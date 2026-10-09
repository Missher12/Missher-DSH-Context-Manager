import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setImmediate as immediate } from 'node:timers/promises'
import { Context } from '@deepseek-ai/cordis'
import Storage from '@deepseek-ai/dsh-storage'
import { DomainFacility } from '@deepseek-ai/dsh-storage-domain'
import { JsonStorageBackend } from '@deepseek-ai/dsh-storage-json'
import { LlmAdapter, ToolCallId, createMessage, createToolResultMessage,
  createUserMessage, resolveRetryPolicy } from '@deepseek-ai/dsh-llm'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import { sessionFormatCatalog } from '@deepseek-ai/dsh-session-format-catalog'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import TokenMeter from '@deepseek-ai/dsh-token-meter'
import { BasicCompactionEngine } from '@deepseek-ai/dsh-compaction-basic'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import { defineContentToolFixture } from '@deepseek-ai/dsh-tools'
import * as Retry from '@deepseek-ai/dsh-llm-retry'
import Manager from '../lib/index.js'
import Engine from '../lib/engine.js'
import { budget, defaults } from '../lib/policy.js'

// Run this same file against naturally old and enhanced SDK installations.
// Never erase a capability marker or replace a Host's storage close method.
const WINDOW = 200000
const SESSION = 'portable-host-subject'
const TOOL_MARKER = 'ORIGINAL_TOOL_EVIDENCE_MUST_REMAIN_IN_HISTORY:'
const POLICY = { ...defaults, absoluteEnabled: true, absoluteTriggerTokens: 200000,
  absoluteTargetTokens: 100000, summaryMaxTokens: 512, maxPasses: 1, idleEnabled: false }
const USAGE = { inputTokens: 700, outputTokens: 23, cacheReadTokens: 90, cacheWriteTokens: 10 }
const TOTALS = { input: 800, output: 23, cacheRead: 90, cacheWrite: 10, attempts: 1, unknownAttempts: 0 }
const counters = stats => Object.fromEntries(Object.keys(TOTALS).map(key => [key, stats[key]]))
const message = text => createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } })
const commits = agent => agent.session.snapshotEvents().filter(event => event.type === 'compaction/summary')
const checkpoint = JSON.stringify({ goal: 'Continue the exact pending task', constraints: ['Keep unrelated files unchanged'],
  completed: ['Read the old tool evidence'], pending: ['Execute the current task'],
  evidence: ['The original tool result is retained in the session transcript'], next: 'Continue', uncertainties: [] })

function deferred() {
  let resolve
  const promise = new Promise(done => { resolve = done })
  return { promise, resolve }
}

async function until(predicate, description) {
  const deadline = performance.now() + 5000
  while (performance.now() < deadline) {
    if (predicate()) return
    await immediate()
  }
  assert.ok(predicate(), description)
}

