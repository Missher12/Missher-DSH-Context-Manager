/** Durable call permits. A single operation row consumes both budget and authorization.
 * Legacy cycle rows are read only and counted once, never mirrored into this table.
 * No history or generated text is persisted here. */
import { createHash, randomUUID } from 'node:crypto'
import { z } from 'zod'
import { defineDomain, domainTable } from '@deepseek-ai/dsh-storage-domain'
import type { Domain, DomainFacility, KvTable } from '@deepseek-ai/dsh-storage-domain'
import type { ClaimRecord } from './compaction-cycles.ts'
import { CONTEXT_MANAGER_VERSION } from './version.ts'

const count = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER)
const identifier = z.string().min(1).max(256)
const hash = z.string().regex(/^[a-f0-9]{64}$/)
// A single explicitly authorized recovery can cover a bounded legacy group.
// Keep this in sync with recoveryTarget() so the UI never offers a grant that
// the durable schema cannot persist.
const MAX_RECOVERY_ORIGINS = 4096
export const operationPhase = z.enum(['recorded', 'committed', 'known_failed_unapplied', 'generated_uncommitted', 'unknown_interrupted', 'not_dispatched'])
export type OperationPhase = z.infer<typeof operationPhase>
const operationSchema = z.object({
  operationId: identifier, sessionId: identifier, requestHash: hash, routeHash: hash, sourceHash: hash,
  sourceWatermark: count, cycleWatermark: count, sourceStart: count.optional(), sourceEnd: count.optional(),
  cycle: count.min(1), ordinal: count.min(1).max(4),
  purpose: z.enum(['summary', 'repair', 'recovery']), trigger: z.enum(['idle', 'pressure', 'overflow', 'manual']),
  reissue: z.boolean(), claimedAt: count, phase: operationPhase,
  reasonCode: z.string().max(64).optional(), attemptId: identifier.optional(), compactionId: identifier,
  /** Fingerprint of the summarization instruction and output cap, excluding source text. */
  strategyHash: hash.optional(),
  /** True only when both billed input and output were observed for this call. */
  usageComplete: z.boolean().optional(),
  /** Provider stream completion observed after a cancellation; never inferred from AbortSignal. */
  physicalEnded: z.literal(true).optional(),
  settledAt: count.optional(), authorizationId: identifier.optional(),
  /** Exact prior failed operation this changed-strategy recovery resolves. */
  recoveryFor: identifier.optional(),
  /** Exact set of same-source legacy/operation risks resolved by one committed recovery. */
  recoveryForIds: z.array(identifier).max(MAX_RECOVERY_ORIGINS).optional(),
  /** Explicit user acceptance for origins whose source lineage cannot be proved. */
  riskAcceptedOriginIds: z.array(identifier).max(MAX_RECOVERY_ORIGINS).optional(),
  diagnostic: z.object({ finish: z.string().max(40), chars: count, outputHash: hash, elapsedMs: count, totalMs: count }).strict().optional(),
}).strict()
export type OperationRow = z.infer<typeof operationSchema>
const grantSchema = z.object({
  authorizationId: identifier, sessionId: identifier, requestHash: hash, routeHash: hash, sourceHash: hash,
  sourceWatermark: count, sourceStart: count.optional(), sourceEnd: count.optional(),
  strategyHash: hash.optional(), recoveryRouteHash: hash.optional(),
  recoveryForIds: z.array(identifier).max(MAX_RECOVERY_ORIGINS).optional(), grantedAt: count, expiresAt: count,
  riskAcceptedOriginIds: z.array(identifier).max(MAX_RECOVERY_ORIGINS).optional(),
}).strict()
export type GrantRow = z.infer<typeof grantSchema>
export interface RecoveryOriginRef {
  operationId?: string
  legacyCycle?: number
  requestHash: string
  routeHash: string
  strategyHash?: string
  sourceHash: string
  sourceWatermark: number
  sourceStart?: number
  sourceEnd?: number
}
export interface SourceAncestorProof {
  operationId: string
  sourceHash: string
  sourceWatermark: number
  prefixHash: string
  currentSourceHash: string
  currentSourceWatermark: number
  sourceStart: number
  sourceEnd: number
}
export interface RecoverySelection extends RecoveryOriginRef {
  recoveryRouteHash: string
  additionalOrigins?: RecoveryOriginRef[]
  riskAcceptedOriginIds?: string[]
  authorizationRequestHash?: string
  authorizationRouteHash?: string
}
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
const legacyKey = (row: Pick<ClaimRecord, 'cycle' | 'requestHash'>) => `legacy:${row.cycle}:${row.requestHash}`
const originKey = (origin: RecoveryOriginRef) => origin.operationId ?? (origin.legacyCycle === undefined
  ? undefined : `legacy:${origin.legacyCycle}:${origin.requestHash}`)
