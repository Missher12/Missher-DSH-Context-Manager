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
import { LlmAdapter, createUserMessage, createMessage, resolveRetryPolicy } from '@deepseek-ai/dsh-llm'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import TokenMeter from '@deepseek-ai/dsh-token-meter'
import * as Retry from '@deepseek-ai/dsh-llm-retry'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import Manager from '../lib/index.js'
import Engine from '../lib/engine.js'
import { defaults } from '../lib/policy.js'

// A type-broken primary: all seven keys present, only `constraints` has the
// wrong JSON type. Every other field is valid and must survive a repair verbatim.
const typeBroken = JSON.stringify({ goal: 'Preserve the pending task', constraints: 'Keep authorization boundaries', completed: ['Preparation complete'], pending: ['Continue current task'], evidence: [], next: 'Continue after completed preparation', uncertainties: [] })
// The correct repair: only the broken type is fixed; every other value stays identical.
const repairedCheckpoint = JSON.stringify({ goal: 'Preserve the pending task', constraints: ['Keep authorization boundaries'], completed: ['Preparation complete'], pending: ['Continue current task'], evidence: [], next: 'Continue after completed preparation', uncertainties: [] })
// A repair that silently rewrites a valid field must be rejected.
const alteredCheckpoint = JSON.stringify({ goal: 'Altered goal', constraints: ['Keep authorization boundaries'], completed: ['Preparation complete'], pending: ['Continue current task'], evidence: [], next: 'Continue after completed preparation', uncertainties: [] })
const missingField = JSON.stringify({ goal: 'no next field', constraints: [], completed: [], pending: [], evidence: [], uncertainties: [] })
const primaryMissingField = JSON.stringify({ goal: 'Preserve the pending task', constraints: [], completed: [], pending: ['Continue current task'], evidence: [], next: 'Continue after completed preparation' })
const primaryProse = 'ordinary prose summary'
const primaryTruncated = '{"goal":'
const primaryOversize = JSON.stringify({ goal: 'g', constraints: 'not-an-array', completed: [], pending: [], evidence: ['e'.repeat(40000)], next: 'n', uncertainties: [] })

class Adapter extends LlmAdapter {
  constructor(options = {}) { super(); this.options = options; this.order = []; this.summaries = []; this.requests = []; this.work = 0 }
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
    // The repair request carries exactly one user message and never the history.
    const repair = options.messages.length === 1
    this.summaries.push(options); this.order.push(repair ? 'repair-start' : 'summary-start')
    if (repair) {
      if (this.options.repairHold) await this.options.repairHold(options.signal)
      if (this.options.repairFail) { yield { type: 'usage', usage: { inputTokens: 600, cacheReadTokens: 100, outputTokens: 30 } }; yield { type: 'finish', reason: { kind: 'error', failure: { code: 'SERVER', message: 'repair unavailable' } } }; return }
      const text = this.options.repairMissingField ? missingField : this.options.repairAltered ? alteredCheckpoint : this.options.repairText ?? repairedCheckpoint
      yield { type: 'usage', usage: { inputTokens: 600, cacheReadTokens: 100, outputTokens: 30 } }
      yield { type: 'block-start', index: 0, blockType: 'text' }
      yield { type: 'block-end', index: 0, block: { type: 'text', text } }
      yield { type: 'finish', reason: { kind: 'stop' } }
      return
    }
    const text = this.options.fail ? '' : this.options.missingField ? primaryMissingField : this.options.prose ? primaryProse : this.options.truncated ? primaryTruncated : this.options.oversize ? primaryOversize : this.options.typeBroken === false ? repairedCheckpoint : typeBroken
    yield { type: 'usage', usage: { inputTokens: 500, cacheReadTokens: 100, outputTokens: 20 } }
    if (this.options.fail) { yield { type: 'finish', reason: { kind: 'error', failure: { code: 'SERVER', message: 'summary unavailable' } } }; return }
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
  ctx.effect(() => () => rm(storageRoot, { recursive: true, force: true }))
  await ctx.plugin(Storage)
  await ctx.plugin(StorageJson, { root: storageRoot })
  await ctx.plugin(StorageDomain, { backend: 'json' })
  await mountAgentLoopTestDependencies(ctx)
  await ctx.plugin(AgentLoop, { agents: [] })
  await ctx.plugin(TokenMeter)
  await ctx.plugin(Retry)
  await ctx.plugin(Manager, { policy: { ...defaults, summaryMaxTokens: 512, ...policy } })
  await ctx.plugin(Engine)
  const adapter = new Adapter(options)
  ctx.llm.registerAdapter(['mock'], adapter)
  const { agent } = await ctx.agentLoop.createAgent(ctx, { sessionId: SessionId('subject'), seed, agentOptions: { provider: 'mock', model: 'large' } })
  return { ctx, adapter, agent }
}
const message = () => createUserMessage({ content: [{ type: 'text', text: '请完成当前任务；不要改动无关文件。' }], source: { kind: 'user' } })
const commits = agent => agent.session.snapshotEvents().filter(event => event.type === 'compaction/summary').length
const stats = ctx => ctx.contextManager.summaryLedger.stats('subject')
async function drainUntil(predicate) {
  const until = performance.now() + 5000
  while (performance.now() < until) { if (predicate()) return; await immediate() }
  assert.ok(predicate(), 'asynchronous repair did not settle')
}

