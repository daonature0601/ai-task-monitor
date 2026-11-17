import { useEffect, useState } from 'react'
import { Copy, FolderOpen, RefreshCw, ShieldCheck, Waves } from 'lucide-react'
import type { AdapterInfo, BridgeStatus } from '@shared/types'
import type { HookStatus } from '@shared/ipc-contract'
import { TOOL_META } from '@shared/types'
import { formatRelative } from '@shared/format'
import { useMonitor } from '../store/monitor'
import { Badge, Card, SectionTitle, StatusDot, ToolAvatar } from '../components/ui/atoms'
import { cn, toolName } from '../lib/utils'

const CHANNEL_LABEL: Record<string, string> = {
  jsonl: 'JSONL 增量',
  sqlite: 'SQLite 只读',
  leveldb: 'LevelDB 快照',
  bridge: '网页桥接',
  process: '进程探活'
}

export function Adapters(): JSX.Element {
  const snapshot = useMonitor((s) => s.snapshot)
  const adapters = useMonitor((s) => s.adapters)
  const setAdapters = useMonitor((s) => s.setAdapters)
  const notify = useMonitor((s) => s.notify)
  const [bridge, setBridge] = useState<BridgeStatus | null>(null)
  const [busy, setBusy] = useState(false)
  const [rebuilding, setRebuilding] = useState(false)
  const [hooks, setHooks] = useState<HookStatus | null>(null)
  const [hookBusy, setHookBusy] = useState(false)
  const [rebuildDays, setRebuildDays] = useState(30)

  useEffect(() => {
    window.monitor
      .getBridgeStatus()
      .then(setBridge)
      .catch((error: unknown) => console.error('[adapters] bridge status failed', error))
  }, [])

  useEffect(() => {
    void window.monitor
      .getHookStatus()
      .then(setHooks)
      .catch((error: unknown) => console.error('[adapters] hook status failed', error))
  }, [])

  useEffect(() => {
    if (snapshot?.adapters) setAdapters(snapshot.adapters)
  }, [snapshot?.adapters, setAdapters])

  const list: AdapterInfo[] = adapters.length > 0 ? adapters : (snapshot?.adapters ?? [])

  const rescan = async (): Promise<void> => {
    setBusy(true)
    const next = await window.monitor.rescanAdapters()
    setAdapters(next)
    const status = await window.monitor.getBridgeStatus()
    setBridge(status)
    notify('已重新扫描全部数据源')
    setBusy(false)
  }

  const toggleHooks = async (install: boolean): Promise<void> => {
    setHookBusy(true)
    try {
      const next = install
        ? await window.monitor.installHooks()
        : await window.monitor.removeHooks()
      setHooks(next)
      notify(install ? '已启用状态挂钩，工具下次启动后生效' : '已移除挂钩并还原配置', 'ok')
    } catch (error) {
      console.error('[adapters] hooks failed', error)
      notify('挂钩操作失败，请查看主进程日志', 'warn')
    } finally {
      setHookBusy(false)
    }
  }

  const rebuild = async (): Promise<void> => {
    const ok = window.confirm(
      `将清空任务与用量流水，并按最近 ${rebuildDays} 天重新扫描日志。\n\n` +
        '设置与价目表不受影响；扫描期间数据会短暂为空，完成后自动恢复。\n' +
        `日志体积较大时可能需要数分钟。确认继续？`
    )
    if (!ok) return

    setRebuilding(true)
    try {
      await window.monitor.rebuildHistory(rebuildDays)
      const next = await window.monitor.getAdapters()
      setAdapters(next)
      notify(`已按最近 ${rebuildDays} 天重建，扫描在后台继续，数据会逐步恢复`)
    } catch (error) {
      console.error('[adapters] rebuild failed', error)
      notify('重建失败，请查看主进程日志')
    } finally {
      setRebuilding(false)
    }
  }

  const copyScript = async (tool: 'yuanbao' | 'deepseek-harness'): Promise<void> => {
    const script = await window.monitor.getBridgeScript(tool)
    await navigator.clipboard.writeText(script)
    notify(`${toolName(tool)} 上报脚本已复制，安装到油猴后刷新页面即可`)
  }

  return (
    <div className="space-y-5">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-title font-semibold text-fg-hi">采集通道</h2>
          <p className="mt-0.5 text-caption text-fg-lo">
            每个工具使用最贴近其真实数据源的采集方式；无法获取的指标以「—」呈现，不做估算
          </p>
        </div>
        <button type="button" onClick={() => void rescan()} disabled={busy} className="btn h-[30px]">
          <RefreshCw size={13} className={cn(busy && 'animate-spin')} />
          <span className="text-caption">重新扫描</span>
        </button>
      </div>

      <div className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3">
        {list.map((adapter) => {
          const meta = TOOL_META[adapter.id]
          return (
            <Card key={adapter.id} hover className="space-y-3">
              <div className="flex items-start justify-between">
                <div className="flex items-center gap-2.5">
                  <ToolAvatar tool={adapter.id} active={adapter.status === 'ok'} />
                  <div>
                    <p className="text-body font-medium text-fg-hi">{meta?.displayName ?? adapter.id}</p>
                    <p className="text-[10px] text-fg-lo">{meta?.vendor}</p>
                  </div>
                </div>
                <div className="flex items-center gap-1.5">
                  <StatusDot
                    tone={adapter.status === 'ok' ? 'ok' : adapter.status === 'degraded' ? 'warn' : 'off'}
                    pulse={adapter.status === 'ok'}
                  />
                  <span className="text-caption text-fg-mid">
                    {adapter.status === 'ok' ? '正常' : adapter.status === 'degraded' ? '降级' : '未检测到'}
                  </span>
                </div>
              </div>

              <div className="flex flex-wrap gap-1.5">
                <Badge tone="violet">{CHANNEL_LABEL[adapter.channel] ?? adapter.channel}</Badge>
                <Badge tone={adapter.capabilities.tokens ? 'ok' : 'neutral'}>
                  {adapter.capabilities.tokens ? 'Token 可用' : 'Token 不可得'}
                </Badge>
                {adapter.capabilities.bridgeRequired && <Badge tone="warn">需桥接</Badge>}
                {adapter.capabilities.liveStream && <Badge tone="cyan">实时流</Badge>}
              </div>

              <p className="line-clamp-2 min-h-[32px] text-caption leading-4 text-fg-lo">
                {adapter.message ?? meta?.dataHint ?? '—'}
              </p>

              <div className="flex items-center justify-between border-t border-white/[0.05] pt-2 text-caption text-fg-lo">
                <span className="num">
                  {adapter.lastEventAt ? formatRelative(adapter.lastEventAt) : '暂无事件'}
                </span>
                <span className="num">今日 {adapter.eventsToday} 条</span>
                {adapter.errorCount > 0 && (
                  <span className="num text-state-danger">错误 {adapter.errorCount}</span>
                )}
              </div>
            </Card>
          )
        })}
      </div>

      <Card>
        <SectionTitle title="能力矩阵与数据源" hint="路径为本机实测位置，跨平台会自动切换根目录" />
        <div className="overflow-hidden rounded-lg border border-white/[0.05]">
          <table className="w-full text-caption">
            <thead>
              <tr className="bg-white/[0.025] text-fg-lo">
                <th className="px-3 py-2 text-left font-medium">工具</th>
                <th className="w-[86px] px-2 py-2 text-left font-medium">Token</th>
                <th className="w-[86px] px-2 py-2 text-left font-medium">实时流</th>
                <th className="w-[86px] px-2 py-2 text-left font-medium">桥接</th>
                <th className="w-[118px] px-2 py-2 text-left font-medium">通道</th>
                <th className="px-3 py-2 text-left font-medium">数据源</th>
              </tr>
            </thead>
            <tbody>
              {list.map((adapter) => (
                <tr key={adapter.id} className="border-t border-white/[0.04]">
                  <td className="px-3 py-2 text-fg-hi">{toolName(adapter.id)}</td>
                  <td className="px-2 py-2 text-fg-mid">{adapter.capabilities.tokens ? '支持' : '不可得'}</td>
                  <td className="px-2 py-2 text-fg-mid">{adapter.capabilities.liveStream ? '支持' : '轮询'}</td>
                  <td className="px-2 py-2 text-fg-mid">
                    {adapter.capabilities.bridgeRequired ? '必需' : '不需要'}
                  </td>
                  <td className="px-2 py-2 text-fg-mid">
                    {CHANNEL_LABEL[adapter.channel] ?? adapter.channel}
                  </td>
                  <td className="num truncate px-3 py-2 text-[11px] text-fg-lo" title={adapter.dataPath ?? ''}>
                    {adapter.dataPath ?? '未检测到路径'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>

      <Card className="space-y-4">
        <SectionTitle
          title="网页端桥接"
          hint="元宝与 DeepSeek 网页端的真实用量需由脚本上报到本机端口"
          action={
            <div className="flex items-center gap-1.5">
              <Waves size={13} className={bridge?.listening ? 'text-accent-cyan' : 'text-fg-lo'} />
              <span className="text-caption text-fg-mid">
                {bridge?.listening ? `127.0.0.1:${bridge.port}` : '未监听'}
              </span>
            </div>
          }
        />

        <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
          <div className="rounded-xl border border-white/[0.05] bg-white/[0.02] px-3 py-2.5">
            <p className="label-xs">端口</p>
            <p className="num mt-1 text-body text-fg-hi">{bridge?.port ?? '—'}</p>
          </div>
          <div className="rounded-xl border border-white/[0.05] bg-white/[0.02] px-3 py-2.5">
            <p className="label-xs">访问令牌</p>
            <p className="num mt-1 truncate text-body text-fg-hi">
              {bridge ? `${bridge.token.slice(0, 6)}••••${bridge.token.slice(-4)}` : '—'}
            </p>
          </div>
          <div className="rounded-xl border border-white/[0.05] bg-white/[0.02] px-3 py-2.5">
            <p className="label-xs">已接收上报</p>
            <p className="num mt-1 text-body text-fg-hi">
              {bridge?.received ?? 0}
              <span className="ml-2 text-caption text-fg-lo">
                {bridge?.lastAt ? formatRelative(bridge.lastAt) : '尚未收到'}
              </span>
            </p>
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <button type="button" onClick={() => void copyScript('yuanbao')} className="btn">
            <Copy size={13} />
            <span className="text-caption">复制元宝脚本</span>
          </button>
          <button type="button" onClick={() => void copyScript('deepseek-harness')} className="btn">
            <Copy size={13} />
            <span className="text-caption">复制 DeepSeek 脚本</span>
          </button>
          <button type="button" onClick={() => void window.monitor.openDataDir()} className="btn">
            <FolderOpen size={13} />
            <span className="text-caption">打开数据目录</span>
          </button>
          {bridge?.error && (
            <span className="text-caption text-state-warn">{bridge.error}</span>
          )}
        </div>

        <div className="flex items-start gap-2 rounded-xl border border-accent-cyan/15 bg-accent-cyan/[0.04] px-3 py-2.5">
          <ShieldCheck size={14} className="mt-0.5 shrink-0 text-accent-cyan" />
          <p className="text-caption leading-relaxed text-fg-mid">
            桥接仅监听 127.0.0.1，校验 X-Bridge-Token 与来源白名单（yuanbao.tencent.com /
            chat.deepseek.com），限制 64KB 请求体与 30 次/秒；脚本不会读取或上传任何对话正文，只上报 token 计数。
          </p>
        </div>
      </Card>


      <Card>
        <SectionTitle
          title="状态挂钩"
          hint="用工具自身的 hook 上报运行状态，取代基于日志的推断"
        />
        <div className="flex flex-wrap items-center gap-2">
          <HookPill label="Claude Code" ok={hooks?.claude ?? false} note="回合开始 / 结束" />
          <HookPill
            label="Codex"
            ok={hooks?.codex ?? false}
            note={hooks?.codexChained ? "回合结束（已接管原 notify）" : "回合结束"}
          />
          <button
            type="button"
            disabled={hookBusy}
            onClick={() => void toggleHooks(true)}
            className="btn h-[28px]"
          >
            <ShieldCheck size={13} />
            <span className="text-caption">{hookBusy ? '处理中…' : '启用挂钩'}</span>
          </button>
          <button type="button" disabled={hookBusy} onClick={() => void toggleHooks(false)} className="btn h-[28px]">
            <span className="text-caption">移除挂钩</span>
          </button>
        </div>
        <p className="mt-2 text-[10px] leading-relaxed text-fg-lo">
          Claude Code 在 <code>~/.claude/settings.json</code> 注入 UserPromptSubmit / Stop / PreToolUse；
          Codex 在 <code>~/.codex/config.toml</code> 接管 notify（原命令仍会被转调）。两者都会先备份原配置，
          移除挂钩时还原。未启用挂钩的工具仍使用心跳 / 进程探活，这类状态在任务详情里标记为「推断」。
        </p>
      </Card>

      <Card>
        <SectionTitle
          title="数据维护"
          hint="任务与用量流水都由日志派生，可安全重建；设置与价目表不受影响"
        />

        <div className="flex flex-wrap items-center gap-3">
          <div className="flex items-center gap-2">
            <span className="text-caption text-fg-lo">回填窗口</span>
            <select
              value={rebuildDays}
              onChange={(event) => setRebuildDays(Number(event.target.value))}
              className="field h-[28px] w-[92px] px-2 py-0 text-caption"
            >
              <option value={7}>7 天</option>
              <option value={30}>30 天</option>
              <option value={90}>90 天</option>
            </select>
          </div>
          <button
            type="button"
            disabled={rebuilding}
            onClick={() => void rebuild()}
            className="btn h-[28px]"
          >
            <Waves size={13} />
            <span className="text-caption">{rebuilding ? '重建中…' : '重建历史索引'}</span>
          </button>
          <span className="text-caption text-fg-lo">
            选择窗口后点击重建；扫描期间数据会短暂为空
          </span>
        </div>

        <p className="mt-2 text-[10px] leading-relaxed text-fg-lo">
          重建会删除 `tasks` / `usage_events` / `file_cursors` 三张表并按所选窗口重扫日志。
          耗时与日志体积成正比：本机 Codex 日志约 15GB（覆盖 5 个月），30 天约需 1–3 分钟，
          期间概览会短暂变空，扫描完成后数字自动回来。
        </p>
      </Card>
    </div>
  )
}

/** 挂钩启用状态标签 */
function HookPill({ label, ok, note }: { label: string; ok: boolean; note: string }): JSX.Element {
  return (
    <span className="flex items-center gap-1.5 rounded-lg border border-white/[0.07] bg-white/[0.03] px-2 py-1">
      <span className={cn('h-1.5 w-1.5 rounded-full', ok ? 'bg-state-ok' : 'bg-white/20')} />
      <span className="text-caption text-fg-mid">{label}</span>
      <span className="text-[10px] text-fg-lo">{ok ? note : '未启用'}</span>
    </span>
  )
}
