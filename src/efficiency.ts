/**
 * Read-only cost/efficiency attribution over a session log.
 *
 * This module never changes a request, never re-implements billing and never
 * turns an unknown into a zero.
 *
 * Field semantics (verified against the Host sources, REVIEW-USAGE-01 §7):
 * - `TokenUsage.inputTokens` is the *uncached* input, exactly like the Host
 *   projection's `uncachedInputTokens` bucket. The cache read/write buckets are
 *   disjoint optional components, and reasoning tokens are already inside
 *   `outputTokens`. A cache-inclusive input figure is therefore always derived
 *   and labelled as such — it is never the raw `inputTokens`.
 * - The Host's own cumulative `tokenUsage` projection is the authoritative
 *   business total. The event fold here *mirrors* the Host's settlement rule
 *   (same `(turn, step)` replaces, `llm/retry-started` closes the slot so the
 *   next attempt adds) only to attach completeness and purpose information and
 *   to check the projection; a difference is reported, never silently merged.
 * - Failed, cancelled and retried attempts settle as `assistant/attempt` with
 *   the usage in the stream, so the fold reads a message's `data.usage` first
 *   and otherwise decodes the last stream usage chunk through the SDK's public
 *   `lastAssistantStreamChunk`. Counting assistant messages would understate
 *   paid calls.
 * - Summary and repair calls are streamed by this plugin's own engine and are
 *   accounted for in the existing summary ledger, not as assistant messages.
 *   The ledger has no durable purpose field, so its total is reported as
 *   "summary and repair combined, purpose not split" and is never re-derived by
 *   guessing from turn order or timestamps. A settlement that overlaps a
 *   numbered compaction transaction is excluded from business and reported as a
 *   maintenance suspect instead of being labelled as either purpose.
 * - Missing components stay missing: every field carries its own reported and
 *   missing counts, so a partial provider report can never be presented as a
 *   complete account. `0` is only ever written from a reported zero.
 * @module
 */

import { createHash } from 'node:crypto'
import { canonicalHeader, type SessionEvent } from '@deepseek-ai/dsh-session'
import { lastAssistantStreamChunk } from '@deepseek-ai/dsh-llm/assistant-stream'
import type {} from '@deepseek-ai/dsh-llm-retry'

/** The Host's cumulative projection, accepted as the authoritative total. */
export interface HostUsageReference {
  readonly source: string
  readonly uncachedInputTokens: number
  readonly cacheReadTokens: number
  readonly cacheWriteTokens: number
  readonly outputTokens: number
}

/** The existing summary ledger's totals; purpose is not split there. */
export interface SummaryReference {
  readonly source: string
  /** Cache-inclusive billed input, exactly as the ledger stores it. */
  readonly input: number
  readonly output: number
  /** Absent when no attempt reported the component; unknown is never rendered as zero. */
  readonly cacheRead?: number
  readonly cacheWrite?: number
  readonly attempts: number
  readonly unknownAttempts: number
}

/** One usage component: a known sum plus how many samples did not report it. */
export interface FieldTotal {
  readonly sum: number
  readonly reported: number
  readonly missing: number
}

export interface UsageTotals {
  /** Model attempts the Host settled; this is a paid-call count, not a message count. */
  readonly settledAttempts: number
  /** Provider-routed retries observed via `llm/retry-started`. */
  readonly retries: number
  /** Settled attempts whose usage the provider never reported; cost unknown. */
  readonly withoutUsage: number
  readonly uncachedInput: FieldTotal
  readonly cacheRead: FieldTotal
  readonly cacheWrite: FieldTotal
  readonly output: FieldTotal
  /** Derived, labelled: uncached plus cache read plus cache write, as far as known. */
  readonly cacheInclusiveInput: FieldTotal
  /** True only when every settled attempt reported all four components. */
  readonly complete: boolean
}

export interface BucketDifference {
  readonly field: 'uncachedInputTokens' | 'cacheReadTokens' | 'cacheWriteTokens' | 'outputTokens'
  readonly host: number
  readonly mirrored: number
  readonly delta: number
}

export interface BudgetChange {
  readonly seq: number
  readonly time: number
  readonly changed: readonly ('prefix' | 'toolSchema' | 'toolOrder')[]
  readonly note: string
}

