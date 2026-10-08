import { test } from 'node:test'
import assert from 'node:assert/strict'
import { TYPERT } from '../lib/typert.js'

// Exercise the shipped codec entry, not a parallel schema or a service-only return value.
const codec = method => TYPERT.invocations.find(item => item.method === method).result.create()
// The shipped inspection codec, reached the same way the Host reaches it.
const inspectionSchema = () => codec('inspect')
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
const fieldTotal = (sum, reported, missing) => ({ sum, reported, missing })
const efficiency = (patch = {}) => ({
  accounting: 'host-projection',
  host: { uncachedInputTokens: 1200, cacheReadTokens: 340, cacheWriteTokens: 12, outputTokens: 56 },
  mirrored: { settledAttempts: 3, retries: 1, withoutUsage: 1,
    uncachedInput: fieldTotal(1200, 2, 1), cacheRead: fieldTotal(340, 3, 0), cacheWrite: fieldTotal(12, 3, 0),
    output: fieldTotal(56, 2, 1), cacheInclusiveInput: fieldTotal(1552, 2, 1), complete: false },
  differences: [{ field: 'cacheReadTokens', host: 340, mirrored: 300, delta: 40 }],
  summaryAndRepair: { source: 'summary-ledger', input: 900, output: 120, cacheRead: 800, cacheWrite: 0,
    attempts: 2, unknownAttempts: 1, purposeSplit: false, note: '现有摘要总账的累计值，含失败与取消尝试；账本没有持久用途字段' },
  maintenanceSuspects: 1, cacheHitRatio: 0.22,
  requests: [{ seq: 2, time: 5, turn: 1, step: 1, settledBy: 'attempt', routeKnown: false, retry: 1,
    provider: 'unknown', model: 'unknown', uncachedInput: null, cacheRead: 30, cacheWrite: null, output: 4, maintenanceSuspect: true }],
  fingerprint: { prefix: 'a'.repeat(16), toolSchema: 'b'.repeat(16), toolOrder: 'c'.repeat(16), tools: 7, systemChars: 1234 },
  changes: [{ seq: 9, time: 77, changed: ['prefix', 'toolOrder'], note: '工具顺序变化' }],
  ...patch,
})
const reduction = (patch = {}) => ({ mode: 'reduce', pipelineReported: true,
  published: { references: 2, originalChars: 4000, shortenedChars: 900, visibleCharsRemoved: 3100 },
  pending: 1, reverted: 1,
  recent: [{ contentId: 'sha256:abc', callId: 'call-1', tool: 'bash', shortenedChars: 900, complete: true, at: 12345 }],
  notes: ['visibleCharsRemoved 是可见文本字符差，不是账单金额或 Token 计费节省'],
  run: { considered: 9, unverified: 1, wouldReduce: 4, skipped: 3, failed: 1, lastSkip: 'no_savings', lastReason: '低于最小节省' },
  ...patch })

test('actual inspect codec preserves the complete attribution and session reduction readout through JSON', () => {
  const value = { ...inspection(), efficiency: efficiency(), reduction: reduction() }
  const answer = roundTrip('inspect', value)
  assert.deepEqual(answer, value)
  assert.equal(answer.efficiency.host.cacheWriteTokens, 12)
  assert.equal(answer.efficiency.mirrored.cacheInclusiveInput.missing, 1)
  assert.equal(answer.efficiency.summaryAndRepair.purposeSplit, false)
  // A ledger that never reported a cache component stays unknown instead of 0.
  const unreported = inspection()
  unreported.efficiency = efficiency({ summaryAndRepair: { ...efficiency().summaryAndRepair, cacheRead: null, cacheWrite: null } })
  assert.equal(inspectionSchema().parse(unreported).efficiency.summaryAndRepair.cacheRead, null, 'an unreported component is not silently zero')
  assert.equal(answer.reduction.published.visibleCharsRemoved, 3100)
  assert.equal(answer.reduction.run.lastSkip, 'no_savings')
})

