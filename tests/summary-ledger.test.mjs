import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'
import { Context } from '@deepseek-ai/cordis'
import Storage from '@deepseek-ai/dsh-storage'
import { DomainFacility } from '@deepseek-ai/dsh-storage-domain'
import { JsonStorageBackend } from '@deepseek-ai/dsh-storage-json'

// Compile the helper in memory without rebuilding the daily-linked root lib.
const compiled = await build({
  entryPoints: [fileURLToPath(new URL('../src/summary-ledger.ts', import.meta.url))],
  bundle: true, write: false, platform: 'node', format: 'esm', target: 'es2022',
  tsconfigRaw: { compilerOptions: { target: 'ES2022' } },
  plugins: [{ name: 'installed-public-api', setup(builder) {
    builder.onResolve({ filter: /^[^./]/ }, args => ({ path: import.meta.resolve(args.path), external: true }))
  } }],
})
const { SummaryLedger } = await import(`data:text/javascript;base64,${Buffer.from(`${compiled.outputFiles[0].text}\n//# sourceURL=summary-ledger-test.js`).toString('base64')}`)

const sessionId = 'summary-accounting-subject'
const counters = stats => ({ input: stats.input, output: stats.output, cacheRead: stats.cacheRead,
  cacheWrite: stats.cacheWrite, attempts: stats.attempts, unknownAttempts: stats.unknownAttempts })
const zero = () => ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, attempts: 0, unknownAttempts: 0 })
const settledFixture = (index, usage) => ({
  id: `fixture-${index}`, compactionId: `compaction-${index}`, trigger: 'pressure',
  startedAt: 1000 + index, endedAt: 1000 + index, status: ['generated', 'failed', 'cancelled'][index % 3],
  input: usage ? usage.inputTokens + (usage.cacheReadTokens ?? 0) + (usage.cacheWriteTokens ?? 0) : null,
  output: usage?.outputTokens ?? null, cacheRead: usage?.cacheReadTokens ?? 0, cacheWrite: usage?.cacheWriteTokens ?? 0,
})
const startedFixture = index => ({ id: `fixture-${index}`, compactionId: `compaction-${index}`, trigger: 'idle',
  startedAt: 1000 + index, status: 'started', input: null, output: null, cacheRead: null, cacheWrite: null })

async function harness(t) {
  const root = await mkdtemp(join(tmpdir(), 'dsh-context-summary-ledger-'))
  const active = new Set()
  async function boot() {
    const ctx = new Context()
    await ctx.plugin(Storage)
    const backend = new JsonStorageBackend(root)
    ctx.storage.backend.register('json', backend)
    const facility = new DomainFacility(ctx, { backend: 'json' })
    ctx.storage.mount('domain', facility)
    let table
    const ledger = await SummaryLedger.open({ async open(spec) {
      const domain = await facility.open(spec)
      table = domain.table('sessions')
      return domain
    } })
    // Boundary fixtures enter through the real schema-validating Domain, so
    // tests exercise rollover without hundreds of unrelated fsync operations.
    const seed = recent => table.put(sessionId, { sessionId, since: 1000, archived: zero(), recent })
    const runtime = { ctx, backend, facility, ledger, seed }
    active.add(runtime)
    return runtime
  }
  async function stop(runtime) {
    await runtime.ledger.close()
    await runtime.facility.closeAll()
    await runtime.backend.close()
    await runtime.ctx.fiber.dispose()
    active.delete(runtime)
  }
  t.after(async () => {
    try { for (const runtime of active) await stop(runtime) }
    finally { await rm(root, { recursive: true, force: true }) }
  })
  async function saved() {
    const files = (await readdir(root)).filter(name => name.endsWith('.json'))
    assert.equal(files.length, 1, 'the fixture owns exactly one real domain file')
    return JSON.parse(await readFile(join(root, files[0]), 'utf8')).tables.sessions[sessionId]
  }
  return { boot, stop, saved }
}

