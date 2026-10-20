import test from 'node:test'
import assert from 'node:assert/strict'
import { build } from 'esbuild'

const resolver = [{ name: 'resolve-runtime-dependencies', setup(builder) {
  builder.onResolve({ filter: /^[^./]/ }, args => ({ path: import.meta.resolve(args.path), external: true }))
} }]
const compiled = await build({ entryPoints: ['src/efficiency.ts', 'src/session-cost.ts', 'src/inspector-wire.ts'], outdir: '.build/session-cost-tests', bundle: true, write: false,
  platform: 'node', format: 'esm', target: 'es2022', packages: 'external', plugins: resolver })
const modules = new Map()
for (const file of compiled.outputFiles) {
  const name = file.path.split('/').at(-1)
  modules.set(name, await import(`data:text/javascript;base64,${Buffer.from(file.text).toString('base64')}`))
}
const { attributeSession } = modules.get('efficiency.js')
const { estimateSessionCost } = modules.get('session-cost.js')
const { sessionUsageQuerySchema, sessionUsageReadoutSchema, TYPERT_REMOTE } = modules.get('inspector-wire.js')

const peak = Date.parse('2026-09-28T01:00:00Z')
const offpeak = Date.parse('2026-09-27T02:00:00Z')
const header = (seq, time, provider = 'deepseek-official', model = 'deepseek-flash') => ({ seq, time, type: 'request/header', surfaceOp: 'append',
  data: { header: { config: { provider, model }, tools: [] } } })
const message = (seq, time, turn, step, usage, route = {}) => ({ seq, time, type: 'assistant/message', surfaceOp: 'append',
  data: { turn, step, usage, message: { source: { kind: 'model', ...route }, content: [{ type: 'text', text: 'synthetic fixture only' }] } } })
const attribution = (events, options) => attributeSession(events, { fingerprint: false, ...options })

test('empty sessions stay empty, while reported zero usage stays a real zero', () => {
  const empty = estimateSessionCost(attribution([]))
  assert.equal(empty.hasRecords, false)
  assert.equal(empty.total, null)
  const zero = estimateSessionCost(attribution([
    header(0, peak), message(1, peak, 1, 1, { inputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 0 },
      { provider: 'deepseek-official', model: 'deepseek-flash' }),
  ]))
  assert.equal(zero.hasRecords, true)
  assert.equal(zero.requestTokens, 0)
  assert.equal(zero.total, 0)
  assert.equal(zero.partial, false)
})

test('prices mixed peak/offpeak records by each historical model and disjoint token bucket', () => {
  const value = estimateSessionCost(attribution([
    header(0, peak, 'deepseek-official', 'deepseek-flash'),
    message(1, peak, 1, 1, { inputTokens: 1_000_000, cacheReadTokens: 1_000_000, cacheWriteTokens: 0, outputTokens: 1_000_000 },
      { provider: 'deepseek-official', model: 'deepseek-flash' }),
    header(2, offpeak, 'deepseek-account', 'deepseek-v4-pro'),
    message(3, offpeak, 2, 1, { inputTokens: 1_000_000, cacheReadTokens: 2_000_000, cacheWriteTokens: 0, outputTokens: 1_000_000 },
      { provider: 'deepseek-account', model: 'deepseek-v4-pro' }),
  ]))
  assert.equal(value.requestTokens, 7_000_000)
  assert.equal(value.peak, 10.04)
  assert.equal(value.offpeak, 18.3)
  assert.equal(value.total, 28.34)
  assert.equal(value.partial, false)
})

test('same turn and step replace unless a retry boundary closes the prior settlement', () => {
  const events = [
    header(0, peak),
    message(1, peak, 1, 1, { inputTokens: 100, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 10 },
      { provider: 'deepseek-official', model: 'deepseek-flash' }),
    message(2, peak, 1, 1, { inputTokens: 200, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 20 },
      { provider: 'deepseek-official', model: 'deepseek-flash' }),
    { seq: 3, time: peak, type: 'llm/retry-started', data: { turn: 1, step: 1 } },
    message(4, peak, 1, 1, { inputTokens: 300, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 30 },
      { provider: 'deepseek-official', model: 'deepseek-flash' }),
  ]
  const folded = attribution(events)
  const value = estimateSessionCost(folded)
  assert.equal(folded.mirrored.settledAttempts, 2)
  assert.equal(folded.mirrored.retries, 1)
  assert.equal(folded.mirrored.uncachedInput.sum, 500)
  assert.equal(folded.requests.length, 2)
  assert.equal(value.requestTokens, 550)
})

test('more than 200 settlements contribute to totals and cost', () => {
  const events = []
  for (let index = 0; index < 251; index++) {
    const seq = index * 2
    events.push(header(seq, offpeak))
    events.push(message(seq + 1, offpeak, index + 1, 1,
      { inputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 1 },
      { provider: 'deepseek-official', model: 'deepseek-flash' }))
  }
  const folded = attribution(events)
  const value = estimateSessionCost(folded)
  assert.equal(folded.requests.length, 200, 'request detail remains bounded')
  assert.equal(folded.mirrored.settledAttempts, 251)
  assert.equal(folded.mirrored.uncachedInput.sum, 251)
  assert.equal(value.requestTokens, 502)
  assert.equal(value.total, 0.001255)
})

