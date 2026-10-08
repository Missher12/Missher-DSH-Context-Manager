import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Context } from '@deepseek-ai/cordis'
import { createMessage, createUserMessage } from '@deepseek-ai/dsh-llm'
import { estimateMessage, estimateToolsTokens } from '@deepseek-ai/dsh-token-meter/estimate'
import Inspector from '../lib/inspector.js'
import { indexContext } from '../lib/inspector-fold.js'
import { TYPERT } from '../lib/typert.js'

const text = value => [{ type: 'text', text: value }]
const user = value => createUserMessage({ content: text(value), source: { kind: 'user' } })
const assistant = value => createMessage({ role: 'assistant', content: text(value), source: { kind: 'model', provider: 'offline', model: 'fixture' } })
function log() {
  const events = []
  const add = (type, data, surfaceOp, sourceEventSeqs) => {
    events.push({ seq: events.length, time: 1000 + events.length, type, data,
      ...(surfaceOp === undefined ? {} : { surfaceOp }), ...(sourceEventSeqs ? { sourceEventSeqs } : {}) })
    return events.length - 1
  }
  add('system/message', { turn: 1, step: 1, message: createMessage({ role: 'system', content: text('system instructions'), source: { kind: 'system-prompt' } }) }, 'append')
  return { events, add }
}
const query = sessionId => ({ sessionId, atSeq: null, offset: 0, category: 'all', search: '', sort: 'size', archived: false })
const resultCodec = method => TYPERT.invocations.find(item => item.method === method).result.create()

test('canonical replay handles reversed positional endpoints and excludes replaced content from totals', () => {
  const { events, add } = log()
  add('user/message', user('old task'), 'append') // 1
  add('assistant/message', { turn: 1, step: 1, message: assistant('old response'), stream: [] }, 'append') // 2
  add('user/message', user('middle'), 'append') // 3
  add('user/message', user('first checkpoint'), { op: 'replace', startSeq: 1, endSeq: 2 }, [1, 2]) // 4 -> [0,4,3]
  add('user/message', user('final checkpoint'), { op: 'replace', startSeq: 4, endSeq: 3 }, [4, 3]) // 5
  add('user/message', user('latest task survives'), 'append')
  const index = indexContext(events)
  assert.deepEqual(index.indexed.filter(item => item.row.current).map(item => item.row.seq), [0, 5, 6])
  assert.equal(index.indexed.filter(item => !item.row.current).length, 4)
  assert.equal(index.parts.reduce((sum, item) => sum + item.tokens, 0),
    estimateMessage(events[0].data.message) + estimateMessage(events[5].data) + estimateMessage(events[6].data))
  assert.equal(index.indexed.find(item => item.row.seq === 1).body(), 'old task')
})

test('registered message projections, explicit skill attribution and tool frame use host accounting', () => {
  const { events, add } = log()
  add('user/message', user('before'), 'append')
  add('fixture/project', { target: 1 }, undefined)
  events.at(-1).ignorable = true
  const tools = [{ name: 'skill', description: 'load skills', parameters: { type: 'object' } }, { name: 'bash', description: 'run', parameters: {} }]
  const header = { config: { provider: 'offline', model: 'fixture', maxTokens: 1024 }, tools }
  add('request/header', { header })
  add('assistant/message', { turn: 1, step: 1, message: { ...assistant(''), content: [{ type: 'tool-call', id: 'skill-1', name: 'skill', arguments: '{}' }] }, stream: [] }, 'append')
  add('tool/result', { turn: 1, step: 1, message: createMessage({ role: 'tool', toolCallId: 'skill-1', content: text('skill body'), source: { kind: 'tool' } }) }, 'append')
  add('user/message', user('<skill>ordinary text is still user content</skill>'), 'append')
  const projection = { type: 'fixture/project', project: () => new Map([[1, user('after projection')]]) }
  const index = indexContext(events, [projection])
  assert.equal(index.indexed.find(item => item.row.seq === 1).body(), 'after projection')
  assert.equal(index.parts.find(item => item.category === 'tools').tokens, estimateToolsTokens(header))
  assert.equal(index.indexed.find(item => item.row.seq === 5).row.category, 'skill')
  assert.equal(index.indexed.find(item => item.row.seq === 6).row.category, 'user')
  assert.equal(index.requests[0].input, null, 'missing usage is unknown, not zero')
})

