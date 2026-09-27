import { test } from 'node:test'
import assert from 'node:assert/strict'
import { writeFileSync } from 'node:fs'
import { Context } from '@deepseek-ai/cordis'
import { LlmAdapter, createUserMessage, createMessage, ToolCallId, resolveRetryPolicy } from '@deepseek-ai/dsh-llm'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import { sessionFormatCatalog } from '@deepseek-ai/dsh-session-format-catalog'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import TokenMeter from '@deepseek-ai/dsh-token-meter'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import { defineContentToolFixture } from '@deepseek-ai/dsh-tools'
import * as Retry from '@deepseek-ai/dsh-llm-retry'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Group from '@deepseek-ai/cordis-plugin-group'
import AgentPresets from '@deepseek-ai/dsh-agent-preset-registry'
import Manager from '../lib/index.js'
import Engine from '../lib/engine.js'
import { defaults, budget, validatePolicy } from '../lib/policy.js'
import { diagnosticsProjection } from '../lib/diagnostics.js'

class Adapter extends LlmAdapter {
  order = []; requests = []; summaries = []; work = 0
  constructor(options = {}) { super(); this.options = options }
  async resolveModel(provider, model) { return { provider, id: model, name: model, context: { contextWindow: model === 'small' ? 6000 : 10000 }, reasoning: { efforts: [{ id: 'high', name: 'High' }] } } }
  imageRequestPricing() { return { priceImages: images => images.map(() => ({ visualTokens: 7000, text: 'image handle' })) } }
  providerRetryPolicy() { return resolveRetryPolicy({ mode: 'always', backoff: { initialDelayMs: 1, maxDelayMs: 1, jitterRatio: 0 } }, 'test') }
  async *stream(options) {
    if (options.purpose === 'compaction') {
      this.order.push('summary-start'); this.summaries.push(options)
      if (this.options.pause) await this.options.pause(options.signal)
      if (this.options.fail) { yield { type: 'finish', reason: { kind: 'error', failure: { code: 'SERVER', message: 'summary unavailable' } } }; return }
      const text = this.options.noShrink ? 'oversized '.repeat(9000) : 'Checkpoint: preserve pending task, continue after completed preparation.'
      yield { type: 'block-start', index: 0, blockType: 'text' }
      yield { type: 'block-end', index: 0, block: { type: 'text', text } }
      this.order.push('summary-finish')
      yield { type: 'finish', reason: { kind: 'stop' } }; return
    }
    this.order.push('main'); this.requests.push(options)
    if (this.options.reportUsage) yield { type: 'usage', usage: { inputTokens: 1200, outputTokens: 40, cacheReadTokens: 300 } }
    if (this.options.overflow && this.requests.length === 1) {
      yield { type: 'finish', reason: { kind: 'error', failure: { code: 'CONTEXT_WINDOW_EXCEEDED', message: 'provider window exhausted' } } }; return
    }
    if (this.options.tools && this.requests.length === 1) {
      yield { type: 'block-start', index: 0, blockType: 'tool-call' }
      yield { type: 'block-end', index: 0, block: { type: 'tool-call', id: ToolCallId('work-1'), name: 'work', arguments: '{}' } }
      yield { type: 'finish', reason: { kind: 'tool-calls' } }; return
    }
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'block-end', index: 0, block: { type: 'text', text: 'done' } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

function history(length = 31600) {
  const session = Session.create(SessionId('seed'))
  session.append('turn/start', { turn: 1 })
  session.append('step/start', { turn: 1, step: 1 })
  // Real sessions reserve surface node zero for the system prompt. Omitting
  // that head can pass in-memory replay but fails the persisted V4 decoder.
  session.append('system/message', { turn: 1, step: 1, message: createMessage({ role: 'system', content: [], source: { kind: 'system-prompt' } }) }, { surfaceOp: 'append' })
  session.append('user/message', createUserMessage({ content: [{ type: 'text', text: 'h'.repeat(length) }], source: { kind: 'user' } }), { surfaceOp: 'append' })
  session.append('assistant/message', { stream: [], turn: 1, step: 1, message: createMessage({ role: 'assistant', content: [{ type: 'text', text: 'previous work done' }], source: { kind: 'model', provider: 'mock', model: 'large' } }) }, { surfaceOp: 'append' })
  session.append('step/end', { turn: 1, step: 1 })
  session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
  return session.snapshotEvents()
}

async function fixture(options = {}, policy = {}, seed = history()) {
  const ctx = new Context()
  await mountAgentLoopTestDependencies(ctx)
  await ctx.plugin(AgentLoop, { agents: [] })
  await ctx.plugin(TokenMeter)
  await ctx.plugin(Retry)
  await ctx.plugin(Manager, { policy: { ...defaults, summaryMaxTokens: 512, ...policy } })
  await ctx.plugin(Engine)
  if (options.presets) {
    ctx.baseUrl = new URL('../', import.meta.url).href
    await ctx.plugin(Loader); ctx.loader.builtins.group = Group
    await ctx.plugin(AgentPresets, { default: 'one' })
    for (const id of ['one', 'two']) await ctx.plugin({ inject: ['agentPresets'], async *apply(child) {
      yield await child.agentPresets.register({ id, plugins: [{ name: 'cordis:group', group: true, isolate: { compaction: true }, config: [{ name: new URL('../lib/engine.js', import.meta.url).href }] }] })
    } })
  }
  const adapter = new Adapter(options)
  ctx.llm.registerAdapter(['mock'], adapter)
  ctx.tools.register(defineContentToolFixture({ name: 'work', description: 'Count work', parameters: {}, async execute() { adapter.work++; adapter.order.push('tool'); return [{ type: 'text', text: options.toolOutput ?? 'tool complete' }] } }))
  const { agent } = await ctx.agentLoop.createAgent(ctx, { sessionId: SessionId('subject'), seed, agentOptions: { provider: 'mock', model: 'large' }, ...(options.presets ? { setup: async agentCtx => { await ctx.agentPresets.mount(agentCtx, 'one') } } : {}) })
  return { ctx, adapter, agent }
}
const message = (text = '请完成当前任务；不要改动无关文件。') => createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } })
const completed = agent => assert.equal(agent.session.snapshotEvents().at(-1).data.reason.kind, 'completed')

