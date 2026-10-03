import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setImmediate as immediate } from 'node:timers/promises'
import { Context } from '@deepseek-ai/cordis'
import { createVolatile, updateVolatile } from '@deepseek-ai/cosmokit'
import { LlmAdapter, createMessage, createUserMessage, resolveRetryPolicy } from '@deepseek-ai/dsh-llm'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import Storage from '@deepseek-ai/dsh-storage'
import * as StorageJson from '@deepseek-ai/dsh-storage-json'
import * as StorageDomain from '@deepseek-ai/dsh-storage-domain'
import JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import TokenMeter from '@deepseek-ai/dsh-token-meter'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import * as Retry from '@deepseek-ai/dsh-llm-retry'
import Manager from '../lib/index.js'
import Engine from '../lib/engine.js'
import { defaults } from '../lib/policy.js'

const sessionId = SessionId('durable-idle-subject')
const delay = defaults.idleMinutes * 60000
const options = { provider: 'mock', model: 'large' }

class Adapter extends LlmAdapter {
  mainCalls = 0
  summaryCalls = 0

  async resolveModel(provider, model) {
    return { provider, id: model, name: model, context: { contextWindow: 10000 } }
  }

  providerRetryPolicy() { return resolveRetryPolicy({ mode: 'normal', maxRetries: 0 }, 'recovery-test') }

  async *stream(request) {
    const summary = request.purpose === 'compaction'
    if (summary) this.summaryCalls++
    else this.mainCalls++
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'block-end', index: 0, block: { type: 'text', text: summary
      ? JSON.stringify({ goal: 'Complete the current task', constraints: ['Preserve the acceptance criteria'], completed: ['Prior preparation is complete'], pending: [], evidence: [], next: 'Continue from the current user request', uncertainties: [] })
      : 'done' } }
    // Leave ordinary request pressure estimated from the actual seeded surface.
    if (summary) yield { type: 'usage', usage: { inputTokens: 500, outputTokens: 20 } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

function history() {
  const session = Session.create(SessionId('seed'))
  session.append('turn/start', { turn: 1 })
  session.append('step/start', { turn: 1, step: 1 })
  // Persisted V4 sessions require the system surface head, just like real turns.
  session.append('system/message', { turn: 1, step: 1, message: createMessage({ role: 'system', content: [], source: { kind: 'system-prompt' } }) }, { surfaceOp: 'append' })
  session.append('user/message', createUserMessage({ content: [{ type: 'text', text: 'h'.repeat(28000) }], source: { kind: 'user' } }), { surfaceOp: 'append' })
  session.append('assistant/message', { stream: [], turn: 1, step: 1, message: createMessage({ role: 'assistant', content: [{ type: 'text', text: 'previous preparation done' }], source: { kind: 'model', ...options } }) }, { surfaceOp: 'append' })
  session.append('step/end', { turn: 1, step: 1 })
  session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
  return session.snapshotEvents()
}

const message = () => createUserMessage({ content: [{ type: 'text', text: 'Complete the current task and preserve the acceptance criteria.' }], source: { kind: 'user' } })
const state = (ctx, agent) => ctx.contextManager.idleStatus(agent.id)
const eligibility = record => ({ sessionId: record.sessionId, turnEndSeq: record.turnEndSeq, completedAt: record.completedAt, fingerprint: record.fingerprint })

function changePolicy(ctx, patch) {
  updateVolatile(ctx.contextManager.config.policy, createVolatile({ ...ctx.contextManager.snapshot(), ...patch }))
  ctx.emit('settings/document-updated', 'context-manager', 2)
}

async function drainUntil(predicate, description) {
  // Real fs workers must keep advancing while Date/setTimeout are mocked.
  const deadline = performance.now() + 8000
  while (!predicate() && performance.now() < deadline) await immediate()
  assert.ok(predicate(), typeof description === 'function' ? description() : description)
}

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'dsh-context-idle-recovery-'))
  const contexts = new Set()
  t.after(async () => {
    for (const ctx of contexts) await ctx.fiber.dispose()
    await rm(root, { recursive: true, force: true })
  })
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: Date.now() })

  async function boot({ manager = true, engine = manager } = {}) {
    const ctx = new Context()
    contexts.add(ctx)
    await ctx.plugin(Storage)
    await ctx.plugin(StorageJson, { root: join(root, 'storage') })
    await ctx.plugin(StorageDomain, { backend: 'json' })
    await mountAgentLoopTestDependencies(ctx)
    // Dispose AgentLoop before its persistence backend, so every writer drains.
    await ctx.plugin(JsonlSessionPersistence, { root: join(root, 'sessions'), compression: 'none' })
    await ctx.plugin(AgentLoop, { agents: [] })
    await ctx.plugin(TokenMeter)
    await ctx.plugin(Retry)
    if (manager) await ctx.plugin(Manager, { policy: { ...defaults, summaryMaxTokens: 512 } })
    if (engine) await ctx.plugin(Engine)
    const adapter = new Adapter()
    ctx.llm.registerAdapter(['mock'], adapter)
    return { ctx, adapter }
  }

  async function stop(ctx) {
    await ctx.fiber.dispose()
    contexts.delete(ctx)
  }

  return { boot, stop }
}