test('actual inspect codec keeps both readouts optional for old responses and preserves unknown as unknown', () => {
  const old = roundTrip('inspect', inspection())
  assert.deepEqual(old, inspection())
  assert.equal(Object.hasOwn(old, 'efficiency'), false)
  assert.equal(Object.hasOwn(old, 'reduction'), false)

  // An event-log-only cut keeps nulls null, an unavailable ledger null, and a
  // zero that was really reported stays a real zero.
  const unknown = { ...inspection(), efficiency: efficiency({ accounting: 'event-log', host: null, summaryAndRepair: null,
    cacheHitRatio: null, fingerprint: null, changes: [], differences: [], maintenanceSuspects: 0,
    mirrored: { settledAttempts: 1, retries: 0, withoutUsage: 1, uncachedInput: fieldTotal(0, 0, 1), cacheRead: fieldTotal(0, 0, 1),
      cacheWrite: fieldTotal(0, 0, 1), output: fieldTotal(0, 0, 1), cacheInclusiveInput: fieldTotal(0, 0, 1), complete: false } }),
    reduction: reduction({ mode: 'off', pipelineReported: false, published: { references: 0, originalChars: 0, shortenedChars: 0, visibleCharsRemoved: 0 },
      pending: 0, reverted: 0, recent: [], notes: [], run: { considered: 0, unverified: 0, wouldReduce: 0, skipped: 0, failed: 0, lastSkip: null, lastReason: null } }) }
  const answer = roundTrip('inspect', unknown)
  assert.deepEqual(answer, unknown)
  assert.equal(answer.efficiency.host, null)
  assert.equal(answer.efficiency.cacheHitRatio, null)
  assert.equal(Object.hasOwn(answer.reduction, 'archiveError'), false)
  // Archive errors survive and are never turned into an empty reading.
  const failed = { ...inspection(), reduction: reduction({ archiveError: '原文档案目录不可写' }) }
  assert.deepEqual(roundTrip('inspect', failed), failed)
  // A negative difference is a real reading, not a malformed count.
  const shifted = { ...inspection(), efficiency: efficiency({ differences: [{ field: 'outputTokens', host: 40, mirrored: 56, delta: -16 }] }) }
  assert.deepEqual(roundTrip('inspect', shifted), shifted)
})

test('inspect codec rejects malformed, unbounded and non-JSON attribution values', () => {
  const result = codec('inspect')
  const cases = [
    ['accounting', efficiency({ accounting: 'projection' })],
    ['host', efficiency({ host: { uncachedInputTokens: -1, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 0 } })],
    ['host-incomplete', efficiency({ host: { uncachedInputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 } })],
    ['nested-extra', efficiency({ mirrored: { ...efficiency().mirrored, extra: true } })],
    ['ratio', efficiency({ cacheHitRatio: 1.5 })],
    ['ratioNegative', efficiency({ cacheHitRatio: -0.1 })],
    ['attempts', efficiency({ mirrored: { ...efficiency().mirrored, settledAttempts: 1.5 } })],
    ['summarySplit', efficiency({ summaryAndRepair: { ...efficiency().summaryAndRepair, purposeSplit: true } })],
    ['summaryCacheNegative', efficiency({ summaryAndRepair: { ...efficiency().summaryAndRepair, cacheRead: -1 } })],
    ['summaryCacheString', efficiency({ summaryAndRepair: { ...efficiency().summaryAndRepair, cacheWrite: '12' } })],
    ['note', efficiency({ summaryAndRepair: { ...efficiency().summaryAndRepair, note: 'x'.repeat(601) } })],
    ['fingerprint', efficiency({ fingerprint: { ...efficiency().fingerprint, prefix: 'a'.repeat(65) } })],
    ['changes', efficiency({ changes: Array.from({ length: 17 }, (_, seq) => ({ seq, time: seq, changed: ['prefix'], note: 'x' })) })],
    ['change-empty', efficiency({ changes: [{ seq: 1, time: 1, changed: [], note: 'x' }] })],
    ['change-kind', efficiency({ changes: [{ seq: 1, time: 1, changed: ['route'], note: 'x' }] })],
    ['requests', efficiency({ requests: Array.from({ length: 201 }, (_, seq) => ({ ...efficiency().requests[0], seq })) })],
    ['request-provider', efficiency({ requests: [{ ...efficiency().requests[0], provider: 'p'.repeat(201) }] })],
    ['request-settledBy', efficiency({ requests: [{ ...efficiency().requests[0], settledBy: 'stream' }] })],
    ['extra-top', efficiency({ extra: 1 })],
    ['reduction-mode', reduction({ mode: 'safe' })],
    ['reduction-recent', reduction({ recent: Array.from({ length: 9 }, (_, index) => ({ ...reduction().recent[0], contentId: `id-${index}` })) })],
    ['reduction-callId', reduction({ recent: [{ ...reduction().recent[0], callId: 'c'.repeat(201) }] })],
    ['reduction-callId-empty', reduction({ recent: [{ ...reduction().recent[0], callId: '' }] })],
    ['reduction-notes', reduction({ notes: Array.from({ length: 9 }, () => 'x') })],
    ['reduction-run', reduction({ run: { ...reduction().run, lastSkip: 'x'.repeat(101) } })],
    ['reduction-error', reduction({ archiveError: 'x'.repeat(401) })],
    ['reduction-extra', reduction({ extra: 1 })],
    ['reduction-negative', reduction({ pending: -1 })],
  ]
  for (const [name, value] of cases) {
    const target = Object.hasOwn(value, 'published') || Object.hasOwn(value, 'mode') ? { reduction: value } : { efficiency: value }
    assert.equal(result.safeParse({ ...inspection(), ...target }).success, false, name)
  }
})
