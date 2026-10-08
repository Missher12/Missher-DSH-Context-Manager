import { test } from 'node:test'
import assert from 'node:assert/strict'
import { setImmediate as immediate } from 'node:timers/promises'
import { createVolatile, updateVolatile } from '@deepseek-ai/cosmokit'
import { writeFileSync } from 'node:fs'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { zstdCompressSync, zstdDecompressSync } from 'node:zlib'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Storage from '@deepseek-ai/dsh-storage'
import * as StorageJson from '@deepseek-ai/dsh-storage-json'
import * as StorageDomain from '@deepseek-ai/dsh-storage-domain'
import { Context } from '@deepseek-ai/cordis'
import { LlmAdapter, createUserMessage, createMessage, createToolResultMessage, ToolCallId, resolveRetryPolicy } from '@deepseek-ai/dsh-llm'
import { Session, SessionId, SessionLogOffset } from '@deepseek-ai/dsh-session'
import { sessionFormatCatalog } from '@deepseek-ai/dsh-session-format-catalog'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import TokenMeter from '@deepseek-ai/dsh-token-meter'
import ToolResultPruner from '@deepseek-ai/dsh-compaction-tool-result-pruner'
import { BasicCompactionEngine } from '@deepseek-ai/dsh-compaction-basic'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import { defineContentToolFixture } from '@deepseek-ai/dsh-tools'
import * as Retry from '@deepseek-ai/dsh-llm-retry'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Group from '@deepseek-ai/cordis-plugin-group'
import AgentPresets from '@deepseek-ai/dsh-agent-preset-registry'
import Manager from '../lib/index.js'
import Engine from '../lib/engine.js'
import { pressureHistory } from '../lib/inspector.js'
import { defaults, budget, validatePolicy } from '../lib/policy.js'
import { diagnosticsProjection } from '../lib/diagnostics.js'

class Adapter extends LlmAdapter {
  order = []; requests = []; summaries = []; work = 0
  constructor(options = {}) { super(); this.options = options }
  async resolveModel(provider, model) { return { provider, id: model, name: model, context: { contextWindow: model === 'small' ? 6000 : this.options.contextWindow ?? 10000 }, reasoning: { efforts: [{ id: 'high', name: 'High' }] } } }
  imageRequestPricing() { return { priceImages: images => images.map(() => ({ visualTokens: 7000, text: 'image handle' })) } }
  providerRetryPolicy() { return resolveRetryPolicy(this.options.mainFail ? { mode: 'normal', maxRetries: 0 } : { mode: 'always', backoff: { initialDelayMs: 1, maxDelayMs: 1, jitterRatio: 0 } }, 'test') }
  async *stream(options) {
    if (options.purpose === 'compaction') {
      this.order.push('summary-start'); this.summaries.push(options)
      if (this.options.pause) await this.options.pause(options.signal)
      if (this.options.fail) { yield { type: 'finish', reason: { kind: 'error', failure: { code: 'SERVER', message: 'summary unavailable' } } }; return }
      const text = this.options.malformed ? 'incomplete checkpoint' : JSON.stringify({ goal: 'Preserve the pending task', constraints: ['Keep authorization boundaries'], completed: ['Preparation complete'], pending: ['Continue current task'], evidence: this.options.noShrink ? ['oversized '.repeat(5000)] : [], next: 'Continue after completed preparation', uncertainties: [] })
      yield { type: 'block-start', index: 0, blockType: 'text' }
      yield { type: 'block-end', index: 0, block: { type: 'text', text } }
      yield { type: 'usage', usage: { inputTokens: 500, cacheReadTokens: 250, outputTokens: 20 } }
      this.order.push('summary-finish')
      yield { type: 'finish', reason: { kind: 'stop' } }; return
    }
    this.order.push('main'); this.requests.push(options)
    if (this.options.mainFail) { yield { type: 'finish', reason: { kind: 'error', failure: { code: 'BAD_REQUEST', message: 'fixture failure' } } }; return }
    if (this.options.mainPause) await this.options.mainPause(options.signal)
    if (this.options.reportUsage) yield { type: 'usage', usage: { inputTokens: this.options.usageInput ?? 1200, outputTokens: 40, cacheReadTokens: 300 } }
    if (this.options.overflow && this.requests.length === 1) {
      yield { type: 'finish', reason: { kind: 'error', failure: { code: 'CONTEXT_WINDOW_EXCEEDED', message: 'provider window exhausted' } } }; return
    }
    if ((this.options.tools && this.requests.length === 1) || this.requests.length <= (this.options.toolOutputs?.length ?? 0)) {
      yield { type: 'block-start', index: 0, blockType: 'tool-call' }
      yield { type: 'block-end', index: 0, block: { type: 'tool-call', id: ToolCallId(`work-${this.requests.length}`), name: 'work', arguments: '{}' } }
      yield { type: 'finish', reason: { kind: 'tool-calls' } }; return
    }
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'block-end', index: 0, block: { type: 'text', text: 'done' } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

function history(length = 31600, asSession = false) {
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
  return asSession ? session : session.snapshotEvents()
}

async function fixture(options = {}, policy = {}, seed = history()) {
  const ctx = new Context()
  const storageRoot = await mkdtemp(join(tmpdir(), 'dsh-context-loop-'))
  ctx.effect(() => () => rm(storageRoot, { recursive: true, force: true }))
  await ctx.plugin(Storage)
  await ctx.plugin(StorageJson, { root: storageRoot })
  await ctx.plugin(StorageDomain, { backend: 'json' })
  await mountAgentLoopTestDependencies(ctx)
  await ctx.plugin(AgentLoop, { agents: [] })
  await ctx.plugin(TokenMeter)
  await ctx.plugin(Retry)
  if (options.pruner) await ctx.plugin(ToolResultPruner, { thresholdChars: 2000, headChars: 600, tailChars: 400 })
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
  ctx.tools.register(defineContentToolFixture({ name: 'work', description: 'Count work', parameters: {}, async execute() { adapter.work++; adapter.order.push('tool'); return [{ type: 'text', text: options.toolOutputs?.[adapter.work - 1] ?? options.toolOutput ?? 'tool complete' }] } }))
  const { agent } = await ctx.agentLoop.createAgent(ctx, { sessionId: SessionId('subject'), seed, agentOptions: { provider: 'mock', model: 'large' },
    meta: { delegationDepth: options.seeded ? 1 : 0, ...(options.seeded ? { isSeeded: true, parentSession: SessionId('seed') } : {}) },
    ...(options.seeded ? { inheritedEventCount: SessionLogOffset(seed.length) } : {}),
    ...(options.presets ? { setup: async agentCtx => { await ctx.agentPresets.mount(agentCtx, 'one') } } : {}) })
  return { ctx, adapter, agent }
}
const message = (text = '请完成当前任务；不要改动无关文件。') => createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } })
const completed = agent => assert.equal(agent.session.snapshotEvents().at(-1).data.reason.kind, 'completed')