async function service(events, projections, extra = {}) {
  const ctx = new Context(); const reads = []; let disposals = 0
  // Only capabilities a real Manager also exposes are added; a missing service
  // method stays missing so the panel reports it as unavailable instead of a
  // catch block inventing an empty statistic.
  ctx.provide('contextManager', { idleStatus: () => ({ status: 'waiting', dueAt: null, message: '等待任务完成' }), ...extra.contextManager })
  ctx.provide('sessions', { messageProjections: [] })
  ctx.provide('sessionProjections', { restore: () => ({ snapshot: { values: {} }, checkpoint: {} }) })
  ctx.provide('sessionQuery', { async observeSession(sessionId, options) {
    reads.push({ sessionId, ...options })
    const log = typeof events === 'function' ? events(sessionId) : events
    return { cursor: log.length - 1, events: log, projections: typeof projections === 'function' ? projections(sessionId) : projections,
      [Symbol.dispose]() { disposals++ } }
  } })
  await ctx.plugin(Inspector)
  return { ctx, reads, get disposals() { return disposals } }
}

test('RPC uses exact Session cuts, paginates all entries, keeps historical pressure unknown and releases leases', async () => {
  const { events, add } = log()
  for (let i = 0; i < 65; i++) add('user/message', user(`message-${i}`), 'append')
  const f = await service(events, { values: { contextPressure: { projectedTokens: 500, pressureTokens: 400, contextWindow: 10000 } } })
  try {
    const first = await f.ctx.contextInspector.inspect(query('active-b'), new AbortController().signal)
    assert.equal(first.total, 66); assert.equal(first.rows.length, 50); assert.equal(first.sessionId, 'active-b')
    assert.equal(f.reads[0].sessionId, 'active-b'); assert.equal(f.disposals, 1)
    assert.deepEqual(resultCodec('inspect').parse(first), first)
    const last = await f.ctx.contextInspector.inspect({ ...query('active-b'), offset: 50 }, new AbortController().signal)
    assert.equal(last.rows.length, 16)
    const search = await f.ctx.contextInspector.inspect({ ...query('active-b'), search: 'MESSAGE-64' }, new AbortController().signal)
    assert.equal(search.total, 1)
    const history = await f.ctx.contextInspector.inspect({ ...query('active-b'), atSeq: 2 }, new AbortController().signal)
    assert.equal(history.activeCount, 3); assert.equal(history.pressure, null); assert.equal(history.usage, null)
    assert.equal(f.reads.at(-1).projectionMode, 'none')
    await assert.rejects(f.ctx.contextInspector.content({ sessionId: 'active-b', cutSeq: 2, id: 'event:64', offset: 0 }, new AbortController().signal), /不属于/)
    await assert.rejects(f.ctx.contextInspector.inspect({ ...query('active-b'), atSeq: 1000 }, new AbortController().signal), /版本已失效/)
    const aborted = new AbortController(); aborted.abort()
    await assert.rejects(f.ctx.contextInspector.inspect(query('active-b'), aborted.signal), { name: 'AbortError' })
    assert.equal(f.disposals, f.reads.length)
  } finally { await ctxDispose(f.ctx) }
})
async function ctxDispose(ctx) { await ctx.fiber.dispose() }

