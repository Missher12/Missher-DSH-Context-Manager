/**
 * Context-owned compaction transaction using the public Session event protocol.
 * Protocol validation and checkpoint framing adapted from DeepSeek Harness
 * compaction-basic (Copyright DeepSeek, MIT; see THIRD_PARTY_NOTICES.md).
 * The plugin owns the final cancellation check; no patched Basic class is required.
 */
import { randomUUID } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import { CompactionId, ManualCompactionError, compactCheckpointSource, toolPairingBalancedBefore, toolPairingBalancedAfter } from '@deepseek-ai/dsh-compaction'
import type { CompactionResult } from '@deepseek-ai/dsh-compaction'
import { createUserMessage, errorChain } from '@deepseek-ai/dsh-llm'
import type { ContentBlock, Message, TokenUsage, ToolSchema } from '@deepseek-ai/dsh-llm'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { Session, SessionSeq } from '@deepseek-ai/dsh-session'
import type { TokenMeter, TokenMeasurement } from '@deepseek-ai/dsh-token-meter'

export interface SummaryInput { readonly messages: readonly Message[]; readonly tools?: readonly ToolSchema[] }
interface SummaryResult {
  summary: ContentBlock[]; rawOutput: ContentBlock[]; llmStreamCall: true
  provider: string; model: string; maxTokens?: number; usage?: TokenUsage
}
type Command = NonNullable<CompactionResult['sourceCommandId']>
interface Dependencies {
  meter: TokenMeter
  validateCandidate?(agent: Agent, start: SessionSeq, end: SessionSeq, checkpoint: Message, before: TokenMeasurement): void
  refreshAfterRecovery?(agent: Agent, start: SessionSeq, end: SessionSeq, signal: AbortSignal): Promise<void>
  summarize(input: SummaryInput, agent: Agent, signal: AbortSignal): Promise<SummaryResult>
  recover(error: unknown, agent: Agent, seqs: readonly SessionSeq[], signal: AbortSignal): boolean
}
interface Options {
  idle: boolean
  sourceCommandId?: Command
  flush?: () => Promise<void>
}
class SurfaceChangedError extends Error {}

const PREAMBLE = 'This is an automatically generated checkpoint condensing an earlier span of the conversation to free up context. Treat the captured context as established background and build on it without restating it. Continue the task directly from the messages that follow, without acknowledging this checkpoint.'

function selection(session: Session, start: SessionSeq, end: SessionSeq) {
  const nodes = session.surface.nodes, first = nodes.indexOf(start), last = nodes.indexOf(end)
  if (first < 0 || last < first) throw new SurfaceChangedError('压缩选区已经改变，原文保留')
  if (session.eventAt(start)?.type === 'system/message') throw new Error('不能压缩系统消息')
  if (!toolPairingBalancedBefore(session, start) || !toolPairingBalancedAfter(session, end)) {
    throw new SurfaceChangedError('压缩选区会拆开工具调用与结果，原文保留')
  }
  return { start, end, first, last, seqs: nodes.slice(first, last + 1) }
}

function entryOwner(session: Session, idle: boolean): number | null {
  const events = session.snapshotEvents()
  const boundary = events.findLast(e => e.type === 'session/end-seed')?.seq ?? -1
  const bracket = events.findLast(e => e.type === 'compaction/start' || e.type === 'compaction/end')
  if (bracket?.type === 'compaction/start' && bracket.seq > boundary) {
    throw new ManualCompactionError('busy', '已有未收尾的压缩事务，原文保留')
  }
  const turn = events.findLast(e => e.type === 'turn/start' || e.type === 'turn/end')
  const owner = turn?.type === 'turn/start' ? turn.data.turn : null
  if (idle && owner !== null) throw new ManualCompactionError('busy', '任务正在执行，不能进行闲置压缩')
  if (!idle && owner === null) throw new Error('请求前压缩必须由当前任务持有')
  return owner
}

function prepare(deps: Dependencies, session: Session, start: SessionSeq, end: SessionSeq) {
  const span = selection(session, start, end), measurement = deps.meter.measure(session)
  const priced = measurement.nodes.slice(span.first, span.last + 1)
  if (!isDeepStrictEqual(priced.map(n => n.seq), span.seqs)) throw new SurfaceChangedError('上下文计量与压缩选区不一致')
  const head = session.eventAt(session.surface.nodes[0]!)
  const system = head?.type === 'system/message' ? session.deriveEventMessage(head) : null
  const messages = span.seqs.map(seq => session.deriveEventMessage(session.eventAt(seq)!)).filter((m): m is Message => m !== null)
  const tools = session.requestHeader()?.tools
  return { ...span, measurement, priced,
    shadowedTokenCount: priced.reduce((n, row) => n + row.heuristicTokens, 0),
    routeTokens: priced.reduce((n, row) => n + row.tokens, 0),
    input: { messages: system === null ? messages : [system, ...messages], ...(tools === undefined ? {} : { tools }) },
  }
}