test('summary ledger: failed and cancelled attempts retain known provider usage independently of commits', async t => {
  const { boot } = await harness(t)
  const { ledger } = await boot()
  assert.equal(ledger.stats(sessionId), undefined)
  const attempts = [
    ['failed', 'pressure', { inputTokens: 100, outputTokens: 11, cacheReadTokens: 20, cacheWriteTokens: 3 }],
    ['cancelled', 'idle', { inputTokens: 40, outputTokens: 5, cacheReadTokens: 4, cacheWriteTokens: 1 }],
    ['generated', 'manual', { inputTokens: 70, outputTokens: 7 }],
  ]
  for (const [status, trigger, usage] of attempts) {
    const id = await ledger.start(sessionId, `compaction-${status}`, trigger)
    await ledger.finish(sessionId, id, status, usage)
  }
  const stats = ledger.stats(sessionId)
  assert.deepEqual(counters(stats), { input: 238, output: 23, cacheRead: 24, cacheWrite: 4, attempts: 3, unknownAttempts: 0 })
  assert.deepEqual(stats.recent.map(item => item.status), ['failed', 'cancelled', 'generated'])
  assert.deepEqual(stats.recent.map(item => item.trigger), ['pressure', 'idle', 'manual'])
  stats.recent[0].input = 99999
  assert.equal(ledger.stats(sessionId).recent[0].input, 123, 'inspection returns detached data')
})

test('summary ledger: absent or incomplete usage remains explicitly unknown, including interrupted starts', async t => {
  const { boot } = await harness(t)
  const { ledger } = await boot()
  const failed = await ledger.start(sessionId, 'failed-without-usage', 'overflow')
  await ledger.finish(sessionId, failed, 'failed')
  const cancelled = await ledger.start(sessionId, 'cancelled-without-usage', 'idle')
  await ledger.finish(sessionId, cancelled, 'cancelled')
  const started = await ledger.start(sessionId, 'unfinished-at-restart', 'manual')
  assert.deepEqual(counters(ledger.stats(sessionId)), { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, attempts: 3, unknownAttempts: 3 })
  assert.ok(ledger.stats(sessionId).recent.every(item => item.input === null && item.output === null))
  await ledger.finish(sessionId, started, 'failed', { inputTokens: 12 })
  const partial = ledger.stats(sessionId).recent.find(item => item.id === started)
  assert.equal(partial.input, 12)
  assert.equal(partial.output, null)
  assert.equal(ledger.stats(sessionId).unknownAttempts, 3, 'one known field cannot imply that all usage is known')
})

test('summary ledger: repeated and concurrent finish notifications never add usage twice', async t => {
  const { boot } = await harness(t)
  const { ledger } = await boot()
  const id = await ledger.start(sessionId, 'one-compaction', 'pressure')
  await ledger.finish(sessionId, id, 'failed', { inputTokens: 10, outputTokens: 2, cacheReadTokens: 3 })
  const first = ledger.stats(sessionId)
  await Promise.all([
    ledger.finish(sessionId, id, 'generated', { inputTokens: 999, outputTokens: 999 }),
    ledger.finish(sessionId, id, 'cancelled'),
    ledger.finish(sessionId, id, 'failed', { inputTokens: 10, outputTokens: 2, cacheReadTokens: 3 }),
  ])
  assert.deepEqual(ledger.stats(sessionId), first)
  assert.deepEqual(counters(first), { input: 13, output: 2, cacheRead: 3, cacheWrite: 0, attempts: 1, unknownAttempts: 0 })
})

test('summary ledger: full storage teardown and reopen retain totals, unknown status and idempotence', async t => {
  const { boot, stop } = await harness(t)
  const first = await boot()
  const known = await first.ledger.start(sessionId, 'known', 'pressure')
  await first.ledger.finish(sessionId, known, 'failed', { inputTokens: 42, outputTokens: 6 })
  await first.ledger.start(sessionId, 'abandoned', 'idle')
  const before = first.ledger.stats(sessionId)
  await stop(first)
  const second = await boot()
  assert.notEqual(second.ctx, first.ctx)
  assert.deepEqual(second.ledger.stats(sessionId), before)
  await second.ledger.finish(sessionId, known, 'generated', { inputTokens: 999, outputTokens: 999 })
  assert.deepEqual(second.ledger.stats(sessionId), before)
  const next = await second.ledger.start(sessionId, 'next', 'manual')
  await second.ledger.finish(sessionId, next, 'cancelled', { inputTokens: 5, outputTokens: 1 })
  assert.deepEqual(counters(second.ledger.stats(sessionId)), { input: 47, output: 7, cacheRead: 0, cacheWrite: 0, attempts: 3, unknownAttempts: 1 })
  assert.equal(second.ledger.stats(sessionId).since, before.since)
})

