import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, parse, resolve } from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
// The native matrix installs only this compiler outside the Host workspace.
const require = createRequire(process.env.CONTEXT_CI_DEPS
  ? join(resolve(process.env.CONTEXT_CI_DEPS), 'package.json') : import.meta.url)
const { build } = require('esbuild')

// Bundle this pure helper in memory, never rebuild the daily-linked root lib.
const compiled = await build({
  entryPoints: [fileURLToPath(new URL('../src/recovery-journal.ts', import.meta.url))],
  bundle: true, write: false, platform: 'node', format: 'esm', target: 'es2022',
  tsconfigRaw: { compilerOptions: { target: 'ES2022' } },
})
const moduleUrl = `data:text/javascript;base64,${Buffer.from(compiled.outputFiles[0].text).toString('base64')}`
const { RecoveryJournal } = await import(moduleUrl)
const IDLE = 'context_manager_idle', SUMMARIES = 'context_manager_summaries'
const idle = (status = 'eligible', key = 'session-test', time = 1) => ({
  sessionId: key, turnEndSeq: 5, completedAt: 1, fingerprint: 'synthetic-fingerprint', status, updatedAt: time,
  ...(status === 'started' ? { attemptId: 'synthetic-attempt' } : {}),
})
const summary = (input = null) => ({ sessionId: 'session-test', since: 1,
  archived: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, attempts: 0, unknownAttempts: 0 },
  recent: [{ id: 'synthetic-attempt', compactionId: 'synthetic-compaction', trigger: 'pressure',
    startedAt: 1, endedAt: 2, status: 'cancelled', input, output: 40, cacheRead: null, cacheWrite: null }] })
const validate = (key, value) => {
  assert.equal(value.sessionId, key)
  return structuredClone(value)
}

async function fixture(t, directory = 'journal') {
  const parent = await mkdtemp(join(tmpdir(), 'dsh-context-recovery-')), root = join(parent, directory)
  const journals = []
  const open = () => { const journal = RecoveryJournal.open(root); journals.push(journal); return journal }
  t.after(async () => {
    for (const journal of journals) journal.close()
    await rm(parent, { recursive: true, force: true })
  })
  const saved = () => JSON.parse(fs.readFileSync(join(root, 'pending.json'), 'utf8'))
  return { root, parent, open, saved }
}
function table(seed = []) {
  const rows = new Map(seed), writes = []
  return { rows, writes, get: key => rows.get(key), async put(key, value) {
    writes.push({ key, value: structuredClone(value) }); rows.set(key, structuredClone(value))
  } }
}
function crashWriter(root, extra = '') {
  const source = `const { RecoveryJournal } = await import(${JSON.stringify(moduleUrl)});
    const journal = RecoveryJournal.open(${JSON.stringify(root)});
    journal.record(${JSON.stringify(SUMMARIES)}, 'session-test', undefined, ${JSON.stringify(summary(600))});
    ${extra}
    process.exit(0);`
  const env = { PATH: process.env.PATH ?? '', HOME: root, DSH_HOME: root, LANG: 'C.UTF-8' }
  if (process.platform === 'win32') {
    // Keep the Windows loader's system locations; never inherit user-data or
    // temporary-directory locations through libuv's required-env fallback.
    for (const name of ['SystemRoot', 'WINDIR']) {
      const value = Object.entries(process.env).find(([key]) => key.toLowerCase() === name.toLowerCase())?.[1]
      if (value) env[name] = value
    }
    const drive = parse(root).root.replace(/[\\/]+$/u, '')
    Object.assign(env, { USERPROFILE: root, HOMEDRIVE: drive, HOMEPATH: root.slice(drive.length) || '\\',
      TEMP: root, TMP: root })
  }
  const result = spawnSync(process.execPath, ['--input-type=module'], { input: source, encoding: 'utf8', timeout: 5000, env })
  assert.equal(result.status, 0, result.stderr)
  assert.equal(result.signal, null)
}

