import type { AppSettings, PricingRow } from './types'

export const DEFAULT_SETTINGS: AppSettings = {
  currency: 'USD',
  fxRate: 7.2,
  fileDebounceMs: 300,
  processProbeMs: 5_000,
  desktopPollMs: 10_000,
  snapshotPushMs: 2_000,
  trayRefreshMs: 5_000,
  idleThresholdMs: 90_000,
  alertCostWarnUsd: 1,
  alertCostDangerUsd: 5,
  alertDurationWarnMs: 30 * 60_000,
  alertDurationDangerMs: 120 * 60_000,
  alertCacheHitMinRate: 0.3,
  retentionDays: 90,
  eventsCostVersion: 0,
  launchAtLogin: false,
  bridgeEnabled: true,
  bridgePort: 43117,
  paused: false
}

export const SETTINGS_BOUNDS: Record<string, { min: number; max: number; step: number; unit: string }> = {
  fileDebounceMs: { min: 100, max: 2000, step: 100, unit: 'ms' },
  processProbeMs: { min: 2000, max: 30_000, step: 1000, unit: 'ms' },
  desktopPollMs: { min: 3000, max: 60_000, step: 1000, unit: 'ms' },
  snapshotPushMs: { min: 1000, max: 10_000, step: 500, unit: 'ms' },
  trayRefreshMs: { min: 2000, max: 30_000, step: 1000, unit: 'ms' },
  idleThresholdMs: { min: 30_000, max: 600_000, step: 10_000, unit: 'ms' },
  alertCostWarnUsd: { min: 0.1, max: 50, step: 0.1, unit: 'USD' },
  alertCostDangerUsd: { min: 1, max: 200, step: 1, unit: 'USD' },
  alertDurationWarnMs: { min: 300_000, max: 7_200_000, step: 300_000, unit: 'ms' },
  alertDurationDangerMs: { min: 600_000, max: 28_800_000, step: 600_000, unit: 'ms' },
  alertCacheHitMinRate: { min: 0, max: 1, step: 0.05, unit: 'rate' },
  retentionDays: { min: 7, max: 365, step: 1, unit: 'day' },
  fxRate: { min: 5, max: 10, step: 0.01, unit: 'CNY/USD' }
}

const ANTHROPIC_SRC = 'https://platform.claude.com/docs/en/about-claude/pricing'
const OPENAI_SRC = 'https://platform.openai.com/docs/pricing'
const DEEPSEEK_SRC = 'https://api-docs.deepseek.com/quick_start/pricing'

/**
 * 内置种子价目表（USD / 每百万 token），首次启动写入 pricing 表，之后用户可编辑。
 *
 * 规则：
 *  - status='verified' 的行价格来自厂商官方定价页（source 字段给出链接）
 *  - 无法核实的模型（Codex 订阅制、腾讯/智谱自有模型等）一律 status='pending'、单价为 0，
 *    界面费用显示 "—"，不做任何推算
 */
