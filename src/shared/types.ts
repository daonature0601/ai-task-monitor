/**
 * 全局共享类型 — 主进程 / preload / 渲染进程三方共用。
 * 这里只放纯数据结构，不允许引入任何 node / electron 依赖。
 */

export type ToolId =
  | 'codex'
  | 'claude-code'
  | 'deepseek-harness'
  | 'codebuddy'
  | 'workbuddy'
  | 'cursor'
  | 'yuanbao'

export const TOOL_IDS: ToolId[] = [
  'codex',
  'claude-code',
  'deepseek-harness',
  'codebuddy',
  'workbuddy',
  'cursor',
  'yuanbao'
]

export type TaskStatus = 'running' | 'idle' | 'ended'

/** Token 数据可信度：native=工具原生落盘 / bridge=网页上报 / partial=部分字段 / unavailable=不可得 */
export type TokensSource = 'native' | 'bridge' | 'partial' | 'unavailable'

export type CollectChannel = 'jsonl' | 'sqlite' | 'leveldb' | 'process' | 'bridge'

export type AdapterHealth = 'ok' | 'degraded' | 'off'

export type AlertKind =
  | 'cost_warn'
  | 'cost_danger'
  | 'duration_warn'
  | 'duration_danger'
  | 'cache_low'
  | 'adapter_error'

export type Currency = 'USD' | 'CNY'

export interface TokenUsage {
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
  reasoningTokens: number
}

/** 适配器产出的归一化增量。token 字段必须为真实值或 0，禁止估算填充。 */
export interface UsageDelta extends TokenUsage {
  tool: ToolId
  externalSessionId: string
  ts: number
  title?: string
  workspace?: string
  model?: string
  tokensSource: TokensSource
  /** 幂等键：`${adapterId}:${fileRelPath}:${byteOffset}` 或 `msg:${messageId}` */
  dedupeKey: string
  /** 显式结束信号（如会话状态 completed） */
  endSignal?: boolean
  /** 真实开始时间（心跳类数据源可给出早于首个事件的时间） */
  startedAtHint?: number
  /** 仅用于维持活跃度、无需写入用量流水（如每 30s 的心跳） */
  skipEventLog?: boolean
  /** 标题由数据源稳定生成，应覆盖任务上的旧标题 */
  authoritativeTitle?: boolean
}

export interface TaskSnapshot extends TokenUsage {
  id: string
  tool: ToolId
  externalSessionId: string
  title: string
  workspace?: string
  model?: string
  status: TaskStatus
  startedAt: number
  lastEventAt: number
  endedAt?: number
  durationMs: number
  costUsd: number
  /** 是否可计价：模型命中已核实的价目行才为 true，否则费用显示 "—" */
  costKnown: boolean
  cacheHitRate: number | null
  tokensSource: TokensSource
  eventCount: number
  alerts: AlertKind[]
}

export interface AdapterCapabilities {
  tokens: boolean
  liveStream: boolean
  bridgeRequired: boolean
}

export interface AdapterInfo {
  id: ToolId
  displayName: string
  channel: CollectChannel
  capabilities: AdapterCapabilities
  installed: boolean
  dataPath: string | null
  status: AdapterHealth
  lastEventAt: number | null
  errorCount: number
  message: string | null
  eventsToday: number
}

export interface MonitorSummary {
  runningCount: number
  idleCount: number
  todayTasks: number
  todayInputTokens: number
  todayOutputTokens: number
  todayCacheReadTokens: number
  todayCostUsd: number
  avgCacheHitRate: number | null
  runningCostUsd: number
}

export interface AlertItem {
  id: string
  taskId: string
  title: string
  tool: ToolId
  kind: AlertKind
  message: string
  raisedAt: number
}

export interface SnapshotPayload {
  generatedAt: number
  tasks: TaskSnapshot[]
  summary: MonitorSummary
  adapters: AdapterInfo[]
  alerts: AlertItem[]
  paused: boolean
  currency: Currency
  fxRate: number
}

export interface AppSettings {
  currency: Currency
  fxRate: number
  fileDebounceMs: number
  processProbeMs: number
  desktopPollMs: number
  snapshotPushMs: number
  trayRefreshMs: number
  idleThresholdMs: number
  alertCostWarnUsd: number
  alertCostDangerUsd: number
  alertDurationWarnMs: number
  alertDurationDangerMs: number
  alertCacheHitMinRate: number
  retentionDays: number
  /** 首次回填窗口（天）：可调大后重建索引以恢复更早的历史 */
  backfillDays: number
  /** 事件费用回填版本，用于一次性重算历史流水 */
  eventsCostVersion: number
  launchAtLogin: boolean
  bridgeEnabled: boolean
  bridgePort: number
  paused: boolean
}

