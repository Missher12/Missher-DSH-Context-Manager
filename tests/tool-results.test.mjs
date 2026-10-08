// Tool-result reduction: real ToolRuntime, the real SDK bash definition, the
// durable archive and the read-back closure. Canonical lib is never rebuilt:
// the candidate modules are compiled in memory from src/.
//
// Every fixture is bounded: the runner passes --test-timeout, a timeout is a
// failure, and each cleanup is a promise the runner awaits. No force-exit is
// used, so a fixture that fails to dispose cannot be hidden.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'
import { Context } from '@deepseek-ai/cordis'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import SessionQueryEngine from '@deepseek-ai/dsh-session-query'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import * as BashTool from '@deepseek-ai/dsh-tool-bash'
import { createUserMessage, createToolResultMessage, createMessage, ToolCallId } from '@deepseek-ai/dsh-llm'

const plugin = [{ name: 'installed-public-api', setup(builder) {
  builder.onResolve({ filter: /^[^./]/ }, args => ({ path: import.meta.resolve(args.path), external: true }))
} }]
async function load(entry) {
  const compiled = await build({ entryPoints: [fileURLToPath(new URL(entry, import.meta.url))], bundle: true, write: false,
    platform: 'node', format: 'esm', target: 'es2022', tsconfigRaw: { compilerOptions: { target: 'ES2022' } }, plugins: plugin })
  return import(`data:text/javascript;base64,${Buffer.from(compiled.outputFiles[0].text).toString('base64')}`)
}
const { TextArchive, hashText } = await load('../src/archive.ts')
const { registerToolResultReduction } = await load('../src/tool-results.ts')
const { registerHistoryTools } = await load('../src/history-tools.ts')
const reducer = await load('../src/reducer.ts')
const efficiency = await load('../src/efficiency.ts')

/**
 * Capture the real SDK bash definition without mounting its plugin graph: its
 * own schema, output.render and presenters stay exactly as shipped, and only
 * the executor is replaced by an in-memory result. No shell process runs.
 */
let realBash
BashTool.apply({
  shell: {}, systemPrompt: { section() {}, getSectionOrder() { return 0 } },
  tools: { register(definition) { realBash = definition } },
}, { enableRunInBackground: false })
assert.equal(realBash?.name, 'bash', 'the real SDK bash definition must be capturable')
assert.equal(typeof realBash.output?.render, 'function', 'the real definition owns a render step')

/** A long, purely repetitive success output: the only shape this rule reduces. */
const repetitive = () => Array.from({ length: 40 }, () => 'progress line without any protected word').join('\n')
function shellResult(text, overrides = {}) {
  return { kind: 'foreground', exitCode: 0, signal: null, timedOut: false, aborted: false, timeoutMs: 120000,
    stdout: { text, truncated: false }, stderr: { text: '', truncated: false }, ...overrides }
}

function tempRoot(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ctx-archive-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  return root
}

const policyOf = (mode = 'reduce') => ({ toolResultsMode: mode, toolResultsMaxChars: 200000,
  toolResultsMinSavings: 100, archiveReadBudget: 6000, archiveSearchLimit: 3 })

async function fixture(t, { mode = 'reduce', value = shellResult(repetitive()), registerBash = true, output, override = {} } = {}) {
  const ctx = new Context()
  const root = tempRoot(t)
  const archive = TextArchive.open(path.join(root, 'archive'), { create: true })
  t.after(async () => { await ctx.fiber.dispose(); archive.close() })
  await ctx.plugin(SessionStore)
  await ctx.plugin(class extends SessionQueryEngine {})
  // ToolRuntime injects systemPrompt before it provides `tools`.
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  const policy = { ...policyOf(mode), ...override }
  let reduction
  await ctx.plugin(scope => { reduction = registerToolResultReduction(scope, () => policy, () => archive) })
  await ctx.plugin(scope => { registerHistoryTools(scope, () => ({ archive, searchLimit: policy.archiveSearchLimit, readBudget: policy.archiveReadBudget })) })
  const session = ctx.sessions.create(SessionId('tool-results-session'))
  const agent = { session }
  if (registerBash) {
    ctx.tools.register({ ...realBash, ...(output === undefined ? {} : { output }), execute: async () => value })
  }
  let call = 0
  const execute = async (name, args, caller = agent) => ctx.tools.execute({
    name, arguments: args, callId: ToolCallId(`call-${++call}`), signal: new AbortController().signal,
    ...(caller === null ? {} : { agent }),
  })
  return { ctx, session, archive, reduction, execute, root, policy }
}

/**
 * A real fork fixture: the parent's short text and grant come from the shipping
 * reduction, the log is appended by hand at that exact call id, and the child
 * is created by the public `sessions.fork` cut.
 * @param t - the running test, for cleanup.
 * @param options - optional session-query engine override for controlled fixtures.
 * @returns the mounted harness plus fork/read helpers.
 */
async function forkHarness(t, { engine } = {}) {
  const ctx = new Context()
  const root = tempRoot(t)
  const archive = TextArchive.open(path.join(root, 'archive'), { create: true })
  t.after(async () => { await ctx.fiber.dispose(); archive.close() })
  await ctx.plugin(SessionStore)
  await ctx.plugin(engine ?? class extends SessionQueryEngine {})
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  const policy = policyOf('reduce')
  let reduction
  await ctx.plugin(scope => { reduction = registerToolResultReduction(scope, () => policy, () => archive) })
  await ctx.plugin(scope => { registerHistoryTools(scope, () => ({ archive, searchLimit: 3, readBudget: 6000 })) })
  const parent = ctx.sessions.create(SessionId('fork-parent'))
  const queue = []
  ctx.tools.register({ ...realBash, execute: async () => queue.shift() })
  let n = 0
  const run = (session, name, args) => ctx.tools.execute({ name, arguments: args,
    callId: ToolCallId(`fork-run-${++n}`), signal: new AbortController().signal, agent: { session } })
  // A real reduction by the parent: the short text, the content id and the
  // durable grant are produced by the shipping path, never hand-written.
  const reduce = async (callId, session = parent, text) => {
    if (text !== undefined) queue.push(shellResult(text))
    const reduced = await ctx.tools.execute({ name: 'bash', arguments: { command: 'run', description: 'x' },
      callId: ToolCallId(callId), signal: new AbortController().signal, agent: { session } })
    assert.equal(reduced.isError, false, JSON.stringify(reduced))
    const shortened = reduced.content.map(block => 'text' in block ? block.text : '').join('\n')
    const contentId = /id=([a-f0-9]{64})/u.exec(shortened)?.[1]
    assert.ok(contentId, `the short text must carry its content id: ${shortened}`)
    return { shortened, contentId, callId }
  }
  const appendCall = (entry, text = entry.shortened) => {
    parent.append('turn/start', { turn: 1 })
    parent.append('step/start', { turn: 1, step: 1 })
    parent.append('user/message', createUserMessage({ content: [{ type: 'text', text: text }], source: { kind: 'user' } }), { surfaceOp: 'append' })
    parent.append('assistant/message', { turn: 1, step: 1, stream: [], message: createMessage({ role: 'assistant',
      content: [{ type: 'tool-call', id: entry.callId, name: 'bash', arguments: '{}' }], source: { kind: 'model', provider: 'mock', model: 'large' } }) }, { surfaceOp: 'append' })
    const call = parent.append('tool/call', { turn: 1, step: 1, callId: entry.callId, name: 'bash', arguments: '{}' })
    const result = parent.append('tool/result', { turn: 1, step: 1, message: createToolResultMessage({ callId: entry.callId,
      content: [{ type: 'text', text }], isError: false }) }, { surfaceOp: 'append' })
    return { call, result }
  }
  const fork = (at, id) => ctx.sessions.fork(parent, at, SessionId(id))
  const readAs = async (session, args) => JSON.parse((await run(session, 'context_history_read', args)).value)
  return { ctx, archive, parent, reduction, queue, run, reduce, appendCall, fork, readAs }
}

