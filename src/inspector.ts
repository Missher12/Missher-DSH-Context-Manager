import type { Context } from '@deepseek-ai/cordis'
import { SessionId } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-session-query'
import type { SessionObservation } from '@deepseek-ai/dsh-session-query'
import type {} from '@deepseek-ai/dsh-token-meter/client'
import { Remote, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import { indexContext, MAX_EVENTS } from './inspector-fold.ts'
import { inspectQuerySchema, contentQuerySchema } from './inspector-wire.ts'
import type { InspectQuery, Inspection, ContentQuery, ContentPage } from './inspector-types.ts'

declare module '@deepseek-ai/cordis' { interface Context { contextInspector: ContextInspector } }

/** Read-only observations; no Agent activation, persistence writes, or model calls. */
export class ContextInspector extends TypertRemoteService {
  static inject = ['sessionQuery', 'sessions']
  private readonly lifetime = new AbortController()
  constructor(ctx: Context) {
    super(ctx, 'contextInspector')
    ctx.effect(() => () => this.lifetime.abort())
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
      const needle = query.search.trim().toLocaleLowerCase()
      const matched = index.indexed.map(item => item.row).filter(row => (query.archived || row.current)
        && (query.category === 'all' || row.category === query.category)
        && (!needle || `${row.title} ${row.source}`.toLocaleLowerCase().includes(needle)))
      matched.sort(query.sort === 'size' ? (a, b) => b.tokens - a.tokens || b.seq - a.seq || a.id.localeCompare(b.id) : (a, b) => a.seq - b.seq || a.id.localeCompare(b.id))
      const config = index.header?.config
      return { sessionId: query.sessionId, cursor: observation.cursor, cutSeq: cut, sampledAt: Date.now(), historical: query.atSeq !== null,
        pressure: query.atSeq === null && typeof pressure?.projectedTokens === 'number' && typeof pressure.pressureTokens === 'number' ? { projected: pressure.projectedTokens, input: pressure.pressureTokens, window: pressure.contextWindow ?? null } : null,
        official: query.atSeq === null && official ? { system: official.systemTokens, tools: official.toolsTokens, messages: official.messageTokens } : null,
        usage: query.atSeq === null && usage ? { input: usage.uncachedInputTokens + usage.cacheReadTokens + usage.cacheWriteTokens, output: usage.outputTokens, cacheRead: usage.cacheReadTokens } : null,
        model: config ? { provider: config.provider, model: config.model, effort: config.reasoningEffort === undefined ? null : String(config.reasoningEffort), maxTokens: typeof config.maxTokens === 'number' && Number.isFinite(config.maxTokens) && config.maxTokens >= 0 ? config.maxTokens : null } : null,
        parts: index.parts, rows: matched.slice(query.offset, query.offset + 50), total: matched.length, offset: query.offset, pageSize: 50,
        activeCount: index.indexed.filter(item => item.row.current).length, archivedCount: index.indexed.filter(item => !item.row.current).length,
        requests: index.requests, requestCount: index.requestCount, compactions: index.diagnostics.compactions }
    })
  }
  @Remote('content')
  async content(input: ContentQuery, signal: AbortSignal): Promise<ContentPage> {
    const query = contentQuerySchema().parse(input)
    return this.read(query.sessionId, query.cutSeq, signal, 'none', (_observation, cut, index) => {
      const item = index.indexed.find(item => item.row.id === query.id)
      if (!item) throw new Error('该条目不属于这个会话截面，请重新选择。')
      const text = item.body()
      if (query.offset > text.length) throw new Error('内容位置已失效，请重新选择条目。')
      let end = Math.min(query.offset + 16000, text.length)
      // Keep a UTF-16 surrogate pair on the same page.
      if (end < text.length && /[\uD800-\uDBFF]/u.test(text[end - 1]!)) end--
      return { sessionId: query.sessionId, cutSeq: cut, id: query.id, text: text.slice(query.offset, end), offset: query.offset, totalChars: text.length, nextOffset: end < text.length ? end : null }
    })
  }
}
export default ContextInspector