export interface Attribution {
  /**
   * `host-projection` means {@link host} is the authoritative business total;
   * `event-log` means only the fold was available and its completeness fields
   * must be read before any total is quoted.
   */
  readonly accounting: 'host-projection' | 'event-log'
  readonly host?: HostUsageReference
  /** The fold's own reconstruction, with per-field completeness. */
  readonly mirrored: UsageTotals
  /** Non-zero entries mean the log could not reproduce the Host's own total. */
  readonly differences: readonly BucketDifference[]
  /**
   * Summary and repair usage from the existing ledger. `purposeSplit` is false
   * because the ledger has no durable purpose field, including for archived
   * totals; the figures are never guessed apart or added to a second time.
   */
  readonly summaryAndRepair?: SummaryReference & { readonly purposeSplit: false, readonly note: string }
  /** Settlements overlapping a numbered compaction transaction; purpose never guessed. */
  readonly maintenanceSuspects: number
  /** Cache read share of measured input; null when nothing measurable was reported. */
  readonly cacheHitRatio: number | null
  readonly requests: readonly RequestRow[]
  readonly fingerprint: Fingerprint | null
  readonly changes: readonly BudgetChange[]
}

export interface RequestRow {
  readonly seq: number
  readonly time: number
  readonly turn: number
  readonly step: number
  /** How this settlement was observed; `attempt` usually means a failed or cancelled call. */
  readonly settledBy: 'message' | 'attempt'
  /** False when neither the message nor a request header named the route. */
  readonly routeKnown: boolean
  /** Retry attempt index *within this turn/step*, counting from 0. */
  readonly retry: number
  readonly provider: string
  readonly model: string
  readonly uncachedInput: number | null
  readonly cacheRead: number | null
  readonly cacheWrite: number | null
  readonly output: number | null
  /**
   * True when this settlement happened while a numbered compaction transaction
   * owned its turn. It only marks the purpose as unconfirmed: the settlement is
   * still part of {@link UsageTotals}, and it is never called a summary or a
   * repair.
   */
  readonly maintenanceSuspect: boolean
}

export interface Fingerprint {
  readonly prefix: string
  readonly toolSchema: string
  readonly toolOrder: string
  readonly tools: number
  readonly systemChars: number
}

interface Sample {
  readonly uncachedInput: number | null
  readonly cacheRead: number | null
  readonly cacheWrite: number | null
  readonly output: number | null
}

interface Slot {
  turn: number; step: number; seq: number; time: number
  /** Retry index within this turn/step, captured when the slot was created. */
  retry: number
  settledBy: 'message' | 'attempt'; provider: string; model: string
  /** A settlement without a named route stays explicitly unknown. */
  routeKnown: boolean
  /**
   * True when a settlement folded into this slot happened while a numbered
   * compaction transaction owned this turn. Fixed at settlement time, so a
   * later transaction can neither relabel this row nor erase the label.
   */
  suspect: boolean
  sample: Sample
}

const FIELD_ORDER = ['uncachedInput', 'cacheRead', 'cacheWrite', 'output'] as const
type FieldName = typeof FIELD_ORDER[number]

function emptyField(): FieldTotal { return { sum: 0, reported: 0, missing: 0 } }
function token(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null
}
function sampleOf(usage: Record<string, unknown> | undefined): Sample {
  return { uncachedInput: token(usage?.inputTokens), cacheRead: token(usage?.cacheReadTokens),
    cacheWrite: token(usage?.cacheWriteTokens), output: token(usage?.outputTokens) }
}
function isEmptySample(sample: Sample): boolean { return FIELD_ORDER.every(field => sample[field] === null) }
function sameSample(left: Sample, right: Sample): boolean { return FIELD_ORDER.every(field => left[field] === right[field]) }

/**
 * The Host's own settlement rule for one durable attempt record: a message's
 * explicit usage wins, otherwise the last usage chunk embedded in the stream is
 * decoded through the SDK's export. A settlement that carried no usage is
 * reported as unknown rather than zero.
 */
function usageOf(event: Extract<SessionEvent, { type: 'assistant/message' | 'assistant/attempt' }>): Sample | undefined {
  const explicit = event.type === 'assistant/message' ? event.data.usage : undefined
  if (explicit !== undefined) return sampleOf(explicit as unknown as Record<string, unknown>)
  const last = lastAssistantStreamChunk(event.data.stream, 'usage')?.usage
  if (last === undefined) return undefined
  return sampleOf(last as unknown as Record<string, unknown>)
}

function systemPromptText(event: SessionEvent): string | undefined {
  if (event.type !== 'system/message') return undefined
  return event.data.message.content.map(block => block.type === 'text' ? block.text : '').join('\n')
}
function digest(value: string): string { return createHash('sha256').update(value).digest('hex').slice(0, 16) }