test('summary ledger: crossing the 128-record boundary archives totals without dropping known or unknown usage', { timeout: 20000 }, async t => {
  const { boot, stop, saved } = await harness(t)
  const first = await boot()
  const expected = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, attempts: 132, unknownAttempts: 0 }
  const ids = []
  const fixtureRecords = []
  for (let index = 0; index < expected.attempts; index++) {
    const usage = index % 4 === 0 ? undefined : { inputTokens: index + 1, outputTokens: index % 7, cacheReadTokens: 2, cacheWriteTokens: 1 }
    if (index < 128) {
      const item = settledFixture(index, usage)
      fixtureRecords.push(item)
      ids.push(item.id)
    } else {
      if (index === 128) await first.seed(fixtureRecords)
      const id = await first.ledger.start(sessionId, `compaction-${index}`, ['idle', 'pressure', 'manual'][index % 3])
      ids.push(id)
      await first.ledger.finish(sessionId, id, ['generated', 'failed', 'cancelled'][index % 3], usage)
    }
    if (usage) {
      expected.input += usage.inputTokens + usage.cacheReadTokens + usage.cacheWriteTokens
      expected.output += usage.outputTokens
      expected.cacheRead += usage.cacheReadTokens
      expected.cacheWrite += usage.cacheWriteTokens
    } else expected.unknownAttempts++
  }
  const stats = first.ledger.stats(sessionId)
  assert.deepEqual(counters(stats), expected)
  assert.deepEqual(stats.recent.map(item => item.id), ids.slice(-32))
  const persisted = await saved()
  assert.equal(persisted.recent.length, 128)
  assert.equal(persisted.archived.attempts, 4)
  // Unknown-usage attempts stay in recent so late usage can still land.
  assert.equal(persisted.archived.unknownAttempts, 0)
  assert.equal(persisted.recent[0].id, ids[0])
  await stop(first)
  const reopened = await boot()
  assert.deepEqual(reopened.ledger.stats(sessionId), stats, 'archived counters survive an entirely new Context and storage backend')
})

test('summary ledger: archival retains the oldest unfinished attempt so late usage can replace unknown accounting', { timeout: 20000 }, async t => {
  const { boot, saved } = await harness(t)
  const { ledger, seed } = await boot()
  const waiting = startedFixture(0)
  await seed([waiting, ...Array.from({ length: 127 }, (_, index) => settledFixture(index + 1, { inputTokens: 2, outputTokens: 1, cacheReadTokens: 1, cacheWriteTokens: 1 }))])
  for (let index = 127; index < 129; index++) {
    const id = await ledger.start(sessionId, `settled-${index}`, 'manual')
    await ledger.finish(sessionId, id, 'generated', { inputTokens: 2, outputTokens: 1, cacheReadTokens: 1, cacheWriteTokens: 1 })
  }
  assert.deepEqual(counters(ledger.stats(sessionId)), { input: 516, output: 129, cacheRead: 129, cacheWrite: 129, attempts: 130, unknownAttempts: 1 })
  const persisted = await saved()
  assert.equal(persisted.recent.length, 128)
  assert.equal(persisted.recent.find(item => item.id === waiting.id)?.status, 'started')
  assert.equal(persisted.archived.attempts, 2)
  await ledger.finish(sessionId, waiting.id, 'cancelled', { inputTokens: 10, outputTokens: 4, cacheReadTokens: 2, cacheWriteTokens: 1 })
  assert.deepEqual(counters(ledger.stats(sessionId)), { input: 529, output: 133, cacheRead: 131, cacheWrite: 130, attempts: 130, unknownAttempts: 0 })
})

