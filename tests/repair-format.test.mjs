import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import assert from 'node:assert/strict'
import { setImmediate as immediate } from 'node:timers/promises'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Storage from '@deepseek-ai/dsh-storage'
import * as StorageJson from '@deepseek-ai/dsh-storage-json'
import * as StorageDomain from '@deepseek-ai/dsh-storage-domain'
import { Context } from '@deepseek-ai/cordis'
import { LlmAdapter, createUserMessage, createMessage, resolveRetryPolicy } from '@deepseek-ai/dsh-llm'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import TokenMeter from '@deepseek-ai/dsh-token-meter'
import * as Retry from '@deepseek-ai/dsh-llm-retry'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import Manager from '../lib/index.js'
import { ContextEngine as Engine } from '../lib/engine.js'
import { defaults } from '../lib/policy.js'
import { installTestCompactionHost } from './fixtures/test-compaction-host.mjs'

// A type-broken primary: all seven keys present, only `constraints` has the
// wrong JSON type. The local wrap must preserve every value byte-for-byte.
const typeBroken = JSON.stringify({ goal: 'Preserve the pending task', constraints: 'Keep authorization boundaries', completed: ['Preparation complete'], pending: ['Continue current task'], evidence: [], next: 'Continue after completed preparation', uncertainties: [] })
const missingField = JSON.stringify({ goal: 'no next field', constraints: [], completed: [], pending: [], evidence: [], uncertainties: [] })
const primaryProse = 'ordinary prose summary'
const primaryTruncated = '{"goal":'
const primaryOversize = JSON.stringify({ goal: 'g', constraints: 'not-an-array', completed: [], pending: [], evidence: ['e'.repeat(70000)], next: 'n', uncertainties: [] })

class Adapter extends LlmAdapter {
  constructor(options = {}) { super(); this.options = options; this.order = []; this.summaries = []; this.requests = []; this.repairs = []; this.work = 0 }
  async resolveModel(provider, model) { return { provider, id: model, name: model, context: { contextWindow: 10000 } } }
  providerRetryPolicy() { return resolveRetryPolicy({ mode: 'normal', maxRetries: 0 }, 'test') }
  async *stream(options) {
    if (options.purpose !== 'compaction') {
      this.order.push('main'); this.requests.push(options)
      yield { type: 'block-start', index: 0, blockType: 'text' }
      yield { type: 'block-end', index: 0, block: { type: 'text', text: 'done' } }
      yield { type: 'finish', reason: { kind: 'stop' } }
      return
    }
    // A repair request would carry exactly one user message and never history.
    // The local deterministic repair must make this path unreachable.
    if (options.messages.length === 1) { this.repairs.push(options); this.order.push('repair-start'); yield { type: 'finish', reason: { kind: 'error', failure: { code: 'SERVER', message: 'repair must not be requested' } } }; return }
    this.summaries.push(options); this.order.push('summary-start')
    if (this.options.primaryHold) await this.options.primaryHold(options.signal)
    if (this.options.fail) { yield { type: 'finish', reason: { kind: 'error', failure: { code: 'SERVER', message: 'summary unavailable' } } }; return }
    yield { type: 'usage', usage: { inputTokens: 500, cacheReadTokens: 100, outputTokens: 20 } }
    if (this.options.primaryHoldAfterUsage) await this.options.primaryHoldAfterUsage(options.signal)
    const text = this.options.missingField ? missingField : this.options.prose ? primaryProse : this.options.truncated ? primaryTruncated : this.options.oversize ? primaryOversize : typeBroken
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'block-end', index: 0, block: { type: 'text', text } }
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
  const storageRoot = await mkdtemp(join(tmpdir(), 'dsh-context-repair-'))
  ctx.provide('profileContext', {dir:storageRoot,installAnchor:fileURLToPath(new URL('../package.json',import.meta.url)),patchPath:fileURLToPath(new URL('../cordis.patch.yml',import.meta.url))})
  ctx.effect(() => () => rm(storageRoot, { recursive: true, force: true }))
  await ctx.plugin(Storage)
  await ctx.plugin(StorageJson, { root: storageRoot })
  await ctx.plugin(StorageDomain, { backend: 'json' })
  await mountAgentLoopTestDependencies(ctx)
  await ctx.plugin(AgentLoop, { agents: [] })
  await ctx.plugin(TokenMeter)
  await ctx.plugin(Retry)
  installTestCompactionHost(ctx)
  await ctx.plugin(Manager, { policy: { ...defaults, capacityMode: 'legacy', summaryMaxTokens: 512, ...policy } })
  await ctx.plugin(Engine)
  const adapter = new Adapter(options)
  ctx.llm.registerAdapter(['mock'], adapter)
  const { agent } = await ctx.agentLoop.createAgent(ctx, { sessionId: SessionId('subject'), seed, agentOptions: { provider: 'mock', model: 'large' } })
  return { ctx, adapter, agent }
}
const message = () => createUserMessage({ content: [{ type: 'text', text: '请完成当前任务；不要改动无关文件。' }], source: { kind: 'user' } })
const commits = agent => agent.session.snapshotEvents().filter(event => event.type === 'compaction/summary').length
const stats = ctx => ctx.contextManager.summaryLedger.stats('subject')
const terminal = (ctx, purpose = 'summary') => ctx.contextManager.summaryOperations.records('subject').find(row => row.purpose === purpose)
async function drainUntil(predicate) {
  const until = performance.now() + 5000
  while (performance.now() < until) { if (predicate()) return; await immediate() }
  assert.ok(predicate(), 'asynchronous operation did not settle')
}

