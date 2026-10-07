/** Percentage plus absolute working-history policy shared by the admission gate and settings preview. */
export interface Policy {
  enabled: boolean
  triggerPercent: number
  targetPercent: number
  earlyPercent: number
  safetyPercent: number
  summaryMaxTokens: number
  maxPasses: number
  timeoutMs: number
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
  /** Absolute soft target in measured session tokens; the final target is the more conservative bound. */
  absoluteTargetTokens: number
}

export const defaults: Policy = {
  enabled: true, triggerPercent: 80, targetPercent: 55, earlyPercent: 1,
  safetyPercent: 2, summaryMaxTokens: 8192, maxPasses: 2, timeoutMs: 90000,
  idleEnabled: true, idleMinutes: 15, idleMinPercent: 65, summaryInstructions: '',
  formatRepairEnabled: true, formatRepairMaxTokens: 2048,
  absoluteEnabled: false, absoluteTriggerTokens: 200000, absoluteTargetTokens: 100000,
}

/** Validate at the settings/request boundary; invalid policy never admits work. */
export function validatePolicy(p: Policy): void {
  if (typeof p.enabled !== 'boolean') throw new Error('自动压缩开关必须是布尔值')
  if (typeof p.idleEnabled !== 'boolean') throw new Error('闲置自动压缩开关必须是布尔值')
  if (typeof p.formatRepairEnabled !== 'boolean') throw new Error('摘要格式修复开关必须是布尔值')
  if (typeof p.absoluteEnabled !== 'boolean') throw new Error('绝对工作历史软预算开关必须是布尔值')
  if (typeof p.summaryInstructions !== 'string' || p.summaryInstructions.length > 2000) throw new Error('摘要保留重点不能超过 2000 字符')
  const ranges: Record<Exclude<keyof Policy, 'enabled' | 'idleEnabled' | 'formatRepairEnabled' | 'absoluteEnabled' | 'summaryInstructions'>, [number, number]> = {
    triggerPercent: [50, 95], targetPercent: [10, 75], earlyPercent: [0, 5],
    safetyPercent: [1, 10], summaryMaxTokens: [256, 32768], maxPasses: [1, 2], timeoutMs: [1000, 300000],
    idleMinutes: [1, 1440], idleMinPercent: [10, 95],
    formatRepairMaxTokens: [256, 8192],
    absoluteTriggerTokens: [10000, 1_000_000_000], absoluteTargetTokens: [1000, 1_000_000_000],
  }
  for (const [key, [min, max]] of Object.entries(ranges)) {
    const value = p[key as keyof typeof ranges]
    if (!Number.isFinite(value) || value < min || value > max) throw new Error(`${key} 必须在 ${min}–${max} 之间`)
  }
  if (p.targetPercent > p.triggerPercent - p.earlyPercent - 10) throw new Error('压缩目标须比实际检查阈值至少低 10 个百分点')
  if (p.absoluteEnabled && p.absoluteTargetTokens > Math.floor(p.absoluteTriggerTokens * 0.8)) throw new Error('绝对软目标须比绝对软触发至少低 20%')
  for (const key of ['summaryMaxTokens', 'maxPasses', 'timeoutMs', 'idleMinutes', 'formatRepairMaxTokens', 'absoluteTriggerTokens', 'absoluteTargetTokens'] as const) {
    if (!Number.isInteger(p[key])) throw new Error(`${key} 必须是整数`)
  }
}

export interface Budget {
  window: number
  outputReserve: number
  safety: number
  hard: number
  trigger: number
  admission: number
  target: number
  /** Which constraint produced the effective admission; absolute ties win over percent/hard. */
  admissionSource: 'percent' | 'absolute' | 'hard'
  targetSource: 'percent' | 'absolute'
  /** Effective absolute values when enabled; null otherwise. Never falsifies the model window. */
  absoluteTrigger: number | null
  absoluteTarget: number | null
}

/**
 * Output reservation, safety space, the user's trigger, and the optional
 * absolute soft budget may each lower the admission bound. The window itself
 * is reported verbatim; the absolute budget is a policy knob, not a capacity
 * claim. Deduction order: percent admission, hard envelope, absolute trigger,
 * taking the minimum. The target likewise takes the minimum of the percent
 * target and the absolute target.
 */
export function budget(policy: Policy, window: number, outputReserve: number): Budget {
  validatePolicy(policy)
  if (!Number.isSafeInteger(window) || window <= 0) throw new Error('当前模型未提供有效上下文窗口')
  if (!Number.isFinite(outputReserve) || outputReserve < 0) throw new Error('当前模型输出预留无效')
  const safety = Math.ceil(window * policy.safetyPercent / 100)
  const hard = Math.max(0, window - Math.ceil(outputReserve) - safety)
  const trigger = Math.min(Math.floor(window * policy.triggerPercent / 100), hard)
  const percentAdmission = Math.max(0, trigger - Math.ceil(window * policy.earlyPercent / 100))
  const percentTarget = Math.min(Math.floor(window * policy.targetPercent / 100), Math.floor(percentAdmission * 0.8))
  const absoluteTrigger = policy.absoluteEnabled ? policy.absoluteTriggerTokens : null
  const absoluteTarget = policy.absoluteEnabled ? policy.absoluteTargetTokens : null
  const admission = Math.min(percentAdmission, hard, absoluteTrigger ?? Number.POSITIVE_INFINITY)
  const target = Math.min(percentTarget, absoluteTarget ?? Number.POSITIVE_INFINITY)
  // Keep the constraint that actually shaped the value: when the hard
  // envelope clamps the percentage trigger, admission inherits that bound.
  const admissionSource: Budget['admissionSource'] = absoluteTrigger !== null && admission === absoluteTrigger ? 'absolute'
    : trigger === hard || admission === hard ? 'hard' : 'percent'
  const targetSource: Budget['targetSource'] = absoluteTarget !== null && target === absoluteTarget ? 'absolute' : 'percent'
  return { window, outputReserve, safety, hard, trigger, admission, target, admissionSource, targetSource, absoluteTrigger, absoluteTarget }
}

/**
 * Effective idle-compaction floor shared by the idle scheduler and the
 * maintenance range selection. The idle percentage floor keeps its meaning,
 * but it can never exceed the current request admission, which already
 * accounts for the output reserve, safety space and any absolute trigger.
 */
export function idleFloorTokens(policy: Policy, window: number, outputReserve: number): number {
  const limits = budget(policy, window, outputReserve)
  const percentFloor = window * Math.max(policy.idleMinPercent, policy.targetPercent + 10) / 100
  return Math.min(percentFloor, limits.admission)
}
