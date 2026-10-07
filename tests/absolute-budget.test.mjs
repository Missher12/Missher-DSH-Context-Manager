import { test } from 'node:test'
import assert from 'node:assert/strict'
import { setImmediate as immediate } from 'node:timers/promises'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Storage from '@deepseek-ai/dsh-storage'
import * as StorageJson from '@deepseek-ai/dsh-storage-json'
import * as StorageDomain from '@deepseek-ai/dsh-storage-domain'
import { Context } from '@deepseek-ai/cordis'
import { LlmAdapter, createUserMessage, createMessage, ToolCallId, resolveRetryPolicy } from '@deepseek-ai/dsh-llm'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import TokenMeter from '@deepseek-ai/dsh-token-meter'
import * as Retry from '@deepseek-ai/dsh-llm-retry'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import { defineContentToolFixture } from '@deepseek-ai/dsh-tools'
import Manager from '../lib/index.js'
import Engine from '../lib/engine.js'
import { defaults, budget, validatePolicy, idleFloorTokens } from '../lib/policy.js'

const ABSOLUTE = { absoluteEnabled: true, absoluteTriggerTokens: 200000, absoluteTargetTokens: 100000 }

class Adapter extends LlmAdapter {
  constructor(options = {}) { super(); this.options = options; this.order = []; this.summaries = []; this.requests = []; this.work = 0 }
  async resolveModel(provider, model) { return { provider, id: model, name: model, context: { contextWindow: model === 'million' ? 1000000 : 10000 }, ...(model === 'million' ? { defaultMaxTokens: 256000 } : {}) } }
  providerRetryPolicy() { return resolveRetryPolicy({ mode: 'normal', maxRetries: 0 }, 'test') }
  async *stream(options) {
    if (options.purpose === 'compaction') {
      this.order.push('summary'); this.summaries.push(options)
      yield { type: 'block-start', index: 0, blockType: 'text' }
      yield { type: 'block-end', index: 0, block: { type: 'text', text: JSON.stringify({ goal: 'Continue the current task', constraints: [], completed: [], pending: ['Execute the current task'], evidence: [], next: 'Continue', uncertainties: [] }) } }
      yield { type: 'usage', usage: { inputTokens: 500, cacheReadTokens: 100, outputTokens: 20 } }
      yield { type: 'finish', reason: { kind: 'stop' } }
      return
    }
    this.order.push('main'); this.requests.push(options)
    if (this.options.tool && this.requests.length === 1) {
      yield { type: 'block-start', index: 0, blockType: 'tool-call' }
      yield { type: 'block-end', index: 0, block: { type: 'tool-call', id: ToolCallId('work-call'), name: 'work', arguments: '{}' } }
      yield { type: 'finish', reason: { kind: 'tool-calls' } }
      return
    }
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'block-end', index: 0, block: { type: 'text', text: this.options.bigResponse ? 'done' + 'r'.repeat(8000) : 'done' } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

function history(length = 31600) {
  const session = Session.create(SessionId('seed'))
  session.append('turn/start', { turn: 1 })
  session.append('step/start', { turn: 1, step: 1 })
  session.append('system/message', { turn: 1, step: 1, message: createMessage({ role: 'system', content: [], source: { kind: 'system-prompt' } }) }, { surfaceOp: 'append' })
  session.append('user/message', createUserMessage({ content: [{ type: 'text', text: 'h'.repeat(length) }], source: { kind: 'user' } }), { surfaceOp: 'append' })
  session.append('assistant/message', { stream: [], turn: 1, step: 1, message: createMessage({ role: 'assistant', content: [{ type: 'text', text: 'previous work done' }], source: { kind: 'model', provider: 'mock', model: 'large' } }) }, { surfaceOp: 'append' })
  session.append('step/end', { turn: 1, step: 1 })
  session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
  return session.snapshotEvents()
}

async function fixture(options = {}, policy = {}, seed = history()) {
  const ctx = new Context()
  const storageRoot = await mkdtemp(join(tmpdir(), 'dsh-context-absolute-'))
  ctx.effect(() => () => rm(storageRoot, { recursive: true, force: true }))
  await ctx.plugin(Storage)
  await ctx.plugin(StorageJson, { root: storageRoot })
  await ctx.plugin(StorageDomain, { backend: 'json' })
  await mountAgentLoopTestDependencies(ctx)
  await ctx.plugin(AgentLoop, { agents: [] })
  await ctx.plugin(TokenMeter)
  await ctx.plugin(Retry)
  await ctx.plugin(Manager, { policy: { ...defaults, summaryMaxTokens: 512, idleEnabled: false, ...policy } })
  await ctx.plugin(Engine)
  const adapter = new Adapter(options)
  ctx.llm.registerAdapter(['mock'], adapter)
  ctx.tools.register(defineContentToolFixture({ name: 'work', description: 'Count work', parameters: {}, async execute() { adapter.work++; return [{ type: 'text', text: options.toolOutput ?? 'tool complete' }] } }))
  const { agent } = await ctx.agentLoop.createAgent(ctx, { sessionId: SessionId('subject'), seed, agentOptions: { provider: 'mock', model: 'million' } })
  return { ctx, adapter, agent }
}
const message = (text = '请完成当前任务；不要改动无关文件。') => createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } })
const commits = agent => agent.session.snapshotEvents().filter(event => event.type === 'compaction/summary').length
async function drainUntil(predicate) {
  const until = performance.now() + 5000
  while (performance.now() < until) { if (predicate()) return; await immediate() }
  assert.ok(predicate(), 'asynchronous maintenance did not settle')
}

