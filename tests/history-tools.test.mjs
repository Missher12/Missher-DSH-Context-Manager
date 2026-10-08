import { test } from 'node:test'
import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'
import { Context } from '@deepseek-ai/cordis'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import SessionQueryEngine from '@deepseek-ai/dsh-session-query'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import { createMessage, createUserMessage, createToolResultMessage, ToolCallId } from '@deepseek-ai/dsh-llm'

// Compile this helper in memory; canonical lib is never rebuilt or written.
const compiled = await build({
  entryPoints: [fileURLToPath(new URL('../src/history-tools.ts', import.meta.url))],
  bundle: true, write: false, platform: 'node', format: 'esm', target: 'es2022',
  tsconfigRaw: { compilerOptions: { target: 'ES2022' } },
  plugins: [{ name: 'installed-public-api', setup(builder) {
    builder.onResolve({ filter: /^[^./]/ }, args => ({ path: import.meta.resolve(args.path), external: true }))
  } }],
})
const { registerHistoryTools } = await import(`data:text/javascript;base64,${Buffer.from(compiled.outputFiles[0].text).toString('base64')}`)

class Query extends SessionQueryEngine {
  reads = []
  hook
  searchSessions() { throw new Error('Cross-session search must never be called') }
  searchEvents() { throw new Error('Indexed search must never be called') }
  async observeSession(id, options) {
    this.reads.push(id)
    const observation = await super.observeSession(id, options)
    await this.hook?.(observation)
    return observation
  }
}

async function fixture(t, { lateTools = false } = {}) {
  const ctx = new Context()
  t.after(() => ctx.fiber.dispose())
  await ctx.plugin(SessionStore)
  await ctx.plugin(Query)
  await ctx.plugin(SystemPrompt)
  const owner = await ctx.plugin(scope => { registerHistoryTools(scope) })
  if (lateTools) assert.equal(ctx.get('tools'), undefined)
  await ctx.plugin(ToolRuntime)
  const session = ctx.sessions.create(SessionId('history-tool-current'))
  // The execution identity points at a real live Session. No loop or provider
  // is mounted: these tools are read-only and do not require model execution.
  const agent = { session }
  let call = 0
  const execute = (name, args, signal = new AbortController().signal, caller = agent) => ctx.tools.execute({
    name, arguments: args, callId: ToolCallId(`history-${++call}`), signal,
    ...(caller === null ? {} : { agent: caller }),
  })
  const invoke = async (name, args, signal) => {
    const result = await execute(name, args, signal)
    assert.equal(result.isError, false, JSON.stringify(result))
    assert.equal(typeof result.value, 'string')
    assert.ok(result.value.length <= 8000, 'the complete JSON output respects the bound, including escaping')
    assert.deepEqual(result.content, [{ type: 'text', text: result.value }])
    return JSON.parse(result.value)
  }
  return { ctx, owner, session, execute, invoke }
}

function user(session, text, content = [{ type: 'text', text }]) {
  return session.append('user/message', createUserMessage({ content, source: { kind: 'user' } }), { surfaceOp: 'append' })
}
const read = (f, args) => f.invoke('context_history_read', args)
const search = (f, args) => f.invoke('context_history_search', args)
function deferred() {
  let resolve
  const promise = new Promise(accept => { resolve = accept })
  return { promise, resolve }
}

test('history tools: late dynamic registration is scoped and exports no session selector', async t => {
  const f = await fixture(t, { lateTools: true })
  const schemas = f.ctx.tools.schemas()
  assert.deepEqual(schemas.map(item => item.name).sort(), ['context_history_read', 'context_history_search'])
  for (const schema of schemas) assert.equal(Object.hasOwn(schema.parameters.properties, 'sessionId'), false)
  await f.owner.dispose()
  assert.equal(f.ctx.tools.schemas().length, 0)
})

test('history tools: the execution session is the only readable scope', async t => {
  const f = await fixture(t)
  user(f.session, 'current-only')
  const other = f.ctx.sessions.create(SessionId('unrelated-history'))
  user(other, 'other-only-secret')
  assert.equal((await search(f, { query: 'other-only-secret' })).hits.length, 0)
  assert.equal((await read(f, { sourceSeq: 0 })).text, 'current-only')
  assert.deepEqual(new Set(f.ctx.sessionQuery.reads), new Set([f.session.id]))
  const injected = await f.execute('context_history_read', { sourceSeq: 0, sessionId: other.id })
  assert.equal(injected.isError, true, 'unknown root fields are rejected beyond the SDK open-object schema')
  const withoutAgent = await f.execute('context_history_read', { sourceSeq: 0 }, undefined, null)
  assert.equal(withoutAgent.isError, true)
  assert.equal(f.ctx.sessionQuery.reads.length, 2, 'rejected requests do not acquire an observation')
})