test('idle status RPC validates the wire shape without observing or activating a Session', async () => {
  const f = await service([])
  try {
    const status = await f.ctx.contextInspector.idleStatus({ sessionId: 'unloaded' }, new AbortController().signal)
    assert.equal(status.status, 'waiting')
    assert.deepEqual(resultCodec('idleStatus').parse(status), status)
    assert.equal(f.reads.length, 0)
    const abort = new AbortController(); abort.abort()
    await assert.rejects(f.ctx.contextInspector.idleStatus({ sessionId: 'unloaded' }, abort.signal), { name: 'AbortError' })
  } finally { await ctxDispose(f.ctx) }
})

test('large bodies are read in bounded pages without splitting emoji; usage history is bounded separately', async () => {
  const { events, add } = log()
  const body = 'a'.repeat(15999) + '😀' + 'b'.repeat(16001)
  add('user/message', user(body), 'append')
  for (let i = 0; i < 205; i++) add('assistant/message', { turn: i + 1, step: 1, message: assistant(`reply ${i}`), stream: [], usage: { inputTokens: 10, cacheReadTokens: 20, cacheWriteTokens: 5, outputTokens: 4 } }, 'append')
  const f = await service(events)
  try {
    const snapshot = await f.ctx.contextInspector.inspect(query('body'), new AbortController().signal)
    assert.equal(snapshot.requestCount, 205); assert.equal(snapshot.requests.length, 200)
    assert.equal(snapshot.requests[0].input, 35); assert.equal(snapshot.pressure, null)
    let offset = 0; let joined = ''
    do {
      const page = await f.ctx.contextInspector.content({ sessionId: 'body', cutSeq: events.length - 1, id: 'event:1', offset }, new AbortController().signal)
      resultCodec('content').parse(page)
      assert.ok(page.text.length <= 16000)
      assert.ok(!/[\uD800-\uDBFF]$/u.test(page.text))
      joined += page.text; offset = page.nextOffset
    } while (offset !== null)
    assert.equal(joined, body); assert.equal(f.disposals, f.reads.length)
  } finally { await ctxDispose(f.ctx) }
})

test('current summaries are identified by the host checkpoint marker and filtered as their own group', async () => {
  const { events, add } = log()
  add('user/message', user('old task'), 'append')
  add('user/message', createUserMessage({ content: text('retained summary'), source: { kind: 'compact-checkpoint', compactionId: 'fixture-summary' } }), { op: 'replace', startSeq: 1, endSeq: 1 }, [1])
  add('user/message', user('compact-checkpoint is merely text here'), 'append')
  const index = indexContext(events)
  assert.equal(index.indexed.find(item => item.row.seq === 2).row.category, 'summary')
  assert.equal(index.indexed.find(item => item.row.seq === 3).row.category, 'user')
  assert.equal(index.parts.find(part => part.category === 'summary').tokens, estimateMessage(events[2].data))
  const f = await service(events)
  try {
    const result = await f.ctx.contextInspector.inspect({ ...query('summary'), group: 'summary' }, new AbortController().signal)
    assert.equal(result.total, 1)
    assert.equal(result.rows[0].category, 'summary')
    assert.deepEqual(resultCodec('inspect').parse(result), result)
    const messages = await f.ctx.contextInspector.inspect({ ...query('summary'), group: 'message' }, new AbortController().signal)
    assert.equal(messages.total, 1)
    assert.equal(messages.rows[0].seq, 3)
  } finally { await ctxDispose(f.ctx) }
})