test('offline diagnostic fixture reports usage and retains replayable real-loop history', async () => {
  const { ctx, agent } = await fixture({ tools: true, reportUsage: true })
  try {
    agent.followup(message()); await agent.whenIdle(); completed(agent)
    const values = ctx.sessionProjections.snapshot(agent.session).values
    assert.equal(values.contextManagerDiagnostics.requests.length, 2)
    assert.equal(values.contextManagerDiagnostics.requests[0].input, 1500)
    assert.equal(values.contextPressure.pressureTokens, 1500)
    const restore = sessionFormatCatalog.createRestore({ type: 'session', version: 4, id: 'offline-fixture', createdAt: 1, delegationDepth: 0, isSeeded: false }, { recovery: 'strict', validation: 'current' })
    for (const event of agent.session.snapshotEvents()) restore.decodeRow(JSON.parse(JSON.stringify(sessionFormatCatalog.encodeCurrentEvent(event))))
    assert.equal(restore.finish().events.length, agent.session.snapshotEvents().length)
    writeFileSync(new URL('../verification/synthetic-session.json', import.meta.url), JSON.stringify({
      provenance: 'Synthetic adapter, real AgentLoop. No API calls or user conversation data.',
      events: agent.session.snapshotEvents(),
    }, null, 2) + '\n')
  } finally { await ctx.fiber.dispose() }
})

test('79.9% is inside the early admission boundary; output reservation can lower it', () => {
  assert.equal(budget(defaults, 100000, 8000).admission, 79000)
  assert.ok(79900 >= budget(defaults, 100000, 8000).admission)
  assert.equal(budget(defaults, 100000, 25000).admission, 72000)
  assert.throws(() => validatePolicy({ ...defaults, targetPercent: 75 }))
})

