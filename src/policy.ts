import type { DeadlineLimits } from './summary-deadline.ts'

/** Admission limits and working-history policy shared by the engine and settings preview. */
export interface Policy {
  enabled: boolean
  /** Automatic planning uses a bounded recent tail; custom mode also applies the saved occupancy caps. */
  historyMode: 'automatic' | 'custom'
  /** Recent verbatim-history budget; protected instructions and the current task are counted separately. */
  recentTokens: number
  triggerPercent: number
  /** Saved custom occupancy cap. Inactive in automatic mode. */
  targetPercent: number
  earlyPercent: number
  safetyPercent: number
  summaryMaxTokens: number
  maxPasses: number
  /** Hard bound for the entire fixed-mode compaction transaction. Meaning and saved values are unchanged. */
  timeoutMs: number
  /**
   * `fixed` (default, and every existing saved configuration) keeps the saved
   * `timeoutMs` as the one hard bound of the whole compaction transaction.
   * `adaptive` is chosen explicitly in native settings and uses
   * {@link Policy.summaryTotalMs} instead, with a first-output wait and a
   * progress-renewed stall bound inside it. No mode adds a hidden extra bound.
   */
  summaryTimeoutMode: 'fixed' | 'adaptive'
  /** Adaptive only: the one visible hard bound of the whole compaction transaction. */
  summaryTotalMs: number
  /** Adaptive only: how long one call may take before its first non-empty output. */
  summaryFirstOutputMs: number
  /** Adaptive only: how long one call's output may stop progressing after it started. */
  summaryStallMs: number
  idleEnabled: boolean
  idleMinutes: number
  idleMinPercent: number
  summaryInstructions: string
  /** Bounded single repair of a structurally failed summary inside the same compaction transaction. */
  formatRepairEnabled: boolean
  /** Output cap for the repair call; its input carries only the failed response and format requirements. */
  formatRepairMaxTokens: number
  /** Absolute soft budget on the measured session occupancy, independent of window percentages. */
  absoluteEnabled: boolean
  /** Absolute soft trigger in measured session tokens; the final admission is the more conservative bound. */
  absoluteTriggerTokens: number
  /** Saved absolute occupancy cap. Active only in custom mode with the absolute budget enabled. */
  absoluteTargetTokens: number
  /** `off` keeps the Host result; `observe` measures without changing it; `reduce` publishes a verified short result. */
  toolResultsMode: 'off' | 'observe' | 'reduce'
  /** Bounded input window; a larger result is never a reduction candidate. */
  toolResultsMaxChars: number
  /** Minimum byte saving before a short result is worth publishing. */
  toolResultsMinSavings: number
  // Retention is unconditional: an original referenced by a live session is
  // never expired and uninstalling never deletes it. There is no purge action,
  // so no `archiveRetention` switch is offered — a setting nothing implements
  // would be a false promise.
  /** Extra characters one archive read may return. Bounded by the tool's own output limit. */
  archiveReadBudget: number
  /** Result budget for archive hits inside `context_history_search`. */
  archiveSearchLimit: number
  /** Read-only request-prefix fingerprint diagnostics. Never changes the request. */
  prefixDiagnosticsEnabled: boolean
}

export const defaults: Policy = {
  enabled: true, historyMode: 'automatic', recentTokens: 20000,
  triggerPercent: 80, targetPercent: 55, earlyPercent: 1,
  safetyPercent: 2, summaryMaxTokens: 8192, maxPasses: 2, timeoutMs: 90000,
  summaryTimeoutMode: 'fixed', summaryTotalMs: 600000, summaryFirstOutputMs: 120000, summaryStallMs: 180000,
  idleEnabled: true, idleMinutes: 15, idleMinPercent: 65, summaryInstructions: '',
  formatRepairEnabled: true, formatRepairMaxTokens: 2048,
  absoluteEnabled: false, absoluteTriggerTokens: 200000, absoluteTargetTokens: 100000,
  toolResultsMode: 'observe', toolResultsMaxChars: 200000, toolResultsMinSavings: 400,
  archiveReadBudget: 6000, archiveSearchLimit: 3,
  prefixDiagnosticsEnabled: true,
}