async function completeNewTurn(ctx) {
  const { agent } = await ctx.agents.create({ sessionId, seed: history(), agentOptions: options })
  agent.followup(message())
  await agent.whenIdle()
  const end = agent.session.snapshotEvents().findLast(event => event.type === 'turn/end')
  assert.equal(end.data.reason.kind, 'completed')
  assert.equal(await ctx.sessions.flush(agent.session), true, 'the real JSONL backend must acknowledge durability')
  return { agent, end }
}

test('idle recovery: a durable completed turn keeps its deadline across full restart and runs only once', { timeout: 30000 }, async t => {
  const { boot, stop } = await fixture(t)
  const first = await boot()
  const { agent: original, end } = await completeNewTurn(first.ctx)
  await drainUntil(() => state(first.ctx, original).status === 'scheduled', 'normal completion must persist eligibility before scheduling')
  const reserved = first.ctx.contextManager.idleStore.get(sessionId)
  assert.equal(reserved.status, 'eligible')
  assert.equal(reserved.turnEndSeq, end.seq)
  assert.equal(reserved.completedAt, end.time)
  assert.ok(reserved.fingerprint)
  const dueAt = state(first.ctx, original).dueAt
  assert.equal(dueAt, reserved.completedAt + delay)
  assert.equal(first.adapter.mainCalls, 1)
  assert.equal(first.adapter.summaryCalls, 0)
  t.mock.timers.tick(300000)
  await stop(first.ctx)

  const second = await boot()
  assert.equal(second.ctx.agents.get(sessionId), undefined, 'opening the idle store must not activate stored sessions')
  assert.deepEqual(eligibility(second.ctx.contextManager.idleStore.get(sessionId)), eligibility(reserved))
  const { agent: resumed } = await second.ctx.agents.resume({ resumeSessionId: sessionId, agentOptions: options })
  assert.notEqual(resumed.session, original.session, 'restart must use a newly read persisted session')
  await drainUntil(() => state(second.ctx, resumed).status === 'scheduled', () => `the registered completion must recover on public resume: ${JSON.stringify(state(second.ctx, resumed))}`)
  assert.equal(state(second.ctx, resumed).dueAt, dueAt, 'resume must not restart the idle countdown')
  t.mock.timers.tick(dueAt - Date.now() - 1)
  await immediate()
  assert.equal(second.adapter.summaryCalls, 0)
  t.mock.timers.tick(1)
  await drainUntil(() => second.ctx.contextManager.idleStore.get(sessionId)?.status === 'completed', 'the recovered pass must settle durably')
  await resumed.whenIdle()
  assert.equal(second.adapter.mainCalls, 0, 'idle recovery is maintenance, not a new user turn')
  assert.equal(second.adapter.summaryCalls, 1)
  assert.equal(resumed.session.snapshotEvents().filter(event => event.type === 'compaction/summary').length, 1)
  const settled = second.ctx.contextManager.idleStore.get(sessionId)
  assert.deepEqual(eligibility(settled), eligibility(reserved))
  assert.ok(settled.attemptId)
  assert.ok(settled.afterTokens < settled.beforeTokens)
  assert.equal(await second.ctx.sessions.flush(resumed.session), true)
  await stop(second.ctx)

  const third = await boot()
  const { agent: resumedAgain } = await third.ctx.agents.resume({ resumeSessionId: sessionId, agentOptions: options })
  t.mock.timers.tick(86400000)
  await immediate()
  assert.equal(third.adapter.mainCalls, 0)
  assert.equal(third.adapter.summaryCalls, 0, 'a settled qualification must never be replayed after another restart')
  assert.equal(third.ctx.contextManager.idleStore.get(sessionId).status, 'completed')
  assert.equal(resumedAgain.session.snapshotEvents().filter(event => event.type === 'compaction/summary').length, 1)
})

