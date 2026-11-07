import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Context } from '@deepseek-ai/cordis'
import { SessionId } from '@deepseek-ai/dsh-session'
import Inspector from '../lib/inspector.js'

const header = (id, parentSession) => ({ id, ...(parentSession ? { parentSession } : {}) })
const event = (seq, time, type, data, surfaceOp) => ({ seq, time, type, data, ...(surfaceOp ? { surfaceOp } : {}) })
const usageEvents = [
  event(0, 10, 'request/header', { header: { config: { provider: 'custom', model: 'inherited' } } }),
  event(1, 11, 'assistant/message', { turn: 1, step: 1, usage: { inputTokens: 900, outputTokens: 90 }, message: { source: { kind: 'model', provider: 'custom', model: 'inherited' }, content: [] } }, 'append'),
  event(2, 101, 'compaction/start', { compactionId: 'old-compaction', turn: null }),
  event(3, 102, 'request/header', { header: { config: { provider: 'deepseek-official', model: 'deepseek-flash' } } }),
  event(4, 103, 'assistant/message', { turn: 2, step: 1, usage: { inputTokens: 100, cacheReadTokens: 10, cacheWriteTokens: 5, outputTokens: 20 },
    message: { source: { kind: 'model', provider: 'deepseek-official', model: 'deepseek-flash' }, content: [] } }, 'append'),
]

async function createService(t, { trace, observe, summaryLedger } = {}) {
  const ctx = new Context()
  const reads = []
  let disposed = 0
  ctx.provide('contextManager', { summaryLedger })
  ctx.provide('sessions', { messageProjections: [] })
  ctx.provide('sessionProjections', { restore: () => ({ snapshot: { values: {} }, checkpoint: {} }) })
  ctx.provide('sessionQuery', {
    async traceSession(id) { return trace(String(id)) },
    async observeSession(id, options) {
      reads.push({ sessionId: String(id), projectionMode: options.projectionMode })
      const result = await observe(String(id), options)
      return { ...result, [Symbol.dispose]() { disposed++ } }
    },
  })
  await ctx.plugin(Inspector)
  t.after(() => ctx.fiber.dispose())
  return { api: ctx.contextInspector, reads, get disposed() { return disposed } }
}

test('team usage uses roster plus lineage, excludes inherited member events, and reports summary coverage gaps', async t => {
  const members = [
    { id: 'root', name: 'Lead', role: 'lead', phase: 'active' },
    { id: 'worker', name: 'Worker', role: 'teammate', phase: 'failed' },
  ]
  const team = await createService(t, {
    trace: id => ({ target: { header: header(id, id === 'worker' ? 'root' : undefined) }, ancestors: id === 'worker' ? [{ header: header('root') }] : [] }),
    observe: async (id, options) => ({
      cursor: id === 'worker' ? 4 : -1,
      header: header(id, id === 'worker' ? 'root' : undefined),
      inheritedEventCount: id === 'worker' ? 2 : 0,
      events: id === 'worker' ? usageEvents : [],
      projections: options.projectionMode === 'all' ? { values: { agentTeam: { members } } } : undefined,
    }),
    summaryLedger: { stats: id => id === 'worker' ? {
      since: 200, input: 50, output: 5, cacheRead: 2, cacheWrite: 3, attempts: 1, unknownAttempts: 0,
      recent: [{ id: 'attempt', compactionId: 'old-compaction', startedAt: 100, status: 'generated', input: 50, output: 5, cacheRead: 2, cacheWrite: 3 }],
    } : undefined },
  })
  const result = await team.api.teamUsage({ sessionId: 'worker' }, new AbortController().signal)
  const worker = result.members.find(member => member.sessionId === 'worker')
  assert.equal(result.status, 'ready')
  assert.equal(result.members.length, 2)
  assert.equal(worker.requestTokens, 135, 'the inherited 1,000-token call is omitted')
  assert.deepEqual([worker.uncachedInput.sum, worker.cacheRead.sum, worker.cacheWrite.sum, worker.output.sum], [100, 10, 5, 20])
  assert.equal(worker.summaryTokens, 55)
  assert.equal(worker.summaryCoverage, 'partial', 'pre-ledger compaction use stays partial')
  assert.equal(worker.totalTokens, 190)
  assert.equal(worker.tokensPartial, true)
  assert.deepEqual(team.reads, [
    { sessionId: 'worker', projectionMode: 'all' },
    { sessionId: 'root', projectionMode: 'all' },
    { sessionId: 'worker', projectionMode: 'none' },
  ])
  assert.equal(team.disposed, 3)
})