test('goal stop reason surfaces from the read-only projection and stays separate from context pressure', async () => {
  const { events, add } = log()
  add('user/message', user('latest task'), 'append')
  const f = await service(events, { values: { goal: { goal: { id: 'goal-1', revision: 1, objective: 'finish the task', phase: 'blocked', blockedReason: { code: 'round-limit', message: 'Goal reached its configured limit of 12 rounds.' }, maxGoalRounds: 12 }, roundsStarted: 12, createdAt: 1, updatedAt: 1 } } })
  try {
    const snapshot = await f.ctx.contextInspector.inspect(query('goal-subject'), new AbortController().signal)
    assert.equal(snapshot.goal.phase, 'blocked')
    assert.equal(snapshot.goal.blockedReason.code, 'round-limit')
    assert.equal(snapshot.goal.blockedReason.message, 'Goal reached its configured limit of 12 rounds.')
    assert.equal(snapshot.goal.roundsStarted, 12)
    assert.equal(snapshot.goal.maxGoalRounds, 12)
    assert.equal(snapshot.pressure, null, 'a round-limit stop is not context pressure')
    resultCodec('inspect').parse(snapshot)
  } finally { await ctxDispose(f.ctx) }
})
// Two sessions with genuinely different logs, ledgers and durable archive
// results: the readout must be scoped to the queried session and must never
// present a current ledger, archive or host projection as a historical value.
function attributionLog(label) {
  const events = []
  const add = (type, data, surfaceOp) => { events.push({ seq: events.length, time: 1000 + events.length, type, data, ...(surfaceOp === undefined ? {} : { surfaceOp }) }); return events.length - 1 }
  add('system/message', { turn: 1, step: 1, message: createMessage({ role: 'system', content: text(`${label} system prefix`), source: { kind: 'system-prompt' } }) }, 'append')
  add('request/header', { header: { config: { provider: 'offline', model: label, maxTokens: 1024 }, tools: [{ name: 'bash', description: 'run', parameters: {} }] } })
  add('compaction/start', { compactionId: `${label}-compact`, turn: 2, kind: 'compact' })
  add('llm/retry-started', { turn: 3, step: 1, attempt: 1 })
  // A settlement whose provider never reported any component: unknown, not zero.
  add('assistant/attempt', { turn: 3, step: 1, stream: [] })
  // A settlement during the open compaction transaction: purpose unconfirmed.
  add('assistant/message', { turn: 2, step: 1, message: assistant(`${label} reply`), stream: [], usage: { inputTokens: 100, cacheReadTokens: 40, outputTokens: 7 } }, 'append')
  add('compaction/end', { compactionId: `${label}-compact`, turn: 2, status: 'completed' })
  // A settlement that reported all four components: the only one a cache-hit
  // ratio may be derived from.
  add('assistant/message', { turn: 4, step: 1, message: assistant(`${label} later reply`), stream: [],
    usage: { inputTokens: 30, cacheReadTokens: 70, cacheWriteTokens: 10, outputTokens: 5 } }, 'append')
  add('user/message', user(`${label} latest task`), 'append')
  return events
}
const attributionQuery = sessionId => ({ ...query(sessionId) })

