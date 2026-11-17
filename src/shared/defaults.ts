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
  backfillDays: 7,
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
const ZHIPU_SRC = 'https://docs.bigmodel.cn/cn/guide/start/pricing'
const TENCENT_SRC = 'https://cloud.tencent.com/document/api/266/130055'

/**
 * 价目表种子（单位：美元 / 百万 token，Standard 档）。
 *
 * 全部来自官方定价页，抓取时间 2026-11-17：
 * - Anthropic：Fable / Mythos / Opus / Sonnet / Haiku 全系
 * - OpenAI：gpt-6 系与 gpt-5 系 Standard 价
 * - DeepSeek：flash 与 v4-pro，取**低谷价**（高峰为其 2 倍）
 * - 智谱：GLM-5.3 / 5.3-Flash / 5.3-FlashX / 5.2 / 5.1 / 5，人民币折算
 *
 * 官方页面没有对应项的（Codex 订阅、混元内部别名等）保持 pending，不猜。
 */
export const PRICING_SEED: PricingRow[] = [
  // ── Anthropic（官方 Pricing 页，MTok）─────────────────────────
  { id: 'anthropic-fable-5.2', provider: 'Anthropic', match: 'claude-fable-5.2*', inputPerM: 8, outputPerM: 40, cacheReadPerM: 0.2, cacheWritePerM: 10, status: 'verified', source: ANTHROPIC_SRC, note: '5m 写入价；1h 写入 $16' },
  { id: 'anthropic-opus-5.5', provider: 'Anthropic', match: 'claude-opus-5.5*', inputPerM: 4, outputPerM: 20, cacheReadPerM: 0.2, cacheWritePerM: 5, status: 'verified', source: ANTHROPIC_SRC, note: '5m 写入价；1h 写入 $8' },
  { id: 'anthropic-sonnet-5.5', provider: 'Anthropic', match: 'claude-sonnet-5.5*', inputPerM: 2, outputPerM: 10, cacheReadPerM: 0.1, cacheWritePerM: 2.5, status: 'verified', source: ANTHROPIC_SRC, note: '5m 写入价；1h 写入 $4' },
  { id: 'anthropic-haiku-5.5', provider: 'Anthropic', match: 'claude-haiku-5.5*', inputPerM: 0.1, outputPerM: 0.5, cacheReadPerM: 0.01, cacheWritePerM: 0.125, status: 'verified', source: ANTHROPIC_SRC, note: '≤100K 提示；>100K 为 $0.5/$2.5' },
  { id: 'anthropic-mythos-5.2', provider: 'Anthropic', match: 'claude-mythos-5.2*', inputPerM: 8, outputPerM: 40, cacheReadPerM: 0.2, cacheWritePerM: 10, status: 'verified', source: ANTHROPIC_SRC },
  { id: 'anthropic-fable-5.1', provider: 'Anthropic', match: 'claude-fable-5.1*', inputPerM: 10, outputPerM: 50, cacheReadPerM: 0.25, cacheWritePerM: 12.5, status: 'verified', source: ANTHROPIC_SRC },
  { id: 'anthropic-mythos-5.1', provider: 'Anthropic', match: 'claude-mythos-5.1*', inputPerM: 10, outputPerM: 50, cacheReadPerM: 0.25, cacheWritePerM: 12.5, status: 'verified', source: ANTHROPIC_SRC },
  { id: 'anthropic-fable-5', provider: 'Anthropic', match: 'claude-fable-5*', inputPerM: 10, outputPerM: 50, cacheReadPerM: 1, cacheWritePerM: 12.5, status: 'verified', source: ANTHROPIC_SRC },
  { id: 'anthropic-mythos-5', provider: 'Anthropic', match: 'claude-mythos-5*', inputPerM: 10, outputPerM: 50, cacheReadPerM: 1, cacheWritePerM: 12.5, status: 'verified', source: ANTHROPIC_SRC },
  { id: 'anthropic-opus-4.8', provider: 'Anthropic', match: 'claude-opus-4.8*', inputPerM: 5, outputPerM: 25, cacheReadPerM: 0.5, cacheWritePerM: 6.25, status: 'verified', source: ANTHROPIC_SRC },
  { id: 'anthropic-opus-4.7', provider: 'Anthropic', match: 'claude-opus-4.7*', inputPerM: 5, outputPerM: 25, cacheReadPerM: 0.5, cacheWritePerM: 6.25, status: 'verified', source: ANTHROPIC_SRC },
  { id: 'anthropic-opus-4.6', provider: 'Anthropic', match: 'claude-opus-4.6*', inputPerM: 5, outputPerM: 25, cacheReadPerM: 0.5, cacheWritePerM: 6.25, status: 'verified', source: ANTHROPIC_SRC },
  { id: 'anthropic-opus-4.5', provider: 'Anthropic', match: 'claude-opus-4.5*', inputPerM: 5, outputPerM: 25, cacheReadPerM: 0.5, cacheWritePerM: 6.25, status: 'verified', source: ANTHROPIC_SRC },
  { id: 'anthropic-opus-5', provider: 'Anthropic', match: 'claude-opus-5*', inputPerM: 5, outputPerM: 25, cacheReadPerM: 0.5, cacheWritePerM: 6.25, status: 'verified', source: ANTHROPIC_SRC },
  { id: 'anthropic-opus-4.1', provider: 'Anthropic', match: 'claude-opus-4.1*', inputPerM: 15, outputPerM: 75, cacheReadPerM: 1.5, cacheWritePerM: 18.75, status: 'verified', source: ANTHROPIC_SRC },
  { id: 'anthropic-opus-4', provider: 'Anthropic', match: 'claude-opus-4*', inputPerM: 15, outputPerM: 75, cacheReadPerM: 1.5, cacheWritePerM: 18.75, status: 'verified', source: ANTHROPIC_SRC },
  { id: 'anthropic-sonnet-5', provider: 'Anthropic', match: 'claude-sonnet-5*', inputPerM: 2, outputPerM: 10, cacheReadPerM: 0.2, cacheWritePerM: 2.5, status: 'verified', source: ANTHROPIC_SRC },
  { id: 'anthropic-sonnet-4.6', provider: 'Anthropic', match: 'claude-sonnet-4.6*', inputPerM: 3, outputPerM: 15, cacheReadPerM: 0.3, cacheWritePerM: 3.75, status: 'verified', source: ANTHROPIC_SRC },
  { id: 'anthropic-sonnet-4.5', provider: 'Anthropic', match: 'claude-sonnet-4.5*', inputPerM: 3, outputPerM: 15, cacheReadPerM: 0.3, cacheWritePerM: 3.75, status: 'verified', source: ANTHROPIC_SRC },
  { id: 'anthropic-sonnet-4', provider: 'Anthropic', match: 'claude-sonnet-4*', inputPerM: 3, outputPerM: 15, cacheReadPerM: 0.3, cacheWritePerM: 3.75, status: 'verified', source: ANTHROPIC_SRC },
  { id: 'anthropic-haiku-4.5', provider: 'Anthropic', match: 'claude-haiku-4.5*', inputPerM: 1, outputPerM: 5, cacheReadPerM: 0.1, cacheWritePerM: 1.25, status: 'verified', source: ANTHROPIC_SRC },

  // ── OpenAI（官方 API Pricing 页，Standard 档）────────────────
  { id: 'openai-gpt-5.3-codex', provider: 'OpenAI', match: 'gpt-5.3-codex*', inputPerM: 1.75, outputPerM: 14, cacheReadPerM: 0.175, cacheWritePerM: 0, status: 'verified', source: OPENAI_SRC, note: 'Codex 专用档：$1.75/$14/$0.175；Priority 档 $3.5/$28' },
  { id: 'openai-gpt-6-astra', provider: 'OpenAI', match: 'gpt-6-astra*', inputPerM: 10, outputPerM: 50, cacheReadPerM: 1, cacheWritePerM: 12.5, status: 'verified', source: OPENAI_SRC, note: '缓存写入为 30m 档；12h 档 $25，长上下文翻倍' },
  { id: 'openai-gpt-6.1-sol', provider: 'OpenAI', match: 'gpt-6.1-sol*', inputPerM: 2, outputPerM: 10, cacheReadPerM: 0.1, cacheWritePerM: 2.5, status: 'verified', source: OPENAI_SRC },
  { id: 'openai-gpt-6.1-terra', provider: 'OpenAI', match: 'gpt-6.1-terra*', inputPerM: 1, outputPerM: 5, cacheReadPerM: 0.05, cacheWritePerM: 1.25, status: 'verified', source: OPENAI_SRC },
  { id: 'openai-gpt-6-luna', provider: 'OpenAI', match: 'gpt-6-luna*', inputPerM: 0.1, outputPerM: 0.5, cacheReadPerM: 0.01, cacheWritePerM: 0.125, status: 'verified', source: OPENAI_SRC },
  { id: 'openai-gpt-6-sol', provider: 'OpenAI', match: 'gpt-6-sol*', inputPerM: 2, outputPerM: 10, cacheReadPerM: 0.2, cacheWritePerM: 2.5, status: 'verified', source: OPENAI_SRC },
  { id: 'openai-gpt-5.6-sol', provider: 'OpenAI', match: 'gpt-5.6-sol*', inputPerM: 4, outputPerM: 20, cacheReadPerM: 0.4, cacheWritePerM: 5, status: 'verified', source: OPENAI_SRC },
  { id: 'openai-gpt-5.6-terra', provider: 'OpenAI', match: 'gpt-5.6-terra*', inputPerM: 2, outputPerM: 12, cacheReadPerM: 0.2, cacheWritePerM: 2.5, status: 'verified', source: OPENAI_SRC },
  { id: 'openai-gpt-5.6-luna', provider: 'OpenAI', match: 'gpt-5.6-luna*', inputPerM: 0.2, outputPerM: 1.2, cacheReadPerM: 0.02, cacheWritePerM: 0.25, status: 'verified', source: OPENAI_SRC },
  { id: 'openai-gpt-5.5', provider: 'OpenAI', match: 'gpt-5.5*', inputPerM: 5, outputPerM: 30, cacheReadPerM: 0.5, cacheWritePerM: 0, status: 'verified', source: OPENAI_SRC, note: '<272K 上下文；更长时 $10/$45' },
  { id: 'openai-gpt-5.4', provider: 'OpenAI', match: 'gpt-5.4*', inputPerM: 2.5, outputPerM: 15, cacheReadPerM: 0.25, cacheWritePerM: 0, status: 'verified', source: OPENAI_SRC, note: '<272K 上下文；更长时 $5/$22.5' },
  { id: 'openai-gpt-5.2', provider: 'OpenAI', match: 'gpt-5.2*', inputPerM: 1.75, outputPerM: 14, cacheReadPerM: 0.175, cacheWritePerM: 0, status: 'verified', source: OPENAI_SRC },
  { id: 'openai-gpt-5.1', provider: 'OpenAI', match: 'gpt-5.1*', inputPerM: 1.25, outputPerM: 10, cacheReadPerM: 0.125, cacheWritePerM: 0, status: 'verified', source: OPENAI_SRC },
  { id: 'openai-gpt-5', provider: 'OpenAI', match: 'gpt-5*', inputPerM: 1.25, outputPerM: 10, cacheReadPerM: 0.125, cacheWritePerM: 0, status: 'verified', source: OPENAI_SRC },
  { id: 'openai-gpt-5-mini', provider: 'OpenAI', match: 'gpt-5-mini*', inputPerM: 0.25, outputPerM: 2, cacheReadPerM: 0.025, cacheWritePerM: 0, status: 'verified', source: OPENAI_SRC },
  { id: 'openai-gpt-5-nano', provider: 'OpenAI', match: 'gpt-5-nano*', inputPerM: 0.05, outputPerM: 0.4, cacheReadPerM: 0.005, cacheWritePerM: 0, status: 'verified', source: OPENAI_SRC },

  // ── DeepSeek（官方 Pricing 页，分时计价）────────────────────
  // 高峰时段：UTC 01:00-04:00、06:00-10:00（周一至周五，对应北京时间 09:00-12:00、14:00-18:00）；
  // 中国法定节假日全天按低谷计（节假日无法静态枚举，这里只按工作日+时段判定）。
  {
    id: 'deepseek-flash',
    provider: 'DeepSeek',
    match: 'deepseek-flash*',
    inputPerM: 0.15,
    outputPerM: 0.6,
    cacheReadPerM: 0.003,
    cacheWritePerM: 0.15,
    peak: { inputPerM: 0.3, outputPerM: 1.2, cacheReadPerM: 0.006, cacheWritePerM: 0.3 },
    peakHoursUtc: [
      [1, 4],
      [6, 10]
    ],
    peakWeekdaysOnly: true,
    status: 'verified',
    source: DEEPSEEK_SRC,
    note: '低谷 $0.15/$0.6；高峰为 UTC 01-04、06-10（周一至周五，北京时间 09-12、14-18），价格翻倍'
  },
  {
    id: 'deepseek-v4.1-flash',
    provider: 'DeepSeek',
    match: 'deepseek-v4.1-flash*',
    inputPerM: 0.15,
    outputPerM: 0.6,
    cacheReadPerM: 0.003,
    cacheWritePerM: 0.15,
    peak: { inputPerM: 0.3, outputPerM: 1.2, cacheReadPerM: 0.006, cacheWritePerM: 0.3 },
    peakHoursUtc: [
      [1, 4],
      [6, 10]
    ],
    peakWeekdaysOnly: true,
    status: 'verified',
    source: DEEPSEEK_SRC,
    note: '官方注明 deepseek-v4-flash 等旧名按 Flash 价计费'
  },
  {
    id: 'deepseek-v4-flash-legacy',
    provider: 'DeepSeek',
    match: 'deepseek-v4-flash*',
    inputPerM: 0.15,
    outputPerM: 0.6,
    cacheReadPerM: 0.003,
    cacheWritePerM: 0.15,
    peak: { inputPerM: 0.3, outputPerM: 1.2, cacheReadPerM: 0.006, cacheWritePerM: 0.3 },
    peakHoursUtc: [
      [1, 4],
      [6, 10]
    ],
    peakWeekdaysOnly: true,
    status: 'verified',
    source: DEEPSEEK_SRC,
    note: '旧名由 V4.1-Flash 承接，按 Flash 价计费'
  },
  {
    id: 'deepseek-v4-pro',
    provider: 'DeepSeek',
    match: 'deepseek-v4-pro*',
    inputPerM: 0.66,
    outputPerM: 1.98,
    cacheReadPerM: 0.022,
    cacheWritePerM: 0.66,
    peak: { inputPerM: 1.32, outputPerM: 3.96, cacheReadPerM: 0.044, cacheWritePerM: 1.32 },
    peakHoursUtc: [
      [1, 4],
      [6, 10]
    ],
    peakWeekdaysOnly: true,
    status: 'verified',
    source: DEEPSEEK_SRC,
    note: '低谷 $0.66/$1.98；高峰（北京时间 09:00-12:00、14:00-18:00）翻倍'
  },

  // ── 智谱 GLM（官方人民币价 ÷ 7.1）──────────────────────────
  { id: 'zhipu-glm-5.3', provider: 'Zhipu', match: 'glm-5.3', inputPerM: 8, outputPerM: 28, cacheReadPerM: 2, cacheWritePerM: 0, currency: 'CNY', status: 'verified', source: ZHIPU_SRC, note: '官方 ¥8/¥28（命中 ¥2）/百万（人民币报价，入库按 7.1 折美元）' },
  { id: 'zhipu-glm-5.3-flash', provider: 'Zhipu', match: 'glm-5.3-flash*', inputPerM: 0.8, outputPerM: 2.8, cacheReadPerM: 0.23, cacheWritePerM: 0, currency: 'CNY', status: 'verified', source: ZHIPU_SRC, note: '官方 ¥0.8/¥2.8（命中 ¥0.23）/百万（人民币报价，入库按 7.1 折美元）' },
  { id: 'zhipu-glm-5.3-flashx', provider: 'Zhipu', match: 'glm-5.3-flashx*', inputPerM: 2, outputPerM: 7, cacheReadPerM: 0.57, cacheWritePerM: 0, currency: 'CNY', status: 'verified', source: ZHIPU_SRC, note: '官方 ¥2/¥7（命中 ¥0.57）/百万（人民币报价，入库按 7.1 折美元）' },
  { id: 'zhipu-glm-5.2', provider: 'Zhipu', match: 'glm-5.2*', inputPerM: 8, outputPerM: 28, cacheReadPerM: 2, cacheWritePerM: 0, currency: 'CNY', status: 'verified', source: ZHIPU_SRC, note: '官方 ¥8/¥28（命中 ¥2）/百万（人民币报价，入库按 7.1 折美元）' },
  { id: 'zhipu-glm-5.1', provider: 'Zhipu', match: 'glm-5.1*', inputPerM: 6, outputPerM: 24, cacheReadPerM: 1.3, cacheWritePerM: 0, currency: 'CNY', status: 'verified', source: ZHIPU_SRC, note: '≤32K 档；≥32K 为 ¥8/¥28，按 7.1 折算' },
  { id: 'zhipu-glm-5', provider: 'Zhipu', match: 'glm-5*', inputPerM: 4, outputPerM: 18, cacheReadPerM: 1, cacheWritePerM: 0, currency: 'CNY', status: 'verified', source: ZHIPU_SRC, note: '≤32K 档；≥32K 为 ¥6/¥22，按 7.1 折算' },

  // ── 腾讯混元（TokenHub 模型价格页，人民币折算）──────────────
  { id: 'tencent-hy4', provider: 'Tencent', match: 'hy4*', inputPerM: 6, outputPerM: 18, cacheReadPerM: 0.3, cacheWritePerM: 0, currency: 'CNY', status: 'verified', source: TENCENT_SRC, note: '官方 ¥6/¥18（命中 ¥0.3）/百万（人民币报价，入库按 7.1 折美元）' },
  { id: 'tencent-hy4-preview', provider: 'Tencent', match: 'hy4-preview*', inputPerM: 6, outputPerM: 18, cacheReadPerM: 0.3, cacheWritePerM: 0, currency: 'CNY', status: 'verified', source: TENCENT_SRC, note: '与 Hy4 同价：¥6/¥18（命中 ¥0.3）/百万' },
  { id: 'tencent-hy4-flash', provider: 'Tencent', match: 'hy4-flash*', inputPerM: 0.5, outputPerM: 2, cacheReadPerM: 0.02, cacheWritePerM: 0, currency: 'CNY', status: 'verified', source: TENCENT_SRC, note: 'Hy4 flash：¥0.5/¥2（命中 ¥0.02）/百万' },
  { id: 'tencent-hy3', provider: 'Tencent', match: 'hy3*', inputPerM: 1, outputPerM: 4, cacheReadPerM: 0.25, cacheWritePerM: 0, currency: 'CNY', status: 'verified', source: TENCENT_SRC, note: 'Hy3：¥1/¥4（命中 ¥0.25）/百万' },

  // ── 待确认：官方价目表未列，禁止推算 ────────────────────────
  { id: 'tencent-hy-free', provider: 'Tencent', match: 'hy4-free*', inputPerM: 0, outputPerM: 0, cacheReadPerM: 0, cacheWritePerM: 0, status: 'pending', note: 'WorkBuddy 免费档位（-free），官方无单价' },
  { id: 'tencent-hy4-flash-free', provider: 'Tencent', match: 'hy4-flash-free*', inputPerM: 0, outputPerM: 0, cacheReadPerM: 0, cacheWritePerM: 0, status: 'pending', note: 'WorkBuddy 免费档位（-free），官方无单价' },
  { id: 'tencent-hy-generic', provider: 'Tencent', match: 'hy*', inputPerM: 0, outputPerM: 0, cacheReadPerM: 0, cacheWritePerM: 0, status: 'pending', note: '未识别的混元别名，需补录' },
  { id: 'openai-codex-subscription', provider: 'OpenAI', match: 'codex-auto-review*', inputPerM: 0, outputPerM: 0, cacheReadPerM: 0, cacheWritePerM: 0, status: 'pending', note: 'Codex 内部自动审查线程，不计费也不应建成任务' },
  { id: 'fallback', provider: '未知', match: '*', inputPerM: 0, outputPerM: 0, cacheReadPerM: 0, cacheWritePerM: 0, status: 'pending', note: '未匹配任何已核实模型' }
]
