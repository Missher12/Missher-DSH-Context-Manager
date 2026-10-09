/** Durable call permits. A single operation row consumes both budget and authorization.
 * Legacy cycle rows are read only and counted once, never mirrored into this table.
 * No history or generated text is persisted here. */
import { createHash, randomUUID } from 'node:crypto'
import { z } from 'zod'
import { defineDomain, domainTable } from '@deepseek-ai/dsh-storage-domain'
import type { Domain, DomainFacility, KvTable } from '@deepseek-ai/dsh-storage-domain'
import type { ClaimRecord } from './compaction-cycles.ts'

const count = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER)
const identifier = z.string().min(1).max(256)
const hash = z.string().regex(/^[a-f0-9]{64}$/)
export const operationPhase = z.enum(['recorded', 'committed', 'known_failed_unapplied', 'generated_uncommitted', 'unknown_interrupted', 'not_dispatched'])
export type OperationPhase = z.infer<typeof operationPhase>
const operationSchema = z.object({
  operationId: identifier, sessionId: identifier, requestHash: hash, routeHash: hash, sourceHash: hash,
  sourceWatermark: count, cycleWatermark: count, cycle: count.min(1), ordinal: count.min(1).max(4),
  purpose: z.enum(['summary', 'repair', 'recovery']), trigger: z.enum(['idle', 'pressure', 'overflow', 'manual']),
  reissue: z.boolean(), claimedAt: count, phase: operationPhase,
  reasonCode: z.string().max(64).optional(), attemptId: identifier.optional(), compactionId: identifier,
  settledAt: count.optional(), authorizationId: identifier.optional(),
  diagnostic: z.object({ finish: z.string().max(40), chars: count, outputHash: hash, elapsedMs: count, totalMs: count }).strict().optional(),
}).strict()
export type OperationRow = z.infer<typeof operationSchema>
const grantSchema = z.object({
  authorizationId: identifier, sessionId: identifier, requestHash: hash, routeHash: hash, sourceHash: hash,
  sourceWatermark: count, grantedAt: count, expiresAt: count,
}).strict()
export type GrantRow = z.infer<typeof grantSchema>
export const summaryOperationsSpec = defineDomain({
  name: 'context_manager_operations', version: 1,
  tables: { operations: domainTable<string, OperationRow>(operationSchema), grants: domainTable<string, GrantRow>(grantSchema) },
})
// Independent manual rescue budget. Original automatic cycle rows are never
// renumbered, cleared, or credited. One durable row consumes the whole rescue.
const emergencySchema = z.object({ operation: operationSchema, expiresAt: count, acceptedUnknownCost: z.literal(true), confirmationHash:hash }).strict()
const runSchema=z.object({sessionId:identifier,compactionId:identifier,version:z.string().max(40),startedAt:count,totalMs:count,firstOutputMs:count,stallMs:count,dispatched:count,actualDispatched:count.optional(),endedAt:count.optional(),reasonCode:z.string().max(64).optional()}).strict()
const emergencySpec = defineDomain({ name: 'context_manager_emergency', version: 1,
  tables: { calls: domainTable<string, z.infer<typeof emergencySchema>>(emergencySchema), runs: domainTable<string,z.infer<typeof runSchema>>(runSchema) } })
export interface EmergencyPlan { token: string; expiresAt: number; cycle: number; warning: string; model:string; deadline:string; estimatedInput:number }
const emergencyWarning = '旧调用费用及供应商状态可能未知；本次最多额外收费调用一次，不重试、不修复。仅压缩，不重放已结束任务。'
export class OperationStateError extends Error {
  constructor(message: string, readonly code = 'operation_state') { super(message); this.name = 'OperationStateError' }
}
const keyOf = (...parts: string[]) => createHash('sha256').update(JSON.stringify(parts)).digest('hex')
function refuse(message: string, code?: string): never { throw new OperationStateError(message, code) }
export interface PermitInput {
  sessionId: string; requestHash: string; routeHash: string; sourceHash: string; sourceWatermark: number
  freshTokens: number; minNewTokens: number; purpose: OperationRow['purpose']; trigger: OperationRow['trigger']
  compactionId: string; legacy: readonly ClaimRecord[]; unboundManual: boolean
  confirmation?: {hash:string;model:string;deadline:string;estimatedInput:number}
}
export interface RecoveryStatus { available: boolean; message: string; requestHash?: string }