test('history tools: bounded escaped and Unicode pages reconstruct exact original text', async t => {
  const f = await fixture(t)
  const text = ('中文🙂 "\\\n\u0000'.repeat(900))
  const event = user(f.session, text)
  let next = { sourceSeq: event.seq, offset: 0 }, reconstructed = '', pages = 0
  while (next) {
    const result = await read(f, { ...next, limit: 6000 })
    assert.equal(result.status, 'ok')
    assert.equal(result.offset, reconstructed.length)
    assert.equal(result.availableLength, text.length)
    assert.equal(result.truncated, result.next !== null)
    assert.ok(result.text.length > 0)
    reconstructed += result.text
    next = result.next
    assert.ok(++pages < 30)
  }
  assert.equal(reconstructed, text)
  assert.ok(pages > 1)
})

test('history tools: a pruned tool result remains retrievable through its original source sequence', async t => {
  const f = await fixture(t)
  const callId = ToolCallId('old-output')
  const message = createToolResultMessage({ callId, content: [{ type: 'text', text: 'head ORIGINAL-MIDDLE tail' }], isError: false })
  const original = f.session.append('tool/result', { turn: 1, step: 1, message }, { surfaceOp: 'append' })
  // Exact public replacement protocol used by the Host tool-result pruner.
  const replacement = f.session.append('tool/result', { turn: 1, step: 1,
    message: { ...message, content: [{ type: 'text', text: 'head [middle pruned] tail' }] } },
  { surfaceOp: { op: 'replace', startSeq: original.seq, endSeq: original.seq }, sourceEventSeqs: [original.seq] })
  assert.equal(f.session.deriveMessages()[0].content[0].text, 'head [middle pruned] tail')
  const result = await read(f, { sourceSeq: replacement.sourceEventSeqs[0], offset: 5, limit: 15 })
  assert.equal(result.text, 'ORIGINAL-MIDDLE')
  assert.equal(result.sourceSeq, original.seq)
  const found = await search(f, { query: 'ORIGINAL-MIDDLE' })
  assert.equal(found.hits.length, 1)
  assert.equal(found.hits[0].sourceSeq, original.seq)
  assert.equal((await read(f, { sourceSeq: replacement.seq })).status, 'excluded')
})

test('history tools: literal case-sensitive search returns exact multi-block offsets', async t => {
  const f = await fixture(t)
  const event = user(f.session, '', [{ type: 'text', text: 'abc [x]' }, { type: 'text', text: '中文 [x] ABC' }])
  const first = await search(f, { query: '[x]', limit: 1 })
  assert.deepEqual(first.hits.map(hit => [hit.sourceSeq, hit.offset, hit.matchLength]), [[event.seq, 4, 3]])
  const second = await search(f, { query: '[x]', ...first.next })
  assert.equal(second.hits[0].offset, 11)
  assert.equal(second.next, null)
  assert.equal((await search(f, { query: 'ABC' })).hits.length, 1)
  assert.equal((await search(f, { query: '[x]\n中文' })).hits[0].offset, 4)
})

test('history tools: the event scan limit exposes a resumable uncovered tail', async t => {
  const f = await fixture(t)
  for (let index = 0; index < 205; index++) user(f.session, `small event ${index}`)
  const target = user(f.session, 'tail-only-needle')
  const before = JSON.stringify(f.session.snapshotEvents())
  const first = await search(f, { query: 'tail-only-needle' })
  assert.equal(first.hits.length, 0)
  assert.equal(first.coverage.scannedEvents, 200)
  assert.equal(first.truncated, true)
  assert.deepEqual(first.next, { sourceSeq: 200, offset: 0 })
  const next = await search(f, { query: 'tail-only-needle', ...first.next })
  assert.equal(next.hits[0].sourceSeq, target.seq)
  assert.equal(next.truncated, false)
  assert.equal(JSON.stringify(f.session.snapshotEvents()), before, 'reading and searching append no event')
})

test('history tools: text spanning the character scan boundary is not lost', async t => {
  const f = await fixture(t)
  const original = 'x'.repeat(32765) + 'BOUNDARY' + 'y'.repeat(80)
  user(f.session, original)
  const first = await search(f, { query: 'BOUNDARY' })
  assert.equal(first.hits.length, 0)
  assert.equal(first.coverage.scannedChars, 32768)
  assert.equal(first.truncated, true)
  assert.ok(first.next.offset <= 32765)
  const next = await search(f, { query: 'BOUNDARY', ...first.next })
  assert.equal(next.hits[0].offset, 32765)
  assert.equal(next.next, null)
})