test('partial, completely missing and unknown route or time usage never become a complete zero', () => {
  const partial = estimateSessionCost(attribution([
    header(0, peak), message(1, peak, 1, 1, { inputTokens: 100 }, { provider: 'deepseek-official', model: 'deepseek-flash' }),
  ]))
  assert.equal(partial.total, 0.0002)
  assert.equal(partial.partial, true)
  assert.ok(partial.issues.includes('missing-usage'))
  assert.ok(partial.issues.includes('cache-write'))

  const unknown = estimateSessionCost(attribution([
    header(0, peak), message(1, peak, 1, 1, {}, { provider: 'deepseek-official', model: 'deepseek-flash' }),
  ]))
  assert.equal(unknown.hasRecords, true)
  assert.equal(unknown.total, null, 'all-missing usage cannot render as ¥0')
  assert.equal(unknown.partial, true)

  const cacheWriteOnly = estimateSessionCost(attribution([
    header(0, peak), message(1, peak, 1, 1, { cacheWriteTokens: 100 }, { provider: 'deepseek-official', model: 'deepseek-flash' }),
  ]))
  assert.equal(cacheWriteOnly.requestTokens, 100)
  assert.equal(cacheWriteOnly.total, null, 'cache-write-only usage has no supported priceable bucket')
  assert.ok(cacheWriteOnly.issues.includes('cache-write'))

  const unsupported = estimateSessionCost(attribution([
    header(0, peak, 'third-party', 'deepseek-flash'),
    message(1, peak, 1, 1, { inputTokens: 100, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 10 },
      { provider: 'third-party', model: 'deepseek-flash' }),
  ]))
  assert.equal(unsupported.total, null)
  assert.ok(unsupported.issues.includes('unknown-route'))

  const future = estimateSessionCost(attribution([
    header(0, Date.parse('2027-01-04T01:00:00Z')),
    message(1, Date.parse('2027-01-04T01:00:00Z'), 1, 1, { inputTokens: 100, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 10 },
      { provider: 'deepseek-official', model: 'deepseek-flash' }),
  ]))
  assert.equal(future.total, null)
  assert.ok(future.issues.includes('unknown-period'))
})

test('summary usage stays separately visible, cache-inclusive input is not added twice, and overlap is excluded', () => {
  const summary = estimateSessionCost(attribution([], { summary: {
    source: 'summary-ledger', input: 1000, output: 40, cacheRead: 700, cacheWrite: 20, attempts: 2, unknownAttempts: 1,
  } }))
  assert.equal(summary.hasRecords, true)
  assert.equal(summary.requestTokens, 0)
  assert.equal(summary.summary.tokens, 1040)
  assert.equal(summary.total, null)
  assert.ok(summary.issues.includes('summary-unpriced'))

  const overlap = estimateSessionCost(attribution([
    { seq: 0, time: peak, type: 'compaction/start', data: { compactionId: 'synthetic', turn: 1 } },
    header(1, peak),
    message(2, peak, 1, 1, { inputTokens: 1000, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 100 },
      { provider: 'deepseek-official', model: 'deepseek-flash' }),
    { seq: 3, time: peak, type: 'compaction/end', data: { compactionId: 'synthetic' } },
  ]))
  assert.equal(overlap.total, null)
  assert.ok(overlap.issues.includes('maintenance-overlap'))
})

test('nonzero Host totals remain visible when event details are absent', () => {
  const value = estimateSessionCost(attribution([], { host: {
    source: 'host-token-usage', uncachedInputTokens: 321, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 45,
  } }))
  assert.equal(value.hasRecords, true)
  assert.equal(value.requestTokens, 366)
  assert.equal(value.total, null)
  assert.equal(value.partial, true)
  assert.ok(value.issues.includes('missing-usage'))
})

test('fingerprint-disabled attribution does not inspect stored system-prompt text', () => {
  const privateBody = { seq: 0, time: peak, type: 'system/message', surfaceOp: 'append',
    data: { message: Object.defineProperty({}, 'content', { get() { throw new Error('private body was read') } }) } }
  const folded = attributeSession([privateBody], { fingerprint: false })
  assert.equal(folded.fingerprint, null)
  assert.deepEqual(folded.costUsage, [])
})

test('session usage remote schema is strict and registers the supported status', () => {
  const query = sessionUsageQuerySchema().parse({ sessionId: 'synthetic-session' })
  assert.equal(query.sessionId, 'synthetic-session')
  assert.throws(() => sessionUsageQuerySchema().parse({ sessionId: 'synthetic-session', includeBodies: true }))
  const limited = { sessionId: 'synthetic-session', sampledAt: 100, status: 'analysis-limit', hasRecords: true,
    settledAttempts: 0, retries: 0, requestTokens: 500, requestTokensPartial: false, summary: null,
    peak: null, offpeak: null, total: null, partial: true, issues: ['missing-usage'] }
  assert.equal(sessionUsageReadoutSchema().parse(limited).status, 'analysis-limit')
  assert.ok(TYPERT_REMOTE.descriptors.some(item => item.service === 'contextInspector' && item.method === 'sessionUsage'))
})
