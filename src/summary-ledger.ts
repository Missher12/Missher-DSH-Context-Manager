/** Attempt accounting includes failed/cancelled summaries, independently of surface commits. */
import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import { defineDomain, domainTable, type Domain, type DomainFacility } from '@deepseek-ai/dsh-storage-domain'

export type SummaryTrigger = 'idle' | 'pressure' | 'overflow' | 'manual'
const count = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER)
const totals = z.object({ input: count, output: count, cacheRead: count, cacheWrite: count, attempts: count, unknownAttempts: count }).strict()
const attempt = z.object({ id: z.string(), compactionId: z.string(), trigger: z.enum(['idle', 'pressure', 'overflow', 'manual']),
  startedAt: count, endedAt: count.optional(), status: z.enum(['started', 'generated', 'failed', 'cancelled']),
  input: count.nullable(), output: count.nullable(), cacheRead: count.nullable(), cacheWrite: count.nullable() }).strict()
const record = z.object({ sessionId: z.string(), since: count, archived: totals, recent: z.array(attempt).max(128) }).strict()
const spec = defineDomain({ name: 'context_manager_summaries', version: 1, tables: { sessions: domainTable<string, z.infer<typeof record>>(record) } })
type Attempt = z.infer<typeof attempt>
type Totals = z.infer<typeof totals>
type Row = z.infer<typeof record>
type Usage = { inputTokens?: number; outputTokens?: number; cacheReadTokens?: number; cacheWriteTokens?: number }
export interface SummaryStats extends Totals { since: number; recent: Attempt[] }
const zero = (): Totals => ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, attempts: 0, unknownAttempts: 0 })
const finite = (n: unknown): n is number => typeof n === 'number' && Number.isSafeInteger(n) && n >= 0

/**
 * Per-field first-known merge of a provider usage totals snapshot. Every
 * component fills independently of the others and of arrival order; `finish`
 * only settles the status and never overwrites a known field with a missing
 * one. Cache components carry their own known/unknown state, so a later
 * notification can still fill them, and a billed input that was computed
 * without them is adjusted exactly once when they first become known.
 */
function mergeUsage(row: Pick<Attempt, 'input' | 'output' | 'cacheRead' | 'cacheWrite'>, usage?: Usage): Pick<Attempt, 'input' | 'output' | 'cacheRead' | 'cacheWrite'> {
  const cacheRead = row.cacheRead ?? (finite(usage?.cacheReadTokens) ? usage.cacheReadTokens : null)
  const cacheWrite = row.cacheWrite ?? (finite(usage?.cacheWriteTokens) ? usage.cacheWriteTokens : null)
  const incomingInput = finite(usage?.inputTokens) ? usage.inputTokens + (cacheRead ?? 0) + (cacheWrite ?? 0) : null
  const incomingOutput = finite(usage?.outputTokens) ? usage.outputTokens : null
  let input = row.input ?? incomingInput
  if (row.input !== null && input !== null) {
    // Late cache components complete a previously computed billed input once.
    if (row.cacheRead === null && cacheRead !== null) input += cacheRead
    if (row.cacheWrite === null && cacheWrite !== null) input += cacheWrite
  }
  return { input, output: row.output ?? incomingOutput, cacheRead, cacheWrite }
}

function add(total: Totals, row: Attempt): Totals {
  return { input: total.input + (row.input ?? 0), output: total.output + (row.output ?? 0),
    cacheRead: total.cacheRead + (row.cacheRead ?? 0), cacheWrite: total.cacheWrite + (row.cacheWrite ?? 0),
    attempts: total.attempts + 1, unknownAttempts: total.unknownAttempts + (row.input === null || row.output === null ? 1 : 0) }
}

