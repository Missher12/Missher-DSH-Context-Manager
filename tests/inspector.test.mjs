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

async function service(events, projections) {
  const ctx = new Context(); const reads = []; let disposals = 0
  ctx.provide('contextManager', { idleStatus: () => ({ status: 'waiting', dueAt: null, message: '等待任务完成' }) })
  ctx.provide('sessions', { messageProjections: [] })
  ctx.provide('sessionProjections', { restore: () => ({ snapshot: { values: {} }, checkpoint: {} }) })
  ctx.provide('sessionQuery', { async observeSession(sessionId, options) {
    reads.push({ sessionId, ...options })
    return { cursor: events.length - 1, events, projections,
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