export type PricingStatus = 'verified' | 'pending'

/**
 * 价目表行。
 * status='verified' 仅用于能从厂商官方定价页核实的模型；
 * 无法核实时必须为 'pending' 且单价为 0 —— 此时界面费用显示 "—"，绝不猜测。
 */
export interface PricingRow {
  id: string
  provider: string
  /** 模型匹配模式，支持 `*` 通配，如 `claude-sonnet*` */
  match: string
  inputPerM: number
  outputPerM: number
  cacheReadPerM: number
  cacheWritePerM: number
  status: PricingStatus
  /** 官方来源链接，verified 行必填 */
  source?: string
  /** 计价口径补充说明，如分时计价 */
  note?: string
}

export interface TaskQuery {
  tools?: ToolId[]
  statuses?: TaskStatus[]
  from?: number
  to?: number
  keyword?: string
  limit?: number
  offset?: number
}

export interface UsageEventItem extends TokenUsage {
  id: number
  ts: number
  costUsd: number
  dedupeKey: string
}

export interface TaskDetail {
  task: TaskSnapshot
  events: UsageEventItem[]
}

export interface ToolAggregate {
  tool: ToolId
  tasks: number
  costUsd: number
  inputTokens: number
  outputTokens: number
  cacheHitRate: number | null
}

export interface DailyPoint {
  date: string
  total: number
  byTool: Partial<Record<ToolId, number>>
}

export interface CachePoint {
  date: string
  rate: number | null
}

export interface TopTaskRow {
  id: string
  title: string
  tool: ToolId
  costUsd: number
  totalTokens: number
  durationMs: number
}

export interface StatsPayload {
  from: number
  to: number
  totals: MonitorSummary
  daily: DailyPoint[]
  byTool: ToolAggregate[]
  topTasks: TopTaskRow[]
  cacheTrend: CachePoint[]
  durationBuckets: { label: string; count: number }[]
}

/** 网页端脚本上报的原始载荷（桥接服务与适配器共用） */
export interface BridgePayload {
  tool: 'yuanbao' | 'deepseek-harness'
  sessionId: string
  title?: string
  model?: string
  inputTokens?: number
  outputTokens?: number
  cacheReadTokens?: number
  cacheWriteTokens?: number
  ts?: number
  end?: boolean
}

export interface BridgeStatus {
  enabled: boolean
  port: number
  token: string
  listening: boolean
  received: number
  lastAt: number | null
  error: string | null
}

export interface ToolMeta {
  id: ToolId
  displayName: string
  vendor: string
  /** 品牌色，用于图标与图表 */
  color: string
  dataHint: string
}

export const TOOL_META: Record<ToolId, ToolMeta> = {
  codex: {
    id: 'codex',
    displayName: 'Codex',
    vendor: 'OpenAI',
    color: '#E8EEF7',
    dataHint: '~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl'
  },
  'claude-code': {
    id: 'claude-code',
    displayName: 'Claude Code',
    vendor: 'Anthropic',
    color: '#E07B4F',
    dataHint: '~/.claude/projects/<slug>/<session>.jsonl'
  },
  'deepseek-harness': {
    id: 'deepseek-harness',
    displayName: 'DeepSeek Harness',
    vendor: 'DeepSeek',
    color: '#4D6BFE',
    dataHint: 'App Support/@deepseek-ai/dsh-desktop + 桥接'
  },
  codebuddy: {
    id: 'codebuddy',
    displayName: 'CodeBuddy',
    vendor: 'Tencent',
    color: '#2DD4BF',
    dataHint: '~/.codebuddy/projects, logs'
  },
  workbuddy: {
    id: 'workbuddy',
    displayName: 'WorkBuddy',
    vendor: 'Tencent',
    color: '#7C6BFF',
    dataHint: '~/.workbuddy/workbuddy.db'
  },
  cursor: {
    id: 'cursor',
    displayName: 'Cursor',
    vendor: 'Anysphere',
    color: '#60A5FA',
    dataHint: 'App Support/Cursor/User/globalStorage/state.vscdb'
  },
  yuanbao: {
    id: 'yuanbao',
    displayName: '元宝',
    vendor: 'Tencent',
    color: '#FBBF24',
    dataHint: '网页桥接上报（无本地会话落盘）'
  }
}
