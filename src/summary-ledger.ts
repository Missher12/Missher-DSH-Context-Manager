/** Attempt accounting includes failed/cancelled summaries, independently of surface commits. */
import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import { defineDomain, domainTable, type Domain, type DomainFacility } from '@deepseek-ai/dsh-storage-domain'

export type SummaryTrigger = 'idle' | 'pressure' | 'overflow' | 'manual'
const count = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER)
const totals = z.object({ input: count, output: count, cacheRead: count, cacheWrite: count, attempts: count, unknownAttempts: count }).strict()
const attempt = z.object({ id: z.string(), compactionId: z.string(), trigger: z.enum(['idle', 'pressure', 'overflow', 'manual']),
  startedAt: count, endedAt: count.optional(), status: z.enum(['started', 'generated', 'failed', 'cancelled']),
  input: count.nullable(), output: count.nullable(), cacheRead: count, cacheWrite: count }).strict()
const record = z.object({ sessionId: z.string(), since: count, archived: totals, recent: z.array(attempt).max(128) }).strict()
const spec = defineDomain({ name: 'context_manager_summaries', version: 1, tables: { sessions: domainTable<string, z.infer<typeof record>>(record) } })
type Attempt = z.infer<typeof attempt>
type Totals = z.infer<typeof totals>
type Row = z.infer<typeof record>
export interface SummaryStats extends Totals { since: number; recent: Attempt[] }
const zero = (): Totals => ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, attempts: 0, unknownAttempts: 0 })
const finite = (n: unknown): n is number => typeof n === 'number' && Number.isSafeInteger(n) && n >= 0
function add(total: Totals, row: Attempt): Totals {
  return { input: total.input + (row.input ?? 0), output: total.output + (row.output ?? 0),
    cacheRead: total.cacheRead + row.cacheRead, cacheWrite: total.cacheWrite + row.cacheWrite,
    attempts: total.attempts + 1, unknownAttempts: total.unknownAttempts + (row.input === null || row.output === null ? 1 : 0) }
}

export class SummaryLedger {
  private chain: Promise<unknown> = Promise.resolve()
  private closed = false
  private readonly table
  private constructor(private readonly domain: Domain<typeof spec>) { this.table = domain.table('sessions') }
  static async open(facility: DomainFacility): Promise<SummaryLedger> { return new SummaryLedger(await facility.open(spec)) }
  private enqueue<T>(work: () => Promise<T>): Promise<T> {
    if (this.closed) return Promise.reject(new Error('Summary ledger closed'))
    const operation = this.chain.then(work)
    this.chain = operation.catch(() => {})
    return operation
  }
  async start(sessionId: string, compactionId: string, trigger: SummaryTrigger): Promise<string> {
    return this.enqueue(async () => {
      const old = this.table.get(sessionId)
      const next: Row = old ? { ...old, recent: [...old.recent], archived: { ...old.archived } }
        : { sessionId, since: Date.now(), recent: [], archived: zero() }
      if (next.recent.length === 128) {
        const archived = next.recent.findIndex(item => item.status !== 'started')
        if (archived < 0) throw new Error('Too many unsettled summary attempts')
        next.archived = add(next.archived, next.recent.splice(archived, 1)[0]!)
      }
      const id = randomUUID()
      next.recent.push({ id, compactionId, trigger, startedAt: Date.now(), status: 'started', input: null, output: null, cacheRead: 0, cacheWrite: 0 })
      await this.table.put(sessionId, next)
      return id
    })
  }
  async finish(sessionId: string, id: string, status: 'generated' | 'failed' | 'cancelled', usage?: { inputTokens?: number; outputTokens?: number; cacheReadTokens?: number; cacheWriteTokens?: number }): Promise<void> {
    return this.enqueue(async () => {
      const old = this.table.get(sessionId)
      const index = old?.recent.findIndex(item => item.id === id) ?? -1
      // Only settled attempts are archived; a repeated finish remains idempotent.
      if (!old || index < 0) return
      if (old.recent[index]!.status !== 'started') return
      const cacheRead = finite(usage?.cacheReadTokens) ? usage.cacheReadTokens : 0
      const cacheWrite = finite(usage?.cacheWriteTokens) ? usage.cacheWriteTokens : 0
      const row: Attempt = { ...old.recent[index]!, status, endedAt: Date.now(), cacheRead, cacheWrite,
        input: finite(usage?.inputTokens) ? usage.inputTokens + cacheRead + cacheWrite : null,
        output: finite(usage?.outputTokens) ? usage.outputTokens : null }
      const recent = [...old.recent]; recent[index] = row
      await this.table.put(sessionId, { ...old, recent })
    })
  }
  stats(sessionId: string): SummaryStats | undefined {
    const row = this.table.get(sessionId)
    if (!row) return
    return { ...row.recent.reduce(add, { ...row.archived }), since: row.since, recent: row.recent.slice(-32).map(item => ({ ...item })) }
  }
  async close(): Promise<void> { this.closed = true; await this.chain; await this.domain.close() }
}