function totalsOf(slots: readonly Slot[], retries: number): UsageTotals {
  const fields: Record<FieldName, FieldTotal> = { uncachedInput: emptyField(), cacheRead: emptyField(), cacheWrite: emptyField(), output: emptyField() }
  let withoutUsage = 0
  for (const slot of slots) {
    if (isEmptySample(slot.sample)) { withoutUsage++; continue }
    for (const field of FIELD_ORDER) {
      const value = slot.sample[field]
      const held = fields[field]
      fields[field] = value === null
        ? { ...held, missing: held.missing + 1 }
        : { sum: held.sum + value, reported: held.reported + 1, missing: held.missing }
    }
  }
  const settled = slots.length
  // Derived cache-inclusive input: known only where all three input components
  // were reported for the same settlement.
  let inclusiveSum = 0, inclusiveReported = 0, inclusiveMissing = 0
  for (const slot of slots) {
    const parts = [slot.sample.uncachedInput, slot.sample.cacheRead, slot.sample.cacheWrite]
    if (parts.every(value => value !== null)) { inclusiveSum += parts.reduce((total, value) => total + (value ?? 0), 0); inclusiveReported++ }
    else if (isEmptySample(slot.sample)) continue
    else inclusiveMissing++
  }
  const complete = withoutUsage === 0
    && FIELD_ORDER.every(field => fields[field].missing === 0)
  return { settledAttempts: settled, retries, withoutUsage,
    uncachedInput: fields.uncachedInput, cacheRead: fields.cacheRead, cacheWrite: fields.cacheWrite, output: fields.output,
    cacheInclusiveInput: { sum: inclusiveSum, reported: inclusiveReported, missing: inclusiveMissing }, complete }
}

/**
 * Fold one session log into a read-only attribution view.
 * @param events - the session events, in log order.
 * @param options - optional authoritative references owned by the Host and the existing summary ledger.
 */