test('history tools: excluded and oversized-block events are explicit, never a full-text claim', async t => {
  const f = await fixture(t)
  const system = f.session.append('system/message', { turn: 1, step: 1,
    message: createMessage({ role: 'system', content: [{ type: 'text', text: 'excluded-system-secret' }], source: { kind: 'system-prompt' } }) }, { surfaceOp: 'append' })
  const image = { type: 'image', attachment: { attachmentId: 'sha256:' + 'a'.repeat(64), mediaType: 'image/png', bytes: 1, width: 1, height: 1 } }
  const rich = user(f.session, '', [image, { type: 'text', text: 'visible-only' }])
  const many = user(f.session, '', Array.from({ length: 4097 }, () => ({ type: 'text', text: 'uncovered-text' })))
  assert.equal((await read(f, { sourceSeq: system.seq })).status, 'excluded')
  const richRead = await read(f, { sourceSeq: rich.seq })
  assert.equal(richRead.text, 'visible-only')
  assert.equal(richRead.omittedBlocks, 1)
  const oversized = await read(f, { sourceSeq: many.seq })
  assert.equal(oversized.status, 'block_limit')
  assert.equal(oversized.truncated, true)
  assert.equal(oversized.next, null, 'unsupported block counts are explicit, not an endless cursor')
  const found = await search(f, { query: 'secret' })
  assert.equal(found.hits.length, 0)
  assert.equal(found.coverage.excludedEvents, 1)
  assert.equal(found.coverage.blockLimitedEvents, 1)
  assert.equal(found.truncated, true)
  assert.equal(found.next, null)
  assert.match(found.warning, /untrusted data/)
})

test('history tools: malformed parameters and missing positions have precise outcomes', async t => {
  const f = await fixture(t)
  const event = user(f.session, 'short')
  for (const args of [{ sourceSeq: -1 }, { sourceSeq: 0.5 }, { sourceSeq: event.seq, offset: -1 },
    { sourceSeq: event.seq, limit: 6001 }, { sourceSeq: event.seq, limit: 0 }, { sourceSeq: event.seq, path: '/private' }]) {
    assert.equal((await f.execute('context_history_read', args)).isError, true)
  }
  for (const args of [{ query: '' }, { query: '  ' }, { query: 'x'.repeat(201) }, { query: 'short', limit: 9 }, { query: 'short', sessionId: 'other' }]) {
    assert.equal((await f.execute('context_history_search', args)).isError, true)
  }
  assert.equal((await read(f, { sourceSeq: 999 })).status, 'missing')
  assert.equal((await read(f, { sourceSeq: event.seq, offset: 6 })).status, 'offset_out_of_range')
  const end = await read(f, { sourceSeq: event.seq, offset: 5 })
  assert.equal(end.text, '')
  assert.equal(end.next, null)
})

test('history tools: cancellation after observation acquisition disposes the lease and returns no text', async t => {
  const f = await fixture(t)
  user(f.session, 'must-not-return-after-cancel')
  const entered = deferred(), release = deferred()
  let disposed = 0
  f.ctx.sessionQuery.hook = async observation => {
    const original = observation[Symbol.dispose].bind(observation)
    observation[Symbol.dispose] = () => { disposed++; original() }
    entered.resolve()
    await release.promise
  }
  const controller = new AbortController()
  const result = f.execute('context_history_read', { sourceSeq: 0 }, controller.signal)
  await entered.promise
  controller.abort()
  release.resolve()
  const cancelled = await result
  assert.equal(cancelled.isError, true)
  assert.equal(disposed, 1)
  assert.equal(JSON.stringify(cancelled.content).includes('must-not-return-after-cancel'), false)
  f.ctx.sessionQuery.hook = undefined
  const before = f.ctx.sessionQuery.reads.length
  assert.equal((await f.execute('context_history_search', { query: 'must' }, controller.signal)).isError, true)
  assert.equal(f.ctx.sessionQuery.reads.length, before, 'pre-cancelled calls do not read history')
})

test('history tools: output-heavy search pages keep all continuation matches under the bound', async t => {
  const f = await fixture(t)
  const text = ('\u0000'.repeat(65) + 'MATCH' + '\u0000'.repeat(220)).repeat(12)
  user(f.session, text)
  const offsets = []
  let next = { sourceSeq: 0, offset: 0 }, pages = 0
  while (next) {
    const result = await search(f, { query: 'MATCH', limit: 8, ...next })
    offsets.push(...result.hits.map(hit => hit.offset))
    next = result.next
    assert.ok(++pages < 10)
  }
  assert.deepEqual(offsets, Array.from({ length: 12 }, (_, index) => index * 290 + 65))
  assert.ok(pages > 1)
})