test('summary ledger: repeated finish remains a no-op after its record was archived and storage reopened', { timeout: 20000 }, async t => {
  const { boot, stop, saved } = await harness(t)
  const first = await boot()
  const records = Array.from({ length: 128 }, (_, index) => settledFixture(index, { inputTokens: 1, outputTokens: 1 }))
  await first.seed(records)
  const oldest = records[0].id
  const newest = await first.ledger.start(sessionId, 'settled-128', 'pressure')
  await first.ledger.finish(sessionId, newest, 'generated', { inputTokens: 1, outputTokens: 1 })
  assert.equal((await saved()).recent.some(item => item.id === oldest), false)
  const before = first.ledger.stats(sessionId)
  await first.ledger.finish(sessionId, oldest, 'cancelled', { inputTokens: 999, outputTokens: 999 })
  assert.deepEqual(first.ledger.stats(sessionId), before)
  await stop(first)
  const reopened = await boot()
  await reopened.ledger.finish(sessionId, oldest, 'failed')
  assert.deepEqual(reopened.ledger.stats(sessionId), before)
  assert.deepEqual(counters(before), { input: 129, output: 129, cacheRead: 0, cacheWrite: 0, attempts: 129, unknownAttempts: 0 })
})

test('summary ledger: 128 unfinished attempts reject further starts without losing records or poisoning the queue', { timeout: 20000 }, async t => {
  const { boot, saved } = await harness(t)
  const { ledger, seed } = await boot()
  const records = Array.from({ length: 128 }, (_, index) => startedFixture(index))
  await seed(records)
  const before = ledger.stats(sessionId)
  await assert.rejects(ledger.start(sessionId, 'refused-before-provider', 'idle'), /unsettled/i)
  assert.deepEqual(ledger.stats(sessionId), before)
  assert.equal((await saved()).recent.length, 128)
  assert.equal((await saved()).archived.attempts, 0)
  const release = ledger.retainUsage(records[0].id)
  await ledger.finish(sessionId, records[0].id, 'failed', { inputTokens: 3, outputTokens: 1 })
  release()
  await ledger.start(sessionId, 'accepted-after-settlement', 'idle')
  assert.deepEqual(counters(ledger.stats(sessionId)), { input: 3, output: 1, cacheRead: 0, cacheWrite: 0, attempts: 129, unknownAttempts: 128 })
})

test('summary ledger: partial late usage fills field by field, repeats never double-count and the status stays settled', async t => {
  const { boot } = await harness(t)
  const { ledger } = await boot()
  const id = await ledger.start(sessionId, 'compaction-partial', 'pressure')
  await ledger.finish(sessionId, id, 'cancelled')
  await ledger.recordUsage(sessionId, id, { inputTokens: 500, cacheReadTokens: 100 })
  await ledger.recordUsage(sessionId, id, { outputTokens: 40 })
  const stats = ledger.stats(sessionId)
  assert.deepEqual(counters(stats), { input: 600, output: 40, cacheRead: 100, cacheWrite: 0, attempts: 1, unknownAttempts: 0 })
  assert.equal(stats.recent[0].status, 'cancelled')
  await ledger.recordUsage(sessionId, id, { inputTokens: 500, cacheReadTokens: 100, outputTokens: 40 })
  await ledger.recordUsage(sessionId, id, { outputTokens: 999 })
  assert.deepEqual(counters(ledger.stats(sessionId)), { input: 600, output: 40, cacheRead: 100, cacheWrite: 0, attempts: 1, unknownAttempts: 0 })
})

test('summary ledger: usage recorded before finish survives the settle, in either notification order', async t => {
  const { boot } = await harness(t)
  const { ledger } = await boot()
  for (const order of ['usage-first', 'finish-first']) {
    const id = await ledger.start(sessionId, `compaction-${order}`, 'pressure')
    if (order === 'usage-first') await ledger.recordUsage(sessionId, id, { inputTokens: 500, cacheReadTokens: 100, outputTokens: 40 })
    await ledger.finish(sessionId, id, 'cancelled', order === 'finish-first' ? { outputTokens: 40 } : undefined)
    if (order === 'finish-first') await ledger.recordUsage(sessionId, id, { inputTokens: 500, cacheReadTokens: 100 })
    const stats = ledger.stats(sessionId)
    const row = stats.recent.find(item => item.id === id)
    assert.equal(row.status, 'cancelled')
    assert.equal(row.input, 600); assert.equal(row.output, 40)
    assert.equal(row.cacheRead, 100, 'cache components come from the first notification that establishes input')
  }
  const stats = ledger.stats(sessionId)
  assert.deepEqual(counters(stats), { input: 1200, output: 80, cacheRead: 200, cacheWrite: 0, attempts: 2, unknownAttempts: 0 })
})