export const PRICING_SEED: PricingRow[] = [
  // ── Anthropic（官方 Pricing 页）─────────────────────────────
  { id: 'anthropic-opus-5.5', provider: 'Anthropic', match: 'claude-opus-5.5*', inputPerM: 4, outputPerM: 20, cacheReadPerM: 0.2, cacheWritePerM: 5, status: 'verified', source: ANTHROPIC_SRC },
  { id: 'anthropic-opus-5', provider: 'Anthropic', match: 'claude-opus-5*', inputPerM: 5, outputPerM: 25, cacheReadPerM: 0.5, cacheWritePerM: 6.25, status: 'verified', source: ANTHROPIC_SRC },
  { id: 'anthropic-opus-4.5', provider: 'Anthropic', match: 'claude-opus-4.5*', inputPerM: 5, outputPerM: 25, cacheReadPerM: 0.5, cacheWritePerM: 6.25, status: 'verified', source: ANTHROPIC_SRC },
  { id: 'anthropic-opus-4.1', provider: 'Anthropic', match: 'claude-opus-4.1*', inputPerM: 15, outputPerM: 75, cacheReadPerM: 1.5, cacheWritePerM: 18.75, status: 'verified', source: ANTHROPIC_SRC },
  { id: 'anthropic-opus-4', provider: 'Anthropic', match: 'claude-opus-4*', inputPerM: 15, outputPerM: 75, cacheReadPerM: 1.5, cacheWritePerM: 18.75, status: 'verified', source: ANTHROPIC_SRC },
  { id: 'anthropic-sonnet-5.5', provider: 'Anthropic', match: 'claude-sonnet-5.5*', inputPerM: 2, outputPerM: 10, cacheReadPerM: 0.1, cacheWritePerM: 2.5, status: 'verified', source: ANTHROPIC_SRC },
  { id: 'anthropic-sonnet-5', provider: 'Anthropic', match: 'claude-sonnet-5*', inputPerM: 2, outputPerM: 10, cacheReadPerM: 0.2, cacheWritePerM: 2.5, status: 'verified', source: ANTHROPIC_SRC },
  { id: 'anthropic-sonnet-4', provider: 'Anthropic', match: 'claude-sonnet-4*', inputPerM: 3, outputPerM: 15, cacheReadPerM: 0.3, cacheWritePerM: 3.75, status: 'verified', source: ANTHROPIC_SRC },
  { id: 'anthropic-haiku-5.5', provider: 'Anthropic', match: 'claude-haiku-5.5*', inputPerM: 0.1, outputPerM: 0.5, cacheReadPerM: 0.01, cacheWritePerM: 0.125, status: 'verified', source: ANTHROPIC_SRC, note: '≤100K 提示；>100K 为 $0.5/$2.5' },
  { id: 'anthropic-haiku-4.5', provider: 'Anthropic', match: 'claude-haiku-4.5*', inputPerM: 1, outputPerM: 5, cacheReadPerM: 0.1, cacheWritePerM: 1.25, status: 'verified', source: ANTHROPIC_SRC },

  // ── OpenAI（官方 API Pricing 页，Standard 档）────────────────
  { id: 'openai-gpt-6-astra', provider: 'OpenAI', match: 'gpt-6-astra*', inputPerM: 10, outputPerM: 50, cacheReadPerM: 1, cacheWritePerM: 12.5, status: 'verified', source: OPENAI_SRC, note: '缓存写入为 30m 档；12h 档 $25' },
  { id: 'openai-gpt-6.1-sol', provider: 'OpenAI', match: 'gpt-6.1-sol*', inputPerM: 2, outputPerM: 10, cacheReadPerM: 0.1, cacheWritePerM: 2.5, status: 'verified', source: OPENAI_SRC },
  { id: 'openai-gpt-6.1-terra', provider: 'OpenAI', match: 'gpt-6.1-terra*', inputPerM: 1, outputPerM: 5, cacheReadPerM: 0.05, cacheWritePerM: 1.25, status: 'verified', source: OPENAI_SRC },
  { id: 'openai-gpt-6-luna', provider: 'OpenAI', match: 'gpt-6-luna*', inputPerM: 0.1, outputPerM: 0.5, cacheReadPerM: 0.01, cacheWritePerM: 0.125, status: 'verified', source: OPENAI_SRC },

  // ── DeepSeek（官方 Pricing 页，低谷价）──────────────────────
  { id: 'deepseek-flash', provider: 'DeepSeek', match: 'deepseek-flash*', inputPerM: 0.15, outputPerM: 0.6, cacheReadPerM: 0.003, cacheWritePerM: 0.15, status: 'verified', source: DEEPSEEK_SRC, note: '低谷价；高峰（UTC 周一至周五 01-04 / 06-10 点）为 2 倍' },
  { id: 'deepseek-v4-pro', provider: 'DeepSeek', match: 'deepseek-v4-pro*', inputPerM: 0.66, outputPerM: 1.98, cacheReadPerM: 0.022, cacheWritePerM: 0.66, status: 'verified', source: DEEPSEEK_SRC, note: '低谷价；高峰为 2 倍' },

  // ── 待确认：官方 API 价目表未列，禁止推算 ────────────────────
  { id: 'openai-codex', provider: 'OpenAI', match: 'codex-*', inputPerM: 0, outputPerM: 0, cacheReadPerM: 0, cacheWritePerM: 0, status: 'pending', note: 'Codex 走订阅额度，API 定价页无 token 单价，需查订阅账单后手工补录' },
  { id: 'tencent-hy', provider: 'Tencent', match: 'hy*', inputPerM: 0, outputPerM: 0, cacheReadPerM: 0, cacheWritePerM: 0, status: 'pending', note: '未找到官方公开单价' },
  { id: 'zhipu-glm', provider: 'Zhipu', match: 'glm-*', inputPerM: 0, outputPerM: 0, cacheReadPerM: 0, cacheWritePerM: 0, status: 'pending', note: '未找到官方公开单价' },
  { id: 'fallback', provider: '未知', match: '*', inputPerM: 0, outputPerM: 0, cacheReadPerM: 0, cacheWritePerM: 0, status: 'pending', note: '未匹配任何已核实模型' }
]
