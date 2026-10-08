// Standalone native filesystem check: no Host, user profile, or model calls.
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { createRequire } from 'node:module'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'

const dependencyRoot = process.env.CONTEXT_CI_DEPS
const require = createRequire(dependencyRoot ? join(resolve(dependencyRoot), 'package.json') : import.meta.url)
const { build } = require('esbuild')
const compiled = await build({
  entryPoints: [fileURLToPath(new URL('../src/recovery-journal.ts', import.meta.url))],
  bundle: true, write: false, platform: 'node', format: 'esm', target: 'es2022',
  tsconfigRaw: { compilerOptions: { target: 'ES2022' } },
})
const { RecoveryJournal } = await import(`data:text/javascript;base64,${Buffer.from(compiled.outputFiles[0].text).toString('base64')}`)
const parent = fs.mkdtempSync(join(tmpdir(), 'dsh context 中文-'))
const root = join(parent, 'profile space 中文', '.context-manager-recovery')
fs.mkdirSync(join(parent, 'profile space 中文'))
const result = { platform: process.platform, node: process.version, checks: [], modelCalls: 0 }
const journals = []
const open = () => { const journal = RecoveryJournal.open(root); journals.push(journal); return journal }
const check = (name, action) => { action(); result.checks.push(name) }
try {
  let journal = open()
  check('initial load', () => assert(fs.existsSync(join(root, 'pending.json'))))
  const value = { sessionId: 'session-synthetic', since: 1,
    archived: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, attempts: 0, unknownAttempts: 0 },
    recent: [{ id: 'attempt-synthetic', compactionId: 'compaction-synthetic', trigger: 'pressure',
      startedAt: 1, endedAt: 2, status: 'cancelled', input: 600, output: 40, cacheRead: null, cacheWrite: null }] }
  journal.record('context_manager_summaries', value.sessionId, undefined, value)
  check('pending usage persisted', () => assert.deepEqual(JSON.parse(fs.readFileSync(join(root, 'pending.json'), 'utf8')).entries[0].next, value))
  check('live owner rejected', () => assert.throws(() => RecoveryJournal.open(root), /locked by a live process/))
  journal.close()
  check('lock released', () => assert(!fs.existsSync(join(root, 'lock.json'))))
  const rows = new Map(), writes = []
  const table = { get: key => rows.get(key), async put(key, next) { rows.set(key, structuredClone(next)); writes.push(key) } }
  journal = open()
  await journal.replay('context_manager_summaries', table, (key, next) => {
    assert.equal(next.sessionId, key); return structuredClone(next)
  })
  check('restart recovered usage exactly once', () => { assert.deepEqual(rows.get(value.sessionId), value); assert.equal(writes.length, 1) })
  journal.close()
  journal = open()
  await journal.replay('context_manager_summaries', table, (_key, next) => structuredClone(next))
  check('second restart does not duplicate usage', () => assert.equal(writes.length, 1))
  result.ok = true
} catch (error) {
  result.ok = false
  result.error = { name: error.name, code: error.code, syscall: error.syscall, message: error.message }
  process.exitCode = 1
} finally {
  for (const journal of journals) {
    try { journal.close() } catch (error) { result.cleanupError = error.message; result.ok = false; process.exitCode = 1 }
  }
  fs.writeFileSync('recovery-platform-result.json', JSON.stringify(result, null, 2) + '\n')
  console.log(JSON.stringify(result, null, 2))
  fs.rmSync(parent, { recursive: true, force: true })
}