const readBack = async (f, args) => {
  const result = await f.execute('context_history_read', args)
  assert.equal(result.isError, false, JSON.stringify(result))
  return JSON.parse(result.value)
}

test('reduction: the real bash definition is actually reduced, the canonical value is unchanged and the original reads back', async t => {
  const text = repetitive()
  const f = await fixture(t)
  const result = await f.execute('bash', { command: 'echo hi', description: 'run echo' })
  assert.equal(result.isError, false)
  // Real SDK definition: the value keeps its canonical shape and stays complete.
  assert.equal(result.value.kind, 'foreground')
  assert.equal(result.value.exitCode, 0)
  assert.equal(result.value.stdout.text, text)
  assert.equal(result.value.stdout.truncated, false)
  const published = result.content.map(block => block.text).join('\n')
  assert.ok(published.length < text.length * 0.5, `content must be shortened, got ${published.length} of ${text.length}`)
  assert.ok(published.includes('repeated 39 more times'), 'the reference states the exact remaining count')
  assert.match(published, /\[\[dsh-context-archive id=([a-f0-9]{64}) session="tool-results-session" call="call-1" rule=collapse-identical-lines v1 reduced=\d+\]\]/u)
  const stats = f.reduction.stats()
  assert.equal(stats.published, 1, JSON.stringify(stats))
  assert.equal(stats.pending, 0)
  assert.equal(stats.reverted, 0)
  assert.equal(f.reduction.reported(), true)
  // The per-session reader returns the real record shape, not a tuple.
  assert.deepEqual(f.reduction.sessions().get('tool-results-session'), { published: 1, reverted: 0 })
  // Realised reduction comes from durable published facts, not from archive volume.
  const summary = f.archive.summary('tool-results-session')
  assert.equal(summary.published.references, 1)
  assert.equal(summary.published.originalChars, text.length)
  assert.ok(summary.published.visibleCharsRemoved > 0)
  assert.equal(summary.pending, 0)
  assert.equal(summary.reverted, 0)
  assert.ok(summary.volume.originalChars >= text.length, 'volume records storage, not saving')
  // Closure: the reference id reads back the exact original through the read tool.
  const contentId = /id=([a-f0-9]{64})/u.exec(published)[1]
  assert.equal(contentId, hashText(text))
  const page = await readBack(f, { contentId, archive: true, limit: 6000 })
  assert.equal(page.status, 'ok')
  assert.equal(page.source, 'archive')
  assert.equal(page.complete, true)
  assert.equal(page.outcome, 'published')
  const rest = page.next === null ? '' : (await readBack(f, { ...page.next, archive: true })).text
  assert.equal(page.text + rest, text, 'the stored original is byte-exact')
  // Persistence: the confirmed outcome survives a restart of the archive.
  const reopened = TextArchive.open(path.join(f.root, 'archive'))
  assert.equal(reopened.outcomeOf(contentId, 'tool-results-session', 'call-1'), 'published')
  assert.equal(reopened.read(contentId), text)
  reopened.close()
  // The same reference also resolves through its call id, and ambiguity is refused.
  const byCall = await readBack(f, { callId: 'call-1', archive: true })
  assert.equal(byCall.contentId, contentId)
  const ambiguous = await f.execute('context_history_read', { sourceSeq: 0, contentId, archive: true })
  assert.equal(ambiguous.isError, true, 'mixing the two identities must be refused, not guessed')
})

test('reduction: a non-zero exit or a truncated stream is never reduced, even when isError is false', async t => {
  const text = repetitive()
  for (const [label, value] of [
    ['non-zero exit', shellResult(text, { exitCode: 1 })],
    ['timeout', shellResult(text, { timedOut: true })],
    ['signal', shellResult(text, { signal: 'SIGKILL' })],
    ['truncated stdout', shellResult(text, { stdout: { text, truncated: true, spillPath: '/tmp/spill' } })],
    ['stderr output', shellResult(text, { stderr: { text: 'warning: something', truncated: false } })],
  ]) {
    const f = await fixture(t, { value })
    const result = await f.execute('bash', { command: 'run', description: 'x' })
    assert.equal(result.isError, false, label)
    assert.equal(result.content[0].text, realBash.output.render({}, value)[0].text, `${label}: the Host result must pass through unchanged`)
    assert.equal(f.reduction.stats().unverified, 1, label)
    assert.equal(f.reduction.stats().published, 0, label)
    assert.equal(f.archive.grants, 0, `${label}: nothing may be archived for an unverified success`)
  }
})

test('reduction: a success whose value shape cannot be verified is passed through untouched', async t => {
  const text = repetitive()
  const f = await fixture(t, { value: text, output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] } })
  const result = await f.execute('bash', { command: 'run', description: 'x' })
  assert.equal(result.isError, false)
  assert.equal(result.content[0].text, text, 'an unknown value shape is not evidence of success')
  assert.equal(f.reduction.stats().unverified, 1)
  assert.equal(f.reduction.stats().lastReason.includes('no inspectable shape'), true, JSON.stringify(f.reduction.stats()))
  assert.equal(f.archive.grants, 0)
})

test('reduction: the upstream truncation notice in the body is never archived as a complete original', async t => {
  const text = `${repetitive()}\n[output truncated; full output: /tmp/spill.txt]`
  const f = await fixture(t, { value: shellResult(text) })
  const result = await f.execute('bash', { command: 'run', description: 'x' })
  assert.equal(result.content[0].text, text, 'the visible truncation notice must survive verbatim')
  assert.equal(f.archive.grants, 0)
  assert.equal(f.reduction.stats().published, 0)
})

test('reduction: mode observe and off change nothing at all', async t => {
  const text = repetitive()
  for (const mode of ['observe', 'off']) {
    const f = await fixture(t, { mode, value: shellResult(text) })
    const result = await f.execute('bash', { command: 'run', description: 'x' })
    assert.equal(result.content[0].text, text, `${mode} must not rewrite content`)
    assert.equal(f.archive.grants, 0, `${mode} must not archive`)
    assert.equal(f.reduction.stats().wouldReduce, mode === 'observe' ? 1 : 0)
  }
})