class Adapter extends LlmAdapter {
  order = []
  summaries = []
  requests = []
  summaryClosed = 0
  work = 0
  constructor(options = {}) { super(); this.options = options }
  async resolveModel(provider, model) {
    return { provider, id: model, name: model, context: { contextWindow: WINDOW },
      defaultMaxTokens: this.options.outputReserve ?? 8192 }
  }
  providerRetryPolicy() { return resolveRetryPolicy({ mode: 'normal', maxRetries: 0 }, 'portable-host-test') }
  async *stream(options) {
    if (options.purpose === 'compaction') {
      this.order.push('summary')
      this.summaries.push(options)
      try {
        // Deliberately ignore AbortSignal only in the late-provider fixture.
        if (this.options.pause) await this.options.pause()
        for (let n = 0; n < (this.options.usageCopies ?? 1); n++) yield { type: 'usage', usage: { ...USAGE } }
        yield { type: 'block-start', index: 0, blockType: 'text' }
        yield { type: 'block-end', index: 0, block: { type: 'text', text: this.options.checkpoint ?? checkpoint } }
        yield { type: 'finish', reason: { kind: 'stop' } }
      } finally { this.summaryClosed++ }
      return
    }
    this.order.push('business')
    this.requests.push(options)
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'block-end', index: 0, block: { type: 'text', text: 'done' } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

function history(length) {
  const session = Session.create(SessionId('portable-seed'))
  const callId = ToolCallId('portable-old-read')
  session.append('turn/start', { turn: 1 })
  session.append('step/start', { turn: 1, step: 1 })
  session.append('system/message', { turn: 1, step: 1, message: createMessage({ role: 'system',
    content: [], source: { kind: 'system-prompt' } }) }, { surfaceOp: 'append' })
  session.append('user/message', message('Read the original evidence without changing any files.'), { surfaceOp: 'append' })
  session.append('assistant/message', { stream: [], turn: 1, step: 1, message: createMessage({ role: 'assistant',
    source: { kind: 'model', provider: 'mock', model: 'window-200k' },
    content: [{ type: 'tool-call', id: callId, name: 'work', arguments: '{}' }] }) }, { surfaceOp: 'append' })
  session.append('tool/call', { turn: 1, step: 1, callId, name: 'work', arguments: '{}' })
  session.append('tool/result', { turn: 1, step: 1, message: createToolResultMessage({ callId,
    content: [{ type: 'text', text: TOOL_MARKER + 'h'.repeat(length) }], isError: false }) }, { surfaceOp: 'append' })
  session.append('step/end', { turn: 1, step: 1 })
  session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
  return session.snapshotEvents()
}

function assertPairs(messages) {
  const pending = new Set()
  for (const item of messages) {
    for (const block of item.content) {
      if (block.type === 'tool-call') {
        assert.ok(!pending.has(block.id), 'tool call identity is not duplicated')
        pending.add(block.id)
      }
    }
    if (item.role === 'tool') {
      assert.ok(pending.delete(item.toolCallId), 'each result retains its preceding tool call')
    }
  }
  assert.equal(pending.size, 0, 'no tool call is left without its result')
}

function assertHistory(agent, before) {
  const events = agent.session.snapshotEvents()
  assert.deepEqual(events.slice(0, before.length), before, 'every original event remains byte-equivalent JSON')
  assert.ok(events.some(event => event.type === 'tool/result'
    && event.data.message.content.some(block => block.type === 'text' && block.text.startsWith(TOOL_MARKER))))
  assertPairs(agent.session.deriveMessages())
  const restore = sessionFormatCatalog.createRestore({ type: 'session', version: 4, id: SESSION,
    createdAt: 1, delegationDepth: 0, isSeeded: false }, { recovery: 'strict', validation: 'current' })
  for (const event of events) restore.decodeRow(JSON.parse(JSON.stringify(sessionFormatCatalog.encodeCurrentEvent(event))))
  assert.equal(restore.finish().events.length, events.length, 'the committed transcript passes the real strict V4 decoder')
}

function closedOnly(error) {
  if (error instanceof AggregateError) return error.errors.length > 0 && error.errors.every(closedOnly)
  return error instanceof Error && (error.code === 'closed' || /\bclosed\b/iu.test(error.message))
}

async function harness(t) {
  const profile = await mkdtemp(join(tmpdir(), 'dsh-context-portable-'))
  const active = new Set()
  async function boot(options = {}, seed) {
    const ctx = new Context()
    ctx.provide('profileContext', { dir: profile })
    await ctx.plugin(Storage)
    const backend = new JsonStorageBackend(join(profile, 'storage'))
    ctx.storage.backend.register('json', backend)
    const facility = new DomainFacility(ctx, { backend: 'json' })
    ctx.storage.mount('domain', facility)
    ctx.provide('storageDomain', facility)
    const runtime = { ctx, backend, facility, profile, storageClosedEarly: false }
    active.add(runtime)
    await mountAgentLoopTestDependencies(ctx)
    await ctx.plugin(AgentLoop, { agents: [] })
    await ctx.plugin(TokenMeter)
    await ctx.plugin(Retry)
    await ctx.plugin(Manager, { policy: { ...POLICY, ...options.policy } })
    await ctx.plugin(Engine)
    const adapter = new Adapter(options)
    runtime.adapter = adapter
    ctx.llm.registerAdapter(['mock'], adapter)
    ctx.tools.register(defineContentToolFixture({ name: 'work', description: 'Fixture tool', parameters: {},
      async execute() { adapter.work++; return [{ type: 'text', text: 'fixture complete' }] } }))
    if (seed !== undefined) {
      const { agent } = await ctx.agentLoop.createAgent(ctx, { sessionId: SessionId(SESSION), seed,
        agentOptions: { provider: 'mock', model: 'window-200k' } })
      runtime.agent = agent
    }
    return runtime
  }
  async function stop(runtime) {
    if (!active.has(runtime)) return
    const outcomes = []
    // Manager gets the first opportunity to drain and release its journal.
    // The old-host test has already closed the actual Domain/JSON explicitly.
    for (const close of [() => runtime.ctx.fiber.dispose(), () => runtime.facility.closeAll(), () => runtime.backend.close()]) {
      try { await close() } catch (error) { outcomes.push(error) }
    }
    active.delete(runtime)
    if (runtime.storageClosedEarly) {
      assert.ok(outcomes.every(closedOnly), 'only the deliberate closed-domain flush may fail during disposal')
    } else if (outcomes.length) throw new AggregateError(outcomes, 'Portable fixture disposal failed')
  }
  async function pending() {
    return JSON.parse(await readFile(join(profile, '.context-manager-recovery', 'pending.json'), 'utf8'))
  }
  async function savedSummary() {
    return JSON.parse(await readFile(join(profile, 'storage', 'context_manager_summaries.json'), 'utf8')).tables.sessions[SESSION]
  }
  t.after(async () => {
    try { for (const runtime of active) await stop(runtime) }
    finally { await rm(profile, { recursive: true, force: true }) }
  })
  return { boot, stop, pending, savedSummary }
}

async function seedAt(env, target) {
  const calibration = await env.boot({ policy: { enabled: false } }, history(4000))
  const overhead = calibration.ctx.tokenMeter.measure(calibration.agent.session).totalTokens - 1000
  await env.stop(calibration)
  return history(Math.max(0, Math.round((target - overhead) * 4)))
}

test('portable host: a real 200K window clamps a 200K absolute trigger below capacity', () => {
  for (const [reserve, expectedAdmission, source] of [[8192, 158000, 'percent'], [60000, 134000, 'hard']]) {
    const limits = budget(POLICY, WINDOW, reserve)
    assert.equal(limits.window, 200000)
    assert.equal(limits.absoluteTrigger, 200000)
    assert.equal(limits.admission, expectedAdmission)
    assert.equal(limits.admissionSource, source)
    assert.equal(limits.hard, WINDOW - reserve - 4000)
    assert.ok(limits.admission < 200000)
  }
})

for (const [reserve, expectedAdmission] of [[8192, 158000], [60000, 134000]]) {
  test(`portable host: real 200K incoming pressure compacts before business (output reserve ${reserve})`,
    { timeout: 20000 }, async t => {
      const env = await harness(t)
      const runtime = await env.boot({ outputReserve: reserve }, await seedAt(env, expectedAdmission - 500))
      const { ctx, adapter, agent } = runtime
      const model = await ctx.llm.resolveModelInfo('mock', 'window-200k')
      assert.equal(model.context.contextWindow, WINDOW, 'the actual LlmRuntime route exposes 200K, not 1M')
      assert.equal(model.defaultMaxTokens, reserve)
      const beforeTokens = ctx.tokenMeter.measure(agent.session).totalTokens
      assert.ok(Math.abs(beforeTokens - (expectedAdmission - 500)) <= 2, `host meter measured ${beforeTokens}`)
      const before = agent.session.snapshotEvents()
      const task = message('请原样执行当前任务，不改无关文件。' + 'x'.repeat(4000))
      agent.followup(task)
      await agent.whenIdle()
      assert.deepEqual(adapter.order, ['summary', 'business'])
      assert.equal(adapter.work, 0)
      assert.equal(commits(agent).length, 1)
      assert.equal(agent.session.snapshotEvents().at(-1).data.reason.kind, 'completed')
      assert.deepEqual(adapter.requests[0].messages.find(item => item.id === task.id)?.content, task.content)
      assert.ok(adapter.summaries[0].messages.some(item => item.role === 'tool'), 'the large tool group enters the summary together')
      assertPairs(adapter.summaries[0].messages)
      assertPairs(adapter.requests[0].messages)
      assertHistory(agent, before)
      assert.deepEqual(counters(ctx.contextManager.summaryLedger.stats(SESSION)), TOTALS)
      await env.stop(runtime)
    })
}

test('portable host: naturally old Basic without supportsSummaryAbortCommit still compacts', { timeout: 20000 }, async t => {
  if (BasicCompactionEngine.supportsSummaryAbortCommit === true) {
    t.skip('Enhanced SDK has the real static capability; run the unchanged file on the old SDK for this case')
    return
  }
  assert.equal(BasicCompactionEngine.supportsSummaryAbortCommit, undefined, 'the installed old Basic is unmodified')
  const env = await harness(t)
  const { ctx, adapter, agent } = await env.boot({}, await seedAt(env, 159000))
  assert.equal(ctx.contextManager.supportsSafeShutdown, true, 'the plugin owns a profile recovery journal')
  agent.followup(message('Continue using the plugin-owned transaction.'))
  await agent.whenIdle()
  assert.deepEqual(adapter.order, ['summary', 'business'])
  assert.equal(commits(agent).length, 1)
})

test('portable host: cancellation during the final ledger finish await cannot commit', { timeout: 20000 }, async t => {
  const env = await harness(t)
  const { ctx, adapter, agent } = await env.boot({}, await seedAt(env, 159000))
  const before = agent.session.snapshotEvents()
  const ledger = ctx.contextManager.summaryLedger
  const entered = deferred(), release = deferred()
  const finish = ledger.finish
  let paused = false
  ledger.finish = async function (...args) {
    await finish.apply(this, args)
    if (args[2] === 'generated' && !paused) {
      paused = true
      entered.resolve()
      await release.promise
    }
  }
  const task = message('Keep this task and all original evidence on cancellation.')
  try {
    agent.followup(task)
    await until(() => paused, 'the final successful finish must reach its awaited boundary')
    await entered.promise
    assert.equal(commits(agent).length, 0)
    assert.deepEqual(counters(ledger.stats(SESSION)), TOTALS, 'provider usage was durably settled before cancellation')
    agent.cancel({ kind: 'user' })
    release.resolve()
    await agent.whenIdle()
    assert.deepEqual(adapter.order, ['summary'])
    assert.equal(adapter.work, 0)
    assert.equal(commits(agent).length, 0, 'generated accounting is not a committed checkpoint')
    assert.deepEqual(agent.session.deriveMessages().find(item => item.id === task.id)?.content, task.content)
    assertHistory(agent, before)
    assert.deepEqual(counters(ledger.stats(SESSION)), TOTALS)
  } finally {
    release.resolve()
    ledger.finish = finish
  }
})

test('portable host: old Domain/JSON close before late known usage recovers one attempt without model replay',
  { timeout: 25000 }, async t => {
    if (typeof DomainFacility.prototype.registerDrain === 'function'
      || typeof JsonStorageBackend.prototype.registerDrain === 'function') {
      t.skip('Enhanced SDK drains consumers before closing; this forced old ordering requires the unchanged old SDK')
      return
    }
    assert.equal(BasicCompactionEngine.supportsSummaryAbortCommit, undefined)
    const env = await harness(t)
    const entered = deferred(), release = deferred()
    const runtime = await env.boot({ pause: async () => { entered.resolve(); await release.promise }, usageCopies: 2 },
      await seedAt(env, 159000))
    const { ctx, adapter, agent, facility, backend } = runtime
    const before = agent.session.snapshotEvents()
    const table = facility.get('context_manager_summaries').table('sessions')
    const task = message('CANCELLED_TASK_BODY_MUST_NOT_ENTER_METADATA_JOURNAL')
    try {
      agent.followup(task)
      await until(() => adapter.summaries.length === 1, 'the paid attempt is started once before cancellation')
      await entered.promise
      const started = (await env.savedSummary()).recent[0]
      assert.equal(started.status, 'started', 'start completed its real JSON write before the provider stream')
      assert.equal(started.input, null)
      assert.deepEqual((await env.pending()).entries, [], 'no pending start write may mask the later closed-domain read')
      agent.cancel({ kind: 'user' })
      await agent.whenIdle()
      const cancelled = (await env.savedSummary()).recent[0]
      assert.equal(cancelled.id, started.id)
      assert.equal(cancelled.status, 'cancelled')
      assert.equal(cancelled.input, null)
      assert.equal(table.get(SESSION).recent[0].id, started.id)
      assert.deepEqual((await env.pending()).entries, [], 'cancel finish is durable before closing storage')
      await facility.closeAll()
      await backend.close()
      runtime.storageClosedEarly = true
      assert.equal(facility.get('context_manager_summaries'), undefined)
      assert.throws(() => table.get(SESSION), /closed/iu, 'the real Domain is closed, not a stubbed failure')
      await assert.rejects(() => backend.kv.open({ name: 'portable_closed_probe', version: 1,
        tables: ['sessions'], hasGlobal: false }), /closed/iu, 'the real JSON backend is closed too')
      const afterCancel = agent.session.snapshotEvents()
      release.resolve()
      await until(() => adapter.summaryClosed === 1, 'the same physical stream drains its late usage')
      const pending = await env.pending()
      const entries = pending.entries.filter(item => item.domain === 'context_manager_summaries' && item.key === SESSION)
      assert.equal(entries.length, 1)
      assert.equal(entries[0].next.recent.length, 1)
      const recovered = entries[0].next.recent[0]
      assert.deepEqual(recovered, { ...cancelled, input: 800, output: 23, cacheRead: 90, cacheWrite: 10 })
      assert.equal(recovered.compactionId, started.compactionId)
      assert.deepEqual(counters(ctx.contextManager.summaryLedger.stats(SESSION)), TOTALS)
      assert.equal((await env.savedSummary()).recent[0].input, null, 'closed Host storage was not bypassed')
      assert.ok(!JSON.stringify(pending).includes(TOOL_MARKER))
      assert.ok(!JSON.stringify(pending).includes(task.content[0].text))
      assert.ok(!JSON.stringify(pending).includes(checkpoint))
      assert.deepEqual(agent.session.snapshotEvents(), afterCancel, 'late text and usage append no session events')
      assertHistory(agent, before)
      assert.equal(commits(agent).length, 0)
      assert.deepEqual(adapter.order, ['summary'])
      await env.stop(runtime)

      // These are new Contexts, DomainFacilites and JsonStorageBackends. No
      // closed handle is read, no Agent is loaded, and no provider work is queued.
      for (let reopen = 0; reopen < 2; reopen++) {
        const next = await env.boot()
        const stats = next.ctx.contextManager.summaryLedger.stats(SESSION)
        assert.deepEqual(counters(stats), TOTALS, `reopen ${reopen + 1} does not add another charge`)
        assert.deepEqual(stats.recent, [recovered])
        assert.deepEqual((await env.savedSummary()).recent, [recovered])
        assert.deepEqual((await env.pending()).entries, [])
        await immediate()
        assert.deepEqual(next.adapter.order, [], 'opening/replaying metadata never calls the provider')
        await env.stop(next)
      }
    } finally { release.resolve() }
  })

// Deterministic continuation replay. It checks transport and retained facts;
// a mocked summary is not proof of an actual model's semantic quality.
test('working set: 200K long-task checkpoint leaves room for eight further tasks', { timeout: 20000 }, async t => {
  const env = await harness(t)
  const facts = { goal: 'Finish MSE acceptance', constraints: ['Correction: write only Context; coordinator alone installs'],
    completed: ['Offline checks passed'], pending: ['Ubuntu native acceptance remains open'],
    evidence: ['/tmp/acceptance.json: failure E42', 'branch context-fix; commit abc123'],
    next: 'Reproduce E42 and preserve the original sessions', uncertainties: ['Real Qwen model has not been accepted'] }
  const seed = structuredClone(await seedAt(env, 159000))
  const tool = seed.find(event => event.type === 'tool/result')
  tool.data.message.content[0].text = tool.data.message.content[0].text + '\n' + JSON.stringify(facts)
  const runtime = await env.boot({ checkpoint: JSON.stringify(facts) }, seed)
  const { ctx, agent, adapter } = runtime
  const original = agent.session.snapshotEvents()
  agent.followup(message('Continue; the latest correction is no installation without the coordinator.'))
  await agent.whenIdle()
  assert.equal(commits(agent).length, 1)
  assert.equal(adapter.requests.length, 1)
  const firstPressure = ctx.tokenMeter.measure(agent.session).totalTokens
  assert.ok(firstPressure < 40000, `working set, not a fixed 100K target: ${firstPressure}`)
  const input = JSON.stringify(adapter.summaries[0].messages)
  const resumed = JSON.stringify(adapter.requests[0].messages)
  for (const value of Object.values(facts).flat()) {
    assert.ok(input.includes(value), `original fact reached summary: ${value}`)
    assert.ok(resumed.includes(value), `accepted fact reached continuation: ${value}`)
  }
  for (let i = 0; i < 8; i++) {
    const task = message(`Follow-up ${i}: preserve all earlier constraints. ` + 'new-work '.repeat(4000))
    agent.followup(task); await agent.whenIdle()
    assert.deepEqual(adapter.requests.at(-1).messages.find(item => item.id === task.id)?.content, task.content)
    assert.equal(agent.session.snapshotEvents().at(-1).data.reason.kind, 'completed')
  }
  assert.equal(adapter.summaries.length, 1, 'new moderate work must not recompact the same checkpoint each turn')
  assert.equal(adapter.requests.length, 9)
  assert.equal(ctx.contextManager.summaryOperations.records(SESSION).length, 1)
  assertHistory(agent, original)
  for (const request of adapter.requests) assertPairs(request.messages)
})
