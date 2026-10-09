import type { Context } from '@deepseek-ai/cordis'
import { SessionId, SessionLogOffset } from '@deepseek-ai/dsh-session'
import { isCompactCheckpointSource } from '@deepseek-ai/dsh-compaction/checkpoint'
import type { ProjectionCheckpoint, SessionProjectionRegistry } from '@deepseek-ai/dsh-session-projection'
import type {} from '@deepseek-ai/dsh-session-query'
import type { SessionObservation } from '@deepseek-ai/dsh-session-query'
import type {} from '@deepseek-ai/dsh-token-meter/client'
import type {} from '@deepseek-ai/dsh-token-meter'
import type {} from '@deepseek-ai/dsh-goal'
import { Remote, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import { contextGroups } from './chart-data.ts'
import { pressureHistory } from './pressure-history.ts'
export { pressureHistory } from './pressure-history.ts'
import { indexContext, MAX_EVENTS } from './inspector-fold.ts'
import { attributeSession } from './efficiency.ts'
import { inspectQuerySchema, contentQuerySchema } from './inspector-wire.ts'
import type { InspectQuery, Inspection, ContentQuery, ContentPage, ContextDelta, ContextGrowth, AdmissionReadout, EfficiencyReadout } from './inspector-types.ts'
import type { IdleStatus } from './idle-types.ts'
import type {} from './index.ts'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type ContextEngine from './engine.ts'
import { idleQuerySchema, recoveryGrantSchema, emergencyConfirmSchema } from './inspector-wire.ts'

declare module '@deepseek-ai/cordis' { interface Context { contextInspector: ContextInspector; contextRecovery: ContextRecovery } }

/** Compare at most four exact cuts of the public host projection. It is an
 * approximate occupancy indicator, not provider billing or admission input.
 * An unpriced legacy replacement and any intervening route switch invalidate
 * the post-compaction comparison instead of inventing a comparable baseline.
 */
export function contextGrowth(registry: Pick<SessionProjectionRegistry, 'restore'>, observation: Pick<SessionObservation, 'events' | 'header' | 'inheritedEventCount'>, cut: number, signal: AbortSignal): ContextGrowth {
  let compact = -1; let tool = -1
  let route: string | undefined
  let comparable = false
  for (const event of observation.events) {
    if (event.seq > cut) break
    signal.throwIfAborted()
    if (event.type === 'request/header') {
      const next = JSON.stringify([event.data.header.config.provider, event.data.header.config.model])
      if (next !== route) comparable = false
      route = next
    }
    if (event.type === 'user/message' && typeof event.surfaceOp === 'object' && isCompactCheckpointSource(event.data.source)) {
      compact = event.seq
      const claim = observation.events[event.seq - 1]
      comparable = route !== undefined && claim?.type === 'compaction/summary'
        && claim.data.compactionId === event.data.source.compactionId
        && claim.data.shadowedRange.start === event.surfaceOp.startSeq && claim.data.shadowedRange.end === event.surfaceOp.endSeq
    }
    if (event.type === 'tool/result' && event.surfaceOp === 'append') tool = event.seq
  }
  const cuts = [...new Set([...(compact >= 0 && comparable ? [compact, cut] : []), ...(tool > 0 ? [tool - 1, tool] : [])])].sort((a, b) => a - b)
  const measured = new Map<number, number>()
  let checkpoint: ProjectionCheckpoint = {}; let start = 0
  for (const seq of cuts) {
    signal.throwIfAborted()
    const restored = registry.restore(checkpoint, observation.events.slice(start, seq + 1), SessionLogOffset(start), observation.header, observation.inheritedEventCount)
    checkpoint = restored.checkpoint; start = seq + 1
    const tokens = restored.snapshot.values.contextPressure?.projectedTokens
    if (typeof tokens === 'number' && Number.isSafeInteger(tokens) && tokens >= 0) measured.set(seq, tokens)
  }
  const delta = (fromSeq: number, toSeq: number): ContextDelta | null => {
    const beforeTokens = measured.get(fromSeq); const afterTokens = measured.get(toSeq)
    return beforeTokens === undefined || afterTokens === undefined ? null : { fromSeq, toSeq, beforeTokens, afterTokens, deltaTokens: afterTokens - beforeTokens }
  }
  return { sinceCompaction: comparable ? delta(compact, cut) : null, lastToolResult: delta(tool - 1, tool) }
}

/** Read-only observations; no Agent activation, persistence writes, or model calls. */
export class ContextInspector extends TypertRemoteService {
  static inject = ['sessionQuery', 'sessions', 'contextManager', 'sessionProjections']
  private readonly lifetime = new AbortController()
  constructor(ctx: Context) {
    super(ctx, 'contextInspector')
    ctx.plugin(ContextRecovery)
    ctx.effect(() => () => this.lifetime.abort())
  }
  @Remote('idleStatus')
  async idleStatus(input: { sessionId: string }, signal: AbortSignal): Promise<IdleStatus> {
    signal.throwIfAborted()
    const query = idleQuerySchema().parse(input)
    return this.ctx.contextManager.idleStatus(query.sessionId)
  }
  private admission(sessionId: string, cut: number): AdmissionReadout | undefined {
    // get() reads existing services/sessions only. Never load an Agent, resolve
    // a provider model, or substitute the approximate status projection here.
    const meter = this.ctx.get('tokenMeter')
    if (!meter) return
    const session = this.ctx.sessions.get(SessionId(sessionId))
    if (!session) return
    try {
      const measurement = meter.measure(session)
      if (measurement.logRevision !== cut + 1 || !Number.isSafeInteger(measurement.totalTokens)
        || measurement.totalTokens < 0) return
      const config = session.requestHeader()?.config
      const context = session.requestContext()
      const sameRoute = config !== undefined && context !== undefined
        && context.provider === config.provider && context.model === config.model
      const window = sameRoute ? context.contextWindow : undefined
      const outputReserve = config?.maxTokens
      return { tokens: measurement.totalTokens, logRevision: measurement.logRevision, baseline: measurement.baseline.kind,
        window: typeof window === 'number' && Number.isSafeInteger(window) && window > 0 ? window : null,
        outputReserve: typeof outputReserve === 'number' && Number.isSafeInteger(outputReserve) && outputReserve >= 0 ? outputReserve : null }
    } catch {
      // Missing route pricing or a disappearing live session makes admission
      // unknown; the read-only historical/projection view remains available.
      return undefined
    }
  }
  private async read<T>(sessionId: string, atSeq: number | null, signal: AbortSignal, mode: 'all' | 'none', use: (observation: SessionObservation, cut: number, index: ReturnType<typeof indexContext>) => T): Promise<T> {
    const cancel = AbortSignal.any([signal, this.lifetime.signal, AbortSignal.timeout(12000)])
    const observation = await this.ctx.sessionQuery.observeSession(SessionId(sessionId), { signal: cancel, projectionMode: mode })
    try {
      cancel.throwIfAborted()
      const cut = atSeq ?? observation.cursor
      if (cut > observation.cursor) throw new Error('记录版本已失效，请刷新当前会话。')
      if (cut + 1 > MAX_EVENTS) throw new Error(`当前日志超过 ${MAX_EVENTS.toLocaleString()} 条记录的分析上限。`)
      const index = indexContext(observation.events.slice(0, cut + 1), this.ctx.sessions.messageProjections)
      cancel.throwIfAborted()
      return use(observation, cut, index)
    } finally { observation[Symbol.dispose]() }
  }
  @Remote('inspect')
  async inspect(input: InspectQuery, signal: AbortSignal): Promise<Inspection> {
    const query = inspectQuerySchema().parse(input)
    return this.read(query.sessionId, query.atSeq, signal, query.atSeq === null ? 'all' : 'none', (observation, cut, index) => {
      const values = observation.projections?.values
      const pressure = values?.contextPressure
      const official = values?.contextBreakdown
      const usage = values?.tokenUsage
      const goalState = values?.goal
      const admission = query.atSeq === null ? this.admission(query.sessionId, cut) : undefined
      const summary = query.atSeq === null ? this.ctx.contextManager.summaryLedger?.stats(query.sessionId) : undefined
      // The Host projection is authoritative for the current cut only. A
      // historical cut keeps the event-log fold and omits every current
      // ledger/archive figure instead of passing them off as old values.
      const attribution = attributeSession(observation.events.slice(0, cut + 1), {
        ...(query.atSeq !== null || usage === undefined ? {} : { host: { source: 'host-token-usage',
          uncachedInputTokens: usage.uncachedInputTokens, cacheReadTokens: usage.cacheReadTokens,
          cacheWriteTokens: usage.cacheWriteTokens, outputTokens: usage.outputTokens } }),
        ...(summary === undefined ? {} : { summary: { source: 'summary-ledger', input: summary.input, output: summary.output,
          cacheRead: summary.cacheRead, cacheWrite: summary.cacheWrite, attempts: summary.attempts, unknownAttempts: summary.unknownAttempts } }),
        fingerprint: this.ctx.contextManager.snapshot?.().prefixDiagnosticsEnabled ?? true,
      })
      const reductions = query.atSeq === null ? this.ctx.contextManager.reductionReadout?.(query.sessionId) : undefined
      const efficiency: EfficiencyReadout = {
        accounting: attribution.accounting,
        host: attribution.host === undefined ? null : { uncachedInputTokens: attribution.host.uncachedInputTokens,
          cacheReadTokens: attribution.host.cacheReadTokens, cacheWriteTokens: attribution.host.cacheWriteTokens,
          outputTokens: attribution.host.outputTokens },
        mirrored: { settledAttempts: attribution.mirrored.settledAttempts, retries: attribution.mirrored.retries,
          withoutUsage: attribution.mirrored.withoutUsage, uncachedInput: { ...attribution.mirrored.uncachedInput },
          cacheRead: { ...attribution.mirrored.cacheRead }, cacheWrite: { ...attribution.mirrored.cacheWrite },
          output: { ...attribution.mirrored.output }, cacheInclusiveInput: { ...attribution.mirrored.cacheInclusiveInput },
          complete: attribution.mirrored.complete },
        differences: attribution.differences.map(item => ({ field: item.field, host: item.host, mirrored: item.mirrored, delta: item.delta })),
        summaryAndRepair: attribution.summaryAndRepair === undefined ? null : { source: attribution.summaryAndRepair.source,
          input: attribution.summaryAndRepair.input, output: attribution.summaryAndRepair.output,
          cacheRead: attribution.summaryAndRepair.cacheRead ?? null, cacheWrite: attribution.summaryAndRepair.cacheWrite ?? null,
          attempts: attribution.summaryAndRepair.attempts, unknownAttempts: attribution.summaryAndRepair.unknownAttempts,
          purposeSplit: attribution.summaryAndRepair.purposeSplit, note: attribution.summaryAndRepair.note },
        maintenanceSuspects: attribution.maintenanceSuspects,
        cacheHitRatio: attribution.cacheHitRatio,
        requests: attribution.requests.map(item => ({ seq: item.seq, time: item.time, turn: item.turn, step: item.step,
          settledBy: item.settledBy, routeKnown: item.routeKnown, retry: item.retry, provider: item.provider, model: item.model,
          uncachedInput: item.uncachedInput, cacheRead: item.cacheRead, cacheWrite: item.cacheWrite, output: item.output,
          maintenanceSuspect: item.maintenanceSuspect })),
        fingerprint: attribution.fingerprint === null ? null : { ...attribution.fingerprint },
        changes: attribution.changes.map(item => ({ seq: item.seq, time: item.time, changed: [...item.changed], note: item.note })),
      }
      signal.throwIfAborted()
      const triggers = new Map((summary?.recent ?? []).map(attempt => [attempt.compactionId, attempt.trigger]))
      const compactions = index.diagnostics.compactions.map(entry => {
        const trigger = entry.kind === 'compact' ? triggers.get(entry.id) : undefined
        const run=query.atSeq===null?this.ctx.contextManager.summaryOperations?.run(query.sessionId,entry.id):undefined
        const modelCallStatus=run?.endedAt!==undefined?((run.actualDispatched??run.dispatched)===0?'not_dispatched' as const:'dispatched' as const):undefined
        return { ...entry, ...(run?{execution:`Context ${run.version} · 总限${run.totalMs/1000}s/首输出${run.firstOutputMs/1000}s/停滞${run.stallMs/1000}s · 调用准入${run.dispatched}/实际派发${run.actualDispatched??'未知'} · ${run.reasonCode ?? '执行中'}`} : {}), ...(run?.reasonCode==='prepared'?{status:'unapplied' as const,error:'人工急救预检完成，未调用模型'}:{}), ...(trigger===undefined?{}:{trigger}),...(modelCallStatus?{modelCallStatus}:{}) }
      })
      const needle = query.search.trim().toLocaleLowerCase()
      const matched = index.indexed.map(item => item.row).filter(row => (query.archived || row.current)
        && (query.category === 'all' || row.category === query.category)
        && (query.group === undefined || contextGroups.find(group => group.id === query.group)?.categories.some(category => category === row.category))
        && (!needle || `${row.title} ${row.source}`.toLocaleLowerCase().includes(needle)))
      matched.sort(query.sort === 'size' ? (a, b) => b.tokens - a.tokens || b.seq - a.seq || a.id.localeCompare(b.id) : (a, b) => a.seq - b.seq || a.id.localeCompare(b.id))
      const config = index.header?.config
      return { sessionId: query.sessionId, cursor: observation.cursor, cutSeq: cut, sampledAt: Date.now(), historical: query.atSeq !== null,
        pressure: query.atSeq === null && typeof pressure?.projectedTokens === 'number' && typeof pressure.pressureTokens === 'number' ? { projected: pressure.projectedTokens, input: pressure.pressureTokens, window: pressure.contextWindow ?? null } : null,
        ...(admission ? { admission } : {}),
        official: query.atSeq === null && official ? { system: official.systemTokens, tools: official.toolsTokens, messages: official.messageTokens } : null,
        usage: query.atSeq === null && usage ? { input: usage.uncachedInputTokens + usage.cacheReadTokens + usage.cacheWriteTokens, output: usage.outputTokens, cacheRead: usage.cacheReadTokens, uncached: usage.uncachedInputTokens, cacheWrite: usage.cacheWriteTokens } : null,
        ...(summary ? { summaryUsage: { input: summary.input, output: summary.output, attempts: summary.attempts, unknownAttempts: summary.unknownAttempts, since: summary.since } } : {}),
        efficiency,
        ...(reductions === undefined ? {} : { reduction: reductions }),
        ...(query.atSeq === null ? { contextGrowth: contextGrowth(this.ctx.sessionProjections, observation, cut, signal) } : {}),
        model: config ? { provider: config.provider, model: config.model, effort: config.reasoningEffort === undefined ? null : String(config.reasoningEffort), maxTokens: typeof config.maxTokens === 'number' && Number.isFinite(config.maxTokens) && config.maxTokens >= 0 ? config.maxTokens : null } : null,
        ...(query.atSeq === null && goalState ? { goal: { phase: goalState.goal.phase,
          blockedReason: goalState.goal.blockedReason === undefined ? null : { code: goalState.goal.blockedReason.code, message: goalState.goal.blockedReason.message },
          roundsStarted: goalState.roundsStarted, maxGoalRounds: goalState.goal.maxGoalRounds } } : {}),
        pressureHistory: pressureHistory(this.ctx.sessionProjections, observation, cut, signal),
        parts: index.parts, rows: matched.slice(query.offset, query.offset + 50), total: matched.length, offset: query.offset, pageSize: 50,
        activeCount: index.indexed.filter(item => item.row.current).length, archivedCount: index.indexed.filter(item => !item.row.current).length,
        requests: index.requests, requestCount: index.requestCount, compactions }
    })
  }
  @Remote('content')
  async content(input: ContentQuery, signal: AbortSignal): Promise<ContentPage> {
    const query = contentQuerySchema().parse(input)
    return this.read(query.sessionId, query.cutSeq, signal, 'none', (_observation, cut, index) => {
      const item = index.indexed.find(item => item.row.id === query.id)
      if (!item) throw new Error('该条目不属于这个会话截面，请重新选择。')
      const sourceOffset = query.sourceOffset ?? 0
      if (query.sourceOffset !== undefined && item.row.category !== 'summary') throw new Error('只有压缩摘要可以读取来源索引。')
      const bySeq = new Map(index.indexed.filter(entry => entry.row.id.startsWith('event:')).map(entry => [entry.row.seq, entry.row]))
      const sources = item.sourceSeqs?.flatMap(seq => { const row = bySeq.get(seq); return row ? [row] : [] })
      if (sources && sourceOffset > sources.length) throw new Error('来源位置已失效，请重新选择摘要。')
      const text = item.body()
      if (query.offset > text.length) throw new Error('内容位置已失效，请重新选择条目。')
      let end = Math.min(query.offset + 16000, text.length)
      // Keep a UTF-16 surrogate pair on the same page.
      if (end < text.length && /[\uD800-\uDBFF]/u.test(text[end - 1]!)) end--
      return { sessionId: query.sessionId, cutSeq: cut, id: query.id, text: text.slice(query.offset, end), offset: query.offset, totalChars: text.length, nextOffset: end < text.length ? end : null,
        ...(sources ? { sources: { rows: sources.slice(sourceOffset, sourceOffset + 4), offset: sourceOffset, total: sources.length, nextOffset: sourceOffset + 4 < sources.length ? sourceOffset + 4 : null } } : {}) }
    })
  }
}
export default ContextInspector

/** Separate explicit mutation service. Inspector methods remain read only. */
export class ContextRecovery extends TypertRemoteService {
  static inject = ['contextManager', 'typert']
  constructor(ctx: Context) { super(ctx, 'contextRecovery') }
  private async emergencyEngine(sessionId:string,signal:AbortSignal) {
    signal.throwIfAborted()
    // Explicit mutation only. The public Host lookup restores its normal preset
    // and ownership; read-only status never invokes this lookup.
    const agent=this.ctx.get('agents')?.get(SessionId(sessionId)) ?? await this.ctx.typert.lookups.get('agent')?.resolve(SessionId(sessionId)) as Agent | undefined
    signal.throwIfAborted();if(!agent)throw new Error('当前宿主不能恢复该会话，请先打开会话')
    const engine=this.ctx.get('agentPresets')?.serviceFor(agent,'compaction') ?? agent.ctx.get('compaction')
    if(!engine || !('prepareEmergency' in engine) || !('executeEmergency' in engine))throw new Error('当前会话未由支持人工急救的Context接管')
    return {agent,engine:engine as ContextEngine}
  }
  @Remote('prepareEmergency')
  async prepareEmergency(input:{sessionId:string},signal:AbortSignal) {
    const query=idleQuerySchema().parse(input),{agent,engine}=await this.emergencyEngine(query.sessionId,signal)
    return engine.prepareEmergency(agent,signal)
  }
  @Remote('executeEmergency')
  async executeEmergency(input:{sessionId:string;token:string;acceptUnknownCost:true},signal:AbortSignal):Promise<{granted:true}> {
    const query=emergencyConfirmSchema().parse(input),{agent,engine}=await this.emergencyEngine(query.sessionId,signal)
    await engine.executeEmergency(agent,query.token,signal);return {granted:true}
  }
  @Remote('authorizeOnce')
  async authorizeOnce(input: { sessionId: string; requestHash: string }, signal: AbortSignal): Promise<{ granted: true }> {
    signal.throwIfAborted()
    const query = recoveryGrantSchema().parse(input)
    await this.ctx.contextManager.authorizeRecovery(query.sessionId, query.requestHash, signal)
    return { granted: true }
  }
}