test('journal: durable write-ahead metadata uses supported permissions and survives close', async t => {
  const f = await fixture(t), journal = f.open(), value = summary(600)
  journal.record(SUMMARIES, value.sessionId, undefined, value)
  assert.equal(fs.lstatSync(f.root).isDirectory(), true)
  for (const name of ['pending.json', 'lock.json']) assert.equal(fs.lstatSync(join(f.root, name)).isFile(), true)
  if (process.platform !== 'win32') {
    assert.equal(fs.statSync(f.root).mode & 0o777, 0o700)
    for (const name of ['pending.json', 'lock.json']) assert.equal(fs.statSync(join(f.root, name)).mode & 0o777, 0o600)
  }
  // Windows inherits the profile's ACL. POSIX mode bits cannot prove its ACL.
  assert.deepEqual(f.saved().entries[0].next, value)
  journal.close()
  assert.equal(fs.existsSync(join(f.root, 'lock.json')), false)
  const next = f.open(), target = table()
  await next.replay(SUMMARIES, target, validate)
  assert.deepEqual(target.get(value.sessionId), value)
  assert.equal(target.writes.length, 1)
  assert.deepEqual(f.saved(), { schema: 1, entries: [] })
})

test('journal: out-of-order older acknowledgements never clear a newer generation', async t => {
  const f = await fixture(t), journal = f.open(), a = idle(), b = idle('started', 'session-test', 2), c = idle('completed', 'session-test', 3)
  const ackA = journal.record(IDLE, a.sessionId, undefined, a)
  const ackB = journal.record(IDLE, a.sessionId, a, b)
  const ackC = journal.record(IDLE, a.sessionId, b, c)
  ackB(); ackA(); ackA()
  assert.deepEqual(f.saved().entries[0].next, c)
  assert.equal(f.saved().entries[0].before.length, 3)
  ackC(); ackB(); ackC()
  assert.equal(f.saved().entries.length, 0)
})

test('journal: every committed intermediate queue state can recover only the latest row', async t => {
  for (const committed of [undefined, idle(), idle('started', 'session-test', 2)]) {
    const f = await fixture(t), journal = f.open(), a = idle(), b = idle('started', 'session-test', 2), c = idle('completed', 'session-test', 3)
    journal.record(IDLE, a.sessionId, undefined, a)
    journal.record(IDLE, a.sessionId, a, b)
    journal.record(IDLE, a.sessionId, b, c)
    journal.close()
    const reopened = f.open(), target = table(committed === undefined ? [] : [[a.sessionId, committed]])
    await reopened.replay(IDLE, target, validate)
    assert.deepEqual(target.get(a.sessionId), c)
    assert.equal(target.writes.length, 1)
    await reopened.replay(IDLE, target, validate)
    assert.equal(target.writes.length, 1, 'repeat recovery must not duplicate metadata writes or model attempts')
  }
})

test('journal: crash after domain put but before acknowledgement does not write or count twice', async t => {
  const f = await fixture(t), journal = f.open(), value = summary(600), target = table()
  journal.record(SUMMARIES, value.sessionId, undefined, value)
  const original = target.put
  target.put = async (key, row) => { await original(key, row); throw new Error('synthetic post-put interruption') }
  await assert.rejects(journal.replay(SUMMARIES, target, validate), /post-put interruption/)
  assert.equal(f.saved().entries.length, 1)
  journal.close()
  target.put = original
  await f.open().replay(SUMMARIES, target, validate)
  assert.equal(target.writes.length, 1)
  assert.deepEqual(target.get(value.sessionId), value)
  assert.equal(f.saved().entries.length, 0)
})

test('journal: missing cache/input stays unknown and a late field replaces the snapshot without adding attempts', async t => {
  const f = await fixture(t), journal = f.open(), unknown = summary(), known = summary(600)
  const oldAck = journal.record(SUMMARIES, unknown.sessionId, undefined, unknown)
  journal.record(SUMMARIES, known.sessionId, unknown, known)
  oldAck()
  journal.close()
  const target = table([[unknown.sessionId, unknown]])
  await f.open().replay(SUMMARIES, target, validate)
  const restored = target.get(known.sessionId)
  assert.equal(restored.recent.length, 1)
  assert.equal(restored.recent[0].input, 600)
  assert.equal(restored.recent[0].cacheRead, null)
  assert.equal(restored.recent[0].cacheWrite, null)
  assert.equal(restored.recent[0].status, 'cancelled')
})