test('repair: a type-broken primary commits with one local wrap and zero repair calls', { timeout: 8000 }, async () => {
  const { ctx, adapter, agent } = await fixture()
  try {
    const task = message(); agent.followup(task); await agent.whenIdle()
    assert.deepEqual(adapter.order, ['summary-start', 'main'])
    assert.equal(adapter.repairs.length, 0, 'deterministic repair must never request a model')
    assert.equal(adapter.summaries.length, 1)
    assert.equal(adapter.requests.length, 1); assert.equal(adapter.work, 0)
    assert.equal(commits(agent), 1)
    assert.ok(agent.session.deriveMessages().some(m => m.id === task.id))
    const checkpoint = agent.session.snapshotEvents().find(event => event.type === 'compaction/summary')
    const text = checkpoint.data.summary.map(block => block.text).join('')
    assert.match(text, /Keep authorization boundaries/)
    assert.ok(!text.includes('constraints'), 'the checkpoint surface is Markdown, not raw JSON')
    const ledger = stats(ctx)
    assert.equal(ledger.attempts, 1); assert.equal(ledger.unknownAttempts, 0)
    assert.deepEqual(ledger.recent.map(item => item.status), ['generated'])
    assert.equal(ledger.input, 600); assert.equal(ledger.output, 20)
    const row = terminal(ctx)
    assert.equal(row.phase, 'committed')
    assert.equal(row.reasonCode, 'deterministic_repair')
    const view = ctx.sessionProjections.snapshot(agent.session).values.contextManagerDiagnostics
    assert.equal(view.compactions[0].status, 'completed')
    assert.equal(view.compactions[0].inputTokens, 600); assert.equal(view.compactions[0].outputTokens, 20)
  } finally { await ctx.fiber.dispose() }
})

test('repair: disabled by policy rejects a repairable structure without any second call', { timeout: 8000 }, async () => {
  const { ctx, adapter, agent } = await fixture({}, { formatRepairEnabled: false })
  try {
    const task = message(); agent.followup(task); await agent.whenIdle()
    assert.deepEqual(adapter.order, ['summary-start'])
    assert.equal(adapter.summaries.length, 1); assert.equal(adapter.repairs.length, 0)
    assert.equal(adapter.requests.length, 0); assert.equal(commits(agent), 0)
    assert.ok(agent.session.deriveMessages().some(m => m.id === task.id))
    const ledger = stats(ctx)
    assert.equal(ledger.attempts, 1); assert.equal(ledger.unknownAttempts, 0)
    const view = ctx.sessionProjections.snapshot(agent.session).values.contextManagerDiagnostics
    assert.match(view.compactions[0].error ?? '', /本地结构修复已关闭|格式修复已关闭/)
  } finally { await ctx.fiber.dispose() }
})

for (const [name, option, errorMatch] of [
  ['truncated JSON', { truncated: true }, /损坏或截断/],
  ['missing fields', { missingField: true }, /缺少字段/],
  ['prose', { prose: true }, /损坏或截断/],
]) test(`repair: ${name} fails closed as known-unapplied with no replay`, { timeout: 8000 }, async () => {
  const { ctx, adapter, agent } = await fixture(option)
  try {
    const task = message(); agent.followup(task); await agent.whenIdle()
    assert.deepEqual(adapter.order, ['summary-start'], 'damaged input must never be replayed')
    assert.equal(adapter.summaries.length, 1); assert.equal(adapter.repairs.length, 0)
    assert.equal(adapter.requests.length, 0); assert.equal(commits(agent), 0)
    assert.ok(agent.session.deriveMessages().some(m => m.id === task.id))
    const ledger = stats(ctx)
    assert.equal(ledger.attempts, 1); assert.equal(ledger.unknownAttempts, 0)
    const row = terminal(ctx)
    assert.equal(row.phase, 'known_failed_unapplied', 'a physically complete unapplied call is not unknown')
    assert.equal(row.reasonCode, 'invalid_structure')
    const view = ctx.sessionProjections.snapshot(agent.session).values.contextManagerDiagnostics
    assert.match(view.compactions[0].error ?? '', errorMatch)
  } finally { await ctx.fiber.dispose() }
})

test('repair: over-limit evidence is rejected whole without truncation, local repair or replay', { timeout: 8000 }, async () => {
  const { ctx, adapter, agent } = await fixture({ oversize: true })
  try {
    const task = message(); agent.followup(task); await agent.whenIdle()
    assert.deepEqual(adapter.order, ['summary-start'])
    assert.equal(adapter.summaries.length, 1); assert.equal(adapter.repairs.length, 0)
    assert.equal(adapter.requests.length, 0); assert.equal(commits(agent), 0)
    assert.ok(agent.session.deriveMessages().some(m => m.id === task.id))
    const view = ctx.sessionProjections.snapshot(agent.session).values.contextManagerDiagnostics
    assert.match(view.compactions[0].error ?? '', /字段条目类型或长度无效/)
  } finally { await ctx.fiber.dispose() }
})

