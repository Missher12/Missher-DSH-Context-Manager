import { test } from 'node:test'
import assert from 'node:assert/strict'
import { TYPERT } from '../lib/typert.js'

// Exercise the shipped codec entry, not a parallel schema or a service-only return value.
const codec = method => TYPERT.invocations.find(item => item.method === method).result.create()
const roundTrip = (method, value) => {
  const result = codec(method)
  return result.parse(JSON.parse(JSON.stringify(result.parse(value))))
}
const inspection = () => ({
  sessionId: 'wire-goal', cursor: 12, cutSeq: 12, sampledAt: 1, historical: false,
  pressure: null, model: null, parts: [], official: null, usage: null,
  pressureHistory: [], rows: [], total: 0, offset: 0, pageSize: 50, activeCount: 0, archivedCount: 0,
  requests: [], requestCount: 0, compactions: [],
})
const goal = () => ({
  phase: 'blocked', blockedReason: { code: 'goal-round-limit', message: 'Goal reached its configured limit of 12 rounds.' },
  roundsStarted: 12, maxGoalRounds: 12,
})

test('actual inspect codec preserves the complete Goal stop readout through JSON transport', () => {
  const value = { ...inspection(), goal: goal() }
  assert.deepEqual(roundTrip('inspect', value), value)
  const active = { ...inspection(), goal: { ...goal(), phase: 'active', blockedReason: null } }
  assert.deepEqual(roundTrip('inspect', active), active)
})

test('actual inspect codec keeps Goal optional for old or historical responses', () => {
  for (const historical of [false, true]) {
    const value = { ...inspection(), historical }
    const answer = roundTrip('inspect', value)
    assert.deepEqual(answer, value)
    assert.equal(Object.hasOwn(answer, 'goal'), false)
  }
})

test('Goal codec rejects missing fields, unknown nested fields and unbounded or invalid values', () => {
  const result = codec('inspect')
  const { maxGoalRounds, ...missing } = goal()
  for (const invalid of [
    null, missing, { ...goal(), extra: true },
    { ...goal(), phase: '' }, { ...goal(), phase: 'x'.repeat(101) },
    { ...goal(), blockedReason: { code: '', message: 'reason' } },
    { ...goal(), blockedReason: { code: 'x'.repeat(101), message: 'reason' } },
    { ...goal(), blockedReason: { code: 'limit', message: 'x'.repeat(4001) } },
    { ...goal(), blockedReason: { code: 'limit', message: 'reason', extra: true } },
    { ...goal(), roundsStarted: -1 }, { ...goal(), roundsStarted: 1.5 },
    { ...goal(), maxGoalRounds: Number.MAX_SAFE_INTEGER + 1 },
  ]) assert.equal(result.safeParse({ ...inspection(), goal: invalid }).success, false)
})

test('actual idle codec preserves each compaction phase and accepts old responses without it', () => {
  const status = { status: 'compacting', dueAt: null, message: 'Preparing context' }
  assert.deepEqual(roundTrip('idleStatus', status), status)
  for (const compactionPhase of ['summarizing', 'repairing']) {
    const value = { ...status, compactionPhase }
    assert.deepEqual(roundTrip('idleStatus', value), value)
  }
  for (const compactionPhase of ['', 'completed', null, 1]) {
    assert.equal(codec('idleStatus').safeParse({ ...status, compactionPhase }).success, false)
  }
})

test('actual inspect codec preserves optional admission measurements and rejects invalid meter metadata', () => {
  const admission = { tokens: 162000, logRevision: 13, baseline: 'usage', window: 200000, outputReserve: 8192 }
  for (const reading of [admission, { ...admission, baseline: 'estimated', window: null, outputReserve: null },
    { ...admission, baseline: 'none', tokens: 0, outputReserve: 0 }]) {
    const value = { ...inspection(), admission: reading }
    assert.deepEqual(roundTrip('inspect', value), value)
  }
  assert.equal(Object.hasOwn(roundTrip('inspect', inspection()), 'admission'), false)
  const { baseline, ...incomplete } = admission
  for (const invalid of [null, incomplete, { ...admission, extra: true }, { ...admission, baseline: 'projection' },
    { ...admission, tokens: -1 }, { ...admission, tokens: 1.5 }, { ...admission, logRevision: -1 },
    { ...admission, window: 0 }, { ...admission, outputReserve: -1 }, { ...admission, tokens: Infinity }]) {
    assert.equal(codec('inspect').safeParse({ ...inspection(), admission: invalid }).success, false)
  }
})