// A valid in-memory surface does not establish that the persisted event log can
// be opened. Exercise the physical V4 encoder, a complete Zstandard frame on
// disk, the strict installed decoder and detached Session restoration together.
async function assertPhysicalSessionRestore(session) {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-context-v4-roundtrip-'))
  try {
    const events = session.snapshotEvents()
    const header = sessionFormatCatalog.encodeCurrentHeader(session.header, session.inheritedEventCount)
    const rows = [header, ...events.map(event => sessionFormatCatalog.encodeCurrentEvent(event))]
    const bytes = Buffer.from(rows.map(row => JSON.stringify(row)).join('\n') + '\n')
    const file = join(dir, 'session.v4.jsonl.zstd')
    // This fixture deliberately stores one complete frame. A one-shot decoder
    // must not be used for a real log containing multiple appended frames.
    await writeFile(file, zstdCompressSync(bytes), { flag: 'wx' })
    const decoded = zstdDecompressSync(await readFile(file))
    assert.deepEqual(decoded, bytes, 'the complete physical log, not only its header, was decoded')
    const lines = decoded.toString('utf8').trimEnd().split('\n')
    assert.equal(lines.length, events.length + 1)
    const restore = sessionFormatCatalog.createRestore(JSON.parse(lines[0]), { recovery: 'strict', validation: 'current' })
    for (const line of lines.slice(1)) restore.decodeRow(JSON.parse(line))
    const artifact = restore.finish()
    assert.equal(artifact.events.length, events.length)
    assert.equal(artifact.inheritedEventCount, session.inheritedEventCount, 'preserve the real inherited prefix')
    assert.deepEqual(artifact.header, session.header)
    const reopened = Session.fromRestore(SessionId(artifact.header.id), artifact.events, artifact.header,
      SessionLogOffset(artifact.inheritedEventCount), 'detached')
    assert.deepEqual(reopened.snapshotEvents().slice(0, events.length), events)
    assert.deepEqual(reopened.deriveMessages(), session.deriveMessages())
    return reopened
  } finally { await rm(dir, { recursive: true, force: true }) }
}

const idleState = (ctx, agent) => ctx.contextManager.idleStatus(agent.id)
async function drainUntil(predicate) {
  const until = performance.now() + 4000
  while (performance.now() < until) { if (predicate()) return; await immediate() }
  assert.ok(predicate(), 'asynchronous maintenance did not settle')
}
function clock(t) { t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: Date.now() }) }
function changePolicy(ctx, patch) {
  updateVolatile(ctx.contextManager.config.policy, createVolatile({ ...ctx.contextManager.snapshot(), ...patch }))
  ctx.emit('settings/document-updated', 'context-manager', 2)
}

test('idle: old policy gains safe defaults and rejects invalid idle settings', () => {
  const { idleEnabled, idleMinutes, idleMinPercent, summaryInstructions, ...legacy } = defaults
  assert.deepEqual(Manager.Config({ policy: legacy }).policy.get(), defaults)
  for (const patch of [{ idleMinutes: 0 }, { idleMinutes: 1.5 }, { idleMinPercent: 96 }, { summaryInstructions: 'x'.repeat(2001) }]) {
    assert.throws(() => validatePolicy({ ...defaults, ...patch }))
  }
})

test('idle: restored history is dormant; a completed task arms exactly one maintenance pass with usage', { timeout: 8000 }, async t => {
  const { ctx, adapter, agent } = await fixture({}, { summaryInstructions: '保留验收命令与失败原因' }, history(28000))
  clock(t)
  try {
    assert.equal(idleState(ctx, agent).status, 'waiting')
    t.mock.timers.tick(900000); await immediate()
    assert.equal(adapter.summaries.length, 0)
    agent.followup(message()); await agent.whenIdle(); await drainUntil(() => ['scheduled', 'off'].includes(idleState(ctx, agent).status))
    assert.equal(idleState(ctx, agent).status, 'scheduled')
    t.mock.timers.tick(899999); await immediate(); assert.equal(adapter.summaries.length, 0)
    t.mock.timers.tick(1)
    await drainUntil(() => idleState(ctx, agent).status === 'completed')
    assert.deepEqual(adapter.order, ['main', 'summary-start', 'summary-finish'])
    assert.ok(JSON.stringify(adapter.summaries[0].messages).includes('保留验收命令与失败原因'))
    assert.equal(adapter.summaries[0].provider, 'mock')
    assert.ok(idleState(ctx, agent).afterTokens < idleState(ctx, agent).beforeTokens)
    const diagnostics = ctx.sessionProjections.snapshot(agent.session).values.contextManagerDiagnostics
    assert.equal(diagnostics.compactions[0].inputTokens, 750)
    assert.equal(diagnostics.compactions[0].outputTokens, 20)
    assert.equal(diagnostics.compactions[0].manual, true, 'between-turn compaction uses the host null-turn scope')
    const restore = sessionFormatCatalog.createRestore({ type: 'session', version: 4, id: 'idle-fixture', createdAt: 1, delegationDepth: 0, isSeeded: false }, { recovery: 'strict', validation: 'current' })
    for (const event of agent.session.snapshotEvents()) restore.decodeRow(JSON.parse(JSON.stringify(sessionFormatCatalog.encodeCurrentEvent(event))))
    assert.equal(restore.finish().events.length, agent.session.snapshotEvents().length)
    t.mock.timers.tick(86400000); await immediate()
    assert.equal(adapter.summaries.length, 1)
  } finally { await ctx.fiber.dispose() }
})