// Calibrate the deterministic seed length so measured occupancy lands exactly on the target.
let overhead = null
async function seedAt(target) {
  if (overhead === null) {
    const probe = await fixture({}, { enabled: false }, history(4000))
    overhead = probe.ctx.tokenMeter.measure(probe.agent.session).totalTokens - 1000
    await probe.ctx.fiber.dispose()
  }
  return history((target - overhead) * 4)
}

test('absolute: effective budget takes the conservative bound and reports sources without falsifying the window', () => {
  const limits = budget({ ...defaults, ...ABSOLUTE }, 1000000, 256000)
  assert.equal(limits.window, 1000000)
  assert.equal(limits.hard, 724000)
  assert.equal(limits.admission, 200000)
  assert.equal(limits.admissionSource, 'absolute')
  assert.equal(limits.target, 100000)
  assert.equal(limits.targetSource, 'absolute')
  assert.equal(limits.absoluteTrigger, 200000)
  // Percentage path stays intact for old configurations; on this window the
  // hard envelope clamps the percentage trigger, so the label reports hard.
  const legacy = budget(defaults, 1000000, 256000)
  assert.equal(legacy.admission, 714000)
  assert.equal(legacy.admissionSource, 'hard')
  assert.equal(legacy.absoluteTrigger, null)
})

test('absolute: below the trigger runs the task directly, at or above it compacts before the first business call', { timeout: 8000 }, async () => {
  for (const [label, target, compact] of [['below', 199000, false], ['above', 201000, true]]) {
    const { ctx, adapter, agent } = await fixture({}, { ...ABSOLUTE }, await seedAt(target))
    try {
      const measured = ctx.tokenMeter.measure(agent.session).totalTokens
      assert.ok(Math.abs(measured - target) <= 2, `calibrated seed ${label} measured ${measured}`)
      agent.followup(message()); await agent.whenIdle()
      assert.equal(adapter.order.includes('summary'), compact, `${label}: ${adapter.order.join(',')}`)
      assert.equal(adapter.requests.length, 1)
      assert.equal(commits(agent), compact ? 1 : 0)
    } finally { await ctx.fiber.dispose() }
  }
})

test('absolute: incoming message pressure participates in the first gate and the task stays verbatim', { timeout: 8000 }, async () => {
  const { ctx, adapter, agent } = await fixture({}, { ...ABSOLUTE }, await seedAt(199500))
  try {
    assert.ok(ctx.tokenMeter.measure(agent.session).totalTokens < 200000)
    const task = message('请完成当前任务；不要改动无关文件。' + 'x'.repeat(4000))
    agent.followup(task); await agent.whenIdle()
    assert.deepEqual(adapter.order, ['summary', 'main'], 'new message pressure must be counted before the first execution')
    assert.equal(commits(agent), 1)
    assert.deepEqual(adapter.requests[0].messages.find(m => m.id === task.id)?.content, task.content)
  } finally { await ctx.fiber.dispose() }
})

test('absolute: a small window keeps its percentage budget and reports the window verbatim', () => {
  const limits = budget({ ...defaults, ...ABSOLUTE }, 10000, 0)
  assert.equal(limits.window, 10000)
  assert.equal(limits.admission, 7900)
  assert.equal(limits.admissionSource, 'percent', 'an unreachable absolute trigger does not bind')
})

