/** Select whole balanced groups from the effective surface, never from shadowed history. */
export interface WorkingNode {
  seq: number
  tokens: number
  protected: boolean
  balancedBefore: boolean
  balancedAfter: boolean
  /** Plugin checkpoints are counted inside the composition, never added again as a separate reserve. */
  checkpoint?: boolean
}
export interface WorkingPlan {
  start: number; end: number; tokens: number
  before: number; remaining: number; estimatedAfter: number
  /** retainedTokens counts only discretionary recent groups, excluding protected groups. */
  summaryTokens: number; upper: number; retainedTokens: number
  /** Reserve below the effective admission kept free for the next work steps. */
  resumeHeadroom: number; admission: number
  /** The measured composition after replacement, before output framing and continuation reserve. */
  composition: { fixed: number; recent: number; selected: number; unselected: number; uncertaintyDelta: number }
  /** Active checkpoints are a subcategory of F/R/S/U, never additive to measured pressure. */
  checkpoints: { active: number; selected: number; retained: number; budget?: number; reserved: number }
  /** Admission is the request gate; completionTarget is the desired post-compaction bound. */
  admissionCeiling: number; completionTarget: number; completionTargetCertain: boolean
}
export interface WorkingLimits {
  total: number; admission: number; hard: number; recentTokens: number
  summaryTokens: number; target?: number; completionTarget?: number
  /** Whole framed budget for all active Context checkpoints on the effective surface. */
  aggregateCheckpointTokens?: number
  /** Full active-surface checkpoint occupancy when planning only a subrange. */
  activeCheckpointTokens?: number
  /** Whole budget reserved for the remaining planned segments in this batch. */
  reservedCheckpointTokens?: number
  /** Provider-confirmed overflow drops the recency preference, never protected content. */
  overflow?: boolean
  /**
   * Tokens that must stay free below the admission line so a compacted task can
   * continue for the next steps instead of re-triggering immediately. Planning
   * is infeasible when protected content leaves no room for this reserve.
   */
  resumeHeadroom?: number
}

export interface HeadroomInput {
  window: number; admission: number
  /** Net tokens added by the last completed business step, excluding incoming input. */
  recentGrowth: number
  /** Tokens of the current new input/attachments already in the measurement. */
  incomingTokens: number
}

export interface ContinuationHeadroom {
  /** Reserve actually used by the planner, never silently below required. */
  tokens: number
  /** One observed step of growth plus input and a 25% estimation margin. */
  required: number
  /** Largest reserve that still leaves the plan below its effective admission line. */
  limit: number
  /** Full observed growth used for projection. */
  projectedGrowth: number
  /** Kept for wire compatibility; observed growth is never capped. */
  projectionCapped: boolean
  /** Bounded uncertainty allowance for the already-counted current input. */
  inputMargin: number
  sufficient: boolean
}

/**
 * Conservative reserve for one more business step. Uses all observed recent
 * net growth plus a bounded error margin for input already present in pressure.
 * The reserve is never clipped to a convenient percentage: callers stop when
 * it cannot fit below the real admission line.
 */
export function continuationHeadroom(input: HeadroomInput): ContinuationHeadroom {
  const { window, admission } = input
  if (!Number.isFinite(window) || !Number.isFinite(admission) || window <= 0 || admission <= 0) {
    return { tokens: 0, required: 0, limit: 0, projectedGrowth: 0, projectionCapped: false, inputMargin: 0, sufficient: false }
  }
  const growth = Math.max(0, Number.isFinite(input.recentGrowth) ? input.recentGrowth : 0)
  const incoming = Math.max(0, Math.min(Number.isFinite(input.incomingTokens) ? input.incomingTokens : 0, window))
  const projectedGrowth = growth
  const projectionCapped = false
  const typical = growth > 0 ? growth : Math.max(1024, Math.floor(window * 0.005))
  // A one-off new task is already present in `total` and is kept protected.
  // Include only a bounded 5% measurement-error margin from its size; never
  // project the whole attachment as though it repeats on every next step.
  const inputMargin = Math.min(Math.ceil(incoming * 0.05), Math.floor(window * 0.02))
  const need = Math.ceil((typical + inputMargin) * 1.25)
  const floor = Math.min(2048, Math.floor(admission * 0.05))
  // Keep one token below admission so the next request remains under the gate.
  // Actual feasibility against protected content is decided by the planner.
  const limit = Math.max(0, Math.floor(admission) - 1)
  const required = Math.max(floor, need)
  return { tokens: required, required, limit, projectedGrowth, projectionCapped, inputMargin, sufficient: required <= limit }
}

