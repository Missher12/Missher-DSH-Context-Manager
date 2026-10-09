import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import Storage from '@deepseek-ai/dsh-storage'
import * as StorageJson from '@deepseek-ai/dsh-storage-json'
import * as StorageDomain from '@deepseek-ai/dsh-storage-domain'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import TokenMeter from '@deepseek-ai/dsh-token-meter'
import * as ImageOffload from '@deepseek-ai/dsh-compaction-image-offload'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import { IMAGE_OFFLOAD_REQUIRED_CODE, LlmAdapter, LlmError, createMessage,
  createUserMessage, resolveRetryPolicy } from '@deepseek-ai/dsh-llm'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import Manager from '../lib/index.js'
import Engine from '../lib/engine.js'
import { defaults } from '../lib/policy.js'

// The real public image-offload plugin owns recovery and its message projection.
// Only the provider is fake. This file never reads credentials or makes requests.
const SESSION = 'summary-recovery-subject'
const OLD_MARKER = 'ORIGINAL_IMAGE_CONTEXT:'
const FIRST_USAGE = { inputTokens: 400, outputTokens: 11, cacheReadTokens: 30, cacheWriteTokens: 5 }
const SECOND_USAGE = { inputTokens: 500, outputTokens: 23, cacheReadTokens: 70, cacheWriteTokens: 7 }
const CHECKPOINT = JSON.stringify({ goal: 'Continue the latest task unchanged',
  constraints: ['Keep the latest task and its attachment intact'], completed: ['Read earlier context'],
  pending: ['Perform the latest task'], evidence: ['Earlier source events remain in the transcript'],
  next: 'Continue with the latest task', uncertainties: [] })

function deferred() {
  let resolve
  const promise = new Promise(done => { resolve = done })
  return { promise, resolve }
}

function image(name) {
  return { type: 'image', attachment: { attachmentId: `sha256:${(name === 'old-image' ? 'a' : 'b').repeat(64)}`,
    name, mediaType: 'image/png', bytes: 1, width: 1, height: 1 } }
}

function message(text, name) {
  return createUserMessage({ content: [{ type: 'text', text }, image(name)], source: { kind: 'user' } })
}

function history() {
  const session = Session.create(SessionId('summary-recovery-seed'))
  session.append('turn/start', { turn: 1 })
  session.append('step/start', { turn: 1, step: 1 })
  session.append('system/message', { turn: 1, step: 1, message: createMessage({ role: 'system',
    content: [], source: { kind: 'system-prompt' } }) }, { surfaceOp: 'append' })
  session.append('user/message', message(OLD_MARKER + 'h'.repeat(32000), 'old-image'), { surfaceOp: 'append' })
  session.append('assistant/message', { stream: [], turn: 1, step: 1, message: createMessage({ role: 'assistant',
    content: [{ type: 'text', text: 'Earlier work finished' }], source: { kind: 'model', provider: 'mock', model: 'images' } }) },
  { surfaceOp: 'append' })
  session.append('step/end', { turn: 1, step: 1 })
  session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
  return session.snapshotEvents()
}

function failure(kind) {
  if (kind === 'generic') return new Error('Unstructured summary outage')
  return new LlmError('Summary fixture failure', kind === 'other' ? 'SERVER' : IMAGE_OFFLOAD_REQUIRED_CODE,
    { status: 413, requestId: 'fixture-request-id', ...(kind === 'other' ? {} : { offloadImages: 1 }) })
}