test('journal: existing conflicts are detected before any record is written and preserve pending bytes', async t => {
  const f = await fixture(t), journal = f.open(), a = idle('eligible', 'session-a'), b = idle('eligible', 'session-b')
  journal.record(IDLE, a.sessionId, undefined, a)
  journal.record(IDLE, b.sessionId, undefined, b)
  const bytes = fs.readFileSync(join(f.root, 'pending.json'))
  const target = table([[b.sessionId, idle('completed', b.sessionId, 88)]])
  await assert.rejects(journal.replay(IDLE, target, validate), /conflicts/)
  assert.equal(target.writes.length, 0)
  assert.deepEqual(fs.readFileSync(join(f.root, 'pending.json')), bytes)
  assert.equal(target.get(b.sessionId).updatedAt, 88)
})

test('journal: stale writers cannot replace a newer pending state; duplicate writes are idempotent', async t => {
  const f = await fixture(t), journal = f.open(), a = idle(), b = idle('started', 'session-test', 2)
  journal.record(IDLE, a.sessionId, undefined, a)
  journal.record(IDLE, a.sessionId, a, b)
  const bytes = fs.readFileSync(join(f.root, 'pending.json'))
  assert.throws(() => journal.record(IDLE, a.sessionId, a, idle('cancelled', 'session-test', 3)), /newer pending/)
  const ack = journal.record(IDLE, a.sessionId, a, b)
  assert.deepEqual(fs.readFileSync(join(f.root, 'pending.json')), bytes)
  ack()
  assert.equal(f.saved().entries.length, 0)
})

test('journal: unknown domain/fields, model bodies and non-JSON values never enter durable state', async t => {
  const f = await fixture(t), journal = f.open(), row = idle()
  for (const value of [{ ...row, prompt: 'must not persist' }, { ...row, output: 'must not persist' },
    { ...row, updatedAt: Number.NaN }, { ...row, updatedAt: Infinity }, { ...row, fingerprint: undefined }]) {
    assert.throws(() => journal.record(IDLE, row.sessionId, undefined, value))
  }
  assert.throws(() => journal.record('other_plugin', row.sessionId, undefined, row), /invalid domain/)
  assert.throws(() => journal.record(IDLE, 'wrong-key', undefined, row), /does not match/)
  assert.equal(f.saved().entries.length, 0)
})

test('journal: caller schema validation and normalization cannot silently rewrite recovery facts', async t => {
  const f = await fixture(t), journal = f.open(), row = idle()
  journal.record(IDLE, row.sessionId, undefined, row)
  const target = table()
  await assert.rejects(journal.replay(IDLE, target, () => { throw new Error('synthetic schema rejection') }), /schema rejection/)
  await assert.rejects(journal.replay(IDLE, target, (_key, value) => ({ ...value, fingerprint: 'rewritten' })), /validation changed/)
  assert.equal(target.writes.length, 0)
  assert.equal(f.saved().entries.length, 1)
})

test('journal: malformed persisted schema and unknown fields fail closed without modifying pending', async t => {
  for (const mutate of [
    value => ({ ...value, schema: 2 }), value => ({ ...value, extra: true }),
    value => ({ ...value, entries: value.entries.map(entry => ({ ...entry, extra: true })) }),
    value => ({ ...value, entries: value.entries.map(entry => ({ ...entry, next: { ...entry.next, prompt: 'forbidden' } })) }),
  ]) {
    const f = await fixture(t), journal = f.open(), row = idle()
    journal.record(IDLE, row.sessionId, undefined, row); journal.close()
    const malformed = JSON.stringify(mutate(f.saved()))
    fs.writeFileSync(join(f.root, 'pending.json'), malformed)
    assert.throws(() => f.open())
    assert.equal(fs.readFileSync(join(f.root, 'pending.json'), 'utf8'), malformed)
    assert.equal(fs.existsSync(join(f.root, 'lock.json')), false)
  }
})

