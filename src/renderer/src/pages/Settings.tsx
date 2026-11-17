import { useEffect, useMemo, useRef, useState } from 'react'
import { Check, Database, Gauge, Palette, ShieldAlert, Timer } from 'lucide-react'
import type { AppSettings, Currency, PricingRow } from '@shared/types'
import { DEFAULT_SETTINGS } from '@shared/defaults'
import { useMonitor } from '../store/monitor'
import { Card, SectionTitle } from '../components/ui/atoms'
import { PricingTable } from '../components/settings/PricingTable'
import { cn } from '../lib/utils'

const SECTIONS = [
  { id: 'refresh', label: '采集与刷新', icon: Timer },
  { id: 'runtime', label: '运行判定', icon: Gauge },
  { id: 'alerts', label: '告警阈值', icon: ShieldAlert },
  { id: 'display', label: '显示与币种', icon: Palette },
  { id: 'data', label: '数据与系统', icon: Database }
]

export function AdapterSettings(): JSX.Element {
  const storeSettings = useMonitor((s) => s.settings)
  const setSettings = useMonitor((s) => s.setSettings)
  const [local, setLocal] = useState<AppSettings | null>(storeSettings)
  const [pricing, setPricing] = useState<PricingRow[]>([])
  const [savedAt, setSavedAt] = useState<number | null>(null)
  const timerRef = useRef<number | null>(null)

  useEffect(() => {
    if (storeSettings) setLocal(storeSettings)
  }, [storeSettings])

  useEffect(() => {
    window.monitor
      .getPricing()
      .then(setPricing)
      .catch((error: unknown) => console.error('[settings] pricing failed', error))
  }, [])

  const settings = local ?? DEFAULT_SETTINGS

  /** 乐观更新 + 400ms 合并保存，避免拖动滑块时刷库 */
  const patch = (changes: Partial<AppSettings>): void => {
    setLocal((prev) => ({ ...(prev ?? settings), ...changes }))
    if (timerRef.current) window.clearTimeout(timerRef.current)
    timerRef.current = window.setTimeout(() => {
      void window.monitor.updateSettings(changes).then((next) => {
        setSettings(next)
        setSavedAt(Date.now())
      })
    }, 400)
  }

  const dirtyHint = useMemo(() => {
    if (!savedAt) return null
    if (Date.now() - savedAt > 2400) return null
    return savedAt
  }, [savedAt])

  return (
    <div className="grid grid-cols-1 items-start gap-5 xl:grid-cols-[168px_1fr]">
      {/* 目录栏吸附在滚动容器顶部，不随内容滚动 */}
      <nav className="sticky top-0 hidden max-h-[calc(100vh-140px)] flex-col gap-1 self-start overflow-y-auto py-1 pr-1 xl:flex">
        {SECTIONS.map((section) => {
          const Icon = section.icon
          return (
            <a
              key={section.id}
              href={`#${section.id}`}
              className="flex items-center gap-2 rounded-lg px-2.5 py-1.5 text-caption text-fg-lo transition-colors hover:bg-white/[0.04] hover:text-fg-hi"
            >
              <Icon size={13} />
              {section.label}
            </a>
          )
        })}
        <div className="mt-2 border-t border-white/[0.05] pt-2">
          <a
            href="#pricing"
            className="flex items-center gap-2 rounded-lg px-2.5 py-1.5 text-caption text-fg-lo transition-colors hover:bg-white/[0.04] hover:text-fg-hi"
          >
            <Database size={13} />
            模型价目表
          </a>
        </div>
        {dirtyHint && (
          <span className="mt-2 flex items-center gap-1 px-2.5 text-caption text-state-ok">
            <Check size={12} /> 已保存
          </span>
        )}
      </nav>

      <div className="space-y-4">
        <Card id="refresh" className="space-y-3">
          <SectionTitle title="采集与刷新" hint="数值越小越实时，代价是更高的 CPU 与磁盘读取频率" />
          <NumberRow
            label="文件监听防抖"
            hint="chokidar 合并写入事件的等待时间"
            value={settings.fileDebounceMs}
            unit="ms"
            min={100}
            max={2000}
            step={100}
            onChange={(value) => patch({ fileDebounceMs: value })}
          />
          <NumberRow
            label="进程探活周期"
            hint="检测工具进程是否仍在运行"
            value={settings.processProbeMs}
            unit="ms"
            min={2000}
            max={30000}
            step={1000}
            onChange={(value) => patch({ processProbeMs: value })}
          />
          <NumberRow
            label="桌面端数据库轮询"
            hint="WorkBuddy / Cursor 等 SQLite 数据源的读取间隔"
            value={settings.desktopPollMs}
            unit="ms"
            min={3000}
            max={60000}
            step={1000}
            onChange={(value) => patch({ desktopPollMs: value })}
          />
          <NumberRow
            label="界面快照推送"
            hint="主进程向界面推送聚合快照的间隔"
            value={settings.snapshotPushMs}
            unit="ms"
            min={1000}
            max={10000}
            step={500}
            onChange={(value) => patch({ snapshotPushMs: value })}
          />
          <NumberRow
            label="菜单栏刷新"
            hint="托盘图标与菜单文案的更新间隔"
            value={settings.trayRefreshMs}
            unit="ms"
            min={2000}
            max={30000}
            step={1000}
            onChange={(value) => patch({ trayRefreshMs: value })}
          />
        </Card>

        <Card id="runtime" className="space-y-3">
          <SectionTitle
            title="运行判定"
            hint="超过该窗口没有新事件的任务转为「静默」，静默满 30 分钟自动结算为「已结束」"
          />
          <div className="flex items-center justify-between gap-4">
            <div>
              <p className="text-body text-fg-hi">空闲判定窗口</p>
              <p className="mt-0.5 text-caption text-fg-lo">
                推荐 90 秒：既能容忍长思考间隙，又能及时反映任务停滞
              </p>
            </div>
            <div className="flex rounded-lg border border-white/[0.07] bg-white/[0.03] p-0.5">
              {[30, 60, 90, 180, 300].map((seconds) => (
                <button
                  key={seconds}
                  type="button"
                  onClick={() => patch({ idleThresholdMs: seconds * 1000 })}
                  className={cn(
                    'rounded-md px-2 py-0.5 text-caption transition-colors',
                    settings.idleThresholdMs === seconds * 1000
                      ? 'bg-white/[0.09] text-fg-hi'
                      : 'text-fg-lo hover:text-fg-mid'
                  )}
                >
                  {seconds < 60 ? `${seconds}s` : `${seconds / 60}m`}
                </button>
              ))}
            </div>
          </div>
        </Card>

        <Card id="alerts" className="space-y-3">
          <SectionTitle title="告警阈值" hint="单任务费用、时长与缓存命中率低于阈值时在任务卡与图标上标记" />
          <NumberRow
            label="费用提醒"
            hint="达到该金额后任务卡片描边转为琥珀色"
            value={settings.alertCostWarnUsd}
            unit="USD"
            min={0.1}
            max={50}
            step={0.1}
            onChange={(value) => patch({ alertCostWarnUsd: value })}
          />
          <NumberRow
            label="费用警示"
            hint="达到该金额后转为红色并触发托盘提示"
            value={settings.alertCostDangerUsd}
            unit="USD"
            min={1}
            max={200}
            step={1}
            onChange={(value) => patch({ alertCostDangerUsd: value })}
          />
          <NumberRow
            label="时长提醒"
            hint="单位：分钟"
            value={Math.round(settings.alertDurationWarnMs / 60000)}
            unit="min"
            min={5}
            max={120}
            step={5}
            onChange={(value) => patch({ alertDurationWarnMs: value * 60000 })}
          />
          <NumberRow
            label="时长警示"
            hint="单位：分钟"
            value={Math.round(settings.alertDurationDangerMs / 60000)}
            unit="min"
            min={10}
            max={480}
            step={10}
            onChange={(value) => patch({ alertDurationDangerMs: value * 60000 })}
          />
          <NumberRow
            label="缓存命中率下限"
            hint="低于该比例时提示；样本不足 1000 token 的小任务不参与判定"
            value={Math.round(settings.alertCacheHitMinRate * 100)}
            unit="%"
            min={0}
            max={100}
            step={5}
            onChange={(value) => patch({ alertCacheHitMinRate: value / 100 })}
          />
        </Card>

        <Card id="display" className="space-y-3">
          <SectionTitle title="显示与币种" hint="费用默认以美元计价，可按汇率换算为人民币展示" />
          <div className="flex items-center justify-between gap-4">
            <div>
              <p className="text-body text-fg-hi">展示币种</p>
              <p className="mt-0.5 text-caption text-fg-lo">仅影响展示，数据库始终以 USD 存储</p>
            </div>
            <div className="flex rounded-lg border border-white/[0.07] bg-white/[0.03] p-0.5">
              {(['USD', 'CNY'] as Currency[]).map((currency) => (
                <button
                  key={currency}
                  type="button"
                  onClick={() => patch({ currency })}
                  className={cn(
                    'rounded-md px-2.5 py-0.5 text-caption transition-colors',
                    settings.currency === currency
                      ? 'bg-white/[0.09] text-fg-hi'
                      : 'text-fg-lo hover:text-fg-mid'
                  )}
                >
                  {currency === 'USD' ? '$ USD' : '¥ CNY'}
                </button>
              ))}
            </div>
          </div>
          <NumberRow
            label="汇率"
            hint="1 USD 折合人民币"
            value={settings.fxRate}
            unit="CNY/USD"
            min={5}
            max={10}
            step={0.01}
            onChange={(value) => patch({ fxRate: value })}
          />
        </Card>

        <Card id="data" className="space-y-3">
          <SectionTitle title="数据与系统" hint="明细保留周期、开机启动与桥接端口" />
          <NumberRow
            label="明细保留天数"
            hint="超期任务在每次启动与每 6 小时清理时归档删除"
            value={settings.retentionDays}
            unit="天"
            min={7}
            max={365}
            step={1}
            onChange={(value) => patch({ retentionDays: value })}
          />
          <div className="flex items-center justify-between gap-4">
            <div>
              <p className="text-body text-fg-hi">开机自动启动</p>
              <p className="mt-0.5 text-caption text-fg-lo">登录系统后在后台启动并驻留菜单栏</p>
            </div>
            <Toggle checked={settings.launchAtLogin} onChange={(value) => patch({ launchAtLogin: value })} />
          </div>
          <div className="flex items-center justify-between gap-4">
            <div>
              <p className="text-body text-fg-hi">启用网页桥接</p>
              <p className="mt-0.5 text-caption text-fg-lo">为元宝与 DeepSeek 网页端提供上报端口</p>
            </div>
            <Toggle checked={settings.bridgeEnabled} onChange={(value) => patch({ bridgeEnabled: value })} />
          </div>
          <NumberRow
            label="桥接端口"
            hint="被占用时自动向后递增，最多尝试 83 个端口"
            value={settings.bridgePort}
            unit="port"
            min={1024}
            max={65535}
            step={1}
            onChange={(value) => patch({ bridgePort: value })}
          />
        </Card>

        <Card id="pricing" className="space-y-3">
          <SectionTitle
            title="模型价目表"
            hint="修改后所有历史任务的费用会按新价格重算（基于累计 token）"
          />
          <PricingTable rows={pricing} onSaved={setPricing} />
        </Card>
      </div>
    </div>
  )
}