class Adapter extends LlmAdapter {
  summaries = []
  business = []
  order = []
  entered = deferred()
  release = deferred()
  firstClosed = deferred()
  constructor(options) { super(); this.options = options; this.error = failure(options.kind) }
  async resolveModel(provider, model) {
    return { provider, id: model, name: model, context: { contextWindow: 10000 }, defaultMaxTokens: 512 }
  }
  imageRequestPricing() { return { priceImages: images => images.map(() => ({ visualTokens: this.options.imageTokens ?? 64, text: 'image handle' })) } }
  providerRetryPolicy() { return resolveRetryPolicy({ mode: 'normal', maxRetries: 0 }, 'summary-recovery-test') }
  async *stream(options) {
    assert.equal(options.provider, 'mock', 'all provider execution stays inside the fake adapter')
    if (options.purpose === 'compaction') {
      this.summaries.push(options)
      this.order.push('summary')
      if (this.summaries.length === 1) {
        try {
          yield { type: 'usage', usage: { ...FIRST_USAGE } }
          if (this.options.pause) {
            this.entered.resolve()
            // One controlled late failure after real Agent cancellation.
            await this.release.promise
          }
          if (this.options.mode === 'throw') throw this.error
          yield { type: 'finish', reason: { kind: 'error', failure: this.error.failure } }
        } finally { this.firstClosed.resolve() }
        return
      }
      assert.equal(this.summaries.length, 2, 'one offload recovery must not create further provider attempts')
      yield { type: 'usage', usage: { ...SECOND_USAGE } }
      yield { type: 'block-start', index: 0, blockType: 'text' }
      yield { type: 'block-end', index: 0, block: { type: 'text', text: CHECKPOINT } }
      yield { type: 'finish', reason: { kind: 'stop' } }
      return
    }
    this.order.push('business')
    this.business.push(options)
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'block-end', index: 0, block: { type: 'text', text: 'done' } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

async function fixture(t, options) {
  const profile = await mkdtemp(join(tmpdir(), 'dsh-context-summary-recovery-'))
  const ctx = new Context()
  const adapter = new Adapter(options)
  t.after(async () => {
    adapter.release.resolve()
    try { await ctx.fiber.dispose() }
    finally { await rm(profile, { recursive: true, force: true }) }
  })
  ctx.provide('profileContext', { dir: profile })
  await ctx.plugin(Storage)
  await ctx.plugin(StorageJson, { root: join(profile, 'storage') })
  await ctx.plugin(StorageDomain, { backend: 'json' })
  await mountAgentLoopTestDependencies(ctx)
  await ctx.plugin(AgentLoop, { agents: [] })
  await ctx.plugin(TokenMeter)
  await ctx.plugin(ImageOffload)
  await ctx.plugin(Manager, { policy: { ...defaults, summaryMaxTokens: 512, maxPasses: 1, idleEnabled: false } })
  await ctx.plugin(Engine)
  ctx.llm.registerAdapter(['mock'], adapter)
  const observed = []
  ctx.on('compaction/summary-error', (payload, next) => {
    observed.push({ error: payload.error, signal: payload.signal,
      sourceEventSeqs: [...payload.sourceEventSeqs], stats: ctx.contextManager.summaryLedger.stats(SESSION) })
    return next()
  }, true)
  const { agent } = await ctx.agentLoop.createAgent(ctx, { sessionId: SessionId(SESSION), seed: history(),
    agentOptions: { provider: 'mock', model: 'images' } })
  const before = structuredClone(agent.session.snapshotEvents())
  const old = before.find(event => event.type === 'user/message'
    && event.data.content.some(block => block.type === 'text' && block.text.startsWith(OLD_MARKER)))
  assert.ok(old, 'the source image is in real immutable Session history')
  const task = message('LATEST_TASK_MUST_REMAIN_VERBATIM:' + 'x'.repeat(2000), 'new-task-image')
  return { ctx, adapter, agent, observed, before, old, task }
}

function assertOriginals(env) {
  const { agent, adapter, before, old, task } = env
  const events = agent.session.snapshotEvents()
  assert.deepEqual(events.slice(0, before.length), before, 'original events and attachment references remain unchanged')
  assert.equal(events[old.seq].data.content.find(block => block.type === 'image').offloaded, undefined,
    'offload is a separate durable projection, never a rewrite of original image evidence')
  const appended = events.filter(event => event.type === 'user/message' && event.data.id === task.id)
  assert.equal(appended.length, 1, 'the exact new task enters history once')
  assert.deepEqual(appended[0].data, task)
  assert.deepEqual(agent.session.deriveMessages().find(item => item.id === task.id), task,
    'current surface retains the new task, including its original attachment')
  for (const request of adapter.summaries) {
    assert.ok(!request.messages.some(item => item.id === task.id), 'recovery never adds the latest task to the old summary span')
  }
  for (const request of adapter.business) assert.deepEqual(request.messages.find(item => item.id === task.id), task)
  return events
}

function billed(item, usage) {
  assert.equal(item.input, usage.inputTokens + usage.cacheReadTokens + usage.cacheWriteTokens)
  assert.equal(item.output, usage.outputTokens)
  assert.equal(item.cacheRead, usage.cacheReadTokens)
  assert.equal(item.cacheWrite, usage.cacheWriteTokens)
}

for (const mode of ['throw', 'finish']) {
  test(`summary recovery: ${mode} preserves typed failure for real image offload and separate usage`,
    { timeout: 15000 }, async t => {
      const env = await fixture(t, { mode, kind: 'offload', imageTokens: 700 })
      const { ctx, adapter, agent, observed, old, task } = env
      agent.followup(task)
      await agent.whenIdle()
      assert.deepEqual(adapter.order, ['summary', 'summary', 'business'])
      assert.equal(observed.length, 1)
      assert.ok(observed[0].error instanceof LlmError)
      assert.equal(observed[0].error.code, IMAGE_OFFLOAD_REQUIRED_CODE)
      assert.deepEqual(observed[0].error.failure, adapter.error.failure,
        'code, message, offload count and provider facts survive both failure forms')
      assert.equal(observed[0].signal.aborted, false)
      assert.ok(observed[0].sourceEventSeqs.includes(old.seq))
      assert.equal(observed[0].stats.attempts, 1)
      assert.equal(observed[0].stats.recent[0].status, 'failed', 'failed attempt settles before recovery runs')
      billed(observed[0].stats.recent[0], FIRST_USAGE)
      const events = assertOriginals(env)
      const decisions = events.filter(event => event.type === 'image/offload')
      assert.equal(decisions.length, 1)
      assert.deepEqual(decisions[0].data.targets, [{ seq: old.seq, imageIndexes: [0] }])
      assert.equal(adapter.summaries[0].messages.find(item => item.id === old.data.id)
        .content.find(block => block.type === 'image').offloaded, undefined)
      assert.equal(adapter.summaries[1].messages.find(item => item.id === old.data.id)
        .content.find(block => block.type === 'image').offloaded, true,
      'the second real request uses the public image/offload message projection')
      const commits = events.filter(event => event.type === 'compaction/summary')
      assert.equal(commits.length, 1)
      assert.ok(commits[0].data.shadowedSeqs.includes(old.seq))
      const replacement = events[commits[0].seq + 1]
      assert.equal(replacement.type, 'user/message')
      assert.ok(replacement.sourceEventSeqs.includes(old.seq), 'the committed checkpoint retains source provenance')
      assert.equal(events.filter(event => event.type === 'compaction/start').length, 1)
      assert.equal(events.filter(event => event.type === 'compaction/end').length, 1)
      assert.equal(events.at(-1).data.reason.kind, 'completed')
      const stats = ctx.contextManager.summaryLedger.stats(SESSION)
      assert.equal(stats.attempts, 2)
      assert.equal(stats.unknownAttempts, 0)
      assert.deepEqual(stats.recent.map(item => item.status), ['failed', 'generated'])
      assert.notEqual(stats.recent[0].id, stats.recent[1].id)
      assert.ok(stats.recent.every(item => item.compactionId === commits[0].data.compactionId))
      billed(stats.recent[0], FIRST_USAGE)
      billed(stats.recent[1], SECOND_USAGE)
      assert.equal(stats.input, 1012)
      assert.equal(stats.output, 34)
      const rows = ctx.contextManager.summaryOperations.records(SESSION)
      const cycle = { summaryCalls: rows.filter(row => row.purpose !== 'repair').length, calls: rows.length }
      assert.equal(cycle.summaryCalls, 2, 'image recovery also consumes one primary call in the unified budget')
      assert.equal(cycle.calls, 2, 'both actual requests consume the durable total allowance')
    })

  test(`summary recovery: cancel before late ${mode} failure does not offload, retry or commit`,
    { timeout: 15000 }, async t => {
      const env = await fixture(t, { mode, kind: 'offload', pause: true })
      const { ctx, adapter, agent, observed, task } = env
      agent.followup(task)
      await adapter.entered.promise
      agent.cancel({ kind: 'user' })
      adapter.release.resolve()
      await agent.whenIdle()
      await adapter.firstClosed.promise
      assert.deepEqual(adapter.order, ['summary'])
      assert.equal(observed.length, 0, 'an aborted compaction never invokes the recovery waterfall')
      const events = assertOriginals(env)
      assert.equal(events.filter(event => event.type === 'image/offload').length, 0)
      assert.equal(events.filter(event => event.type === 'compaction/summary').length, 0)
      assert.equal(events.filter(event => event.type === 'compaction/start').length, 1)
      assert.equal(events.filter(event => event.type === 'compaction/end').length, 1)
      assert.notEqual(events.at(-1).data.reason.kind, 'completed')
      const stats = ctx.contextManager.summaryLedger.stats(SESSION)
      assert.equal(stats.attempts, 1)
      assert.equal(stats.unknownAttempts, 0)
      assert.equal(stats.recent[0].status, 'cancelled')
      billed(stats.recent[0], FIRST_USAGE)
    })
}

for (const [mode, kind] of [['throw', 'generic'], ['finish', 'other']]) {
  test(`summary recovery: ${kind} ${mode} failure is terminal without image omission or retry`,
    { timeout: 15000 }, async t => {
      const env = await fixture(t, { mode, kind })
      const { ctx, adapter, agent, observed, task } = env
      agent.followup(task)
      await agent.whenIdle()
      assert.deepEqual(adapter.order, ['summary'])
      assert.equal(observed.length, 1)
      if (kind === 'other') {
        assert.ok(observed[0].error instanceof LlmError)
        assert.deepEqual(observed[0].error.failure, adapter.error.failure)
      } else {
        // The real adapter boundary converts a generic Error to an UNKNOWN
        // failure chunk; the engine preserves that public typed failure.
        assert.ok(observed[0].error instanceof LlmError)
        assert.equal(observed[0].error.code, 'UNKNOWN')
        assert.equal(observed[0].error.message, adapter.error.message)
        assert.deepEqual(observed[0].error.failure, { code: 'UNKNOWN', message: adapter.error.message })
      }
      assert.notEqual(observed[0].error.code, IMAGE_OFFLOAD_REQUIRED_CODE)
      assert.equal(observed[0].error.failure.offloadImages, undefined)
      const events = assertOriginals(env)
      assert.equal(events.filter(event => event.type === 'image/offload').length, 0)
      assert.equal(events.filter(event => event.type === 'compaction/summary').length, 0)
      assert.equal(events.filter(event => event.type === 'compaction/start').length, 1)
      assert.equal(events.filter(event => event.type === 'compaction/end').length, 1)
      assert.notEqual(events.at(-1).data.reason.kind, 'completed')
      const stats = ctx.contextManager.summaryLedger.stats(SESSION)
      assert.equal(stats.attempts, 1)
      assert.equal(stats.unknownAttempts, 0)
      assert.equal(stats.recent[0].status, 'failed')
      billed(stats.recent[0], FIRST_USAGE)
    })
}