export class SummaryLedger {
  private chain: Promise<unknown> = Promise.resolve()
  private closed = false
  private readonly table
  /**
   * Read overlay updated synchronously at merge time. The domain table only
   * reflects a value after its backend write completes, so without the
   * overlay a delivered late usage could stay invisible to {@link stats}
   * until the persistence lag passes. Durable writes stay ordered by
   * {@link chain}; per-field merges commute, so call-time application is safe.
   */
  private readonly overlay = new Map<string, Row>()
  private readonly usageOwners = new Map<string, number>()
  private readonly usageClosed = new Set<string>()
  private constructor(private readonly domain: Domain<typeof spec>) {
    this.table = domain.table('sessions')
    // Old-process streams cannot deliver after reopening. Preserve their
    // unknown totals, but never replay a call or permanently fill the ring.
    for (const [, row] of this.table.entries()) {
      for (const item of row.recent) this.usageClosed.add(item.id)
    }
  }
  /** Pin this attempt while its logical call or bounded physical drain owns it. */
  retainUsage(id: string): () => void {
    this.usageClosed.delete(id)
    this.usageOwners.set(id, (this.usageOwners.get(id) ?? 0) + 1)
    let released = false
    return () => {
      if (released) return
      released = true
      const remaining = (this.usageOwners.get(id) ?? 1) - 1
      if (remaining) this.usageOwners.set(id, remaining)
      else { this.usageOwners.delete(id); this.usageClosed.add(id) }
    }
  }
  static async open(facility: DomainFacility): Promise<SummaryLedger> { return new SummaryLedger(await facility.open(spec)) }
  private enqueue<T>(work: () => Promise<T>): Promise<T> {
    if (this.closed) return Promise.reject(new Error('Summary ledger closed'))
    const operation = this.chain.then(work)
    this.chain = operation.catch(() => {})
    return operation
  }
  private read(sessionId: string): Row | undefined {
    return this.overlay.get(sessionId) ?? this.table.get(sessionId)
  }
  /** Apply one merged row to the read overlay, then enqueue its durable write. */
  private commit(sessionId: string, row: Row): Promise<void> {
    if (this.closed) return Promise.reject(new Error('Summary ledger closed'))
    this.overlay.set(sessionId, row)
    return this.enqueue(async () => {
      await this.table.put(sessionId, row)
      // A failed write keeps its overlay dirty. An identical later merge or
      // close retries it; an older write cannot clear a newer pending value.
      if (this.overlay.get(sessionId) === row) this.overlay.delete(sessionId)
    })
  }
  async start(sessionId: string, compactionId: string, trigger: SummaryTrigger): Promise<string> {
    const old = this.read(sessionId)
    const next: Row = old ? { ...old, recent: [...old.recent], archived: { ...old.archived } }
      : { sessionId, since: Date.now(), recent: [], archived: zero() }
    if (next.recent.length === 128) {
      const archived = next.recent.findIndex(item => !this.usageOwners.has(item.id) && (
        this.usageClosed.has(item.id) || (item.status !== 'started' && item.input !== null && item.output !== null
          && item.cacheRead !== null && item.cacheWrite !== null)))
      if (archived < 0) throw new Error('Too many unsettled summary attempts')
      const removed = next.recent.splice(archived, 1)[0]!
      next.archived = add(next.archived, removed)
      this.usageClosed.delete(removed.id)
    }
    const id = randomUUID()
    next.recent.push({ id, compactionId, trigger, startedAt: Date.now(), status: 'started', input: null, output: null, cacheRead: null, cacheWrite: null })
    await this.commit(sessionId, next)
    return id
  }
  async finish(sessionId: string, id: string, status: 'generated' | 'failed' | 'cancelled', usage?: Usage): Promise<void> {
    const old = this.read(sessionId)
    const index = old?.recent.findIndex(item => item.id === id) ?? -1
    // Only settled attempts are archived; a repeated finish remains idempotent.
    if (!old || index < 0) return
    const item = old.recent[index]!
    const merged = mergeUsage(item, usage)
    if (item.status !== 'started' && merged.input === item.input && merged.output === item.output
      && merged.cacheRead === item.cacheRead && merged.cacheWrite === item.cacheWrite) {
      if (this.overlay.has(sessionId)) await this.commit(sessionId, old)
      return
    }
    const recent = [...old.recent]
    recent[index] = { ...item, ...merged, ...(item.status === 'started' ? { status, endedAt: Date.now() } : {}) }
    await this.commit(sessionId, { ...old, recent })
  }

  /**
   * Idempotently record usage that arrived after a cancelled attempt was
   * settled. Each field is filled at most once from the first notification
   * that provides it; later notifications only fill still-unknown fields, the
   * attempt status stays untouched, and genuinely absent usage stays unknown.
   * @param sessionId - owning session of the settled attempt.
   * @param id - exact attempt id from {@link start}.
   * @param usage - late provider usage totals snapshot; partial usage records only the known fields.
   */
  async recordUsage(sessionId: string, id: string, usage: Usage): Promise<void> {
    const old = this.read(sessionId)
    const index = old?.recent.findIndex(item => item.id === id) ?? -1
    if (!old || index < 0) return
    const row = old.recent[index]!
    const merged = mergeUsage(row, usage)
    if (merged.input === row.input && merged.output === row.output
      && merged.cacheRead === row.cacheRead && merged.cacheWrite === row.cacheWrite) {
      if (this.overlay.has(sessionId)) await this.commit(sessionId, old)
      return
    }
    const recent = [...old.recent]; recent[index] = { ...row, ...merged }
    await this.commit(sessionId, { ...old, recent })
  }
  stats(sessionId: string): SummaryStats | undefined {
    const row = this.read(sessionId)
    if (!row) return
    return { ...row.recent.reduce(add, { ...row.archived }), since: row.since, recent: row.recent.slice(-32).map(item => ({ ...item })) }
  }
  async close(): Promise<void> {
    this.closed = true
    await this.chain
    try {
      for (const [sessionId, row] of this.overlay) {
        await this.table.put(sessionId, row)
        this.overlay.delete(sessionId)
      }
    } finally { await this.domain.close() }
  }
}