test('repair: a type-broken primary is repaired once in the same transaction with bounded input and no history', { timeout: 8000 }, async () => {
  const { ctx, adapter, agent } = await fixture({ typeBroken: true, repairText: repairedCheckpoint })
  try {
    const task = message(); agent.followup(task); await agent.whenIdle()
    assert.deepEqual(adapter.order, ['summary-start', 'repair-start', 'main'])
    assert.equal(adapter.requests.length, 1); assert.equal(adapter.work, 0)
    assert.equal(commits(agent), 1)
    assert.ok(agent.session.deriveMessages().some(m => m.id === task.id))
    const repair = adapter.summaries[1]
    assert.equal(repair.messages.length, 1, 'repair must not resend the conversation history')
    assert.equal('toolHistory' in repair, false, 'repair must not carry tool history')
    assert.equal('tools' in repair, false, 'repair must not carry tool schemas')
    const repairText = JSON.stringify(repair.messages)
    assert.ok(!repairText.includes('h'.repeat(100)), 'repair input must not contain the original history')
    assert.ok(repairText.includes('Keep authorization boundaries'), 'repair input carries the complete failed output')
    assert.equal(repair.provider, 'mock'); assert.equal(repair.model, 'large')
    assert.ok((repair.maxTokens ?? 0) <= 2048, 'repair output is bounded by the repair budget')
    const ledger = stats(ctx)
    assert.equal(ledger.attempts, 2); assert.equal(ledger.unknownAttempts, 0)
    assert.deepEqual(ledger.recent.map(item => item.status), ['failed', 'generated'])
    assert.equal(ledger.recent[0].compactionId, ledger.recent[1].compactionId, 'both attempts share the same compaction')
    assert.equal(ledger.input, 1300); assert.equal(ledger.output, 50)
    const view = ctx.sessionProjections.snapshot(agent.session).values.contextManagerDiagnostics
    assert.equal(view.compactions[0].status, 'completed')
    assert.equal(view.compactions[0].inputTokens, 1300); assert.equal(view.compactions[0].outputTokens, 50)
  } finally { await ctx.fiber.dispose() }
})

test('repair: a second failure terminates without commit, charges both attempts and preserves the task', { timeout: 8000 }, async () => {
  const { ctx, adapter, agent } = await fixture({ typeBroken: true, repairFail: true })
  try {
    const task = message(); agent.followup(task); await agent.whenIdle()
    assert.deepEqual(adapter.order, ['summary-start', 'repair-start'])
    assert.equal(adapter.requests.length, 0); assert.equal(adapter.work, 0)
    assert.equal(commits(agent), 0)
    assert.ok(agent.session.deriveMessages().some(m => m.id === task.id))
    const ledger = stats(ctx)
    assert.equal(ledger.attempts, 2); assert.equal(ledger.unknownAttempts, 0)
    assert.deepEqual(ledger.recent.map(item => item.status), ['failed', 'failed'])
    const view = ctx.sessionProjections.snapshot(agent.session).values.contextManagerDiagnostics
    assert.equal(view.compactions[0].status, 'failed')
    assert.match(view.compactions[0].error ?? '', /格式修复未通过校验/)
  } finally { await ctx.fiber.dispose() }
})

test('repair: disabled by policy, a structural failure performs exactly one attempt', { timeout: 8000 }, async () => {
  const { ctx, adapter, agent } = await fixture({ typeBroken: true }, { formatRepairEnabled: false })
  try {
    const task = message(); agent.followup(task); await agent.whenIdle()
    assert.deepEqual(adapter.order, ['summary-start'])
    assert.equal(adapter.requests.length, 0); assert.equal(commits(agent), 0)
    assert.ok(agent.session.deriveMessages().some(m => m.id === task.id))
    const ledger = stats(ctx)
    assert.equal(ledger.attempts, 1); assert.equal(ledger.unknownAttempts, 0)
    assert.deepEqual(ledger.recent.map(item => item.status), ['failed'])
    const view = ctx.sessionProjections.snapshot(agent.session).values.contextManagerDiagnostics
    assert.match(view.compactions[0].error ?? '', /格式修复已关闭/)
  } finally { await ctx.fiber.dispose() }
})

