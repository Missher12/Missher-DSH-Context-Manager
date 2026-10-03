/** Percentage policy shared by the admission gate and settings preview. */
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
}

export const defaults: Policy = {
  enabled: true, triggerPercent: 80, targetPercent: 55, earlyPercent: 1,
  safetyPercent: 2, summaryMaxTokens: 8192, maxPasses: 2, timeoutMs: 90000,
  idleEnabled: true, idleMinutes: 15, idleMinPercent: 65, summaryInstructions: '',
}

/** Validate at the settings/request boundary; invalid policy never admits work. */
export function validatePolicy(p: Policy): void {
  if (typeof p.enabled !== 'boolean') throw new Error('自动压缩开关必须是布尔值')
  if (typeof p.idleEnabled !== 'boolean') throw new Error('闲置自动压缩开关必须是布尔值')
  if (typeof p.summaryInstructions !== 'string' || p.summaryInstructions.length > 2000) throw new Error('摘要保留重点不能超过 2000 字符')
  const ranges: Record<Exclude<keyof Policy, 'enabled' | 'idleEnabled' | 'summaryInstructions'>, [number, number]> = {
    triggerPercent: [50, 95], targetPercent: [10, 75], earlyPercent: [0, 5],
    safetyPercent: [1, 10], summaryMaxTokens: [256, 32768], maxPasses: [1, 2], timeoutMs: [1000, 300000],
    idleMinutes: [1, 1440], idleMinPercent: [10, 95],
  }
  for (const [key, [min, max]] of Object.entries(ranges)) {
    const value = p[key as keyof typeof ranges]
    if (!Number.isFinite(value) || value < min || value > max) throw new Error(`${key} 必须在 ${min}–${max} 之间`)
  }
  if (p.targetPercent > p.triggerPercent - p.earlyPercent - 10) throw new Error('压缩目标须比实际检查阈值至少低 10 个百分点')
  for (const key of ['summaryMaxTokens', 'maxPasses', 'timeoutMs', 'idleMinutes'] as const) {
    if (!Number.isInteger(p[key])) throw new Error(`${key} 必须是整数`)
  }
}

/** Output reservation and safety space may lower the user's trigger. */
export function budget(policy: Policy, window: number, outputReserve: number) {
  validatePolicy(policy)
  if (!Number.isSafeInteger(window) || window <= 0) throw new Error('当前模型未提供有效上下文窗口')
  if (!Number.isFinite(outputReserve) || outputReserve < 0) throw new Error('当前模型输出预留无效')
  const safety = Math.ceil(window * policy.safetyPercent / 100)
  const hard = Math.max(0, window - Math.ceil(outputReserve) - safety)
  const trigger = Math.min(Math.floor(window * policy.triggerPercent / 100), hard)
  const admission = Math.max(0, trigger - Math.ceil(window * policy.earlyPercent / 100))
  const target = Math.min(Math.floor(window * policy.targetPercent / 100), Math.floor(admission * 0.8))
  return { window, outputReserve, safety, hard, trigger, admission, target }
}