test('real loop: summary settles before the first main call and tool; current task is unchanged and enters once', { timeout: 8000 }, async () => {
  const { ctx, adapter, agent } = await fixture({ tools: true })
  try {
    const task = message(); agent.followup(task); await agent.whenIdle()
    assert.deepEqual(adapter.order, ['summary-start', 'summary-finish', 'main', 'tool', 'main'])
    assert.equal(adapter.work, 1)
    assert.equal(agent.session.snapshotEvents().filter(e => e.type === 'user/message' && e.data.id === task.id).length, 1)
    assert.deepEqual(adapter.requests[0].messages.find(m => m.id === task.id)?.content, task.content)
    assert.equal(agent.session.snapshotEvents().filter(e => e.type === 'compaction/summary').length, 1)
    const live = ctx.sessionProjections.snapshot(agent.session).values.contextManagerDiagnostics
    assert.equal(live.compactions.length, 1)
    assert.equal(live.compactions[0].status, 'completed')
    assert.equal(live.compactions[0].applied, true)
    assert.ok(live.compactions[0].beforeTokens > live.compactions[0].afterTokens)
    const replay = agent.session.snapshotEvents().reduce(diagnosticsProjection.apply, diagnosticsProjection.init())
    assert.deepEqual(diagnosticsProjection.wire.view(replay), live, 'fresh replay reproduces live diagnostics')
    completed(agent)
  } finally { await ctx.fiber.dispose() }
})

for (const kind of ['fail', 'noShrink']) test(`real loop: ${kind} pauses without business calls or unbounded retry`, { timeout: 8000 }, async () => {
  const { ctx, adapter, agent } = await fixture({ [kind]: true })
  try {
    const task = message(); agent.followup(task); await agent.whenIdle()
    assert.equal(adapter.requests.length, 0); assert.equal(adapter.work, 0); assert.equal(adapter.summaries.length, 1)
    assert.ok(agent.session.deriveMessages().some(m => m.id === task.id))
    assert.equal(agent.session.snapshotEvents().filter(e => e.type === 'compaction/summary').length, 0)
    const view = ctx.sessionProjections.snapshot(agent.session).values.contextManagerDiagnostics
    assert.equal(view.compactions[0].status, 'failed')
    assert.equal(view.compactions[0].applied, false)
  } finally { await ctx.fiber.dispose() }
})

test('real loop: cancelling the summary keeps the new task and never starts work', { timeout: 8000 }, async () => {
  let started; const entered = new Promise(resolve => { started = resolve })
  const { ctx, adapter, agent } = await fixture({ pause: signal => new Promise((resolve, reject) => { started(); signal.addEventListener('abort', () => reject(signal.reason), { once: true }) }) })
  try {
    const task = message(); agent.followup(task); await entered
    assert.equal(adapter.requests.length, 0); assert.equal(adapter.work, 0)
    agent.cancel('user'); await agent.whenIdle()
    assert.equal(adapter.requests.length, 0); assert.ok(agent.session.deriveMessages().some(m => m.id === task.id))
  } finally { await ctx.fiber.dispose() }
})

test('real loop: below threshold does not summarize', { timeout: 8000 }, async () => {
  const { ctx, adapter, agent } = await fixture({}, {}, history(2000))
  try { agent.followup(message()); await agent.whenIdle(); assert.equal(adapter.summaries.length, 0); assert.equal(adapter.requests.length, 1); completed(agent) }
  finally { await ctx.fiber.dispose() }
})

test('real loop: actual request route and reasoning effort are inherited by summary', { timeout: 8000 }, async () => {
  const { ctx, adapter, agent } = await fixture({}, {}, history(19000))
  ctx.on('agent/request', async (_payload, next) => ({ ...await next(), provider: 'mock', model: 'small', reasoningEffort: 'high' }))
  try {
    agent.followup(message()); await agent.whenIdle()
    assert.equal(adapter.summaries.length, 1); assert.equal(adapter.summaries[0].model, 'small'); assert.equal(adapter.summaries[0].reasoningEffort, 'high'); completed(agent)
  } finally { await ctx.fiber.dispose() }
})

test('real loop: oversized new task pauses and is never summarized away', { timeout: 8000 }, async () => {
  const { ctx, adapter, agent } = await fixture({}, {}, history(2000))
  try {
    const task = message('巨大新任务'.repeat(15000)); agent.followup(task); await agent.whenIdle()
    assert.equal(adapter.requests.length, 0); assert.ok(adapter.summaries.length <= 2)
    assert.deepEqual(agent.session.deriveMessages().find(m => m.id === task.id).content, task.content)
  } finally { await ctx.fiber.dispose() }
})

