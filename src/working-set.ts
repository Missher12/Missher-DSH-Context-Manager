/** Select whole balanced groups from the effective surface, never from shadowed history. */
export interface WorkingNode {
  seq: number
  tokens: number
  protected: boolean
  balancedBefore: boolean
  balancedAfter: boolean
}
export interface WorkingPlan {
  start: number; end: number; tokens: number
  before: number; remaining: number; estimatedAfter: number
  /** retainedTokens counts only discretionary recent groups, excluding protected groups. */
  summaryTokens: number; upper: number; retainedTokens: number
}
export interface WorkingLimits {
  total: number; admission: number; hard: number; recentTokens: number
  summaryTokens: number; target?: number
  /** Provider-confirmed overflow drops the recency preference, never protected content. */
  overflow?: boolean
}

interface Group { start: number; end: number; tokens: number; fixed: boolean }
const FRAMING_TOKENS = 128
const minimumGain = (before: number) => Math.min(1024, Math.max(128, before * 0.005))

/** A protected member protects its entire tool group; unmatched edges are never eligible. */
function groupNodes(nodes: readonly WorkingNode[]): Group[] {
  const groups: Group[] = []
  for (let start = 0; start < nodes.length;) {
    if (!nodes[start]!.balancedBefore) {
      groups.push({ start, end: start, tokens: nodes[start]!.tokens, fixed: true })
      start++
      continue
    }
    let end = start, tokens = 0, fixed = false
    for (; end < nodes.length; end++) {
      tokens += nodes[end]!.tokens
      fixed ||= nodes[end]!.protected
      if (nodes[end]!.balancedAfter) break
    }
    if (end === nodes.length) { end--; fixed = true }
    groups.push({ start, end, tokens, fixed })
    start = end + 1
  }
  return groups
}

function planWithTail(
  nodes: readonly WorkingNode[], groups: readonly Group[], limits: WorkingLimits, upper: number, recentTokens: number,
): WorkingPlan | undefined {
  const tail = new Set<number>()
  let retainedTokens = 0
  for (let i = groups.length - 1; i >= 0; i--) {
    const group = groups[i]!
    // Fixed facts consume remaining pressure, not the discretionary recent-history budget.
    if (group.fixed) continue
    // An oversized newest eligible group may be summarized whole. Never split a pair to fit T.
    if (retainedTokens + group.tokens > recentTokens) break
    tail.add(i)
    retainedTokens += group.tokens
  }
  let best: WorkingPlan | undefined
  // Each maximal eligible contiguous span is considered once. User/system
  // barriers remain at their original positions; no partial multi-span commit.
  for (let start = 0; start < groups.length;) {
    const first = groups[start]!
    if (first.fixed || tail.has(start)) { start++; continue }
    let tokens = 0, cursor = start
    for (; cursor < groups.length; cursor++) {
      const group = groups[cursor]!
      if (group.fixed || tail.has(cursor)) break
      tokens += group.tokens
    }
    const remaining = Math.max(0, limits.total - tokens)
    // The output cap is a feasibility estimate, never permission to drop protected facts.
    // The caller still checks the actual framed replacement before committing.
    const room = upper - remaining - FRAMING_TOKENS
    const cap = Math.floor(Math.min(limits.summaryTokens, room, tokens * 0.5))
    if (cap >= 256 && tokens - cap - FRAMING_TOKENS >= minimumGain(limits.total)) {
      const candidate = { start: nodes[first.start]!.seq, end: nodes[groups[cursor - 1]!.end]!.seq, tokens,
        before: limits.total, remaining, estimatedAfter: remaining + cap + FRAMING_TOKENS,
        summaryTokens: cap, upper, retainedTokens }
      if (!best || candidate.tokens > best.tokens) best = candidate
    }
    start = Math.max(start + 1, cursor)
  }
  return best
}

export function planWorkingSet(nodes: readonly WorkingNode[], limits: WorkingLimits): WorkingPlan | undefined {
  const measures = [limits.total, limits.admission, limits.hard, limits.recentTokens, limits.summaryTokens,
    ...(limits.target === undefined ? [] : [limits.target])]
  if (measures.some(value => !Number.isFinite(value) || value < 0)
    || nodes.some(node => !Number.isFinite(node.tokens) || node.tokens < 0)) return undefined
  const upper = Math.min(limits.admission - 1, limits.hard - 1, limits.target ?? Infinity)
  const groups = groupNodes(nodes)
  // At most four linear passes. T is a preference; shrink it before declaring the
  // fixed/protected remainder impossible. Provider overflow immediately requests
  // the deepest eligible reduction, without inventing a new capacity estimate.
  const budgets = limits.overflow ? [0] : [...new Set([
    limits.recentTokens, Math.floor(limits.recentTokens / 2), Math.floor(limits.recentTokens / 4), 0,
  ])]
  for (const recentTokens of budgets) {
    const plan = planWithTail(nodes, groups, limits, upper, recentTokens)
    if (plan) return plan
  }
  return undefined
}

/** Preview the complete calibrated pressure, including the replacement framing. */
export function validateWorkingCandidate(plan: WorkingPlan, replacementTokens: number): number {
  const after = plan.remaining + replacementTokens
  if (!Number.isFinite(replacementTokens) || replacementTokens < 0 || !Number.isFinite(after) || after > plan.upper) {
    throw new Error(`压缩后仍超过有效上限（预计 ${Math.ceil(after)} / ${Math.floor(plan.upper)} Token），原文保留`)
  }
  const freed = plan.before - after
  if (freed < minimumGain(plan.before)) {
    throw new Error('压缩收益不足，停止重复摘要；任务原文保留')
  }
  return after
}