export class SummaryOperations {
  private readonly table: KvTable<string, OperationRow>
  private readonly grants: KvTable<string, GrantRow>
  private readonly rows = new Map<string, OperationRow>()
  private readonly emergencyRows = new Map<string, z.infer<typeof emergencySchema>>()
  private readonly prepared = new Map<string, { input: PermitInput; token: string; expiresAt: number; cycle: number }>()
  private readonly inputs = new Map<string, PermitInput>()
  private readonly blocked = new Map<string, PermitInput>()
  private chain: Promise<void> = Promise.resolve()
  private closing = false
  private poisoned = false
  private disposal?: Promise<void>
  private constructor(private readonly domain: Domain<typeof summaryOperationsSpec>, private readonly emergencyDomain: Domain<typeof emergencySpec>) {
    for (const [key, value] of emergencyDomain.table('calls').entries()) {
      const row=emergencySchema.parse(value)
      if(key!==keyOf(row.operation.sessionId,String(row.operation.cycle))) refuse('独立急救账本身份不一致')
      this.emergencyRows.set(key,row)
    }
    this.table = domain.table('operations'); this.grants = domain.table('grants')
    for (const [key, value] of this.table.entries()) {
      const row = operationSchema.parse(value)
      if (key !== keyOf(row.sessionId, row.operationId) || this.rows.has(row.operationId)
        || (row.phase === 'recorded' ? row.settledAt !== undefined : row.settledAt === undefined)) refuse('压缩调用记录不一致，停止收费')
      this.rows.set(row.operationId, row)
    }
    for (const [key, value] of this.grants.entries()) {
      const row = grantSchema.parse(value)
      if (key !== keyOf(row.sessionId, row.authorizationId) || row.expiresAt <= row.grantedAt) refuse('恢复授权记录不一致')
    }
    const authorizations = [...this.rows.values()].flatMap(row => row.authorizationId ? [row.authorizationId] : [])
    if (new Set(authorizations).size !== authorizations.length) refuse('恢复授权重复消费，停止收费')
  }
  static async open(facility: Pick<DomainFacility, 'open'>): Promise<SummaryOperations> {
    const domain = await facility.open(summaryOperationsSpec)
    let emergency: Domain<typeof emergencySpec> | undefined
    try { emergency = await facility.open(emergencySpec); return new SummaryOperations(domain, emergency) } catch (error) { await emergency?.close(); await domain.close(); throw error }
  }
  records(sessionId: string): readonly OperationRow[] {
    return [...this.rows.values()].filter(row => row.sessionId === sessionId).map(row => Object.freeze({ ...row }))
  }
  run(sessionId:string,compactionId:string) {return this.emergencyDomain.table('runs').get(keyOf(sessionId,compactionId))}
  async startRun(sessionId:string,compactionId:string,limits:{totalMs:number;firstOutputMs:number;stallMs:number}) {
    return this.enqueue(async()=>{const key=keyOf(sessionId,compactionId);if(this.emergencyDomain.table('runs').get(key))return
      await this.emergencyDomain.table('runs').put(key,{sessionId,compactionId,version:'0.10.0-local.4',startedAt:Date.now(),...limits,dispatched:0})})
  }
  async dispatchRun(sessionId:string,compactionId:string) {
    return this.enqueue(async()=>{const key=keyOf(sessionId,compactionId),row=this.emergencyDomain.table('runs').get(key)
      if(!row || row.endedAt!==undefined)refuse('缺少有效执行诊断，停止调用')
      await this.emergencyDomain.table('runs').put(key,{...row,dispatched:row.dispatched+1})})
  }
  async endRun(sessionId:string,compactionId:string,reasonCode:string,actualDispatched:number) {
    return this.enqueue(async()=>{const key=keyOf(sessionId,compactionId),row=this.emergencyDomain.table('runs').get(key)
      if(row && row.endedAt===undefined)await this.emergencyDomain.table('runs').put(key,{...row,endedAt:Date.now(),reasonCode,actualDispatched})})
  }
  allRecords(sessionId: string): readonly OperationRow[] {
    return [...this.records(sessionId), ...[...this.emergencyRows.values()].map(v=>v.operation).filter(r=>r.sessionId===sessionId).map(row=>Object.freeze({...row}))]
  }
  emergencyStatus(sessionId: string, legacy: readonly ClaimRecord[] = []) {
    const cycle=this.cycle(sessionId,legacy)
    const used=!!cycle && this.emergencyRows.has(keyOf(sessionId,String(cycle.cycle)))
    const eligible=!!cycle && (cycle.primary>=2 || cycle.total>=4) && !used
    return {eligible,used,message:used?'本批历史的独立人工急救已消费，不能重复领取':eligible?emergencyWarning:''}
  }
  prepareEmergency(input: PermitInput): EmergencyPlan {
    if(!input.confirmation) refuse('缺少精确急救确认信息')
    if(this.closing || this.poisoned) refuse('账本不可用，未准备急救')
    if(!this.emergencyStatus(input.sessionId,input.legacy).eligible) refuse('当前批次不符合独立急救条件')
    const cycle=this.cycle(input.sessionId,input.legacy)!
    const plan={input:{...input,confirmation:{...input.confirmation}},token:randomUUID(),expiresAt:Date.now()+120000,cycle:cycle.cycle}
    this.prepared.set(input.sessionId,plan)
    return {token:plan.token,expiresAt:plan.expiresAt,cycle:plan.cycle,warning:emergencyWarning,model:input.confirmation.model,deadline:input.confirmation.deadline,estimatedInput:input.confirmation.estimatedInput}
  }
  /** Final synchronous gate, after every durable await and immediately before llm.stream. */
  assertEmergencyDispatch(sessionId:string,id:string,confirmationHash:string):void {
    if(this.closing || this.poisoned)refuse('账本不可用，未派发人工急救')
    const saved=[...this.emergencyRows.values()].find(v=>v.operation.sessionId===sessionId && v.operation.operationId===id)
    if(!saved || saved.operation.phase!=='recorded' || saved.expiresAt<=Date.now())refuse('人工急救授权已过期或不再有效，未调用模型')
    if(saved.confirmationHash!==confirmationHash)refuse('等待期间配置、工具或原文发生变化，未调用模型')
  }
  async claimEmergency(input: PermitInput, token: string): Promise<OperationRow> {
    return this.enqueue(async()=>{
      const plan=this.prepared.get(input.sessionId),cycle=this.cycle(input.sessionId,input.legacy)
      if(!plan || plan.token!==token || plan.expiresAt<=Date.now() || plan.cycle!==cycle?.cycle
        || !this.emergencyStatus(input.sessionId,input.legacy).eligible) refuse('急救计划已失效或已消费')
      if(!input.confirmation || input.confirmation.hash!==plan.input.confirmation?.hash)refuse('配置、工具或计划已改变，请重新预检')
      for(const key of ['sessionId','sourceHash','sourceWatermark','requestHash','routeHash'] as const)
        if(plan.input[key]!==input[key]) refuse('原文、计划或模型已改变，请重新预检')
      const row=operationSchema.parse({operationId:randomUUID(),sessionId:input.sessionId,requestHash:input.requestHash,
        routeHash:input.routeHash,sourceHash:input.sourceHash,sourceWatermark:input.sourceWatermark,cycleWatermark:cycle.watermark,
        cycle:cycle.cycle,ordinal:1,purpose:'recovery',trigger:'manual',reissue:false,claimedAt:Date.now(),phase:'recorded',
        compactionId:input.compactionId,authorizationId:token})
      const key=keyOf(input.sessionId,String(cycle.cycle)),value={operation:row,expiresAt:plan.expiresAt,acceptedUnknownCost:true as const,confirmationHash:input.confirmation.hash}
      try {await this.emergencyDomain.table('calls').put(key,value)}catch(error){this.poisoned=true;throw error}
      this.emergencyRows.set(key,value);this.prepared.delete(input.sessionId)
      return Object.freeze({...row})
    })
  }
  /** Count original-source growth from this watermark; checkpoint replacements do not advance it. */
  watermark(sessionId: string, legacy: readonly ClaimRecord[]): number {
    return this.cycle(sessionId, legacy)?.watermark ?? -1
  }
  private cycle(sessionId: string, legacy: readonly ClaimRecord[]) {
    const rows = [...legacy, ...this.records(sessionId)]
      .sort((a, b) => a.cycle - b.cycle || a.ordinal - b.ordinal)
    let current: { cycle: number; watermark: number; total: number; primary: number } | undefined
    for (const row of rows) {
      const watermark = 'cycleWatermark' in row ? row.cycleWatermark : row.sourceWatermark
      if (!current || row.cycle !== current.cycle) {
        if (row.cycle !== (current?.cycle ?? 0) + 1 || row.ordinal !== 1 || row.purpose === 'repair'
          || (current && watermark <= current.watermark)) refuse('压缩周期顺序不一致，停止收费')
        current = { cycle: row.cycle, watermark, total: 0, primary: 0 }
      }
      if (row.ordinal !== current.total + 1 || current.watermark !== watermark) refuse('压缩周期存在重复或缺口，停止收费')
      current.total++
      if (row.purpose !== 'repair') current.primary++
      if (current.total > 4 || current.primary > 2) refuse('压缩周期已超出安全预算，停止收费')
    }
    return current
  }
  private decision(input: PermitInput) {
    const previous = this.cycle(input.sessionId, input.legacy)
    if (previous && input.sourceWatermark < previous.watermark) refuse('压缩来源早于当前周期，停止收费')
    const all = this.records(input.sessionId)
    const same = all.filter(row => row.requestHash === input.requestHash)
    const legacySame = input.legacy.some(row => row.requestHash === input.requestHash)
    if (same.some(row => row.phase === 'committed' || all.some(other => other.compactionId === row.compactionId && other.phase === 'committed'))) refuse('相同摘要已经提交，不重复收费')
    // Exact retries never open a new cycle, even if a newly numbered checkpoint exists.
    const newCycle = !previous || (!legacySame && same.length === 0 && input.purpose !== 'repair'
      && input.sourceWatermark > previous.watermark && input.freshTokens >= input.minNewTokens)
    if (!previous && input.purpose === 'repair') refuse('格式修复不能单独开启周期')
    if (!newCycle && previous && (previous.total >= 4 || (input.purpose !== 'repair' && previous.primary >= 2))) {
      refuse(`本批历史已达到 2 个主摘要 / 4 次总调用上限（已用主摘要 ${previous.primary}/2、总调用 ${previous.total}/4）；这是调用额度阻断，本次未调用摘要模型；修改时限不返还未知调用额度，任务原文保留`, 'budget_exhausted')
    }
    const exact = (row: OperationRow) => row.sourceHash === input.sourceHash && row.routeHash === input.routeHash
      && row.sourceWatermark === input.sourceWatermark
    if (same.some(row => !exact(row))) refuse('旧调用的来源或模型路由已改变，不能自动重发或沿用授权')
    const unresolved = (row: OperationRow) => !['known_failed_unapplied', 'not_dispatched', 'committed'].includes(row.phase)
    // Changing request text or model cannot silently escape an unresolved primary.
    const pending = !newCycle && input.purpose !== 'repair' && all.some(row => row.cycle === previous?.cycle && unresolved(row))
    const legacyPending = !newCycle && input.purpose !== 'repair' && input.legacy.some(row => row.cycle === previous?.cycle)
    const unknown = legacySame || legacyPending || same.some(unresolved) || pending
    const reissue = same.length > 0 || legacySame
    if (same.some(row => row.reissue || row.authorizationId)) refuse('相同请求已恢复过一次，停止重复收费')
    return { cycle: newCycle ? (previous?.cycle ?? 0) + 1 : previous!.cycle,
      cycleWatermark: newCycle ? input.sourceWatermark : previous!.watermark,
      ordinal: newCycle ? 1 : previous!.total + 1, unknown, reissue }
  }
  private matchingGrant(input: PermitInput): GrantRow | undefined {
    const consumed = new Set([...this.rows.values()].map(row => row.authorizationId))
    return [...this.grants.entries()].map(([, row]) => row).find(row => row.sessionId === input.sessionId
      && row.requestHash === input.requestHash && row.routeHash === input.routeHash && row.sourceHash === input.sourceHash
      && row.sourceWatermark === input.sourceWatermark && row.expiresAt > Date.now() && !consumed.has(row.authorizationId))
  }
  /** One serialized durable put is the only permission to dispatch. A crash consumes it. */
  async claim(input: PermitInput): Promise<OperationRow> {
    return this.enqueue(async () => {
      let decision: ReturnType<SummaryOperations['decision']>
      try { decision = this.decision(input) } catch (error) {
        this.blocked.set(input.sessionId, { ...input, legacy: input.legacy.map(row => ({ ...row })) })
        throw error
      }
      const grant = decision.unknown ? this.matchingGrant(input) : undefined
      if (decision.unknown && (!grant || input.unboundManual)) {
        this.blocked.set(input.sessionId, { ...input, legacy: input.legacy.map(row => ({ ...row })) })
        refuse(input.unboundManual ? '旧手动调用无法精确绑定预算，需要先核验，未授权新收费'
          : '上次调用结果未知，不自动再次收费；可在上下文面板明确授权一次恢复')
      }
      const row = operationSchema.parse({ operationId: randomUUID(), sessionId: input.sessionId,
        requestHash: input.requestHash, routeHash: input.routeHash, sourceHash: input.sourceHash,
        sourceWatermark: input.sourceWatermark, cycleWatermark: decision.cycleWatermark, cycle: decision.cycle,
        ordinal: decision.ordinal, purpose: input.purpose, trigger: input.trigger, reissue: decision.reissue,
        compactionId: input.compactionId, claimedAt: Date.now(), phase: 'recorded',
        ...(grant ? { authorizationId: grant.authorizationId } : {}) })
      await this.write(row)
      this.inputs.set(row.operationId, { ...input })
      this.blocked.delete(input.sessionId)
      return Object.freeze({ ...row })
    })
  }
  /** Read only. No grant is created by inspector reads or ordinary continue messages. */
  recoveryStatus(sessionId: string, legacy: readonly ClaimRecord[] = []): RecoveryStatus {
    const input = this.blocked.get(sessionId)
    if (!input) {
      try {
        const cycle = this.cycle(sessionId, legacy)
        const rows = this.records(sessionId).filter(row => row.cycle === cycle?.cycle)
        if (cycle && (cycle.primary >= 2 || cycle.total >= 4) && !rows.some(row => row.phase === 'committed')) {
          return { available: false, message: `本批历史额度已满：主摘要 ${cycle.primary}/2、总调用 ${cycle.total}/4；未授权新收费。修改时限或重启不返还未知额度，请先核验原调用结果。` }
        }
        if (rows.some(row => ['recorded', 'unknown_interrupted', 'generated_uncommitted'].includes(row.phase)) || legacy.length) {
          return { available: false, message: '旧压缩调用记录仍待核验；当前没有已绑定的恢复计划，未授权新收费。' }
        }
      } catch { return { available: false, message: '压缩调用记录无法核验，停止收费' } }
      return { available: false, message: '' }
    }
    try {
      const decision = this.decision(input)
      if (!decision.unknown || input.unboundManual) return { available: false, message: '旧调用预算需要核验，不能授权新收费' }
      if (this.matchingGrant(input)) return { available: false, message: '一次恢复授权已保存；有效期两分钟，来源和模型必须保持一致' }
      return { available: true, requestHash: input.requestHash, message: '上次费用结果未知；可明确授权一次额外调用，仍受同源预算限制' }
    } catch (error) { return { available: false, message: error instanceof Error ? error.message : '调用记录无法核验' } }
  }
  /** Explicit UI mutation, bound to the currently blocked request; never called by a tool. */
  async grant(sessionId: string, requestHash: string): Promise<void> {
    return this.enqueue(async () => {
      const input = this.blocked.get(sessionId)
      if (!input || input.requestHash !== requestHash || !this.recoveryStatus(sessionId).available) refuse('恢复条件已改变，请重新检查上下文状态')
      const now = Date.now()
      const row = grantSchema.parse({ authorizationId: randomUUID(), sessionId, requestHash,
        routeHash: input.routeHash, sourceHash: input.sourceHash, sourceWatermark: input.sourceWatermark,
        grantedAt: now, expiresAt: now + 120000 })
      try { await this.grants.put(keyOf(sessionId, row.authorizationId), row) }
      catch (error) { this.poisoned = true; throw error }
    })
  }
  async bind(sessionId: string, id: string, extra: { attemptId?: string; compactionId?: string }): Promise<void> {
    return this.enqueue(async () => {
      const row = this.requireRow(sessionId, id)
      for (const key of ['attemptId', 'compactionId'] as const) {
        if (extra[key] !== undefined && row[key] !== undefined && extra[key] !== row[key]) refuse('压缩调用身份不能覆盖')
      }
      const defined = Object.fromEntries(Object.entries(extra).filter(([, value]) => value !== undefined))
      await this.write(operationSchema.parse({ ...row, ...defined }))
    })
  }
  async describe(sessionId: string, id: string, diagnostic: NonNullable<OperationRow['diagnostic']>): Promise<void> {
    return this.enqueue(async () => {
      const row = this.requireRow(sessionId, id)
      if (row.diagnostic || row.phase !== 'recorded') return
      await this.write(operationSchema.parse({ ...row, diagnostic }))
    })
  }
  async settle(sessionId: string, id: string, phase: Exclude<OperationPhase, 'recorded'>,
    extra: { reasonCode?: string } = {}): Promise<void> {
    return this.enqueue(async () => {
      const row = this.requireRow(sessionId, id)
      if (row.phase !== 'recorded') return // Terminal proof never changes, including after late usage.
      await this.write(operationSchema.parse({ ...row, ...extra, phase, settledAt: Date.now() }))
      const input = this.inputs.get(id)
      if (input && ['unknown_interrupted', 'generated_uncommitted'].includes(phase)) this.blocked.set(sessionId, input)
      this.inputs.delete(id)
    })
  }
  private requireRow(sessionId: string, id: string): OperationRow {
    const row = this.rows.get(id) ?? [...this.emergencyRows.values()].find(v=>v.operation.operationId===id)?.operation
    if (!row || row.sessionId !== sessionId) refuse('压缩调用身份不匹配')
    return row
  }
  private async write(row: OperationRow): Promise<void> {
    const emergencyKey=keyOf(row.sessionId,String(row.cycle)),emergency=this.emergencyRows.get(emergencyKey)
    if(emergency?.operation.operationId===row.operationId) {
      const value={...emergency,operation:row}
      try {await this.emergencyDomain.table('calls').put(emergencyKey,value)}catch(error){this.poisoned=true;throw error}
      this.emergencyRows.set(emergencyKey,value);return
    }
    try { await this.table.put(keyOf(row.sessionId, row.operationId), row) }
    catch (error) { this.poisoned = true; throw error }
    this.rows.set(row.operationId, row)
  }
  close(): Promise<void> {
    if (!this.disposal) { this.closing = true; this.disposal = this.chain.then(async () => {try {await this.emergencyDomain.close()}finally{await this.domain.close()}}) }
    return this.disposal
  }
  private enqueue<T>(job: () => Promise<T>): Promise<T> {
    if (this.closing) return Promise.reject(new OperationStateError('压缩记录正在关闭'))
    const pending = this.chain.then(() => { if (this.poisoned) refuse('持久写入结果未知，重开核验前停止收费'); return job() })
    this.chain = pending.then(() => {}, () => {})
    return pending
  }
}
export function routeHashOf(route: { provider: string; model: string; reasoningEffort?: string; maxTokens?: number }): string {
  return keyOf(route.provider, route.model, route.reasoningEffort ?? '', String(route.maxTokens ?? ''))
}