test('real preset scopes: two simultaneous sessions each compact exactly once, without root-engine duplication', { timeout: 8000 }, async () => {
  const { ctx, adapter, agent } = await fixture({ presets: true })
  try {
    assert.ok((await ctx.agentPresets.list()).every(p => !p.broken))
    const { agent: second } = await ctx.agentLoop.createAgent(ctx, { sessionId: SessionId('second'), seed: history(), agentOptions: { provider: 'mock', model: 'large' }, setup: async child => { await ctx.agentPresets.mount(child, 'two') } })
    agent.followup(message('任务一')); second.followup(message('任务二'))
    await Promise.all([agent.whenIdle(), second.whenIdle()])
    assert.equal(adapter.summaries.length, 2); assert.equal(adapter.requests.length, 2)
    for (const subject of [agent, second]) { assert.equal(subject.session.snapshotEvents().filter(e => e.type === 'compaction/summary').length, 1); completed(subject) }
  } finally { await ctx.fiber.dispose() }
})

test('real loop: tool growth is checked again before the next model request', { timeout: 8000 }, async () => {
  const { ctx, adapter, agent } = await fixture({ tools: true, toolOutput: 'result '.repeat(4500) }, {}, history(1000))
  try {
    const task = message(); agent.followup(task); await agent.whenIdle()
    assert.equal(adapter.requests.length, 2)
    assert.deepEqual(adapter.order, ['main', 'tool', 'summary-start', 'summary-finish', 'main'])
    assert.ok(agent.session.deriveMessages().some(m => m.id === task.id))
    assert.ok(adapter.summaries.length <= 2)
    completed(agent)
  } finally { await ctx.fiber.dispose() }
})

test('real loop: exactly 79.9% before new input compacts before any business call', { timeout: 8000 }, async () => {
  // Two content blocks/roles (16) plus the five-token historical response.
  const { ctx, adapter, agent } = await fixture({}, {}, history((7990 - 21) * 4))
  try {
    assert.equal(ctx.tokenMeter.measure(agent.session).totalTokens, 7990)
    agent.followup(message()); await agent.whenIdle()
    assert.deepEqual(adapter.order, ['summary-start', 'summary-finish', 'main']); completed(agent)
  } finally { await ctx.fiber.dispose() }
})

test('real loop: new image pricing participates in admission and its reference survives compaction', { timeout: 8000 }, async () => {
  const { ctx, adapter, agent } = await fixture({}, {}, history(6000))
  try {
    const image = { type: 'image', attachment: { attachmentId: 'sha256:12345678', mediaType: 'image/png', bytes: 2048, width: 800, height: 800, name: 'diagram.png' } }
    const task = createUserMessage({ content: [{ type: 'text', text: '分析图片，并继续原任务' }, image], source: { kind: 'user' } })
    agent.followup(task); await agent.whenIdle()
    assert.deepEqual(adapter.order, ['summary-start', 'summary-finish', 'main'])
    assert.deepEqual(adapter.requests[0].messages.find(m => m.id === task.id)?.content, task.content)
    completed(agent)
  } finally { await ctx.fiber.dispose() }
})

test('real loop: provider-confirmed overflow below the estimate uses bounded recovery', { timeout: 8000 }, async () => {
  const { ctx, adapter, agent } = await fixture({ overflow: true }, {}, history(14000))
  try {
    agent.followup(message()); await agent.whenIdle()
    assert.deepEqual(adapter.order, ['main', 'summary-start', 'summary-finish', 'main']); completed(agent)
  } finally { await ctx.fiber.dispose() }
})

test('real loop: successful compacted history can be replayed by a fresh Agent', { timeout: 8000 }, async () => {
  const { ctx, adapter, agent } = await fixture()
  try {
    agent.followup(message()); await agent.whenIdle(); completed(agent)
    const { agent: resumed } = await ctx.agentLoop.createAgent(ctx, { sessionId: SessionId('resumed'), seed: agent.session.snapshotEvents(), agentOptions: { provider: 'mock', model: 'large' } })
    resumed.followup(message('继续')); await resumed.whenIdle(); completed(resumed)
    assert.equal(adapter.summaries.length, 1); assert.equal(adapter.requests.length, 2)
  } finally { await ctx.fiber.dispose() }
})
