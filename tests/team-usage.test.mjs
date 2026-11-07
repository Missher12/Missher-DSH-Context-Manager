import { test } from 'node:test'
import assert from 'node:assert/strict'
import { AssistantStreamAccumulator } from '@deepseek-ai/dsh-llm'
import { aggregateTeamUsage, attributeOwnedSession, resolveSummaryCoverage, resolveVerifiedTeam } from '../src/team-usage.ts'

const lead = { id: 'lead-id', name: 'lead', role: 'lead', phase: 'active' }
const roster = members => ({ rootId: 'lead-id', members })
const attemptStream = (usage, time) => {
  const stream = new AssistantStreamAccumulator()
  stream.push({ time, chunk: { type: 'usage', usage } })
  return [...stream.snapshot()]
}

test('a lead-only projection and an ordinary child do not prove a team', () => {
  assert.equal(resolveVerifiedTeam('lead-id', [], [roster([lead])]), null)
  const team = roster([lead, { id: 'actual-member', name: 'worker', role: 'teammate', phase: 'active' }])
  assert.equal(resolveVerifiedTeam('ordinary-fork', ['lead-id'], [team]), null)
})

test('a persistent roster accepts opaque member ids and keeps failed or ended members', () => {
  const member = { id: '5741e83e-05fd-450c-8dbd-680c4da9e818', name: 'worker', role: 'teammate', phase: 'failed' }
  const result = resolveVerifiedTeam(member.id, ['lead-id'], [roster([lead, member, member])])
  assert.equal(result.teamId, 'lead-id')
  assert.deepEqual(result.members.map(item => [item.id, item.phase]), [
    ['lead-id', 'active'], [member.id, 'failed'],
  ])
})

test('owned attribution excludes inherited calls and inherited routes without backfilling later routes', () => {
  const events = [
    { seq: 0, time: 1, type: 'request/header', data: { header: { config: { provider: 'deepseek-official', model: 'deepseek-flash' } } } },
    { seq: 1, time: 2, type: 'assistant/message', surfaceOp: 'append', data: { turn: 1, step: 1,
      usage: { inputTokens: 100, outputTokens: 10 }, message: { source: { kind: 'model', provider: 'deepseek-official', model: 'deepseek-flash' }, content: [] } } },
    { seq: 2, time: 3, type: 'assistant/attempt', data: { turn: 2, step: 1,
      stream: attemptStream({ inputTokens: 20, outputTokens: 4 }, 3) } },
    { seq: 3, time: 4, type: 'request/header', data: { header: { config: { provider: 'deepseek-official', model: 'deepseek-v4-pro' } } } },
    { seq: 4, time: 5, type: 'assistant/message', surfaceOp: 'append', data: { turn: 3, step: 1,
      usage: { inputTokens: 30, outputTokens: 6 }, message: { source: { kind: 'model', provider: 'deepseek-official', model: 'deepseek-v4-pro' }, content: [] } } },
  ]
  const result = attributeOwnedSession(events, 2)
  assert.equal(result.attribution.mirrored.settledAttempts, 2)
  assert.equal(result.attribution.mirrored.uncachedInput.sum, 50)
  assert.equal(result.attribution.mirrored.output.sum, 10)
  assert.equal(result.attribution.requests[0].routeKnown, false)
  assert.equal(result.attribution.requests[0].model, 'unknown')
  assert.equal(result.attribution.requests[1].model, 'deepseek-v4-pro')
  assert.equal(result.cost.requestTokens, 60)
  assert.equal(result.cost.partial, true)
})

test('owned same-step settlements replace until a retry boundary and then count the next attempt', () => {
  const events = [
    { seq: 0, time: 1, type: 'request/header', data: { header: { config: { provider: 'deepseek-official', model: 'deepseek-flash' } } } },
    { seq: 1, time: 2, type: 'assistant/message', surfaceOp: 'append', data: { turn: 1, step: 1,
      usage: { inputTokens: 900, outputTokens: 90 }, message: { source: { kind: 'model', provider: 'deepseek-official', model: 'deepseek-flash' }, content: [] } } },
    { seq: 2, time: 3, type: 'request/header', data: { header: { config: { provider: 'deepseek-official', model: 'deepseek-flash' } } } },
    { seq: 3, time: 4, type: 'assistant/message', surfaceOp: 'append', data: { turn: 2, step: 1,
      usage: { inputTokens: 100, outputTokens: 10 }, message: { source: { kind: 'model', provider: 'deepseek-official', model: 'deepseek-flash' }, content: [] } } },
    { seq: 4, time: 5, type: 'assistant/message', surfaceOp: 'append', data: { turn: 2, step: 1,
      usage: { inputTokens: 150, outputTokens: 15 }, message: { source: { kind: 'model', provider: 'deepseek-official', model: 'deepseek-flash' }, content: [] } } },
    { seq: 5, time: 6, type: 'llm/retry-started', data: { turn: 2, step: 1 } },
    { seq: 6, time: 7, type: 'assistant/attempt', data: { turn: 2, step: 1,
      stream: attemptStream({ inputTokens: 200, outputTokens: 20 }, 7) } },
  ]
  const result = attributeOwnedSession(events, 2)
  assert.equal(result.attribution.mirrored.settledAttempts, 2)
  assert.equal(result.attribution.mirrored.retries, 1)
  assert.equal(result.attribution.mirrored.uncachedInput.sum, 350)
  assert.equal(result.attribution.mirrored.output.sum, 35)
  assert.equal(result.cost.requestTokens, 385)
})

test('team totals preserve a known subtotal and mark unreadable members and prices unknown', () => {
  const result = aggregateTeamUsage([
    { status: 'ready', totalTokens: 100, tokensPartial: false, referenceCost: 0.25, costPartial: false },
    { status: 'analysis-limit', totalTokens: null, tokensPartial: true, referenceCost: null, costPartial: true },
  ])
  assert.equal(result.knownTokens, 100)
  assert.equal(result.unknownMembers, 1)
  assert.equal(result.tokensPartial, true)
  assert.equal(result.shareBasis, 'known-subtotal')
  assert.equal(result.referenceCost, 0.25)
  assert.equal(result.costPartial, true)
})

test('summary coverage stays partial when earlier or uncorrelated compactions predate the ledger', () => {
  const stats = { since: 100, attempts: 1, unknownAttempts: 0, recent: [{ id: 'a', compactionId: 'new', startedAt: 120 }] }
  assert.equal(resolveSummaryCoverage([{ id: 'old', startedAt: 90 }, { id: 'new', startedAt: 120 }], stats), 'partial')
  assert.equal(resolveSummaryCoverage([{ id: 'new', startedAt: 120 }, { id: 'other', startedAt: 130 }], stats), 'partial')
})

test('summary coverage requires every attempt to remain attributable and known', () => {
  const compactions = [{ id: 'c1', startedAt: 120 }, { id: 'c2', startedAt: 140 }]
  const recent = [
    { id: 'a', compactionId: 'c1', startedAt: 121 },
    { id: 'b', compactionId: 'c2', startedAt: 141 },
  ]
  assert.equal(resolveSummaryCoverage(compactions, { since: 100, attempts: 2, unknownAttempts: 0, recent }), 'complete')
  assert.equal(resolveSummaryCoverage(compactions, { since: 100, attempts: 3, unknownAttempts: 0, recent }), 'partial')
  assert.equal(resolveSummaryCoverage(compactions, { since: 100, attempts: 2, unknownAttempts: 1, recent }), 'partial')
  assert.equal(resolveSummaryCoverage(compactions, undefined), 'unknown')
})