test('repair: an error finish keeps the provider failure, records usage and is not replayed', { timeout: 8000 }, async () => {
  const { ctx, adapter, agent } = await fixture({ fail: true })
  try {
    const task = message(); agent.followup(task); await agent.whenIdle()
    assert.deepEqual(adapter.order, ['summary-start'])
    assert.equal(adapter.summaries.length, 1); assert.equal(adapter.repairs.length, 0)
    assert.equal(adapter.requests.length, 0); assert.equal(commits(agent), 0)
    assert.ok(agent.session.deriveMessages().some(m => m.id === task.id))
    const ledger = stats(ctx)
    assert.equal(ledger.attempts, 1); assert.equal(ledger.unknownAttempts, 1)
    assert.equal(ledger.input, 0); assert.equal(ledger.output, 0)
    const view = ctx.sessionProjections.snapshot(agent.session).values.contextManagerDiagnostics
    assert.equal(view.compactions[0].error, 'summary unavailable')
  } finally { await ctx.fiber.dispose() }
})

test('repair: cancellation during the summary stream never commits and late usage is recorded once', { timeout: 8000 }, async () => {
  let release; let started; const entered = new Promise(resolve => { started = resolve })
  const held = new Promise(resolve => { release = resolve })
  const { ctx, adapter, agent } = await fixture({ primaryHoldAfterUsage: async () => { started(); await held } })
  try {
    const task = message(); agent.followup(task); await entered
    agent.cancel({ kind: 'user' }); await agent.whenIdle()
    assert.equal(commits(agent), 0); assert.equal(adapter.requests.length, 0)
    release()
    await drainUntil(() => { const ledger = stats(ctx); return ledger.recent[0]?.status === 'cancelled' && ledger.recent[0].input !== null })
    await immediate()
    assert.equal(commits(agent), 0); assert.equal(adapter.requests.length, 0)
    assert.ok(agent.session.deriveMessages().some(m => m.id === task.id))
    const ledger = stats(ctx)
    assert.equal(ledger.attempts, 1); assert.equal(ledger.unknownAttempts, 0)
    assert.equal(ledger.recent[0].status, 'cancelled')
    assert.equal(ledger.recent[0].input, 600); assert.equal(ledger.recent[0].output, 20)
    await ctx.contextManager.summaryLedger.recordUsage('subject', ledger.recent[0].id, { inputTokens: 9999, outputTokens: 9999 })
    assert.equal(stats(ctx).recent[0].input, 10099, 'a newer provider total replaces the prior input snapshot and retains known cache usage')
    assert.equal(stats(ctx).recent[0].output, 9999)
    assert.equal(stats(ctx).attempts, 1, 'late snapshots update the original attempt rather than creating a duplicate charge')
  } finally { await ctx.fiber.dispose() }
})

test('repair: idle path applies the deterministic wrap once inside maintenance', { timeout: 8000 }, async t => {
  const { ctx, adapter, agent } = await fixture({}, {}, history(28000))
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: Date.now() })
  try {
    agent.followup(message()); await agent.whenIdle()
    await drainUntil(() => ctx.contextManager.idleStatus(agent.id).status === 'scheduled')
    t.mock.timers.tick(900000)
    await drainUntil(() => ctx.contextManager.idleStatus(agent.id).status === 'completed')
    assert.deepEqual(adapter.order, ['main', 'summary-start'])
    assert.equal(adapter.repairs.length, 0)
    assert.equal(commits(agent), 1)
    const ledger = stats(ctx)
    assert.equal(ledger.attempts, 1); assert.deepEqual(ledger.recent.map(item => item.status), ['generated'])
    assert.ok(ctx.contextManager.idleStatus(agent.id).afterTokens < ctx.contextManager.idleStatus(agent.id).beforeTokens)
  } finally { t.mock.timers.reset(); await ctx.fiber.dispose() }
})

test('percent: deterministic repair commits without consuming repair output budget', { timeout: 8000 }, async () => {
  const { ctx, adapter, agent } = await fixture({}, { capacityMode: 'percent', recentPercent: 10, summaryPercent: 5, repairPercent: 1, maxPasses: 1 })
  try {
    const task = message(); agent.followup(task); await agent.whenIdle()
    assert.deepEqual(adapter.order, ['summary-start', 'main'])
    assert.equal(adapter.summaries.length, 1); assert.equal(adapter.repairs.length, 0)
    assert.equal(adapter.requests.length, 1); assert.equal(commits(agent), 1)
    const ledger = stats(ctx)
    assert.equal(ledger.attempts, 1); assert.equal(ledger.input, 600); assert.equal(ledger.output, 20)
    assert.equal(ctx.contextManager.summaryOperations.records('subject').filter(row => row.purpose === 'repair').length, 0)
  } finally { await ctx.fiber.dispose() }
})