test('journal: a live owner is refused and a truly exited child owner is recovered', async t => {
  const f = await fixture(t), journal = f.open()
  assert.throws(() => f.open(), /live process/)
  journal.close()
  crashWriter(f.root)
  const old = JSON.parse(fs.readFileSync(join(f.root, 'lock.json'), 'utf8'))
  assert.notEqual(old.pid, process.pid)
  const reopened = f.open(), target = table()
  await reopened.replay(SUMMARIES, target, validate)
  assert.deepEqual(target.get('session-test'), summary(600))
  assert.equal(fs.readdirSync(f.root).some(name => name.startsWith('reclaim-')), false)
})

test('journal: foreign hosts, malformed locks and interrupted stale reclaim stay refused', async t => {
  for (const kind of ['foreign', 'malformed', 'reclaim']) {
    const f = await fixture(t)
    crashWriter(f.root)
    const path = join(f.root, 'lock.json'), owner = JSON.parse(fs.readFileSync(path, 'utf8'))
    if (kind === 'foreign') fs.writeFileSync(path, JSON.stringify({ ...owner, host: 'another-synthetic-host' }))
    if (kind === 'malformed') fs.writeFileSync(path, '{}')
    if (kind === 'reclaim') fs.writeFileSync(join(f.root, `reclaim-${owner.token}.json`), JSON.stringify({ ...owner, pid: process.pid }))
    const bytes = fs.readFileSync(path), pending = fs.readFileSync(join(f.root, 'pending.json'))
    assert.throws(() => f.open())
    assert.deepEqual(fs.readFileSync(path), bytes)
    assert.deepEqual(fs.readFileSync(join(f.root, 'pending.json')), pending)
  }
})

test('journal: a permission/unknown process check refuses stale-lock reclamation', async t => {
  const f = await fixture(t)
  crashWriter(f.root)
  const bytes = fs.readFileSync(join(f.root, 'lock.json'))
  const mocked = t.mock.method(process, 'kill', () => { throw Object.assign(new Error('synthetic denied signal'), { code: 'EPERM' }) })
  try { assert.throws(() => f.open(), /cannot be established/) } finally { mocked.mock.restore() }
  assert.deepEqual(fs.readFileSync(join(f.root, 'lock.json')), bytes)
})

test('journal: failed atomic replacement keeps pending state and a later retry can recover', async t => {
  const f = await fixture(t), journal = f.open(), a = summary(), b = summary(600)
  journal.record(SUMMARIES, a.sessionId, undefined, a)
  const before = fs.readFileSync(join(f.root, 'pending.json'))
  const mocked = t.mock.method(fs, 'renameSync', () => { throw Object.assign(new Error('synthetic disk failure'), { code: 'EIO' }) })
  try { assert.throws(() => journal.record(SUMMARIES, a.sessionId, a, b), /disk failure/) }
  finally { mocked.mock.restore() }
  assert.deepEqual(fs.readFileSync(join(f.root, 'pending.json')), before)
  journal.record(SUMMARIES, a.sessionId, a, b)
  assert.deepEqual(f.saved().entries[0].next, b)
  assert.equal(fs.readdirSync(f.root).some(name => name.endsWith('.tmp')), false)
})

test('journal: failed acknowledgement is retryable and never silently clears pending metadata', async t => {
  const f = await fixture(t), journal = f.open(), row = summary(600)
  const ack = journal.record(SUMMARIES, row.sessionId, undefined, row)
  const mocked = t.mock.method(fs, 'renameSync', () => { throw new Error('synthetic ack failure') })
  try { assert.throws(ack, /ack failure/) } finally { mocked.mock.restore() }
  assert.equal(f.saved().entries.length, 1)
  ack(); ack()
  assert.equal(f.saved().entries.length, 0)
})