const hasCommittedRiskAcceptance = (rows: readonly OperationRow[], key: string) => rows.some(row =>
  row.phase === 'committed' && row.riskAcceptedOriginIds?.includes(key))
const recoveryOrigins = (selection: RecoverySelection): RecoveryOriginRef[] => {
  const { recoveryRouteHash: _route, additionalOrigins = [], riskAcceptedOriginIds: _risk,
    authorizationRequestHash: _request, authorizationRouteHash: _authorizationRoute, ...primary } = selection
  return [primary, ...additionalOrigins]
}
function unresolved(row: OperationRow): boolean {
  if (row.phase === 'committed' || row.phase === 'not_dispatched') return false
  if (row.phase === 'known_failed_unapplied' || row.phase === 'generated_uncommitted') return row.usageComplete !== true
  if (row.phase === 'unknown_interrupted' && row.physicalEnded === true && row.usageComplete === true) return false
  return true
}
function planCovers(input: PermitInput, row: Pick<OperationRow, 'sourceStart' | 'sourceEnd'>): boolean {
  if (row.sourceStart === undefined || row.sourceEnd === undefined) return true
  return input.sourceStart !== undefined && input.sourceEnd !== undefined
    && input.sourceStart <= row.sourceStart && input.sourceEnd >= row.sourceEnd
}
function verifiedAncestor(input: PermitInput, row: OperationRow): boolean {
  if (row.sourceStart === undefined || row.sourceEnd === undefined) return false
  const proof = input.sourceAncestors?.find(candidate => candidate.operationId === row.operationId)
  return proof !== undefined && proof.sourceHash === row.sourceHash
    && proof.sourceWatermark === row.sourceWatermark && proof.prefixHash === row.sourceHash
    && proof.currentSourceHash === input.sourceHash && proof.currentSourceWatermark === input.sourceWatermark
    && proof.sourceStart === row.sourceStart && proof.sourceEnd === row.sourceEnd
    && planCovers(input, row)
}
function sourceMatchesOrigin(input: PermitInput, row: OperationRow): boolean {
  const exact = row.sourceHash === input.sourceHash && row.sourceWatermark === input.sourceWatermark
  return planCovers(input, row) && (exact || verifiedAncestor(input, row))
}
function refuse(message: string, code?: string): never { throw new OperationStateError(message, code) }
export interface PermitInput {
  sessionId: string; requestHash: string; routeHash: string; sourceHash: string; sourceWatermark: number
  /** Start of the exact selected source range; used only to prove legacy coverage. */
  sourceStart?: number
  /** End of the exact selected source range. */
  sourceEnd?: number
  /** Prefix hashes recomputed from the current immutable original-event chain. */
  sourceAncestors?: readonly SourceAncestorProof[]
  /** Route the one explicitly confirmed compact recovery would use. */
  recoveryRouteHash?: string
  strategyHash?: string
  /** Original failed permit authorizing one deterministic changed-strategy recovery. */
  recoveryFrom?: RecoverySelection
  freshTokens: number; minNewTokens: number; purpose: OperationRow['purpose']; trigger: OperationRow['trigger']
  compactionId: string; legacy: readonly ClaimRecord[]; unboundManual: boolean
  confirmation?: {hash:string;model:string;deadline:string;estimatedInput:number}
}
export interface RecoveryStatus { available: boolean; message: string; requestHash?: string; authorizationToken?: string; originCount?: number; riskAcceptanceRequired?: boolean }

