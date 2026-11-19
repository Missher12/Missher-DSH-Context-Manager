import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Context } from '@deepseek-ai/cordis'
import { SessionId } from '@deepseek-ai/dsh-session'
import Inspector from '../lib/inspector.js'
import { TYPERT } from '../lib/typert.js'

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

test('current Host Team mode uses its direct subagent catalog and counts each owned request once', async t => {
  const time = Date.parse('2026-11-18T02:00:00Z')
  const settled = (seq, turn, usage) => event(seq, time + seq, 'assistant/message', {
    turn, step: 1, usage,
    message: { source: { kind: 'model', provider: 'deepseek-official', model: 'deepseek-flash' }, content: [] },
  }, 'append')
  const lead = settled(0, 1, { inputTokens: 800, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 200 })
  const worker = settled(1, 2, { inputTokens: 100, cacheReadTokens: 10, cacheWriteTokens: 5, outputTokens: 20 })
  const child = id => id === 'worker' || id === 'ordinary-fork'
  const service = await createService(t, {
    trace: id => ({
      target: { header: header(id, child(id) ? 'root' : undefined) },
      ancestors: child(id) ? [{ header: header('root') }] : [],
    }),
    observe: async (id, options) => {
      assert.notEqual(id, 'external-run', 'external members have no local session log')
      return {
        cursor: id === 'worker' ? 1 : 0,
        header: header(id, child(id) ? 'root' : undefined),
        inheritedEventCount: child(id) ? 1 : 0,
        events: id === 'worker' ? [lead, worker] : [lead],
        projections: options.projectionMode === 'all' ? { values: {
          agentTeam: { enabled: id === 'root', tasks: [] },
          subagentCatalog: id === 'root' ? [
            { id: 'worker', name: 'reviewer', label: 'Review', mode: 'continuable', createdAt: time },
            { id: 'external-run', name: 'external', mode: 'external', createdAt: time },
          ] : [],
        } } : undefined,
      }
    },
  })
  for (const sessionId of ['root', 'worker']) {
    const result = await service.api.teamUsage({ sessionId }, new AbortController().signal)
    assert.equal(result.status, 'ready')
    assert.equal(result.teamId, 'root')
    assert.deepEqual(result.members.map(row => [row.sessionId, row.requestTokens, row.status]), [
      ['root', 1000, 'ready'], ['worker', 135, 'ready'], ['external-run', null, 'unavailable'],
    ])
    assert.equal(result.knownTokens, 1135)
    assert.equal(result.unknownMembers, 1)
    assert.equal(result.costPartial, true)
    assert.ok(Math.abs(result.referenceCost - 0.0035604) < 1e-12)
  }
  const fork = await service.api.teamUsage({ sessionId: 'ordinary-fork' }, new AbortController().signal)
  assert.equal(fork.status, 'not-team')
})

