/** Current official tariff schedule, checked 2026-09-27.
 * https://api-docs.deepseek.com/zh-cn/quick_start/pricing/
 * 2026 public holiday calendar: State Council, 国办发明电〔2025〕7号
 * https://www.gov.cn/zhengce/zhengceku/202511/content_7047091.htm
 * For the live indicator only; never use this snapshot to price past calls.
 */
export const PRICING_URL = 'https://api-docs.deepseek.com/zh-cn/quick_start/pricing/'
export const RULE_CHECKED = '2026-09-27'
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
    && ['deepseek-flash', 'deepseek-v4-flash', 'deepseek-v4-flash-vision-exp', 'deepseek-v4-pro'].includes(selection.model)
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
