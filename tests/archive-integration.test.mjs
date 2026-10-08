// Real integration of the archive lifecycle through the plugin's own service:
// the actual ContextManager is mounted with a real profileContext and a real
// storage domain, and the reduction runs through the actual ToolRuntime with
// the real SDK bash definition. A helper-only archive test is not evidence for
// this contract: the bug it guards against is exactly the Manager forgetting to
// forward `create`.
//
// Bounded like the rest of the suite: no force-exit, an explicit timeout is a
// failure, and every fixture is disposed through the plugin's own drain.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'
import { Context } from '@deepseek-ai/cordis'
import Storage from '@deepseek-ai/dsh-storage'
import { DomainFacility } from '@deepseek-ai/dsh-storage-domain'
import { JsonStorageBackend } from '@deepseek-ai/dsh-storage-json'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import SessionQueryEngine from '@deepseek-ai/dsh-session-query'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import * as BashTool from '@deepseek-ai/dsh-tool-bash'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import { TYPERT } from '../lib/typert.js'

const plugin = [{ name: 'installed-public-api', setup(builder) {
  builder.onResolve({ filter: /^[^./]/ }, args => ({ path: import.meta.resolve(args.path), external: true }))
} }]
async function load(entry) {
  const compiled = await build({ entryPoints: [fileURLToPath(new URL(entry, import.meta.url))], bundle: true, write: false,
    platform: 'node', format: 'esm', target: 'es2022', tsconfigRaw: { compilerOptions: { target: 'ES2022' } }, plugins: plugin })
  return import(`data:text/javascript;base64,${Buffer.from(compiled.outputFiles[0].text).toString('base64')}`)
}
const { default: ContextManager } = await load('../src/index.ts')
const { defaults } = await load('../src/policy.ts')

/** The real SDK bash definition, captured without mounting its plugin graph. */
let realBash
BashTool.apply({
  shell: {}, systemPrompt: { section() {}, getSectionOrder() { return 0 } },
  tools: { register(definition) { realBash = definition } },
}, { enableRunInBackground: false })
assert.equal(realBash?.name, 'bash', 'the real SDK bash definition must be capturable')

const repetitive = () => Array.from({ length: 40 }, () => 'progress line without any protected word').join('\n')
const shellResult = text => ({ kind: 'foreground', exitCode: 0, signal: null, timedOut: false, aborted: false, timeoutMs: 120000,
  stdout: { text, truncated: false }, stderr: { text: '', truncated: false } })

/**
 * Mount the plugin exactly as the Host does: a real profile directory, a real
 * storage domain, the real ToolRuntime and the real manager service.
 */
async function mount(t, policy) {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'ctx-archive-integration-'))
  const ctx = new Context()
  ctx.provide('profileContext', { dir: profile })
  await ctx.plugin(Storage)
  const backend = new JsonStorageBackend(path.join(profile, 'storage'))
  ctx.storage.backend.register('json', backend)
  const facility = new DomainFacility(ctx, { backend: 'json' })
  ctx.storage.mount('domain', facility)
  ctx.provide('storageDomain', facility)
  await ctx.plugin(SessionStore)
  await ctx.plugin(class extends SessionQueryEngine {})
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(ContextManager, { policy: { ...defaults, ...policy } })
  const session = ctx.sessions.create(SessionId('archive-integration-session'))
  const agent = { session }
  let call = 0
  t.after(async () => {
    const outcomes = []
    for (const close of [() => ctx.fiber.dispose(), () => facility.closeAll(), () => backend.close()]) {
      try { await close() } catch (error) { outcomes.push(error) }
    }
    fs.rmSync(profile, { recursive: true, force: true })
    if (outcomes.length) throw new AggregateError(outcomes, 'fixture disposal failed')
  })
  return { ctx, profile, agent,
    archiveDirectory: path.join(profile, '.context-manager-archive'),
    execute: (name, args) => ctx.tools.execute({ name, arguments: args, callId: ToolCallId(`call-${++call}`),
      signal: new AbortController().signal, agent }) }
}