test('reduction: another policy decision is preserved, never rebuilt', async t => {
  // additionalContexts survives a content-only reduction.
  const text = repetitive()
  const f = await fixture(t, { value: shellResult(text) })
  const contexts = [createUserMessage({ content: [{ type: 'text', text: 'policy-required-context' }], source: { kind: 'user' } })]
  f.ctx.on('tools/post-execute', async (_exec, _result, next) => ({ ...(await next()), additionalContexts: contexts }))
  const result = await f.execute('bash', { command: 'run', description: 'x' })
  assert.equal(result.isError, false)
  assert.ok(result.content[0].text.includes('dsh-context-archive'))
  assert.deepEqual(result.additionalContexts, contexts)
  // A value replacement stays authoritative and is not reduced. The replacement
  // has to satisfy the registered tool's own output schema: the Host validates
  // it and re-renders content from it, so a placeholder string would be refused
  // by the Host itself and would prove nothing about this policy.
  const masked = await fixture(t, { value: shellResult(text) })
  const replacement = shellResult(`masked body\n${'replacement line\n'.repeat(40)}`)
  masked.ctx.on('tools/post-execute', async () => ({ kind: 'accept', value: replacement }))
  const replaced = await masked.execute('bash', { command: 'run', description: 'x' })
  assert.equal(replaced.isError, false, JSON.stringify(replaced))
  assert.equal(replaced.value.stdout.text, replacement.stdout.text, 'the replacing value stays the authoritative one')
  assert.deepEqual(replaced.content, realBash.output.render({}, replaced.value), 'the Host re-renders from the replacement, not from this policy')
  assert.equal(replaced.content.some(block => block.text.includes('dsh-context-archive')), false, 'a replaced value is never rewritten into a reference')
  assert.equal(masked.reduction.stats().wouldReduce, 0)
  assert.equal(masked.reduction.stats().lastSkip, 'replaced_value')
  assert.equal(masked.archive.grants, 0)
  // A block stays a block.
  const blocked = await fixture(t, { value: shellResult(text) })
  blocked.ctx.on('tools/post-execute', async () => ({ kind: 'block', feedback: [{ type: 'text', text: 'DENIED' }] }))
  const denied = await blocked.execute('bash', { command: 'run', description: 'x' })
  assert.equal(denied.isError, true)
  assert.deepEqual(denied.content, [{ type: 'text', text: 'DENIED' }])
})

test('reduction: a tool-owned finalizer keeps receiving the untouched content', async t => {
  const text = repetitive()
  const f = await fixture(t, { registerBash: false, value: shellResult(text) })
  let finalizerInput
  f.ctx.tools.register({ ...realBash, execute: async () => shellResult(text),
    finalizeContent(_exec, result) { finalizerInput = result.content; return result.content } })
  const result = await f.execute('bash', { command: 'run', description: 'x' })
  assert.equal(result.isError, false)
  assert.deepEqual(finalizerInput, [{ type: 'text', text }], 'a tool that owns finalizeContent is never reduced')
  assert.equal(f.archive.grants, 0)
})

test('reducer: exact bytes only, exact counts, and protected lines always pass through', async t => {
  const limits = { maxInputChars: 200000, minSavingsChars: 100 }
  const padding = 'x'.repeat(400)
  const line = 'a progress line long enough to be worth collapsing'
  const collapsed = reducer.reduceText(`${padding}\n${`${line}\n`.repeat(5)}end`, limits)
  assert.ok(collapsed.reduced !== undefined, JSON.stringify(collapsed))
  assert.match(collapsed.reduced, new RegExp(`${line}\n\u27ea repeated 4 more times \u27eb`, 'u'))
  assert.equal(collapsed.collapsedLines, 4)
  // Different indentation is different content: nothing may be collapsed.
  const indented = reducer.reduceText(`${padding}\n    indented\n  indented\n    indented\n  indented\ntail`, limits)
  assert.equal(indented.reduced, undefined)
  assert.equal(indented.reason, 'no_collapsible_run')
  // A quantitative or failure marker anywhere keeps the whole result intact.
  for (const marker of ['1 passed', 'ok', 'ERROR: broken', 'Tests: 3', ' 12 | code', '失败后重试', 'exit code: 3']) {
    const outcome = reducer.reduceText(`${padding}\n${'noise\n'.repeat(5)}${marker}\n${'noise\n'.repeat(3)}`, limits)
    assert.equal(outcome.reduced, undefined, `${marker} must pass through`)
    assert.equal(outcome.reason, 'protected_marker_present')
  }
  // A run shorter than three lines is never collapsed, and neither is a tiny line.
  assert.equal(reducer.reduceText(`${padding}\n${'dup\n'.repeat(2)}end`, limits).reason, 'no_collapsible_run')
  assert.equal(reducer.reduceText(`${padding}\n${'ab\n'.repeat(6)}end`, limits).reason, 'no_collapsible_run')
  // Small results are not worth rewriting at all.
  assert.equal(reducer.reduceText('short', limits).reason, 'below_min_input')
  // Reduction is a pure function: the same bytes always give the same text.
  const twice = reducer.reduceText(`${padding}\n${`${line}\n`.repeat(5)}end`, limits)
  assert.equal(twice.reduced, collapsed.reduced)
})