test('idle recovery: old persisted history without registered eligibility stays dormant', { timeout: 20000 }, async t => {
  const { boot, stop } = await fixture(t)
  const legacy = await boot({ manager: false })
  await completeNewTurn(legacy.ctx)
  await stop(legacy.ctx)
  t.mock.timers.tick(delay + 1)

  const current = await boot()
  const { agent } = await current.ctx.agents.resume({ resumeSessionId: sessionId, agentOptions: options })
  assert.equal(current.ctx.contextManager.idleStore.get(sessionId), undefined)
  assert.equal(state(current.ctx, agent).status, 'waiting')
  assert.equal(state(current.ctx, agent).reasonCode, 'no_plan')
  t.mock.timers.tick(86400000)
  await immediate()
  assert.equal(current.adapter.mainCalls, 0)
  assert.equal(current.adapter.summaryCalls, 0)
  assert.equal(current.ctx.contextManager.idleStore.get(sessionId), undefined, 'reading old completion events must not grant new eligibility')
})

test('idle recovery: a durable started marker becomes interrupted and never resends after restart', { timeout: 30000 }, async t => {
  const { boot, stop } = await fixture(t)
  const first = await boot()
  const { agent } = await completeNewTurn(first.ctx)
  await drainUntil(() => state(first.ctx, agent).status === 'scheduled', 'normal completion must register eligibility')
  const reserved = first.ctx.contextManager.idleStore.get(sessionId)
  await stop(first.ctx)

  // Reproduce the exact durable crash boundary after claim and before any
  // model/settlement: no Agent or idle timer is live to turn it into cancellation.
  const abandoned = await boot({ engine: false })
  assert.equal(abandoned.ctx.agents.get(sessionId), undefined)
  const started = await abandoned.ctx.contextManager.idleStore.claim(eligibility(reserved), 'abandoned-attempt', 7000)
  assert.equal(started.status, 'started')
  await stop(abandoned.ctx)
  t.mock.timers.tick(delay + 1)

  const recovered = await boot()
  assert.equal(recovered.ctx.contextManager.idleStore.get(sessionId).status, 'started')
  const { agent: resumed } = await recovered.ctx.agents.resume({ resumeSessionId: sessionId, agentOptions: options })
  await drainUntil(() => recovered.ctx.contextManager.idleStore.get(sessionId)?.status === 'interrupted', 'ambiguous started work must stop instead of retrying')
  t.mock.timers.tick(86400000)
  await immediate()
  const stopped = recovered.ctx.contextManager.idleStore.get(sessionId)
  assert.equal(stopped.attemptId, 'abandoned-attempt')
  assert.deepEqual(eligibility(stopped), eligibility(reserved))
  assert.equal(recovered.adapter.mainCalls, 0)
  assert.equal(recovered.adapter.summaryCalls, 0)
  assert.equal(resumed.session.snapshotEvents().filter(event => event.type === 'compaction/start').length, 0)
  await stop(recovered.ctx)

  const again = await boot()
  await again.ctx.agents.resume({ resumeSessionId: sessionId, agentOptions: options })
  t.mock.timers.tick(86400000)
  await immediate()
  assert.equal(again.ctx.contextManager.idleStore.get(sessionId).status, 'interrupted')
  assert.equal(again.adapter.summaryCalls, 0, 'interrupted work stays consumed across later restarts')
})

test('idle race: manual compaction during awaited activity invalidates the idle plan without a second summary', { timeout: 20000 }, async t => {
  const { boot } = await fixture(t)
  const { ctx, adapter } = await boot()
  const { agent } = await completeNewTurn(ctx)
  await drainUntil(() => state(ctx, agent).status === 'scheduled', 'completion must schedule idle work')
  const gate = Promise.withResolvers()
  let entered = false
  const removeActivity = ctx.on('workspace/session-activity', async () => {
    entered = true
    await gate.promise
    return []
  })
  try {
    t.mock.timers.tick(delay)
    await drainUntil(() => entered, 'idle work must reach the asynchronous activity check')
    assert.equal(state(ctx, agent).status, 'checking')
    const generation = agent.session.surface.replaceGeneration
    assert.ok(await ctx.compaction.compactNow(agent, new AbortController().signal), 'the manual operation must actually commit')
    assert.ok(agent.session.surface.replaceGeneration > generation)
    assert.equal(adapter.summaryCalls, 1)
    gate.resolve()
    await drainUntil(() => ctx.contextManager.idleStore.get(sessionId)?.status === 'cancelled', 'manual compaction must durably consume the idle plan')
    t.mock.timers.tick(86400000)
    await immediate()
    assert.equal(adapter.mainCalls, 1)
    assert.equal(adapter.summaryCalls, 1, 'releasing stale activity must not launch another summary')
    assert.equal(agent.session.snapshotEvents().filter(event => event.type === 'compaction/summary').length, 1)
  } finally {
    gate.resolve()
    removeActivity()
  }
})

