import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtemp, mkdir, readFile, rename, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'
import { Context } from '@deepseek-ai/cordis'
import Storage from '@deepseek-ai/dsh-storage'
import { DomainFacility } from '@deepseek-ai/dsh-storage-domain'
import { JsonStorageBackend } from '@deepseek-ai/dsh-storage-json'

// Bundle only this helper in memory; never rebuild or write canonical lib.
const compiled = await build({
  entryPoints: [fileURLToPath(new URL('../src/compaction-cycles.ts', import.meta.url))],
  bundle: true, write: false, platform: 'node', format: 'esm', target: 'es2022',
  tsconfigRaw: { compilerOptions: { target: 'ES2022' } },
  plugins: [{ name: 'installed-public-api', setup(builder) {
    builder.onResolve({ filter: /^[^./]/ }, args => ({ path: import.meta.resolve(args.path), external: true }))
  } }],
})
const { CompactionCycles, CompactionCycleError, compactionCyclesSpec } = await import(`data:text/javascript;base64,${Buffer.from(`${compiled.outputFiles[0].text}\n//# sourceURL=compaction-cycles-test.js`).toString('base64')}`)

const sessionId = 'cycle-fixture-session'
const requestHash = value => createHash('sha256').update(value).digest('hex')
const input = (name, patch = {}) => ({ sessionId, requestHash: requestHash(name), sourceWatermark: 100,
  freshTokens: 0, minNewTokens: 10000, purpose: 'summary', ...patch })
const code = expected => error => error instanceof CompactionCycleError && error.code === expected
function deferred() {
  let resolve
  const promise = new Promise(accept => { resolve = accept })
  return { promise, resolve }
}

async function harness(t) {
  const root = await mkdtemp(join(tmpdir(), 'dsh-context-cycles-'))
  const path = join(root, `${compactionCyclesSpec.name}.json`)
  const active = new Set()
  async function boot(options = {}) {
    const ctx = new Context()
    await ctx.plugin(Storage)
    const backend = new JsonStorageBackend(root)
    ctx.storage.backend.register('json', backend)
    const facility = new DomainFacility(ctx, { backend: 'json' })
    ctx.storage.mount('domain', facility)
    const runtime = { ctx, backend, facility }
    active.add(runtime)
    try {
      runtime.cycles = await CompactionCycles.open({ async open(spec) {
        const domain = await facility.open(spec)
        const table = domain.table('claims')
        runtime.table = table
        // Instrument only the write boundary; reads, writes and durability
        // remain owned by the real schema-backed Domain and JSON backend.
        return { table: () => ({
          get: key => table.get(key), entries: () => table.entries(),
          put: async (key, value) => { await options.beforePut?.(key, value); await table.put(key, value) },
        }), close: () => domain.close() }
      } })
      return runtime
    } catch (error) { await stop(runtime); throw error }
  }
  async function stop(runtime) {
    await runtime.cycles?.close()
    await runtime.facility.closeAll()
    await runtime.backend.close()
    await runtime.ctx.fiber.dispose()
    active.delete(runtime)
  }
  t.after(async () => {
    try { for (const runtime of active) await stop(runtime) }
    finally { await rm(root, { recursive: true, force: true }) }
  })
  const saved = async () => JSON.parse(await readFile(path, 'utf8')).tables.claims
  return { path, boot, stop, saved }
}

test('cycles: a persisted unknown call survives full teardown and cannot be replayed', async t => {
  const { boot, stop, saved } = await harness(t)
  const first = await boot()
  assert.equal(first.cycles.peek(sessionId), undefined)
  await first.cycles.claim(input('unknown-outcome'))
  const before = first.cycles.peek(sessionId)
  assert.equal(before.calls, 1)
  assert.equal(before.summaryCalls, 1)
  assert.equal(before.cycle, 1)
  assert.equal(before.sourceWatermark, 100)
  const rows = Object.values(await saved())
  assert.equal(rows.length, 1, 'claim resolves only after the JSON row is durable')
  assert.deepEqual(Object.keys(rows[0]).sort(), ['sessionId', 'requestHash', 'sourceWatermark', 'freshTokens', 'minNewTokens', 'purpose', 'cycle', 'ordinal', 'claimedAt'].sort())
  await stop(first)
  const second = await boot()
  assert.notEqual(second.ctx, first.ctx)
  assert.deepEqual(second.cycles.peek(sessionId), before, 'opening observes permits without reissuing work')
  await assert.rejects(second.cycles.claim(input('unknown-outcome')), code('duplicate_request'))
  assert.equal(Object.keys(await saved()).length, 1)
  await second.cycles.claim(input('different-plan'))
  assert.equal(second.cycles.peek(sessionId).calls, 2)
})

test('cycles: two summary plans and four total calls share one persistent allowance', async t => {
  const { boot, stop } = await harness(t)
  let runtime = await boot()
  await runtime.cycles.claim(input('plan-one'))
  await runtime.cycles.claim(input('plan-two'))
  await assert.rejects(runtime.cycles.claim(input('plan-three')), code('summary_limit'))
  await runtime.cycles.claim(input('repair-one', { purpose: 'repair' }))
  await runtime.cycles.claim(input('recovery-one', { purpose: 'recovery' }))
  assert.equal(runtime.cycles.peek(sessionId).calls, 4)
  assert.equal(runtime.cycles.peek(sessionId).summaryCalls, 2)
  await stop(runtime)
  runtime = await boot()
  for (const purpose of ['summary', 'repair', 'recovery']) {
    await assert.rejects(runtime.cycles.claim(input(`after-restart-${purpose}`, { purpose })), code('call_limit'))
  }
  assert.equal(runtime.cycles.peek(sessionId).calls, 4)
})

test('cycles: only increased original-source watermark with enough new tokens opens another cycle', async t => {
  const { boot, saved } = await harness(t)
  const { cycles } = await boot()
  await cycles.claim(input('first-plan'))
  await cycles.claim(input('different-model-or-policy', { freshTokens: 50000 }))
  assert.equal(cycles.peek(sessionId).cycle, 1, 'different request hash or claimed pressure alone is not new source')
  await assert.rejects(cycles.claim(input('too-little-new-source', { sourceWatermark: 101, freshTokens: 9999 })), code('summary_limit'))
  assert.equal(cycles.peek(sessionId).sourceWatermark, 100, 'small additions do not advance the cycle baseline')
  await cycles.claim(input('new-source-plan', { sourceWatermark: 101, freshTokens: 10000 }))
  const next = cycles.peek(sessionId)
  assert.equal(next.cycle, 2)
  assert.equal(next.sourceWatermark, 101)
  assert.equal(next.calls, 1)
  assert.equal(next.summaryCalls, 1)
  assert.deepEqual(next.requestHashes, [requestHash('new-source-plan')])
  await assert.rejects(cycles.claim(input('first-plan', { sourceWatermark: 200, freshTokens: 50000 })), code('duplicate_request'))
  await assert.rejects(cycles.claim(input('old-source-plan')), code('stale_source'))
  assert.equal(Object.keys(await saved()).length, 3, 'old request hashes remain durable after rollover')
})

test('cycles: repair and recovery never create or renew a cycle', async t => {
  const { boot } = await harness(t)
  const { cycles } = await boot()
  for (const purpose of ['repair', 'recovery']) {
    await assert.rejects(cycles.claim(input(`orphan-${purpose}`, { purpose })), code('no_cycle'))
  }
  await cycles.claim(input('original'))
  for (const [index, purpose] of ['repair', 'recovery', 'repair'].entries()) {
    await cycles.claim(input(`auxiliary-${index}`, { purpose, sourceWatermark: 900, freshTokens: 100000 }))
    assert.equal(cycles.peek(sessionId).cycle, 1)
    assert.equal(cycles.peek(sessionId).sourceWatermark, 100)
  }
  await assert.rejects(cycles.claim(input('exhausted-recovery', { purpose: 'recovery', sourceWatermark: 1000, freshTokens: 100000 })), code('call_limit'))
})

test('cycles: concurrent duplicate claims have one winner and distinct calls cannot overbook', async t => {
  const { boot, saved } = await harness(t)
  const { cycles } = await boot()
  const duplicate = await Promise.allSettled(Array.from({ length: 12 }, () => cycles.claim(input('same-request'))))
  assert.equal(duplicate.filter(result => result.status === 'fulfilled').length, 1)
  assert.ok(duplicate.filter(result => result.status === 'rejected').every(result => code('duplicate_request')(result.reason)))
  const remaining = await Promise.allSettled(['summary', 'repair', 'recovery', 'repair', 'recovery'].map((purpose, index) => cycles.claim(input(`concurrent-${index}`, { purpose }))))
  assert.equal(remaining.filter(result => result.status === 'fulfilled').length, 3)
  assert.ok(remaining.filter(result => result.status === 'rejected').every(result => code('call_limit')(result.reason)))
  assert.equal(cycles.peek(sessionId).calls, 4)
  assert.equal(cycles.peek(sessionId).summaryCalls, 2)
  assert.equal(Object.keys(await saved()).length, 4)
})

test('cycles: a failed JSON write grants no call or speculative state and a later write can succeed', async t => {
  const { boot, path, saved } = await harness(t)
  const { cycles } = await boot()
  await cycles.claim(input('persisted'))
  const before = cycles.peek(sessionId)
  const persisted = await saved()
  const backup = `${path}.fixture-backup`
  await rename(path, backup)
  await mkdir(path)
  try {
    await assert.rejects(cycles.claim(input('failed-write')))
    assert.deepEqual(cycles.peek(sessionId), before)
    assert.deepEqual(JSON.parse(await readFile(backup, 'utf8')).tables.claims, persisted)
  } finally {
    await rm(path, { recursive: true, force: true })
    await rename(backup, path)
  }
  await cycles.claim(input('failed-write'))
  assert.equal(cycles.peek(sessionId).calls, 2)
  assert.equal(Object.keys(await saved()).length, 2)
})

test('cycles: close drains accepted claims, rejects newcomers and publishes only durable state', async t => {
  const { boot, stop } = await harness(t)
  const entered = deferred(), release = deferred()
  let writes = 0, granted = false, closed = false
  const runtime = await boot({ beforePut: async () => { if (++writes === 1) { entered.resolve(); await release.promise } } })
  const first = runtime.cycles.claim(input('queued-first')).then(() => { granted = true })
  const second = runtime.cycles.claim(input('queued-second'))
  await entered.promise
  assert.equal(granted, false)
  assert.equal(runtime.cycles.peek(sessionId), undefined)
  const closing = runtime.cycles.close()
  assert.equal(runtime.cycles.close(), closing, 'close is idempotent')
  void closing.then(() => { closed = true })
  try {
    await assert.rejects(runtime.cycles.claim(input('after-close')), code('closed'))
    assert.equal(closed, false)
    assert.equal(writes, 1)
  } finally { release.resolve() }
  await Promise.all([first, second, closing])
  assert.equal(granted, true)
  assert.equal(closed, true)
  assert.equal(runtime.cycles.peek(sessionId).calls, 2)
  await stop(runtime)
  const reopened = await boot()
  assert.equal(reopened.cycles.peek(sessionId).calls, 2)
})

test('cycles: hashes are isolated by session and snapshots cannot mutate permits', async t => {
  const { boot } = await harness(t)
  const { cycles } = await boot()
  await cycles.claim(input('shared-request'))
  await cycles.claim(input('shared-request', { sessionId: 'second-session' }))
  const first = cycles.peek(sessionId)
  assert.equal(cycles.peek('second-session').calls, 1)
  assert.throws(() => { first.calls = 0 }, TypeError)
  assert.throws(() => { first.requestHashes.push('fabricated') }, TypeError)
  await cycles.claim(input('second-in-first-session'))
  assert.equal(first.calls, 1, 'old snapshot remains detached from later claims')
  assert.equal(cycles.peek(sessionId).calls, 2)
})

test('cycles: malformed inputs and unknown fields cannot enter the metadata domain', async t => {
  const { boot, path } = await harness(t)
  const { cycles } = await boot()
  for (const patch of [
    { requestHash: 'unhashed content' }, { sessionId: '' }, { sourceWatermark: -1 },
    { sourceWatermark: 1.5 }, { freshTokens: Number.NaN }, { minNewTokens: 0 },
    { purpose: 'business' }, { transcript: 'fixture-only text' },
  ]) await assert.rejects(cycles.claim(input('invalid', patch)))
  assert.equal(cycles.peek(sessionId), undefined)
  await assert.rejects(readFile(path), { code: 'ENOENT' })
})

test('cycles: reopening rejects edited cycle ordinals instead of resetting an allowance', async t => {
  const { boot, stop } = await harness(t)
  const runtime = await boot()
  await runtime.cycles.claim(input('original-permit'))
  const [key, row] = [...runtime.table.entries()][0]
  await runtime.table.put(key, { ...row, ordinal: 2 })
  await stop(runtime)
  await assert.rejects(boot(), code('invalid_state'))
})