test('repair: an error finish with no text is rejected without a second paid call and its usage is recorded', { timeout: 8000 }, async () => {
  const { ctx, adapter, agent } = await fixture({ fail: true })
  try {
    const task = message(); agent.followup(task); await agent.whenIdle()
    assert.deepEqual(adapter.order, ['summary-start'])
    assert.equal(adapter.requests.length, 0); assert.equal(commits(agent), 0)
    assert.ok(agent.session.deriveMessages().some(m => m.id === task.id))
    const ledger = stats(ctx)
    assert.equal(ledger.attempts, 1); assert.equal(ledger.unknownAttempts, 0)
    assert.equal(ledger.input, 600); assert.equal(ledger.output, 20, 'usage observed before the failure settles the failed attempt')
    const view = ctx.sessionProjections.snapshot(agent.session).values.contextManagerDiagnostics
    assert.match(view.compactions[0].error ?? '', /摘要未完整结束/)
  } finally { await ctx.fiber.dispose() }
})

for (const [name, option, errorMatch] of [
  ['truncated JSON', { truncated: true }, /损坏或截断/],
  ['missing fields', { missingField: true }, /缺少字段/],
  ['prose', { prose: true }, /损坏或截断/],
]) test(`repair: ${name} is rejected without any second provider call`, { timeout: 8000 }, async () => {
  const { ctx, adapter, agent } = await fixture(option)
  try {
    const task = message(); agent.followup(task); await agent.whenIdle()
    assert.deepEqual(adapter.order, ['summary-start'], 'damaged input must never reach a repair call')
    assert.equal(adapter.requests.length, 0); assert.equal(commits(agent), 0)
    assert.ok(agent.session.deriveMessages().some(m => m.id === task.id))
    assert.equal(stats(ctx).attempts, 1)
    const view = ctx.sessionProjections.snapshot(agent.session).values.contextManagerDiagnostics
    assert.match(view.compactions[0].error ?? '', errorMatch)
  } finally { await ctx.fiber.dispose() }
})

test('repair: a failed output whose complete repair request exceeds the window budget is rejected whole, never sliced', { timeout: 8000 }, async () => {
  const { ctx, adapter, agent } = await fixture({ oversize: true })
  try {
    const task = message(); agent.followup(task); await agent.whenIdle()
    assert.deepEqual(adapter.order, ['summary-start'], 'over-budget output must never reach a repair call')
    assert.equal(adapter.requests.length, 0); assert.equal(commits(agent), 0)
    assert.ok(agent.session.deriveMessages().some(m => m.id === task.id))
    const view = ctx.sessionProjections.snapshot(agent.session).values.contextManagerDiagnostics
    assert.match(view.compactions[0].error ?? '', /超出窗口预算/)
  } finally { await ctx.fiber.dispose() }
})

test('repair: a repair response with missing fields still fails closed', { timeout: 8000 }, async () => {
  const { ctx, adapter, agent } = await fixture({ typeBroken: true, repairMissingField: true })
  try {
    const task = message(); agent.followup(task); await agent.whenIdle()
    assert.deepEqual(adapter.order, ['summary-start', 'repair-start'])
    assert.equal(adapter.requests.length, 0); assert.equal(commits(agent), 0)
    assert.ok(agent.session.deriveMessages().some(m => m.id === task.id))
    const ledger = stats(ctx)
    assert.equal(ledger.attempts, 2); assert.deepEqual(ledger.recent.map(item => item.status), ['failed', 'failed'])
    const view = ctx.sessionProjections.snapshot(agent.session).values.contextManagerDiagnostics
    assert.match(view.compactions[0].error ?? '', /格式修复未通过校验/)
  } finally { await ctx.fiber.dispose() }
})

test('repair: a repair response that rewrites an already-valid field is rejected', { timeout: 8000 }, async () => {
  const { ctx, adapter, agent } = await fixture({ typeBroken: true, repairAltered: true })
  try {
    const task = message(); agent.followup(task); await agent.whenIdle()
    assert.deepEqual(adapter.order, ['summary-start', 'repair-start'])
    assert.equal(adapter.requests.length, 0); assert.equal(commits(agent), 0)
    assert.ok(agent.session.deriveMessages().some(m => m.id === task.id))
    const view = ctx.sessionProjections.snapshot(agent.session).values.contextManagerDiagnostics
    assert.match(view.compactions[0].error ?? '', /格式修复与无损修复要求不一致（goal）/u)
  } finally { await ctx.fiber.dispose() }
})

