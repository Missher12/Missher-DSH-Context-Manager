/** Current official tariff schedule, checked 2026-09-29.
 * https://api-docs.deepseek.com/zh-cn/quick_start/pricing/
 * 2026 public holiday calendar: State Council, 国办发明电〔2025〕7号
 * https://www.gov.cn/zhengce/zhengceku/202511/content_7047091.htm
 * For the live indicator only; never use this snapshot to price past calls.
 */
export const PRICING_URL = 'https://api-docs.deepseek.com/zh-cn/quick_start/pricing/'
export const RULE_CHECKED = '2026-09-29'
const HOUR = 3_600_000
const DAY = 24 * HOUR
const BEIJING_OFFSET = 8 * HOUR
const HOLIDAYS_2026 = [
  ['01-01', '01-03'], ['02-15', '02-23'], ['04-04', '04-06'],
  ['05-01', '05-05'], ['06-19', '06-21'], ['09-25', '09-27'], ['10-01', '10-07'],
] as const
export type Period = 'peak' | 'offpeak' | 'unknown'

/** Match host-owned official routes, never a model name on a third-party route. */
export function isOfficialDeepSeek(selection: { provider: string; model: string } | null | undefined) {
  return !!selection && ['deepseek-official', 'deepseek-account'].includes(selection.provider)
}

export interface ModelPrice { name: string; cache: number; input: number; output: number }
/** CNY per million tokens. Aliases follow the official routing table, not name prefixes. */
export function modelPrice(model: string): ModelPrice | null {
  if (['deepseek-flash', 'deepseek-v4-flash', 'deepseek-v4-flash-vision-exp'].includes(model)) return { name: 'DeepSeek V4.1-Flash', cache: 0.04, input: 2, output: 8 }
  if (model === 'deepseek-v4-pro') return { name: 'DeepSeek V4-Pro-0813', cache: 0.30, input: 9, output: 27 }
  return null
}

/** Blank is unknown, not zero. Reject partial numbers and unsafe integer counts. */
export function tokenCount(value: string): number | null {
  if (!/^\d+$/u.test(value.trim())) return null
  const count = Number(value)
  return Number.isSafeInteger(count) && count >= 0 ? count : null
}

/** Compare the same hypothetical usage in both periods; never price a past request. */
export function compareCost(price: ModelPrice, values: { cache: string; input: string; output: string }): { peak: number; offpeak: number } | null {
  const cache = tokenCount(values.cache), input = tokenCount(values.input), output = tokenCount(values.output)
  if (cache === null || input === null || output === null) return null
  const peak = (cache * price.cache + input * price.input + output * price.output) / 1_000_000
  return { peak, offpeak: peak / 2 }
}

export function periodAt(now: number): Period {
  if (!Number.isFinite(now)) return 'unknown'
  const beijing = new Date(now + BEIJING_OFFSET)
  // Do not silently apply an incomplete holiday calendar to another year.
  if (beijing.getUTCFullYear() !== 2026) return 'unknown'
  const day = beijing.getUTCDay()
  const date = beijing.toISOString().slice(5, 10)
  // Official weekends remain off-peak even on make-up working days.
  if (day === 0 || day === 6 || HOLIDAYS_2026.some(([start, end]) => date >= start && date <= end)) return 'offpeak'
  const hour = beijing.getUTCHours()
  return (hour >= 9 && hour < 12) || (hour >= 14 && hour < 18) ? 'peak' : 'offpeak'
}

export function nextPeriodChange(now: number): number | null {
  const current = periodAt(now)
  if (current === 'unknown') return null
  const midnight = Math.floor((now + BEIJING_OFFSET) / DAY) * DAY - BEIJING_OFFSET
  for (let day = 0; day <= 14; day++) {
    for (const hour of [0, 9, 12, 14, 18]) {
      const candidate = midnight + day * DAY + hour * HOUR
      if (candidate <= now) continue
      const next = periodAt(candidate)
      if (next === 'unknown') return null
      if (next !== current) return candidate
    }
  }
  return null
}

export function beijingTime(now: number): string {
  const date = new Date(now + BEIJING_OFFSET)
  return `${date.getUTCMonth() + 1}月${date.getUTCDate()}日 ${String(date.getUTCHours()).padStart(2, '0')}:${String(date.getUTCMinutes()).padStart(2, '0')}`
}