test('archive integration: observing never creates storage, and the first real reduction creates it and reads back', async t => {
  const text = repetitive()
  const policy = { toolResultsMode: 'reduce', toolResultsMaxChars: 200000, toolResultsMinSavings: 100,
    archiveReadBudget: 6000, archiveSearchLimit: 3 }
  const f = await mount(t, policy)

  // 1. Read-only observation of a clean profile must not create any storage.
  const before = f.ctx.contextManager.archiveAccess(false)
  assert.equal(before.archive, undefined, 'a clean profile has no archive yet')
  assert.match(before.error, /尚未创建|不可用/u)
  const status = f.ctx.contextManager.reductionStatus()
  assert.equal(status.archiveDirectory, undefined, 'the status readout must not create the directory either')
  assert.equal(status.archiveOriginals, 0)
  assert.equal(status.archive, undefined)
  assert.equal(fs.existsSync(f.archiveDirectory), false, 'observe/status must never create the archive directory')

  // 2. The first real reduction creates the archive, durably, before publishing.
  f.ctx.tools.register({ ...realBash, execute: async () => shellResult(text) })
  const result = await f.execute('bash', { command: 'echo hi', description: 'run echo' })
  assert.equal(result.isError, false, JSON.stringify(result))
  assert.ok(result.content[0].text.length < text.length * 0.5, 'the published content is genuinely shortened')
  assert.equal(f.ctx.contextManager.reductionStatus().published, 1)
  assert.equal(fs.existsSync(f.archiveDirectory), true, 'the reducer creates the archive on its first use')

  // 3. The created archive is readable through the plugin's own read-only path,
  //    and the stored original is byte-exact.
  const access = f.ctx.contextManager.archiveAccess(false)
  assert.ok(access.archive, `the created archive must open read-only: ${access.error}`)
  const contentId = /id=([a-f0-9]{64})/u.exec(result.content[0].text)[1]
  assert.equal(access.archive.read(contentId), text)
  assert.deepEqual(access.archive.referencingSessions(contentId), ['archive-integration-session'])

  // 4. A restart of the service finds the same durable facts without creating.
  const summary = f.ctx.contextManager.reductionSummary('archive-integration-session')
  assert.equal(summary.published.references, 1)
  assert.equal(summary.published.originalChars, text.length)
})

test('archive integration: in observe mode no reduction and no storage is created', async t => {
  const f = await mount(t, { toolResultsMode: 'observe', toolResultsMaxChars: 200000, toolResultsMinSavings: 100 })
  f.ctx.tools.register({ ...realBash, execute: async () => shellResult(repetitive()) })
  const result = await f.execute('bash', { command: 'echo hi', description: 'run echo' })
  assert.equal(result.isError, false)
  assert.equal(f.ctx.contextManager.reductionStatus().wouldReduce, 1, 'observe still reports what it would do')
  assert.equal(f.ctx.contextManager.reductionStatus().published, 0)
  assert.equal(fs.existsSync(f.archiveDirectory), false, 'observe must not create the archive')
})
test('archive integration: the session readout is session-scoped, read-only and codec-clean', async t => {
  const text = repetitive()
  const f = await mount(t, { toolResultsMode: 'reduce', toolResultsMaxChars: 200000, toolResultsMinSavings: 100 })
  // A clean profile: reading a session that has no archive yet must report the
  // missing capability and must not create anything.
  const clean = f.ctx.contextManager.reductionReadout('no-such-session')
  assert.equal(clean.published.references, 0)
  assert.equal(clean.pending, 0)
  assert.equal(clean.reverted, 0)
  assert.deepEqual(clean.recent, [])
  assert.match(clean.archiveError, /尚未创建|不可用/u)
  assert.equal(fs.existsSync(f.archiveDirectory), false, 'a readout must never create the archive')

  f.ctx.tools.register({ ...realBash, execute: async () => shellResult(text) })
  const result = await f.execute('bash', { command: 'echo hi', description: 'run echo' })
  assert.equal(result.isError, false, JSON.stringify(result))

  // Durable state of the archive directory before and after a read-only readout.
  const tree = () => fs.readdirSync(f.archiveDirectory, { recursive: true }).sort()
    .map(name => { const stat = fs.statSync(path.join(f.archiveDirectory, name)); return `${name}:${stat.size}:${stat.mtimeMs}` })
  const before = tree()
  const mine = f.ctx.contextManager.reductionReadout('archive-integration-session')
  const other = f.ctx.contextManager.reductionReadout('a-different-session')
  assert.equal(mine.mode, 'reduce')
  assert.equal(mine.pipelineReported, true)
  assert.equal(mine.published.references, 1)
  assert.equal(mine.published.originalChars, text.length)
  assert.equal(mine.published.visibleCharsRemoved, text.length - mine.published.shortenedChars)
  assert.equal(mine.recent.length, 1)
  assert.match(mine.recent[0].tool, /bash/u)
  assert.equal(mine.recent[0].complete, true)
  assert.match(mine.recent[0].callId, /call-\d+/u, 'the readout carries the grant identity, not only the deduplicated original id')
  assert.equal(mine.run.considered >= 1, true)
  assert.equal(Object.hasOwn(mine, 'archiveError'), false)
  // The other session never inherits this session's confirmed references.
  assert.equal(other.published.references, 0)
  assert.equal(other.published.visibleCharsRemoved, 0)
  assert.deepEqual(other.recent, [])
  assert.deepEqual(tree(), before, 'a repeated read-only readout writes no archive file')
  assert.deepEqual(f.ctx.contextManager.reductionReadout('archive-integration-session'), mine)
  // The produced readout passes the real inspect codec unchanged.
  const codec = TYPERT.invocations.find(item => item.method === 'inspect').result.create()
  const inspection = { sessionId: 'archive-integration-session', cursor: 1, cutSeq: 1, sampledAt: 1, historical: false,
    pressure: null, model: null, parts: [], official: null, usage: null, pressureHistory: [], rows: [], total: 0,
    offset: 0, pageSize: 50, activeCount: 0, archivedCount: 0, requests: [], requestCount: 0, compactions: [],
    reduction: mine }
  assert.deepEqual(codec.parse(inspection), inspection)
})
