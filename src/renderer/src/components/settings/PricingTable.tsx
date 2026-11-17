import { useEffect, useState } from 'react'
import { BadgeCheck, ExternalLink, HelpCircle, Plus, RotateCcw, Trash2 } from 'lucide-react'
import type { PricingRow } from '@shared/types'
import { useMonitor } from '../../store/monitor'
import { cn } from '../../lib/utils'

const COLUMNS: Array<{ key: keyof PricingRow; label: string; width: string }> = [
  { key: 'provider', label: '厂商', width: 'w-[88px]' },
  { key: 'match', label: '模型匹配', width: 'w-[124px]' },
  { key: 'inputPerM', label: '输入/M', width: 'w-[68px]' },
  { key: 'outputPerM', label: '输出/M', width: 'w-[68px]' },
  { key: 'cacheReadPerM', label: '缓存读/M', width: 'w-[76px]' },
  { key: 'cacheWritePerM', label: '缓存写/M', width: 'w-[76px]' }
]

export function PricingTable({
  rows,
  onSaved
}: {
  rows: PricingRow[]
  onSaved: (rows: PricingRow[]) => void
}): JSX.Element {
  const [draft, setDraft] = useState<PricingRow[]>(rows)
  const [saving, setSaving] = useState(false)
  const notify = useMonitor((s) => s.notify)

  // 首屏价目表来自异步查询，props 到位后必须同步到本地草稿，
  // 否则组件会永久停留在挂载时的空数组上。
  useEffect(() => {
    setDraft(rows)
  }, [rows])

  const update = (index: number, key: keyof PricingRow, value: string): void => {
    setDraft((prev) =>
      prev.map((row, i) => {
        if (i !== index) return row
        if (key === 'provider' || key === 'match' || key === 'id') {
          return { ...row, [key]: value }
        }
        const parsed = Number(value)
        return { ...row, [key]: Number.isFinite(parsed) ? Math.max(0, parsed) : 0 }
      })
    )
  }

  const toggleStatus = (index: number): void => {
    setDraft((prev) =>
      prev.map((row, i) =>
        i === index
          ? { ...row, status: row.status === 'verified' ? 'pending' : 'verified' }
          : row
      )
    )
  }

  const addRow = (): void => {
    setDraft((prev) => [
      ...prev,
      {
        id: `custom-${Date.now()}`,
        provider: '自定义',
        match: 'model-*',
        inputPerM: 0,
        outputPerM: 0,
        cacheReadPerM: 0,
        cacheWritePerM: 0,
        status: 'pending',
        note: '尚未核实单价'
      }
    ])
  }

  const save = async (): Promise<void> => {
    setSaving(true)
    const next = await window.monitor.updatePricing(draft)
    setDraft(next)
    onSaved(next)
    notify('价目表已更新，任务费用已按新口径重算')
    setSaving(false)
  }

  const reset = async (): Promise<void> => {
    setSaving(true)
    const next = await window.monitor.resetPricing()
    setDraft(next)
    onSaved(next)
    notify('已恢复内置价目表（含官方来源标记）')
    setSaving(false)
  }

  const verifiedCount = draft.filter((row) => row.status === 'verified').length
  const pendingCount = draft.length - verifiedCount

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2 text-caption">
        <span className="inline-flex items-center gap-1 rounded-md border border-state-ok/25 bg-state-ok/10 px-1.5 py-0.5 text-state-ok">
          <BadgeCheck size={11} /> 已核实 {verifiedCount}
        </span>
        <span className="inline-flex items-center gap-1 rounded-md border border-white/10 bg-white/[0.04] px-1.5 py-0.5 text-fg-mid">
          <HelpCircle size={11} /> 待确认 {pendingCount}
        </span>
        <span className="text-fg-lo">
          待确认行不参与计价，任务费用显示「—」
        </span>
      </div>

      {draft.length === 0 ? (
        <div className="rounded-lg border border-dashed border-white/[0.08] px-3 py-6 text-center text-caption text-fg-lo">
          正在读取价目表…
        </div>
      ) : (
        <div className="overflow-x-auto rounded-lg border border-white/[0.05]">
          <table className="w-full min-w-[720px] text-caption">
            <thead>
              <tr className="bg-white/[0.025] text-fg-lo">
                {COLUMNS.map((col) => (
                  <th key={col.key} className={cn('px-2 py-1.5 text-left font-medium whitespace-nowrap', col.width)}>
                    {col.label}
                  </th>
                ))}
                <th className="w-[96px] px-2 py-1.5 text-left font-medium">状态</th>
                <th className="w-[30px] px-2 py-1.5" />
              </tr>
            </thead>
            <tbody>
              {draft.map((row, index) => {
                const verified = row.status === 'verified'
                return (
                  <tr
                    key={row.id}
                    className={cn('border-t border-white/[0.04]', !verified && 'bg-white/[0.012]')}
                  >
                    {COLUMNS.map((col) => (
                      <td key={col.key} className="px-1.5 py-1">
                        <input
                          value={String(row[col.key] ?? '')}
                          onChange={(event) => update(index, col.key, event.target.value)}
                          className={cn(
                            'field h-[26px] px-1.5 py-0 text-[11px]',
                            !verified && col.key !== 'provider' && col.key !== 'match' && 'text-fg-lo'
                          )}
                          inputMode={col.key === 'provider' || col.key === 'match' ? 'text' : 'decimal'}
                        />
                      </td>
                    ))}
                    <td className="px-1.5 py-1">
                      <button
                        type="button"
                        onClick={() => toggleStatus(index)}
                        title={row.note ?? (verified ? '价格取自官方定价页' : '价格未核实')}
                        className={cn(
                          'inline-flex items-center gap-1 rounded-md border px-1.5 py-0.5 text-[10px] transition-colors whitespace-nowrap',
                          verified
                            ? 'border-state-ok/25 bg-state-ok/10 text-state-ok hover:bg-state-ok/15'
                            : 'border-white/10 bg-white/[0.04] text-fg-mid hover:text-fg-hi'
                        )}
                      >
                        {verified ? <BadgeCheck size={10} /> : <HelpCircle size={10} />}
                        {verified ? '已核实' : '待确认'}
                      </button>
                      {row.source ? (
                        <button
                          type="button"
                          onClick={() => void window.monitor.openExternal(row.source as string)}
                          className="ml-1 inline-flex items-center text-fg-lo transition-colors hover:text-accent-cyan"
                          title={row.source}
                        >
                          <ExternalLink size={10} />
                        </button>
                      ) : null}
                    </td>
                    <td className="px-1 py-1">
                      <button
                        type="button"
                        onClick={() => setDraft((prev) => prev.filter((_, i) => i !== index))}
                        className="rounded p-1 text-fg-lo transition-colors hover:bg-state-danger/10 hover:text-state-danger"
                        title="删除该行"
                      >
                        <Trash2 size={12} />
                      </button>
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}

      <div className="flex flex-wrap items-center gap-2">
        <button type="button" onClick={addRow} className="btn h-[28px]">
          <Plus size={12} />
          <span className="text-caption">新增模型</span>
        </button>
        <button type="button" onClick={() => void reset()} disabled={saving} className="btn h-[28px]">
          <RotateCcw size={12} />
          <span className="text-caption">恢复内置</span>
        </button>
        <button
          type="button"
          onClick={() => void save()}
          disabled={saving}
          className="btn btn-primary ml-auto h-[28px]"
        >
          <span className="text-caption">{saving ? '保存中…' : '保存价目表'}</span>
        </button>
      </div>

      <div className="space-y-1 text-[10px] leading-relaxed text-fg-lo">
        <p>
          单价单位 USD / 每百万 token，来源：Anthropic
          <span className="num"> platform.claude.com/docs/.../pricing</span>、OpenAI
          <span className="num"> platform.openai.com/docs/pricing</span>、DeepSeek
          <span className="num"> api-docs.deepseek.com</span>。
        </p>
        <p>
          Codex 走订阅额度、腾讯与智谱自有模型未公开 API 单价，这些行一律标为
          <span className="text-fg-mid"> 待确认 </span>
          且单价置 0 —— 不猜测、不推算。补录后把状态切为「已核实」即可参与计价。
        </p>
      </div>
    </div>
  )
}