function NumberRow({
  label,
  hint,
  value,
  unit,
  min,
  max,
  step,
  onChange
}: {
  label: string
  hint: string
  value: number
  unit: string
  min: number
  max: number
  step: number
  onChange: (value: number) => void
}): JSX.Element {
  return (
    <div className="flex items-center justify-between gap-4">
      <div className="min-w-0">
        <p className="text-body text-fg-hi">{label}</p>
        <p className="mt-0.5 text-caption text-fg-lo">{hint}</p>
      </div>
      <div className="flex shrink-0 items-center gap-1.5">
        <input
          type="number"
          value={value}
          min={min}
          max={max}
          step={step}
          onChange={(event) => {
            const parsed = Number(event.target.value)
            if (!Number.isFinite(parsed)) return
            onChange(Math.min(max, Math.max(min, parsed)))
          }}
          className="field num h-[30px] w-[92px] text-right"
        />
        <span className="num w-[62px] text-caption text-fg-lo">{unit}</span>
      </div>
    </div>
  )
}

function Toggle({ checked, onChange }: { checked: boolean; onChange: (v: boolean) => void }): JSX.Element {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      onClick={() => onChange(!checked)}
      className={cn(
        'relative h-[22px] w-[38px] shrink-0 rounded-full border transition-colors',
        checked
          ? 'border-accent-cyan/40 bg-accent-cyan/25'
          : 'border-white/[0.09] bg-white/[0.05]'
      )}
    >
      <span
        className={cn(
          'absolute top-[2px] h-[16px] w-[16px] rounded-full transition-all duration-200',
          checked ? 'left-[19px] bg-accent-cyan' : 'left-[2px] bg-fg-lo'
        )}
      />
    </button>
  )
}