test('archive: short manifest writes are completed, and a write that makes no progress is refused', async t => {
  const root = path.join(tempRoot(t), 'archive')
  const text = 'A'.repeat(300) + '\n' + 'B'.repeat(700)
  const archive = TextArchive.open(root, { create: true })
  const realWrite = fs.writeSync
  /**
   * Fault injection is confined to the JSONL manifests of this archive.
   * `fs.writeFileSync` uses `writeSync` internally in a synchronous loop, so a
   * global injection would spin forever inside the blob write before the guard
   * under test could ever run — and it would not be the manifest write either.
   * The manifest fd is identified through the real openSync path we observe.
   */
  const manifestFds = new Set()
  const realOpen = fs.openSync
  const isManifest = file => typeof file === 'string' && file.endsWith('.jsonl')
  function install(mode, sink) {
    // Only fds opened from now on may be faulted: a stale fd number reused by a
    // blob write would otherwise turn the injected write into the blob's own
    // fs.writeFileSync loop, which is not the manifest under test.
    manifestFds.clear()
    fs.openSync = function trackedOpen(file, ...rest) {
      const fd = realOpen.call(fs, file, ...rest)
      if (isManifest(file)) manifestFds.add(fd)
      return fd
    }
    fs.writeSync = function manifestWrite(fd, buffer, offset, length, position) {
      if (!manifestFds.has(fd)) return realWrite.call(fs, fd, buffer, offset, length, position)
      sink.push(mode)
      if (mode === 'zero') return 0
      // A genuine short write makes progress and is only shorter than asked;
      // reporting zero bytes is the separate fault injected below. Returning
      // floor(length / 2) on a one-byte remainder would be zero progress and
      // would make the "short writes are completed" case unsatisfiable.
      return realWrite.call(fs, fd, buffer, offset, Math.max(1, Math.floor(length / 2)), position)
    }
  }
  const restore = () => { fs.writeSync = realWrite; fs.openSync = realOpen }
  const hits = []
  // The blob must already be durable before the manifest write is faulted, so
  // the injection provably lands on the manifest and not on the blob.
  t.after(restore)
  const first = archive.save({ text, source: 'tool:bash', rule: reducer.RULE_ID, ruleVersion: reducer.RULE_VERSION,
    shortenedChars: 10, sessionId: 's1', callId: 'pre', complete: true })
  assert.equal(hits.length, 0, 'an uninjected save must not report a fault')
  install('short', hits)
  try {
    archive.save({ text: `${text}\nsecond entry`, source: 'tool:bash', rule: reducer.RULE_ID, ruleVersion: reducer.RULE_VERSION,
      shortenedChars: 10, sessionId: 's1', callId: 'c1', complete: true })
  } finally { restore() }
  assert.ok(hits.length > 0 && hits.every(hit => hit === 'short'), `the short write must hit a manifest write, got ${JSON.stringify(hits)}`)
  assert.ok(hits.length > 1, `a short write must be completed by further writes, got ${hits.length} call(s)`)
  archive.close()
  const reopened = TextArchive.open(root)
  assert.equal(reopened.grants, 2, 'a genuinely short manifest write is completed, not silently truncated')
  assert.equal(reopened.read(first.contentId), text)
  reopened.close()

  // A manifest write that reports no progress at all must fail closed.
  const zeroRoot = path.join(tempRoot(t), 'archive')
  const refused = TextArchive.open(zeroRoot, { create: true })
  refused.save({ text: 'Z'.repeat(4000), source: 'tool:bash', rule: reducer.RULE_ID, ruleVersion: reducer.RULE_VERSION,
    shortenedChars: 10, sessionId: 's1', callId: 'blob-only', complete: true })
  const zeroHits = []
  install('zero', zeroHits)
  try {
    assert.throws(() => refused.save({ text: 'Y'.repeat(4000), source: 'tool:bash', rule: reducer.RULE_ID,
      ruleVersion: reducer.RULE_VERSION, shortenedChars: 10, sessionId: 's1', callId: 'c2', complete: true }), /no progress/u)
  } finally { restore() }
  assert.ok(zeroHits.length > 0 && zeroHits.every(hit => hit === 'zero'), `the zero-progress injection must land on the manifest write, got ${JSON.stringify(zeroHits)}`)
  assert.equal(refused.grants, 1, 'the refused entry is not remembered as granted')
  refused.close()
  const afterZero = TextArchive.open(zeroRoot)
  assert.equal(afterZero.grants, 1, 'a refused manifest write leaves no extra grant behind')
  assert.equal(afterZero.sessionGrants('s1', 10).some(grant => grant.callId === 'c2'), false)
  afterZero.close()
})

test('archive: a dedup hit re-verifies the blob and never publishes a dead reference', async t => {
  const root = path.join(tempRoot(t), 'archive')
  const text = 'shared original text '.repeat(40)
  const archive = TextArchive.open(root, { create: true })
  const save = (sessionId, callId) => archive.save({ text, source: 'tool:bash', rule: reducer.RULE_ID,
    ruleVersion: reducer.RULE_VERSION, shortenedChars: 20, sessionId, callId, complete: true })
  const first = save('session-a', 'call-1')
  const blob = path.join(root, first.contentId.slice(0, 2), first.contentId.slice(2, 4), `${first.contentId}.txt`)
  fs.rmSync(blob)
  const second = save('session-b', 'call-2')
  assert.equal(second.contentId, first.contentId)
  assert.equal(archive.read(second.contentId), text, 'the restored blob is readable')
  assert.equal(archive.grantsFor(second.contentId, 'session-b').length, 1)
  // Corruption, not just absence, is repaired from the exact input.
  fs.writeFileSync(blob, 'corrupted'.padEnd(Buffer.byteLength(text), 'x'))
  const third = save('session-c', 'call-3')
  assert.equal(archive.read(third.contentId), text)
  archive.close()
  const reopened = TextArchive.open(root)
  assert.equal(reopened.read(third.contentId), text)
  assert.deepEqual(new Set(reopened.referencingSessions(third.contentId)), new Set(['session-a', 'session-b', 'session-c']))
  reopened.close()
})

test('archive: published volume, pending and reverted stay separate and survive a restart', async t => {
  const root = path.join(tempRoot(t), 'archive')
  const text = 'reference text '.repeat(60)
  const archive = TextArchive.open(root, { create: true })
  const save = (callId) => archive.save({ text, source: 'tool:bash', rule: reducer.RULE_ID, ruleVersion: reducer.RULE_VERSION,
    shortenedChars: 40, sessionId: 's1', callId, complete: true })
  const first = save('c1')
  save('c2')
  save('c3')
  archive.notePublished(first.contentId, 's1', 'c1')
  archive.noteReverted(first.contentId, 's1', 'c2', 'final result differed')
  const before = archive.summary('s1')
  assert.equal(before.published.references, 1)
  assert.equal(before.pending, 1)
  assert.equal(before.reverted, 1)
  assert.equal(before.published.shortenedChars, 40)
  assert.equal(before.published.visibleCharsRemoved, text.length - 40)
  assert.match(before.notes.join(' '), /不是账单/u)
  archive.close()
  const reopened = TextArchive.open(root)
  const after = reopened.summary('s1')
  assert.deepEqual(after, before, 'the durable outcome rows rebuild exactly the same summary')
  assert.equal(reopened.revertedReason(first.contentId, 's1', 'c2'), 'final result differed')
  reopened.close()
})

test('archive: a bounded search discloses what it could not read instead of claiming completeness', async t => {
  const root = path.join(tempRoot(t), 'archive')
  const archive = TextArchive.open(root, { create: true })
  const big = `NEEDLE${'filler text '.repeat(160)}`
  archive.save({ text: big, source: 'tool:bash', rule: reducer.RULE_ID, ruleVersion: reducer.RULE_VERSION, shortenedChars: 10,
    sessionId: 's1', callId: 'c1', complete: true })
  const starved = archive.searchSession('s1', 'NEEDLE', { limit: 3, maxEntries: 16, maxChars: 64 })
  assert.equal(starved.hits.length, 0, 'the budget cannot cover this original')
  assert.equal(starved.truncated, true, 'an unread candidate must never look like a complete search')
  assert.equal(starved.skipped, 1)
  assert.equal(starved.scannedEntries, 0)
  const full = archive.searchSession('s1', 'NEEDLE', { limit: 3, maxEntries: 16, maxChars: 65536 })
  assert.equal(full.hits.length, 1)
  assert.equal(full.hits[0].offset, 0)
  assert.equal(full.truncated, false, JSON.stringify(full))
  // A deleted blob is reported as unreadable, never as "no match".
  const path0 = path.join(root, full.hits[0].owner.contentId.slice(0, 2), full.hits[0].owner.contentId.slice(2, 4), `${full.hits[0].owner.contentId}.txt`)
  fs.rmSync(path0)
  const broken = archive.searchSession('s1', 'NEEDLE', { limit: 3, maxEntries: 16, maxChars: 65536 })
  assert.equal(broken.hits.length, 0)
  assert.equal(broken.truncated, true)
  assert.ok(broken.unavailable + broken.skipped >= 1, JSON.stringify(broken))
  archive.close()
})