test('idle: short context and running background work skip model use', { timeout: 8000 }, async t => {
  clock(t)
  for (const background of [false, true]) {
    const { ctx, adapter, agent } = await fixture({}, {}, history(background ? 28000 : 2000))
    if (background) ctx.on('workspace/session-activity', async () => [{ kind: 'background', label: 'fixture work' }])
    try {
      agent.followup(message()); await agent.whenIdle(); await drainUntil(() => ['scheduled', 'off'].includes(idleState(ctx, agent).status)); t.mock.timers.tick(900000)
      if (background) {
        for (let i = 0; i < 3; i++) {
          await drainUntil(() => idleState(ctx, agent).status === 'scheduled')
          t.mock.timers.tick(30000)
        }
      }
      await drainUntil(() => idleState(ctx, agent).status === 'skipped')
      assert.equal(adapter.summaries.length, 0)
      assert.match(idleState(ctx, agent).message, background ? /后台/ : /未达到/)
    } finally { await ctx.fiber.dispose() }
  }
})

test('idle: failed and cancelled tasks never arm a timer', { timeout: 8000 }, async t => {
  clock(t)
  for (const cancel of [false, true]) {
    let enter; const entered = new Promise(resolve => { enter = resolve })
    const { ctx, adapter, agent } = await fixture(cancel ? { mainPause: signal => new Promise((_resolve, reject) => {
      enter(); signal.addEventListener('abort', () => reject(signal.reason), { once: true })
    }) } : { mainFail: true }, {}, history(28000))
    try {
      agent.followup(message())
      if (cancel) { await entered; agent.cancel({ kind: 'user' }) }
      await agent.whenIdle(); assert.notEqual(idleState(ctx, agent).status, 'scheduled')
      t.mock.timers.tick(900000); await immediate(); assert.equal(adapter.summaries.length, 0)
    } finally { await ctx.fiber.dispose() }
  }
})

test('idle: new input cancels in-flight summary and resumes that exact task once', { timeout: 8000 }, async t => {
  let enter; const entered = new Promise(resolve => { enter = resolve })
  const { ctx, adapter, agent } = await fixture({ pause: signal => new Promise((_resolve, reject) => {
    enter(); signal.addEventListener('abort', () => reject(signal.reason), { once: true })
  }) }, {}, history(28000))
  clock(t)
  try {
    agent.followup(message()); await agent.whenIdle(); await drainUntil(() => ['scheduled', 'off'].includes(idleState(ctx, agent).status)); t.mock.timers.tick(900000); await entered
    assert.equal(idleState(ctx, agent).status, 'compacting')
    const task = message('新任务必须完整执行一次'); agent.followup(task); await agent.whenIdle()
    await drainUntil(() => idleState(ctx, agent).status === 'scheduled')
    assert.equal(adapter.summaries.length, 1); assert.equal(adapter.requests.length, 2)
    assert.ok(adapter.summaries[0].signal.aborted)
    assert.deepEqual(agent.session.deriveMessages().find(m => m.id === task.id).content, task.content)
    assert.equal(agent.session.snapshotEvents().filter(e => e.type === 'user/message' && e.data.id === task.id).length, 1)
    assert.equal(agent.session.snapshotEvents().filter(e => e.type === 'compaction/summary').length, 0)
  } finally { await ctx.fiber.dispose() }
})

test('idle: live delay edits preserve elapsed idle time and disabling removes the deadline', { timeout: 8000 }, async t => {
  const { ctx, adapter, agent } = await fixture({}, {}, history(28000)); clock(t)
  try {
    agent.followup(message()); await agent.whenIdle(); await drainUntil(() => ['scheduled', 'off'].includes(idleState(ctx, agent).status))
    const due = idleState(ctx, agent).dueAt
    t.mock.timers.tick(600000); changePolicy(ctx, { idleMinutes: 20 })
    assert.equal(idleState(ctx, agent).dueAt, due + 300000)
    t.mock.timers.tick(300000); await immediate(); assert.equal(adapter.summaries.length, 0)
    changePolicy(ctx, { idleEnabled: false })
    t.mock.timers.tick(300000); await immediate(); assert.equal(idleState(ctx, agent).status, 'off')
    assert.equal(adapter.summaries.length, 0)
  } finally { await ctx.fiber.dispose() }
})

test('idle: lengthening delay during async safety checks re-arms a valid completed task', { timeout: 8000 }, async t => {
  const { ctx, adapter, agent } = await fixture({}, {}, history(28000)); clock(t)
  let release; let checks = 0
  ctx.on('workspace/session-activity', async () => { if (++checks === 1) await new Promise(resolve => { release = resolve }); return [] })
  try {
    agent.followup(message()); await agent.whenIdle(); await drainUntil(() => ['scheduled', 'off'].includes(idleState(ctx, agent).status)); t.mock.timers.tick(900000)
    await drainUntil(() => !!release)
    changePolicy(ctx, { idleMinutes: 20 }); release()
    await drainUntil(() => idleState(ctx, agent).status === 'scheduled')
    assert.equal(adapter.summaries.length, 0)
    t.mock.timers.tick(300000); await drainUntil(() => idleState(ctx, agent).status === 'completed')
    assert.equal(adapter.summaries.length, 1)
  } finally { await ctx.fiber.dispose() }
})

