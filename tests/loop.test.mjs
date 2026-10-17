import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import assert from 'node:assert/strict'
import { setImmediate as immediate } from 'node:timers/promises'
import { createVolatile, updateVolatile } from '@deepseek-ai/cosmokit'
import { writeFileSync } from 'node:fs'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { zstdCompressSync, zstdDecompressSync } from 'node:zlib'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { build } from 'esbuild'
import TypertRegistry from '@deepseek-ai/dsh-typert-registry'
import Storage from '@deepseek-ai/dsh-storage'
import * as StorageJson from '@deepseek-ai/dsh-storage-json'
import * as StorageDomain from '@deepseek-ai/dsh-storage-domain'
import { Context } from '@deepseek-ai/cordis'
import { LlmAdapter, LlmError, createUserMessage, createMessage, createToolResultMessage, ToolCallId, resolveRetryPolicy } from '@deepseek-ai/dsh-llm'
import { Session, SessionId, SessionLogOffset } from '@deepseek-ai/dsh-session'
import JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
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
import { ContextEngine as Engine } from '../lib/engine.js'
import { pressureHistory } from '../lib/inspector.js'
import { defaults, budget, validatePolicy } from '../lib/policy.js'
import { diagnosticsProjection } from '../lib/diagnostics.js'
import { installTestCompactionHost } from './fixtures/test-compaction-host.mjs'

const checkpointBuild = await build({ entryPoints: [fileURLToPath(new URL('../src/checkpoint.ts', import.meta.url))],
  bundle: true, write: false, platform: 'node', format: 'esm', target: 'es2022',
  plugins: [{ name: 'installed-public-api', setup(builder) {
    builder.onResolve({ filter: /^[^./]/ }, args => ({ path: import.meta.resolve(args.path), external: true }))
  } }] })
const { parseCheckpoint } = await import(`data:text/javascript;base64,${Buffer.from(checkpointBuild.outputFiles[0].text).toString('base64')}`)

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
      if (this.options.imageFailure) throw new LlmError('image offload requested','IMAGE_OFFLOAD_REQUIRED')
      if (this.options.fail) { yield { type: 'finish', reason: { kind: 'error', failure: { code: 'SERVER', message: 'summary unavailable' } } }; return }
      const checkpointResponse = this.options.checkpointText
      const text = (typeof checkpointResponse === 'function'
        ? checkpointResponse(options, this.summaries.length)
        : checkpointResponse) ?? (this.options.sectionsText
        ? '## 当前目标\n继续当前任务\n\n## 约束与纠正\n- 保持唯一写入者与授权边界\n\n## 已完成\n- 完成准备\n\n## 待完成\n- 继续当前任务\n\n## 证据与引用\n- 原始日志保留\n\n## 下一步\n继续执行\n\n## 尚未核实\n无'
        : (this.options.malformed || this.options.firstMalformed && this.summaries.length === 1) ? 'incomplete checkpoint' : JSON.stringify({ goal: 'Preserve the pending task', constraints: ['Keep authorization boundaries'], completed: ['Preparation complete'], pending: ['Continue current task'], evidence: this.options.noShrink ? ['oversized '.repeat(5000)] : [], next: 'Continue after completed preparation', uncertainties: [] }))
      yield { type: 'block-start', index: 0, blockType: 'text' }
      if (this.options.progress) {
        for (let step=0;step<3;step++) { this.options.progress(); yield { type: 'text-delta', index: 0, text: text.slice(Math.floor(step*text.length/3),Math.floor((step+1)*text.length/3)) } }
      }
      yield { type: 'block-end', index: 0, block: { type: 'text', text } }
      const snapshots = this.options.summaryUsageSnapshots ?? [{ inputTokens: 500, cacheReadTokens: 250, outputTokens: 20 }]
      for (const usage of snapshots) yield { type: 'usage', usage }
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

function history(length = 31600, asSession = false, seedPrefix = '') {
  const session = Session.create(SessionId('seed'))
  session.append('turn/start', { turn: 1 })
  session.append('step/start', { turn: 1, step: 1 })
  // Real sessions reserve surface node zero for the system prompt. Omitting
  // that head can pass in-memory replay but fails the persisted V4 decoder.
  session.append('system/message', { turn: 1, step: 1, message: createMessage({ role: 'system', content: [], source: { kind: 'system-prompt' } }) }, { surfaceOp: 'append' })
  const historyText = `${seedPrefix}${seedPrefix ? '\n' : ''}${'h'.repeat(length)}`
  session.append('user/message', createUserMessage({ content: [{ type: 'text', text: historyText }], source: { kind: 'user' } }), { surfaceOp: 'append' })
  session.append('assistant/message', { stream: [], turn: 1, step: 1, message: createMessage({ role: 'assistant', content: [{ type: 'text', text: 'previous work done' }], source: { kind: 'model', provider: 'mock', model: 'large' } }) }, { surfaceOp: 'append' })
  session.append('step/end', { turn: 1, step: 1 })
  session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
  return asSession ? session : session.snapshotEvents()
}

async function fixture(options = {}, policy = {}, seed = history()) {
  const ctx = new Context()
  const storageRoot = options.storageRoot ?? await mkdtemp(join(tmpdir(), 'dsh-context-loop-'))
  ctx.provide('profileContext',{dir:storageRoot,installAnchor:fileURLToPath(new URL('../package.json',import.meta.url)),patchPath:fileURLToPath(new URL('../cordis.patch.yml',import.meta.url))})
  ctx.effect(() => () => options.keepStorage ? undefined : rm(storageRoot, { recursive: true, force: true }))
  await ctx.plugin(Storage)
  await ctx.plugin(StorageJson, { root: storageRoot })
  await ctx.plugin(StorageDomain, { backend: 'json' })
  await mountAgentLoopTestDependencies(ctx)
  await ctx.plugin(TypertRegistry)
  if (options.persistSession) await ctx.plugin(JsonlSessionPersistence, { root: join(storageRoot, 'sessions'), compression: 'none' })
  await ctx.plugin(AgentLoop, { agents: [] })
  await ctx.plugin(TokenMeter)
  await ctx.plugin(Retry)
  if (options.pruner) await ctx.plugin(ToolResultPruner, { thresholdChars: 2000, headChars: 600, tailChars: 400 })
  if (options.presets) {
    ctx.baseUrl = new URL('../', import.meta.url).href
    await ctx.plugin(Loader); ctx.loader.builtins.group = Group
    await ctx.plugin(AgentPresets, { default: 'one' })
  }
  const testHost = installTestCompactionHost(ctx)
  await ctx.plugin(Manager, { policy: { ...defaults, capacityMode: 'legacy', summaryMaxTokens: 512, ...policy } })
  await ctx.plugin(Engine)
  if (options.presets) {
    for (const id of ['one', 'two']) await ctx.plugin({ inject: ['agentPresets'], async *apply(child) {
      yield await child.agentPresets.register({ id, plugins: [{ name: 'cordis:group', group: true, isolate: { compaction: true }, config: [{ name: options.customBasic ? '@deepseek-ai/dsh-compaction-basic' : new URL('./fixtures/context-engine-class-entry.mjs', import.meta.url).href, ...(options.customBasic ? { config: { auto: false } } : {}) }] }] })
    } })
  }
  const adapter = new Adapter(options)
  ctx.llm.registerAdapter(['mock'], adapter)
  ctx.tools.register(defineContentToolFixture({ name: 'work', description: 'Count work', parameters: {}, async execute() { adapter.work++; adapter.order.push('tool'); return [{ type: 'text', text: options.toolOutputs?.[adapter.work - 1] ?? options.toolOutput ?? 'tool complete' }] } }))
  const { agent } = options.skipCreate ? {} : await ctx.agentLoop.createAgent(ctx, { sessionId: SessionId('subject'), seed, agentOptions: { provider: 'mock', model: 'large' },
    meta: { delegationDepth: options.seeded ? 1 : 0, ...(options.seeded ? { isSeeded: true, parentSession: SessionId('seed') } : {}) },
    ...(options.seeded ? { inheritedEventCount: SessionLogOffset(seed.length) } : {}),
    ...(options.presets ? { setup: async agentCtx => { await ctx.agentPresets.mount(agentCtx, 'one') } } : {}) })
  if (agent) testHost.bind(agent.ctx, options.customBasic ? 'native' : 'enhanced')
  return { ctx, adapter, agent, storageRoot }
}
const message = (text = '请完成当前任务；不要改动无关文件。') => createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } })
const completed = agent => assert.equal(agent.session.snapshotEvents().at(-1).data.reason.kind, 'completed', JSON.stringify(agent.session.snapshotEvents().at(-1).data.reason))

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

