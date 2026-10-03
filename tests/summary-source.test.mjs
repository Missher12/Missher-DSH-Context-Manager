import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'
import { build } from 'esbuild'
import { Context } from '@deepseek-ai/cordis'
import { createMessage, createUserMessage } from '@deepseek-ai/dsh-llm'
import { Session, SessionId, deriveEventMessage } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import TokenMeter from '@deepseek-ai/dsh-token-meter'
import { estimateMessage } from '@deepseek-ai/dsh-token-meter/estimate'
import { JSDOM } from 'jsdom'
import React, { act } from 'react'
import { createRoot } from 'react-dom/client'

const require = createRequire(import.meta.url)
const sourceRoot = fileURLToPath(new URL('../src/', import.meta.url))
// In-memory compilation keeps the daily-linked lib and build scripts untouched.
const hostBuild = await build({
  stdin: { contents: "export { default as Inspector, contextGrowth } from './inspector.ts'; export { indexContext } from './inspector-fold.ts'; export { contentQuerySchema, contentPageSchema, inspectionSchema } from './inspector-wire.ts'", resolveDir: sourceRoot },
  write: false, bundle: true, platform: 'node', format: 'esm', target: 'es2022', tsconfigRaw: { compilerOptions: { target: 'ES2022' } },
  plugins: [{ name: 'public-api', setup(builder) {
    builder.onResolve({ filter: /^[^./]/ }, args => ({ path: import.meta.resolve(args.path), external: true }))
  } }],
})
const { Inspector, contextGrowth, indexContext, contentQuerySchema, contentPageSchema, inspectionSchema } = await import(`data:text/javascript;base64,${Buffer.from(`${hostBuild.outputFiles[0].text}\n//# sourceURL=summary-source-service-test.js`).toString('base64')}`)
const primitivesBuild = await build({
  stdin: { contents: ['Button', 'Checkbox', 'Input', 'StateDot', 'Tooltip'].map(name => `export { ${name} } from ${JSON.stringify(require.resolve(`@deepseek-ai/dsh-client-ui-primitives/src/${name}.tsx`))}`).join('\n'), resolveDir: sourceRoot },
  outfile: '/virtual/summary-source-primitives.cjs', write: false, bundle: true, platform: 'node', format: 'cjs',
  external: ['react', 'react/*', 'react-dom', 'react-dom/*'], loader: { '.css': 'local-css' }, jsx: 'automatic',
  tsconfigRaw: { compilerOptions: { target: 'ES2022' } },
})
const scope = { module: { exports: {} }, require, setTimeout, clearTimeout }
for (const name of ['window', 'document', 'Node']) Object.defineProperty(scope, name, { get: () => name === 'Node' ? globalThis.window?.Node : globalThis[name] })
scope.getComputedStyle = element => globalThis.window.getComputedStyle(element)
vm.runInNewContext(primitivesBuild.outputFiles.find(file => file.path.endsWith('.cjs')).text, scope)
const uiBuild = await build({
  stdin: { contents: "export { ContextInspectorView } from './inspector-view.tsx'; export { CompactionChart } from './inspector-charts.tsx'; export { inspectorText } from './inspector-locales.ts'", resolveDir: sourceRoot },
  write: false, bundle: true, platform: 'browser', format: 'cjs', jsx: 'automatic', target: 'es2022',
  external: ['react', 'react/*', 'react-dom', 'react-dom/*', '@deepseek-ai/dsh-client-ui-primitives'], loader: { '.css': 'text' },
  tsconfigRaw: { compilerOptions: { target: 'ES2022' } },
})
const uiScope = { module: { exports: {} }, AbortController, setTimeout, clearTimeout,
  require: name => name === '@deepseek-ai/dsh-client-ui-primitives' ? scope.module.exports : require(name) }
vm.runInNewContext(uiBuild.outputFiles[0].text, uiScope)
const { ContextInspectorView, CompactionChart, inspectorText } = uiScope.module.exports

const text = value => [{ type: 'text', text: value }]
const user = value => createUserMessage({ content: text(value), source: { kind: 'user' } })
function fixture({ metered = false, usage = true } = {}) {
  const events = []
  function add(type, data, surfaceOp, sourceEventSeqs) {
    const seq = events.length
    events.push({ seq, time: 1000 + seq, type, data, ...(surfaceOp === undefined ? {} : { surfaceOp }), ...(sourceEventSeqs ? { sourceEventSeqs } : {}) })
    return seq
  }
  add('system/message', { turn: 1, step: 1, message: createMessage({ role: 'system', content: text('system'), source: { kind: 'system-prompt' } }) }, 'append')
  if (metered) {
    add('request/header', { header: { config: { provider: 'offline', model: 'fixture' } } })
    if (usage) add('assistant/message', { turn: 1, step: 1, stream: [], usage: { inputTokens: 9000, outputTokens: 3 },
      message: createMessage({ role: 'assistant', content: text('usage anchor'), source: { kind: 'model', provider: 'offline', model: 'fixture' } }) }, 'append')
  }
  const body = 'a'.repeat(15999) + '😀' + 'b'.repeat(9000)
  const inputs = Array.from({ length: 6 }, (_, index) => add('user/message', user(index ? `source-${index}` : body), 'append'))
  const compact = (id, seqs, direct = true) => {
    const start = add('compaction/start', { compactionId: id, manual: false })
    const summary = add('compaction/summary', { compactionId: id, summary: `summary-${id}`, shadowedRange: { start: seqs[0], end: seqs.at(-1) }, shadowedSeqs: seqs, shadowedTokenCount: seqs.reduce((sum, seq) => sum + estimateMessage(deriveEventMessage(events[seq])), 0), provider: 'offline', model: 'fixture' })
    return add('user/message', createUserMessage({ content: text(`summary-${id}`), source: { kind: 'compact-checkpoint', compactionId: id } }),
      { op: 'replace', startSeq: seqs[0], endSeq: seqs.at(-1) }, [start, summary, ...(direct ? seqs : [])])
  }
  const first = compact('first', inputs)
  const later = add('user/message', user('later input'), 'append')
  const second = compact('second', [first, later])
  return { events, inputs, first, second, later, body, add, compact }
}
async function service(t, events, summaryLedger, projections) {
  const ctx = new Context(); const reads = []; let disposed = 0
  ctx.provide('contextManager', { summaryLedger, idleStatus: () => ({ status: 'off', message: 'off', dueAt: null }) })
  ctx.provide('sessions', { messageProjections: [] })
  ctx.provide('sessionProjections', projections ?? { restore: () => ({ snapshot: { values: {} }, checkpoint: {} }) })
  ctx.provide('sessionQuery', { async observeSession(sessionId, options) {
    reads.push({ sessionId, ...options })
    return { cursor: events.length - 1, ...observation(events), [Symbol.dispose]() { disposed++ } }
  } })
  await ctx.plugin(Inspector)
  t.after(() => ctx.fiber.dispose())
  return { api: ctx.contextInspector, reads, get disposed() { return disposed } }
}
const request = (fixture, id, patch = {}) => ({ sessionId: 'read-only', cutSeq: fixture.events.length - 1, id: `event:${id}`, offset: 0, ...patch })
function observation(events) {
  const session = Session.create(SessionId('read-only'))
  return { events, header: session.header, inheritedEventCount: session.inheritedEventCount }
}
async function meter(t) {
  const ctx = new Context()
  await ctx.plugin(SessionProjectionRegistry); await ctx.plugin(TokenMeter)
  t.after(() => ctx.fiber.dispose())
  return ctx.sessionProjections
}
function appendTool(f) {
  f.add('assistant/message', { turn: 2, step: 1, stream: [], message: createMessage({ role: 'assistant',
    content: [{ type: 'tool-call', id: 'tool-1', name: 'fixture', arguments: '{}' }], source: { kind: 'model', provider: 'offline', model: 'fixture' } }) }, 'append')
  return f.add('tool/result', { turn: 2, step: 1, message: createMessage({ role: 'tool', toolCallId: 'tool-1', content: text('recorded tool result '.repeat(100)), source: { kind: 'tool' } }) }, 'append')
}

test('summary source lookup follows exact inputs, deduplicates metadata links, and preserves nested summary identity', () => {
  const f = fixture()
  const indexed = indexContext(f.events).indexed
  assert.deepEqual(indexed.find(item => item.row.seq === f.first).sourceSeqs, f.inputs)
  assert.deepEqual(indexed.find(item => item.row.seq === f.second).sourceSeqs, [f.first, f.later])
  assert.equal(indexed.find(item => item.row.seq === f.inputs[0]).body(), f.body)
  assert.equal(indexed.find(item => item.row.seq === 0).sourceSeqs, undefined)
  // A referenced summary record can supply shadowedSeqs without inventing a range.
  const linked = f.add('user/message', createUserMessage({ content: text('linked checkpoint'), source: { kind: 'compact-checkpoint', compactionId: 'first' } }), 'append', [f.first - 1])
  assert.deepEqual(indexContext(f.events).indexed.find(item => item.row.seq === linked).sourceSeqs, f.inputs)
  f.events[linked].data = createUserMessage({ content: text('unrelated checkpoint'), source: { kind: 'compact-checkpoint', compactionId: 'unrelated' } })
  assert.deepEqual(indexContext(f.events).indexed.find(item => item.row.seq === linked).sourceSeqs, [], 'unrelated compaction metadata never supplies source references')
})

test('content RPC returns four references per page and reads exact original text in bounded pages without writes', async t => {
  const f = fixture(); const baseline = JSON.stringify(f.events); const host = await service(t, f.events)
  const read = patch => host.api.content(request(f, f.first, patch), new AbortController().signal)
  const first = await read({ sourceOffset: 0 })
  assert.equal(first.sources.rows.length, 4); assert.equal(first.sources.total, 6); assert.equal(first.sources.nextOffset, 4)
  assert.equal(first.text, 'summary-first'); assert.equal(JSON.stringify(first).includes('b'.repeat(100)), false)
  assert.deepEqual(contentPageSchema().parse(first), first)
  const last = await read({ sourceOffset: first.sources.nextOffset })
  assert.deepEqual(last.sources.rows.map(row => row.seq), f.inputs.slice(4)); assert.equal(last.sources.nextOffset, null)
  let offset = 0; let original = ''
  do {
    const page = await host.api.content(request(f, f.inputs[0], { offset }), new AbortController().signal)
    assert.equal(page.sources, undefined); assert.ok(page.text.length <= 16000)
    assert.ok(!/[\uD800-\uDBFF]$/u.test(page.text)); original += page.text; offset = page.nextOffset
  } while (offset !== null)
  assert.equal(original, f.body)
  assert.equal(JSON.stringify(f.events), baseline, 'reading does not alter or copy the historical log')
  assert.ok(host.reads.every(read => read.projectionMode === 'none')); assert.equal(host.reads.length, host.disposed)
})

test('summary source wire and service reject invalid offsets, extra fields, stale cuts and cancelled reads', async t => {
  const f = fixture(); const host = await service(t, f.events)
  for (const patch of [{ sourceOffset: -1 }, { sourceOffset: 0.1 }, { all: true }]) {
    assert.equal(contentQuerySchema().safeParse(request(f, f.first, patch)).success, false)
  }
  await assert.rejects(host.api.content(request(f, f.first, { sourceOffset: 100 }), new AbortController().signal), /来源位置/)
  await assert.rejects(host.api.content(request(f, f.inputs[0], { sourceOffset: 0 }), new AbortController().signal), /只有压缩摘要/)
  await assert.rejects(host.api.content(request(f, f.second, { cutSeq: f.first }), new AbortController().signal), /不属于/)
  const controller = new AbortController(); controller.abort()
  await assert.rejects(host.api.content(request(f, f.first), controller.signal), { name: 'AbortError' })
  assert.equal(host.reads.length, host.disposed)
  const page = await host.api.content(request(f, f.first), new AbortController().signal)
  assert.equal(contentPageSchema().safeParse({ ...page, sources: { ...page.sources, rows: [...page.sources.rows, page.sources.rows[0]] } }).success, false)
  assert.equal(contentPageSchema().safeParse({ ...page, sources: { ...page.sources, body: 'must not ship' } }).success, false)
})

test('current inspection adds bounded summary accounting independently; historical cuts never inherit latest ledger totals', async t => {
  const f = fixture(); const ledgerReads = []
  const stats = { input: 2300, output: 200, attempts: 3, unknownAttempts: 1, since: 1000, cacheRead: 300, cacheWrite: 0,
    recent: [{ id: 'internal-attempt', compactionId: 'first', trigger: 'idle' }] }
  const host = await service(t, f.events, { stats: sessionId => { ledgerReads.push(sessionId); return stats } })
  const query = { sessionId: 'read-only', atSeq: null, offset: 0, category: 'all', search: '', sort: 'size', archived: false }
  const current = await host.api.inspect(query, new AbortController().signal)
  assert.equal(current.usage, null)
  assert.deepEqual(current.summaryUsage, { input: 2300, output: 200, attempts: 3, unknownAttempts: 1, since: 1000 })
  assert.deepEqual(inspectionSchema().parse(current), current)
  assert.equal(current.compactions.find(entry => entry.id === 'first').trigger, 'idle')
  assert.equal(current.compactions.find(entry => entry.id === 'second').trigger, undefined)
  assert.equal(JSON.stringify(current).includes('internal-attempt'), false)
  const historical = await host.api.inspect({ ...query, atSeq: f.first }, new AbortController().signal)
  assert.equal(historical.summaryUsage, undefined); assert.deepEqual(ledgerReads, ['read-only'])
  assert.ok(historical.compactions.every(entry => !Object.hasOwn(entry, 'trigger')))
  const legacy = await service(t, f.events)
  assert.equal((await legacy.api.inspect(query, new AbortController().signal)).summaryUsage, undefined)
})

test('compaction sources require matching current-session ledger evidence and never annotate pruning or old history', async t => {
  const f = fixture(); const tool = appendTool(f)
  const prune = f.add('compaction/prune', { shadowedRange: { start: tool, end: tool }, shadowedSeqs: [tool], shadowedTokenCount: estimateMessage(f.events[tool].data.message) })
  const stats = { input: 0, output: 0, attempts: 1, unknownAttempts: 1, since: 1000, recent: [] }
  const host = await service(t, f.events, { stats: sessionId => sessionId === 'read-only' ? stats : undefined })
  const query = { sessionId: 'read-only', atSeq: null, offset: 0, category: 'all', search: '', sort: 'size', archived: false }
  for (const trigger of ['idle', 'pressure', 'overflow', 'manual']) {
    stats.recent = [{ compactionId: 'first', trigger }, { compactionId: 'unrelated', trigger }, { compactionId: `prune:${prune}`, trigger }]
    const current = await host.api.inspect(query, new AbortController().signal)
    assert.equal(current.compactions.find(entry => entry.id === 'first').trigger, trigger)
    assert.equal(current.compactions.find(entry => entry.id === 'second').trigger, undefined)
    assert.equal(current.compactions.find(entry => entry.id === `prune:${prune}`).trigger, undefined)
    assert.deepEqual(inspectionSchema().parse(current), current)
  }
  assert.ok(indexContext(f.events).diagnostics.compactions.every(entry => !Object.hasOwn(entry, 'trigger')), 'durable diagnostics retain their original schema')
  const historical = await host.api.inspect({ ...query, atSeq: f.first }, new AbortController().signal)
  assert.ok(historical.compactions.every(entry => !Object.hasOwn(entry, 'trigger')))
  const otherSession = await host.api.inspect({ ...query, sessionId: 'other-session' }, new AbortController().signal)
  assert.ok(otherSession.compactions.every(entry => !Object.hasOwn(entry, 'trigger')), 'matching ids alone cannot borrow another session ledger')
})

test('growth compares real host projection cuts, preserves negative recalibration and measures the latest appended tool result', async t => {
  const registry = await meter(t); const f = fixture({ metered: true }); const tool = appendTool(f)
  const cuts = []
  const tracked = { restore(...args) { cuts.push(args[1].at(-1)?.seq); return registry.restore(...args) } }
  const current = contextGrowth(tracked, observation(f.events), f.events.length - 1, new AbortController().signal)
  const projectedAt = cut => registry.restore({}, f.events.slice(0, cut + 1), 0, observation(f.events).header, 0).snapshot.values.contextPressure.projectedTokens
  assert.equal(current.sinceCompaction.fromSeq, f.second)
  assert.equal(current.sinceCompaction.beforeTokens, projectedAt(f.second))
  assert.equal(current.sinceCompaction.afterTokens, projectedAt(f.events.length - 1))
  assert.equal(current.sinceCompaction.deltaTokens, projectedAt(f.events.length - 1) - projectedAt(f.second))
  assert.deepEqual(current.lastToolResult, { fromSeq: tool - 1, toSeq: tool, beforeTokens: projectedAt(tool - 1), afterTokens: projectedAt(tool), deltaTokens: projectedAt(tool) - projectedAt(tool - 1) })
  assert.ok(current.lastToolResult.deltaTokens > 0); assert.ok(cuts.length <= 4)
  f.add('compaction/prune', { shadowedRange: { start: tool, end: tool }, shadowedSeqs: [tool], shadowedTokenCount: estimateMessage(f.events[tool].data.message) })
  f.add('tool/result', { ...f.events[tool].data, message: createMessage({ role: 'tool', toolCallId: 'tool-1', content: text('pruned result'), source: { kind: 'tool' } }) }, { op: 'replace', startSeq: tool, endSeq: tool }, [tool])
  assert.deepEqual(contextGrowth(registry, observation(f.events), f.events.length - 1, new AbortController().signal).lastToolResult, current.lastToolResult, 'a pruning replacement is not a newly added tool result')
  f.add('assistant/message', { turn: 2, step: 2, stream: [], usage: { inputTokens: 10, outputTokens: 1 },
    message: createMessage({ role: 'assistant', content: text('recalibrated'), source: { kind: 'model', provider: 'offline', model: 'fixture' } }) }, 'append')
  const after = contextGrowth(registry, observation(f.events), f.events.length - 1, new AbortController().signal)
  assert.ok(after.sinceCompaction.deltaTokens < 0, 'a downward usage recalibration stays negative')
  assert.deepEqual(after.lastToolResult, current.lastToolResult, 'later replies do not change the historical tool-event delta')
})

test('growth stays unknown without provider anchors, across routes and after unpriced legacy compaction', async t => {
  const registry = await meter(t)
  const unmeasured = fixture({ metered: true, usage: false }); appendTool(unmeasured)
  assert.deepEqual(contextGrowth(registry, observation(unmeasured.events), unmeasured.events.length - 1, new AbortController().signal), { sinceCompaction: null, lastToolResult: null })
  const switched = fixture({ metered: true })
  switched.add('request/header', { header: { config: { provider: 'offline', model: 'other-route' } } })
  assert.equal(contextGrowth(registry, observation(switched.events), switched.events.length - 1, new AbortController().signal).sinceCompaction, null)
  switched.add('request/header', { header: { config: { provider: 'offline', model: 'fixture' } } })
  assert.equal(contextGrowth(registry, observation(switched.events), switched.events.length - 1, new AbortController().signal).sinceCompaction, null, 'switching back does not erase the incomparable interval')
  const legacy = fixture({ metered: true })
  legacy.events[legacy.second - 1] = { ...legacy.events[legacy.second - 1], type: 'fixture/legacy', data: {}, ignorable: true }
  assert.equal(contextGrowth(registry, observation(legacy.events), legacy.events.length - 1, new AbortController().signal).sinceCompaction, null)
  const aborted = new AbortController(); aborted.abort()
  assert.throws(() => contextGrowth(registry, observation(legacy.events), legacy.events.length - 1, aborted.signal), { name: 'AbortError' })
})

test('historical inspection omits current growth and only replays events through its selected cut', async t => {
  const registry = await meter(t); const f = fixture({ metered: true }); appendTool(f)
  const cuts = []; const tracked = { restore(...args) { cuts.push(args[1].at(-1)?.seq); return registry.restore(...args) } }
  const host = await service(t, f.events, undefined, tracked)
  const query = { sessionId: 'read-only', atSeq: null, offset: 0, category: 'all', search: '', sort: 'size', archived: false }
  const current = await host.api.inspect(query, new AbortController().signal)
  assert.ok(current.contextGrowth.lastToolResult); assert.deepEqual(inspectionSchema().parse(current), current)
  cuts.length = 0
  const historical = await host.api.inspect({ ...query, atSeq: f.first }, new AbortController().signal)
  assert.equal(historical.contextGrowth, undefined); assert.ok(cuts.every(seq => seq <= f.first))
})

const summaryRow = { id: 'event:20', seq: 20, title: 'retained summary', category: 'summary', current: true, source: 'compact-checkpoint', tokens: 10, images: 0 }
const sourceRows = Array.from({ length: 6 }, (_, index) => ({ ...summaryRow, id: `event:${index + 1}`, seq: index + 1, title: `original ${index + 1}`, category: 'user', current: false }))

test('real DOM distinguishes verified compaction triggers while legacy and historical rows use their original classification', async () => {
  const dom = new JSDOM('<div id="root"></div>', { url: 'http://localhost' })
  globalThis.window = dom.window; globalThis.document = dom.window.document; globalThis.IS_REACT_ACT_ENVIRONMENT = true
  const base = { kind: 'compact', startedAt: 1000, status: 'completed', manual: false, applied: false }
  const entries = [...['idle', 'pressure', 'overflow', 'manual'].map(trigger => ({ ...base, id: trigger, trigger })),
    { ...base, id: 'legacy-between', manual: true }, { ...base, id: 'legacy-task' }, { ...base, id: 'prune', kind: 'prune', trigger: 'idle' }]
  const root = createRoot(document.getElementById('root')); const t = inspectorText('zh')
  const render = historical => act(async () => root.render(React.createElement(CompactionChart, { data: { historical, compactions: entries }, t })))
  try {
    await render(false)
    await act(async () => [...document.querySelectorAll('button')].find(button => button.textContent === '全部记录').click())
    const labels = () => [...document.querySelectorAll('.cmv-events > li')].map(row => row.querySelector('[tabindex="0"]').textContent.split(' · ').at(-1))
    assert.deepEqual(labels(), ['工具整理', '任务内', '会话间', '手动', '溢出', '请求前', '闲置'])
    await render(true)
    assert.deepEqual(labels(), ['工具整理', '任务内', '会话间', '任务内', '任务内', '任务内', '任务内'])
  } finally {
    await act(async () => root.unmount()); dom.window.close(); delete globalThis.window; delete globalThis.document
  }
})

test('real DOM reads four source links on demand in the same panel, cancels old bodies and resets on target change', async () => {
  const dom = new JSDOM('<div id="root"></div>', { url: 'http://localhost' })
  globalThis.window = dom.window; globalThis.document = dom.window.document; globalThis.IS_REACT_ACT_ENVIRONMENT = true
  const state = { revision: 1, value: undefined }
  const form = { subscribe: () => () => {}, getSnapshot: () => state }
  const pulse = { subscribe: () => () => {}, getSnapshot: () => 0 }
  const reads = []
  const api = {
    idleStatus: async () => ({ status: 'scheduled', dueAt: Date.now() + 60000, restored: true, message: 'server scheduled', reasonCode: 'eligible' }),
    inspect: async query => ({ ...query, cursor: 30, cutSeq: 30, sampledAt: 1000, historical: false, pressure: null, official: null, usage: null, summaryUsage: { input: 2300, output: 200, attempts: 3, unknownAttempts: 1, since: 1000 }, contextGrowth: { sinceCompaction: { fromSeq: 20, toSeq: 30, beforeTokens: 1000, afterTokens: 800, deltaTokens: -200 }, lastToolResult: null }, model: null, parts: [], rows: [summaryRow], total: 1, pageSize: 50, activeCount: 1, archivedCount: 6, requests: [], requestCount: 0, pressureHistory: [], compactions: [] }),
    content: (query, signal) => new Promise(resolve => reads.push({ query, signal, resolve })),
  }
  const root = createRoot(document.getElementById('root'))
  const render = target => act(async () => root.render(React.createElement(ContextInspectorView, { target, form, api, pulse })))
  const settle = () => act(async () => new Promise(resolve => setTimeout(resolve, 230)))
  const click = label => act(async () => { const button = [...document.querySelectorAll('button')].find(item => item.textContent === label); assert.ok(button && !button.disabled, label); button.click() })
  const reply = (read, body = 'summary body', nextOffset = null) => act(async () => read.resolve({ ...read.query, text: body, nextOffset, totalChars: nextOffset ? 20000 : body.length,
    ...(read.query.id === summaryRow.id ? { sources: { rows: sourceRows.slice(read.query.sourceOffset, read.query.sourceOffset + 4), offset: read.query.sourceOffset, total: 6, nextOffset: read.query.sourceOffset === 0 ? 4 : null } } : {}) }))
  try {
    await render('a'); await settle(); assert.equal(reads.length, 1)
    assert.match(document.querySelector('[aria-label="闲置整理"]').textContent, /已恢复 · 1 分钟后检查/)
    assert.equal(document.querySelectorAll('.cmv-usage').length, 1)
    assert.match(document.querySelector('.cmv-usage .cmv-summary-usage').textContent, /摘要已记录 2\.5K Token · 3 次尝试 · 1 次用量未知/)
    assert.match(document.querySelector('.cmv-usage').textContent, /暂无累计用量/, 'summary accounting does not fabricate main-request usage')
    assert.match(document.querySelector('[data-growth="sinceCompaction"]').textContent, /≈ -200 Token/)
    assert.match(document.querySelector('[data-growth="lastToolResult"]').textContent, /未知/)
    assert.equal(document.querySelectorAll('.cmv-composition').length, 1, 'growth stays inside the existing occupancy card')
    await reply(reads[0])
    assert.equal(document.querySelectorAll('.cmv-summary-source .cmi-content-list > button').length, 4)
    assert.equal(reads.length, 1, 'references do not prefetch original bodies')
    await click('下一组来源'); assert.equal(reads.at(-1).query.sourceOffset, 4); await reply(reads.at(-1))
    assert.equal(document.querySelectorAll('.cmv-summary-source .cmi-content-list > button').length, 2)
    await act(async () => document.querySelector('.cmv-summary-source .cmi-content-list > button').click())
    const original = reads.at(-1)
    assert.equal(original.query.id, 'event:5'); assert.equal(original.query.offset, 0)
    assert.equal(document.querySelectorAll('.cmv-reader').length, 1); assert.equal(document.querySelector('.cmi-body'), null)
    await reply(original, 'first original page', 16000); await click('下一段')
    const delayed = reads.at(-1); assert.equal(delayed.query.offset, 16000)
    await click('返回上一级摘要'); assert.equal(delayed.signal.aborted, true)
    await reply(delayed, 'late original page'); assert.ok(!document.body.textContent.includes('late original page'))
    assert.equal(reads.at(-1).query.id, summaryRow.id); assert.equal(reads.at(-1).query.sourceOffset, 0)
    const delayedSummary = reads.at(-1)
    await render('b'); assert.equal(delayedSummary.signal.aborted, true)
    assert.equal(document.querySelector('.cmv-summary-source'), null)
    await reply(delayedSummary, 'late summary a'); await settle()
    assert.ok(!document.body.textContent.includes('late summary a'))
    assert.equal(reads.at(-1).query.sessionId, 'b'); assert.equal(reads.at(-1).query.offset, 0)
    assert.equal(document.querySelectorAll('[role="tab"], textarea').length, 0)
    // Waiting for a background task preserves the server explanation.
    api.idleStatus = async () => ({ status: 'scheduled', dueAt: Date.now() + 30000, message: '后台任务尚未结束，稍后检查', reasonCode: 'background-busy' })
    await render('c'); await settle()
    assert.match(document.querySelector('[aria-label="闲置整理"]').textContent, /后台任务尚未结束/)
  } finally {
    await act(async () => root.unmount()); assert.ok(reads.every(read => read.signal.aborted))
    dom.window.close(); delete globalThis.window; delete globalThis.document
  }
})
