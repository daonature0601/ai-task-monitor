import { existsSync, promises as fsp } from 'node:fs'
import { join } from 'node:path'
import type { AdapterCapabilities, ToolId } from '@shared/types'
import type { AdapterContext } from '../base'
import { BaseAdapter, type DetectResult } from '../base'
import { withReadonlyDb, readItemTable } from '../../collectors/sqlite-reader'
import { pickUsageFields } from '../../collectors/leveldb-reader'
import { TOOL_PATHS, appSupportDir, firstExisting } from '../../collectors/paths'
import { isInstalled } from '../../collectors/process-probe'

interface ComposerEntry {
  composerId?: string
  name?: string
  createdAt?: number
  lastUpdatedAt?: number
  unifiedMode?: string
  workspace?: string
}

const COMPOSER_KEYS = [
  'composer.composerData',
  'workbench.panel.aichat.view.aichat.chatdata',
  'aiChat.chatdata',
  'workbench.panel.composerChatViewPane.hidden'
]

/**
 * Cursor 适配器。
 * 数据源：
 *  - <AppSupport>/Cursor/User/globalStorage/state.vscdb（ItemTable 键值）
 *  - <AppSupport>/Cursor/User/workspaceStorage/<hash>/state.vscdb
 * 说明：Cursor 的 token 明细由服务端持有，本地通常不落盘。
 * 因此本适配器优先提取 composer 会话时间线；若键值中确实存在 usage 字段才计入 token，
 * 否则 tokensSource=unavailable，绝不用估算填补。
 */
export class CursorAdapter extends BaseAdapter {
  readonly id: ToolId = 'cursor'
  readonly displayName = 'Cursor'
  readonly channel = 'sqlite' as const
  readonly capabilities: AdapterCapabilities = {
    tokens: false,
    liveStream: false,
    bridgeRequired: false
  }

  private timer: NodeJS.Timeout | null = null
  private readonly emitted = new Set<string>()
  private hasStateDb = false

  async detect(): Promise<DetectResult> {
    const spec = TOOL_PATHS.cursor()
    const globalDb = join(appSupportDir(), 'Cursor', 'User', 'globalStorage', 'state.vscdb')
    this.hasStateDb = existsSync(globalDb)
    const path = this.hasStateDb ? globalDb : firstExisting(spec.alternates)
    return {
      installed: isInstalled('cursor', path),
      dataPath: path,
      message: this.hasStateDb
        ? undefined
        : '未找到 state.vscdb：Cursor 的 token 明细由服务端持有，本地通常只有会话时间线'
    }
  }

  override health() {
    const base = super.health()
    if (base.status === 'ok' && !this.hasStateDb) {
      return {
        ...base,
        status: 'degraded' as const,
        message: '仅能读取会话时间线，token 用量不可得（可接入桥接）'
      }
    }
    return base
  }

  protected async onStart(ctx: AdapterContext): Promise<void> {
    if (!this.dataPath) return
    const interval = Math.max(5000, ctx.settings().desktopPollMs)
    await this.poll(ctx)
    this.timer = setInterval(() => {
      void this.poll(ctx)
    }, interval)
    console.log(`[adapter:cursor] polling every ${interval}ms`)
  }

  protected async onStop(): Promise<void> {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
  }

  private async poll(ctx: AdapterContext): Promise<void> {
    if (ctx.isPaused()) return
    try {
      const globalDb = join(appSupportDir(), 'Cursor', 'User', 'globalStorage', 'state.vscdb')
      if (existsSync(globalDb)) this.scanStateDb(globalDb, ctx)
      const workspaceRoot = join(appSupportDir(), 'Cursor', 'User', 'workspaceStorage')
      if (existsSync(workspaceRoot)) {
        const dirs = await fsp.readdir(workspaceRoot, { withFileTypes: true })
        for (const dir of dirs) {
          if (!dir.isDirectory()) continue
          const dbPath = join(workspaceRoot, dir.name, 'state.vscdb')
          if (existsSync(dbPath)) this.scanStateDb(dbPath, ctx)
        }
      }
    } catch (error) {
      this.fail(error)
    }
  }

  private scanStateDb(dbPath: string, ctx: AdapterContext): void {
    withReadonlyDb(dbPath, (db) => {
      const values = readItemTable(db, COMPOSER_KEYS)
      for (const raw of values) {
        const composers = extractComposers(raw)
        for (const composer of composers) {
          this.emitComposer(composer, raw, dbPath, ctx)
        }
      }
      return null
    })
  }

  private emitComposer(
    composer: ComposerEntry,
    rawValue: string,
    dbPath: string,
    ctx: AdapterContext
  ): void {
    const id = composer.composerId
    if (!id) return
    const startedAt = composer.createdAt ?? composer.lastUpdatedAt
    if (!startedAt) return
    const lastUpdated = composer.lastUpdatedAt ?? startedAt
    const key = `${id}:${lastUpdated}`
    const usage = pickUsageFields(rawValue)
    if (this.emitted.has(key) && !usage) return
    this.emitted.add(key)

    this.push({
      tool: this.id,
      externalSessionId: id,
      ts: Math.min(lastUpdated, Date.now()),
      title: composer.name?.trim() || undefined,
      workspace: composer.workspace,
      model: undefined,
      // 只有真实抓到 usage 才记为 native，否则明确不可用
      inputTokens: usage?.inputTokens ?? 0,
      outputTokens: usage?.outputTokens ?? 0,
      cacheReadTokens: usage?.cacheReadTokens ?? 0,
      cacheWriteTokens: usage?.cacheWriteTokens ?? 0,
      reasoningTokens: 0,
      tokensSource: usage ? 'native' : 'unavailable',
      dedupeKey: `composer:${key}:${dbPath.length}`
    })
  }
}

function extractComposers(raw: string): ComposerEntry[] {
  if (!raw || raw.length < 2) return []
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return []
  }
  const out: ComposerEntry[] = []
  const visit = (node: unknown, depth: number): void => {
    if (!node || depth > 6 || out.length > 120) return
    if (Array.isArray(node)) {
      for (const item of node) visit(item, depth + 1)
      return
    }
    if (typeof node !== 'object') return
    const record = node as Record<string, unknown>
    if (typeof record.composerId === 'string') {
      out.push({
        composerId: record.composerId,
        name: typeof record.name === 'string' ? record.name : undefined,
        createdAt: numberOrUndefined(record.createdAt),
        lastUpdatedAt: numberOrUndefined(record.lastUpdatedAt),
        unifiedMode: typeof record.unifiedMode === 'string' ? record.unifiedMode : undefined,
        workspace: typeof record.workspace === 'string' ? record.workspace : undefined
      })
    }
    for (const value of Object.values(record)) {
      if (value && typeof value === 'object') visit(value, depth + 1)
    }
  }
  visit(parsed, 0)
  return out
}

function numberOrUndefined(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) return value
  return undefined
}