function recoveryAuthorizationToken(input: PermitInput, target: RecoverySelection): string {
  const origins = recoveryOrigins(target).map(origin => [originKey(origin), origin.requestHash, origin.routeHash,
    origin.strategyHash ?? '', origin.sourceHash, origin.sourceWatermark, origin.sourceStart ?? '', origin.sourceEnd ?? ''])
  return keyOf('context-recovery-authorization-v1', input.sessionId, input.requestHash, input.routeHash,
    input.sourceHash, String(input.sourceWatermark), String(input.sourceStart ?? ''), String(input.sourceEnd ?? ''),
    input.strategyHash ?? '', input.purpose, input.trigger, target.recoveryRouteHash,
    JSON.stringify(origins), JSON.stringify([...(target.riskAcceptedOriginIds ?? [])].sort()),
    target.authorizationRequestHash ?? '', target.authorizationRouteHash ?? '')
}

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
      await this.emergencyDomain.table('runs').put(key,{sessionId,compactionId,version:CONTEXT_MANAGER_VERSION,startedAt:Date.now(),...limits,dispatched:0})})
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
  /** Exact same-source risks one user-confirmed call can resolve. Never guesses across a changed modern source. */
  recoveryTarget(input: PermitInput): RecoverySelection | undefined {
    const all = this.allRecords(input.sessionId)
    const committedFor = (key: string) => all.some(row => row.phase === 'committed'
      && (row.recoveryFor === key || row.recoveryForIds?.includes(key)))
    // A grant is a one-call authorization tied to this exact source/route and
    // plan. Merely recording its permit, or proving that it was not dispatched,
    // must not turn its risk list into a durable cross-plan waiver.
    const previouslyAccepted = (key: string) => hasCommittedRiskAcceptance(all, key)
    const candidates: RecoveryOriginRef[] = []
    const seen = new Set<string>()
    const riskAcceptedOriginIds = new Set<string>()
    const add = (origin: RecoveryOriginRef) => {
      const key = originKey(origin)
      if (key && !seen.has(key)) { seen.add(key); candidates.push(origin) }
    }
    for (const row of all) {
      if (!unresolved(row) && row.requestHash !== input.requestHash) continue
      if (row.phase === 'committed' || row.phase === 'not_dispatched' || committedFor(row.operationId)
        || previouslyAccepted(row.operationId)) continue
      if (!sourceMatchesOrigin(input, row)) riskAcceptedOriginIds.add(row.operationId)
      add({ operationId: row.operationId, requestHash: row.requestHash, routeHash: row.routeHash,
        ...(row.strategyHash === undefined ? {} : { strategyHash: row.strategyHash }),
        sourceHash: row.sourceHash, sourceWatermark: row.sourceWatermark,
        ...(row.sourceStart === undefined ? {} : { sourceStart: row.sourceStart }),
        ...(row.sourceEnd === undefined ? {} : { sourceEnd: row.sourceEnd }) })
    }
    for (const row of input.legacy) {
      const key = legacyKey(row)
      if (committedFor(key) || previouslyAccepted(key)) continue
      // Legacy permits have no source hash or plan span. Their outcome and
      // source cannot be inferred, even when the watermark happens to match.
      riskAcceptedOriginIds.add(key)
      add({ legacyCycle: row.cycle, requestHash: row.requestHash, routeHash: input.routeHash,
        sourceHash: input.sourceHash, sourceWatermark: row.sourceWatermark })
    }
    const unresolvedKeys = all.filter(unresolved).filter(row => !committedFor(row.operationId)
      && !previouslyAccepted(row.operationId)).map(row => row.operationId)
    const unresolvedLegacyKeys = input.legacy.filter(row => !committedFor(legacyKey(row))
      && !previouslyAccepted(legacyKey(row))).map(legacyKey)
    const candidateKeys = new Set(candidates.map(originKey))
    if ([...unresolvedKeys, ...unresolvedLegacyKeys].some(key => !candidateKeys.has(key))) return undefined
    if (candidates.length === 0 || candidates.length > MAX_RECOVERY_ORIGINS
      || riskAcceptedOriginIds.size > MAX_RECOVERY_ORIGINS) return undefined
    const [primary, ...additionalOrigins] = candidates
    return { ...primary!, recoveryRouteHash: input.recoveryRouteHash ?? input.routeHash,
      ...(additionalOrigins.length ? { additionalOrigins } : {}),
      ...(riskAcceptedOriginIds.size ? { riskAcceptedOriginIds: [...riskAcceptedOriginIds],
        authorizationRequestHash: input.requestHash, authorizationRouteHash: input.routeHash } : {}) }
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
    const recoveryFrom = input.recoveryFrom ?? this.recoveryTarget(input)
    const plan={input:{...input,...(recoveryFrom ? { recoveryFrom } : {}), confirmation:{...input.confirmation}},token:randomUUID(),expiresAt:Date.now()+120000,cycle:cycle.cycle}
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
      for(const key of ['sessionId','sourceHash','sourceWatermark','sourceStart','sourceEnd','requestHash','routeHash'] as const)
        if(plan.input[key]!==input[key]) refuse('原文、计划或模型已改变，请重新预检')
      const recoveryFrom = input.recoveryFrom ?? this.recoveryTarget(input)
      if (JSON.stringify(plan.input.recoveryFrom ?? null) !== JSON.stringify(recoveryFrom ?? null)) refuse('待解决的调用来源已改变，请重新预检')
      const origins = recoveryFrom ? recoveryOrigins(recoveryFrom) : []
      const riskIds = new Set(recoveryFrom?.riskAcceptedOriginIds ?? [])
      const targetIds = origins.map(origin => originKey(origin)!).filter(key => !riskIds.has(key))
      const riskAcceptedOriginIds = [...riskIds]
      const row=operationSchema.parse({operationId:randomUUID(),sessionId:input.sessionId,requestHash:input.requestHash,
        routeHash:input.routeHash,sourceHash:input.sourceHash,sourceWatermark:input.sourceWatermark,
        ...(input.sourceStart === undefined ? {} : { sourceStart: input.sourceStart }),
        ...(input.sourceEnd === undefined ? {} : { sourceEnd: input.sourceEnd }), cycleWatermark:cycle.watermark,
        cycle:cycle.cycle,ordinal:1,purpose:'recovery',trigger:'manual',reissue:false,claimedAt:Date.now(),phase:'recorded',
        compactionId:input.compactionId,authorizationId:token,
        ...(targetIds.length ? { recoveryFor: targetIds[0], recoveryForIds: targetIds } : {}),
        ...(riskAcceptedOriginIds.length ? { riskAcceptedOriginIds } : {})})
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
    let current: { cycle: number; watermark: number; total: number; primary: number; assigned: number } | undefined
    for (const row of rows) {
      const watermark = 'cycleWatermark' in row ? row.cycleWatermark : row.sourceWatermark
      if (!current || row.cycle !== current.cycle) {
        if (row.cycle !== (current?.cycle ?? 0) + 1 || row.ordinal !== 1 || row.purpose === 'repair'
          || (current && watermark <= current.watermark)) refuse('压缩周期顺序不一致，停止收费')
        current = { cycle: row.cycle, watermark, total: 0, primary: 0, assigned: 0 }
      }
      if (row.ordinal !== current.assigned + 1 || current.watermark !== watermark) refuse('压缩周期存在重复或缺口，停止收费')
      current.assigned++
      // A permit that provably never reached the provider releases its budget
      // slot. It stays assigned so ordinals remain continuous, but it is not
      // counted against the 2-primary / 4-total limit.
      if (!('phase' in row) || row.phase !== 'not_dispatched') {
        current.total++
        if (row.purpose !== 'repair') current.primary++
      }
      if (current.total > 4 || current.primary > 2) refuse('压缩周期已超出安全预算，停止收费')
    }
    return current
  }
  private decision(input: PermitInput, allowExactForStatus = false) {
    const all = this.allRecords(input.sessionId)
    const recoveryRefs = input.recoveryFrom ? recoveryOrigins(input.recoveryFrom) : []
    const recoveryKeys = new Set<string>()
    const riskAccepted = new Set(input.recoveryFrom?.riskAcceptedOriginIds ?? [])
    if (input.recoveryFrom) {
      if (recoveryRefs.length === 0 || input.routeHash !== input.recoveryFrom.recoveryRouteHash) {
        refuse('恢复路由或来源清单不符合预定的紧凑策略')
      }
      if ([...riskAccepted].some(key => !recoveryRefs.some(ref => originKey(ref) === key))
        || (riskAccepted.size > 0 && (!input.recoveryFrom.authorizationRequestHash || !input.recoveryFrom.authorizationRouteHash
          || input.sourceStart === undefined || input.sourceEnd === undefined || input.sourceEnd < input.sourceStart))) {
        refuse('历史风险接受缺少当前请求、路由或完整计划范围绑定')
      }
      for (const ref of recoveryRefs) {
        const key = originKey(ref)
        if (!key || recoveryKeys.has(key) || input.requestHash === ref.requestHash
          || (ref.strategyHash !== undefined && (input.strategyHash === undefined || input.strategyHash === ref.strategyHash))
        ) refuse('恢复必须改变策略并绑定不重复的原始来源')
        recoveryKeys.add(key)
        if (ref.operationId) {
          const origin = all.find(row => row.operationId === ref.operationId)
          if (!origin || origin.sessionId !== input.sessionId || origin.requestHash !== ref.requestHash
            || origin.routeHash !== ref.routeHash || origin.sourceHash !== ref.sourceHash
            || origin.sourceWatermark !== ref.sourceWatermark
            || origin.sourceStart !== ref.sourceStart || origin.sourceEnd !== ref.sourceEnd
            || origin.phase === 'committed' || origin.phase === 'not_dispatched') {
            refuse('恢复没有绑定到一个仍可恢复的原始调用')
          }
          if (!sourceMatchesOrigin(input, origin) && !riskAccepted.has(key)) {
            refuse('恢复来源无法证明与旧调用相同或包含旧来源前缀及压缩范围；须由用户明确接受历史费用未知')
          }
        } else {
          const old = input.legacy.find(row => row.cycle === ref.legacyCycle && row.requestHash === ref.requestHash
            && row.sourceWatermark === ref.sourceWatermark)
          if (!old || (!riskAccepted.has(key) && input.sourceWatermark !== old.sourceWatermark)
            || (riskAccepted.has(key) && ref.sourceHash !== input.sourceHash)) {
            refuse('旧调用缺少来源哈希；须由用户明确接受历史费用未知并绑定当前原文')
          }
        }
        if (all.some(row => row.phase === 'committed'
          && (row.recoveryFor === key || row.recoveryForIds?.includes(key)))) refuse('该原始调用已由成功恢复解决')
        if (hasCommittedRiskAcceptance(all, key)) refuse('该历史风险已明确接受，不重复授权')
      }
    }
    const previous = this.cycle(input.sessionId, input.legacy)
    if (previous && input.sourceWatermark < previous.watermark) refuse('压缩来源早于当前周期，停止收费')
    const same = all.filter(row => row.requestHash === input.requestHash)
    const legacySame = input.legacy.some(row => row.requestHash === input.requestHash)
    if (same.some(row => row.phase === 'committed' || all.some(other => other.compactionId === row.compactionId && other.phase === 'committed'))) refuse('相同摘要已经提交，不重复收费')
    const exact = (row: OperationRow) => row.sourceHash === input.sourceHash && row.routeHash === input.routeHash
      && row.sourceWatermark === input.sourceWatermark
    // Report changed provenance before the broader unresolved-cost gate.
    const provenanceSensitive = same.filter(row => row.phase !== 'not_dispatched')
    if (!allowExactForStatus && provenanceSensitive.some(row => !exact(row))) refuse('旧调用的来源或模型路由已改变，不能自动重发或沿用授权')
    // Exact retries never open a new cycle, even if a newly numbered checkpoint exists.
    const newCycle = !input.recoveryFrom && (!previous || (!legacySame && same.length === 0 && input.purpose !== 'repair'
      && input.sourceWatermark > previous.watermark && input.freshTokens >= input.minNewTokens)
    )
    if (!previous && input.purpose === 'repair') refuse('格式修复不能单独开启周期')
    if (!newCycle && previous && (previous.total >= 4 || (input.purpose !== 'repair' && previous.primary >= 2))) {
      refuse(`本批历史已达到 2 个主摘要 / 4 次总调用上限（已用主摘要 ${previous.primary}/2、总调用 ${previous.total}/4）；这是调用额度阻断，本次未调用摘要模型；修改时限不返还未知调用额度，任务原文保留`, 'budget_exhausted')
    }
    const hasCommittedRecovery = (row: OperationRow) => all.some(candidate => candidate.phase === 'committed'
      && (candidate.recoveryFor === row.operationId || candidate.recoveryForIds?.includes(row.operationId)))
    const hasAcceptedRisk = (key: string) => hasCommittedRiskAcceptance(all, key)
    const globallyUnresolved = all.filter(row => unresolved(row) && !hasCommittedRecovery(row) && !hasAcceptedRisk(row.operationId))
    const hasCommittedLegacyRecovery = (row: ClaimRecord) => all.some(candidate => candidate.phase === 'committed'
      && (candidate.recoveryFor === legacyKey(row) || candidate.recoveryForIds?.includes(legacyKey(row))))
    const globallyUnresolvedLegacy = input.legacy.filter(row => !hasCommittedLegacyRecovery(row) && !hasAcceptedRisk(legacyKey(row)))
    if (input.recoveryFrom) {
      if (globallyUnresolved.some(row => !recoveryKeys.has(row.operationId))
        || globallyUnresolvedLegacy.some(row => !recoveryKeys.has(legacyKey(row)))) {
        refuse('存在本次来源范围未覆盖的跨周期未知调用，不能用一次恢复清除')
      }
    } else if ((globallyUnresolved.length > 0 || globallyUnresolvedLegacy.length > 0) && !allowExactForStatus) {
      refuse(input.unboundManual
        ? '旧手动调用预算需要核验，不能授权或派发新收费'
        : '存在跨周期尚未解决的摘要调用和未知费用风险；新增输入、来源水位或新周期不能绕过阻断，恢复必须改变摘要策略并明确授权')
    }
    // A known-unapplied call with incomplete usage blocks any new attempt
    // until authorization. With complete usage it may be replaced by a
    // verified different request, but the same requestHash still requires an
    // explicit grant: the same large history is never silently re-dispatched.
    const sameRequiresGrant = same.some(row => row.phase !== 'not_dispatched' && row.phase !== 'committed')
    if (sameRequiresGrant && !input.recoveryFrom && !allowExactForStatus) refuse('恢复必须改变摘要策略；相同请求不得重新派发')
    // Changing request text or model cannot silently escape an unresolved primary.
    const pending = !newCycle && input.purpose !== 'repair' && all.some(row => row.cycle === previous?.cycle
      && unresolved(row) && !hasCommittedRecovery(row) && !hasAcceptedRisk(row.operationId))
    const legacyPending = !newCycle && input.purpose !== 'repair' && input.legacy.some(row => row.cycle === previous?.cycle
      && !hasCommittedLegacyRecovery(row) && !hasAcceptedRisk(legacyKey(row)))
    const unknown = input.recoveryFrom !== undefined || globallyUnresolved.length > 0 || globallyUnresolvedLegacy.length > 0
      || legacySame || legacyPending || sameRequiresGrant || pending
    const reissue = input.recoveryFrom !== undefined || same.length > 0 || legacySame
    if (same.some(row => row.reissue || row.authorizationId)) refuse('相同请求已恢复过一次，停止重复收费')
    return { cycle: newCycle ? (previous?.cycle ?? 0) + 1 : previous!.cycle,
      cycleWatermark: newCycle ? input.sourceWatermark : previous!.watermark,
      ordinal: newCycle ? 1 : previous!.assigned + 1, unknown, reissue }
  }
  private matchingGrant(input: PermitInput): GrantRow | undefined {
    const consumed = new Set(this.allRecords(input.sessionId).map(row => row.authorizationId).filter((value): value is string => value !== undefined))
    const authorized = input.recoveryFrom ? recoveryOrigins(input.recoveryFrom)[0]! : input
    const selectedKeys = input.recoveryFrom ? recoveryOrigins(input.recoveryFrom).map(originKey).sort() : undefined
    const riskAccepted = [...(input.recoveryFrom?.riskAcceptedOriginIds ?? [])].sort()
    const requestHash = riskAccepted.length
      ? input.recoveryFrom?.authorizationRequestHash : authorized.requestHash
    const routeHash = riskAccepted.length
      ? input.recoveryFrom?.authorizationRouteHash : authorized.routeHash
    return [...this.grants.entries()].map(([, row]) => row).find(row => row.sessionId === input.sessionId
      && row.requestHash === requestHash && row.routeHash === routeHash && row.sourceHash === input.sourceHash
      && (authorized.strategyHash === undefined || row.strategyHash === authorized.strategyHash)
      && row.sourceWatermark === input.sourceWatermark
      && row.sourceStart === input.sourceStart && row.sourceEnd === input.sourceEnd
      && (!input.recoveryFrom || row.recoveryRouteHash === input.recoveryFrom.recoveryRouteHash
        && JSON.stringify([...(row.recoveryForIds ?? [])].sort()) === JSON.stringify(selectedKeys)
        && JSON.stringify([...(row.riskAcceptedOriginIds ?? [])].sort()) === JSON.stringify(riskAccepted))
      && row.expiresAt > Date.now() && !consumed.has(row.authorizationId))
  }
  /** One serialized durable put is the only permission to dispatch. A crash consumes it. */
  async claim(input: PermitInput): Promise<OperationRow> {
    return this.enqueue(async () => {
      let decision: ReturnType<SummaryOperations['decision']>
      try { decision = this.decision(input) } catch (error) {
        this.rememberBlocked(input)
        throw error
      }
      const grant = decision.unknown ? this.matchingGrant(input) : undefined
      if (decision.unknown && (!grant || input.unboundManual)) {
        this.rememberBlocked(input)
        refuse(input.unboundManual ? '旧手动调用无法精确绑定预算，需要先核验，未授权新收费'
          : '上次调用结果未知，不自动再次收费；可在上下文面板明确授权一次恢复')
      }
      const row = operationSchema.parse({ operationId: randomUUID(), sessionId: input.sessionId,
        requestHash: input.requestHash, routeHash: input.routeHash, sourceHash: input.sourceHash,
        ...(input.strategyHash === undefined ? {} : { strategyHash: input.strategyHash }),
        sourceWatermark: input.sourceWatermark,
        ...(input.sourceStart === undefined ? {} : { sourceStart: input.sourceStart }),
        ...(input.sourceEnd === undefined ? {} : { sourceEnd: input.sourceEnd }),
        cycleWatermark: decision.cycleWatermark, cycle: decision.cycle,
        ordinal: decision.ordinal, purpose: input.purpose, trigger: input.trigger, reissue: decision.reissue,
        compactionId: input.compactionId, claimedAt: Date.now(), phase: 'recorded',
        ...(grant ? { authorizationId: grant.authorizationId } : {}),
        ...(input.recoveryFrom ? (() => {
          const origins = recoveryOrigins(input.recoveryFrom!)
          const riskIds = new Set(input.recoveryFrom!.riskAcceptedOriginIds ?? [])
          const linked = origins.map(originKey).filter((key): key is string => key !== undefined && !riskIds.has(key))
          return { ...(linked.length ? { recoveryFor: linked[0], recoveryForIds: linked } : {}),
            ...(riskIds.size ? { riskAcceptedOriginIds: [...riskIds] } : {}) }
        })() : {}) })
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
        const all = this.allRecords(sessionId)
        const committedFor = (key: string) => all.some(row => row.phase === 'committed'
          && (row.recoveryFor === key || row.recoveryForIds?.includes(key)))
        const previouslyAccepted = (key: string) => hasCommittedRiskAcceptance(all, key)
        const unresolvedOperations = all.some(row => unresolved(row) && !committedFor(row.operationId) && !previouslyAccepted(row.operationId))
        const unresolvedLegacy = legacy.some(row => !committedFor(legacyKey(row)) && !previouslyAccepted(legacyKey(row)))
        if (unresolvedOperations || unresolvedLegacy) {
          return { available: false, message: '旧压缩调用记录仍待核验；当前没有已绑定的恢复计划，未授权新收费。' }
        }
      } catch { return { available: false, message: '压缩调用记录无法核验，停止收费' } }
      return { available: false, message: '' }
    }
    try {
      // Status describes the recovery the user can authorize now, not an older
      // one-origin selection captured by a previous failed recovery attempt.
      const statusInput = { ...input, recoveryFrom: undefined }
      const decision = this.decision(statusInput, true)
      if (!decision.unknown || input.unboundManual) return { available: false, message: '旧调用预算需要核验，不能授权新收费' }
      const target = this.recoveryTarget(statusInput)
      if (!target) {
        const all = this.allRecords(sessionId)
        const committedFor = (key: string) => all.some(row => row.phase === 'committed'
          && (row.recoveryFor === key || row.recoveryForIds?.includes(key)))
        const unresolvedCount = all.filter(row => unresolved(row) && !committedFor(row.operationId)
          && !hasCommittedRiskAcceptance(all, row.operationId)).length
          + statusInput.legacy.filter(row => !committedFor(legacyKey(row))
            && !hasCommittedRiskAcceptance(all, legacyKey(row))).length
        if (unresolvedCount > MAX_RECOVERY_ORIGINS) {
          return { available: false, originCount: unresolvedCount,
            message: `当前有 ${unresolvedCount} 笔未决来源，超过单次受限迁移上限 ${MAX_RECOVERY_ORIGINS}；没有授权新调用，也未清除任何历史记录。请先通过明确、可审计的本地迁移分组整理来源。` }
        }
        return { available: false, message: '当前压缩范围无法精确覆盖所有未决调用；保留原文与费用记录，未提供恢复授权。' }
      }
      if (this.matchingGrant({ ...statusInput, recoveryFrom: target })) return { available: false, message: '一次恢复授权已保存；有效期两分钟，来源和模型必须保持一致' }
      const keys = new Set(recoveryOrigins(target).map(originKey))
      const prior = this.allRecords(sessionId).filter(row => keys.has(row.operationId) && row.phase !== 'not_dispatched').at(-1)
      const riskCount = target.riskAcceptedOriginIds?.length ?? 0
      const cost = riskCount > 0
        ? `有 ${riskCount} 笔历史来源或结果无法核验；授权即记录接受其费用未知，不标记旧调用成功，也不清除旧记录。`
        : prior?.usageComplete === true ? '已观察的调用用量完整' : '至少一笔调用费用仍未知'
      return { available: true, requestHash: input.requestHash, authorizationToken: recoveryAuthorizationToken(statusInput, target),
        originCount: keys.size,
        ...(riskCount > 0 ? { riskAcceptanceRequired: true } : {}),
        message: riskCount > 0
          ? `${cost}仅按当前完整原文和计划执行一次更紧凑调用；本次仍计入 2/4 额度。`
          : `${cost}；授权后仅执行一次更紧凑策略（输出上限降至原请求的 75%，最低 256 Token），并在该次成功提交后关联解决 ${keys.size} 笔同源未决记录；历史费用不清除。` }
    } catch (error) { return { available: false, message: error instanceof Error ? error.message : '调用记录无法核验' } }
  }
  /** Explicit UI mutation, bound to the currently blocked request; never called by a tool. */
  async grant(sessionId: string, authorizationToken: string): Promise<void> {
    return this.enqueue(async () => {
      const input = this.blocked.get(sessionId)
      const status = input ? this.recoveryStatus(sessionId, input.legacy) : undefined
      if (!input || !status?.available || status.authorizationToken !== authorizationToken) refuse('恢复条件已改变，请重新检查上下文状态')
      const target = this.recoveryTarget(input)
      if (!target) refuse('恢复来源范围已改变，不能保存授权')
      const now = Date.now()
      const authorized = recoveryOrigins(target)[0]!
      const riskAcceptedOriginIds = [...(target.riskAcceptedOriginIds ?? [])].sort()
      const row = grantSchema.parse({ authorizationId: randomUUID(), sessionId,
        requestHash: riskAcceptedOriginIds.length ? target.authorizationRequestHash : authorized.requestHash,
        routeHash: riskAcceptedOriginIds.length ? target.authorizationRouteHash : authorized.routeHash,
        sourceHash: input.sourceHash, sourceWatermark: input.sourceWatermark,
        ...(input.sourceStart === undefined ? {} : { sourceStart: input.sourceStart }),
        ...(input.sourceEnd === undefined ? {} : { sourceEnd: input.sourceEnd }),
        ...(authorized.strategyHash === undefined ? {} : { strategyHash: authorized.strategyHash }),
        recoveryRouteHash: target.recoveryRouteHash, recoveryForIds: recoveryOrigins(target).map(originKey),
        ...(riskAcceptedOriginIds.length ? { riskAcceptedOriginIds } : {}),
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
    extra: { reasonCode?: string; usageComplete?: boolean; physicalEnded?: boolean } = {}): Promise<void> {
    return this.enqueue(async () => {
      const row = this.requireRow(sessionId, id)
      if (row.phase !== 'recorded') return // Phase is immutable; late physical/usage proof has its own monotonic writer.
      const usageComplete = row.usageComplete === true || extra.usageComplete === true ? true : extra.usageComplete ?? row.usageComplete
      await this.write(operationSchema.parse({ ...row, ...extra,
        ...(row.physicalEnded === true || extra.physicalEnded === true ? { physicalEnded: true } : {}),
        ...(usageComplete === undefined ? {} : { usageComplete }),
        phase, settledAt: Date.now() }))
      const input = this.inputs.get(id)
      // Every known-unapplied failure stays visibly blocked: it may still have
      // been billed, and the same request is never re-dispatched silently.
      const needsAuthorization = ['unknown_interrupted', 'generated_uncommitted', 'known_failed_unapplied'].includes(phase)
      if (input && needsAuthorization) this.blocked.set(sessionId, input)
      this.inputs.delete(id)
    })
  }
  /** Add only monotonic proof delivered by the physical stream/usage ledger; never rewrite the original phase. */
  async recordPhysicalProof(sessionId: string, id: string, usageComplete: boolean): Promise<void> {
    return this.enqueue(async () => {
      const row = this.requireRow(sessionId, id)
      const next = operationSchema.parse({ ...row, physicalEnded: true,
        ...(usageComplete || row.usageComplete === true ? { usageComplete: true } : {}) })
      if (next.physicalEnded === row.physicalEnded && next.usageComplete === row.usageComplete) return
      await this.write(next)
    })
  }
  private requireRow(sessionId: string, id: string): OperationRow {
    const row = this.rows.get(id) ?? [...this.emergencyRows.values()].find(v=>v.operation.operationId===id)?.operation
    if (!row || row.sessionId !== sessionId) refuse('压缩调用身份不匹配')
    return row
  }
  private rememberBlocked(input: PermitInput): void {
    // Bind the visible action to the latest denied request. Any prior recovery
    // selection is stale and must be recomputed against this exact source.
    this.blocked.set(input.sessionId, { ...input, recoveryFrom: undefined,
      legacy: input.legacy.map(row => ({ ...row })),
      ...(input.sourceAncestors === undefined ? {} : { sourceAncestors: input.sourceAncestors.map(row => ({ ...row })) }) })
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