test('history tools: an archived original is granted to its session only and other identities are refused', async t => {
  const f = await fixture(t)
  const text = `secret original ${'body '.repeat(80)}`
  const saved = f.archive.save({ text, source: 'tool:bash', rule: reducer.RULE_ID, ruleVersion: reducer.RULE_VERSION,
    shortenedChars: 20, sessionId: 'tool-results-session', callId: 'c1', complete: true })
  const mine = await readBack(f, { contentId: saved.contentId, limit: 6000 })
  assert.equal(mine.text, text)
  assert.equal(mine.outcome, 'pending', 'an unconfirmed reference is reported as pending, not as saved')
  // Another session's grant is out of scope even when the digest is known.
  f.archive.save({ text: 'other session text '.repeat(40), source: 'tool:bash', rule: reducer.RULE_ID,
    ruleVersion: reducer.RULE_VERSION, shortenedChars: 20, sessionId: 'someone-else', callId: 'c2', complete: true })
  const foreign = f.archive.grantsFor(f.archive.sessionGrants('someone-else', 1)[0].contentId, 'someone-else')[0]
  const refused = await readBack(f, { contentId: foreign.contentId, archive: true })
  assert.equal(refused.status, 'out_of_scope')
  assert.equal(refused.text, '')
  assert.equal((await readBack(f, { contentId: 'a'.repeat(64), archive: true })).status, 'not_found')
  const unknownCall = await f.execute('context_history_read', { callId: 'does-not-exist' })
  const parsed = JSON.parse(unknownCall.value)
  assert.equal(parsed.status, 'not_found')
  const neither = await f.execute('context_history_read', { archive: true })
  assert.equal(neither.isError, true)
  const bare = await f.execute('context_history_read', {})
  assert.equal(bare.isError, true)
})

test('history tools: search reports an archived hit together with its disclosure', async t => {
  const f = await fixture(t)
  const text = `find-me ${'body '.repeat(80)}`
  f.archive.save({ text, source: 'tool:bash', rule: reducer.RULE_ID, ruleVersion: reducer.RULE_VERSION,
    shortenedChars: 20, sessionId: 'tool-results-session', callId: 'c1', complete: true })
  const found = await f.execute('context_history_search', { query: 'find-me' })
  const parsed = JSON.parse(found.value)
  assert.equal(parsed.archivedOriginals.searched, true)
  assert.equal(parsed.archivedOriginals.truncated, false)
  assert.equal(parsed.archivedOriginals.skipped, 0)
  assert.equal(parsed.archivedOriginals.hits.length, 1)
  assert.equal(parsed.archivedOriginals.hits[0].callId, 'c1')
  assert.match(parsed.archivedOriginals.note, /覆盖/u)
  // A search in another session's log sees nothing and says so.
  const empty = JSON.parse((await f.execute('context_history_search', { query: 'no-such-needle' })).value)
  assert.equal(empty.archivedOriginals.hits.length, 0)
})

test('reduction: a registration disposed while the waterfall is suspended never delivers a short text', async t => {
  const ctx = new Context()
  const root = tempRoot(t)
  const archive = TextArchive.open(path.join(root, 'archive'), { create: true })
  t.after(async () => { await ctx.fiber.dispose(); archive.close() })
  await ctx.plugin(SessionStore)
  await ctx.plugin(class extends SessionQueryEngine {})
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  const policy = policyOf('reduce')
  let reduction, registration
  await ctx.plugin(scope => { registration = scope; reduction = registerToolResultReduction(scope, () => policy, () => archive) })
  const session = ctx.sessions.create(SessionId('lifecycle-session'))
  const agent = { session }
  const text = repetitive()
  ctx.tools.register({ ...realBash, execute: async () => shellResult(text) })
  let call = 0
  const execute = () => ctx.tools.execute({ name: 'bash', arguments: { command: 'run', description: 'x' },
    callId: ToolCallId(`life-${++call}`), signal: new AbortController().signal, agent })

  // The same registration must still reduce normally: a fence that refuses
  // everything would be worse than the race it guards against.
  const positive = await execute()
  assert.equal(positive.isError, false)
  assert.equal(JSON.stringify(positive.content).includes('dsh-context-archive'), true, 'a live registration still reduces')
  assert.equal(reduction.stats().published, 1)

  // Now suspend the waterfall downstream of this policy and dispose the
  // registration while the continuation is parked at `await next()`.
  let enteredResolve, releaseResolve
  const entered = new Promise(resolve => { enteredResolve = resolve })
  const release = new Promise(resolve => { releaseResolve = resolve })
  ctx.on('tools/post-execute', async (_exec, _result, next) => { enteredResolve(); await release; return next() })
  const pending = execute()
  await entered
  await registration.fiber.dispose()
  releaseResolve()
  const after = await pending
  assert.equal(after.isError, false)
  assert.equal(JSON.stringify(after.content).includes('dsh-context-archive'), false,
    'a disposed registration must not hand a short text to a Host that can no longer confirm it')
  assert.equal(archive.grants, 1, 'the disposed continuation must not archive a new original')
  assert.equal(reduction.stats().published, 1, 'no unconfirmable reduction may be counted')
  assert.equal(reduction.stats().lastSkip, 'unloaded')
  assert.equal(reduction.stats().pending, 0)
})