test('absolute: invalid parameters fail with explainable errors and old configs keep the legacy behavior', () => {
  for (const patch of [{ absoluteTriggerTokens: 9000 }, { absoluteTriggerTokens: 1.5 }, { absoluteTargetTokens: 1.5 }, { absoluteTriggerTokens: Number.NaN }, { absoluteTargetTokens: -1 }]) {
    assert.throws(() => validatePolicy({ ...defaults, ...ABSOLUTE, ...patch }), undefined, JSON.stringify(patch))
  }
  assert.throws(() => validatePolicy({ ...defaults, ...ABSOLUTE, absoluteTargetTokens: 170000 }), /至少低 20%/)
  const { absoluteEnabled, absoluteTriggerTokens, absoluteTargetTokens, formatRepairEnabled, formatRepairMaxTokens, ...legacy } = defaults
  const restored = Manager.Config({ policy: legacy }).policy.get()
  assert.deepEqual(restored, defaults)
  assert.equal(restored.absoluteEnabled, false)
  assert.equal(budget(restored, 100000, 8000).admission, 79000)
})

test('absolute: a protected newest task above the soft target stops bounded and preserves the task', { timeout: 8000 }, async () => {
  // Old history ~100k plus a protected newest user message ~250k: the first
  // compaction shrinks the old span, the remainder still exceeds 200k, and
  // further passes stay bounded with zero business calls.
  const { ctx, adapter, agent } = await fixture({}, { ...ABSOLUTE, maxPasses: 2 }, await seedAt(100000))
  try {
    const task = message('Protected newest task that must not be summarized away.' + 'p'.repeat(250000 * 4))
    agent.followup(task); await agent.whenIdle()
    assert.equal(adapter.requests.length, 0)
    assert.ok(adapter.summaries.length >= 1 && adapter.summaries.length <= 2, `bounded passes: ${adapter.summaries.length}`)
    assert.ok(commits(agent) >= 1 && commits(agent) <= adapter.summaries.length)
    assert.deepEqual(agent.session.deriveMessages().find(m => m.id === task.id)?.content, task.content)
  } finally { await ctx.fiber.dispose() }
})

test('absolute: idle run compacts at the absolute trigger where the percentage floor would skip', { timeout: 8000 }, async t => {
  // The seed sits just below 200k, the final assistant reply pushes the
  // completed turn above it: the pre-request gate stays quiet while the idle
  // pass sees the absolute trigger, far below the 95% percentage floor.
  for (const absolute of [true, false]) {
    const { ctx, adapter, agent } = await fixture({ bigResponse: true }, { ...(absolute ? ABSOLUTE : {}), idleEnabled: true, idleMinutes: 1, idleMinPercent: 95, triggerPercent: 95, earlyPercent: 0, safetyPercent: 1 }, await seedAt(199900))
    t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: Date.now() })
    try {
      agent.followup(message()); await agent.whenIdle()
      assert.ok(ctx.tokenMeter.measure(agent.session).totalTokens >= 200000, 'completed turn must exceed the absolute trigger')
      await drainUntil(() => ctx.contextManager.idleStatus(agent.id).status === 'scheduled')
      t.mock.timers.tick(60001)
      await drainUntil(() => ['completed', 'skipped', 'failed'].includes(ctx.contextManager.idleStatus(agent.id).status))
      if (absolute) {
        assert.equal(ctx.contextManager.idleStatus(agent.id).status, 'completed')
        assert.equal(adapter.summaries.length, 1)
      } else {
        assert.equal(ctx.contextManager.idleStatus(agent.id).status, 'skipped')
        assert.equal(adapter.summaries.length, 0, 'percentage floor alone would skip this occupancy')
      }
    } finally { t.mock.timers.reset(); await ctx.fiber.dispose() }
  }
})

test('absolute: idle floor never exceeds the effective admission with output reserve and safety', () => {
  // Window 100k with a 60k output reserve: hard envelope is 38k and the
  // admission is 37k, so the idle floor cannot keep waiting for 65k/65000.
  const floor = idleFloorTokens(defaults, 100000, 60000)
  assert.equal(floor, 37000)
  // Without a binding absolute trigger the percentage floor still applies.
  assert.equal(idleFloorTokens(defaults, 100000, 8000), 65000)
  // An absolute trigger below the percentage floor binds the idle floor.
  assert.equal(idleFloorTokens({ ...defaults, ...ABSOLUTE }, 1000000, 256000), 200000)
})