test('journal: failure after rename freezes writes until reopen instead of trusting stale memory', async t => {
  const f = await fixture(t), journal = f.open(), a = summary(), b = summary(600)
  journal.record(SUMMARIES, a.sessionId, undefined, a)
  const originalSync = fs.fsyncSync, originalRename = fs.renameSync
  let renamed = false, failures = 0
  const renameMock = t.mock.method(fs, 'renameSync', (...args) => {
    originalRename(...args)
    renamed = true
  })
  const syncMock = t.mock.method(fs, 'fsyncSync', fd => {
    if (renamed) { failures++; throw new Error('synthetic post-rename sync failure') }
    return originalSync(fd)
  })
  try {
    assert.throws(() => journal.record(SUMMARIES, a.sessionId, a, b), /post-rename sync failure/)
    assert.equal(renamed, true, 'the failure must follow a real completed replacement')
    assert.equal(failures, 1)
  } finally { syncMock.mock.restore(); renameMock.mock.restore() }
  assert.throws(() => journal.record(SUMMARIES, a.sessionId, a, b), /durability is uncertain/)
  assert.deepEqual(f.saved().entries[0].next, b)
  journal.close()
  const target = table([[a.sessionId, a]])
  await f.open().replay(SUMMARIES, target, validate)
  assert.deepEqual(target.get(a.sessionId), b)
})

test('journal: limits reject oversized records, pending files and predecessor histories', async t => {
  const f = await fixture(t), journal = f.open(), row = summary()
  row.recent = Array.from({ length: 128 }, () => ({ ...row.recent[0], id: 'i'.repeat(1024), compactionId: 'c'.repeat(1024) }))
  assert.throws(() => journal.record(SUMMARIES, row.sessionId, undefined, row), /exceeds limit/)
  journal.record(IDLE, 'session-test', undefined, idle()); journal.close()
  const value = f.saved()
  value.entries[0].before = Array.from({ length: 1025 }, (_, i) => createHash('sha256').update(String(i)).digest('hex'))
  fs.writeFileSync(join(f.root, 'pending.json'), JSON.stringify(value))
  assert.throws(() => f.open(), /invalid pending chain/)
  fs.writeFileSync(join(f.root, 'pending.json'), ' '.repeat(8 * 1024 * 1024 + 1))
  assert.throws(() => f.open(), /oversized/)
})

test('journal: a directory symlink or Windows junction cannot redirect journal writes', async t => {
  const f = await fixture(t), outside = join(f.parent, 'outside')
  fs.mkdirSync(outside)
  fs.symlinkSync(outside, f.root, process.platform === 'win32' ? 'junction' : 'dir')
  assert.throws(() => f.open(), /real directory/)
  assert.deepEqual(fs.readdirSync(outside), [])
})

test('journal: a file symlink cannot redirect pending metadata reads or writes', async t => {
  const f = await fixture(t), outside = join(f.parent, 'outside')
  fs.mkdirSync(outside)
  const journal = f.open(); journal.close()
  fs.unlinkSync(join(f.root, 'pending.json'))
  const external = join(outside, 'external.json')
  fs.writeFileSync(external, JSON.stringify({ schema: 1, entries: [] }))
  try { fs.symlinkSync(external, join(f.root, 'pending.json'), 'file') }
  catch (error) {
    if (process.platform === 'win32' && error.code === 'EPERM') {
      t.skip('Windows file-symlink creation needs Developer Mode or the symlink privilege; junction coverage still runs')
      return
    }
    throw error
  }
  assert.throws(() => f.open(), /invalid or oversized/)
  assert.equal(fs.readFileSync(external, 'utf8'), JSON.stringify({ schema: 1, entries: [] }))
})

