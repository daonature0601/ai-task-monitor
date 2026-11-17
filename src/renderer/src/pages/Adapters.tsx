import { useEffect, useState } from 'react'
import { Copy, FolderOpen, RefreshCw, ShieldCheck, Waves } from 'lucide-react'
import type { AdapterInfo, BridgeStatus } from '@shared/types'
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

  useEffect(() => {
    window.monitor
      .getBridgeStatus()
      .then(setBridge)
      .catch((error: unknown) => console.error('[adapters] bridge status failed', error))
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
    </div>
  )
}
