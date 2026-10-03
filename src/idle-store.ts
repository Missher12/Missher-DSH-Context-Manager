/** Durable, content-free idle eligibility; one Manager owns the open domain. */
import { z } from 'zod'
import { defineDomain, domainTable } from '@deepseek-ai/dsh-storage-domain'
import type { Domain, DomainFacility, KvTable } from '@deepseek-ai/dsh-storage-domain'

const tokenCount = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER)
const identifier = z.string().min(1).max(256)
const eligibilitySchema = z.object({
  sessionId: identifier,
  turnEndSeq: tokenCount,
  completedAt: tokenCount,
  fingerprint: identifier,
}).strict()
const terminalStatus = z.enum(['completed', 'skipped', 'cancelled', 'failed', 'interrupted'])
const outcomeSchema = z.object({
  status: terminalStatus,
  compactionId: identifier.optional(),
  beforeTokens: tokenCount.optional(),
  afterTokens: tokenCount.optional(),
  reasonCode: z.string().min(1).max(160).optional(),
}).strict()
const recordSchema = eligibilitySchema.extend({
  status: z.enum(['eligible', 'started', ...terminalStatus.options]),
  updatedAt: tokenCount,
  attemptId: identifier.optional(),
  compactionId: identifier.optional(),
  beforeTokens: tokenCount.optional(),
  afterTokens: tokenCount.optional(),
  reasonCode: z.string().min(1).max(160).optional(),
}).refine(record => record.status !== 'started' || record.attemptId !== undefined, {
  message: 'a started idle attempt requires an attemptId',
}).refine(record => record.status !== 'eligible' || record.attemptId === undefined, {
  message: 'an eligible idle turn cannot already have an attemptId',
})

/** Use the original normal turn/end event time, never the time of a replay. */
export type IdleEligibility = z.infer<typeof eligibilitySchema>
/** Fingerprints and reason codes are metadata; never pass message or error bodies. */
export type IdleRecord = Readonly<z.infer<typeof recordSchema>>
export type IdleOutcome = z.infer<typeof outcomeSchema>

export const idleDomainSpec = defineDomain({
  name: 'context_manager_idle',
  version: 1,
  tables: { sessions: domainTable<string, IdleRecord>(recordSchema) },
})

function sameEligibility(left: IdleEligibility, right: IdleEligibility): boolean {
  return left.sessionId === right.sessionId && left.turnEndSeq === right.turnEndSeq
    && left.completedAt === right.completedAt && left.fingerprint === right.fingerprint
}

function eligibilityOf(value: IdleEligibility): IdleEligibility {
  return eligibilitySchema.parse({
    sessionId: value.sessionId,
    turnEndSeq: value.turnEndSeq,
    completedAt: value.completedAt,
    fingerprint: value.fingerprint,
  })
}

/**
 * Serializes conditional writes above storage.domain's durable write queue.
 * There is no second in-memory cache, and no claim succeeds before persistence.
 */
export class IdleStore {
  private readonly table: KvTable<string, IdleRecord>
  private chain: Promise<void> = Promise.resolve()
  private closing = false
  private disposal?: Promise<void>

  private constructor(private readonly domain: Domain<typeof idleDomainSpec>) {
    this.table = domain.table('sessions')
  }

  /** Open once on the Manager; preset engines share the returned instance. */
  static async open(facility: Pick<DomainFacility, 'open'>): Promise<IdleStore> {
    return new IdleStore(await facility.open(idleDomainSpec))
  }

  /** Read only the latest persisted record, without exposing mutable domain state. */
  get(sessionId: string): IdleRecord | undefined {
    const record = this.table.get(sessionId)
    if (!record) return undefined
    if (record.sessionId !== sessionId) throw new Error('idle record session key mismatch')
    return Object.freeze({ ...record })
  }

  /** Snapshot only this ledger's registered metadata, without loading sessions. */
  all(): readonly IdleRecord[] {
    return Object.freeze(Array.from(this.table.entries(), ([key, record]) => {
      if (record.sessionId !== key) throw new Error('idle record session key mismatch')
      return Object.freeze({ ...record })
    }))
  }