test('journal: replay excludes concurrent records and close, then releases its guard on failure', async t => {
  const f = await fixture(t), journal = f.open(), row = idle(), target = table()
  journal.record(IDLE, row.sessionId, undefined, row)
  let release
  const held = new Promise(resolve => { release = resolve })
  const original = target.put
  target.put = async (key, value) => { await held; await original(key, value) }
  const recovery = journal.replay(IDLE, target, validate)
  assert.throws(() => journal.record(IDLE, row.sessionId, row, idle('completed')), /replay is in progress/)
  assert.throws(() => journal.close(), /cannot close during replay/)
  await assert.rejects(journal.replay(IDLE, target, validate), /concurrent replay/)
  release(); await recovery
  journal.close()
})

test('journal: regular-file fsync EPERM rejects updates and acknowledgements without dropping pending state', async t => {
  const f = await fixture(t), journal = f.open(), a = summary(), b = summary(600)
  const acknowledge = journal.record(SUMMARIES, a.sessionId, undefined, a)
  const before = fs.readFileSync(join(f.root, 'pending.json')), originalSync = fs.fsyncSync
  let failures = 0
  const mocked = t.mock.method(fs, 'fsyncSync', fd => {
    if (fs.fstatSync(fd).isFile()) {
      failures++
      throw Object.assign(new Error('synthetic regular-file flush denied'), { code: 'EPERM' })
    }
    return originalSync(fd)
  })
  try {
    assert.throws(() => journal.record(SUMMARIES, a.sessionId, a, b), { code: 'EPERM' })
    assert.throws(acknowledge, { code: 'EPERM' })
    assert.equal(failures, 2, 'neither a data write nor an acknowledgement may swallow a file flush failure')
    assert.deepEqual(fs.readFileSync(join(f.root, 'pending.json')), before)
  } finally { mocked.mock.restore() }
  assert.equal(fs.readdirSync(f.root).some(name => name.endsWith('.tmp')), false)
  journal.record(SUMMARIES, a.sessionId, a, b)
  journal.close()
  const target = table([[a.sessionId, a]])
  await f.open().replay(SUMMARIES, target, validate)
  assert.deepEqual(target.get(a.sessionId), b)
  assert.equal(target.writes.length, 1)
})

test('journal: Chinese characters and spaces in a real path survive orphan-lock recovery', async t => {
  const f = await fixture(t, '恢复 日志 空格路径'), journal = f.open()
  journal.close()
  crashWriter(f.root)
  const reopened = f.open(), target = table()
  await reopened.replay(SUMMARIES, target, validate)
  assert.deepEqual(target.get('session-test'), summary(600))
  assert.equal(target.writes.length, 1)
  await reopened.replay(SUMMARIES, target, validate)
  assert.equal(target.writes.length, 1, 'a second replay never duplicates accounting')
  assert.deepEqual(f.saved(), { schema: 1, entries: [] })
})

test('journal: real-platform durability flushes files and never fsyncs a directory on Windows', async t => {
  const f = await fixture(t), originalSync = fs.fsyncSync
  const counts = { files: 0, directories: 0, published: 0 }
  const mocked = t.mock.method(fs, 'fsyncSync', fd => {
    const held = fs.fstatSync(fd)
    if (held.isDirectory()) counts.directories++
    if (held.isFile()) {
      counts.files++
      const published = fs.lstatSync(join(f.root, 'pending.json'), { throwIfNoEntry: false })
      if (published?.isFile() && published.dev === held.dev && published.ino === held.ino) counts.published++
    }
    return originalSync(fd)
  })
  try {
    const journal = f.open(), row = summary(600)
    const acknowledge = journal.record(SUMMARIES, row.sessionId, undefined, row)
    assert.ok(counts.files > 0, 'actual regular-file fsync calls must remain enabled')
    assert.deepEqual(f.saved().entries[0].next, row)
    acknowledge()
    assert.deepEqual(f.saved().entries, [])
    journal.close()
    if (process.platform === 'win32') {
      assert.equal(counts.directories, 0, 'do not use POSIX directory fsync on a real Windows runtime')
      assert.ok(counts.published >= 3, 'initialization, record and acknowledgement each flush the published file')
    } else {
      assert.ok(counts.directories > 0, 'POSIX directory durability remains enabled')
    }
  } finally { mocked.mock.restore() }
})