test('repair: cancellation during the repair stream stops everything without commit', { timeout: 8000 }, async () => {
  let started; const entered = new Promise(resolve => { started = resolve })
  const { ctx, adapter, agent } = await fixture({ typeBroken: true, repairHold: signal => new Promise((_resolve, reject) => {
    started(); signal.addEventListener('abort', () => reject(signal.reason), { once: true })
  }) })
  try {
    const task = message(); agent.followup(task); await entered
    assert.equal(adapter.requests.length, 0)
    agent.cancel({ kind: 'user' }); await agent.whenIdle()
    assert.equal(adapter.requests.length, 0); assert.equal(adapter.work, 0); assert.equal(commits(agent), 0)
    assert.ok(agent.session.deriveMessages().some(m => m.id === task.id))
    const ledger = stats(ctx)
    assert.equal(ledger.attempts, 2)
    assert.deepEqual(ledger.recent.map(item => item.status), ['failed', 'cancelled'])
  } finally { await ctx.fiber.dispose() }
})

test('repair: a late repair response after cancellation never commits and its delivered usage is recorded once', { timeout: 8000 }, async () => {
  let release; let started; const entered = new Promise(resolve => { started = resolve })
  const held = new Promise(resolve => { release = resolve })
  const { ctx, adapter, agent } = await fixture({ typeBroken: true, repairHold: async () => { started(); await held } })
  try {
    const task = message(); agent.followup(task); await entered
    agent.cancel({ kind: 'user' }); await agent.whenIdle()
    assert.equal(commits(agent), 0); assert.equal(adapter.requests.length, 0)
    release()
    await drainUntil(() => { const ledger = stats(ctx); return ledger.recent[1]?.status === 'cancelled' && ledger.recent[1].input !== null })
    await immediate()
    assert.equal(commits(agent), 0); assert.equal(adapter.requests.length, 0)
    assert.ok(agent.session.deriveMessages().some(m => m.id === task.id))
    const ledger = stats(ctx)
    assert.equal(ledger.attempts, 2); assert.equal(ledger.unknownAttempts, 0)
    assert.equal(ledger.recent[1].status, 'cancelled', 'late content must not upgrade a cancelled attempt')
    assert.equal(ledger.recent[1].input, 700); assert.equal(ledger.recent[1].output, 30, 'delivered usage is recorded once')
    // A second identical notification must not double-count.
    const id = ledger.recent[1].id
    await ctx.contextManager.summaryLedger.recordUsage('subject', id, { inputTokens: 9999, outputTokens: 9999 })
    assert.equal(stats(ctx).recent[1].input, 700)
  } finally { await ctx.fiber.dispose() }
})

test('repair: idle path repairs a type-broken summary once inside its maintenance pass', { timeout: 8000 }, async t => {
  const { ctx, adapter, agent } = await fixture({ typeBroken: true, repairText: repairedCheckpoint }, {}, history(28000))
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: Date.now() })
  try {
    agent.followup(message()); await agent.whenIdle()
    await drainUntil(() => ctx.contextManager.idleStatus(agent.id).status === 'scheduled')
    t.mock.timers.tick(900000)
    await drainUntil(() => ctx.contextManager.idleStatus(agent.id).status === 'completed')
    assert.deepEqual(adapter.order, ['main', 'summary-start', 'repair-start'])
    assert.equal(commits(agent), 1)
    const ledger = stats(ctx)
    assert.equal(ledger.attempts, 2); assert.deepEqual(ledger.recent.map(item => item.status), ['failed', 'generated'])
    assert.ok(ctx.contextManager.idleStatus(agent.id).afterTokens < ctx.contextManager.idleStatus(agent.id).beforeTokens)
  } finally { t.mock.timers.reset(); await ctx.fiber.dispose() }
})

test('repair: a repair response that adds facts to the broken field is rejected', { timeout: 8000 }, async () => {
  const { ctx, adapter, agent } = await fixture({ typeBroken: true, repairText: JSON.stringify({ goal: 'Preserve the pending task', constraints: ['Keep authorization boundaries', 'extra invented fact'], completed: ['Preparation complete'], pending: ['Continue current task'], evidence: [], next: 'Continue after completed preparation', uncertainties: [] }) })
  try {
    const task = message(); agent.followup(task); await agent.whenIdle()
    assert.deepEqual(adapter.order, ['summary-start', 'repair-start'])
    assert.equal(adapter.requests.length, 0); assert.equal(commits(agent), 0)
    assert.ok(agent.session.deriveMessages().some(m => m.id === task.id))
    const view = ctx.sessionProjections.snapshot(agent.session).values.contextManagerDiagnostics
    assert.match(view.compactions[0].error ?? '', /格式修复与无损修复要求不一致（constraints）/u)
  } finally { await ctx.fiber.dispose() }
})