interface Group { start: number; end: number; tokens: number; fixed: boolean; checkpointTokens: number }
interface Span { firstGroup: number; lastGroup: number; tokens: number; checkpointTokens: number }
const FRAMING_TOKENS = 128
const minimumGain = (before: number) => Math.min(1024, Math.max(128, before * 0.005))

/** Reserve framing inside the aggregate batch budget before any call is dispatched. */
export function checkpointOutputBudget(totalCheckpointTokens: number, segments: number, framing = FRAMING_TOKENS): number {
  if (![totalCheckpointTokens, segments, framing].every(Number.isFinite)
    || totalCheckpointTokens < 0 || !Number.isInteger(segments) || segments < 1 || framing < 0) return 0
  return Math.max(0, Math.floor(totalCheckpointTokens / segments) - framing)
}

/** A protected member protects its entire tool group; unmatched edges are never eligible. */
function groupNodes(nodes: readonly WorkingNode[]): Group[] {
  const groups: Group[] = []
  for (let start = 0; start < nodes.length;) {
    if (!nodes[start]!.balancedBefore) {
      groups.push({ start, end: start, tokens: nodes[start]!.tokens, fixed: true, checkpointTokens: nodes[start]!.checkpoint ? nodes[start]!.tokens : 0 })
      start++
      continue
    }
    let end = start, tokens = 0, checkpointTokens = 0, fixed = false
    for (; end < nodes.length; end++) {
      tokens += nodes[end]!.tokens
      if (nodes[end]!.checkpoint) checkpointTokens += nodes[end]!.tokens
      fixed ||= nodes[end]!.protected
      if (nodes[end]!.balancedAfter) break
    }
    if (end === nodes.length) { end--; fixed = true }
    groups.push({ start, end, tokens, fixed, checkpointTokens })
    start = end + 1
  }
  return groups
}

function spansAfterTail(groups: readonly Group[], recentTokens: number) {
  const tail = new Set<number>()
  let retainedTokens = 0
  for (let index = groups.length - 1; index >= 0; index--) {
    const group = groups[index]!
    // Fixed facts consume remaining pressure, not the discretionary recent-history budget.
    if (group.fixed) continue
    // An oversized newest eligible group may be summarized whole. Never split a pair to fit T.
    if (retainedTokens + group.tokens > recentTokens) break
    tail.add(index)
    retainedTokens += group.tokens
  }
  const spans: Span[] = []
  for (let start = 0; start < groups.length;) {
    const first = groups[start]!
    if (first.fixed || tail.has(start)) { start++; continue }
    let tokens = 0, checkpointTokens = 0, cursor = start
    for (; cursor < groups.length; cursor++) {
      const group = groups[cursor]!
      if (group.fixed || tail.has(cursor)) break
      tokens += group.tokens
      checkpointTokens += group.checkpointTokens
    }
    spans.push({ firstGroup: start, lastGroup: cursor - 1, tokens, checkpointTokens })
    start = Math.max(start + 1, cursor)
  }
  return { tail, retainedTokens, spans }
}

/** Legal contiguous source spans after applying the same fixed groups and recent-tail preference as the planner. */
export function selectableWorkingSpans(nodes: readonly WorkingNode[], recentTokens: number) {
  if (!Number.isFinite(recentTokens) || recentTokens < 0) return []
  const groups = groupNodes(nodes)
  const { spans } = spansAfterTail(groups, recentTokens)
  return spans.map(span => ({
    start: nodes[groups[span.firstGroup]!.start]!.seq,
    end: nodes[groups[span.lastGroup]!.end]!.seq,
    tokens: span.tokens,
    checkpointTokens: span.checkpointTokens,
  }))
}