/** Validate at the settings/request boundary; invalid policy never admits work. */
export function validatePolicy(p: Policy): void {
  if (typeof p.enabled !== 'boolean') throw new Error('自动压缩开关必须是布尔值')
  if (p.historyMode !== 'automatic' && p.historyMode !== 'custom') throw new Error('历史保留策略必须为 automatic 或 custom')
  if (typeof p.idleEnabled !== 'boolean') throw new Error('闲置自动压缩开关必须是布尔值')
  if (typeof p.formatRepairEnabled !== 'boolean') throw new Error('摘要格式修复开关必须是布尔值')
  if (typeof p.absoluteEnabled !== 'boolean') throw new Error('绝对工作历史软预算开关必须是布尔值')
  if (typeof p.prefixDiagnosticsEnabled !== 'boolean') throw new Error('请求前缀指纹诊断开关必须是布尔值')
  if (p.toolResultsMode !== 'off' && p.toolResultsMode !== 'observe' && p.toolResultsMode !== 'reduce') throw new Error('工具结果精简模式必须为 off、observe 或 reduce')
  if (p.summaryTimeoutMode !== 'fixed' && p.summaryTimeoutMode !== 'adaptive') throw new Error('压缩超时模式必须为 fixed 或 adaptive')
  if (typeof p.summaryInstructions !== 'string' || p.summaryInstructions.length > 2000) throw new Error('摘要保留重点不能超过 2000 字符')
  const ranges: Record<Exclude<keyof Policy, 'enabled' | 'historyMode' | 'idleEnabled' | 'formatRepairEnabled' | 'absoluteEnabled' | 'prefixDiagnosticsEnabled' | 'toolResultsMode' | 'summaryInstructions' | 'summaryTimeoutMode'>, [number, number]> = {
    recentTokens: [1000, 128000],
    triggerPercent: [50, 95], targetPercent: [10, 75], earlyPercent: [0, 5],
    safetyPercent: [1, 10], summaryMaxTokens: [256, 32768], maxPasses: [1, 2], timeoutMs: [1000, 1800000],
    summaryTotalMs: [10000, 3600000], summaryFirstOutputMs: [5000, 900000], summaryStallMs: [5000, 1800000],
    idleMinutes: [1, 1440], idleMinPercent: [10, 95],
    formatRepairMaxTokens: [256, 8192],
    absoluteTriggerTokens: [10000, 1_000_000_000], absoluteTargetTokens: [1000, 1_000_000_000],
    toolResultsMaxChars: [2000, 4_000_000], toolResultsMinSavings: [100, 1_000_000],
    archiveReadBudget: [500, 6000], archiveSearchLimit: [1, 8],
  }
  for (const [key, [min, max]] of Object.entries(ranges)) {
    const value = p[key as keyof typeof ranges]
    if (!Number.isFinite(value) || value < min || value > max) throw new Error(`${key} 必须在 ${min}–${max} 之间`)
  }
  if (p.historyMode === 'custom' && p.targetPercent > p.triggerPercent - p.earlyPercent - 10) throw new Error('自定义占用上限须比实际检查阈值至少低 10 个百分点')
  if (p.historyMode === 'custom' && p.absoluteEnabled && p.absoluteTargetTokens > Math.floor(p.absoluteTriggerTokens * 0.8)) throw new Error('绝对占用上限须比绝对软触发至少低 20%')
  for (const key of ['recentTokens', 'summaryMaxTokens', 'maxPasses', 'timeoutMs', 'summaryTotalMs', 'summaryFirstOutputMs', 'summaryStallMs', 'idleMinutes', 'formatRepairMaxTokens', 'absoluteTriggerTokens', 'absoluteTargetTokens', 'toolResultsMaxChars', 'toolResultsMinSavings', 'archiveReadBudget', 'archiveSearchLimit'] as const) {
    if (!Number.isInteger(p[key])) throw new Error(`${key} 必须是整数`)
  }
}

export interface Budget {
  historyMode: Policy['historyMode']
  recentTokens: number
  window: number
  outputReserve: number
  safety: number
  hard: number
  trigger: number
  admission: number
  /** In automatic mode this is the admission ceiling, not the engine's planned post-compaction occupancy. */
  target: number
  /** Which constraint produced the effective admission; absolute ties win over percent/hard. */
  admissionSource: 'percent' | 'absolute' | 'hard'
  targetSource: 'working-set' | 'percent' | 'absolute' | 'admission'
  /** Effective absolute values when enabled; null otherwise. Never falsifies the model window. */
  absoluteTrigger: number | null
  absoluteTarget: number | null
}