for (const kind of ['fail', 'noShrink', 'malformed']) test(`idle: ${kind} keeps original context and never loops`, { timeout: 8000 }, async t => {
  const { ctx, adapter, agent } = await fixture({ [kind]: true }, {}, history(28000)); clock(t)
  try {
    agent.followup(message()); await agent.whenIdle(); await drainUntil(() => ['scheduled', 'off'].includes(idleState(ctx, agent).status)); const before = agent.session.deriveMessages()
    t.mock.timers.tick(900000); await drainUntil(() => idleState(ctx, agent).status === 'failed')
    assert.deepEqual(agent.session.deriveMessages(), before)
    // None of these failures is a value-level type mismatch, so no repair call
    // is allowed: error finishes, prose and size failures all stop after one
    // bounded attempt and keep the original context.
    t.mock.timers.tick(86400000); await immediate(); assert.equal(adapter.summaries.length, 1)
    assert.equal(adapter.requests.length, 1)
  } finally { await ctx.fiber.dispose() }
})

test('idle: disposal cancels an unresponsive activity provider without starting a model call', { timeout: 8000 }, async t => {
  const { ctx, adapter, agent } = await fixture({}, {}, history(28000)); clock(t)
  ctx.on('workspace/session-activity', async () => new Promise(() => {}))
  agent.followup(message()); await agent.whenIdle(); await drainUntil(() => ['scheduled', 'off'].includes(idleState(ctx, agent).status)); t.mock.timers.tick(900000)
  await drainUntil(() => idleState(ctx, agent).status === 'checking')
  await ctx.fiber.dispose()
  assert.equal(adapter.summaries.length, 0)
})

test('idle: isolated preset owns its timer without a duplicate root engine', { timeout: 8000 }, async t => {
  const { ctx, adapter, agent } = await fixture({ presets: true }, {}, history(28000)); clock(t)
  try {
    agent.followup(message()); await agent.whenIdle(); await drainUntil(() => ['scheduled', 'off'].includes(idleState(ctx, agent).status)); t.mock.timers.tick(900000)
    await drainUntil(() => idleState(ctx, agent).status === 'completed')
    assert.equal(adapter.summaries.length, 1)
  } finally { await ctx.fiber.dispose() }
})

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
      testSource: 'Synthetic adapter, real AgentLoop. No API calls or user conversation data.',
      events: agent.session.snapshotEvents(),
    }, null, 2) + '\n')
  } finally { await ctx.fiber.dispose() }
})