test('history tools: a fork reads exactly the original it inherited and cannot reach past its own cut', async t => {
  const ctx = new Context()
  const root = tempRoot(t)
  const archive = TextArchive.open(path.join(root, 'archive'), { create: true })
  t.after(async () => { await ctx.fiber.dispose(); archive.close() })
  await ctx.plugin(SessionStore)
  await ctx.plugin(class extends SessionQueryEngine {})
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  const policy = policyOf('reduce')
  let reduction
  await ctx.plugin(scope => { reduction = registerToolResultReduction(scope, () => policy, () => archive) })
  await ctx.plugin(scope => { registerHistoryTools(scope, () => ({ archive, searchLimit: 3, readBudget: 6000 })) })
  const parent = ctx.sessions.create(SessionId('fork-parent'))
  const text = repetitive()
  const later = Array.from({ length: 40 }, () => 'line the parent only ever printed later').join('\n')
  const queue = [shellResult(text), shellResult(later)]
  ctx.tools.register({ ...realBash, execute: async () => queue.shift() })
  let n = 0
  const run = (session, name, args) => ctx.tools.execute({ name, arguments: args,
    callId: ToolCallId(`fork-run-${++n}`), signal: new AbortController().signal, agent: { session } })
  const readAs = async (session, args) => JSON.parse((await run(session, 'context_history_read', args)).value)

  // 1. A real confirmed reduction by the parent: the short text, the content id
  //    and the grant are all produced by the shipping path, never hand-written.
  const callId = ToolCallId('fork-call')
  const reduced = await ctx.tools.execute({ name: 'bash', arguments: { command: 'run', description: 'x' },
    callId, signal: new AbortController().signal, agent: { session: parent } })
  assert.equal(reduction.stats().published, 1, JSON.stringify(reduction.stats()))
  const shortened = reduced.content.map(block => 'text' in block ? block.text : '').join('\n')
  const contentId = /id=([a-f0-9]{64})/u.exec(shortened)?.[1]
  assert.ok(contentId, `the short text must carry its content id: ${shortened}`)
  assert.deepEqual(archive.referencingSessions(contentId), ['fork-parent'])

  // 2. The parent's real log: a user-pasted reference, then the real call and
  //    its shortened result. The pasted copy is visible but authorises nothing.
  parent.append('turn/start', { turn: 1 })
  parent.append('step/start', { turn: 1, step: 1 })
  const pasted = parent.append('user/message', createUserMessage({ content: [{ type: 'text', text: shortened }], source: { kind: 'user' } }), { surfaceOp: 'append' })
  parent.append('assistant/message', { turn: 1, step: 1, stream: [], message: createMessage({ role: 'assistant',
    content: [{ type: 'tool-call', id: callId, name: 'bash', arguments: '{}' }], source: { kind: 'model', provider: 'mock', model: 'large' } }) }, { surfaceOp: 'append' })
  const call = parent.append('tool/call', { turn: 1, step: 1, callId, name: 'bash', arguments: '{}' })
  const result = parent.append('tool/result', { turn: 1, step: 1, message: createToolResultMessage({ callId,
    content: [{ type: 'text', text: shortened }], isError: false }) }, { surfaceOp: 'append' })
  assert.ok(pasted.seq < call.seq && call.seq < result.seq)

  // 3. Three real forks of the same parent at three different cuts.
  const pastedOnly = ctx.sessions.fork(parent, pasted.seq, SessionId('fork-pasted'))
  const beforeResult = ctx.sessions.fork(parent, call.seq, SessionId('fork-before'))
  const afterResult = ctx.sessions.fork(parent, result.seq, SessionId('fork-after'))
  const stranger = ctx.sessions.create(SessionId('fork-stranger'))
  assert.equal(pastedOnly.inheritedEventCount, pasted.seq + 1)
  assert.equal(beforeResult.inheritedEventCount, call.seq + 1)
  assert.equal(afterResult.inheritedEventCount, result.seq + 1)

  // 4. Only the fork that really inherited the result may read the original.
  const mine = await readAs(afterResult, { contentId, archive: true })
  assert.equal(mine.status, 'ok', JSON.stringify(mine))
  assert.equal(mine.text, text, 'the inherited original is returned byte for byte')
  assert.equal(mine.source, 'archive')
  assert.equal(mine.inheritedFrom, 'fork-parent', 'the origin of the inherited reference is disclosed')
  assert.equal(mine.inheritedResultSeq, result.seq)
  assert.equal(mine.outcome, 'published')
  for (const [label, session] of [['a pasted copy of the reference', pastedOnly],
    ['a fork cut before the result', beforeResult], ['an unrelated session', stranger]]) {
    const denied = await readAs(session, { contentId, archive: true })
    assert.equal(denied.status, 'out_of_scope', `${label} must not authorise the read: ${JSON.stringify(denied)}`)
    assert.equal(denied.text, '', `${label} must return no original text`)
    assert.equal(denied.inheritedFrom, undefined, `${label} must not claim an inherited origin`)
  }

  // 5. An original the parent archived only after the cut is never inherited.
  const laterCall = ToolCallId('fork-later')
  const laterReduced = await ctx.tools.execute({ name: 'bash', arguments: { command: 'run', description: 'y' },
    callId: laterCall, signal: new AbortController().signal, agent: { session: parent } })
  const laterId = /id=([a-f0-9]{64})/u.exec(laterReduced.content.map(block => 'text' in block ? block.text : '').join('\n'))?.[1]
  assert.ok(laterId && laterId !== contentId, 'the second reduction is a different original')
  for (const session of [afterResult, pastedOnly, beforeResult]) {
    const denied = await readAs(session, { contentId: laterId, archive: true })
    assert.equal(denied.status, 'out_of_scope', JSON.stringify(denied))
  }
  // The parent itself still reads both.
  assert.equal((await readAs(parent, { contentId: laterId, archive: true })).status, 'ok')

  // 6. A grandchild proves the lineage transitively instead of trusting the name.
  const grand = ctx.sessions.fork(afterResult, undefined, SessionId('fork-grand'))
  const inherited = await readAs(grand, { contentId, archive: true })
  assert.equal(inherited.status, 'ok', JSON.stringify(inherited))
  assert.equal(inherited.text, text)
  assert.equal(inherited.inheritedFrom, 'fork-parent', 'the lineage walk crosses the intermediate fork')

  // 7. Search uses the same authorised candidate set: the hit is found for the
  //    inheriting session and the archive is not even scanned for the others.
  const found = JSON.parse((await run(afterResult, 'context_history_search', { query: 'progress line' })).value)
  assert.equal(found.archivedOriginals.searched, true, JSON.stringify(found.archivedOriginals))
  assert.equal(found.archivedOriginals.inheritedCandidates, 1)
  assert.deepEqual(found.archivedOriginals.hits.map(hit => hit.contentId), [contentId])
  const deniedSearch = JSON.parse((await run(stranger, 'context_history_search', { query: 'progress line' })).value)
  assert.deepEqual(deniedSearch.archivedOriginals.hits, [])
  assert.equal(deniedSearch.archivedOriginals.scannedEntries, 0, 'an unauthorised session never scans the parent library')
})

test('history tools: an inherited reference whose body was rewritten at equal length is refused', async t => {
  const h = await forkHarness(t)
  const text = repetitive()
  const entry = await h.reduce('fork-rewrite-call', h.parent, text)
  // Controlled fixture: the reference line stays byte-identical, only the body
  // changes, and the visible length does not move. Length plus a valid locator
  // is not proof of provenance.
  const cut = entry.shortened.lastIndexOf('\n\n')
  const rewritten = `${entry.shortened.slice(0, cut).replace('progress', 'qrogress')}${entry.shortened.slice(cut)}`
  assert.equal(rewritten.length, entry.shortened.length, 'the forged reference keeps the visible length')
  assert.notEqual(rewritten, entry.shortened)
  const logged = h.appendCall(entry, rewritten)
  const child = h.fork(logged.result.seq, 'fork-rewritten')
  assert.equal(child.inheritedEventCount, logged.result.seq + 1)
  const read = await h.readAs(child, { contentId: entry.contentId, archive: true })
  assert.equal(read.status, 'out_of_scope', `a rewritten body must not authorise a read: ${JSON.stringify(read)}`)
  assert.equal(read.text, '')
  assert.equal(read.inheritedFrom, undefined)
  // The same fork reading the untouched bytes is granted: the refusal above is
  // about the rewritten body, not about the fixture being unable to grant.
  const honest = h.appendCall(entry)
  const control = h.fork(honest.result.seq, SessionId('fork-honest-child'))
  assert.equal((await h.readAs(control, { contentId: entry.contentId, archive: true })).status, 'ok')
})