test('lead-only rosters and unlisted ordinary forks do not produce a team total', async t => {
  const rootMembers = [
    { id: 'root', name: 'Lead', role: 'lead', phase: 'active' },
    { id: 'actual-worker', name: 'Worker', role: 'teammate', phase: 'active' },
  ]
  const service = await createService(t, {
    trace: id => ({ target: { header: header(id, id === 'fork' ? 'root' : undefined) }, ancestors: id === 'fork' ? [{ header: header('root') }] : [] }),
    observe: async id => ({ cursor: 0, header: header(id), inheritedEventCount: 0, events: [], projections: { values: { agentTeam: { members: id === 'root' ? [rootMembers[0]] : rootMembers } } } }),
  })
  const leadOnly = await service.api.teamUsage({ sessionId: 'root' }, new AbortController().signal)
  assert.equal(leadOnly.status, 'not-team')
  assert.deepEqual(leadOnly.members, [])
  const fork = await service.api.teamUsage({ sessionId: 'fork' }, new AbortController().signal)
  assert.equal(fork.status, 'not-team')
  assert.equal(fork.knownTokens, 0)
  assert.deepEqual(service.reads.filter(row => row.sessionId === 'fork'), [{ sessionId: 'fork', projectionMode: 'all' }], 'the fork roster is checked, but its usage never becomes a team total')
})

test('a team created from an ordinary parent is found on the target roster', async t => {
  const members = [
    { id: 'new-lead', name: 'New lead', role: 'lead', phase: 'active' },
    { id: 'new-worker', name: 'Worker', role: 'teammate', phase: 'active' },
  ]
  const service = await createService(t, {
    trace: id => id === 'new-lead'
      ? { target: { header: header(id, 'ordinary-parent') }, ancestors: [{ header: header('ordinary-parent') }] }
      : { target: { header: header(id, 'new-lead') }, ancestors: [{ header: header('new-lead') }, { header: header('ordinary-parent') }] },
    observe: async (id, options) => ({
      cursor: 0, header: header(id, id === 'new-lead' ? 'ordinary-parent' : id === 'new-worker' ? 'new-lead' : undefined),
      inheritedEventCount: 0, events: [],
      projections: options.projectionMode === 'all'
        ? { values: { ...(id === 'new-lead' ? { agentTeam: { members } } : {}) } }
        : undefined,
    }),
  })
  const result = await service.api.teamUsage({ sessionId: 'new-lead' }, new AbortController().signal)
  assert.equal(result.status, 'ready')
  assert.equal(result.teamId, 'new-lead')
  assert.deepEqual(service.reads, [
    { sessionId: 'new-lead', projectionMode: 'all' },
    { sessionId: 'new-worker', projectionMode: 'none' },
  ])
  assert.equal(service.disposed, 2)
})

test('missing or malformed target rosters stay unavailable instead of claiming no team', async t => {
  const service = await createService(t, {
    trace: id => ({ target: { header: header(id) }, ancestors: [] }),
    observe: async id => ({ cursor: 0, header: header(id), inheritedEventCount: 0, events: [], projections: {
      values: id === 'malformed' ? { agentTeam: { members: [{ id: 'bad', name: 'Bad', role: 'unknown', phase: 'active' }] } } : {},
    } }),
  })
  const missing = await service.api.teamUsage({ sessionId: 'missing' }, new AbortController().signal)
  const malformed = await service.api.teamUsage({ sessionId: 'malformed' }, new AbortController().signal)
  assert.equal(missing.status, 'unavailable')
  assert.equal(malformed.status, 'unavailable')
})

test('an observation resolving after cancellation is disposed immediately', async t => {
  let release
  let started
  const entered = new Promise(resolve => { started = resolve })
  const service = await createService(t, {
    trace: id => ({ target: { header: header(id) }, ancestors: [] }),
    observe: () => new Promise(resolve => { release = resolve; started() }),
  })
  const controller = new AbortController()
  const request = service.api.teamUsage({ sessionId: 'root' }, controller.signal)
  await entered
  controller.abort()
  release({ cursor: 0, header: header('root'), inheritedEventCount: 0, events: [], projections: { values: { agentTeam: { members: [{ id: 'root', name: 'Lead', role: 'lead', phase: 'active' }] } } } })
  await assert.rejects(request)
  assert.equal(service.disposed, 1)
})
