/** Durable automatic-compaction call permits. Only hashes, counters and source positions are stored. */
import { createHash } from 'node:crypto'
import { z } from 'zod'
import { defineDomain, domainTable } from '@deepseek-ai/dsh-storage-domain'
import type { Domain, DomainFacility, KvTable } from '@deepseek-ai/dsh-storage-domain'

const count = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER)
const positive = count.min(1)
const identifier = z.string().min(1).max(256)
const hash = z.string().regex(/^[a-f0-9]{64}$/)
const purpose = z.enum(['summary', 'repair', 'recovery'])
const inputSchema = z.object({
  sessionId: identifier, requestHash: hash, sourceWatermark: count,
  freshTokens: count, minNewTokens: positive, purpose,
}).strict()
const claimSchema = inputSchema.extend({ cycle: positive, ordinal: positive.max(4), claimedAt: count })

export type CompactionClaim = z.infer<typeof inputSchema>
export type ClaimRecord = z.infer<typeof claimSchema>
export type CompactionCycleCode = 'duplicate_request' | 'summary_limit' | 'call_limit' | 'no_cycle' | 'stale_source' | 'closed' | 'invalid_state'

/** A refusal is not permission to retry under a different model or step. */
export class CompactionCycleError extends Error {
  constructor(readonly code: CompactionCycleCode, message: string) {
    super(message)
    this.name = 'CompactionCycleError'
  }
}

export interface CompactionCycleSnapshot {
  readonly sessionId: string
  readonly cycle: number
  /** Original-source watermark at the start of this cycle, unchanged by smaller intervening additions. */
  readonly sourceWatermark: number
  readonly summaryCalls: number
  readonly calls: number
  readonly requestHashes: readonly string[]
  readonly startedAt: number
  readonly updatedAt: number
}

/** One durable row per permit keeps the call and its cycle membership atomic. */
export const compactionCyclesSpec = defineDomain({
  name: 'context_manager_cycles', version: 1,
  tables: { claims: domainTable<string, ClaimRecord>(claimSchema) },
})

function keyOf(sessionId: string, requestHash: string): string {
  return createHash('sha256').update(JSON.stringify([sessionId, requestHash])).digest('hex')
}

function invalid(): never {
  throw new CompactionCycleError('invalid_state', '压缩调用周期记录不一致；保留记录并停止自动摘要')
}

/** Validate the complete durable prefix, including when replaying an interrupted process. */
function advance(previous: CompactionCycleSnapshot | undefined, row: ClaimRecord): CompactionCycleSnapshot {
  const newCycle = previous === undefined || row.cycle !== previous.cycle
  if (newCycle) {
    if (row.cycle !== (previous?.cycle ?? 0) + 1 || row.ordinal !== 1 || row.purpose !== 'summary') invalid()
    if (previous && (row.sourceWatermark <= previous.sourceWatermark || row.freshTokens < row.minNewTokens)) invalid()
  } else if (row.sourceWatermark !== previous.sourceWatermark || row.ordinal !== previous.calls + 1) invalid()
  const summaryCalls = (newCycle ? 0 : previous.summaryCalls) + (row.purpose === 'summary' ? 1 : 0)
  if (summaryCalls > 2) invalid()
  return Object.freeze({ sessionId: row.sessionId, cycle: row.cycle, sourceWatermark: row.sourceWatermark,
    summaryCalls, calls: row.ordinal,
    requestHashes: Object.freeze([...(newCycle ? [] : previous.requestHashes), row.requestHash]),
    startedAt: newCycle ? row.claimedAt : previous.startedAt, updatedAt: row.claimedAt })
}

/** One Manager owns this domain and serializes all preset engines' claims. */
export class CompactionCycles {
  private readonly table: KvTable<string, ClaimRecord>
  private readonly sessions = new Map<string, CompactionCycleSnapshot>()
  private chain: Promise<void> = Promise.resolve()
  private closing = false
  private disposal?: Promise<void>

