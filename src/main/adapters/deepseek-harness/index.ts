import { existsSync } from 'node:fs'
import { join } from 'node:path'
import type { AdapterCapabilities, ToolId } from '@shared/types'
import type { AdapterContext } from '../base'
import { BaseAdapter, type DetectResult } from '../base'
import {
  pickUsageFields,
  readLevelDbEntries,
  removeSnapshot,
  snapshotLevelDb
} from '../../collectors/leveldb-reader'
import { TOOL_PATHS, firstExisting } from '../../collectors/paths'
import { PROCESS_MATCHERS, isInstalled } from '../../collectors/process-probe'

const LEVELDB_SUBPATH = join('Local Storage', 'leveldb')

/**
 * DeepSeek Harness（dsh-desktop）适配器。
 * 数据源：
 *  1) <AppSupport>/@deepseek-ai/dsh-desktop/Local Storage/leveldb —— 快照后只读遍历
 *  2) 本地桥接（chat.deepseek.com 网页上报）
 * 本地 LevelDB 无 transcript schema，因此仅在确实解析出 usage 字段时才记录 token，
 * 否则标记 unavailable，由桥接补足。
 */
export class DeepSeekHarnessAdapter extends BaseAdapter {
  readonly id: ToolId = 'deepseek-harness'
  readonly displayName = 'DeepSeek Harness'
  readonly channel = 'leveldb' as const
  readonly capabilities: AdapterCapabilities = {
    tokens: true,
    liveStream: true,
    bridgeRequired: true
  }

  private timer: NodeJS.Timeout | null = null
  private aliveTimer: NodeJS.Timeout | null = null
  private readonly seen = new Set<string>()

  async detect(): Promise<DetectResult> {
    const spec = TOOL_PATHS.deepseekHarness()
    const path = firstExisting([spec.primary, ...spec.alternates])
    return {
      installed: isInstalled('deepseek-harness', path),
      dataPath: path,
      message: path
        ? undefined
        : '未检测到 DeepSeek Harness 数据目录，仅能通过网页桥接采集'
    }
  }

  protected async onStart(ctx: AdapterContext): Promise<void> {
    const scanInterval = Math.max(ctx.settings().desktopPollMs * 6, 90_000)
    void this.scan(ctx)
    this.timer = setInterval(() => {
      void this.scan(ctx)
    }, scanInterval)

    this.aliveTimer = setInterval(() => {
      void this.aliveFallback(PROCESS_MATCHERS['deepseek-harness'], 'DeepSeek Harness')
    }, 60_000)
    console.log(`[adapter:deepseek-harness] leveldb scan every ${scanInterval}ms`)
  }

  protected async onStop(): Promise<void> {
    if (this.timer) clearInterval(this.timer)
    if (this.aliveTimer) clearInterval(this.aliveTimer)
    this.timer = null
    this.aliveTimer = null
  }

  private async scan(ctx: AdapterContext): Promise<void> {
    if (ctx.isPaused() || !this.dataPath) return
    const levelDir = join(this.dataPath, LEVELDB_SUBPATH)
    if (!existsSync(levelDir)) return

    let snapshot: string | null = null
    try {
      snapshot = await snapshotLevelDb(levelDir)
      if (!snapshot) return
      const entries = await readLevelDbEntries(snapshot, {
        maxEntries: 3000,
        keyFilter: (key) =>
          /chat|conversation|session|message|usage/i.test(key) && key.length < 500
      })
      for (const entry of entries) {
        const usage = pickUsageFields(entry.value)
        if (!usage) continue
        const dedupe = `level:${hashKey(entry.key)}:${usage.inputTokens ?? 0}:${usage.outputTokens ?? 0}`
        if (this.seen.has(dedupe)) continue
        this.seen.add(dedupe)
        if (this.seen.size > 20_000) this.seen.clear()

        this.push({
          tool: this.id,
          externalSessionId: `dsh-${hashKey(entry.key)}`,
          ts: Date.now(),
          title: 'DeepSeek Harness 本地会话',
          inputTokens: usage.inputTokens ?? 0,
          outputTokens: usage.outputTokens ?? 0,
          cacheReadTokens: usage.cacheReadTokens ?? 0,
          cacheWriteTokens: usage.cacheWriteTokens ?? 0,
          reasoningTokens: 0,
          tokensSource: 'native',
          dedupeKey: dedupe
        })
      }
    } catch (error) {
      this.fail(error)
    } finally {
      if (snapshot) await removeSnapshot(snapshot)
    }
  }
}

function hashKey(value: string): string {
  let hash = 0
  for (let i = 0; i < value.length; i += 1) {
    hash = (hash * 31 + value.charCodeAt(i)) | 0
  }
  return Math.abs(hash).toString(36)
}