function planWithTail(
  nodes: readonly WorkingNode[], groups: readonly Group[], limits: WorkingLimits, upper: number, recentTokens: number, resumeHeadroom: number,
): WorkingPlan | undefined {
  const { tail, retainedTokens, spans } = spansAfterTail(groups, recentTokens)
  let best: WorkingPlan | undefined
  // Each maximal eligible contiguous span is considered once. User/system
  // barriers remain at their original positions; no partial multi-span commit.
  for (const span of spans) {
    const { firstGroup, lastGroup, tokens } = span
    let fixed = 0, recent = 0, selected = 0, unselected = 0
    let fixedCheckpoints = 0, recentCheckpoints = 0, selectedCheckpoints = 0
    for (let index = 0; index < groups.length; index++) {
      const group = groups[index]!
      if (group.fixed) { fixed += group.tokens; fixedCheckpoints += group.checkpointTokens }
      else if (index >= firstGroup && index <= lastGroup) { selected += group.tokens; selectedCheckpoints += group.checkpointTokens }
      else if (tail.has(index)) { recent += group.tokens; recentCheckpoints += group.checkpointTokens }
      else unselected += group.tokens
    }
    // Delta retains calibration drift between the public measured total and the
    // summed surface nodes. It is signed; a negative delta must never be hidden
    // by clamping a residual to zero.
    const uncertaintyDelta = limits.total - nodes.reduce((sum, node) => sum + node.tokens, 0)
    const remaining = fixed + recent + unselected + uncertaintyDelta
    if (!Number.isFinite(remaining) || remaining < 0) continue
    const selectedSurfaceCheckpoints = nodes.reduce((sum, node) => sum + (node.checkpoint ? node.tokens : 0), 0)
    const activeCheckpoints = limits.activeCheckpointTokens ?? selectedSurfaceCheckpoints
    if (!Number.isFinite(activeCheckpoints) || activeCheckpoints < selectedSurfaceCheckpoints) {
      continue
    }
    const retainedCheckpoints = activeCheckpoints - selectedCheckpoints
    const reservedCheckpoints = limits.reservedCheckpointTokens ?? 0
    const checkpointAvailable = limits.aggregateCheckpointTokens === undefined ? Infinity
      : limits.aggregateCheckpointTokens - retainedCheckpoints - reservedCheckpoints
    // The output cap is a feasibility estimate, never permission to drop protected facts.
    // The caller still checks the actual framed replacement before committing.
    const room = upper - remaining - FRAMING_TOKENS
    const checkpointRoom = checkpointAvailable === Infinity ? Infinity : checkpointAvailable - FRAMING_TOKENS
    const cap = Math.floor(Math.min(limits.summaryTokens, room, tokens * 0.5, checkpointRoom))
    if (cap >= 256 && tokens - cap - FRAMING_TOKENS >= minimumGain(limits.total)) {
      const admissionCeiling = Math.min(limits.admission - 1, limits.hard - 1)
      // A negative calibration delta remains in `remaining` and cannot lower the promised target.
      const completionTarget = limits.completionTarget
        ?? (limits.aggregateCheckpointTokens === undefined
          ? limits.target ?? admissionCeiling
          : fixed + recent - fixedCheckpoints - recentCheckpoints
            + limits.aggregateCheckpointTokens + resumeHeadroom + Math.max(0, uncertaintyDelta))
      if (!Number.isFinite(completionTarget) || completionTarget < 0) continue
      const candidate = { start: nodes[groups[firstGroup]!.start]!.seq, end: nodes[groups[lastGroup]!.end]!.seq, tokens,
        before: limits.total, remaining, estimatedAfter: remaining + cap + FRAMING_TOKENS,
        summaryTokens: cap, upper, retainedTokens, resumeHeadroom, admission: limits.admission,
        composition: { fixed, recent, selected, unselected, uncertaintyDelta },
        checkpoints: { active: activeCheckpoints, selected: selectedCheckpoints, retained: retainedCheckpoints,
          ...(limits.aggregateCheckpointTokens === undefined ? {} : { budget: limits.aggregateCheckpointTokens }), reserved: reservedCheckpoints },
        admissionCeiling, completionTarget, completionTargetCertain: uncertaintyDelta >= 0 }
      if (!best || candidate.tokens > best.tokens) best = candidate
    }
  }
  return best
}