test('summary ledger: cache components arriving before or after the billed input complete it exactly once', async t => {
  const { boot } = await harness(t)
  const { ledger } = await boot()
  const cacheFirst = await ledger.start(sessionId, 'compaction-cache-first', 'pressure')
  await ledger.finish(sessionId, cacheFirst, 'cancelled')
  await ledger.recordUsage(sessionId, cacheFirst, { cacheReadTokens: 100 })
  await ledger.recordUsage(sessionId, cacheFirst, { inputTokens: 500 })
  let row = ledger.stats(sessionId).recent.find(item => item.id === cacheFirst)
  assert.equal(row.input, 600, 'cache arriving first must complete the later billed input')
  assert.equal(row.cacheRead, 100)
  const inputFirst = await ledger.start(sessionId, 'compaction-cache-late', 'pressure')
  await ledger.finish(sessionId, inputFirst, 'cancelled')
  await ledger.recordUsage(sessionId, inputFirst, { inputTokens: 500, outputTokens: 40 })
  await ledger.recordUsage(sessionId, inputFirst, { cacheReadTokens: 100 })
  row = ledger.stats(sessionId).recent.find(item => item.id === inputFirst)
  assert.equal(row.input, 600, 'cache arriving later must adjust the billed input exactly once')
  assert.equal(row.output, 40); assert.equal(row.cacheRead, 100)
  await ledger.recordUsage(sessionId, inputFirst, { cacheReadTokens: 200 })
  assert.equal(ledger.stats(sessionId).recent.find(item => item.id === inputFirst).input, 600, 'a repeated cache notification never double-counts')
  const stats = ledger.stats(sessionId)
  assert.deepEqual(counters(stats), { input: 1200, output: 40, cacheRead: 200, cacheWrite: 0, attempts: 2, unknownAttempts: 1 }, 'the cache-first attempt never delivered output, so its usage stays partially unknown')
})

test('summary ledger: a settled attempt awaiting late usage is never archived and stays fillable', async t => {
  const { boot, saved } = await harness(t)
  const { ledger, seed } = await boot()
  const awaiting = { id: 'awaiting-late', compactionId: 'compaction-awaiting', trigger: 'pressure',
    startedAt: 1, endedAt: 2, status: 'cancelled', input: null, output: null, cacheRead: null, cacheWrite: null }
  await seed([awaiting, ...Array.from({ length: 127 }, (_, index) => settledFixture(index + 1, { inputTokens: 2, outputTokens: 1, cacheReadTokens: 1, cacheWriteTokens: 1 }))])
  const id = await ledger.start(sessionId, 'new-after-full', 'manual')
  await ledger.finish(sessionId, id, 'generated', { inputTokens: 2, outputTokens: 1 })
  const persisted = await saved()
  assert.ok(persisted.recent.some(item => item.id === 'awaiting-late'), 'an attempt awaiting late usage must never be archived')
  assert.equal(persisted.archived.attempts, 1, 'a fully known settled attempt takes the archive slot instead')
  const before = ledger.stats(sessionId)
  await ledger.recordUsage(sessionId, 'awaiting-late', { inputTokens: 500, cacheReadTokens: 100, outputTokens: 40 })
  const stats = ledger.stats(sessionId)
  assert.equal(stats.input, before.input + 600); assert.equal(stats.output, before.output + 40)
  assert.equal(stats.cacheRead, before.cacheRead + 100); assert.equal(stats.unknownAttempts, before.unknownAttempts - 1)
})

test('summary ledger: a full queue of settled but unknown attempts refuses new starts instead of losing late usage', async t => {
  const { boot } = await harness(t)
  const { ledger, seed } = await boot()
  const unknown = Array.from({ length: 128 }, (_, index) => ({ id: `unknown-${index}`, compactionId: `compaction-${index}`, trigger: 'pressure',
    startedAt: 1000 + index, endedAt: 2000 + index, status: 'cancelled', input: null, output: null, cacheRead: null, cacheWrite: null }))
  await seed(unknown)
  await assert.rejects(ledger.start(sessionId, 'refused-safe', 'manual'), /unsettled/i)
  await ledger.recordUsage(sessionId, 'unknown-3', { inputTokens: 500, cacheReadTokens: 100, outputTokens: 40 })
  const stats = ledger.stats(sessionId)
  assert.equal(stats.input, 600); assert.equal(stats.unknownAttempts, 127)
})