test('idle: short context skips; background busy past 90 seconds retains eligibility and eventually compacts once', { timeout: 10000 }, async t => {
  clock(t)
  for (const background of [false, true]) {
    const { ctx, adapter, agent } = await fixture({}, {}, history(background ? 28000 : 2000))
    let busy = background, checks = 0
    if (background) ctx.on('workspace/session-activity', async () => { checks++; return busy ? [{ kind: 'background', label: 'fixture work' }] : [] })
    try {
      agent.followup(message()); await agent.whenIdle(); await drainUntil(() => ['scheduled', 'off', 'skipped'].includes(idleState(ctx, agent).status)); t.mock.timers.tick(900000)
      if (background) {
        for (const delay of [30000,60000,120000,240000]) {
          await drainUntil(() => idleState(ctx, agent).status === 'scheduled')
          assert.equal(adapter.summaries.length,0)
          t.mock.timers.tick(delay)
        }
        await drainUntil(() => idleState(ctx, agent).status === 'scheduled')
        assert.ok(checks >= 5); busy=false; t.mock.timers.tick(300000)
        await drainUntil(() => idleState(ctx, agent).status === 'completed')
        assert.equal(adapter.summaries.length,1)
        t.mock.timers.tick(86400000); await immediate(); assert.equal(adapter.summaries.length,1)
      } else {
        await drainUntil(() => idleState(ctx, agent).status === 'skipped')
        assert.equal(adapter.summaries.length,0)
      }
    } finally {
      await ctx.fiber.dispose()
      // Keep startupProof's wall clock and monotonic time aligned when the
      // second fixture is mounted after the first fake-clock interval.
      if (!background) { t.mock.timers.reset(); clock(t) }
    }
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
    } finally {
      await ctx.fiber.dispose()
      if (!cancel) { t.mock.timers.reset(); clock(t) }
    }
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
    // Every physically settled failure is recorded as known-unapplied with its
    // usage; the same large history is never replayed automatically.
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

test('real loop: later provider usage totals update known fields without adding the repeated input total', { timeout: 8000 }, async () => {
  const { ctx, adapter, agent } = await fixture({ summaryUsageSnapshots: [
    { inputTokens: 100, outputTokens: 0, cacheReadTokens: 5 },
    { inputTokens: 100, outputTokens: 40 },
  ] }, { idleEnabled: false }, history(31600))
  try {
    agent.followup(message()); await agent.whenIdle()
    assert.equal(adapter.summaries.length, 1)
    const usage = ctx.contextManager.summaryLedger.stats(String(agent.id))
    assert.equal(usage.attempts, 1)
    assert.equal(usage.input, 105, 'repeated provider totals are snapshots, not increments')
    assert.equal(usage.output, 40, 'a later snapshot can update a field that was previously zero')
    assert.equal(usage.cacheRead, 5, 'an omitted later field retains its last known snapshot value')
    assert.equal(usage.unknownAttempts, 0)
  } finally { await ctx.fiber.dispose() }
})

for (const kind of ['fail', 'noShrink', 'malformed']) test(`real loop: ${kind} pauses without business calls or unbounded retry`, { timeout: 8000 }, async () => {
  const { ctx, adapter, agent } = await fixture({ [kind]: true })
  try {
    const task = message(); agent.followup(task); await agent.whenIdle()
    // No automatic replay of the same large history for any failure class.
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

test('active pressure compaction aborts on every queued source and fails closed on hosts without handoff', { timeout: 8000 }, async () => {
  let entered; const started = new Promise(resolve => { entered = resolve })
  const { ctx, adapter, agent } = await fixture({ pause: signal => new Promise((resolve, reject) => {
    entered()
    if (signal.aborted) reject(signal.reason)
    else signal.addEventListener('abort', () => reject(signal.reason), { once: true })
  }) }, { idleEnabled: false }, history(31600))
  try {
    // Exercise the older Host contract even when this suite is linked to the
    // candidate Host, whose agents advertise the opt-in handoff capability.
    Object.defineProperty(agent, 'supportsRequestErrorHandoff', { configurable: true, value: false })
    const activeTask = message('当前任务保持原样')
    agent.followup(activeTask)
    await started
    assert.equal(adapter.summaries.length, 1)

    // A bridge/steer message may carry an attachment and does not have to use
    // source.kind === 'user'. The event is a queue mutation, not a human-origin
    // classifier.
    const attachment = { type: 'image', attachment: { attachmentId: `sha256:${'a'.repeat(64)}`, mediaType: 'image/png', bytes: 128, width: 16, height: 16 } }
    const queuedStep = createUserMessage({ content: [{ type: 'text', text: '桥接补充' }, attachment], source: { kind: 'cordis-host-runner' } })
    const queuedTurn = createUserMessage({ content: [{ type: 'text', text: '后续任务' }], source: { kind: 'user' } })
    agent.inject(queuedStep)
    agent.followup(queuedTurn)
    await agent.whenIdle()

    assert.equal(adapter.requests.length, 0, 'the cancelled summary must not authorize the original provider request')
    assert.equal(adapter.summaries.length, 1)
    assert.equal(adapter.summaries[0].signal.aborted, true)
    assert.equal(agent.session.snapshotEvents().filter(event => event.type === 'compaction/summary').length, 0, 'the obsolete checkpoint never commits')
    assert.equal(agent.session.snapshotEvents().filter(event => event.type === 'user/message' && event.data.id === activeTask.id).length, 1)
    assert.deepEqual(agent.inbox.nextStep.map(item => item.id), [queuedStep.id], 'unsupported Hosts keep the bridge input queued without admitting it')
    assert.deepEqual(agent.inbox.nextTurn.map(item => item.id), [queuedTurn.id], 'unsupported Hosts keep the next task queued without admitting it')
    const end = agent.session.snapshotEvents().findLast(event => event.type === 'turn/end')
    assert.equal(end?.data.reason.kind, 'error', 'unsupported handoff must stop the turn instead of dispatching work')
    assert.ok(end.data.reason.error?.message)
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
  const { ctx, adapter, agent } = await fixture({ contextWindow: 20000, tools: true, toolOutput: 'result '.repeat(2500) }, {}, history(50000))
  try {
    const task = message(); agent.followup(task); await agent.whenIdle()
    assert.equal(adapter.requests.length, 2)
    assert.deepEqual(adapter.order, ['main', 'tool', 'summary-start', 'summary-finish', 'main'])
    assert.ok(agent.session.deriveMessages().some(m => m.id === task.id))
    assert.ok(adapter.summaries.length <= 2)
    completed(agent)
  } finally { await ctx.fiber.dispose() }
})

test('real loop: source growth compacts older history while preserving the active tool result', { timeout: 12000 }, async () => {
  // At 200K, admission is about 158K. The 150K old history fits on its own;
  // the 20K current tool result crosses the threshold but still leaves enough
  // measured continuation headroom to compact the old region safely.
  const seed = history(600000)
  const oldUser = seed.find(event => event.type === 'user/message')
  assert.ok(oldUser)
  const { ctx, adapter, agent } = await fixture({ contextWindow: 200000,
    tools: true, toolOutput: 'ACTIVE-TOOL-OUTPUT\n' + 'a'.repeat(80000) },
  { historyMode: 'automatic', recentTokens: 20000, idleEnabled: false }, seed)
  const permits = []
  ctx.on('llm/stream', async function* (options, next) {
    if (options.purpose === 'compaction') permits.push(ctx.contextManager.summaryOperations.records(String(agent.id)).at(-1))
    yield* next()
  }, true)
  try {
    const task = message('CURRENT-TASK-MUST-STAY-VERBATIM')
    agent.followup(task)
    await agent.whenIdle()
    completed(agent)
    assert.equal(adapter.work, 1, 'the finite fixture executes one tool')
    assert.equal(adapter.requests.length, 2, 'the business request resumes after one safe summary')
    assert.equal(adapter.summaries.length, 1)
    assert.deepEqual(adapter.order, ['main', 'tool', 'summary-start', 'summary-finish', 'main'])

    const events = agent.session.snapshotEvents()
    const taskEvent = events.find(event => event.type === 'user/message' && event.data.id === task.id)
    const results = events.filter(event => event.type === 'tool/result' && event.surfaceOp === 'append')
    const summaries = events.filter(event => event.type === 'compaction/summary')
    assert.ok(taskEvent)
    assert.equal(results.length, 1)
    assert.equal(summaries.length, 1, 'the older source commits without touching the active task or tool result')
    assert.ok(summaries[0].data.shadowedSeqs.includes(oldUser.seq))
    assert.ok(summaries[0].data.shadowedSeqs.every(seq => seq < taskEvent.seq), 'the selected region is older than the protected task')
    assert.ok(!summaries[0].data.shadowedSeqs.includes(results[0].seq), 'the active tool result remains intact')
    const retained = agent.session.deriveMessages().filter(item => item.id === task.id)
    assert.equal(retained.length, 1)
    assert.deepEqual(retained[0].content, task.content)

    assert.equal(permits.length, 1)
    assert.equal(permits[0].cycle, 1)
    assert.equal(permits[0].sourceWatermark, results[0].seq)
    const usage = ctx.contextManager.summaryLedger.stats(String(agent.id))
    assert.equal(usage.attempts, 1)
    assert.equal(usage.input, 750, 'one 500 input + 250 cache-read attempt is counted exactly once')
    assert.equal(usage.output, 20)
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
  const { ctx, adapter, agent } = await fixture({ contextWindow: 20000 }, {}, history(45000))
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

test('host handoff: queued input is admitted once after summary interruption without unknown-cost replay', { timeout: 8000 }, async t => {
  let enterSummary
  const entered = new Promise(resolve => { enterSummary = resolve })
  let summaryCount = 0
  const { ctx, adapter, agent } = await fixture({ pause: signal => {
    summaryCount++
    if (summaryCount > 1) return Promise.resolve()
    enterSummary()
    return new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }))
  } }, {}, history((7990 - 21) * 4))
  try {
    if (agent.supportsRequestErrorHandoff !== true) {
      t.skip('requires the opt-in Host request-error handoff capability')
      return
    }
    const original = message('先提交的任务；首次上下文重建期间新输入到达')
    agent.followup(original)
    await entered
    assert.equal(adapter.summaries.length, 1)

    const queued = message('新输入应接管下一次模型请求')
    agent.steer(queued)
    await agent.whenIdle()

    const events = agent.session.snapshotEvents()
    assert.deepEqual(adapter.order, ['summary-start'])
    assert.equal(adapter.requests.length, 0, 'the gated business request and interrupted summary are not replayed')
    assert.equal(adapter.summaries.length, 1)
    assert.equal(adapter.work, 0)
    assert.equal(events.filter(event => event.type === 'user/message' && event.data.id === original.id).length, 1)
    assert.equal(events.filter(event => event.type === 'user/message' && event.data.id === queued.id).length, 1)
    const liveTurn = events.filter(event => event.type === 'turn/start').at(-1).data.turn
    assert.equal(events.filter(event => event.type === 'step/start' && event.data.turn === liveTurn).length, 2, 'handoff continues within the reserved turn')
    assert.equal(agent.inbox.nextStep.length + agent.inbox.nextTurn.length, 0)
    const end = events.filter(event => event.type === 'turn/end').at(-1)
    assert.equal(end.data.reason.kind, 'error')
    assert.equal(end.data.reason.error.code, 'CONTEXT_MANAGER_BLOCKED')
    const [operation] = ctx.contextManager.summaryOperations.records(String(agent.id))
    assert.equal(operation.phase, 'unknown_interrupted')
    assert.equal(operation.reasonCode, 'queued_input')
    assert.equal(events.filter(event => event.type === 'compaction/summary').length, 0)
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

test('real llm/stream iterator: return.done cannot release the gate while next is still pending', { timeout: 8000 }, async t => {
  let started, resolvePending, returnCalls = 0, streamCalls = 0, nextCalls = 0
  const entered = new Promise(resolve => { started = resolve })
  const pendingNext = new Promise(resolve => { resolvePending = resolve })
  const iterator = {
    [Symbol.asyncIterator]() { return this },
    next() {
      nextCalls++
      if (nextCalls === 1) return Promise.resolve({ done: false, value: { type: 'usage', usage: { inputTokens: 100, outputTokens: 20 } } })
      if (nextCalls === 2) { started(); return pendingNext }
      return Promise.resolve({ done: true, value: undefined })
    },
    return() { returnCalls++; return Promise.resolve({ done: true, value: undefined }) },
  }
  const { ctx, agent, adapter } = await fixture({ contextWindow: 10000 }, { idleEnabled: false }, history(31600))
  const originalTimeout = AbortSignal.timeout
  try {
    ctx.on('llm/stream', (options, next) => {
      if (options.purpose === 'compaction' && streamCalls++ === 0) return iterator
      return next()
    }, true)
    const task = message('受控工具流测试')
    agent.followup(task)
    await entered
    // Make the physical harvester's bounded window expire immediately. The
    // iterator deliberately reports return.done while its second next remains
    // unresolved, matching a public custom-adapter implementation.
    AbortSignal.timeout = () => AbortSignal.abort()
    agent.cancel({ kind: 'user' })
    await agent.whenIdle()
    await drainUntil(() => returnCalls === 1)
    AbortSignal.timeout = originalTimeout
    const nextTask = message('传输仍未结束时不应发起重叠请求')
    agent.followup(nextTask); await agent.whenIdle()
    assert.equal(adapter.requests.length, 0, 'the overlap gate blocks the next business provider request')
    assert.equal(agent.session.snapshotEvents().filter(event => event.type === 'user/message' && event.data.id === nextTask.id).length, 1)
    assert.equal(streamCalls, 1, 'the second provider call is rejected before the public llm/stream hook')
    assert.equal(nextCalls, 2, 'the underlying next remains in flight when return resolves')
  } finally {
    AbortSignal.timeout = originalTimeout
    resolvePending?.({ done: true, value: undefined })
    await immediate()
    await ctx.fiber.dispose()
  }
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
      assert.equal(ctx.compaction.pruneOlderTools(agent, ctx.tokenMeter.measure(agent.session), 10000), false)
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
      assert.equal(ctx.compaction.pruneOlderTools(agent, ctx.tokenMeter.measure(agent.session), 10000), false)
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
    assert.equal(ctx.compaction.pruneOlderTools(agent, ctx.tokenMeter.measure(agent.session), 10000), false)
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
    // Prose is not a value-level type mismatch, so no local repair applies and
    // the same history is never replayed; the original history stays intact.
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

// These use the real AgentLoop, storage domains and automatic request-error hook.
// The deterministic adapter makes no network call and is not real-model acceptance.
test('automatic recovery: the same request stays blocked after failure until an explicit grant', async () => {
  const {ctx,adapter,agent}=await fixture({firstMalformed:true})
  try {
    const task=message(); agent.followup(task);await agent.whenIdle()
    assert.equal(adapter.summaries.length,1,'the same large history is never replayed automatically')
    assert.equal(adapter.requests.length,0)
    const first=ctx.contextManager.summaryOperations.records(String(agent.id))
    assert.deepEqual(first.map(r=>r.phase),['known_failed_unapplied'])
    assert.equal(first[0].reasonCode,'invalid_structure')
    assert.equal(agent.session.deriveMessages().filter(m=>m.id===task.id).length,1,'the task stays verbatim')
    assert.equal(ctx.contextManager.idleStatus(String(agent.id)).recovery.available,true)
    // A later ordinary input must not silently re-dispatch the same request.
    agent.followup(message('继续'));await agent.whenIdle()
    assert.equal(adapter.summaries.length,1,'same requestHash after failure requires authorization')
    assert.equal(adapter.requests.length,0)
    const end=agent.session.snapshotEvents().filter(e=>e.type==='turn/end').at(-1)
    assert.match(end?.data?.reason?.error?.message ?? '', /恢复|授权|来源|上限|operation_state/)
    const rows=ctx.contextManager.summaryOperations.records(String(agent.id))
    assert.deepEqual(rows.map(r=>r.phase),['known_failed_unapplied'])
    assert.equal(ctx.contextManager.compactionCycles.records(String(agent.id)).length,0)
  } finally {await ctx.fiber.dispose()}
})

test('explicit recovery: real mutation grants one bound maintenance call; inspector reads cannot grant', async () => {
  const {ctx,adapter,agent}=await fixture({fail:true})
  try {
    agent.followup(message());await agent.whenIdle()
    assert.equal(adapter.summaries.length,1);assert.equal(adapter.requests.length,0)
    const {ContextRecovery}=await import('../lib/inspector.js')
    await ctx.plugin(ContextRecovery)
    const before=ctx.contextManager.summaryOperations.records(String(agent.id))
    for(let n=0;n<3;n++)assert.equal(ctx.contextManager.idleStatus(String(agent.id)).recovery.available,true)
    assert.deepEqual(ctx.contextManager.summaryOperations.records(String(agent.id)),before)
    const recovery=ctx.contextManager.idleStatus(String(agent.id)).recovery
    adapter.options.fail=false
    await ctx.contextRecovery.authorizeOnce({sessionId:String(agent.id),authorizationToken:recovery.authorizationToken},new AbortController().signal)
    assert.equal(adapter.summaries.length,2)
    const rows=ctx.contextManager.summaryOperations.records(String(agent.id))
    assert.equal(rows[0].phase,'known_failed_unapplied')
    assert.equal(rows[0].usageComplete,false,'billed usage stayed unknown, so authorization was required')
    assert.equal(rows[1].phase,'committed');assert.ok(rows[1].authorizationId)
    assert.equal(new Set(rows.map(row=>row.attemptId)).size,2)
    await assert.rejects(ctx.contextRecovery.authorizeOnce({sessionId:String(agent.id),authorizationToken:recovery.authorizationToken},new AbortController().signal))
    assert.equal(adapter.summaries.length,2)
  } finally {await ctx.fiber.dispose()}
})

test('explicit recovery: changed source cannot use prior authorization or start a fresh paid call', async () => {
  const {ctx,adapter,agent}=await fixture({fail:true})
  try {
    agent.followup(message());await agent.whenIdle()
    const recovery=ctx.contextManager.idleStatus(String(agent.id)).recovery
    agent.followup(message());await agent.whenIdle()
    assert.equal(adapter.summaries.length,1,'ordinary continue is not authorization')
    const {ContextRecovery}=await import('../lib/inspector.js');await ctx.plugin(ContextRecovery)
    adapter.options.fail=false
    await assert.rejects(ctx.contextRecovery.authorizeOnce({sessionId:String(agent.id),authorizationToken:recovery.authorizationToken},new AbortController().signal))
    assert.equal(adapter.summaries.length,1)
  } finally {await ctx.fiber.dispose()}
})

test('explicit recovery: cancelled task A plus task B requires one exact A+B recovery', { timeout: 12000 }, async () => {
  let enter; const entered = new Promise(resolve => { enter = resolve })
  const {ctx,adapter,agent}=await fixture({pause: signal => new Promise((_resolve,reject) => {
    enter()
    if (signal.aborted) reject(signal.reason)
    else signal.addEventListener('abort', () => reject(signal.reason), { once: true })
  })}, {}, history(31600))
  try {
    const id=String(agent.id)
    const taskA=message('任务 A：保留原始校验记录，等待压缩完成。')
    agent.followup(taskA); await entered
    assert.equal(adapter.summaries.length,1)
    agent.cancel({kind:'user'}); await agent.whenIdle()
    const origin=ctx.contextManager.summaryOperations.records(id)[0]
    assert.ok(['known_failed_unapplied','unknown_interrupted'].includes(origin.phase))
    assert.equal(origin.usageComplete,false,'an aborted attempt without usage stays an unresolved cost')

    adapter.options.pause=undefined
    const taskB=message('任务 B：接续任务 A，并保留这条更新后的授权边界。')
    agent.followup(taskB); await agent.whenIdle()
    assert.equal(adapter.summaries.length,1,'changed source must not trigger another paid attempt automatically')
    assert.equal(adapter.requests.length,0,'task B stays paused behind the unresolved A attempt')
    assert.equal(agent.session.snapshotEvents().filter(event=>event.type==='user/message' && event.data.id===taskB.id).length,1)
    const recovery=ctx.contextManager.idleStatus(id).recovery
    assert.equal(recovery.available,true,JSON.stringify({recovery,origin,operations:ctx.contextManager.summaryOperations.records(id)}))
    assert.equal(recovery.riskAcceptanceRequired,undefined,'the immutable original prefix proves ancestry without accepting unverifiable risk')

    const {ContextRecovery}=await import('../lib/inspector.js')
    await ctx.plugin(ContextRecovery)
    await ctx.contextRecovery.authorizeOnce({sessionId:id,authorizationToken:recovery.authorizationToken},new AbortController().signal)
    const rows=ctx.contextManager.summaryOperations.records(id)
    assert.equal(adapter.summaries.length,2,'one user-authorized recovery call')
    assert.equal(rows.length,2)
    assert.equal(rows[0].operationId,origin.operationId)
    assert.equal(rows[0].phase,origin.phase,'the canceled A record remains immutable')
    assert.equal(rows[1].phase,'committed')
    assert.equal(rows[1].recoveryFor,origin.operationId,'the committed A+B range proves and resolves the exact A origin')
    assert.notEqual(rows[1].sourceHash,origin.sourceHash,'the successful recovery is bound to the changed A+B source')
    assert.ok(rows[1].sourceWatermark>origin.sourceWatermark)
    const messages=agent.session.deriveMessages()
    assert.deepEqual(messages.find(item=>item.id===taskA.id)?.content,taskA.content,'canceled task A remains verbatim after recovery')
    assert.deepEqual(messages.find(item=>item.id===taskB.id)?.content,taskB.content,'blocked task B remains verbatim after recovery')
    assert.equal(agent.session.snapshotEvents().filter(event=>event.type==='user/message' && event.data.id===taskA.id).length,1)
    assert.equal(agent.session.snapshotEvents().filter(event=>event.type==='user/message' && event.data.id===taskB.id).length,1)
    assert.ok(agent.session.snapshotEvents().filter(event=>event.type==='compaction/summary').length>=1)
    assert.equal(adapter.requests.length,0,'explicit recovery compacts context without silently replaying either business task')
    assert.equal(adapter.work,0)
  } finally {await ctx.fiber.dispose()}
})

for (const mode of ['adaptive', 'fixed', 'total']) test(`real manual deadline: ${mode} shares progress and total boundary`, async t => {
  t.mock.timers.enable({apis:['Date'],now:Date.now()})
  const {ctx,adapter,agent}=await fixture({progress:()=>t.mock.timers.tick(100000)},
    {summaryTimeoutMode:mode==='fixed'?'fixed':'adaptive',summaryTotalMs:mode==='total'?250000:600000,timeoutMs:90000},history(28000))
  try {
    agent.followup(message());await agent.whenIdle();assert.equal(adapter.summaries.length,0)
    if(mode==='adaptive') assert.ok(await ctx.compaction.compactNow(agent,new AbortController().signal))
    else await assert.rejects(ctx.compaction.compactNow(agent,new AbortController().signal))
    assert.equal(adapter.summaries.length,1)
    assert.equal(agent.session.snapshotEvents().filter(e=>e.type==='compaction/summary').length,mode==='adaptive'?1:0)
    const row=ctx.contextManager.summaryOperations.records(String(agent.id))[0]
    if(mode==='adaptive') assert.equal(row.phase,'committed')
    else {assert.equal(row.phase,'unknown_interrupted');assert.equal(row.reasonCode,'total_timeout')}
    assert.equal(ctx.contextManager.snapshot().timeoutMs,90000)
  } finally {await ctx.fiber.dispose()}
})

test('automatic commit guard: elapsed deadline during final durable ledger await blocks late commit without ticker', async t=>{
 t.mock.timers.enable({apis:['Date'],now:Date.now()})
 const {ctx,adapter,agent}=await fixture({}, {summaryTimeoutMode:'fixed'})
 try {
  const ledger=ctx.contextManager.summaryLedger,finish=ledger.finish
  ledger.finish=async function(...args){await finish.apply(this,args);if(args[2]==='generated')t.mock.timers.tick(90001)}
  agent.followup(message());await agent.whenIdle()
  assert.equal(adapter.summaries.length,1);assert.equal(adapter.requests.length,0)
  assert.equal(agent.session.snapshotEvents().filter(e=>e.type==='compaction/summary').length,0)
  const row=ctx.contextManager.summaryOperations.records(String(agent.id))[0]
  assert.equal(row.phase,'generated_uncommitted');assert.equal(row.reasonCode,'total_timeout')
  assert.equal(ledger.stats(String(agent.id)).recent[0].status,'generated')
 }finally{await ctx.fiber.dispose()}
})

test('ownership: a custom Basic preset stays unowned and inspector reports the actual owner',async()=>{
 const {ctx,adapter,agent}=await fixture({presets:true,customBasic:true})
 try {
  agent.followup(message());await agent.whenIdle()
  assert.equal(adapter.summaries.length,0);assert.equal(adapter.requests.length,1)
  assert.equal(ctx.contextManager.idleStatus(String(agent.id)).owner,'other')
  assert.equal(ctx.contextManager.summaryOperations.records(String(agent.id)).length,0)
 } finally {await ctx.fiber.dispose()}
})

// Reproduce the reported boundary: completed side effect -> next step admission
// -> a progressing summary beyond 90s -> native retry in the SAME turn.
for (const mode of ['default', 'fixed', 'total', 'stall']) test(`automatic long task continuation: ${mode}`, async t => {
  t.mock.timers.enable({apis:['Date'],now:Date.now()})
  let chunks=0
  const policy=mode==='fixed'?{summaryTimeoutMode:'fixed'}:mode==='total'?{summaryTotalMs:250000}:{}
  const {ctx,adapter,agent}=await fixture({contextWindow:191931,tools:true,
    // Keep the completed tool output large enough to force the same-turn
    // continuation summary while remaining inside the computed next-step
    // reserve. An intrinsically infeasible single result is covered by the
    // separate pre-dispatch block path.
    toolOutput:'result '.repeat(25000),progress:()=>t.mock.timers.tick(mode==='stall' && chunks++>0?180001:100000)},
    {...policy,idleEnabled:false},history(470000))
  try {
    const task=message();agent.followup(task);await agent.whenIdle()
    const events=agent.session.snapshotEvents()
    assert.equal(adapter.work,1,'completed side effect must never replay')
    assert.equal(events.filter(e=>e.type==='user/message' && e.data.id===task.id).length,1)
    assert.equal(adapter.summaries.length,1,'one paid summary; no hidden retry')
    const row=ctx.contextManager.summaryOperations.records(String(agent.id))[0]
    writeFileSync(new URL(`../verification/continuation-${mode}.json`,import.meta.url),JSON.stringify({mode,policy:ctx.contextManager.snapshot(),work:adapter.work,order:adapter.order,operation:row,events:events.filter(e=>['turn/start','turn/end','step/start','step/end','compaction/start','compaction/end'].includes(e.type))},null,2))
    if(mode==='default') {
      completed(agent)
      assert.deepEqual(adapter.order,['main','tool','summary-start','summary-finish','main'])
      assert.equal(row.phase,'committed')
      const starts=events.filter(e=>e.type==='turn/start');assert.equal(starts.length,2,'one seeded turn plus one live task')
      const steps=events.filter(e=>e.type==='step/start' && e.data.turn===starts.at(-1).data.turn)
      assert.equal(steps.length,2,'retry rebuilds step two without opening another step')
      assert.equal(events.filter(e=>e.type==='tool/result').length,1)
      assert.equal(events.filter(e=>e.type==='compaction/summary').length,1)
    } else {
      assert.equal(adapter.requests.length,1,'unsafe request must not continue')
      assert.equal(events.filter(e=>e.type==='compaction/summary').length,0)
      assert.equal(row.phase,'unknown_interrupted')
      assert.equal(row.reasonCode,mode==='stall'?'stall_timeout':'total_timeout')
    }
  } finally {await ctx.fiber.dispose()}
})

test('configuration upgrade preserves explicit and ambiguous legacy choices',()=>{
  assert.equal(Manager.Config({}).policy.get().summaryTimeoutMode,'adaptive')
  for(const timeoutMs of [90000,135000]) {
    assert.equal(Manager.Config({policy:{timeoutMs}}).policy.get().summaryTimeoutMode,'fixed')
    assert.equal(Manager.Config({policy:{timeoutMs,summaryTimeoutMode:'fixed'}}).policy.get().timeoutMs,timeoutMs)
  }
  assert.equal(Manager.Config({policy:{summaryTimeoutMode:'adaptive'}}).policy.get().summaryTimeoutMode,'adaptive')
})

for (const presets of [false,true]) test(`hot policy: existing agent adopts adaptive on next transaction, presets=${presets}`,async t=>{
 t.mock.timers.enable({apis:['Date'],now:Date.now()})
 const {ctx,adapter,agent}=await fixture({presets,progress:()=>t.mock.timers.tick(100000)}, {summaryTimeoutMode:'fixed'},history(28000))
 try {
  agent.followup(message());await agent.whenIdle();completed(agent)
  changePolicy(ctx,{summaryTimeoutMode:'adaptive'})
  agent.followup(message('long task '.repeat(500)));await agent.whenIdle();completed(agent)
  assert.equal(adapter.summaries.length,1)
  assert.match(ctx.contextManager.idleStatus(String(agent.id)).execution,/已完成.*总限600s/)
 }finally{await ctx.fiber.dispose()}
})

test('hot recovery: current policy replaces captured admission and records actual transaction limits',async t=>{
 t.mock.timers.enable({apis:['Date'],now:Date.now()})
 const {ctx,adapter,agent}=await fixture({fail:true},{summaryTimeoutMode:'fixed'})
 try {
  agent.followup(message());await agent.whenIdle()
  const recovery=ctx.contextManager.idleStatus(String(agent.id)).recovery
  changePolicy(ctx,{summaryTimeoutMode:'adaptive'})
  adapter.options.fail=false;adapter.options.progress=()=>t.mock.timers.tick(100000)
  await ctx.contextManager.authorizeRecovery(String(agent.id),recovery.authorizationToken,new AbortController().signal)
  assert.equal(adapter.summaries.length,2)
  assert.match(ctx.contextManager.idleStatus(String(agent.id)).execution,/已完成.*总限600s/)
 }finally{await ctx.fiber.dispose()}
})

async function exhaustForEmergency(ctx,agent) {
 agent.followup(message());await agent.whenIdle()
 assert.equal(ctx.contextManager.summaryOperations.records(String(agent.id)).length,1)
 const recovery=ctx.contextManager.idleStatus(String(agent.id)).recovery
 assert.equal(recovery.available,true,'unknown cost needs one explicit authorization')
 // One explicit recovery consumes the second primary (this fixture keeps failing);
 // the third attempt is refused by the shared budget.
 await assert.rejects(ctx.contextManager.authorizeRecovery(String(agent.id),recovery.authorizationToken,new AbortController().signal),
   /闲置压缩未完成|未知|上限|压缩/)
 assert.equal(ctx.contextManager.summaryOperations.records(String(agent.id)).length,2)
 const blocked=ctx.contextManager.idleStatus(String(agent.id)).recovery
 await assert.rejects(ctx.contextManager.authorizeRecovery(String(agent.id),blocked.authorizationToken,new AbortController().signal))
 assert.equal(ctx.contextManager.summaryOperations.records(String(agent.id)).length,2)
}
for(const result of ['success','malformed']) test(`emergency: explicit prepare and one separate call ${result}, no turn replay`,async()=>{
 const {ctx,adapter,agent}=await fixture({fail:true})
 try {
  await exhaustForEmergency(ctx,agent)
  const {ContextRecovery}=await import('../lib/inspector.js');await ctx.plugin(ContextRecovery)
  const original=ctx.contextManager.summaryOperations.records(String(agent.id))
  const messages=agent.session.snapshotEvents().filter(e=>e.type==='user/message').length
  const beforePrepare=agent.session.snapshotEvents()
  const plan=await ctx.contextRecovery.prepareEmergency({sessionId:String(agent.id)},new AbortController().signal)
  assert.deepEqual(agent.session.snapshotEvents(),beforePrepare,'prepare changes no history or effective surface')
  assert.equal(adapter.summaries.length,2,'prepare never calls the model')
  assert.deepEqual(ctx.contextManager.summaryOperations.records(String(agent.id)),original)
  adapter.options.fail=false;adapter.options.malformed=result==='malformed'
  const operation=ctx.contextRecovery.executeEmergency({sessionId:String(agent.id),token:plan.token,acceptUnknownCost:true},new AbortController().signal)
  if(result==='success')await operation;else await assert.rejects(operation)
  assert.equal(adapter.summaries.length,3,'one rescue only, no retry or format repair')
  assert.equal(adapter.requests.length,0,'maintenance never wakes the business task')
  assert.deepEqual(ctx.contextManager.summaryOperations.records(String(agent.id)),original)
  const emergency=ctx.contextManager.summaryOperations.allRecords(String(agent.id)).at(-1)
  assert.equal(emergency.phase,result==='success'?'committed':'known_failed_unapplied')
  assert.equal(ctx.contextManager.idleStatus(String(agent.id)).emergency.used,true)
  const evidenceEvents=agent.session.snapshotEvents().filter(e=>['compaction/start','compaction/end','turn/start','turn/end'].includes(e.type))
  writeFileSync(new URL(`../verification/emergency-${result}.json`,import.meta.url),JSON.stringify({modelCalls:adapter.summaries.length,businessCalls:adapter.requests.length,originalAutomatic:original,finalAutomatic:ctx.contextManager.summaryOperations.records(String(agent.id)),allCalls:ctx.contextManager.summaryOperations.allRecords(String(agent.id)),events:evidenceEvents,runs:evidenceEvents.filter(e=>e.type==='compaction/end').map(e=>ctx.contextManager.summaryOperations.run(String(agent.id),String(e.data.compactionId)))},null,2))
  await assert.rejects(ctx.contextRecovery.executeEmergency({sessionId:String(agent.id),token:plan.token,acceptUnknownCost:true},new AbortController().signal))
  assert.equal(adapter.summaries.length,3)
  assert.equal(agent.session.snapshotEvents().filter(e=>e.type==='user/message' && e.surfaceOp==='append').length,messages)
 }finally{await ctx.fiber.dispose()}
})

test('emergency: changed original source invalidates prepared authorization without dispatch',async()=>{
 const {ctx,adapter,agent}=await fixture({fail:true})
 try {
  await exhaustForEmergency(ctx,agent)
  const plan=await ctx.compaction.prepareEmergency(agent,new AbortController().signal)
  agent.followup(message('new user intent'));await agent.whenIdle()
  adapter.options.fail=false
  await assert.rejects(ctx.compaction.executeEmergency(agent,plan.token,new AbortController().signal))
  assert.equal(adapter.summaries.length,2)
 }finally{await ctx.fiber.dispose()}
})

test('emergency: configuration changes invalidate the precise confirmation envelope',async()=>{
 const {ctx,adapter,agent}=await fixture({fail:true})
 try {
  await exhaustForEmergency(ctx,agent)
  const plan=await ctx.compaction.prepareEmergency(agent,new AbortController().signal)
  changePolicy(ctx,{summaryTotalMs:700000})
  await assert.rejects(ctx.compaction.executeEmergency(agent,plan.token,new AbortController().signal))
  assert.equal(adapter.summaries.length,2)
  const end=agent.session.snapshotEvents().findLast(e=>e.type==='compaction/end')
  const run=ctx.contextManager.summaryOperations.run(String(agent.id),String(end.data.compactionId))
  assert.equal(run.dispatched,0);assert.ok(run.endedAt)
 }finally{await ctx.fiber.dispose()}
})

test('emergency: raw unended transport remains blocked after bounded harvesting expires',{timeout:31000},async()=>{
 const {ctx,adapter,agent}=await fixture({fail:true})
 let release,startedResolve;const started=new Promise(r=>startedResolve=r)
 try {
  agent.followup(message());await agent.whenIdle()
  const recovery=ctx.contextManager.idleStatus(String(agent.id)).recovery
  adapter.options.pause=async()=>{startedResolve();await new Promise(r=>release=r)}
  const abort=new AbortController()
  const rejected=assert.rejects(ctx.contextManager.authorizeRecovery(String(agent.id),recovery.authorizationToken,abort.signal))
  await started;abort.abort(new Error('user cancellation'));await rejected
  await new Promise(r=>setTimeout(r,21000))
  await assert.rejects(ctx.compaction.prepareEmergency(agent,new AbortController().signal),/未结束的摘要传输/)
  assert.equal(adapter.summaries.length,2)
 }finally{release?.();await immediate();await ctx.fiber.dispose()}
})

test('emergency: actual Session and domain restart reconciles only a complete committed bracket',async()=>{
 const first=await fixture({fail:true,keepStorage:true});let second
 try{
  await exhaustForEmergency(first.ctx,first.agent)
  const plan=await first.ctx.compaction.prepareEmergency(first.agent,new AbortController().signal)
  const ops=first.ctx.contextManager.summaryOperations,settle=ops.settle.bind(ops)
  ops.settle=async(session,id,phase,extra)=>{
   if(phase==='committed' && !ops.records(session).some(r=>r.operationId===id))throw new Error('simulated crash before emergency terminal write')
   return settle(session,id,phase,extra)
  }
  first.adapter.options.fail=false
  await first.ctx.compaction.executeEmergency(first.agent,plan.token,new AbortController().signal)
  assert.equal(ops.allRecords('subject').at(-1).phase,'recorded')
  const restored=await assertPhysicalSessionRestore(first.agent.session)
  await first.ctx.fiber.dispose()
  second=await fixture({storageRoot:first.storageRoot,contextWindow:20000},{},restored.snapshotEvents())
  assert.equal(second.ctx.contextManager.summaryOperations.emergencyStatus('subject').used,true)
  second.agent.followup(message('Warm up new source '.repeat(2200)));await second.agent.whenIdle()
  const newTask=message('Continue with genuinely new work. '.repeat(1400))
  second.agent.followup(newTask);await second.agent.whenIdle();completed(second.agent)
  assert.equal(second.adapter.summaries.length,1,'the new request drives reconciliation through the real summary claim path')
  assert.ok(second.agent.session.deriveMessages().some(item=>item.id===newTask.id))
  const emergency=second.ctx.contextManager.summaryOperations.allRecords('subject').find(r=>r.authorizationId===plan.token)
  assert.equal(emergency.phase,'committed')
  assert.equal(second.adapter.requests.length,2,'both genuinely new tasks complete once')
  assert.equal(second.adapter.work,0)
 }finally{await second?.ctx.fiber.dispose();await first.ctx.fiber.dispose();await rm(first.storageRoot,{recursive:true,force:true})}
})

for(const boundary of ['claim','ledger','bind','dispatch','policy','tools']) test(`emergency final gate: ${boundary} await cannot dispatch stale permission`,async t=>{
 t.mock.timers.enable({apis:['Date'],now:Date.now()})
 const {ctx,adapter,agent}=await fixture({fail:true})
 try{
  await exhaustForEmergency(ctx,agent)
  const plan=await ctx.compaction.prepareEmergency(agent,new AbortController().signal)
  const ops=ctx.contextManager.summaryOperations,ledger=ctx.contextManager.summaryLedger
  const target=boundary==='ledger'?ledger:ops
  const method=boundary==='claim'?'claimEmergency':boundary==='ledger'?'start':boundary==='bind'?'bind':'dispatchRun'
  const original=target[method].bind(target)
  target[method]=async(...args)=>{
   const result=await original(...args);await immediate()
   if(boundary==='policy')changePolicy(ctx,{summaryTotalMs:700000})
   else if(boundary==='tools'){
    const header=agent.session.requestHeader();agent.session.requestHeader=()=>({...header,tools:[...(header.tools??[]),{name:'changed-tool',description:'new schema',parameters:{}}]})
   }else t.mock.timers.tick(120001)
   return result
  }
  adapter.options.fail=false
  await assert.rejects(ctx.compaction.executeEmergency(agent,plan.token,new AbortController().signal))
  assert.equal(adapter.summaries.length,2,'no third stream may dispatch after the final await invalidated permission')
  const emergency=ops.allRecords('subject').at(-1)
  assert.equal(emergency.phase,'not_dispatched')
  const run=ops.run('subject',emergency.compactionId)
  assert.equal(run.actualDispatched,0)
  assert.equal(ops.emergencyStatus('subject').used,true,'durable claim is not silently refunded')
 }finally{await ctx.fiber.dispose()}
})

test('emergency: typed image failure never invokes public protocol recovery or rewrites original surface',async()=>{
 const {ctx,adapter,agent}=await fixture({fail:true});let recovered=0
 try{
  await exhaustForEmergency(ctx,agent)
  const plan=await ctx.compaction.prepareEmergency(agent,new AbortController().signal)
  const original=agent.session.deriveMessages()
  ctx.on('compaction/summary-error',(payload,next)=>{
   if(payload.error instanceof LlmError && payload.error.code==='IMAGE_OFFLOAD_REQUIRED'){recovered++;return true}
   return next()
  },true)
  adapter.options.fail=false;adapter.options.imageFailure=true
  await assert.rejects(ctx.compaction.executeEmergency(agent,plan.token,new AbortController().signal))
  assert.equal(recovered,0);assert.equal(adapter.summaries.length,3)
  assert.deepEqual(agent.session.deriveMessages(),original)
 }finally{await ctx.fiber.dispose()}
})


test('emergency: unloaded ID resolves through injected public Typert lookup without model dispatch',async()=>{
 const {ctx,adapter,agent}=await fixture({fail:true})
 try {
  await exhaustForEmergency(ctx,agent)
  const {ContextRecovery}=await import('../lib/inspector.js');await ctx.plugin(ContextRecovery)
  let resolved=0
  ctx.typert.lookups.configure('agent',async id=>{assert.equal(id,'cold-lookup');resolved++;return agent})
  assert.equal(ctx.agents.get(SessionId('cold-lookup')),undefined)
  const before=agent.session.snapshotEvents()
  const plan=await ctx.contextRecovery.prepareEmergency({sessionId:'cold-lookup'},new AbortController().signal)
  assert.equal(resolved,1);assert.ok(plan.token)
  assert.equal(adapter.summaries.length,2);assert.deepEqual(agent.session.snapshotEvents(),before)
 }finally{await ctx.fiber.dispose()}
})


test('checkpoint format: a policy without the field reads the JSON default', { timeout: 8000 }, async () => {
  const { ctx, agent, adapter } = await fixture()
  try {
    assert.equal(ctx.contextManager.snapshot().checkpointFormat, 'json')
    agent.followup(message()); await agent.whenIdle()
    const instruction = adapter.summaries[0].messages.at(-1).content.filter(block => block.type === 'text').map(block => block.text).join('')
    assert.match(instruction, /Return exactly one JSON object/)
  } finally { await ctx.fiber.dispose() }
})

test('section checkpoint: opt-in protocol requests sections, commits and keeps the versioned marker', { timeout: 8000 }, async () => {
  const { ctx, adapter, agent } = await fixture({ sectionsText: true }, { checkpointFormat: 'sections' })
  try {
    const task = message(); agent.followup(task); await agent.whenIdle()
    assert.equal(ctx.contextManager.snapshot().checkpointFormat, 'sections', 'the saved policy choice reaches the engine')
    assert.equal(adapter.summaries.length, 1)
    const instruction = adapter.summaries[0].messages.at(-1).content.filter(block => block.type === 'text').map(block => block.text).join('')
    assert.match(instruction, /## 当前目标/)
    assert.ok(!instruction.includes('Return exactly one JSON object'), 'section protocol must not ask for JSON')
    assert.equal(agent.session.snapshotEvents().filter(event => event.type === 'compaction/summary').length, 1)
    const checkpoint = agent.session.snapshotEvents().find(event => event.type === 'compaction/summary').data.summary.map(block => block.text).join('')
    assert.match(checkpoint, /Checkpoint schema: context-manager\/3/)
    assert.match(checkpoint, /保持唯一写入者与授权边界/)
    assert.deepEqual(adapter.requests[0].messages.find(item => item.id === task.id).content, task.content)
    completed(agent)
  } finally { await ctx.fiber.dispose() }
})

test('real loop checkpoint replay: long task commits exact facts, survives JSONL restart, then continues once', { timeout: 30000 }, async () => {
  const checkpoint = {
    goal: '完成长任务并保持验收证据',
    constraints: [
      '最新纠正：不要覆盖用户已有修改',
      '唯一写入者：当前 Context 开发会话',
      '这是一条多行约束\n第二行仍属于同一个事实',
    ],
    completed: ['已运行唯一一次外部副作用工具，原结果仍在日志中'],
    pending: ['修复失败的 acceptance A-17，再按原命令复验'],
    evidence: ['/workspace/Deepseek Harness/插件/verify.mjs:42\n$ node verify.mjs --mode "strict"'],
    next: '先恢复 A-17，再执行精确引用的命令并记录结果',
    uncertainties: ['远端真实模型对语义压缩的保真度尚未测量'],
  }
  const seedFacts = [
    ...checkpoint.constraints, ...checkpoint.completed, ...checkpoint.pending, ...checkpoint.evidence,
    checkpoint.goal, checkpoint.next, ...checkpoint.uncertainties,
  ].join('\n')
  const first = await fixture({
    persistSession: true, keepStorage: true, tools: true, checkpointText: JSON.stringify(checkpoint),
  }, { idleEnabled: false }, history(31600, false, seedFacts))
  let second
  const original = first.agent
  try {
    const taskText = [
      '完成长任务。', checkpoint.constraints[0], checkpoint.constraints[1], checkpoint.pending[0],
      checkpoint.evidence[0], '失败验收：A-17 仍然失败。',
    ].join('\n')
    const task = message(taskText)
    original.followup(task)
    await original.whenIdle()
    assert.equal(original.session.snapshotEvents().at(-1)?.data?.reason?.kind, 'completed', JSON.stringify({
      order: first.adapter.order, operations: first.ctx.contextManager.summaryOperations.records(String(original.id)),
      reason: original.session.snapshotEvents().at(-1)?.data?.reason,
    }))
    assert.deepEqual(first.adapter.order, ['summary-start', 'summary-finish', 'main', 'tool', 'main'])
    assert.equal(first.adapter.work, 1, 'the side effect is executed once')
    assert.equal(first.adapter.summaries.length, 1, 'one successful compaction, no repair call')
    assert.equal(original.session.snapshotEvents().filter(event => event.type === 'user/message' && event.data.id === task.id).length, 1)
    assert.deepEqual(first.adapter.requests.at(-1).messages.find(item => item.id === task.id)?.content, task.content)

    const events = original.session.snapshotEvents()
    const commits = events.filter(event => event.type === 'compaction/summary')
    const results = events.filter(event => event.type === 'tool/result' && event.surfaceOp === 'append')
    assert.equal(commits.length, 1)
    assert.equal(results.length, 1)
    assert.ok(!commits[0].data.shadowedSeqs.includes(results[0].seq), 'the tool result generated after compaction stays as a separate one-time event')
    const summaryText = commits[0].data.summary.filter(block => block.type === 'text').map(block => block.text).join('\n')
    assert.deepEqual(parseCheckpoint(summaryText), checkpoint, 'the committed checkpoint round-trips every exact fact')
    for (const fact of [checkpoint.constraints[0], checkpoint.constraints[1], checkpoint.completed[0], checkpoint.pending[0], checkpoint.next, checkpoint.uncertainties[0]]) {
      assert.ok(summaryText.includes(fact), `committed checkpoint keeps ${fact}`)
    }
    assert.ok(summaryText.includes('- >这是一条多行约束\n  >第二行仍属于同一个事实'))
    assert.ok(summaryText.includes('- >/workspace/Deepseek Harness/插件/verify.mjs:42\n  >$ node verify.mjs --mode "strict"'))
    const compactedMessage = events[commits[0].seq + 1]
    assert.equal(compactedMessage.type, 'user/message')
    assert.ok(commits[0].data.shadowedSeqs.every(seq => compactedMessage.sourceEventSeqs.includes(seq)), 'the replacement retains all summarized source-event lineage')
    const taskEvent = events.find(event => event.type === 'user/message' && event.data.id === task.id)
    assert.ok(taskEvent && !commits[0].data.shadowedSeqs.includes(taskEvent.seq), 'the active task stays verbatim outside the summary range')
    const summaryInput = first.adapter.summaries[0].messages.map(item => (item.content ?? []).filter(block => block.type === 'text').map(block => block.text).join('')).join('\n')
    for (const fact of [checkpoint.constraints[0], checkpoint.constraints[1], checkpoint.pending[0], ...checkpoint.evidence[0].split('\n')]) {
      assert.ok(summaryInput.includes(fact), `the real loop supplied ${fact} to the summarizer`)
    }

    assert.equal(await first.ctx.sessions.flush(original.session), true, 'the production JSONL persistence layer acknowledges the committed log')
    await assertPhysicalSessionRestore(original.session)
    await first.ctx.fiber.dispose()

    second = await fixture({ storageRoot: first.storageRoot, keepStorage: true, persistSession: true, skipCreate: true }, { idleEnabled: false })
    const { agent: resumed } = await second.ctx.agents.resume({
      resumeSessionId: SessionId('subject'), agentOptions: { provider: 'mock', model: 'large' },
    })
    assert.notEqual(resumed.session, original.session, 'restart reads a new Session from persisted JSONL')
    const reopenedEvents = resumed.session.snapshotEvents()
    const reopenedCommit = reopenedEvents.find(event => event.type === 'compaction/summary')
    assert.ok(reopenedCommit)
    const reopenedText = reopenedCommit.data.summary.filter(block => block.type === 'text').map(block => block.text).join('\n')
    assert.deepEqual(parseCheckpoint(reopenedText), checkpoint, 'the stored event log restores the complete checkpoint')
    assert.equal(reopenedEvents.filter(event => event.type === 'tool/result' && event.surfaceOp === 'append').length, 1)
    assert.equal(reopenedEvents.filter(event => event.type === 'user/message' && event.data.id === task.id).length, 1)
    assert.equal(second.adapter.requests.length, 0, 'resume never replays the finished task or tool call')

    const followup = message('继续 A-17；保留唯一写入者与原始验收路径。')
    resumed.followup(followup)
    await resumed.whenIdle()
    completed(resumed)
    assert.equal(second.adapter.work, 0, 'the restored tool result is not executed again')
    assert.equal(second.adapter.summaries.length, 0, 'the completed summary is not generated again')
    assert.equal(second.adapter.requests.length, 1)
    const continuedInput = second.adapter.requests[0].messages.map(item => (item.content ?? []).filter(block => block.type === 'text').map(block => block.text).join('')).join('\n')
    for (const fact of [checkpoint.constraints[0], checkpoint.constraints[1], checkpoint.pending[0], ...checkpoint.evidence[0].split('\n')]) {
      assert.ok(continuedInput.includes(fact), `the restored task continues with ${fact}`)
    }
    assert.equal(resumed.session.snapshotEvents().filter(event => event.type === 'tool/result' && event.surfaceOp === 'append').length, 1)
  } finally {
    await second?.ctx.fiber.dispose()
    await first.ctx.fiber.dispose()
    await rm(first.storageRoot, { recursive: true, force: true })
  }
})

test('real loop semantic replay: two compactions preserve prior facts and the latest checkpoint survives JSONL restart', { timeout: 45000 }, async () => {
  const firstCheckpoint = {
    goal: '完成风险恢复回归并保留可审查证据',
    constraints: [
      '最新纠正：只有 committed 风险接受才持久生效，not_dispatched 必须允许新授权',
      '唯一写入者：当前 Context 开发会话',
    ],
    completed: ['原风险调用费用仍未知，绝不可自动再次收费'],
    pending: ['失败验收：RISK-17 需在 not_dispatched 重启后获得新的显式授权并成功 claim'],
    evidence: ['synthetic://context-manager/recovery/risk-accepted-not-dispatched-retry.test.mjs:1'],
    next: '完成第二轮摘要后恢复 session，继续核对提交状态',
    uncertainties: ['真实模型的语义保真度尚未验证'],
  }
  const secondCheckpoint = {
    ...firstCheckpoint,
    completed: [...firstCheckpoint.completed, '第二轮压缩也保留了首轮 checkpoint 的授权、失败验收和证据路径'],
    pending: [
      '失败验收仍未完成：RISK-17 需在 not_dispatched 重启后获得新的显式授权并成功 claim',
      '重启后继续读取 RISK-17 的恢复状态，不重放旧摘要调用',
    ],
    next: '重启后读取 RISK-17 恢复状态；若验收仍未完成，重新取得显式授权并完成一次 claim',
  }
  const initialFacts = [
    ...firstCheckpoint.constraints, ...firstCheckpoint.completed, ...firstCheckpoint.pending,
    ...firstCheckpoint.evidence, firstCheckpoint.goal, firstCheckpoint.next, ...firstCheckpoint.uncertainties,
  ]
  const checkpointFacts = [
    ...firstCheckpoint.constraints, ...firstCheckpoint.completed, ...firstCheckpoint.pending,
    ...firstCheckpoint.evidence, firstCheckpoint.goal, firstCheckpoint.next, ...firstCheckpoint.uncertainties,
  ]
  const checkpointText = (options, round) => {
    const inputText = options.messages.map(item => (item.content ?? []).filter(block => block.type === 'text')
      .map(block => block.text).join('')).join('\n')
    assert.ok(round === 1 || round === 2, `unexpected compaction round ${round}`)
    const required = round === 1 ? initialFacts : checkpointFacts
    for (const fact of required) assert.ok(inputText.includes(fact), `round ${round} input must contain ${fact}`)
    return JSON.stringify(round === 1 ? firstCheckpoint : secondCheckpoint)
  }
  const seedFacts = initialFacts.join('\n')
  const first = await fixture({ persistSession: true, keepStorage: true, tools: true,
    toolOutput: 'one-shot side effect result: keep this exact result in the durable session', checkpointText,
  }, { idleEnabled: false }, history(31600, false, seedFacts))
  let second
  const original = first.agent
  const extraTasks = []
  try {
    const task = message([
      '完成两轮语义压缩回归。', ...firstCheckpoint.constraints, ...firstCheckpoint.pending,
      ...firstCheckpoint.evidence, '原始工具结果不得重放。',
    ].join('\n'))
    original.followup(task)
    await original.whenIdle()
    completed(original)
    assert.equal(first.adapter.summaries.length, 1)
    assert.equal(first.adapter.work, 1, 'the side effect runs once before the checkpoint is committed')

    for (let index = 0; index < 120 && first.adapter.summaries.length < 2; index++) {
      const extra = message(`续跑阶段 ${index + 1}：${'核对当前进展并保留原验收状态。'.repeat(18)}`)
      extraTasks.push(extra)
      original.followup(extra)
      await original.whenIdle()
      completed(original)
    }

    const events = original.session.snapshotEvents()
    const commits = events.filter(event => event.type === 'compaction/summary')
    const results = events.filter(event => event.type === 'tool/result' && event.surfaceOp === 'append')
    assert.equal(commits.length, 2, 'accumulated follow-up work drives a second real loop compaction')
    assert.equal(first.adapter.summaries.length, 2)
    assert.equal(first.adapter.work, 1, 'the one-shot side effect is not replayed across either compaction')
    assert.equal(results.length, 1)
    for (const [index, expected] of [[0, firstCheckpoint], [1, secondCheckpoint]]) {
      const text = commits[index].data.summary.filter(block => block.type === 'text').map(block => block.text).join('\n')
      assert.deepEqual(parseCheckpoint(text), expected)
    }
    assert.equal(events.filter(event => event.type === 'user/message' && event.data.id === task.id).length, 1)
    for (const extra of extraTasks) {
      assert.equal(events.filter(event => event.type === 'user/message' && event.data.id === extra.id).length, 1,
        'each accumulated continuation is admitted once')
    }
    const priorCheckpoint = events[commits[0].seq + 1]
    assert.equal(priorCheckpoint.type, 'user/message')
    assert.ok(commits[1].data.shadowedSeqs.includes(priorCheckpoint.seq),
      'the second selected span includes the earlier checkpoint, so its summary may merge those facts')

    assert.equal(await first.ctx.sessions.flush(original.session), true)
    await assertPhysicalSessionRestore(original.session)
    await first.ctx.fiber.dispose()

    second = await fixture({ storageRoot: first.storageRoot, keepStorage: true, persistSession: true, skipCreate: true }, { idleEnabled: false })
    const { agent: resumed } = await second.ctx.agents.resume({
      resumeSessionId: SessionId('subject'), agentOptions: { provider: 'mock', model: 'large' },
    })
    const restored = resumed.session.snapshotEvents()
    assert.equal(restored.filter(event => event.type === 'user/message' && event.data.id === task.id).length, 1)
    assert.equal(restored.filter(event => event.type === 'compaction/summary').length, 2)
    const restoredLast = restored.filter(event => event.type === 'compaction/summary').at(-1)
    const restoredText = restoredLast.data.summary.filter(block => block.type === 'text').map(block => block.text).join('\n')
    assert.deepEqual(parseCheckpoint(restoredText), secondCheckpoint)
    assert.equal(restored.filter(event => event.type === 'tool/result' && event.surfaceOp === 'append').length, 1)
    assert.equal(second.adapter.summaries.length, 0, 'restart does not regenerate either checkpoint')
    assert.equal(second.adapter.requests.length, 0, 'restart does not replay the completed user task')

    resumed.followup(message('继续按第二轮 checkpoint 核对 RISK-17。'))
    await resumed.whenIdle()
    completed(resumed)
    assert.equal(second.adapter.work, 0)
    assert.equal(second.adapter.summaries.length, 0)
    const continued = second.adapter.requests[0].messages.map(item => (item.content ?? []).filter(block => block.type === 'text')
      .map(block => block.text).join('')).join('\n')
    const resumedFacts = [
      ...firstCheckpoint.constraints, ...firstCheckpoint.completed, ...secondCheckpoint.pending,
      ...secondCheckpoint.evidence, secondCheckpoint.goal, secondCheckpoint.next, ...secondCheckpoint.uncertainties,
    ]
    for (const fact of resumedFacts) assert.ok(continued.includes(fact), `resumed request retains ${fact}`)
    assert.ok(continued.includes(secondCheckpoint.completed.at(-1)))
    assert.equal(resumed.session.snapshotEvents().filter(event => event.type === 'tool/result' && event.surfaceOp === 'append').length, 1)
  } finally {
    await second?.ctx.fiber.dispose()
    await first.ctx.fiber.dispose()
    await rm(first.storageRoot, { recursive: true, force: true })
  }
})

test('percent: actual request summary obeys window-based output cap and continues once',async()=>{
 const {ctx,adapter,agent}=await fixture({}, {capacityMode:'percent',recentPercent:10,summaryPercent:5,repairPercent:1})
 try{
  agent.followup(message());await agent.whenIdle()
  assert.equal(adapter.summaries.length,1)
  assert.ok(adapter.summaries[0].maxTokens<=500)
  assert.ok(adapter.requests.length>0);completed(agent)
 }finally{await ctx.fiber.dispose()}
})

for (const target of ['steer', 'followup']) test(`pre-dispatch ${target} handoff settles summary usage without a false unknown`, { timeout: 12000 }, async t => {
  const { ctx, adapter, agent } = await fixture({}, {}, history((7990 - 21) * 4))
  try {
    if (agent.supportsRequestErrorHandoff !== true) {
      t.skip('requires the opt-in Host AgentLoop request-error handoff capability')
      return
    }
  const original = message(`original pressure task for ${target}`)
  const queued = message(`new ${target} task must continue automatically`)
  const ledger = ctx.contextManager.summaryLedger
  const originalStart = ledger.start.bind(ledger)
  let injected = false
  let compactionStreams = 0
  ledger.start = async (...args) => {
    const attempt = await originalStart(...args)
    if (!injected) {
      injected = true
      if (target === 'steer') agent.steer(queued)
      else agent.followup(queued)
    }
    return attempt
  }
  ctx.on('llm/stream', async function* (options, next) {
    if (options.purpose === 'compaction') compactionStreams++
    yield* next()
  }, true)
    agent.followup(original)
    await agent.whenIdle()

    const id = String(agent.id)
    const operationRuns = ctx.contextManager.summaryOperations.records(id).map(row => ({
      phase: row.phase, run: ctx.contextManager.summaryOperations.run(id, row.compactionId),
    }))
    const stats = ledger.stats(id)
    assert.ok(operationRuns.some(item => item.phase === 'not_dispatched' && item.run?.actualDispatched === 0))
    assert.ok(operationRuns.some(item => item.phase === 'committed'))
    assert.equal(compactionStreams, 1, 'only the replacement summary reaches llm/stream')
    assert.equal(adapter.summaries.length, 1)
    assert.equal(adapter.requests.length, 1, 'the queued task completes without a second user message')
    assert.deepEqual(adapter.order, ['summary-start', 'summary-finish', 'main'])
    assert.equal(stats.unknownAttempts, 0)
    assert.ok(stats.recent.some(item => item.status === 'not_dispatched' && item.input === null && item.output === null))
    assert.deepEqual(agent.inbox.nextStep, [])
    assert.deepEqual(agent.inbox.nextTurn, [])
    assert.ok(adapter.requests[0].messages.some(item => item.id === queued.id))
    completed(agent)
  } finally { await ctx.fiber.dispose() }
})
