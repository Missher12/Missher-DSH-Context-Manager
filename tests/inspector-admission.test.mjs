import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Context } from '@deepseek-ai/cordis'
import SessionStore, { Session, SessionId, SessionLogOffset } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import TokenMeter from '@deepseek-ai/dsh-token-meter'
import LlmRuntime, { LlmAdapter, AssistantStreamAccumulator, createMessage, createUserMessage } from '@deepseek-ai/dsh-llm'
import Inspector from '../lib/inspector.js'
import { TYPERT } from '../lib/typert.js'
import { composition } from '../lib/chart-data.js'
import { defaults } from '../lib/policy.js'

const id = SessionId('admission-fixture')
const query = { sessionId: id, atSeq: null, offset: 0, category: 'all', search: '', sort: 'size', archived: false }
const text = value => [{ type: 'text', text: value }]
const user = value => createUserMessage({ content: text(value), source: { kind: 'user' } })
const codec = () => TYPERT.invocations.find(item => item.method === 'inspect').result.create()

async function metadataAdapter(ctx, resolve) {
  await ctx.plugin(LlmRuntime)
  class Adapter extends LlmAdapter {
    resolveModel = resolve
    async *stream() { throw new Error('inspection must never generate a model request') }
  }
  ctx.llm.registerAdapter(['offline'], new Adapter())
}

async function fixture(t, { loaded = true, maxTokens = 8192, meter = true } = {}) {
  const ctx = new Context()
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(SessionStore)
  if (meter) await ctx.plugin(TokenMeter)
  const session = loaded ? ctx.sessions.create(id) : Session.create(id)
  const config = { provider: 'offline', model: '200k', ...(maxTokens === null ? {} : { maxTokens }) }
  session.append('step/start', { turn: 1, step: 1 })
  session.append('request/header', { reason: 'initial', header: { config } })
  session.append('request/context', { provider: 'offline', model: '200k', contextWindow: 200000 })
  session.append('user/message', user('Read the fixture only.'), { surfaceOp: 'append' })
  const stream = new AssistantStreamAccumulator()
  for (const chunk of [{ type: 'block-start', index: 0, blockType: 'text' },
    { type: 'text-delta', index: 0, text: 'done' }, { type: 'block-end', index: 0, block: { type: 'text', text: 'done' } },
    { type: 'usage', usage: { inputTokens: 150000, outputTokens: 12000 } }, { type: 'finish', reason: { kind: 'stop' } }]) {
    stream.push({ time: 1, chunk })
  }
  session.append('assistant/message', { turn: 1, step: 1, stream: [...stream.snapshot()],
    usage: { inputTokens: 150000, outputTokens: 12000 }, message: createMessage({ role: 'assistant',
      content: text('done'), source: { kind: 'model', provider: 'offline', model: '200k' } }) }, { surfaceOp: 'append' })
  session.append('step/end', { turn: 1, step: 1 })
  let afterObserve
  let disposals = 0
  ctx.provide('contextManager', { idleStatus: () => ({ status: 'off', dueAt: null, message: 'off' }) })
  ctx.provide('sessionQuery', { async observeSession(sessionId, options) {
    assert.equal(sessionId, id)
    options.signal.throwIfAborted()
    const events = session.snapshotEvents()
    const projections = options.projectionMode === 'all'
      ? ctx.sessionProjections.restore({}, events, SessionLogOffset(0), session.header, session.inheritedEventCount).snapshot : undefined
    afterObserve?.()
    return { events, cursor: events.length - 1, header: session.header, inheritedEventCount: session.inheritedEventCount,
      projections, [Symbol.dispose]() { disposals++ } }
  } })
  await ctx.plugin(Inspector)
  t.after(() => ctx.fiber.dispose())
  return { ctx, session, inspect: (patch = {}) => ctx.contextInspector.inspect({ ...query, ...patch }, new AbortController().signal),
    afterObserve: callback => { afterObserve = callback }, get disposals() { return disposals } }
}

test('inspector reads the real live meter, separate from pressure projection, without appending or activating an Agent', async t => {
  const f = await fixture(t)
  const before = JSON.stringify(f.session.snapshotEvents())
  const measurement = f.ctx.tokenMeter.measure(f.session)
  const result = await f.inspect()
  assert.deepEqual(result.admission, { tokens: measurement.totalTokens, logRevision: measurement.logRevision,
    baseline: measurement.baseline.kind, window: 200000, outputReserve: 8192 })
  assert.notEqual(result.admission.tokens, result.pressure.projected, 'fixture exercises two genuinely different host readings')
  assert.deepEqual(codec().parse(JSON.parse(JSON.stringify(result))), result)
  assert.equal(JSON.stringify(f.session.snapshotEvents()), before)
  assert.equal(f.ctx.get('agents'), undefined)
  assert.equal(f.disposals, 1)
})

test('custom model inspection uses an observed request reserve only for the same recorded window', async t => {
  const f = await fixture(t, { maxTokens: null })
  f.ctx.contextManager.requestBudgetReadout = session => {
    assert.strictEqual(session, f.session)
    return { window: 200000, outputReserve: 0 }
  }
  const result = await f.inspect()
  assert.equal(result.admission.outputReserve, 0, 'zero is an observed engine reservation, not an invented model default')
  assert.deepEqual(codec().parse(JSON.parse(JSON.stringify(result))), result)
  f.ctx.contextManager.requestBudgetReadout = () => ({ window: 1000000, outputReserve: 8192 })
  assert.equal((await f.inspect()).admission.outputReserve, null, 'a changed request window invalidates the fallback')
})