test('team request details carry only each member’s recent owned business settlements through the wire', async t => {
  const members = [
    { id: 'root', name: 'Lead', role: 'lead', phase: 'active' },
    ...['worker', 'peer', 'empty', 'unreadable'].map(id => ({ id, name: id, role: 'teammate', phase: 'active' })),
  ]
  const settled = (seq, turn, usage) => event(seq, 1_000 + seq, 'assistant/message', {
    turn, step: 1, usage, message: { source: { kind: 'model', provider: 'fixture', model: 'fixed' },
      content: [{ type: 'text', text: 'private fixture text' }] },
  }, 'append')
  const lead = settled(0, 1, { inputTokens: 80, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 20 })
  const workerEvents = [lead, ...Array.from({ length: 9 }, (_, i) => settled(i + 1, i + 2,
    { inputTokens: 2_000 + i, cacheReadTokens: 3_000, outputTokens: 40 })),
    event(10, 1_010, 'compaction/start', { compactionId: 'numbered', turn: 11 }),
    settled(11, 11, { inputTokens: 50_000, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 50 }),
    event(12, 1_012, 'compaction/end', { compactionId: 'numbered' })]
  const service = await createService(t, {
    trace: id => ({ target: { header: header(id) }, ancestors: [] }),
    observe: async (id, { projectionMode }) => {
      if (id === 'unreadable') throw new Error('no log')
      const events = id === 'worker' ? workerEvents : id === 'peer' ? [lead, settled(1, 2, { inputTokens: 30, outputTokens: 9 })] : [lead]
      return { cursor: events.at(-1).seq, header: header(id, id !== 'root' ? 'root' : undefined), events,
        inheritedEventCount: id === 'root' ? 0 : 1,
        projections: projectionMode === 'all' ? { values: { agentTeam: { members } } } : undefined }
    },
    summaryLedger: { stats: id => id === 'worker' ? { since: 1, input: 55_000, output: 120, attempts: 1, unknownAttempts: 0, recent: [] } : undefined },
  })
  const result = await service.api.teamUsage({ sessionId: 'root' }, new AbortController().signal)
  const codec = TYPERT.invocations.find(item => item.method === 'teamUsage').result.create()
  const readout = codec.parse(JSON.parse(JSON.stringify(result)))
  const [root, worker, peer, empty, unreadable] = readout.members
  assert.deepEqual(root.recentRequests, [{ seq: 0, time: 1_000, uncachedInput: 80, cacheRead: 0, cacheWrite: 0, output: 20 }])
  assert.deepEqual(worker.recentRequests.map(row => row.seq), [9, 8, 7, 6, 5, 4, 3, 2])
  assert.deepEqual(worker.recentRequests[0], { seq: 9, time: 1_009, uncachedInput: 2_008, cacheRead: 3_000, cacheWrite: null, output: 40 })
  assert.deepEqual(peer.recentRequests, [{ seq: 1, time: 1_001, uncachedInput: 30, cacheRead: null, cacheWrite: null, output: 9 }])
  assert.deepEqual(empty.recentRequests, [])
  assert.equal(unreadable.status, 'unavailable')
  assert.equal(unreadable.recentRequests, undefined)
  assert.equal(worker.maintenanceSuspects, 1)
  assert.equal(worker.summaryTokens, 55_120)
  assert.ok(!JSON.stringify(readout).includes('private fixture text'))
  const old = JSON.parse(JSON.stringify(readout))
  delete old.members[0].recentRequests
  assert.equal(codec.parse(old).members[0].recentRequests, undefined)
  assert.equal(codec.safeParse({ ...readout, members: [{ ...root, recentRequests: [...worker.recentRequests, root.recentRequests[0]] }] }).success, false)
})

test('a newer Host restores the last historical member state without counting inherited roster events', async t => {
  const archived = (seq, id, phase) => event(seq, seq + 10, 'team/member', {
    version: 2, teamId: 'root', member: { id, name: 'archived review', phase },
  })
  const service = await createService(t, {
    trace: id => ({ target: { header: header(id) }, ancestors: [] }),
    observe: async (id, options) => ({
      header: header(id, id === 'archived' ? 'root' : undefined),
      cursor: id === 'root' ? 2 : -1,
      inheritedEventCount: id === 'root' ? 1 : 0,
      events: id === 'root' ? [archived(0, 'inherited', 'active'), archived(1, 'archived', 'provisioning'),
        archived(2, 'archived', 'failed')] : [],
      projections: options.projectionMode === 'all' ? { values: {
        agentTeam: { enabled: false, tasks: [] }, subagentCatalog: [],
      } } : undefined,
    }),
  })
  const result = await service.api.teamUsage({ sessionId: 'root' }, new AbortController().signal)
  assert.equal(result.status, 'ready')
  assert.deepEqual(result.members.map(row => [row.sessionId, row.phase]), [['root', 'active'], ['archived', 'failed']])
})

test('current Host without an enabled Team excludes ordinary subagents and missing enabled catalogs stay unknown', async t => {
  const service = await createService(t, {
    trace: id => ({ target: { header: header(id) }, ancestors: [] }),
    observe: async id => ({
      cursor: -1, header: header(id), inheritedEventCount: 0, events: [],
      projections: { values: id === 'disabled'
        ? { agentTeam: { enabled: false, tasks: [] }, subagentCatalog: [{ id: 'ordinary-child', label: 'Work', mode: 'continuable', createdAt: 1 }] }
        : { agentTeam: { enabled: true, tasks: [] } } },
    }),
  })
  const ordinary = await service.api.teamUsage({ sessionId: 'disabled' }, new AbortController().signal)
  assert.equal(ordinary.status, 'not-team')
  assert.deepEqual(ordinary.members, [])
  const missing = await service.api.teamUsage({ sessionId: 'no-catalog' }, new AbortController().signal)
  assert.equal(missing.status, 'unavailable')
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