export function planWorkingSet(nodes: readonly WorkingNode[], limits: WorkingLimits): WorkingPlan | undefined {
  const measures = [limits.total, limits.admission, limits.hard, limits.recentTokens, limits.summaryTokens,
    ...(limits.target === undefined ? [] : [limits.target]), ...(limits.completionTarget === undefined ? [] : [limits.completionTarget]),
    ...(limits.aggregateCheckpointTokens === undefined ? [] : [limits.aggregateCheckpointTokens]),
    ...(limits.activeCheckpointTokens === undefined ? [] : [limits.activeCheckpointTokens]),
    limits.reservedCheckpointTokens ?? 0, limits.resumeHeadroom ?? 0]
  if (measures.some(value => !Number.isFinite(value) || value < 0)
    || nodes.some(node => !Number.isFinite(node.tokens) || node.tokens < 0)) return undefined
  const headroom = limits.resumeHeadroom ?? 0
  const admissionCeiling = Math.min(limits.admission - 1, limits.hard - 1)
  const completionTarget = limits.completionTarget ?? limits.target ?? admissionCeiling
  if (!Number.isFinite(completionTarget) || completionTarget < 0) return undefined
  // `target` preserves the legacy direct-planner behavior. A batch completion
  // target is separate and may require several legal spans before it is met.
  const ceiling = Math.min(admissionCeiling, limits.completionTarget === undefined && limits.aggregateCheckpointTokens === undefined
    ? limits.target ?? Infinity : Infinity)
  // The continuation reserve comes out of the planning ceiling, never out of
  // protected facts: if the fixed content cannot fit, planning is infeasible.
  const upper = Math.max(0, ceiling - headroom)
  const groups = groupNodes(nodes)
  // At most four linear passes. T is a preference; shrink it before declaring the
  // fixed/protected remainder impossible. Provider overflow immediately requests
  // the deepest eligible reduction, without inventing a new capacity estimate.
  const budgets = limits.overflow ? [0] : [...new Set([
    limits.recentTokens, Math.floor(limits.recentTokens / 2), Math.floor(limits.recentTokens / 4), 0,
  ])]
  for (const recentTokens of budgets) {
    const plan = planWithTail(nodes, groups, limits, upper, recentTokens, headroom)
    if (plan) return plan
  }
  return undefined
}

/** Preview the complete calibrated pressure, including the replacement framing. */
export function validateWorkingCandidate(plan: WorkingPlan, replacementTokens: number): number {
  const after = plan.remaining + replacementTokens
  if (plan.checkpoints.budget !== undefined
    && plan.checkpoints.retained + replacementTokens + plan.checkpoints.reserved > plan.checkpoints.budget) {
    throw new Error(`全活动摘要超过聚合预算（预计 ${plan.checkpoints.retained + replacementTokens + plan.checkpoints.reserved} / ${plan.checkpoints.budget} Token），原文保留`)
  }
  if (!Number.isFinite(replacementTokens) || replacementTokens < 0 || !Number.isFinite(after) || after > plan.upper) {
    throw new Error(`压缩后仍超过有效上限（预计 ${Math.ceil(after)} / ${Math.floor(plan.upper)} Token，含续跑余量 ${plan.resumeHeadroom}），原文保留`)
  }
  const freed = plan.before - after
  if (freed < minimumGain(plan.before)) {
    throw new Error('压缩收益不足，停止重复摘要；任务原文保留')
  }
  return after
}