export function attributeSession(events: readonly SessionEvent[], options: {
  readonly host?: HostUsageReference
  readonly summary?: SummaryReference
  /**
   * Collect and report request-prefix fingerprint diagnostics. `false` keeps
   * every business usage number and only stops the fingerprint work, so the
   * switch never deletes usage. Defaults to on.
   */
  readonly fingerprint?: boolean
} = {}): Attribution {
  const fingerprintEnabled = options.fingerprint !== false
  const slots: Slot[] = []
  const open = new Map<string, Slot>()
  // One open numbered transaction per id, with a per-turn reference count so a
  // close only releases the turn it actually owned.
  const compactionTurns = new Map<string, number | null>()
  const openTurns = new Map<number, number>()
  const retryIndex = new Map<string, number>()
  const changes: BudgetChange[] = []
  let fingerprint: Fingerprint | undefined
  let lastSystem: string | undefined
  // Last observed request route. A bare `assistant/attempt` carries only
  // turn/step/stream — no message, no source — so an attempt is attributed to
  // the route of the request it belongs to, or to explicit `unknown`.
  let route: { provider: string; model: string } | undefined
  let retries = 0
  let maintenanceSuspects = 0

  for (const event of events) {
    if (event.type === 'compaction/start') {
      compactionTurns.set(event.data.compactionId, event.data.turn)
      if (event.data.turn !== null) openTurns.set(event.data.turn, (openTurns.get(event.data.turn) ?? 0) + 1)
      continue
    }
    if (event.type === 'compaction/end') {
      const turn = compactionTurns.get(event.data.compactionId)
      compactionTurns.delete(event.data.compactionId)
      if (turn !== null && turn !== undefined) {
        const held = (openTurns.get(turn) ?? 0) - 1
        if (held > 0) openTurns.set(turn, held)
        else openTurns.delete(turn)
      }
      continue
    }
    if (event.type === 'llm/retry-started') {
      // The session-wide count is the number of real retry boundaries; the
      // per-step index only ever describes that step's own attempts.
      retries++
      const key = `${event.data.turn}:${event.data.step}`
      retryIndex.set(key, (retryIndex.get(key) ?? 0) + 1)
      const previous = open.get(key)
      // The failed attempt's usage is already counted: closing the slot lets the
      // next attempt add instead of replacing it (the Host's own rule).
      if (previous !== undefined) open.delete(key)
      continue
    }
    if (event.type === 'system/message' && event.surfaceOp === 'append') {
      const text = systemPromptText(event)
      if (text !== undefined && text.length > 0) lastSystem = text
      continue
    }
    if (event.type === 'request/header') {
      const header = canonicalHeader(event.data.header)
      const tools = header.tools ?? []
      const config = header.config
      route = { provider: config.provider, model: config.model }
      // The prefix diagnostics switch: off means no fingerprint is collected,
      // compared or reported. Route attribution and every usage number below
      // are unaffected, which is what the setting promises.
      if (!fingerprintEnabled) { fingerprint = undefined; continue }
      const described: Fingerprint = {
        prefix: digest(JSON.stringify([config.provider, config.model, config.reasoningEffort ?? null, config.maxTokens ?? null,
          config.temperature ?? null, lastSystem ?? ''])),
        toolSchema: digest(JSON.stringify(tools.map(tool => [tool.name, tool.description, tool.parameters]))),
        toolOrder: digest(tools.map(tool => tool.name).join('\u0000')),
        tools: tools.length, systemChars: lastSystem?.length ?? 0,
      }
      const changed: BudgetChange['changed'][number][] = []
      if (fingerprint !== undefined) {
        if (fingerprint.prefix !== described.prefix) changed.push('prefix')
        if (fingerprint.toolSchema !== described.toolSchema) changed.push('toolSchema')
        if (fingerprint.toolOrder !== described.toolOrder) changed.push('toolOrder')
      }
      if (changed.length > 0) changes.push({ seq: event.seq, time: event.time, changed,
        note: '请求前缀组成部分发生变化；这与缓存行为相关，但不是缓存未命中的原因证明' })
      fingerprint = described
      continue
    }
    if (event.type !== 'assistant/message' && event.type !== 'assistant/attempt') continue
    const { turn, step } = event.data
    const key = `${turn}:${step}`
    const sample = usageOf(event)
    const settledBy = event.type === 'assistant/message' ? 'message' : 'attempt'
    const source = event.type === 'assistant/message' ? event.data.message.source : undefined
    const named = source?.provider !== undefined && source.model !== undefined
    const provider = named ? source.provider : route?.provider ?? 'unknown'
    const model = named ? source.model : route?.model ?? 'unknown'
    const routeKnown = named || route !== undefined
    const suspect = openTurns.has(turn)
    const held = open.get(key)
    if (held === undefined) {
      const created: Slot = { turn, step, seq: event.seq, time: event.time, retry: retryIndex.get(key) ?? 0,
        settledBy, provider, model, routeKnown, suspect, sample: sample ?? emptySample() }
      open.set(key, created)
      slots.push(created)
      continue
    }
    // Same turn/step replaces its predecessor unless the buckets are identical.
    held.settledBy = settledBy
    if (named) { held.provider = provider; held.model = model }
    held.routeKnown = held.routeKnown || routeKnown
    held.suspect = held.suspect || suspect
    held.seq = event.seq
    held.time = event.time
    if (sample !== undefined && !sameSample(sample, held.sample)) held.sample = sample
  }
  const mirrored = totalsOf(slots, retries)
  const rows: RequestRow[] = slots.slice(-200).map(slot => ({
    seq: slot.seq, time: slot.time, turn: slot.turn, step: slot.step, settledBy: slot.settledBy, retry: slot.retry,
    routeKnown: slot.routeKnown, provider: slot.provider, model: slot.model,
    uncachedInput: slot.sample.uncachedInput, cacheRead: slot.sample.cacheRead,
    cacheWrite: slot.sample.cacheWrite, output: slot.sample.output,
    maintenanceSuspect: slot.suspect,
  }))
  // Counted over every settlement, never over the truncated detail page.
  maintenanceSuspects = slots.filter(slot => slot.suspect).length
  const host = options.host
  const differences: BucketDifference[] = host === undefined ? [] : ([
    ['uncachedInputTokens', host.uncachedInputTokens, mirrored.uncachedInput.sum],
    ['cacheReadTokens', host.cacheReadTokens, mirrored.cacheRead.sum],
    ['cacheWriteTokens', host.cacheWriteTokens, mirrored.cacheWrite.sum],
    ['outputTokens', host.outputTokens, mirrored.output.sum],
  ] as const).flatMap(([field, hostValue, mirroredValue]) => hostValue === mirroredValue ? []
    : [{ field, host: hostValue, mirrored: mirroredValue, delta: hostValue - mirroredValue }])
  const measured = slots.filter(slot => slot.sample.uncachedInput !== null && slot.sample.cacheRead !== null && slot.sample.cacheWrite !== null)
  const measuredInput = measured.reduce((total, slot) => total + (slot.sample.uncachedInput ?? 0) + (slot.sample.cacheRead ?? 0) + (slot.sample.cacheWrite ?? 0), 0)
  const measuredRead = measured.reduce((total, slot) => total + (slot.sample.cacheRead ?? 0), 0)
  const summary = options.summary
  return {
    accounting: host === undefined ? 'event-log' : 'host-projection',
    ...(host === undefined ? {} : { host }),
    mirrored, differences,
    ...(summary === undefined ? {} : { summaryAndRepair: { ...summary, purposeSplit: false as const,
      note: '现有摘要总账的累计值，含失败与取消尝试；账本没有持久用途字段，摘要与修复合计显示、历史用途未细分，也不与合并后的 compaction/summary 重复相加' } }),
    maintenanceSuspects,
    cacheHitRatio: measuredInput > 0 ? measuredRead / measuredInput : null,
    requests: rows,
    fingerprint: fingerprint ?? null,
    changes: changes.slice(-16),
  }
}

function emptySample(): Sample { return { uncachedInput: null, cacheRead: null, cacheWrite: null, output: null } }