for (const interruption of ['new input', 'disable']) test(`idle race: ${interruption} while durable claim is returning cannot execute or revive the old attempt`, { timeout: 30000 }, async t => {
  const { boot } = await fixture(t)
  const { ctx, adapter } = await boot()
  const { agent } = await completeNewTurn(ctx)
  await drainUntil(() => state(ctx, agent).status === 'scheduled', 'completion must schedule idle work')
  const store = ctx.contextManager.idleStore
  const original = store.get(sessionId)
  const claim = store.claim.bind(store)
  const gate = Promise.withResolvers()
  let persisted
  let returned = false
  store.claim = async (...args) => {
    const result = await claim(...args)
    if (!persisted && result) {
      persisted = result
      // The write really happened in StorageJson. Hold only the completion
      // delivered to the controller, reproducing the durable-await boundary.
      await gate.promise
      returned = true
    }
    return result
  }
  try {
    t.mock.timers.tick(delay)
    await drainUntil(() => !!persisted, 'the real claim write must finish before interruption')
    assert.equal(store.get(sessionId).status, 'started')
    assert.equal(adapter.summaryCalls, 0)
    let next
    if (interruption === 'new input') {
      agent.followup(message())
      await agent.whenIdle()
      await drainUntil(() => store.get(sessionId)?.fingerprint !== original.fingerprint && store.get(sessionId)?.status === 'eligible', 'the new completed turn must own a fresh durable qualification')
      next = store.get(sessionId)
      assert.equal(next.attemptId, undefined)
      assert.equal(adapter.mainCalls, 2)
    } else {
      changePolicy(ctx, { idleEnabled: false })
      await drainUntil(() => store.get(sessionId)?.status === 'cancelled', 'disabling must cancel the durable started marker')
      assert.equal(state(ctx, agent).status, 'off')
    }
    gate.resolve()
    await drainUntil(() => returned, 'the stale claim must return to the controller')
    if (next) {
      await drainUntil(() => state(ctx, agent).status === 'scheduled', 'stale cleanup must leave the fresh qualification scheduled')
      assert.deepEqual(eligibility(store.get(sessionId)), eligibility(next))
      assert.equal(store.get(sessionId).status, 'eligible')
      assert.equal(adapter.summaryCalls, 0, 'the cancelled old qualification must never call the provider')
      t.mock.timers.tick(delay)
      await drainUntil(() => store.get(sessionId)?.status === 'completed', 'only the new qualification may execute at its own deadline')
      assert.deepEqual(eligibility(store.get(sessionId)), eligibility(next))
      assert.equal(adapter.summaryCalls, 1)
    } else {
      changePolicy(ctx, { idleEnabled: true })
      t.mock.timers.tick(86400000)
      await immediate()
      assert.equal(store.get(sessionId).status, 'cancelled')
      assert.equal(adapter.summaryCalls, 0, 're-enabling must not revive a cancelled claim')
    }
  } finally {
    gate.resolve()
    store.claim = claim
  }
})

test('idle race: a real context replacement while model resolution awaits rejects the stale plan', { timeout: 20000 }, async t => {
  const { boot } = await fixture(t)
  const { ctx, adapter } = await boot()
  const { agent } = await completeNewTurn(ctx)
  await drainUntil(() => state(ctx, agent).status === 'scheduled', 'completion must schedule idle work')
  const resolveModel = adapter.resolveModel.bind(adapter)
  const gate = Promise.withResolvers()
  let entered = false
  let returned = false
  adapter.resolveModel = async (...args) => {
    const info = await resolveModel(...args)
    if (!entered) {
      entered = true
      // Simulate an asynchronous metadata provider that settles after the
      // session changed; subsequent manual resolution remains available.
      await gate.promise
      returned = true
    }
    return info
  }
  try {
    t.mock.timers.tick(delay)
    await drainUntil(() => entered, 'idle work must reach asynchronous model resolution')
    const generation = agent.session.surface.replaceGeneration
    assert.ok(await ctx.compaction.compactNow(agent, new AbortController().signal))
    assert.ok(agent.session.surface.replaceGeneration > generation)
    assert.equal(adapter.summaryCalls, 1)
    gate.resolve()
    await drainUntil(() => returned && ctx.contextManager.idleStore.get(sessionId)?.status === 'cancelled', 'the stale resolver must settle without reviving its plan')
    t.mock.timers.tick(86400000)
    await immediate()
    assert.equal(adapter.summaryCalls, 1, 'the old measured surface must never trigger a second provider call')
    assert.equal(agent.session.snapshotEvents().filter(event => event.type === 'compaction/summary').length, 1)
  } finally {
    gate.resolve()
    adapter.resolveModel = resolveModel
  }
})