  /**
   * Record a newly observed normal completion. A duplicate never restores
   * eligibility after an attempt; stale completion events cannot replace newer
   * ones. A later completion may reset its sequence after a history clear.
   */
  async reserve(eligibility: IdleEligibility): Promise<IdleRecord | null> {
    const input = eligibilitySchema.parse(eligibility)
    return this.enqueue(async () => {
      const current = this.get(input.sessionId)
      if (current) {
        if (sameEligibility(current, input)) return current
        if (current.fingerprint === input.fingerprint) return null
        if (input.completedAt < current.completedAt
          || (input.completedAt === current.completedAt && input.turnEndSeq <= current.turnEndSeq)) return null
      }
      return this.put({ ...input, status: 'eligible', updatedAt: Date.now() })
    })
  }

  /** Only the winner may start compaction, and only after awaiting this write. */
  async claim(eligibility: IdleEligibility, attemptId: string, beforeTokens?: number): Promise<IdleRecord | null> {
    const expected = eligibilityOf(eligibility)
    const id = identifier.parse(attemptId)
    const before = beforeTokens === undefined ? undefined : tokenCount.parse(beforeTokens)
    return this.enqueue(async () => {
      const current = this.get(expected.sessionId)
      if (!current || current.status !== 'eligible' || !sameEligibility(current, expected)) return null
      return this.put({ ...current, status: 'started', attemptId: id, updatedAt: Date.now(),
        ...(before === undefined ? {} : { beforeTokens: before }) })
    })
  }

  /** Persist the host transaction ID before its summary stream may begin. */
  async bindCompaction(eligibility: IdleEligibility, attemptId: string, compactionId: string): Promise<IdleRecord | null> {
    const expected = eligibilityOf(eligibility)
    const id = identifier.parse(attemptId)
    const compaction = identifier.parse(compactionId)
    return this.enqueue(async () => {
      const current = this.get(expected.sessionId)
      if (!current || current.status !== 'started' || current.attemptId !== id || !sameEligibility(current, expected)) return null
      if (current.compactionId === compaction) return current
      return this.put({ ...current, compactionId: compaction, updatedAt: Date.now() })
    })
  }

  /**
   * Finish exactly one qualification/attempt. Unclaimed eligibility can be
   * skipped or invalidated without an attemptId, but cannot claim completion.
   * A late cancellation or completion cannot overwrite a newer normal turn.
   */
  async settle(eligibility: IdleEligibility, attemptId: string | undefined, outcome: IdleOutcome): Promise<IdleRecord | null> {
    const expected = eligibilityOf(eligibility)
    const id = attemptId === undefined ? undefined : identifier.parse(attemptId)
    const result = outcomeSchema.parse(outcome)
    return this.enqueue(async () => {
      const current = this.get(expected.sessionId)
      if (!current || !sameEligibility(current, expected) || current.attemptId !== id) return null
      if (current.status !== 'eligible' && current.status !== 'started') return null
      if (current.status === 'eligible' && (id !== undefined || result.status === 'completed')) return null
      return this.put({ ...current, ...result, updatedAt: Date.now() })
    })
  }

  /** Wait for writes already accepted; each write reports its own failure. */
  drain(): Promise<void> { return this.chain }

  /** Reject new writes, drain accepted writes, then release the domain once. */
  close(): Promise<void> {
    if (!this.disposal) {
      this.closing = true
      this.disposal = this.chain.then(() => this.domain.close())
    }
    return this.disposal
  }

  private enqueue<T>(job: () => Promise<T>): Promise<T> {
    if (this.closing) return Promise.reject(new Error('idle store is closing'))
    const pending = this.chain.then(job)
    this.chain = pending.then(() => {}, () => {})
    return pending
  }

  private async put(value: IdleRecord): Promise<IdleRecord> {
    const record = Object.freeze(recordSchema.parse(value))
    await this.table.put(record.sessionId, record)
    return Object.freeze({ ...record })
  }
}