test('attribution and reduction readouts are session-scoped, codec-clean, switch-gated, and absent from history', async () => {
  const logs = { 'sess-a': attributionLog('alpha'), 'sess-b': attributionLog('beta') }
  const usage = { 'sess-a': { uncachedInputTokens: 600, cacheReadTokens: 400, cacheWriteTokens: 40, outputTokens: 7 },
    'sess-b': { uncachedInputTokens: 90, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 3 } }
  const ledgers = { 'sess-a': { input: 900, output: 120, cacheRead: 800, cacheWrite: 0, attempts: 2, unknownAttempts: 1, since: 111, recent: [] },
    'sess-b': { input: 50, output: 10, cacheRead: 0, cacheWrite: 0, attempts: 1, unknownAttempts: 0, since: 222, recent: [] } }
  const archives = { 'sess-a': { mode: 'reduce', pipelineReported: true, published: { references: 2, originalChars: 4000, shortenedChars: 900, visibleCharsRemoved: 3100 },
      pending: 1, reverted: 0, recent: [{ contentId: 'sha256:aaa', callId: 'call-1', tool: 'bash', shortenedChars: 900, complete: true, at: 5 }], notes: ['可见字符差不是账单'],
      run: { considered: 9, unverified: 0, wouldReduce: 2, skipped: 1, failed: 0, lastSkip: 'no_savings', lastReason: '低于最小节省' } },
    'sess-b': { mode: 'observe', pipelineReported: false, published: { references: 0, originalChars: 0, shortenedChars: 0, visibleCharsRemoved: 0 },
      pending: 0, reverted: 3, recent: [], notes: [], run: { considered: 4, unverified: 1, wouldReduce: 0, skipped: 2, failed: 1, lastSkip: 'unverified_result', lastReason: null },
      archiveError: '原文档案目录不可写' } }
  const readouts = []
  const f = await service(sessionId => logs[sessionId], sessionId => ({ values: { tokenUsage: usage[sessionId] } }), { contextManager: {
    summaryLedger: { stats: sessionId => ledgers[sessionId] },
    reductionReadout: sessionId => { readouts.push(sessionId); return archives[sessionId] },
    snapshot: () => ({ prefixDiagnosticsEnabled: false }),
  } })
  try {
    const a = await f.ctx.contextInspector.inspect(attributionQuery('sess-a'), new AbortController().signal)
    const b = await f.ctx.contextInspector.inspect(attributionQuery('sess-b'), new AbortController().signal)
    assert.deepEqual(resultCodec('inspect').parse(a), a)
    assert.deepEqual(resultCodec('inspect').parse(b), b)
    // Host projection is authoritative; the mirrored fold keeps its own gaps.
    assert.equal(a.efficiency.accounting, 'host-projection')
    assert.deepEqual(a.efficiency.host, usage['sess-a'])
    assert.equal(a.efficiency.mirrored.complete, false)
    assert.equal(a.efficiency.mirrored.withoutUsage, 1, 'an attempt without reported usage is unknown, not a zero sample')
    assert.equal(a.efficiency.mirrored.retries, 1)
    assert.equal(a.efficiency.mirrored.uncachedInput.sum, 130)
    assert.equal(a.efficiency.mirrored.cacheRead.sum, 110)
    assert.equal(a.efficiency.mirrored.output.sum, 12)
    assert.equal(a.efficiency.mirrored.cacheWrite.missing, 1, 'a component the provider never reported stays missing')
    assert.equal(a.efficiency.mirrored.uncachedInput.missing, 0, 'an attempt without any usage counts once as unknown, not as four missing components')
    assert.ok(a.efficiency.differences.length > 0, 'the fold cannot reproduce the host total here and must say so')
    assert.equal(a.efficiency.maintenanceSuspects, 1)
    assert.equal(a.efficiency.requests.find(row => row.settledBy === 'attempt').routeKnown, true)
    assert.equal(a.efficiency.requests.find(row => row.maintenanceSuspect).turn, 2)
    // 70 measured cache-read of 110 measured input; nothing else was measurable.
    assert.ok(Math.abs(a.efficiency.cacheHitRatio - 70 / 110) < 1e-9)
    // The prefix switch is really off at the producer: no fingerprint, same numbers.
    assert.equal(a.efficiency.fingerprint, null)
    assert.equal(a.efficiency.changes.length, 0)
    assert.deepEqual(a.efficiency.summaryAndRepair, { source: 'summary-ledger', input: 900, output: 120, cacheRead: 800, cacheWrite: 0,
      attempts: 2, unknownAttempts: 1, purposeSplit: false, note: a.efficiency.summaryAndRepair.note })
    assert.match(a.efficiency.summaryAndRepair.note, /用途/u)
    // Session scoping: neither ledger, archive result nor host bucket leaks across.
    assert.equal(a.reduction.published.references, 2)
    assert.equal(a.reduction.pending, 1)
    assert.equal(b.reduction.published.references, 0)
    assert.equal(b.reduction.reverted, 3)
    assert.equal(b.reduction.archiveError, '原文档案目录不可写')
    assert.equal(Object.hasOwn(a.reduction, 'archiveError'), false)
    assert.equal(b.reduction.mode, 'observe')
    assert.equal(b.reduction.run.lastSkip, 'unverified_result')
    assert.equal(b.efficiency.host.outputTokens, 3)
    assert.equal(b.efficiency.summaryAndRepair.input, 50)
    // Read-only repetition: one observation and one readout per call, nothing cached.
    const again = await f.ctx.contextInspector.inspect(attributionQuery('sess-a'), new AbortController().signal)
    assert.deepEqual({ ...again, sampledAt: 0 }, { ...a, sampledAt: 0 }, 'a repeated read-only call returns the same reading')
    assert.deepEqual(readouts, ['sess-a', 'sess-b', 'sess-a'])
    assert.equal(f.disposals, f.reads.length)
    // History keeps only the event-log fold; current ledger, archive and host
    // projection are omitted instead of being shown as old values.
    const history = await f.ctx.contextInspector.inspect({ ...attributionQuery('sess-a'), atSeq: 5 }, new AbortController().signal)
    assert.equal(history.historical, true)
    assert.equal(history.efficiency.accounting, 'event-log')
    assert.equal(history.efficiency.host, null)
    assert.equal(history.efficiency.summaryAndRepair, null)
    assert.equal(history.efficiency.mirrored.settledAttempts, 2, 'the fold still describes that cut')
    assert.equal(Object.hasOwn(history, 'reduction'), false)
    assert.equal(Object.hasOwn(history, 'summaryUsage'), false)
    assert.equal(Object.hasOwn(history, 'admission'), false)
    assert.deepEqual(resultCodec('inspect').parse(history), history)
    assert.deepEqual(readouts, ['sess-a', 'sess-b', 'sess-a'], 'a historical read never asks for the current archive readout')
    assert.equal(f.disposals, f.reads.length)
    // Positive control for the same switch: switching prefix diagnostics back on
    // adds the fingerprint and changes no usage number at all.
    const on = await service(sessionId => logs[sessionId], sessionId => ({ values: { tokenUsage: usage[sessionId] } }), { contextManager: {
      summaryLedger: { stats: sessionId => ledgers[sessionId] },
      reductionReadout: sessionId => archives[sessionId],
      snapshot: () => ({ prefixDiagnosticsEnabled: true }),
    } })
    try {
      const withDiagnostics = await on.ctx.contextInspector.inspect(attributionQuery('sess-a'), new AbortController().signal)
      assert.equal(withDiagnostics.efficiency.fingerprint.tools, 1)
      assert.equal(withDiagnostics.efficiency.fingerprint.systemChars, 'alpha system prefix'.length)
      assert.match(withDiagnostics.efficiency.fingerprint.prefix, /^[a-f0-9]{16}$/u)
      assert.deepEqual(withDiagnostics.efficiency.mirrored, a.efficiency.mirrored)
      assert.deepEqual(withDiagnostics.efficiency.summaryAndRepair, a.efficiency.summaryAndRepair)
      assert.deepEqual(withDiagnostics.efficiency.host, a.efficiency.host)
    } finally { await ctxDispose(on.ctx) }
  } finally { await ctxDispose(f.ctx) }
})

test('attribution reports a missing ledger or archive capability as unavailable, never as zero savings', async () => {
  const { events, add } = log()
  add('user/message', user('only a message'), 'append')
  // No summaryLedger, no reductionReadout and no tokenUsage projection: the
  // panel must still answer, with the fold and explicit absences.
  const f = await service(events)
  try {
    const result = await f.ctx.contextInspector.inspect(query('bare'), new AbortController().signal)
    assert.equal(result.efficiency.accounting, 'event-log')
    assert.equal(result.efficiency.host, null)
    assert.equal(result.efficiency.summaryAndRepair, null)
    assert.equal(result.efficiency.fingerprint, null)
    assert.equal(result.efficiency.mirrored.settledAttempts, 0)
    assert.equal(Object.hasOwn(result, 'reduction'), false)
    assert.deepEqual(resultCodec('inspect').parse(result), result)
  } finally { await ctxDispose(f.ctx) }
})