test('custom route restores its reserve after restart from exact-model metadata without generating or writing', async t => {
  for (const defaultMaxTokens of [undefined, 8192, 65536]) {
    const f = await fixture(t, { maxTokens: null })
    const before = JSON.stringify(f.session.snapshotEvents())
    let lookups = 0
    await metadataAdapter(f.ctx, async (provider, model, signal) => {
        lookups++
        assert.equal(provider, 'offline'); assert.equal(model, '200k')
        assert.equal(signal.aborted, false)
        assert.equal(f.disposals, 0, 'the immutable read stays leased during metadata resolution')
        return { provider, id: model, name: model, context: { contextWindow: 200000 },
          ...(defaultMaxTokens === undefined ? {} : { defaultMaxTokens }) }
    })
    const result = await f.inspect()
    assert.equal(lookups, 1, 'a fresh inspector has no in-memory request budget')
    assert.equal(result.admission.outputReserve, defaultMaxTokens ?? 0,
      'absence of a configured default uses the same zero reservation as the request gate')
    const chart = composition({ ...result, compression: { mode: 'native' }, cooperation: { requestPressure: 'context' } }, defaults)
    assert.notEqual(chart.reserve, null, 'known custom-route metadata must retain a gray reserve')
    assert.equal(chart.limit, defaultMaxTokens === 65536 ? 128464 : 158000)
    assert.deepEqual(codec().parse(JSON.parse(JSON.stringify(result))), result)
    assert.equal(JSON.stringify(f.session.snapshotEvents()), before)
    assert.equal(f.ctx.get('agents'), undefined)
    assert.equal(f.disposals, 1)
    await f.inspect({ atSeq: result.cutSeq })
    assert.equal(lookups, 1, 'historical cuts never resolve current model settings')
  }
})

test('exact-model reserve lookup keeps failures unknown and discards metadata if the session advances', async t => {
  for (const metadata of [null, { provider: 'other', id: '200k', context: { contextWindow: 200000 } },
    { provider: 'offline', id: 'other', context: { contextWindow: 200000 } },
    { provider: 'offline', id: '200k', context: { contextWindow: 1000000 } }]) {
    const f = await fixture(t, { maxTokens: null })
    await metadataAdapter(f.ctx, async () => {
      if (metadata === null) throw new Error('provider is unavailable')
      return { name: 'fixture', ...metadata }
    })
    assert.equal((await f.inspect()).admission.outputReserve, null)
  }
  const advanced = await fixture(t, { maxTokens: null })
  await metadataAdapter(advanced.ctx, async (provider, model) => {
    advanced.session.append('request/header', { reason: 'change', header: { config: { provider, model: 'changed' } } })
    return { provider, id: model, name: model, context: { contextWindow: 200000 }, defaultMaxTokens: 8192 }
  })
  assert.equal((await advanced.inspect()).admission, undefined, 'an async lookup cannot attach old metadata to a new cut')
  assert.equal(advanced.disposals, 1)
})

test('historical inspection never reads the current meter, even for the current last seq', async t => {
  const f = await fixture(t)
  let reads = 0
  f.ctx.tokenMeter.measure = () => { reads++; throw new Error('historical path must not measure') }
  const result = await f.inspect({ atSeq: f.session.snapshotEvents().length - 1 })
  assert.equal(result.historical, true)
  assert.equal(Object.hasOwn(result, 'admission'), false)
  assert.equal(result.pressure, null)
  assert.equal(reads, 0)
})

test('unloaded, unavailable and concurrently advanced measurements stay unknown', async t => {
  const unloaded = await fixture(t, { loaded: false })
  let reads = 0
  unloaded.ctx.tokenMeter.measure = () => { reads++; throw new Error('unloaded history must not measure') }
  assert.equal((await unloaded.inspect()).admission, undefined)
  assert.equal(unloaded.ctx.sessions.get(id), undefined)
  assert.equal(reads, 0)
  const unavailable = await fixture(t, { meter: false })
  assert.equal((await unavailable.inspect()).admission, undefined)
  const advanced = await fixture(t)
  advanced.afterObserve(() => advanced.session.append('user/message', user('Arrived after the immutable cut.'), { surfaceOp: 'append' }))
  assert.equal((await advanced.inspect()).admission, undefined)
  const failed = await fixture(t)
  failed.ctx.tokenMeter.measure = () => { throw new Error('route price unavailable') }
  assert.equal((await failed.inspect()).admission, undefined)
})

test('missing output defaults and route-mismatched windows are not invented from projections', async t => {
  const missing = await fixture(t, { maxTokens: null })
  const result = await missing.inspect()
  assert.equal(result.admission.window, 200000)
  assert.equal(result.admission.outputReserve, null)
  const switched = await fixture(t)
  switched.session.append('request/header', { reason: 'change', header: { config: { provider: 'offline', model: 'new-route', maxTokens: 4096 } } })
  const next = await switched.inspect()
  assert.equal(next.pressure.window, 200000, 'old projection capacity remains reference data')
  assert.equal(next.admission.window, null)
  assert.equal(next.admission.outputReserve, 4096)
  assert.equal(next.admission.baseline, 'estimated')
})
