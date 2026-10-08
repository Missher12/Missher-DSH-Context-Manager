import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, rename, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'
import { Context } from '@deepseek-ai/cordis'
import Storage from '@deepseek-ai/dsh-storage'
import { DomainFacility } from '@deepseek-ai/dsh-storage-domain'
import { JsonStorageBackend } from '@deepseek-ai/dsh-storage-json'

// Compile only this helper in memory; leave the daily-linked root lib intact.
const compiled = await build({
  entryPoints: [fileURLToPath(new URL('../src/idle-store.ts', import.meta.url))],
  bundle: true, write: false, platform: 'node', format: 'esm', target: 'es2022',
  tsconfigRaw: { compilerOptions: { target: 'ES2022' } },
  plugins: [{ name: 'installed-public-api', setup(builder) {
    builder.onResolve({ filter: /^[^./]/ }, args => ({ path: import.meta.resolve(args.path), external: true }))
  } }],
})
const { IdleStore, idleDomainSpec } = await import(`data:text/javascript;base64,${Buffer.from(`${compiled.outputFiles[0].text}\n//# sourceURL=idle-store-test.js`).toString('base64')}`)
const journalCompiled = await build({
  entryPoints: [fileURLToPath(new URL('../src/recovery-journal.ts', import.meta.url))],
  bundle: true, write: false, platform: 'node', format: 'esm', target: 'es2022',
  tsconfigRaw: { compilerOptions: { target: 'ES2022' } },
})
const { RecoveryJournal } = await import(`data:text/javascript;base64,${Buffer.from(journalCompiled.outputFiles[0].text).toString('base64')}`)

const eligibility = (sequence = 5, time = 1000, fingerprint = `event-${sequence}`) => ({
  sessionId: 'session-a', turnEndSeq: sequence, completedAt: time, fingerprint,
})

async function harness(t, options = {}) {
  const root = await mkdtemp(join(tmpdir(), 'dsh-context-idle-store-'))
  const ctx = new Context()
  await ctx.plugin(Storage)
  const backend = new JsonStorageBackend(root)
  ctx.storage.backend.register('json', backend)
  const facility = new DomainFacility(ctx, { backend: 'json' })
  ctx.storage.mount('domain', facility)
  const journalRoot = join(root, 'recovery')
  const journal = options.journal ? RecoveryJournal.open(journalRoot) : undefined
  const store = await IdleStore.open(options.wrap ? options.wrap(facility) : facility, journal)
  t.after(async () => {
    try {
      await store.close()
      await facility.closeAll()
      await backend.close()
      await ctx.fiber.dispose()
    } finally {
      try { journal?.close() } finally { await rm(root, { recursive: true, force: true }) }
    }
  })
  const path = join(root, `${idleDomainSpec.name}.json`)
  const saved = async () => JSON.parse(await readFile(path, 'utf8')).tables.sessions
  const pending = async () => JSON.parse(await readFile(join(journalRoot, 'pending.json'), 'utf8'))
  return { root, path, ctx, facility, backend, store, saved, journal, journalRoot, pending }
}

test('JSON domain persists latest eligibility and consumed attempts across two opens', async t => {
  const { store, facility, saved, path } = await harness(t)
  assert.equal(store.get('session-a'), undefined)
  await assert.rejects(readFile(path, 'utf8'), { code: 'ENOENT' })
  const first = eligibility()
  await store.reserve(first)
  await store.claim(first, 'attempt-1', 8000)
  await store.settle(first, 'attempt-1', { status: 'completed', compactionId: 'compact-1', afterTokens: 2500 })
  const completed = store.get(first.sessionId)
  assert.deepEqual((await saved())[first.sessionId], completed)
  await store.close()
  const reopened = await IdleStore.open(facility)
  try {
    assert.deepEqual(reopened.get(first.sessionId), completed)
    assert.deepEqual(await reopened.reserve(first), completed, 'replaying the same completion does not rearm it')
    assert.equal(await reopened.claim(first, 'attempt-2'), null)
    assert.equal(reopened.get('copied-session'), undefined, 'another session inherits no ledger eligibility')
  } finally { await reopened.close() }
})

test('concurrent claims have exactly one durable winner', async t => {
  const { store, saved } = await harness(t)
  const first = eligibility()
  await store.reserve(first)
  const results = await Promise.all(Array.from({ length: 12 }, (_, index) => store.claim(first, `attempt-${index}`, 9000)))
  const winners = results.filter(Boolean)
  assert.equal(winners.length, 1)
  assert.equal(winners[0].status, 'started')
  assert.deepEqual((await saved())[first.sessionId], winners[0], 'claim resolves only after JSON persistence')
  assert.deepEqual(store.get(first.sessionId), winners[0])
})

test('reopen keeps started transaction identity for explicit interrupted recovery', async t => {
  const { store, facility } = await harness(t)
  const first = eligibility()
  const eligible = await store.reserve(first)
  const claimed = await store.claim(eligible, 'attempt-1')
  const bound = await store.bindCompaction(claimed, 'attempt-1', 'compact-1')
  await store.close()
  const reopened = await IdleStore.open(facility)
  try {
    const recovered = reopened.get(first.sessionId)
    assert.deepEqual(recovered, bound)
    assert.equal(await reopened.claim(recovered, 'attempt-2'), null, 'recovery never silently retries started work')
    const interrupted = await reopened.settle(recovered, recovered.attemptId, { status: 'interrupted', reasonCode: 'restart' })
    assert.equal(interrupted.compactionId, 'compact-1')
    assert.deepEqual(await reopened.reserve(first), interrupted)
  } finally { await reopened.close() }
})

test('all returns an immutable metadata snapshot independent of later turns', async t => {
  const { store } = await harness(t)
  const first = eligibility()
  await store.reserve(first)
  await store.reserve({ ...first, sessionId: 'session-b' })
  const snapshot = store.all()
  assert.deepEqual(snapshot.map(record => record.sessionId).sort(), ['session-a', 'session-b'])
  assert.throws(() => { snapshot.push(first) }, TypeError)
  assert.throws(() => { snapshot[0].fingerprint = 'changed' }, TypeError)
  await store.claim(first, 'attempt-1')
  assert.equal(snapshot.find(record => record.sessionId === first.sessionId).status, 'eligible')
  assert.equal(store.all().find(record => record.sessionId === first.sessionId).status, 'started')
})

test('failed durable claim leaves eligible memory and disk unchanged and the queue usable', async t => {
  const { store, path, saved } = await harness(t)
  const first = eligibility()
  const original = await store.reserve(first)
  const backup = `${path}.fixture-backup`
  await rename(path, backup)
  await mkdir(path)
  await assert.rejects(store.claim(first, 'failed-write', 9000))
  assert.deepEqual(store.get(first.sessionId), original)
  assert.deepEqual(JSON.parse(await readFile(backup, 'utf8')).tables.sessions[first.sessionId], original)
  await rm(path, { recursive: true })
  await rename(backup, path)
  const claimed = await store.claim(first, 'persisted-write', 9000)
  assert.equal(claimed.attemptId, 'persisted-write')
  assert.deepEqual((await saved())[first.sessionId], claimed)
})

test('failed first reservation and failed settlement never publish speculative state', async t => {
  const { store, path } = await harness(t)
  const first = eligibility()
  await mkdir(path)
  await assert.rejects(store.reserve(first))
  assert.equal(store.get(first.sessionId), undefined)
  await rm(path, { recursive: true })
  await store.reserve(first)
  const claimed = await store.claim(first, 'attempt-1')
  const backup = `${path}.fixture-backup`
  await rename(path, backup)
  await mkdir(path)
  await assert.rejects(store.settle(first, 'attempt-1', { status: 'completed', afterTokens: 10 }))
  assert.deepEqual(store.get(first.sessionId), claimed)
  await rm(path, { recursive: true })
  await rename(backup, path)
  const completed = await store.settle(first, 'attempt-1', { status: 'completed', afterTokens: 10 })
  assert.equal(completed.status, 'completed')
})

test('host compaction binding persists only for the current started attempt and fails closed', async t => {
  const { store, path, saved } = await harness(t)
  const first = eligibility()
  await store.reserve(first)
  assert.equal(await store.bindCompaction(first, 'attempt-1', 'compact-1'), null)
  const claimed = await store.claim(first, 'attempt-1')
  assert.equal(await store.bindCompaction(first, 'other-attempt', 'compact-1'), null)
  const backup = `${path}.fixture-backup`
  await rename(path, backup)
  await mkdir(path)
  await assert.rejects(store.bindCompaction(first, 'attempt-1', 'compact-1'))
  assert.deepEqual(store.get(first.sessionId), claimed)
  await rm(path, { recursive: true })
  await rename(backup, path)
  const bound = await store.bindCompaction(first, 'attempt-1', 'compact-1')
  assert.equal(bound.compactionId, 'compact-1')
  assert.deepEqual((await saved())[first.sessionId], bound)
  await store.settle(first, 'attempt-1', { status: 'interrupted', reasonCode: 'restart' })
  assert.equal(await store.bindCompaction(first, 'attempt-1', 'late-compact'), null)
  assert.equal(store.get(first.sessionId).compactionId, 'compact-1')
})

test('stale qualifications and attempt callbacks cannot overwrite a newer turn', async t => {
  const { store, saved } = await harness(t)
  const first = eligibility()
  await store.reserve(first)
  await store.claim(first, 'attempt-old')
  const second = eligibility(9, 2000, 'event-next')
  await store.reserve(second)
  const claimed = await store.claim(second, 'attempt-new')
  assert.equal(await store.settle(first, 'attempt-old', { status: 'cancelled', reasonCode: 'new-message' }), null)
  assert.equal(await store.settle(second, 'attempt-old', { status: 'completed' }), null)
  assert.equal(await store.settle({ ...second, turnEndSeq: 8 }, 'attempt-new', { status: 'completed' }), null)
  assert.equal(await store.settle({ ...second, completedAt: 1999 }, 'attempt-new', { status: 'completed' }), null)
  assert.equal(await store.reserve(first), null)
  assert.deepEqual(store.get(second.sessionId), claimed)
  const completed = await store.settle(second, 'attempt-new', { status: 'failed', reasonCode: 'summary-failed' })
  assert.deepEqual(await store.reserve(second), completed)
  assert.equal(await store.claim(second, 'retry-forbidden'), null)
  assert.equal(await store.reserve({ ...second, completedAt: 3000 }), null, 'a fingerprint cannot be relabelled as a new turn')
  const afterClear = eligibility(1, 3000, 'fresh-history')
  assert.equal((await store.reserve(afterClear)).status, 'eligible')
  assert.equal(await store.claim({ ...afterClear, fingerprint: 'copied-history' }, 'wrong-history'), null)
  assert.deepEqual(Object.keys(await saved()), [first.sessionId], 'one session stores only its latest record')
})

test('cancelled or skipped unclaimed eligibility is consumed without allowing completion', async t => {
  const { store } = await harness(t)
  const first = eligibility()
  await store.reserve(first)
  assert.equal(await store.settle(first, undefined, { status: 'completed' }), null)
  const cancelled = await store.settle(first, undefined, { status: 'cancelled', reasonCode: 'new-message' })
  assert.equal(cancelled.status, 'cancelled')
  assert.equal(await store.claim(first, 'late-claim'), null)
  assert.equal(await store.settle(first, undefined, { status: 'skipped' }), null)
})

test('drain and close wait for accepted writes while refusing new work', async t => {
  let release
  const barrier = new Promise(resolve => { release = resolve })
  let entered
  const started = new Promise(resolve => { entered = resolve })
  let closed = false
  const { store, saved } = await harness(t, { wrap: facility => ({
    async open(spec) {
      const domain = await facility.open(spec)
      return {
        table(name) {
          const table = domain.table(name)
          return {
            get: key => table.get(key),
            entries: () => table.entries(),
            async put(key, value) { entered(); await barrier; await table.put(key, value) },
          }
        },
        async close() { closed = true; await domain.close() },
      }
    },
  }) })
  const pending = store.reserve(eligibility())
  await started
  let drained = false
  const drain = store.drain().then(() => { drained = true })
  const close = store.close()
  assert.strictEqual(store.close(), close)
  await assert.rejects(store.reserve(eligibility(9, 2000)), /closing/)
  assert.equal(closed, false)
  assert.equal(drained, false)
  release()
  const record = await pending
  await Promise.all([drain, close])
  assert.equal(closed, true)
  assert.deepEqual((await saved())[record.sessionId], record)
})

test('records expose immutable copies and reject content or invalid accounting fields', async t => {
  const { store } = await harness(t)
  const first = eligibility()
  await assert.rejects(store.reserve({ ...first, content: 'private message must not be stored' }))
  await store.reserve(first)
  assert.throws(() => { store.get(first.sessionId).status = 'completed' }, TypeError)
  await assert.rejects(store.claim(first, '', 12))
  await assert.rejects(store.claim(first, 'attempt-1', -1))
  await store.claim(first, 'attempt-1')
  await assert.rejects(store.settle(first, 'attempt-1', { status: 'completed', afterTokens: Infinity }))
  await assert.rejects(store.settle(first, 'attempt-1', { status: 'completed', content: 'private text' }))
  assert.equal(store.get(first.sessionId).status, 'started')
})

for (const scenario of [
  { name: 'skipped preflight', status: 'skipped', reasonCode: 'below_threshold', claimed: false, afterTokens: undefined },
  { name: 'failed summary', status: 'failed', reasonCode: 'failed', claimed: true, afterTokens: undefined },
  { name: 'no compactable range', status: 'skipped', reasonCode: 'no_range', claimed: true, afterTokens: 4500 },
]) {
  test(`real journal persists ${scenario.name} with explicit optional undefined and does not rearm after reopen`, async t => {
    const { store, facility, saved, journal, journalRoot, pending } = await harness(t, { journal: true })
    const first = eligibility()
    await store.reserve(first)
    const attemptId = scenario.claimed ? 'attempt-1' : undefined
    if (scenario.claimed) await store.claim(first, attemptId, 4500)
    const result = await store.settle(first, attemptId, {
      status: scenario.status, reasonCode: scenario.reasonCode, beforeTokens: 4500,
      compactionId: undefined, afterTokens: scenario.afterTokens,
    })
    assert.equal(result.status, scenario.status)
    assert.equal(result.reasonCode, scenario.reasonCode)
    assert.equal(result.beforeTokens, 4500)
    assert.equal(Object.hasOwn(result, 'compactionId'), false)
    assert.equal(Object.hasOwn(result, 'afterTokens'), scenario.afterTokens !== undefined)
    assert.equal(Object.values(result).includes(undefined), false)
    assert.deepEqual((await saved())[first.sessionId], result)
    assert.deepEqual((await pending()).entries, [], 'durable domain write acknowledges its journal generation')
    assert.throws(() => journal.record(idleDomainSpec.name, first.sessionId, result,
      { ...result, afterTokens: undefined }), /metadata/, 'the journal itself still rejects non-JSON values')
    await store.close()
    journal.close()
    const reopenedJournal = RecoveryJournal.open(journalRoot)
    let reopened
    try {
      reopened = await IdleStore.open(facility, reopenedJournal)
      assert.deepEqual(reopened.get(first.sessionId), result)
      assert.deepEqual(await reopened.reserve(first), result)
      assert.equal(await reopened.claim(first, 'forbidden-retry'), null)
      assert.deepEqual((await pending()).entries, [])
    } finally {
      try { await reopened?.close() } finally { reopenedJournal.close() }
    }
  })
}

test('real journal recovers an undefined-free failed outcome after the Host domain closed first', async t => {
  const { root, ctx, backend, store, facility, saved, journal, journalRoot, pending } = await harness(t, { journal: true })
  const first = eligibility()
  await store.reserve(first)
  await store.claim(first, 'attempt-1', 4500)
  await facility.closeAll()
  await assert.rejects(store.settle(first, 'attempt-1', {
    status: 'failed', reasonCode: 'failed', beforeTokens: 4500,
    compactionId: undefined, afterTokens: undefined,
  }), error => error.code === 'closed')
  const latest = store.get(first.sessionId)
  assert.equal(latest.status, 'failed')
  assert.equal(Object.hasOwn(latest, 'compactionId'), false)
  assert.equal(Object.hasOwn(latest, 'afterTokens'), false)
  assert.equal((await saved())[first.sessionId].status, 'started', 'closed Host storage has not changed')
  const entries = (await pending()).entries
  assert.equal(entries.length, 1)
  assert.deepEqual(entries[0].next, latest, 'the complete normalized outcome is durable before the failed Host put')
  await store.close()
  journal.close()
  await backend.close()
  await ctx.fiber.dispose()
  // A stopped Host facility is not reusable on newer SDKs. Recreate the
  // complete storage owner over the same files, as a real restart does.
  const restartedContext = new Context()
  await restartedContext.plugin(Storage)
  const restartedBackend = new JsonStorageBackend(root)
  restartedContext.storage.backend.register('json', restartedBackend)
  const restartedFacility = new DomainFacility(restartedContext, { backend: 'json' })
  restartedContext.storage.mount('domain', restartedFacility)
  const reopenedJournal = RecoveryJournal.open(journalRoot)
  let reopened
  try {
    reopened = await IdleStore.open(restartedFacility, reopenedJournal)
    assert.deepEqual(reopened.get(first.sessionId), latest)
    assert.deepEqual((await saved())[first.sessionId], latest)
    assert.equal(await reopened.claim(first, 'forbidden-retry'), null)
    assert.deepEqual((await pending()).entries, [])
  } finally {
    try {
      await reopened?.close()
      await restartedFacility.closeAll()
      await restartedBackend.close()
      await restartedContext.fiber.dispose()
    } finally { reopenedJournal.close() }
  }
})