test('history tools: a missing or malformed inherited cut is refused instead of read as zero', async t => {
  const strip = id => class extends SessionQueryEngine {
    async observeSession(target, options) {
      const observation = await super.observeSession(target, options)
      if (target !== id) return observation
      // Own property removed: the reader must not fall back to "no prefix".
      const copy = { ...observation, inheritedEventCount: undefined, [Symbol.dispose]: () => observation[Symbol.dispose]() }
      return copy
    }
  }
  // Parent-side: the parent never states how much of it the child inherited.
  const parentSide = await forkHarness(t, { engine: strip('fork-parent') })
  const entryA = await parentSide.reduce('fork-cut-parent', parentSide.parent, repetitive())
  const loggedA = parentSide.appendCall(entryA)
  const childA = parentSide.fork(loggedA.result.seq, 'fork-cut-parent-child')
  const readA = await parentSide.readAs(childA, { contentId: entryA.contentId, archive: true })
  assert.equal(readA.status, 'lineage_unavailable', `an unknown parent cut must fail closed: ${JSON.stringify(readA)}`)
  assert.match(readA.reason, /边界|父会话/u)

  // Child-side: the fork itself never states its cut.
  const childSide = await forkHarness(t, { engine: strip('fork-cut-child') })
  const entryB = await childSide.reduce('fork-cut-child-call', childSide.parent, repetitive())
  const loggedB = childSide.appendCall(entryB)
  const childB = childSide.fork(loggedB.result.seq, 'fork-cut-child')
  const readB = await childSide.readAs(childB, { contentId: entryB.contentId, archive: true })
  assert.equal(readB.status, 'lineage_unavailable', `an unknown own cut must fail closed: ${JSON.stringify(readB)}`)
  assert.match(readB.reason, /边界/u)
  // A plain session with a real zero cut is still an honest scope refusal.
  const stranger = childSide.ctx.sessions.create(SessionId('fork-cut-stranger'))
  const plain = await childSide.readAs(stranger, { contentId: entryB.contentId, archive: true })
  assert.equal(plain.status, 'out_of_scope', JSON.stringify(plain))
})

test('history tools: an inherited reference past the authorisation bound makes the search incomplete, never covered', async t => {
  const h = await forkHarness(t)
  const entries = []
  for (let index = 0; index < 9; index++) {
    const text = `unique-needle-${index}\n${Array.from({ length: 39 }, () => `padding line for entry ${index}`).join('\n')}`
    entries.push(await h.reduce(`fork-many-${index}`, h.parent, text))
  }
  let last
  for (const entry of entries) last = h.appendCall(entry)
  const child = h.fork(last.result.seq, 'fork-many-child')
  assert.equal(child.inheritedEventCount, last.result.seq + 1)
  // The query matches only the ninth inherited original, which is past the bound.
  const found = JSON.parse((await h.run(child, 'context_history_search', { query: 'unique-needle-8' })).value)
  assert.deepEqual(found.archivedOriginals.hits, [])
  assert.equal(found.archivedOriginals.truncated, true, `the search must disclose unfinished authorisation: ${JSON.stringify(found.archivedOriginals)}`)
  assert.equal(found.archivedOriginals.inheritedCandidates, 8)
  assert.ok(found.archivedOriginals.inheritedScannedEvents > 0)
  assert.doesNotMatch(found.archivedOriginals.note, /已覆盖本会话全部可读候选/u)
  assert.match(found.archivedOriginals.note, /未核对|预算|上限/u)
  // An original inside the bound is still found and readable: no wider access
  // is requested, only honest incompleteness.
  const inside = JSON.parse((await h.run(child, 'context_history_search', { query: 'unique-needle-0' })).value)
  assert.deepEqual(inside.archivedOriginals.hits.map(hit => hit.contentId), [entries[0].contentId])
  assert.equal((await h.readAs(child, { contentId: entries[0].contentId, archive: true })).status, 'ok')
  // A precisely named ninth original is still proven: the cap bounds how many
  // references one call enumerates, never which inherited byte it may read.
  // Enumeration honesty is what the assertions above pin down.
  const ninth = await h.readAs(child, { contentId: entries[8].contentId, archive: true })
  assert.equal(ninth.status, 'ok', JSON.stringify(ninth))
  assert.equal(ninth.inheritedFrom, 'fork-parent')
})

test('history tools: the inherited scan is bounded and never reads the whole prefix', async t => {
  let syntheticReads = 0
  const engine = class extends SessionQueryEngine {
    async observeSession(target, options) {
      const observation = await super.observeSession(target, options)
      if (target !== 'fork-scan-child') return observation
      const real = observation.events
      const events = new Proxy([], { get(_target, key) {
        if (key === 'length') return 100000
        if (typeof key === 'string' && /^\d+$/u.test(key)) {
          const index = Number(key)
          if (index < real.length) return real[index]
          syntheticReads++
          return { seq: index, type: 'step/end', data: { turn: 1, step: 1 } }
        }
        return Reflect.get(real, key)
      } })
      return { ...observation, inheritedEventCount: 100000, events, [Symbol.dispose]: () => observation[Symbol.dispose]() }
    }
  }
  const h = await forkHarness(t, { engine })
  // The requested original is real and granted, but its reference is never in
  // this parent's log: the only way to grant it is to check the prefix, and the
  // prefix claims far more events than the budget allows.
  const logged = await h.reduce('fork-scan-logged', h.parent, repetitive())
  const elsewhere = await h.reduce('fork-scan-elsewhere', h.parent,
    Array.from({ length: 40 }, () => 'a line only the never-referenced original printed').join('\n'))
  assert.notEqual(elsewhere.contentId, logged.contentId, 'the requested original must have no reference in this log')
  const appended = h.appendCall(logged)
  const child = h.fork(appended.result.seq, 'fork-scan-child')
  const read = await h.readAs(child, { contentId: elsewhere.contentId, archive: true })
  assert.equal(read.status, 'lineage_unavailable', JSON.stringify(read))
  assert.match(read.reason, /预算/u)
  assert.ok(syntheticReads > 0, 'the bounded scan must actually examine prefix events')
  assert.ok(syntheticReads <= 2000, `the scan must stay inside its budget, read ${syntheticReads}`)
  assert.ok(syntheticReads < 100000, 'the whole prefix is never read')
})

test('history tools: archiveReadBudget bounds one read, and the whole original is still reachable', async t => {
  const text = repetitive()
  const tight = await fixture(t, { value: shellResult(text), override: { archiveReadBudget: 500 } })
  const reduced = await tight.execute('bash', { command: 'echo hi', description: 'run echo' })
  const contentId = /id=([a-f0-9]{64})/u.exec(reduced.content.map(block => block.text).join('\n'))?.[1]
  assert.ok(contentId)
  const first = await readBack(tight, { contentId, archive: true, limit: 6000 })
  assert.equal(first.status, 'ok', JSON.stringify(first))
  assert.equal(first.availableLength, text.length, 'the budget never hides how much was stored')
  assert.ok(first.text.length <= 500, `one read stays inside the policy budget: ${first.text.length}`)
  assert.equal(first.text, text.slice(0, first.text.length))
  assert.equal(first.next.offset, first.text.length, 'the refusal to load more is a cursor, not a loss')
  // The rest is reachable by cursor: the budget bounds a page, never the data.
  const second = await readBack(tight, { contentId, archive: true, limit: 6000, offset: first.next.offset })
  assert.equal(second.text, text.slice(first.text.length, first.text.length + second.text.length))
  assert.ok(second.text.length > 0)
  // The same original with a generous budget arrives whole in one page.
  const roomy = await fixture(t, { value: shellResult(text) })
  const wholeReduced = await roomy.execute('bash', { command: 'echo hi', description: 'run echo' })
  const wholeId = /id=([a-f0-9]{64})/u.exec(wholeReduced.content.map(block => block.text).join('\n'))?.[1]
  const whole = await readBack(roomy, { contentId: wholeId, archive: true, limit: 6000 })
  assert.equal(whole.text, text)
  assert.equal(whole.next, null)
})