/** Shared read-only input preparation for an explicit no-model rescue preview. */
export function prepareContextInput(deps: Dependencies, agent: Agent, start: SessionSeq, end: SessionSeq) {
  return prepare(deps, agent.session, start, end).input
}

function stable(deps: Dependencies, session: Session, prepared: ReturnType<typeof prepare>, idle: boolean) {
  const span = selection(session, prepared.start, prepared.end), current = deps.meter.measure(session)
  if (current.totalTokens !== prepared.measurement.totalTokens || !isDeepStrictEqual(span.seqs, prepared.seqs) || !isDeepStrictEqual(
    idle ? current.nodes.slice(span.first, span.last + 1) : current.nodes,
    idle ? prepared.priced : prepared.measurement.nodes,
  )) throw new SurfaceChangedError('生成摘要期间上下文发生变化，旧摘要未应用')
}

/** No await is permitted between the final signal check and the complete replacement bracket. */
export async function compactContextRegion(
  deps: Dependencies, agent: Agent, start: SessionSeq, end: SessionSeq, options: Options, signal: AbortSignal,
): Promise<CompactionResult> {
  signal.throwIfAborted()
  const session = agent.session
  selection(session, start, end)
  const turn = entryOwner(session, options.idle)
  const lifecycle = { compactionId: CompactionId(randomUUID()), turn,
    ...(options.sourceCommandId === undefined ? {} : { sourceCommandId: options.sourceCommandId }) }
  const opened = session.append('compaction/start', lifecycle)
  let failure: unknown, failed = false, closed = false, closing = false, committing = false
  let result: CompactionResult | undefined
  try {
    let prepared = prepare(deps, session, start, end), summary: SummaryResult
    // Preserve the public summary-error recovery hook, bounded by the caller's
    // timeout. This hook cannot receive an already-cancelled transaction.
    for (;;) {
      signal.throwIfAborted()
      try { summary = await deps.summarize(prepared.input, agent, signal); break }
      catch (error) {
        signal.throwIfAborted()
        stable(deps, session, prepared, options.idle)
        if (!deps.recover(error, agent, prepared.seqs, signal)) throw error
        await deps.refreshAfterRecovery?.(agent, start, end, signal)
        signal.throwIfAborted()
        prepared = prepare(deps, session, start, end)
      }
    }
    signal.throwIfAborted()
    const checkpoint = createUserMessage({ source: compactCheckpointSource(lifecycle.compactionId, options.sourceCommandId),
      content: [{ type: 'text', text: `${PREAMBLE}\n\n<compacted-summary>` }, ...summary.summary, { type: 'text', text: '</compacted-summary>' }] })
    if (deps.meter.estimateMessage(checkpoint) >= prepared.routeTokens) throw new Error('摘要没有缩小所选上下文，原文保留')
    stable(deps, session, prepared, options.idle)
    deps.validateCandidate?.(agent, start, end, checkpoint, prepared.measurement)
    signal.throwIfAborted()
    // Commit linearizes here. Session.append is synchronous; listeners cannot
    // interleave a later async continuation between the three protocol events.
    committing = true
    const summarized = session.append('compaction/summary', {
      compactionId: lifecycle.compactionId,
      ...(options.sourceCommandId === undefined ? {} : { sourceCommandId: options.sourceCommandId }),
      ...summary, shadowedRange: { start, end }, shadowedSeqs: [...prepared.seqs], shadowedTokenCount: prepared.shadowedTokenCount,
    })
    session.append('user/message', checkpoint, { surfaceOp: { op: 'replace', startSeq: start, endSeq: end },
      sourceEventSeqs: [opened.seq, summarized.seq, ...prepared.seqs] })
    closing = true
    const ended = session.append('compaction/end', lifecycle)
    closed = true
    result = { compactionId: lifecycle.compactionId,
      ...(options.sourceCommandId === undefined ? {} : { sourceCommandId: options.sourceCommandId }),
      startSeq: opened.seq, summarySeq: summarized.seq, endSeq: ended.seq, summary: summary.summary,
      shadowedRange: { start, end }, shadowedSeqs: [...prepared.seqs], shadowedTokenCount: prepared.shadowedTokenCount }
  } catch (error) {
    failure = error; failed = true
    if (!closing) {
      closing = true
      try { session.append('compaction/end', { ...lifecycle, error: errorChain(error) }); closed = true }
      catch (closeError) { failure = closeError; committing = true }
    }
  }
  let flushFailure: unknown
  if (closed && options.flush) {
    try { await options.flush() } catch (error) { flushFailure = error }
  }
  if (options.idle) signal.throwIfAborted()
  if (failed) {
    if (!options.idle) throw failure
    throw new ManualCompactionError(committing ? 'commit' : failure instanceof SurfaceChangedError ? 'changed' : 'summary',
      '闲置压缩未完成，原文及事务记录保留', { cause: failure })
  }
  if (flushFailure !== undefined) throw new ManualCompactionError('persistence', '压缩持久化未完成', { cause: flushFailure })
  if (!result) throw new Error('压缩事务缺少完成记录')
  return result
}
