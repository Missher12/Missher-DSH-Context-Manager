import { isOfficialDeepSeek, modelPrice, type Period } from './deepseek-period.ts'
import type { Attribution, CostUsageGroup } from './efficiency.ts'

export type SessionCostIssue = 'missing-usage' | 'unknown-route' | 'unknown-period' | 'cache-write'
  | 'maintenance-overlap' | 'summary-unpriced' | 'host-difference'

export interface SessionCostReadout {
  hasRecords: boolean
  settledAttempts: number
  retries: number
  /** Sum of the disjoint token buckets reported by ordinary session settlements. */
  requestTokens: number
  requestTokensPartial: boolean
  summary: { tokens: number; attempts: number; unknownAttempts: number } | null
  peak: number | null
  offpeak: number | null
  total: number | null
  partial: boolean
  issues: SessionCostIssue[]
}

const BUCKETS = ['uncachedInput', 'cacheRead', 'cacheWrite', 'output'] as const

function groupTokens(group: CostUsageGroup): number {
  return BUCKETS.reduce((sum, key) => sum + group[key].sum, 0)
}

/** Estimate only supported, non-overlapping recorded usage; unknown fields never become zero. */
export function estimateSessionCost(attribution: Attribution): SessionCostReadout {
  const issues = new Set<SessionCostIssue>()
  const mirroredTokens = attribution.costUsage.reduce((sum, group) => sum + groupTokens(group), 0)
  const hostTokens = attribution.host === undefined ? null
    : attribution.host.uncachedInputTokens + attribution.host.cacheReadTokens + attribution.host.cacheWriteTokens + attribution.host.outputTokens
  const requestTokens = hostTokens ?? mirroredTokens
  let requestTokensPartial = attribution.mirrored.withoutUsage > 0
  let peak = 0
  let offpeak = 0
  let pricedGroups = 0

  for (const group of attribution.costUsage) {
    if (group.withoutUsage > 0 || BUCKETS.some(key => group[key].missing > 0)) {
      requestTokensPartial = true
      issues.add('missing-usage')
    }
    if (group.maintenanceSuspect) {
      if (group.settledAttempts > 0) issues.add('maintenance-overlap')
      continue
    }

    const price = group.routeKnown && isOfficialDeepSeek({ provider: group.provider, model: group.model })
      ? modelPrice(group.model) : null
    const tokens = groupTokens(group)
    const hasUnknownTokens = group.withoutUsage > 0 || BUCKETS.some(key => group[key].missing > 0)
    if (group.cacheWrite.sum > 0 || group.cacheWrite.missing > 0) issues.add('cache-write')
    if (!price) {
      if (tokens > 0 || hasUnknownTokens) issues.add('unknown-route')
      continue
    }
    // An entirely unreported settlement has no priced amount. Preserve it as
    // unknown instead of turning the empty sums into a false zero-cost result.
    const pricedBucketsReported = group.cacheRead.reported + group.uncachedInput.reported + group.output.reported
    if (group.withoutUsage === group.settledAttempts || pricedBucketsReported === 0) continue
    if (group.period === 'unknown') {
      if (tokens > 0 || hasUnknownTokens) issues.add('unknown-period')
      continue
    }
    const periodScale = group.period === 'offpeak' ? 0.5 : 1
    const cost = (group.cacheRead.sum * price.cache + group.uncachedInput.sum * price.input + group.output.sum * price.output) * periodScale / 1_000_000
    if (group.period === 'peak') peak += cost
    else offpeak += cost
    pricedGroups++
  }

  const summary = attribution.summaryAndRepair
  const summaryReadout = summary === undefined ? null : {
    // Ledger input is cache-inclusive; cacheRead/cacheWrite must not be added again.
    tokens: summary.input + summary.output,
    attempts: summary.attempts,
    unknownAttempts: summary.unknownAttempts,
  }
  if ((summary?.attempts ?? 0) > 0) issues.add('summary-unpriced')
  if (attribution.differences.length > 0) issues.add('host-difference')
  if (hostTokens !== null && hostTokens > 0 && attribution.costUsage.length === 0) issues.add('missing-usage')

  const hasRecords = attribution.mirrored.settledAttempts > 0 || (summary?.attempts ?? 0) > 0 || (hostTokens ?? 0) > 0
  return {
    hasRecords,
    settledAttempts: attribution.mirrored.settledAttempts,
    retries: attribution.mirrored.retries,
    requestTokens,
    requestTokensPartial,
    summary: summaryReadout,
    peak: pricedGroups > 0 ? peak : null,
    offpeak: pricedGroups > 0 ? offpeak : null,
    total: pricedGroups > 0 ? peak + offpeak : null,
    partial: issues.size > 0,
    issues: [...issues],
  }
}

export function costPeriodLabel(period: Period): string {
  if (period === 'peak') return '高峰'
  if (period === 'offpeak') return '低谷'
  return '未知时段'
}
