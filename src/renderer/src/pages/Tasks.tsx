import { useEffect, useMemo, useRef, useState } from 'react'
import { Download, Search } from 'lucide-react'
import type { TaskQuery, TaskStatus, ToolId } from '@shared/types'
import { TOOL_IDS, TOOL_META } from '@shared/types'
import { useMonitor } from '../store/monitor'
import { useNow } from '../hooks/useTicker'
import { Card } from '../components/ui/atoms'
import { TaskTable } from '../components/tasks/TaskTable'
import { cn, toolName } from '../lib/utils'

type RangeKey = 'today' | 'week' | 'month' | 'all'

const RANGE_LABEL: Record<RangeKey, string> = {
  today: '今天',
  week: '近 7 天',
  month: '近 30 天',
  all: '全部'
}

type StatusFilter = TaskStatus | 'all' | 'active'

const STATUS_OPTIONS: Array<{ key: StatusFilter; label: string }> = [
  { key: 'all', label: '全部' },
  { key: 'active', label: '进行中' },
  { key: 'running', label: '运行中' },
  { key: 'idle', label: '静默' },
  { key: 'ended', label: '已结束' }
]

function rangeToFrom(range: RangeKey): number | undefined {
  const now = Date.now()
  if (range === 'today') {
    const start = new Date(now)
    start.setHours(0, 0, 0, 0)
    return start.getTime()
  }
  if (range === 'week') return now - 7 * 86_400_000
  if (range === 'month') return now - 30 * 86_400_000
  return undefined
}

export function Tasks(): JSX.Element {
  const snapshot = useMonitor((s) => s.snapshot)
  const openDrawer = useMonitor((s) => s.openDrawer)
  const notify = useMonitor((s) => s.notify)

  const [status, setStatus] = useState<StatusFilter>('all')
  const [tools, setTools] = useState<ToolId[]>([])
  const [range, setRange] = useState<RangeKey>('week')
  const [keyword, setKeyword] = useState('')
  const [rows, setRows] = useState<import('@shared/types').TaskSnapshot[]>([])
  const [total, setTotal] = useState(0)
  const [loading, setLoading] = useState(false)
  const debounceRef = useRef<number | null>(null)

  const currency = snapshot?.currency ?? 'USD'
  const fxRate = snapshot?.fxRate ?? 7.2
  const now = useNow(rows.some((task) => task.status === 'running'))
  const signedAt = snapshot?.generatedAt ?? 0

  const query = useMemo<TaskQuery>(
    () => ({
      tools: tools.length > 0 ? tools : undefined,
      statuses:
        status === 'all'
          ? undefined
          : status === 'active'
            ? ['running', 'idle']
            : [status],
      from: rangeToFrom(range),
      keyword: keyword.trim() || undefined,
      limit: 300,
      offset: 0
    }),
    [tools, status, range, keyword]
  )

  useEffect(() => {
    let disposed = false
    const run = async (): Promise<void> => {
      setLoading(true)
      const result = await window.monitor.queryTasks(query)
      if (disposed) return
      setRows(result.rows)
      setTotal(result.total)
      setLoading(false)
    }
    if (debounceRef.current) window.clearTimeout(debounceRef.current)
    debounceRef.current = window.setTimeout(() => void run(), 220)
    return () => {
      disposed = true
      if (debounceRef.current) window.clearTimeout(debounceRef.current)
    }
  }, [query, signedAt])

  const toggleTool = (tool: ToolId): void => {
    setTools((prev) => (prev.includes(tool) ? prev.filter((t) => t !== tool) : [...prev, tool]))
  }

  const exportCsv = async (): Promise<void> => {
    const to = Date.now()
    const from = rangeToFrom(range) ?? to - 30 * 86_400_000
    const result = await window.monitor.exportCsv(from, to)
    notify(
      result.saved ? `已导出 ${result.rows ?? 0} 条任务记录` : '已取消导出',
      result.saved ? 'ok' : 'warn'
    )
  }

  return (
    <div className="space-y-4">
      <Card className="space-y-3 p-3.5">
        <div className="flex flex-wrap items-center gap-2">
          <div className="flex rounded-lg border border-white/[0.07] bg-white/[0.03] p-0.5">
            {STATUS_OPTIONS.map((option) => (
              <button
                key={option.key}
                type="button"
                onClick={() => setStatus(option.key)}
                className={cn(
                  'rounded-md px-2.5 py-1 text-caption transition-colors',
                  status === option.key
                    ? 'bg-white/[0.09] text-fg-hi'
                    : 'text-fg-lo hover:text-fg-mid'
                )}
              >
                {option.label}
              </button>
            ))}
          </div>

          <div className="flex rounded-lg border border-white/[0.07] bg-white/[0.03] p-0.5">
            {(Object.keys(RANGE_LABEL) as RangeKey[]).map((key) => (
              <button
                key={key}
                type="button"
                onClick={() => setRange(key)}
                className={cn(
                  'rounded-md px-2.5 py-1 text-caption transition-colors',
                  range === key ? 'bg-white/[0.09] text-fg-hi' : 'text-fg-lo hover:text-fg-mid'
                )}
              >
                {RANGE_LABEL[key]}
              </button>
            ))}
          </div>

          <div className="relative ml-auto flex items-center">
            <Search size={13} className="pointer-events-none absolute left-2.5 text-fg-lo" />
            <input
              value={keyword}
              onChange={(event) => setKeyword(event.target.value)}
              placeholder="搜索任务、模型或工作区"
              className="field h-[30px] w-[240px] pl-7"
            />
          </div>

          <button type="button" onClick={() => void exportCsv()} className="btn h-[30px]">
            <Download size={13} />
            <span className="text-caption">导出 CSV</span>
          </button>
        </div>

        <div className="flex flex-wrap items-center gap-1.5">
          {TOOL_IDS.map((tool) => {
            const active = tools.includes(tool)
            return (
              <button
                key={tool}
                type="button"
                onClick={() => toggleTool(tool)}
                className={cn('chip', active && 'chip-active')}
                style={active ? { borderColor: `${TOOL_META[tool].color}66`, color: TOOL_META[tool].color } : undefined}
              >
                <span
                  className="h-1.5 w-1.5 rounded-full"
                  style={{ background: TOOL_META[tool].color }}
                />
                {toolName(tool)}
              </button>
            )
          })}
          {tools.length > 0 && (
            <button
              type="button"
              onClick={() => setTools([])}
              className="text-caption text-fg-lo underline-offset-2 hover:text-fg-mid hover:underline"
            >
              清除筛选
            </button>
          )}
          <span className="num ml-auto text-caption text-fg-lo">
            {loading ? '查询中…' : `共 ${total} 条 · 显示 ${rows.length} 条`}
          </span>
        </div>
      </Card>

      <Card className="p-0">
        <TaskTable tasks={rows} currency={currency} fxRate={fxRate} now={now} onOpen={openDrawer} />
      </Card>
    </div>
  )
}