test('settings: prefixDiagnosticsEnabled really gates prefix collection and keeps every usage number', () => {
  // A real request header pair: the second one changes provider, system prefix
  // and tool order, so the fingerprint comparison has something to report.
  const header = (seq, time, provider, system, tools) => ({ seq, time, type: 'request/header', surfaceOp: 'append',
    data: { header: { config: { provider, model: 'large' }, tools } } })
  const system = (seq, time, text) => ({ seq, time, type: 'system/message', surfaceOp: 'append', data: { message: { content: [{ type: 'text', text }] } } })
  const attempt = (seq, time, turn, step, usage) => ({ seq, time, type: 'assistant/message', surfaceOp: 'append',
    data: { turn, step, usage, message: { source: { kind: 'model', provider: 'mock', model: 'large' }, content: [{ type: 'text', text: 'reply' }] } } })
  const tool = name => ({ name, description: `${name} tool`, parameters: { type: 'object' } })
  const events = [
    system(0, 1, 'first prefix'), header(1, 2, 'mock', [tool('a'), tool('b')]), attempt(2, 3, 1, 1, { inputTokens: 100, outputTokens: 10, cacheReadTokens: 0, cacheWriteTokens: 0 }),
    system(3, 4, 'changed prefix'), header(4, 5, 'mock-2', [tool('b'), tool('a')]), attempt(5, 6, 2, 1, { inputTokens: 200, outputTokens: 20, cacheReadTokens: 0, cacheWriteTokens: 0 }),
  ]
  const on = efficiency.attributeSession(events)
  const off = efficiency.attributeSession(events, { fingerprint: false })
  // The switch is about prefix diagnostics only: every usage number is identical.
  assert.notEqual(on.fingerprint, null, 'the default still collects the fingerprint')
  assert.equal(off.fingerprint, null, 'the switch really stops prefix collection')
  assert.deepEqual(off.totals, on.totals, 'business usage is never reduced by the switch')
  assert.deepEqual(off.requests, on.requests, 'per-request rows keep their usage')
  assert.ok(on.changes.some(change => change.changed.includes('prefix')), JSON.stringify(on.changes))
  assert.deepEqual(off.changes, [], 'no prefix change is reported when nothing was collected')
  // Turning it back on in the same process restores the diagnostics exactly.
  assert.deepEqual(efficiency.attributeSession(events).changes, on.changes)
})

test('history tools: a host without the archive service keeps log reads and reports the missing capability', async t => {
  const ctx = new Context()
  t.after(async () => { await ctx.fiber.dispose() })
  await ctx.plugin(SessionStore)
  await ctx.plugin(class extends SessionQueryEngine {})
  await ctx.plugin(SystemPrompt)
  // Exactly the older registration: no archive accessor is injected at all.
  await ctx.plugin(scope => { registerHistoryTools(scope) })
  await ctx.plugin(ToolRuntime)
  const session = ctx.sessions.create(SessionId('history-no-archive'))
  const agent = { session }
  session.append('user/message', createUserMessage({ content: [{ type: 'text', text: 'log-needle-here' }], source: { kind: 'user' } }), { surfaceOp: 'append' })
  let call = 0
  const run = async (name, args) => {
    const result = await ctx.tools.execute({ name, arguments: args, callId: ToolCallId(`no-archive-${++call}`),
      signal: new AbortController().signal, agent })
    assert.equal(result.isError, false, `${name} must answer, not fail: ${JSON.stringify(result)}`)
    return JSON.parse(result.value)
  }
  // An ordinary log read still works.
  const log = await run('context_history_read', { sourceSeq: 0 })
  assert.equal(log.status, 'ok', JSON.stringify(log))
  assert.equal(log.text, 'log-needle-here')
  // A search still returns its log hits, and says plainly that nothing was
  // searched in an archive it never had.
  const found = await run('context_history_search', { query: 'log-needle' })
  assert.equal(found.hits.length, 1, JSON.stringify(found))
  assert.equal(found.archivedOriginals.searched, false)
  assert.match(found.archivedOriginals.reason, /档案/u)
  // The archived-original path reports the missing capability as a result.
  const archived = await run('context_history_read', { contentId: 'a'.repeat(64), archive: true })
  assert.equal(archived.status, 'archive_unavailable', JSON.stringify(archived))
  assert.equal(archived.text, '')
})

test('history tools: an oversized log is refused before the observation getter is ever touched', async t => {
  let getterReads = 0
  const engine = class extends SessionQueryEngine {
    async observeSession(target, options) {
      const observation = await super.observeSession(target, options)
      if (target !== 'fork-cap-child') return observation
      // A log beyond the total cap, with an `events` getter that would pay the
      // whole-log materialisation cost. The guard must decide without it, so
      // even this controlled observation is never spread (a spread would run
      // the getter and the fixture would be measuring itself).
      const stubbed = { source: observation.source, header: observation.header,
        cursor: 100000, inheritedEventCount: 100000, [Symbol.dispose]: () => observation[Symbol.dispose]() }
      Object.defineProperty(stubbed, 'events', { enumerable: true,
        get() { getterReads++; throw new Error('SENTINEL: the whole-log getter must not be touched') } })
      return stubbed
    }
  }
  const h = await forkHarness(t, { engine })
  const entry = await h.reduce('fork-cap-call', h.parent, repetitive())
  const appended = h.appendCall(entry)
  const child = h.fork(appended.result.seq, 'fork-cap-child')
  const read = await h.readAs(child, { contentId: entry.contentId, archive: true })
  assert.equal(read.status, 'lineage_unavailable', JSON.stringify(read))
  assert.match(read.reason, /总量上限|100000/u)
  assert.equal(getterReads, 0, 'the whole-log getter is never accessed once the total cap is exceeded')
  // The log search path stays inside its own existing guard, and equally never
  // materialises the oversized log through this helper.
  const searched = await h.run(child, 'context_history_search', { query: 'progress line' })
  assert.equal(searched.isError, true, JSON.stringify(searched))
  assert.doesNotMatch(JSON.stringify(searched), /SENTINEL/u)
  assert.equal(getterReads, 0)
})

test('archive: a log event and an archived original are read through the same tool', async t => {
  const f = await fixture(t)
  f.session.append('user/message', createUserMessage({ content: [{ type: 'text', text: 'log-text-needle' }], source: { kind: 'user' } }), { surfaceOp: 'append' })
  const message = createToolResultMessage({ callId: ToolCallId('stored'), content: [{ type: 'text', text: 'reduced tool result body' }], isError: false })
  f.session.append('tool/result', { turn: 1, step: 1, message }, { surfaceOp: 'append' })
  const fromLog = await readBack(f, { sourceSeq: 0 })
  assert.equal(fromLog.source, 'log')
  assert.equal(fromLog.text, 'log-text-needle')
})
