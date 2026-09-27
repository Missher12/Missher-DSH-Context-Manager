import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { diagnosticsProjection as projection } from '../lib/diagnostics.js'

const event = (type, data, seq = 0, rest = {}) => ({ type, data, seq, time: 1000 + seq * 100, ...rest })
const start = id => event('compaction/start', { compactionId: id, turn: 1 })
const summary = id => event('compaction/summary', { compactionId: id, shadowedRange: { start: 9, end: 2 }, shadowedSeqs: [9, 2], shadowedTokenCount: 2000 }, 10)
const replacement = (seq = 11) => event('user/message', createUserMessage({ content: [{ type: 'text', text: 'checkpoint' }], source: { kind: 'user' } }), seq, { surfaceOp: { startSeq: 9, endSeq: 2 } })
const fold = events => events.reduce(projection.apply, projection.init())

test('compaction savings require the adjacent matching replacement and a successful end', () => {
  let state = fold([start('c'), summary('c')])
  assert.equal(state.view.compactions[0].applied, false)
  state = projection.apply(state, replacement())
  assert.equal(state.view.compactions[0].status, 'running')
  assert.equal(state.view.compactions[0].applied, true)
  state = projection.apply(state, event('compaction/end', { compactionId: 'c', turn: 1, error: 'flush failed' }, 12))
  assert.equal(state.view.compactions[0].status, 'failed')
  assert.equal(state.view.compactions[0].applied, true, 'post-replacement failure is not a rollback')
  assert.ok(state.view.compactions[0].afterTokens < 2000)
  assert.deepEqual(projection.stateSchema.parse(state), state)
  const missing = fold([start('c'), summary('c'), replacement(12), event('compaction/end', { compactionId: 'c', turn: 1 }, 13)])
  assert.equal(missing.view.compactions[0].status, 'unapplied')
  assert.equal(missing.view.compactions[0].afterTokens, undefined)
})

test('replay boundary ends abandoned work and prune uses the same shadow protocol', () => {
  const seed = fold([start('old'), event('session/end-seed', {}, 1)])
  assert.equal(seed.view.compactions[0].status, 'interrupted')
  const prune = fold([event('compaction/prune', summary('c').data, 10), replacement()])
  assert.equal(prune.view.compactions[0].kind, 'prune')
  assert.equal(prune.view.compactions[0].status, 'completed')
  assert.equal(prune.view.compactions[0].applied, true)
})

test('projection is bounded, does not retain content, and keeps identity for unrelated events', () => {
  let state = projection.init()
  for (let i = 0; i < 40; i++) state = projection.apply(state, start(`c-${i}`))
  assert.equal(state.view.compactions.length, 12)
  state = projection.apply(state, event('request/header', { header: { config: { provider: 'mock', model: 'large', maxTokens: 4096 }, tools: Array.from({ length: 30 }, (_, i) => ({ name: `tool-${i}`, description: 'DO_NOT_COPY_TO_VIEW'.repeat(i + 1), parameters: {} })) } }))
  assert.equal(state.view.tools.count, 30)
  assert.equal(state.view.tools.top.length, 8)
  assert.equal(state.view.tools.top[0].name, 'tool-29')
  assert.ok(!JSON.stringify(state).includes('DO_NOT_COPY_TO_VIEW'))
  for (let i = 0; i < 30; i++) state = projection.apply(state, event('assistant/message', { turn: i, step: 1, usage: { inputTokens: 10, cacheReadTokens: 100, cacheWriteTokens: 20, outputTokens: 5 } }, i + 20, { surfaceOp: 'append' }))
  assert.equal(state.view.requests.length, 12)
  assert.equal(state.view.requests[0].input, 130, 'cache reads and writes still occupy the prompt')
  assert.equal(state.view.requests[0].output, 5)
  assert.strictEqual(projection.apply(state, event('step/end', { turn: 1, step: 1 })), state)
  assert.deepEqual(projection.stateSchema.parse(state), state)
})