  private constructor(private readonly domain: Domain<typeof compactionCyclesSpec>) {
    this.table = domain.table('claims')
    // The storage backend need not preserve insertion order. Rebuild each
    // session's cycle prefix by its explicit ordinal, rejecting gaps or edits.
    const records = [...this.table.entries()].map(([key, value]) => {
      const row = claimSchema.parse(value)
      if (key !== keyOf(row.sessionId, row.requestHash)) invalid()
      return row
    }).sort((a, b) => a.cycle - b.cycle || a.ordinal - b.ordinal)
    for (const row of records) this.sessions.set(row.sessionId, advance(this.sessions.get(row.sessionId), row))
  }

  static async open(facility: Pick<DomainFacility, 'open'>): Promise<CompactionCycles> {
    const domain = await facility.open(compactionCyclesSpec)
    try { return new CompactionCycles(domain) }
    catch (error) { await domain.close(); throw error }
  }

  /** The last persisted cycle. No model request or background work is resumed. */
  peek(sessionId: string): CompactionCycleSnapshot | undefined {
    return this.sessions.get(identifier.parse(sessionId))
  }

  /** Legacy permits remain immutable; new operations account them exactly once. */
  records(sessionId: string): readonly ClaimRecord[] {
    return [...this.table.entries()].map(([, row]) => row).filter(row => row.sessionId === sessionId)
      .map(row => Object.freeze({ ...row })).sort((a, b) => a.cycle - b.cycle || a.ordinal - b.ordinal)
  }

  /** Await this permit immediately before the actual model call; unknown outcomes remain consumed. */
  async claim(value: CompactionClaim): Promise<void> {
    const input = inputSchema.parse(value)
    return this.enqueue(async () => {
      const key = keyOf(input.sessionId, input.requestHash)
      // Check durable state within our serial queue. Old cycles' hashes stay
      // in the table, so new content never authorizes replaying an old request.
      if (this.table.get(key)) throw new CompactionCycleError('duplicate_request', '相同摘要请求已有调用记录，不自动再次收费')
      const previous = this.sessions.get(input.sessionId)
      if (!previous && input.purpose !== 'summary') throw new CompactionCycleError('no_cycle', '修复或协议恢复不能单独开启压缩周期')
      if (previous && input.sourceWatermark < previous.sourceWatermark) {
        throw new CompactionCycleError('stale_source', '压缩来源早于当前周期，不自动重发旧请求')
      }
      const newCycle = previous === undefined || (input.purpose === 'summary'
        && input.sourceWatermark > previous.sourceWatermark && input.freshTokens >= input.minNewTokens)
      if (!newCycle && previous) {
        if (previous.calls >= 4) throw new CompactionCycleError('call_limit', '本批历史已达到 4 次摘要、修复或恢复调用上限')
        if (input.purpose === 'summary' && previous.summaryCalls >= 2) {
          throw new CompactionCycleError('summary_limit', '本批历史已达到 2 个主摘要计划上限')
        }
      }
      const row = claimSchema.parse({ ...input,
        cycle: newCycle ? (previous?.cycle ?? 0) + 1 : previous.cycle,
        ordinal: newCycle ? 1 : previous.calls + 1,
        sourceWatermark: newCycle ? input.sourceWatermark : previous.sourceWatermark,
        claimedAt: Date.now() })
      const next = advance(previous, row)
      // Publish no speculative permit or index entry before backend durability.
      await this.table.put(key, row)
      this.sessions.set(input.sessionId, next)
    })
  }

  /** Reject new claims immediately, then drain already accepted writes and close once. */
  close(): Promise<void> {
    if (!this.disposal) {
      this.closing = true
      this.disposal = this.chain.then(() => this.domain.close())
    }
    return this.disposal
  }

  private enqueue(job: () => Promise<void>): Promise<void> {
    if (this.closing) return Promise.reject(new CompactionCycleError('closed', '压缩周期记录正在关闭，未领取新调用'))
    const pending = this.chain.then(job)
    this.chain = pending.then(() => {}, () => {})
    return pending
  }
}