/**
 * Output reservation, safety space, the user's trigger, and the optional
 * absolute soft budget may each lower the admission bound. The window itself
 * is reported verbatim; the absolute budget is a policy knob, not a capacity
 * claim. Deduction order: percent admission, hard envelope, absolute trigger,
 * taking the minimum. Automatic planning needs the real fixed/protected content
 * and therefore reports only the admission ceiling here. Custom mode additionally
 * applies the saved percentage/absolute occupancy caps and admission headroom.
 */
export function budget(policy: Policy, window: number, outputReserve: number): Budget {
  validatePolicy(policy)
  if (!Number.isSafeInteger(window) || window <= 0) throw new Error('当前模型未提供有效上下文窗口')
  if (!Number.isFinite(outputReserve) || outputReserve < 0) throw new Error('当前模型输出预留无效')
  const safety = Math.ceil(window * policy.safetyPercent / 100)
  const hard = Math.max(0, window - Math.ceil(outputReserve) - safety)
  const trigger = Math.min(Math.floor(window * policy.triggerPercent / 100), hard)
  const percentAdmission = Math.max(0, trigger - Math.ceil(window * policy.earlyPercent / 100))
  const requestedPercentTarget = Math.floor(window * policy.targetPercent / 100)
  const percentTarget = Math.min(requestedPercentTarget, Math.floor(percentAdmission * 0.8))
  const absoluteTrigger = policy.absoluteEnabled ? policy.absoluteTriggerTokens : null
  const absoluteTarget = policy.historyMode === 'custom' && policy.absoluteEnabled ? policy.absoluteTargetTokens : null
  const admission = Math.min(percentAdmission, hard, absoluteTrigger ?? Number.POSITIVE_INFINITY)
  const target = policy.historyMode === 'automatic' ? admission : Math.min(percentTarget, absoluteTarget ?? Number.POSITIVE_INFINITY)
  // Keep the constraint that actually shaped the value: when the hard
  // envelope clamps the percentage trigger, admission inherits that bound.
  const admissionSource: Budget['admissionSource'] = absoluteTrigger !== null && admission === absoluteTrigger ? 'absolute'
    : trigger === hard || admission === hard ? 'hard' : 'percent'
  const targetSource: Budget['targetSource'] = policy.historyMode === 'automatic' ? 'working-set'
    : absoluteTarget !== null && target === absoluteTarget ? 'absolute'
    : percentTarget < requestedPercentTarget ? 'admission' : 'percent'
  return { historyMode: policy.historyMode, recentTokens: policy.recentTokens,
    window, outputReserve, safety, hard, trigger, admission, target, admissionSource, targetSource, absoluteTrigger, absoluteTarget }
}

/**
 * Effective idle-compaction floor shared by the idle scheduler and the
 * maintenance range selection. The idle percentage floor keeps its meaning,
 * but it can never exceed the current request admission, which already
 * accounts for the output reserve, safety space and any absolute trigger.
 */
export function idleFloorTokens(policy: Policy, window: number, outputReserve: number): number {
  const limits = budget(policy, window, outputReserve)
  const minimumPercent = policy.historyMode === 'automatic' ? policy.idleMinPercent : Math.max(policy.idleMinPercent, policy.targetPercent + 10)
  const percentFloor = window * minimumPercent / 100
  return Math.min(percentFloor, limits.admission)
}

/**
 * Effective bounds. `fixed` reproduces the previous contract exactly: the saved
 * `timeoutMs` is the single hard bound of the whole transaction, and
 * first-output/stall collapse into it so no other timer can preempt it.
 */
export function deadlineLimits(policy: Readonly<Policy>): DeadlineLimits {
  if (policy.summaryTimeoutMode === 'adaptive') {
    const totalMs = policy.summaryTotalMs
    return { firstOutputMs: Math.min(policy.summaryFirstOutputMs, totalMs),
      stallMs: Math.min(policy.summaryStallMs, totalMs), totalMs }
  }
  return { firstOutputMs: policy.timeoutMs, stallMs: policy.timeoutMs, totalMs: policy.timeoutMs }
}

/** The one visible hard bound; every entry (manual, pressure, idle, repair, recovery) shares it. */
export function transactionTotalMs(policy: Readonly<Policy>): number {
  return deadlineLimits(policy).totalMs
}