test('79.9% is inside the early admission boundary; output reservation can lower it', () => {
  assert.equal(budget(defaults, 100000, 8000).admission, 79000)
  assert.ok(79900 >= budget(defaults, 100000, 8000).admission)
  assert.equal(budget(defaults, 100000, 25000).admission, 72000)
  assert.throws(() => validatePolicy({ ...defaults, historyMode: 'custom', targetPercent: 75 }))
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

for (const kind of ['fail', 'noShrink', 'malformed']) test(`real loop: ${kind} pauses without business calls or unbounded retry`, { timeout: 8000 }, async () => {
  const { ctx, adapter, agent } = await fixture({ [kind]: true })
  try {
    const task = message(); agent.followup(task); await agent.whenIdle()
    // Error finishes, prose and size failures are not value-level type
    // mismatches, so the narrow repair is never offered: exactly one attempt.
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
    agent.cancel({ kind: 'user' }); await agent.whenIdle()
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

test('real loop: source growth permits an older large region after compacting the later tool region', { timeout: 12000 }, async () => {
  // At 200K, admission is 158K. The initial 80K history + protected 40K
  // task fits. Exactly two tool calls add 100K, then 45K: the first pressure
  // selects the later 100K group, the second selects the older 80K region.
  const seed = history(320000)
  const oldUser = seed.find(event => event.type === 'user/message')
  assert.ok(oldUser)
  const { ctx, adapter, agent } = await fixture({ contextWindow: 200000,
    toolOutputs: ['FIRST-TOOL-OUTPUT\n' + 'a'.repeat(400000), 'SECOND-TOOL-OUTPUT\n' + 'b'.repeat(180000)] },
  { historyMode: 'automatic', recentTokens: 20000, idleEnabled: false }, seed)
  const permits = []
  ctx.on('llm/stream', async function* (options, next) {
    if (options.purpose === 'compaction') permits.push(ctx.contextManager.compactionCycles.peek(String(agent.id)))
    yield* next()
  }, true)
  try {
    const task = message('CURRENT-TASK-MUST-STAY-VERBATIM\n' + 't'.repeat(160000))
    agent.followup(task)
    await agent.whenIdle()
    completed(agent)
    assert.equal(adapter.work, 2, 'the finite fixture executes exactly two tools')
    assert.equal(adapter.requests.length, 3, 'the third business response finishes without another tool')
    assert.equal(adapter.summaries.length, 2, 'each of the two distinct pressured regions needs one summary')
    assert.deepEqual(adapter.order, ['main', 'tool', 'summary-start', 'summary-finish',
      'main', 'tool', 'summary-start', 'summary-finish', 'main'])

    const events = agent.session.snapshotEvents()
    const taskEvent = events.find(event => event.type === 'user/message' && event.data.id === task.id)
    const results = events.filter(event => event.type === 'tool/result' && event.surfaceOp === 'append')
    const summaries = events.filter(event => event.type === 'compaction/summary')
    assert.ok(taskEvent)
    assert.equal(results.length, 2)
    assert.equal(summaries.length, 2, 'both paid results commit; no stale-source refusal')
    assert.ok(summaries[0].data.shadowedSeqs.includes(results[0].seq))
    assert.ok(summaries[0].data.shadowedSeqs.every(seq => seq > taskEvent.seq), 'first plan is after the protected task')
    assert.ok(summaries[1].data.shadowedSeqs.includes(oldUser.seq))
    assert.ok(summaries[1].data.shadowedSeqs.every(seq => seq < taskEvent.seq), 'second plan returns to the older region')
    assert.ok(!summaries[1].data.shadowedSeqs.includes(results[1].seq), 'new tool output is not falsely counted as the selected old region')
    const retained = agent.session.deriveMessages().filter(item => item.id === task.id)
    assert.equal(retained.length, 1)
    assert.deepEqual(retained[0].content, task.content)

    assert.equal(permits.length, 2)
    assert.equal(permits[0].cycle, 1)
    assert.equal(permits[0].sourceWatermark, results[0].seq)
    assert.equal(permits[1].cycle, 2, 'the newly added 45K satisfies the new-content requirement')
    assert.equal(permits[1].sourceWatermark, results[1].seq, 'cycle watermarks follow the whole session, not selection order')
    assert.equal(permits[1].calls, 1)
    const usage = ctx.contextManager.summaryLedger.stats(String(agent.id))
    assert.equal(usage.attempts, 2)
    assert.equal(usage.input, 1500, 'two 500 input + 250 cache-read attempts are counted exactly once')
    assert.equal(usage.output, 40)
    assert.ok(ctx.tokenMeter.measure(agent.session).totalTokens < budget(ctx.contextManager.snapshot(), 200000, 0).admission)
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


test('projection trend replays genuine loop cuts and compaction drops without changing the Session', async () => {
  const { ctx, agent, adapter } = await fixture({ reportUsage: true, usageInput: 7800 }, { enabled: false }, history(28000))
  const snapshot = () => ({ events: agent.session.snapshotEvents(), header: agent.session.header, inheritedEventCount: agent.session.inheritedEventCount })
  try {
    const initial = snapshot()
    assert.ok(pressureHistory(ctx.sessionProjections, initial, initial.events.length - 1, AbortSignal.timeout(1000)).every(point => point.tokens === null), 'no usage does not invent a zero anchor')
    agent.followup(message()); await agent.whenIdle(); completed(agent)
    changePolicy(ctx, { enabled: true })
    agent.followup(message('继续完成')); await agent.whenIdle(); completed(agent)
    assert.equal(adapter.summaries.length, 1)
    const observed = snapshot(), before = JSON.stringify(observed.events)
    const points = pressureHistory(ctx.sessionProjections, observed, observed.events.length - 1, AbortSignal.timeout(3000))
    const replacement = points.findIndex(point => point.kind === 'replace' && point.tokens !== null)
    assert.ok(replacement > 0)
    assert.ok(points[replacement].tokens < points[replacement - 1].tokens, JSON.stringify(points))
    assert.equal(points.at(-1).tokens, ctx.sessionProjections.snapshot(agent.session).values.contextPressure.projectedTokens)
    assert.equal(JSON.stringify(agent.session.snapshotEvents()), before, 'projection history does not mutate or append records')
    writeFileSync(new URL('../verification/trend-session.json', import.meta.url), JSON.stringify({ testSource: 'Synthetic adapter through the real AgentLoop; no live API calls.', ...observed }, null, 2) + '\n')
    const cut = points[replacement].seq
    assert.equal(pressureHistory(ctx.sessionProjections, observed, cut, AbortSignal.timeout(3000)).at(-1).tokens, points[replacement].tokens)
    const cancelled = new AbortController(); cancelled.abort()
    assert.throws(() => pressureHistory(ctx.sessionProjections, observed, cut, cancelled.signal), { name: 'AbortError' })
  } finally { await ctx.fiber.dispose() }
})


test('projection trend bounds the output while folding the complete earlier prefix', async () => {
  const { ctx, agent } = await fixture({ reportUsage: true }, { enabled: false }, history(100))
  try {
    for (let i = 0; i < 42; i++) { agent.followup(message(`step ${i}`)); await agent.whenIdle() }
    const events = agent.session.snapshotEvents()
    const points = pressureHistory(ctx.sessionProjections, { events, header: agent.session.header, inheritedEventCount: agent.session.inheritedEventCount }, events.length - 1, AbortSignal.timeout(3000))
    assert.equal(points.length, 40)
    assert.ok(points[0].seq > 0)
    assert.ok(points.every(point => point.tokens > 0))
    assert.equal(points.at(-1).tokens, ctx.sessionProjections.snapshot(agent.session).values.contextPressure.projectedTokens)
  } finally { await ctx.fiber.dispose() }
})


test('real loop: an adapter ignoring cancellation cannot hold the summary maintenance open', { timeout: 8000 }, async () => {
  let started, release
  const entered = new Promise(resolve => { started = resolve })
  const blocked = new Promise(resolve => { release = resolve })
  const { ctx, adapter, agent } = await fixture({ pause: async () => { started(); await blocked } })
  try {
    const task = message(); agent.followup(task); await entered
    agent.cancel({ kind: 'user' }); await agent.whenIdle()
    assert.equal(adapter.requests.length, 0)
    assert.ok(agent.session.deriveMessages().some(item => item.id === task.id))
    const usage = ctx.contextManager.summaryLedger.stats(String(agent.id))
    assert.equal(usage.attempts, 1)
    assert.equal(usage.unknownAttempts, 1)
    assert.equal(usage.recent[0].status, 'cancelled')
  } finally { release(); await ctx.fiber.dispose() }
})


function toolHistory({ error = false, rich = false, baseSize = 1000 } = {}) {
  const session = history(baseSize, true)
  session.append('turn/start', { turn: 2 })
  session.append('step/start', { turn: 2, step: 1 })
  session.append('user/message', createUserMessage({ content: [{ type: 'text', text: 'Read the old diagnostic output.' }], source: { kind: 'user' } }), { surfaceOp: 'append' })
  const callId = ToolCallId('old-read')
  session.append('assistant/message', { stream: [], turn: 2, step: 1, message: createMessage({ role: 'assistant', source: { kind: 'model', provider: 'mock', model: 'large' }, content: [{ type: 'tool-call', id: callId, name: 'work', arguments: '{}' }] }) }, { surfaceOp: 'append' })
  session.append('tool/call', { turn: 2, step: 1, callId, name: 'work', arguments: '{}' })
  const content = [{ type: 'text', text: 'original evidence '.repeat(2200) }]
  if (rich) content.push({ type: 'image', attachment: { attachmentId: 'sha256:' + 'a'.repeat(64), mediaType: 'image/png', bytes: 1, width: 1, height: 1 } })
  session.append('tool/result', { turn: 2, step: 1, message: createToolResultMessage({ callId, content, isError: error }) }, { surfaceOp: 'append' })
  session.append('step/end', { turn: 2, step: 1 })
  session.append('turn/end', { turn: 2, reason: { kind: 'completed' } })
  return session.snapshotEvents()
}

const idlePrunePolicy = { triggerPercent: 95, earlyPercent: 0, safetyPercent: 1,
  idleMinPercent: 10, recentTokens: 1000 }

for (const scenario of [
  { outcome: 'success', seeded: false }, { outcome: 'success', seeded: true },
  { outcome: 'malformed', seeded: false }, { outcome: 'cancelled', seeded: false },
]) test(`idle pruning regression: manual ${scenario.outcome}${scenario.seeded ? ' with inherited history' : ''} remains reloadable`, { timeout: 12000 }, async t => {
  let entered
  const started = new Promise(resolve => { entered = resolve })
  const pause = signal => new Promise((_resolve, reject) => {
    entered()
    if (signal.aborted) reject(signal.reason)
    else signal.addEventListener('abort', () => reject(signal.reason), { once: true })
  })
  const { ctx, adapter, agent } = await fixture({ pruner: true, contextWindow: 20000,
    seeded: scenario.seeded, malformed: scenario.outcome === 'malformed',
    ...(scenario.outcome === 'cancelled' ? { pause } : {}) },
  { ...idlePrunePolicy, idleEnabled: false }, toolHistory())
  try {
    if (ctx.toolResultPruner.supportsProtectedSeqs !== true) { t.skip('Requires enhanced host protected-pruning contract'); return }
    agent.followup(message()); await agent.whenIdle(); completed(agent)
    assert.equal(adapter.summaries.length, 0, 'preparation must not compact before the idle operation')
    const before = agent.session.snapshotEvents(), surface = agent.session.deriveMessages()
    const original = before.find(event => event.type === 'tool/result')
    assert.ok(ctx.toolResultPruner.pruneContent(original.data.message.content), 'the real text result qualifies for pruning')
    assert.equal(before.findLast(event => event.type === 'turn/start' || event.type === 'turn/end').type, 'turn/end')
    const prune = ctx.toolResultPruner.pruneSession.bind(ctx.toolResultPruner)
    let pruneCalls = 0
    ctx.toolResultPruner.pruneSession = (...args) => { pruneCalls++; return prune(...args) }
    await agent.runMaintenance(async () => {
      assert.equal(ctx.compaction.pruneOlderTools(agent, ctx.tokenMeter.measure(agent.session)), false)
    })
    assert.equal(pruneCalls, 0, 'the no-turn guard must run before calling the mutating pruner')
    assert.deepEqual(agent.session.snapshotEvents(), before, 'the guard must not append even a prune marker')
    const abort = new AbortController()
    const operation = ctx.compaction.compactNow(agent, abort.signal)
    if (scenario.outcome === 'cancelled') {
      const rejected = assert.rejects(operation)
      await started; abort.abort(new Error('cancel idle fixture')); await rejected
    } else if (scenario.outcome === 'malformed') {
      await assert.rejects(operation)
    } else {
      assert.ok(await operation)
    }
    const events = agent.session.snapshotEvents(), added = events.slice(before.length)
    assert.equal(pruneCalls, 0)
    assert.deepEqual(events.slice(0, before.length), before, 'original text and tool lineage stay unchanged')
    assert.equal(added.filter(event => event.type === 'compaction/prune' || event.type === 'tool/result').length, 0)
    assert.equal(added.filter(event => event.type === 'compaction/start').length, 1)
    assert.equal(added.filter(event => event.type === 'compaction/end').length, 1, 'failed/cancelled maintenance closes its bracket')
    assert.equal(added.filter(event => event.type === 'compaction/summary').length, scenario.outcome === 'success' ? 1 : 0)
    assert.equal(adapter.summaries.length, 1)
    if (scenario.outcome !== 'success') assert.deepEqual(agent.session.deriveMessages(), surface)
    const reopened = await assertPhysicalSessionRestore(agent.session)
    assert.equal(reopened.header.isSeeded, scenario.seeded)
    if (scenario.seeded) assert.ok(reopened.inheritedEventCount > 0)
  } finally { await ctx.fiber.dispose() }
})

test('idle pruning regression: timer compacts eligible tool history without a turn-outside replacement and reloads', { timeout: 12000 }, async t => {
  const { ctx, adapter, agent } = await fixture({ pruner: true, contextWindow: 20000 }, idlePrunePolicy, toolHistory())
  clock(t)
  try {
    if (ctx.toolResultPruner.supportsProtectedSeqs !== true) { t.skip('Requires enhanced host protected-pruning contract'); return }
    agent.followup(message()); await agent.whenIdle()
    await drainUntil(() => idleState(ctx, agent).status === 'scheduled')
    const before = agent.session.snapshotEvents()
    assert.ok(ctx.toolResultPruner.pruneContent(before.find(event => event.type === 'tool/result').data.message.content))
    const prune = ctx.toolResultPruner.pruneSession.bind(ctx.toolResultPruner)
    let pruneCalls = 0
    ctx.toolResultPruner.pruneSession = (...args) => { pruneCalls++; return prune(...args) }
    t.mock.timers.tick(defaults.idleMinutes * 60000)
    await drainUntil(() => idleState(ctx, agent).status === 'completed')
    const events = agent.session.snapshotEvents(), added = events.slice(before.length)
    assert.equal(pruneCalls, 0)
    assert.equal(adapter.summaries.length, 1)
    assert.equal(added.filter(event => event.type === 'compaction/summary').length, 1)
    assert.equal(added.filter(event => event.type === 'compaction/prune' || event.type === 'tool/result').length, 0)
    assert.deepEqual(events.slice(0, before.length), before)
    await assertPhysicalSessionRestore(agent.session)
    t.mock.timers.tick(86400000); await immediate()
    assert.equal(adapter.summaries.length, 1, 'successful idle maintenance must not repeat')
  } finally { await ctx.fiber.dispose() }
})

test('layered admission: real protected pruning can admit a rebuilt request without a paid summary', { timeout: 8000 }, async t => {
  const { ctx, agent, adapter } = await fixture({ pruner: true }, {}, toolHistory())
  try {
    if (ctx.toolResultPruner.supportsProtectedSeqs !== true) { t.skip('Requires enhanced host protected-pruning contract'); return }
    const task = message(); agent.followup(task); await agent.whenIdle()
    assert.equal(adapter.summaries.length, 0)
    assert.equal(adapter.requests.length, 1)
    assert.deepEqual(adapter.requests[0].messages.find(item => item.id === task.id).content, task.content)
    const events = agent.session.snapshotEvents()
    assert.equal(events.filter(event => event.type === 'compaction/prune').length, 1)
    assert.ok(events.some(event => event.type === 'tool/result' && event.data.message.content.some(block => block.type === 'text' && block.text.length > 30000)), 'original remains in the durable transcript')
    completed(agent)
    await assertPhysicalSessionRestore(agent.session)
  } finally { await ctx.fiber.dispose() }
})

for (const flags of [{ error: true }, { rich: true }]) test(`protected pruning keeps ${flags.error ? 'errors' : 'rich image results'} intact`, async t => {
  const { ctx, agent } = await fixture({ pruner: true }, { enabled: false }, toolHistory(flags))
  try {
    if (ctx.toolResultPruner.supportsProtectedSeqs !== true) { t.skip('Requires enhanced host protected-pruning contract'); return }
    const original = agent.session.surface.replaceGeneration
    const tool = agent.session.snapshotEvents().find(event => event.type === 'tool/result')
    const prune = ctx.toolResultPruner.pruneSession.bind(ctx.toolResultPruner)
    let pruneCalls = 0, checked = false
    ctx.toolResultPruner.pruneSession = (session, options) => {
      pruneCalls++
      assert.ok(options.protectedSeqs.has(tool.seq), 'the error/rich tool result is explicitly protected')
      return prune(session, options)
    }
    const release = ctx.on('agent/pre-step', ({ agent: current }) => {
      if (current !== agent || checked) return
      checked = true
      assert.equal(agent.session.snapshotEvents().findLast(event => event.type === 'turn/start' || event.type === 'turn/end').type, 'turn/start')
      assert.equal(ctx.compaction.pruneOlderTools(agent, ctx.tokenMeter.measure(agent.session)), false)
    })
    agent.followup(message()); await agent.whenIdle(); release()
    assert.ok(checked)
    assert.equal(pruneCalls, 1, 'protection must be tested inside an open turn, not bypassed by the idle guard')
    assert.equal(agent.session.surface.replaceGeneration, original)
    assert.equal(agent.session.snapshotEvents().filter(event => event.type === 'compaction/prune').length, 0)
  } finally { await ctx.fiber.dispose() }
})

test('old hosts never receive unsafe full-surface pruning through ignored protection options', async () => {
  const { ctx, agent } = await fixture({ pruner: true }, { enabled: false }, toolHistory())
  try {
    ctx.toolResultPruner.supportsProtectedSeqs = false
    let calls = 0
    ctx.toolResultPruner.pruneSession = () => { calls++; throw new Error('must not be called') }
    assert.equal(ctx.compaction.pruneOlderTools(agent, ctx.tokenMeter.measure(agent.session)), false)
    assert.equal(calls, 0)
  } finally { await ctx.fiber.dispose() }
})

test('maintenance planning retains the latest completed interaction verbatim', { timeout: 8000 }, async t => {
  const { ctx, agent, adapter } = await fixture({}, { triggerPercent: 95, earlyPercent: 0, safetyPercent: 1 }, history(28000))
  try {
    if (typeof BasicCompactionEngine.prototype.selectMaintenanceRange !== 'function') { t.skip('Requires enhanced host maintenance-range hook'); return }
    const task = message(); agent.followup(task); await agent.whenIdle()
    const recent = agent.session.deriveMessages().filter(item => item.id === task.id || item.role === 'assistant').at(-1)
    const result = await ctx.compaction.compactNow(agent, new AbortController().signal)
    assert.ok(result)
    assert.equal(adapter.summaries.length, 1)
    assert.deepEqual(agent.session.deriveMessages().find(item => item.id === task.id).content, task.content)
    assert.ok(agent.session.deriveMessages().some(item => item.id === recent.id))
  } finally { await ctx.fiber.dispose() }
})

test('maintenance selection uses surface order after a prior replacement gets a newer log sequence', async () => {
  const { ctx, agent } = await fixture({ pruner: true }, { enabled: false }, toolHistory())
  try {
    // Create the prior replacement within a real model turn. Pruning from the
    // later idle maintenance itself produced a valid surface but an invalid V4
    // log; that old failure is retained separately in the audit evidence.
    let replacement
    const release = ctx.on('agent/request-error', ({ agent: current }, next) => {
      if (current !== agent || replacement !== undefined) return next()
      const result = ctx.toolResultPruner.pruneSession(agent.session)
      assert.equal(result.pruned.length, 1)
      replacement = result.pruned[0].replacementSeq
      return next()
    }, true)
    const task = message(); agent.followup(task); await agent.whenIdle(); release()
    assert.notEqual(replacement, undefined)
    await agent.runMaintenance(async signal => {
      const latest = agent.session.snapshotEvents().find(event => event.type === 'user/message' && event.data.id === task.id).seq
      const original = agent.session.snapshotEvents().find(event => event.type === 'tool/result' && event.surfaceOp === 'append').seq
      assert.ok(replacement > original, 'a newer sequence replaces an older surface position')
      assert.ok(replacement > latest, 'log order still differs from the older tool node surface order')
      const range = await ctx.compaction.selectMaintenanceRange(agent, signal)
      assert.ok(range)
      const surface = [...agent.session.surface.nodes]
      const selected = surface.slice(surface.indexOf(range.start), surface.indexOf(range.end) + 1)
      assert.ok(selected.includes(replacement), 'old replaced tool result remains compactable')
      assert.ok(!selected.includes(latest), 'the latest task remains outside the range')
    })
    assert.deepEqual(agent.session.deriveMessages().find(item => item.id === task.id).content, task.content)
    await assertPhysicalSessionRestore(agent.session)
  } finally { await ctx.fiber.dispose() }
})


test('layered failure preserves original history when pruning committed before a malformed summary', { timeout: 8000 }, async t => {
  const { ctx, agent, adapter } = await fixture({ pruner: true, malformed: true }, {}, toolHistory({ baseSize: 32000 }))
  try {
    if (ctx.toolResultPruner.supportsProtectedSeqs !== true) { t.skip('Requires enhanced host protected-pruning contract'); return }
    const task = message(); agent.followup(task); await agent.whenIdle()
    const events = agent.session.snapshotEvents()
    assert.equal(events.filter(event => event.type === 'compaction/prune').length, 1)
    assert.equal(events.filter(event => event.type === 'compaction/summary').length, 0)
    assert.equal(adapter.requests.length, 0)
    // Prose is not a value-level type mismatch, so the narrow repair never
    // runs; the single bounded attempt keeps the original history.
    assert.equal(adapter.summaries.length, 1)
    assert.ok(events.some(event => event.type === 'tool/result' && event.data.message.content.some(block => block.type === 'text' && block.text === 'original evidence '.repeat(2200))))
    const current = agent.session.deriveMessages()
    assert.deepEqual(current.find(item => item.id === task.id).content, task.content)
    assert.ok(current.filter(item => item.role === 'tool').every(item => item.content.every(block => block.type !== 'text' || block.text.length <= 2000)))
    const summary = ctx.contextManager.summaryLedger.stats(String(agent.id))
    assert.equal(summary.attempts, 1); assert.equal(summary.unknownAttempts, 0)
    assert.equal(summary.input, 750); assert.equal(summary.output, 20)
  } finally { await ctx.fiber.dispose() }
})

test('plugin-owned idle transaction does not require the old host maintenance selection hook', { timeout: 8000 }, async t => {
  const original = Object.getOwnPropertyDescriptor(BasicCompactionEngine.prototype, 'selectMaintenanceRange')
  Object.defineProperty(BasicCompactionEngine.prototype, 'selectMaintenanceRange', { configurable: true, writable: true, value: undefined })
  const { ctx, agent, adapter } = await fixture({}, { triggerPercent: 95, earlyPercent: 0, safetyPercent: 1, idleMinutes: 1 }, history(28000))
  try {
    clock(t); agent.followup(message()); await agent.whenIdle()
    await drainUntil(() => idleState(ctx, agent).status === 'scheduled')
    const generation = agent.session.surface.replaceGeneration
    t.mock.timers.tick(60001)
    await drainUntil(() => idleState(ctx, agent).status === 'completed')
    assert.equal(adapter.summaries.length, 1)
    assert.ok(agent.session.surface.replaceGeneration > generation)
  } finally {
    t.mock.timers.reset(); await ctx.fiber.dispose()
    if (original) Object.defineProperty(BasicCompactionEngine.prototype, 'selectMaintenanceRange', original)
    else delete BasicCompactionEngine.prototype.selectMaintenanceRange
  }
})


test('a model selection after completion cancels the old idle qualification before billing', { timeout: 8000 }, async t => {
  const { ctx, agent, adapter } = await fixture({}, { triggerPercent: 95, earlyPercent: 0, safetyPercent: 1, idleMinutes: 1 }, history(28000))
  try {
    clock(t); agent.followup(message()); await agent.whenIdle()
    await drainUntil(() => idleState(ctx, agent).status === 'scheduled')
    agent.session.append('model/selection', { provider: 'mock', model: 'small', reasoningEffort: 'high' })
    assert.equal(idleState(ctx, agent).reasonCode, 'model_changed')
    t.mock.timers.tick(60001); await immediate()
    assert.equal(adapter.summaries.length, 0)
  } finally { t.mock.timers.reset(); await ctx.fiber.dispose() }
})
