import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'
import { createRequire } from 'node:module'
import { buildSync } from 'esbuild'
import { JSDOM } from 'jsdom'
import React, { act } from 'react'
import { createRoot } from 'react-dom/client'
import { Simulate } from 'react-dom/test-utils'
import { renderToStaticMarkup } from 'react-dom/server'
import { defaults } from '../lib/policy.js'
import { TYPERT } from '../lib/typert.js'

const require = createRequire(import.meta.url)
// Render the host's actual control implementations. Their CSS modules are
// compiled here; visual/theme acceptance runs separately in the real Web host.
const primitivesBuild = buildSync({
  stdin: { contents: ['Button', 'Input', 'Switch', 'Checkbox', 'StateDot', 'SegmentedTabs', 'Tag', 'Tooltip', 'MenuSurface', 'useAnchoredPosition', 'useDismissOnOutsidePointer', 'icons/index', 'settings-form/SettingsForm', 'settings-form/fields'].map(name =>
    `export { ${name === 'settings-form/fields' ? 'SettingsValueField' : name === 'icons/index' ? 'IconClockOutlineRegular' : name.split('/').at(-1)} } from ${JSON.stringify(require.resolve(`@deepseek-ai/dsh-client-ui-primitives/src/${name}.${name.startsWith('use') ? 'ts' : 'tsx'}`))}`).join('\n'), resolveDir: process.cwd() },
  outfile: '/virtual/context-manager-primitives.cjs', bundle: true, platform: 'node', format: 'cjs',
  external: ['react', 'react/*', 'react-dom', 'react-dom/*'], loader: { '.css': 'local-css' }, jsx: 'automatic',
  tsconfigRaw: { compilerOptions: { target: 'ES2022' } }, write: false,
})

test('overview keeps estimated composition separate, handles missing usage, and exposes over-window values', () => {
  const values = { contextPressure: { projectedTokens: 102000, pressureTokens: 95000, contextWindow: 100000 },
    contextBreakdown: { systemTokens: 1000, toolsTokens: 2000, messageTokens: 3000 },
    tokenUsage: { uncachedInputTokens: 999999, cacheReadTokens: 2, cacheWriteTokens: 3, outputTokens: 4 } }
  const html = renderToStaticMarkup(React.createElement(client.ContextReadout, { values, policy: defaults }))
  assert.match(html, /102\.0%/)
  assert.match(html, /预计超出窗口/)
  assert.match(html, /相加不等于上面的模型用量/)
  assert.match(html, /999,999/)
  assert.ok(!html.includes('999.9%'))
  const unknown = renderToStaticMarkup(React.createElement(client.ContextReadout, { values: {}, policy: defaults }))
  assert.match(unknown, /等待模型返回用量/)
  assert.ok(!unknown.includes('NaN') && !unknown.includes('0.0%'))
})

test('settings section contains only policy controls and does not read any session', async () => {
  const dom = new JSDOM('<div id="root"></div>', { url: 'http://localhost' })
  globalThis.window = dom.window; globalThis.document = dom.window.document; globalThis.IS_REACT_ACT_ENVIRONMENT = true
  const snapshot = { status: 'ready', writable: true, mode: 'host', revision: 4, value: { policy: { ...defaults } } }
  const form = { subscribe: () => () => {}, getSnapshot: () => snapshot, mutate: () => { throw new Error('unexpected write') } }
  const root = createRoot(document.getElementById('root'))
  const click = async text => act(async () => [...document.querySelectorAll('button')].find(button => button.textContent === text).click())
  try {
    await act(async () => root.render(React.createElement(client.ContextPage, { form })))
    assert.equal(document.querySelectorAll('style').length, 2)
    assert.equal(document.querySelectorAll('style:not([data-plugin="dsh-context-manager"])').length, 0,
      'page and nested settings styles must not be claimed by another plugin')
    assert.equal(document.querySelectorAll('[role="tab"]').length, 0)
    assert.equal(document.querySelectorAll('select').length, 0)
    await click('提前整理 · 70%')
    assert.equal(document.querySelector('#context-manager-triggerPercent').value, '70')
  } finally { await act(async () => root.unmount()); dom.window.close(); delete globalThis.window; delete globalThis.document }
})
const primitivesScope = { module: { exports: {} }, require, setTimeout, clearTimeout }
for (const name of ['window', 'document', 'Node']) Object.defineProperty(primitivesScope, name, { get: () => name === 'Node' ? globalThis.window?.Node : globalThis[name] })
primitivesScope.getComputedStyle = element => globalThis.window.getComputedStyle(element)
vm.runInNewContext(primitivesBuild.outputFiles.find(file => file.path.endsWith('.cjs')).text, primitivesScope)
let client
vm.runInNewContext(readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8'), {
  AbortController, setTimeout: (callback, delay) => setTimeout(callback, delay), clearTimeout: timer => clearTimeout(timer),
  window: { __ModuleLoader__: { load: module => { client = module.factory(name =>
    name === '@deepseek-ai/dsh-client-ui-primitives' ? primitivesScope.module.exports : require(name)) } } },
})

test('client registers the native conversation tab after trajectory and binds its actual Session', async () => {
  const slots = []
  const bindings = []; const directories = []; const pulse = {}; const directory = {}; const disposers = []
  const ctx = { locale: { register: () => () => {}, bind: () => key => key === 'title' ? '上下文' : key, getLocale: () => ({ active: 'zh' }) }, configForms: { get: () => ({}), whileServed: (_ns, callback) => callback() },
    remote: { $mount: async () => () => {}, contextInspector: {} },
    sessions: { binding: id => { bindings.push(id); return { session: { projections: { faceOf: key => { assert.equal(key, 'contextPressure'); return pulse } } } } } },
    modelDirectories: { directoryFor: id => { directories.push(id); return { store: directory } } },
    slots: { inject: (_slot, callback) => callback(), register: options => { slots.push(options); return () => {} } },
    effect: callback => { disposers.push(callback()) }, inject: (_keys, callback) => callback(ctx) }
  await client.apply(ctx)
  assert.deepEqual(slots.map(slot => slot.name), ['conversation.input.right', 'settings.section', 'conversation.view'])
  assert.equal(slots[2].order, 20); assert.equal(slots[2].label(), '上下文')
  const injected = slots[2].inject('visible-session')
  assert.equal(injected.target, 'visible-session'); assert.equal(injected.pulse, pulse)
  assert.deepEqual(bindings, ['visible-session'])
  assert.equal(slots[0].inject('visible-session').directory, directory)
  assert.deepEqual(directories, ['visible-session'])
  for (const dispose of disposers) dispose?.()
})

test('tariff indicator shares the picker default without history or usage and follows accepted model switches', async () => {
  const dom = new JSDOM('<div id="root"></div>', { url: 'http://localhost' })
  globalThis.window = dom.window; globalThis.document = dom.window.document; globalThis.IS_REACT_ACT_ENVIRONMENT = true
  const listeners = new Set()
  let snapshot = { current: { provider: 'deepseek-official', model: 'deepseek-flash' }, pending: null }
  const directory = { subscribe: cb => { listeners.add(cb); return () => listeners.delete(cb) }, getSnapshot: () => snapshot }
  const root = createRoot(document.getElementById('root'))
  const publish = async patch => act(async () => { snapshot = { ...snapshot, ...patch }; listeners.forEach(cb => cb()) })
  const select = current => publish({ current, pending: null })
  try {
    await act(async () => root.render(React.createElement(client.PeakIndicator, { directory })))
    assert.ok(document.querySelector('[aria-label^="DeepSeek 官方计费"]'), 'fresh default official model displays before first request or usage reading')
    assert.equal(document.querySelector('.cmi-peak a'), null, 'indicator opens a local panel without navigation')
    assert.equal(document.querySelector('.cmi-peak style').dataset.plugin, 'dsh-context-manager')
    await publish({ pending: { provider: 'third-party', model: 'deepseek-flash' } })
    assert.ok(document.querySelector('.cmi-peak'), 'pending switch keeps the currently displayed model')
    await publish({ pending: null, error: 'selection failed' })
    assert.ok(document.querySelector('.cmi-peak'), 'failed switch keeps the accepted selection')
    await select({ provider: 'third-party', model: 'deepseek-flash' })
    assert.equal(document.querySelector('.cmi-peak'), null, 'same model name on third-party route is not official')
    await publish({ pending: { provider: 'deepseek-account', model: 'deepseek-v4-pro' } })
    assert.equal(document.querySelector('.cmi-peak'), null, 'unconfirmed official selection does not claim success')
    await select({ provider: 'deepseek-account', model: 'deepseek-v4-pro' })
    assert.ok(document.querySelector('.cmi-peak'))
    await select(null); assert.equal(document.querySelector('.cmi-peak'), null)
  } finally {
    await act(async () => root.unmount()); assert.equal(listeners.size, 0)
    dom.window.close(); delete globalThis.window; delete globalThis.document
  }
})

test('inspector cancels stale Session reads, never flashes another Session and releases subscriptions', async () => {
  const dom = new JSDOM('<div id="root"></div>', { url: 'http://localhost' })
  globalThis.window = dom.window; globalThis.document = dom.window.document; globalThis.IS_REACT_ACT_ENVIRONMENT = true
  const listeners = new Set(); const calls = []
  const state = { status: 'ready', writable: true, revision: 1, value: { policy: defaults } }
  const form = { subscribe: () => () => {}, getSnapshot: () => state }
  const pulse = { subscribe: cb => { listeners.add(cb); return () => listeners.delete(cb) }, getSnapshot: () => 1 }
  const api = { idleStatus: async () => ({ status: 'off', dueAt: null, message: '闲置自动压缩已关闭' }), inspect: (query, signal) => new Promise(resolve => calls.push({ query, signal, resolve })), content: () => { throw new Error('content is lazy') } }
  const snapshot = sessionId => ({ sessionId, cursor: 1, cutSeq: 1, sampledAt: 1000, historical: false,
    pressure: null, official: null, usage: null, model: { provider: 'fixture', model: sessionId, effort: null, maxTokens: null },
    parts: [], rows: [], total: 0, offset: 0, pageSize: 50, activeCount: 0, archivedCount: 0, requests: [], requestCount: 0, pressureHistory: [], compactions: [] })
  const root = createRoot(document.getElementById('root'))
  const render = async target => { await act(async () => root.render(React.createElement(client.ContextInspectorView, { target, form, api, pulse }))); await act(async () => new Promise(resolve => setTimeout(resolve, 230))) }
  try {
    await render('first-session')
    await render('second-session')
    assert.equal(calls[0].signal.aborted, true)
    await act(async () => calls[0].resolve(snapshot('first-session')))
    assert.ok(!document.body.textContent.includes('fixture / first-session'))
    await act(async () => calls[1].resolve(snapshot('second-session')))
    assert.match(document.body.textContent, /fixture \/ second-session/)
    assert.match(document.body.textContent, /等待完整参数/)
    assert.equal(document.querySelectorAll('[role="tab"]').length, 0, 'all context sections share one panel')
    for (const title of ['当前上下文', '最近压缩', '展开当前有效内容', '当前有效内容', '占用变化', '本会话累计']) assert.ok(document.body.textContent.includes(title), title)
    assert.equal(document.querySelector('#cmi-content-panel'), null, 'entry shows compact preview without loading bodies')
    assert.ok(!document.body.textContent.includes('预计可继续执行'))
    assert.equal(document.querySelectorAll('style:not([data-plugin="dsh-context-manager"])').length, 0)
    await render('third-session')
    assert.ok(!document.body.textContent.includes('fixture / second-session'))
  } finally {
    await act(async () => root.unmount())
    assert.equal(calls.at(-1).signal.aborted, true); assert.equal(listeners.size, 0)
    dom.window.close(); delete globalThis.window; delete globalThis.document
  }
})

test('the session total and every legend row follow one completeness rule instead of a bare zero', async () => {
  const dom = new JSDOM('<div id="root"></div>', { url: 'http://localhost' })
  globalThis.window = dom.window; globalThis.document = dom.window.document; globalThis.IS_REACT_ACT_ENVIRONMENT = true
  const state = { status: 'ready', writable: true, revision: 1, value: { policy: { ...defaults } } }
  const form = { subscribe: () => () => {}, getSnapshot: () => state }
  const pulse = { subscribe: () => () => {}, getSnapshot: () => 1 }
  const field = (sum, reported, missing) => ({ sum, reported, missing })
  const efficiency = mirrored => ({ accounting: 'host-projection', host: { uncachedInputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 0 },
    mirrored: { settledAttempts: 0, retries: 0, withoutUsage: 0, uncachedInput: field(0, 0, 0), cacheRead: field(0, 0, 0),
      cacheWrite: field(0, 0, 0), output: field(0, 0, 0), cacheInclusiveInput: field(0, 0, 0), complete: true, ...mirrored },
    differences: [], summaryAndRepair: null, maintenanceSuspects: 0, cacheHitRatio: null, requests: [], fingerprint: null, changes: [] })
  const zero = { input: 0, uncached: 0, cacheRead: 0, cacheWrite: 0, output: 0 }
  const fixture = (usage, efficiencyReadout) => ({ sessionId: 'total-session', cursor: 3, cutSeq: 3, sampledAt: 1000, historical: false,
    pressure: null, official: null, usage, model: null, parts: [], rows: [], total: 0, offset: 0, pageSize: 50, activeCount: 0,
    archivedCount: 0, requests: [], requestCount: 0, pressureHistory: [], compactions: [], efficiency: efficiencyReadout })
  let payload = fixture(zero, efficiency({}))
  const api = { idleStatus: async () => ({ status: 'off', dueAt: null, message: '闲置自动压缩已关闭' }),
    // Each case reads its own Session so a stale response can never be shown.
    inspect: async query => ({ ...payload, sessionId: query.sessionId }), content: () => { throw new Error('content is lazy') } }
  const root = createRoot(document.getElementById('root'))
  const render = async target => { await act(async () => root.render(React.createElement(client.ContextInspectorView, { target, form, api, pulse }))); await act(async () => new Promise(resolve => setTimeout(resolve, 230))) }
  const total = () => document.querySelector('[data-usage-completeness]')
  const number = () => total().querySelector('strong').textContent
  const unit = () => total().querySelector('span').textContent
  const legend = () => [...document.querySelectorAll('[data-legend-missing]')]
  try {
    // A session that never settled an attempt is a normal, complete zero.
    await render('total-empty')
    assert.equal(total().dataset.usageCompleteness, 'complete')
    assert.equal(number(), '0'); assert.equal(unit(), 'Token')
    assert.deepEqual(legend().map(row => row.dataset.legendMissing), ['0', '0', '0', '0'])
    // Host buckets of zero plus attempts that never reported usage are not a zero.
    payload = fixture(zero, efficiency({ settledAttempts: 2, withoutUsage: 2, output: field(0, 0, 2), complete: false }))
    await render('total-unknown')
    assert.equal(total().dataset.usageCompleteness, 'unknown')
    assert.equal(number(), '—'); assert.equal(unit(), '未知')
    assert.ok(!/\d/.test(number()), 'an unreported total is not rendered as a complete number')
    assert.equal(legend().length, 4)
    assert.ok(legend().every(row => row.dataset.legendMissing === 'unknown'), 'every legend row shares the unknown state')
    assert.ok(legend().every(row => row.querySelector('dd').textContent === '—未知'),
      'the legend does not present the unreported buckets as measured zeros')
    assert.ok(document.querySelector('[data-usage-bound="unknown"]'))
    // Known buckets stay visible, but the total is a labelled lower bound and the
    // rows that really carry unreported samples say so.
    payload = fixture({ input: 90, uncached: 60, cacheRead: 30, cacheWrite: 0, output: 20 },
      efficiency({ host: { uncachedInputTokens: 60, cacheReadTokens: 30, cacheWriteTokens: 0, outputTokens: 20 }, settledAttempts: 2,
        withoutUsage: 1, uncachedInput: field(60, 1, 1), cacheRead: field(30, 1, 0), cacheWrite: field(0, 1, 0), output: field(20, 1, 1), complete: false }))
    await render('total-partial')
    assert.equal(total().dataset.usageCompleteness, 'partial')
    assert.equal(number(), '≥ 110'); assert.equal(unit(), 'Token')
    assert.deepEqual(legend().map(row => row.dataset.legendMissing), ['1', '0', '0', '1'])
    assert.match(legend()[0].querySelector('dd').textContent, /^60/)
    assert.match(legend()[0].querySelector('dd small').textContent, /1 未知/)
    assert.ok(!legend()[1].querySelector('dd small').textContent.includes('未知'),
      'a fully reported row does not borrow the lower-bound wording')
    assert.ok(document.querySelector('[data-usage-bound="partial"]'))
    // Every settled attempt reported every component: the plain total returns.
    payload = fixture({ input: 90, uncached: 60, cacheRead: 30, cacheWrite: 0, output: 20 },
      efficiency({ host: { uncachedInputTokens: 60, cacheReadTokens: 30, cacheWriteTokens: 0, outputTokens: 20 }, settledAttempts: 2,
        uncachedInput: field(60, 2, 0), cacheRead: field(30, 2, 0), cacheWrite: field(0, 2, 0), output: field(20, 2, 0) }))
    await render('total-complete')
    assert.equal(total().dataset.usageCompleteness, 'complete')
    assert.equal(number(), '110'); assert.equal(unit(), 'Token')
    assert.equal(document.querySelector('[data-usage-bound]'), null)
  } finally { await act(async () => root.unmount()); dom.window.close(); delete globalThis.window; delete globalThis.document }
})

test('read-only view hides only its own composer, restores drafts and reads only the selected body by default', async () => {
  const dom = new JSDOM(`<div data-conversation-content data-conversation-session="visible-session"><div data-conversation-scroll><div id="root"></div><div data-composer-seat style="display: flex; color: red"><textarea>unsent draft</textarea></div></div></div><div data-conversation-content data-conversation-session="other-session"><div data-conversation-scroll><div data-composer-seat><textarea>other draft</textarea></div></div></div>`, { url: 'http://localhost' })
  globalThis.window = dom.window; globalThis.document = dom.window.document; globalThis.IS_REACT_ACT_ENVIRONMENT = true
  const state = { status: 'ready', writable: true, revision: 1, value: { policy: defaults } }
  const form = { subscribe: () => () => {}, getSnapshot: () => state }
  const pulse = { subscribe: () => () => {}, getSnapshot: () => 1 }
  const categories = ['system', 'tools', 'user', 'inject', 'skill', 'assistant', 'tool']
  const row = { id: 'body', seq: 1, title: 'test body', category: 'user', current: true, source: 'test', tokens: 20, images: 0 }
  let reads = 0
  const api = { idleStatus: async () => ({ status: 'off', dueAt: null, message: '闲置自动压缩已关闭' }), inspect: async query => ({ ...query, cursor: 1, cutSeq: 1, sampledAt: 1000, historical: false, pressure: null, official: null, usage: null, model: null,
    parts: categories.map((category, i) => ({ category, tokens: 70 - i * 10 })), rows: [row], total: 1, pageSize: 50, activeCount: 1, archivedCount: 0,
    requests: [], requestCount: 0, pressureHistory: [], compactions: [1, 2, 3, 4].map(id => ({ id: String(id), kind: 'compact', status: 'completed', startedAt: 1000, applied: true, beforeTokens: 20, afterTokens: 10 })) }),
    content: async query => { reads++; return { ...query, text: 'read-only content', totalChars: 17, nextOffset: null } } }
  const root = createRoot(document.getElementById('root'))
  const [seat, other] = document.querySelectorAll('[data-composer-seat]')
  const render = async () => { await act(async () => root.render(React.createElement(client.ContextInspectorView, { target: 'visible-session', form, api, pulse }))); await act(async () => new Promise(resolve => setTimeout(resolve, 230))) }
  const click = async text => act(async () => [...document.querySelectorAll('button')].find(button => button.textContent === text).click())
  try {
    await render()
    assert.equal(seat.style.display, 'none'); assert.equal(seat.style.getPropertyPriority('display'), 'important')
    assert.ok(seat.hasAttribute('hidden') && seat.hasAttribute('inert'))
    assert.equal(other.getAttribute('style'), null); assert.equal(other.hasAttribute('hidden'), false)
    assert.equal(reads, 0, 'compact preview does not fetch bodies')
    await click('展开当前有效内容')
    assert.equal(reads, 1, 'explicit expansion fetches only the selected body')
    assert.equal(document.querySelectorAll('.cmv-legend > button').length, 4)
    assert.equal(document.querySelectorAll('.cmv-events > li').length, 2)
    assert.match(document.querySelector('.cmv-record-detail').textContent, /减少 10 Token · 50%/)
    await click('全部记录'); assert.equal(document.querySelectorAll('.cmv-events > li').length, 4)
    assert.match(document.querySelector('.cmi-body').textContent, /read-only content/)
    await click('收起当前有效内容'); assert.equal(document.querySelector('#cmi-content-panel'), null)
    await click('展开当前有效内容')
    assert.equal(reads, 2)
    await click('收起当前有效内容'); assert.equal(document.querySelector('#cmi-content-panel'), null)
    await act(async () => root.render(null))
    assert.equal(seat.style.display, 'flex'); assert.equal(seat.style.color, 'red')
    assert.equal(seat.hasAttribute('hidden'), false); assert.equal(seat.hasAttribute('inert'), false)
    assert.equal(seat.querySelector('textarea').value, 'unsent draft')
    assert.equal(other.querySelector('textarea').value, 'other draft')
    // An existing hidden/inert state belongs to the host and must survive us.
    seat.setAttribute('hidden', 'until-found'); seat.setAttribute('inert', 'host-owned')
    await render(); await act(async () => root.render(null))
    assert.equal(seat.getAttribute('hidden'), 'until-found'); assert.equal(seat.getAttribute('inert'), 'host-owned')
    assert.equal(seat.style.display, 'flex')
  } finally { await act(async () => root.unmount()); dom.window.close(); delete globalThis.window; delete globalThis.document }
})

test('compact previews reset per target, stay collapsed on refresh, and cancel stale paginated bodies', async () => {
  const dom = new JSDOM('<div id="root"></div>', { url: 'http://localhost' })
  globalThis.window = dom.window; globalThis.document = dom.window.document; globalThis.IS_REACT_ACT_ENVIRONMENT = true
  const state = { status: 'ready', writable: true, revision: 1, value: { policy: defaults } }
  const form = { subscribe: () => () => {}, getSnapshot: () => state }
  const listeners = new Set(); let revision = 0
  const pulse = { subscribe: cb => { listeners.add(cb); return () => listeners.delete(cb) }, getSnapshot: () => revision }
  const inspections = []; const bodies = []
  const rows = Array.from({ length: 51 }, (_, seq) => ({ id: `event:${seq}`, seq, title: `item ${seq}`, category: 'user', current: true, source: 'fixture', tokens: 20, images: 0 }))
  const api = { idleStatus: async () => ({ status: 'off', dueAt: null, message: '闲置自动压缩已关闭' }),
    inspect: async query => {
      inspections.push(query)
      return { ...query, cursor: 100, cutSeq: 100, sampledAt: 1000, historical: false, pressure: null, official: null,
        usage: { input: 123, output: 45, cacheRead: 60 }, model: null, parts: [], rows: rows.slice(query.offset, query.offset + 50),
        total: rows.length, pageSize: 50, activeCount: rows.length, archivedCount: 0, requests: [], requestCount: 0, pressureHistory: [], compactions: [] }
    },
    content: (query, signal) => new Promise(resolve => bodies.push({ query, signal, resolve })),
  }
  const root = createRoot(document.getElementById('root'))
  const settle = () => act(async () => new Promise(resolve => setTimeout(resolve, 230)))
  const render = target => act(async () => root.render(React.createElement(client.ContextInspectorView, { target, form, api, pulse })))
  const click = text => act(async () => {
    const button = [...document.querySelectorAll('button')].find(button => button.textContent === text)
    assert.ok(button && !button.disabled, text); button.click()
  })
  const reply = (call, text, nextOffset = null, totalChars = text.length) => act(async () => call.resolve({ ...call.query, text, nextOffset, totalChars }))
  const content = () => document.querySelector('#cmi-content-panel')
  try {
    await render('a'); await settle()
    assert.equal(content(), null); assert.equal(document.querySelectorAll('.cmv-preview > button').length, 3)
    assert.equal(bodies.length, 0); await click('展开当前有效内容')
    assert.ok(content()); assert.ok(document.querySelector('#cmi-history-panel'))
    for (const title of ['当前有效内容', '占用变化', '本会话累计']) assert.ok(document.body.textContent.includes(title), title)
    assert.equal(document.querySelectorAll('.cmi-content-list > button[aria-pressed]').length, 4)
    assert.equal(bodies.length, 1, 'opening details does not prefetch all 51 bodies')
    await reply(bodies[0], 'a'.repeat(16000), 16000, 32000)
    await click('下一段')
    assert.equal(bodies.length, 2); assert.equal(bodies[1].query.offset, 16000)
    await render('b')
    assert.equal(bodies[1].signal.aborted, true)
    assert.equal(document.querySelector('.cmi-body'), null, 'target switch clears old body immediately')
    await reply(bodies[1], 'late body from a')
    assert.ok(!document.body.textContent.includes('late body from a'))
    await settle()
    assert.equal(content(), null); await click('展开当前有效内容')
    assert.ok(content()); assert.equal(bodies[2].query.sessionId, 'b'); assert.equal(bodies[2].query.offset, 0)
    await click('收起当前有效内容')
    assert.equal(bodies[2].signal.aborted, true)
    await reply(bodies[2], 'late body from b')
    assert.equal(content(), null); assert.ok(!document.body.textContent.includes('late body from b'))
    const readsBeforeRefresh = bodies.length
    const inspectionsBeforeRefresh = inspections.length
    await click('刷新数据'); await settle()
    assert.equal(inspections.length, inspectionsBeforeRefresh + 1)
    assert.equal(content(), null); assert.equal(bodies.length, readsBeforeRefresh)
    await act(async () => { revision++; listeners.forEach(cb => cb()) }); await settle()
    assert.equal(inspections.length, inspectionsBeforeRefresh + 2)
    assert.equal(content(), null); assert.equal(bodies.length, readsBeforeRefresh, 'projection refresh preserves manual collapse')
    await render('a'); await settle()
    assert.equal(content(), null, 'changing target resets to compact preview')
    await click('展开当前有效内容')
    assert.equal(bodies.at(-1).query.sessionId, 'a'); assert.equal(bodies.at(-1).query.offset, 0)
    await reply(bodies.at(-1), 'new a body')
    await click('下一页'); await settle()
    assert.equal(inspections.at(-1).offset, 50)
    assert.equal(document.querySelectorAll('.cmi-content-list > button[aria-pressed]').length, 1)
    assert.equal(bodies.at(-1).query.id, 'event:50')
    await reply(bodies.at(-1), 'last page body')
    await click('收起当前有效内容')
    await act(async () => root.render(null))
    await render('a'); await settle()
    assert.equal(content(), null, 'reopening starts with compact preview')
    await click('展开当前有效内容')
    assert.equal(inspections.at(-1).offset, 0); assert.equal(bodies.at(-1).query.id, 'event:0')
  } finally {
    await act(async () => root.unmount())
    for (const body of bodies) assert.equal(body.signal.aborted, true)
    assert.equal(listeners.size, 0)
    dom.window.close(); delete globalThis.window; delete globalThis.document
  }
})

test('settings UI stages edits, validates them and saves the complete policy with a revision fence', async () => {
  const dom = new JSDOM('<div id="root"></div>', { url: 'http://localhost' })
  globalThis.window = dom.window; globalThis.document = dom.window.document; globalThis.IS_REACT_ACT_ENVIRONMENT = true
  const listeners = new Set(); const writes = []
  let snapshot = { status: 'ready', writable: true, mode: 'host', revision: 4, value: { policy: { ...defaults } } }
  const form = { subscribe: cb => { listeners.add(cb); return () => listeners.delete(cb) }, getSnapshot: () => snapshot,
    async mutate(ops, revision) { writes.push({ ops, revision }); snapshot = { ...snapshot, revision: 5, value: { policy: ops[0].value } }; listeners.forEach(cb => cb()); return true } }
  const root = createRoot(document.getElementById('root'))
  try {
    await act(async () => root.render(React.createElement(client.ContextSettings, { form })))
    assert.equal(document.querySelector('style').dataset.plugin, 'dsh-context-manager')
    assert.match(document.body.textContent, /新消息会计入检查/)
    assert.equal(document.querySelector('#context-manager-idleMinutes').value, '15')
    assert.equal(document.querySelector('#context-manager-idleMinPercent').value, '65')
    const buttons = () => [...document.querySelectorAll('button')]
    await act(async () => buttons().find(b => b.textContent === '提前整理 · 70%').click())
    assert.equal(writes.length, 0)
    assert.equal(document.querySelector('#context-manager-triggerPercent').value, '70')
    await act(async () => buttons().find(b => b.textContent === '保存设置').click())
    assert.equal(writes.length, 1); assert.equal(writes[0].revision, 4)
    assert.equal(writes[0].ops[0].value.triggerPercent, 70)
    assert.equal(writes[0].ops[0].value.targetPercent, defaults.targetPercent, 'trigger presets preserve the saved custom cap')
    assert.equal(writes[0].ops[0].value.historyMode, 'automatic')
    assert.equal(writes[0].ops[0].value.recentTokens, 20000)
    assert.match(document.body.textContent, /已保存/)
    await act(async () => document.querySelector('[role="switch"]').click())
    assert.equal(document.querySelector('#context-manager-idleMinutes').disabled, true)
    assert.equal(writes.length, 1, 'toggling the native switch still only stages an edit')
  } finally { await act(async () => root.unmount()); dom.window.close(); delete globalThis.window; delete globalThis.document }
})

test('settings: idle fields preserve invalid drafts, save focus, and handle stale or read-only documents', async () => {
  const dom = new JSDOM('<div id="root"></div>', { url: 'http://localhost' })
  globalThis.window = dom.window; globalThis.document = dom.window.document; globalThis.IS_REACT_ACT_ENVIRONMENT = true
  let snapshot = { status: 'ready', writable: true, mode: 'host', revision: 9, value: { policy: { ...defaults } } }
  const listeners = new Set(); const writes = []; let accept = false
  const form = { subscribe: cb => { listeners.add(cb); return () => listeners.delete(cb) }, getSnapshot: () => snapshot,
    async mutate(ops, revision) { writes.push({ ops, revision }); return accept } }
  const root = createRoot(document.getElementById('root'))
  const save = () => [...document.querySelectorAll('button')].find(b => b.textContent === '保存设置')
  const edit = async (key, value) => act(async () => Simulate.change(document.getElementById(`context-manager-${key}`), { target: { value } }))
  try {
    await act(async () => root.render(React.createElement(client.ContextSettings, { form })))
    await edit('idleMinutes', '1x')
    assert.equal(document.getElementById('context-manager-idleMinutes').value, '1x')
    assert.equal(save().disabled, true)
    await edit('idleMinutes', '30'); await edit('idleMinPercent', '70'); await edit('summaryInstructions', '保留用户约束与验收命令')
    await act(async () => { snapshot = { ...snapshot, revision: 10 }; listeners.forEach(cb => cb()) })
    await act(async () => save().click())
    assert.equal(writes[0].revision, 9, 'dirty draft retains its original revision')
    assert.match(document.body.textContent, /未保存/)
    assert.equal(writes[0].ops[0].value.idleMinutes, 30)
    assert.equal(writes[0].ops[0].value.idleMinPercent, 70)
    assert.equal(writes[0].ops[0].value.summaryInstructions, '保留用户约束与验收命令')
    await act(async () => { snapshot = { ...snapshot, writable: false }; listeners.forEach(cb => cb()) })
    assert.equal(document.getElementById('context-manager-idleMinutes').disabled, true)
    assert.equal(save().disabled, true)
    assert.match(document.body.textContent, /不支持保存/)
  } finally { await act(async () => root.unmount()); dom.window.close(); delete globalThis.window; delete globalThis.document }
})

test('idle status refreshes after task completion even without a pressure change; it never polls transcript bodies', async t => {
  const dom = new JSDOM('<div id="root"></div>', { url: 'http://localhost' })
  globalThis.window = dom.window; globalThis.document = dom.window.document; globalThis.IS_REACT_ACT_ENVIRONMENT = true
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const state = { status: 'ready', writable: true, revision: 1, value: { policy: defaults } }
  const form = { subscribe: () => () => {}, getSnapshot: () => state }
  const pulse = { subscribe: () => () => {}, getSnapshot: () => 1 }
  let inspections = 0; const reads = []
  const api = {
    idleStatus: async (_query, signal) => { reads.push(signal); return reads.length === 1
      ? { status: 'waiting', dueAt: null, message: '等待任务结束' }
      : { status: 'scheduled', dueAt: Date.now() + 60000, message: '已开始计时' } },
    inspect: async query => { inspections++; return { ...query, cursor: 1, cutSeq: 1, sampledAt: 1000, historical: false,
      pressure: null, official: null, usage: null, model: null, parts: [], rows: [], total: 0, pageSize: 50,
      activeCount: 0, archivedCount: 0, requests: [], requestCount: 0, pressureHistory: [], compactions: [] } },
    content: async () => { throw new Error('empty history has no body') },
  }
  const root = createRoot(document.getElementById('root'))
  try {
    await act(async () => root.render(React.createElement(client.ContextInspectorView, { target: 'test', form, api, pulse })))
    await act(async () => t.mock.timers.tick(250))
    assert.match(document.body.textContent, /等待任务结束/)
    await act(async () => t.mock.timers.tick(5000))
    assert.match(document.body.textContent, /分钟后检查/)
    assert.equal(inspections, 1); assert.equal(reads.length, 2)
    await act(async () => root.render(null)); t.mock.timers.tick(5000)
    assert.equal(reads.length, 2); assert.ok(reads.every(signal => signal.aborted))
  } finally { await act(async () => root.unmount()); dom.window.close(); delete globalThis.window; delete globalThis.document }
})

test('native price popover stays local, calculates entered usage, dismisses, and handles unpriced official models', async () => {
  const dom = new JSDOM('<div id="root"></div><button id="outside">Outside</button>', { url: 'http://localhost' })
  globalThis.window = dom.window; globalThis.document = dom.window.document; globalThis.IS_REACT_ACT_ENVIRONMENT = true
  const listeners = new Set()
  let snapshot = { current: { provider: 'deepseek-official', model: 'deepseek-flash' } }
  const directory = { subscribe: cb => { listeners.add(cb); return () => listeners.delete(cb) }, getSnapshot: () => snapshot }
  const root = createRoot(document.getElementById('root'))
  const trigger = () => document.querySelector('.cmi-peak button')
  try {
    await act(async () => root.render(React.createElement(client.PeakIndicator, { directory })))
    await act(async () => trigger().click())
    const dialog = document.querySelector('[role="dialog"]')
    assert.ok(dialog); assert.equal(dialog.parentNode, document.body, 'escapes clipping ancestors')
    assert.ok(dialog.querySelector('[data-menu-material]') || dialog.matches('[data-menu-material]'))
    assert.equal(window.location.href, 'http://localhost/')
    assert.deepEqual([...dialog.querySelectorAll('input')].map(input => input.value), ['', '', ''])
    assert.equal(dialog.querySelector('.cmi-price-totals').textContent, '高峰预估—低谷预估—')
    for (const input of dialog.querySelectorAll('input')) await act(async () => Simulate.change(input, { target: { value: '1000000' } }))
    assert.match(dialog.querySelector('.cmi-price-totals').textContent, /¥10.04.*¥5.02/)
    assert.match(dialog.textContent, /不是实际账单/)
    await act(async () => Simulate.change(dialog.querySelector('input'), { target: { value: '-2' } }))
    assert.equal(dialog.querySelector('input').getAttribute('aria-invalid'), 'true')
    assert.match(dialog.querySelector('[role="alert"]').textContent, /非负整数/)
    await act(async () => document.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true })))
    assert.equal(document.querySelector('[role="dialog"]'), null); assert.equal(document.activeElement, trigger())
    await act(async () => trigger().click())
    await act(async () => document.getElementById('outside').dispatchEvent(new window.Event('pointerdown', { bubbles: true })))
    assert.equal(document.querySelector('[role="dialog"]'), null)
    await act(async () => { snapshot = { current: { provider: 'deepseek-account', model: 'future-model' } }; listeners.forEach(cb => cb()) })
    await act(async () => trigger().click())
    assert.match(document.querySelector('[role="dialog"]').textContent, /价格尚未收录/)
    assert.equal(document.querySelector('[role="dialog"] input'), null)
    assert.equal(document.querySelector('[role="dialog"] a').href, 'https://api-docs.deepseek.com/zh-cn/quick_start/pricing/')
    await act(async () => { snapshot = { current: { provider: 'other', model: 'deepseek-flash' } }; listeners.forEach(cb => cb()) })
    assert.equal(document.querySelector('[role="dialog"]'), null); assert.equal(trigger(), null)
  } finally { await act(async () => root.unmount()); dom.window.close(); delete globalThis.window; delete globalThis.document }
})

test('context charts keep projection gaps, disjoint cache buckets, step changes and empty usage honest', async () => {
  const dom = new JSDOM('<div id="root"></div>', { url: 'http://localhost' })
  globalThis.window = dom.window; globalThis.document = dom.window.document; globalThis.IS_REACT_ACT_ENVIRONMENT = true
  const snapshot = { sessionId: 'charts', cursor: 9, cutSeq: 9, sampledAt: 1000, historical: false,
    pressure: null, official: null, usage: { input: 110, uncached: 30, cacheRead: 70, cacheWrite: 10, output: 90 }, model: null,
    parts: [], rows: [], total: 0, offset: 0, pageSize: 50, activeCount: 0, archivedCount: 0,
    requests: [{ seq: 1, time: 1000, turn: 1, step: 1, provider: 'fixture', model: 'offline', input: 900, output: 30, cacheRead: 0 }, { seq: 3, time: 2000, turn: 2, step: 1, provider: 'fixture', model: 'offline', input: 400, output: 60, cacheRead: 0 }],
    requestCount: 2, compactions: [], pressureHistory: [{ seq: 1, time: 1000, kind: 'reply', tokens: 900, window: 1000 }, { seq: 2, time: 2000, kind: 'reply', tokens: null, window: null }, { seq: 3, time: 3000, kind: 'replace', tokens: 300, window: 1000 }] }
  const formValue = { revision: 1, value: { policy: defaults } }
  const form = { subscribe: () => () => {}, getSnapshot: () => formValue }
  const pulse = { subscribe: () => () => {}, getSnapshot: () => 1 }
  const api = { idleStatus: async () => ({ status: 'off', dueAt: null, message: '' }), inspect: async () => snapshot }
  const root = createRoot(document.getElementById('root'))
  try {
    await act(async () => root.render(React.createElement(client.ContextInspectorView, { target: 'charts', form, api, pulse })))
    await act(async () => new Promise(resolve => setTimeout(resolve, 230)))
    assert.equal(document.querySelectorAll('.cmv-bars>button').length, 3)
    assert.equal(document.querySelectorAll('.cmv-bars>button[data-unknown="true"]').length, 1)
    assert.equal(document.querySelector('.cmv-bars>button[data-unknown="true"]>span').style.height, '0px')
    assert.equal(document.querySelectorAll('svg path.cmi-pressure-line').length, 0)
    assert.equal(document.querySelector('.cmv-usage-stack [data-usage="read"]').style.width, '35%')
    assert.equal(document.querySelector('.cmv-usage-stack [data-usage="write"]').style.width, '5%')
    assert.equal(document.querySelectorAll('.cmv-request-details tbody tr').length, 2)
    const cards = [...document.querySelector('.cmv-chart-grid').children].map(node => node.querySelector('h3').textContent)
    assert.deepEqual(cards, ['占用变化', '最近压缩', '本会话累计'])
    assert.ok(document.querySelector('.cmv-content').compareDocumentPosition(document.querySelector('.cmv-chart-grid')) & 2, 'content follows every chart')
    assert.equal(document.querySelectorAll('[role="tab"]').length, 0)
  } finally { await act(async () => root.unmount()); dom.window.close(); delete globalThis.window; delete globalThis.document }
})

test('current context shows one full 1M window and every K bucket without a basis switch', async () => {
  const dom = new JSDOM('<div id="root"></div>', { url: 'http://localhost' })
  globalThis.window = dom.window; globalThis.document = dom.window.document; globalThis.IS_REACT_ACT_ENVIRONMENT = true
  const snapshot = { sessionId: 'capacity', cursor: 2, cutSeq: 2, sampledAt: 1000, historical: false,
    pressure: {window:1000000,projected:320000,input:310000}, official: null, usage: null, model: {provider:'mock',model:'large',maxTokens:64000,effort:null},
    admission: {tokens:320000,logRevision:3,baseline:'usage',window:1000000,outputReserve:64000},
    parts: [{category:'summary',tokens:30000,count:1},{category:'tool',tokens:200000,count:1},{category:'user',tokens:50000,count:1},{category:'system',tokens:20000,count:1}],
    rows: [], total: 0, offset: 0, pageSize: 50, activeCount: 4, archivedCount: 0, requests: [], requestCount: 0, compactions: [], pressureHistory: [] }
  const formValue = { revision: 1, value: { policy: defaults } }
  const form = { subscribe: () => () => {}, getSnapshot: () => formValue }
  const pulse = { subscribe: () => () => {}, getSnapshot: () => 1 }
  let inspected
  const ready = new Promise(resolve => { inspected = resolve })
  const api = { idleStatus: async () => ({ status: 'off', dueAt: null, message: '' }), inspect: async () => { inspected(); return snapshot } }
  const root = createRoot(document.getElementById('root'))
  try {
    await act(async () => root.render(React.createElement(client.ContextInspectorView, { target: 'capacity', form, api, pulse })))
    await act(async () => ready)
    const card = document.querySelector('.cmv-composition')
    assert.equal(card.querySelector('.cmv-number strong').textContent,'≈ 320K')
    assert.equal(card.querySelector('.cmv-number span').textContent,'/ 1M Token')
    assert.ok(card.querySelector('.cmv-context-title .cmv-model'))
    assert.equal(card.querySelector('.cmv-capacity-stack').dataset.capacity,'1000000')
    assert.equal(card.querySelector('[data-color="free"]').style.width,'47%')
    assert.equal(card.querySelector('.cmv-capacity-stack').lastElementChild.dataset.color,'reserve')
    assert.equal(card.querySelector('[data-color="reserve"]').style.width,'21%')
    assert.equal(card.querySelector('[data-color="other"]').style.width,'2%')
    assert.equal(card.querySelectorAll('.cmv-capacity-stack').length,1)
    assert.equal(card.querySelectorAll('[aria-pressed]').length,0,'no hidden full-window toggle')
    assert.deepEqual([...card.querySelectorAll('.cmv-key')].map(node=>node.textContent),['记忆摘要30K3.0%','工具结果200K20.0%','对话消息50K5.0%','指令与定义20K2.0%','其他占用20K2.0%','未占用470K47.0%','压缩预留210K21.0%'])
    assert.equal(card.querySelector('[data-color="summary"]').style.width,'3%','retained memory keeps its actual share of the window')
    assert.match(card.querySelector('[data-slice="summary"]').title,/属于已用内容/)
    assert.match(card.querySelector('[data-slice="reserve"]').title,/检查线 790K/)
    assert.equal(card.querySelectorAll('.cmv-key:disabled').length,3,'unclassified usage, free space and reserve are not content filters')
  } finally { await act(async () => root.unmount()); dom.window.close(); delete globalThis.window; delete globalThis.document }
})

test('request status uses live admission pressure, leaves unknown cuts unknown and preserves projection trends', async () => {
  const dom = new JSDOM('<div id="root"></div>', { url: 'http://localhost' })
  globalThis.window = dom.window; globalThis.document = dom.window.document; globalThis.IS_REACT_ACT_ENVIRONMENT = true
  const base = { sessionId: 'admission', cursor: 2, cutSeq: 2, sampledAt: 1000, historical: false,
    pressure: { window: 200000, projected: 100000, input: 99000 }, official: null, usage: null,
    model: { provider: 'offline', model: '200k', maxTokens: 8192, effort: null }, parts: [], rows: [],
    total: 0, offset: 0, pageSize: 50, activeCount: 0, archivedCount: 0, requests: [], requestCount: 0, compactions: [],
    pressureHistory: [{ seq: 2, time: 1000, kind: 'current', tokens: 100000, window: 200000 }] }
  const reading = { tokens: 170000, logRevision: 3, baseline: 'usage', window: 200000, outputReserve: 8192 }
  const formValue = { revision: 1, value: { policy: defaults } }
  const form = { subscribe: () => () => {}, getSnapshot: () => formValue }
  const pulse = { subscribe: () => () => {}, getSnapshot: () => 1 }
  const root = createRoot(document.getElementById('root'))
  const render = async snapshot => {
    const api = { idleStatus: async () => ({ status: 'off', dueAt: null, message: '' }), inspect: async () => snapshot }
    await act(async () => root.render(React.createElement(client.ContextInspectorView, { target: 'admission', form, api, pulse })))
    await act(async () => new Promise(resolve => setTimeout(resolve, 230)))
  }
  const status = () => document.querySelector('.cmv-quick')
  try {
    await render({ ...base, admission: reading })
    assert.match(status().textContent, /预计先压缩，再执行/)
    assert.equal(status().querySelector('[data-admission-tokens]').dataset.admissionTokens, '170000')
    assert.match(status().textContent, /检查线 158\.0K/)
    assert.match(document.querySelector('.cmv-bars > button').getAttribute('aria-label'), /100,000/)
    assert.match(document.querySelector('.cmv-meta').textContent, /自动工作集/)
    assert.doesNotMatch(document.querySelector('.cmv-meta').textContent, /目标 55%/)
    await render({ ...base, pressure: { ...base.pressure, projected: 190000 }, admission: { ...reading, tokens: 50000 } })
    assert.match(status().textContent, /预计可继续执行/)
    for (const snapshot of [base, { ...base, admission: { ...reading, outputReserve: null } },
      { ...base, admission: { ...reading, window: null } }]) {
      await render(snapshot)
      assert.match(status().textContent, /等待完整参数/)
      assert.doesNotMatch(status().textContent, /预计可继续|预计先压缩/)
      assert.match(status().textContent, /检查线 —/)
    }
    await render({ ...base, admission: reading, historical: true })
    assert.match(status().textContent, /历史截面/)
    assert.match(status().textContent, /准入计量 未知/)
    assert.equal(status().querySelector('[data-admission-tokens]'), null)
  } finally { await act(async () => root.unmount()); dom.window.close(); delete globalThis.window; delete globalThis.document }
})

test('settings renders the absolute soft budget and repair controls with explainable preview and validation', async () => {
  const dom = new JSDOM('<div id="root"></div>', { url: 'http://localhost' })
  globalThis.window = dom.window; globalThis.document = dom.window.document; globalThis.IS_REACT_ACT_ENVIRONMENT = true
  const snapshot = { status: 'ready', writable: true, mode: 'host', revision: 4, value: { policy: { ...defaults } } }
  const form = { subscribe: () => () => {}, getSnapshot: () => snapshot, mutate: () => { throw new Error('unexpected write') } }
  const root = createRoot(document.getElementById('root'))
  try {
    await act(async () => root.render(React.createElement(client.ContextPage, { form })))
    const trigger = document.querySelector('#context-manager-absoluteTriggerTokens')
    const repair = document.querySelector('#context-manager-formatRepairMaxTokens')
    assert.ok(trigger && repair, 'trigger and repair controls render in automatic mode')
    assert.equal(document.querySelector('#context-manager-targetPercent'), null)
    assert.equal(document.querySelector('#context-manager-absoluteTargetTokens'), null, 'inactive saved caps are hidden')
    assert.equal(trigger.disabled, true, 'absolute fields start blocked until the strategy is enabled')
    const toggle = [...document.querySelectorAll('.cm-row')].find(row => row.textContent.includes('绝对工作历史软预算'))?.querySelector('button[role="switch"]')
    assert.ok(toggle, 'absolute budget toggle renders')
    await act(async () => toggle.click())
    assert.equal(trigger.disabled, false)
    // The example window must exceed the absolute trigger for it to bind.
    await act(async () => Simulate.change(document.querySelector('#context-manager-example'), { target: { value: '1000000' } }))
    await act(async () => Simulate.change(trigger, { target: { value: '200000' } }))
    assert.match(document.querySelector('.cm-native-example .cm-hint').textContent, /自动工作集.*20,000/)
    await act(async () => [...document.querySelectorAll('button')].find(button => button.textContent === '自定义占用上限').click())
    const target = document.querySelector('#context-manager-absoluteTargetTokens')
    assert.ok(target)
    assert.equal(target.disabled, false)
    await act(async () => Simulate.change(target, { target: { value: '100000' } }))
    const preview = document.querySelector('.cm-native-example .cm-hint').textContent
    assert.match(preview, /绝对软预算/)
    assert.match(preview, /200,000/)
    await act(async () => Simulate.change(target, { target: { value: '170000' } }))
    assert.match(document.querySelector('.cm-error')?.textContent ?? '', /至少低 20%/)
  } finally { await act(async () => root.unmount()); dom.window.close(); delete globalThis.window; delete globalThis.document }
})

test('settings migrates a legacy draft, preserves custom caps across modes and validates the recent-history budget', async () => {
  const dom = new JSDOM('<div id="root"></div>', { url: 'http://localhost' })
  globalThis.window = dom.window; globalThis.document = dom.window.document; globalThis.IS_REACT_ACT_ENVIRONMENT = true
  const { historyMode, recentTokens, ...legacy } = defaults
  let snapshot = { status: 'ready', writable: true, mode: 'host', revision: 12,
    value: { policy: { ...legacy, targetPercent: 45, absoluteEnabled: true, absoluteTargetTokens: 120000 } } }
  const listeners = new Set(); const writes = []
  const form = { subscribe: cb => { listeners.add(cb); return () => listeners.delete(cb) }, getSnapshot: () => snapshot,
    async mutate(ops, revision) {
      writes.push({ ops, revision }); snapshot = { ...snapshot, revision: 13, value: { policy: ops[0].value } }
      listeners.forEach(cb => cb()); return true
    } }
  const root = createRoot(document.getElementById('root'))
  const button = label => [...document.querySelectorAll('button')].find(node => node.textContent === label)
  const click = async label => act(async () => button(label).click())
  const edit = async (key, value) => act(async () => Simulate.change(document.getElementById(`context-manager-${key}`), { target: { value } }))
  try {
    await act(async () => root.render(React.createElement(client.ContextSettings, { form })))
    assert.equal(button('自动工作集').getAttribute('aria-pressed'), 'true')
    assert.equal(document.getElementById('context-manager-recentTokens').value, '20000')
    assert.equal(document.getElementById('context-manager-targetPercent'), null)
    await click('提前整理 · 70%')
    await click('自定义占用上限')
    assert.equal(document.getElementById('context-manager-targetPercent').value, '45')
    assert.equal(document.getElementById('context-manager-absoluteTargetTokens').value, '120000')
    await edit('targetPercent', '50'); await edit('absoluteTargetTokens', '130000')
    for (const invalid of ['999', '128001', '20000.5', '']) {
      await edit('recentTokens', invalid)
      assert.equal(button('保存设置').disabled, true, `invalid recent-history budget: ${invalid}`)
      assert.ok(document.querySelector('[role="alert"]'))
      assert.equal(writes.length, 0)
    }
    await edit('recentTokens', '24000')
    await click('自动工作集')
    assert.equal(document.getElementById('context-manager-targetPercent'), null)
    assert.equal(document.getElementById('context-manager-absoluteTargetTokens'), null)
    await click('保存设置')
    assert.equal(writes.length, 1)
    assert.equal(writes[0].revision, 12)
    assert.equal(writes[0].ops[0].value.historyMode, 'automatic')
    assert.equal(writes[0].ops[0].value.recentTokens, 24000)
    assert.equal(writes[0].ops[0].value.targetPercent, 50)
    assert.equal(writes[0].ops[0].value.absoluteTargetTokens, 130000)
    assert.equal(writes[0].ops[0].value.absoluteEnabled, true, 'automatic mode preserves the independent absolute trigger')
    await click('自定义占用上限')
    assert.equal(document.getElementById('context-manager-targetPercent').value, '50')
    assert.equal(document.getElementById('context-manager-absoluteTargetTokens').value, '130000')
  } finally { await act(async () => root.unmount()); dom.window.close(); delete globalThis.window; delete globalThis.document }
})
test('settings expose the tool-result mode, thresholds and prefix switch with legacy fill-in and invalid empty numbers', async () => {
  const dom = new JSDOM('<div id="root"></div>', { url: 'http://localhost' })
  globalThis.window = dom.window; globalThis.document = dom.window.document; globalThis.IS_REACT_ACT_ENVIRONMENT = true
  const listeners = new Set(); const writes = []
  // A legacy document: none of the new keys exist yet.
  const legacy = { ...defaults }
  for (const key of ['toolResultsMode', 'toolResultsMaxChars', 'toolResultsMinSavings', 'archiveReadBudget', 'archiveSearchLimit', 'prefixDiagnosticsEnabled']) delete legacy[key]
  let snapshot = { status: 'ready', writable: true, mode: 'host', revision: 3, value: { policy: legacy } }
  const form = { subscribe: cb => { listeners.add(cb); return () => listeners.delete(cb) }, getSnapshot: () => snapshot,
    async mutate(ops, revision) { writes.push({ ops, revision }); snapshot = { ...snapshot, revision: revision + 1, value: { policy: ops[0].value } }; listeners.forEach(cb => cb()); return true } }
  const root = createRoot(document.getElementById('root'))
  const button = text => [...document.querySelectorAll('button')].find(b => b.textContent === text)
  const save = () => button('保存设置')
  const edit = (key, value) => act(async () => Simulate.change(document.getElementById(`context-manager-${key}`), { target: { value } }))
  try {
    await act(async () => root.render(React.createElement(client.ContextSettings, { form })))
    // Legacy fill-in: defaults appear without overwriting anything else, and the
    // default mode stays observe.
    assert.equal(document.querySelector('#context-manager-toolResultsMaxChars').value, '200000')
    assert.equal(document.querySelector('#context-manager-toolResultsMinSavings').value, '400')
    assert.equal(document.querySelector('#context-manager-archiveReadBudget').value, '6000')
    assert.equal(document.querySelector('#context-manager-archiveSearchLimit').value, '3')
    assert.equal(button('观察').getAttribute('aria-pressed'), 'true')
    assert.equal(button('安全精简').getAttribute('aria-pressed'), 'false')
    assert.match(document.body.textContent, /引用原文长期保留，卸载不会删除/)
    assert.match(document.body.textContent, /不是 Token 口径/)
    // An unimplemented retention switch must not be offered.
    assert.equal(document.body.textContent.includes('archiveRetention'), false)
    // Empty is invalid, never zero.
    await edit('toolResultsMaxChars', '')
    assert.equal(document.querySelector('#context-manager-toolResultsMaxChars').value, '')
    assert.equal(save().disabled, true)
    await edit('toolResultsMaxChars', '1999')
    assert.equal(save().disabled, true, 'a value below the documented minimum stays invalid')
    await act(async () => button('安全精简').click())
    await edit('toolResultsMaxChars', '120000'); await edit('archiveSearchLimit', '8')
    assert.equal(save().disabled, false)
    await act(async () => save().click())
    assert.equal(writes.length, 1)
    assert.equal(writes[0].ops[0].value.toolResultsMode, 'reduce')
    assert.equal(writes[0].ops[0].value.toolResultsMaxChars, 120000)
    assert.equal(writes[0].ops[0].value.archiveSearchLimit, 8)
    assert.equal(writes[0].ops[0].value.toolResultsMinSavings, defaults.toolResultsMinSavings)
    assert.equal(writes[0].ops[0].value.archiveReadBudget, defaults.archiveReadBudget)
    assert.equal(writes[0].ops[0].value.prefixDiagnosticsEnabled, true)
    assert.match(document.body.textContent, /已保存/)
    // Re-read after the accepted write keeps the saved mode selected.
    assert.equal(button('安全精简').getAttribute('aria-pressed'), 'true')
    assert.equal(button('观察').getAttribute('aria-pressed'), 'false')
    // Empty input never becomes a saved zero, even together with a valid mode.
    await edit('archiveReadBudget', '')
    assert.equal(save().disabled, true)
    assert.equal(writes.length, 1)
  } finally { await act(async () => root.unmount()); dom.window.close(); delete globalThis.window; delete globalThis.document }
})

test('the panel renders codec-parsed attribution and reduction data without inventing values', async () => {
  const dom = new JSDOM('<div id="root"></div>', { url: 'http://localhost' })
  globalThis.window = dom.window; globalThis.document = dom.window.document; globalThis.IS_REACT_ACT_ENVIRONMENT = true
  const state = { status: 'ready', writable: true, revision: 1, value: { policy: defaults } }
  const form = { subscribe: () => () => {}, getSnapshot: () => state }
  const pulse = { subscribe: () => () => {}, getSnapshot: () => 1 }
  // The delivered figure is the real codec's own output: schema and view agree.
  const inspection = {
    sessionId: 'attributed-session', cursor: 4, cutSeq: 4, sampledAt: 1000, historical: false,
    pressure: null, official: null, model: null, parts: [], rows: [], total: 0, offset: 0, pageSize: 50,
    activeCount: 0, archivedCount: 0, requests: [], requestCount: 0, pressureHistory: [], compactions: [],
    usage: { input: 1040, output: 7, cacheRead: 400, uncached: 600, cacheWrite: 40 },
    efficiency: { accounting: 'host-projection',
      host: { uncachedInputTokens: 600, cacheReadTokens: 400, cacheWriteTokens: 40, outputTokens: 7 },
      mirrored: { settledAttempts: 3, retries: 1, withoutUsage: 1,
        uncachedInput: { sum: 130, reported: 2, missing: 0 }, cacheRead: { sum: 110, reported: 2, missing: 0 },
        cacheWrite: { sum: 10, reported: 1, missing: 1 }, output: { sum: 12, reported: 2, missing: 0 },
        cacheInclusiveInput: { sum: 250, reported: 1, missing: 1 }, complete: false },
      differences: [{ field: 'uncachedInputTokens', host: 600, mirrored: 130, delta: 470 }],
      summaryAndRepair: { source: 'summary-ledger', input: 900, output: 120, cacheRead: 800, cacheWrite: 0, attempts: 2,
        unknownAttempts: 1, purposeSplit: false, note: '现有摘要总账的累计值，含失败与取消尝试；账本没有持久用途字段' },
      maintenanceSuspects: 1, cacheHitRatio: 0.44,
      requests: [{ seq: 2, time: 5, turn: 3, step: 1, settledBy: 'attempt', routeKnown: true, retry: 1, provider: 'offline',
        model: 'fixture', uncachedInput: null, cacheRead: null, cacheWrite: null, output: null, maintenanceSuspect: false }],
      fingerprint: null, changes: [] },
    reduction: { mode: 'reduce', pipelineReported: false,
      published: { references: 2, originalChars: 4000, shortenedChars: 900, visibleCharsRemoved: 3100 },
      pending: 1, reverted: 0,
      recent: [{ contentId: 'sha256:aaa', callId: 'call-1', tool: 'bash', shortenedChars: 900, complete: true, at: 5 }],
      notes: ['visibleCharsRemoved 是可见文本字符差，不是账单金额或 Token 计费节省'],
      run: { considered: 9, unverified: 1, wouldReduce: 2, skipped: 1, failed: 0, lastSkip: 'no_savings', lastReason: '低于最小节省' },
      archiveError: '原文档案目录不可写' },
  }
  const codec = TYPERT.invocations.find(item => item.method === 'inspect').result.create()
  const parsed = codec.parse(inspection)
  const api = { idleStatus: async () => ({ status: 'off', dueAt: null, message: '闲置自动压缩已关闭' }),
    inspect: async () => parsed, content: () => { throw new Error('content must not be read for this assertion') } }
  const root = createRoot(document.getElementById('root'))
  try {
    await act(async () => root.render(React.createElement(client.ContextInspectorView, { target: 'attributed-session', form, api, pulse })))
    await act(async () => new Promise(resolve => setTimeout(resolve, 230)))
    const text = document.body.textContent
    assert.match(text, /业务用量/)
    assert.match(text, /整理用量/)
    assert.match(text, /用量未知尝试 1/)
    assert.match(text, /宿主投影为准/)
    assert.match(text, /摘要与修复未区分用途，合计显示/)
    assert.match(text, /工具结果精简 · 安全精简/)
    assert.match(text, /已确认引用 2/)
    assert.match(text, /可见字符减少 3,100/)
    assert.match(text, /待确认 1/)
    assert.match(text, /尚未观察到最终结果／能力未确认/, 'an unreported pipeline stays unconfirmed instead of claiming host support')
    assert.match(text, /原文档案不可用/)
    assert.match(text, /本次运行（全进程，不是本会话）/)
    assert.match(text, /字符差只是可见文本长度变化，不是 Token 账单或实际省钱/)
    assert.ok(!/NaN|undefined|Infinity/u.test(text), 'no fabricated or broken number reaches the panel')
    assert.equal(document.querySelector('[data-efficiency="host-projection"]').dataset.efficiency, 'host-projection')
    assert.equal(document.querySelector('[data-reduction-mode]').dataset.reductionMode, 'reduce')
    assert.equal(document.querySelector('[data-run-scope="process"]').textContent.includes('本次运行'), true)
    assert.equal(document.querySelector('[data-maintenance-split="false"]').textContent.includes('未区分用途'), true)
    // A historical cut shows the unavailable marker for the session archive
    // instead of today's confirmed figures.
    await act(async () => root.render(React.createElement(client.ContextInspectorView, { target: 'attributed-session', form,
      api: { ...api, inspect: async () => codec.parse({ ...inspection, historical: true, cutSeq: 2, usage: null,
        reduction: undefined, efficiency: { ...inspection.efficiency, accounting: 'event-log', host: null, summaryAndRepair: null, fingerprint: null } }) },
      pulse })))
    await act(async () => new Promise(resolve => setTimeout(resolve, 230)))
    const historical = document.body.textContent
    assert.match(historical, /该截面不可用（历史）/)
    assert.match(historical, /仅事件日志/)
    assert.ok(!historical.includes('已确认引用 2'), 'a historical cut never shows the current archive result')
  } finally { await act(async () => root.unmount()); dom.window.close(); delete globalThis.window; delete globalThis.document }
})
test('the attribution line shows the known lower bound, never a fabricated zero or a complete bill', async () => {
  const dom = new JSDOM('<div id="root"></div>', { url: 'http://localhost' })
  globalThis.window = dom.window; globalThis.document = dom.window.document; globalThis.IS_REACT_ACT_ENVIRONMENT = true
  const state = { status: 'ready', writable: true, revision: 1, value: { policy: defaults } }
  const form = { subscribe: () => () => {}, getSnapshot: () => state }
  const pulse = { subscribe: () => () => {}, getSnapshot: () => 1 }
  const codec = TYPERT.invocations.find(item => item.method === 'inspect').result.create()
  const field = (sum, reported, missing) => ({ sum, reported, missing })
  const base = { sessionId: 'bounds', cursor: 4, cutSeq: 4, sampledAt: 1000, historical: false, pressure: null, official: null,
    model: null, parts: [], rows: [], total: 0, offset: 0, pageSize: 50, activeCount: 0, archivedCount: 0, requests: [],
    requestCount: 0, pressureHistory: [], compactions: [] }
  const render = async inspection => {
    const api = { idleStatus: async () => ({ status: 'off', dueAt: null, message: '闲置自动压缩已关闭' }), inspect: async () => codec.parse(inspection),
      content: () => { throw new Error('content must not be read here') } }
    const root = createRoot(document.getElementById('root'))
    await act(async () => root.render(React.createElement(client.ContextInspectorView, { target: 'bounds', form, api, pulse })))
    await act(async () => new Promise(resolve => setTimeout(resolve, 230)))
    return root
  }
  try {
    // 1. A historical cut with partial usage: one complete input sample plus a
    //    later sample that reported only uncached input and output. The four
    //    mutually exclusive buckets add up to 69 + 40 + 5 + 30 = 144; the derived
    //    cache-inclusive input covers the complete sample alone (105), so the old
    //    fallback would have shown 135 and silently dropped 9 known characters of
    //    reported input.
    const partial = { ...base, historical: true, usage: null,
      efficiency: { accounting: 'event-log', host: null,
        mirrored: { settledAttempts: 2, retries: 0, withoutUsage: 0,
          uncachedInput: field(69, 2, 0), cacheRead: field(40, 1, 1), cacheWrite: field(5, 1, 1), output: field(30, 2, 0),
          cacheInclusiveInput: field(105, 1, 1), complete: false },
        differences: [], summaryAndRepair: null, maintenanceSuspects: 0, cacheHitRatio: 0.42,
        requests: [], fingerprint: null, changes: [] } }
    let root = await render(partial)
    let text = document.body.textContent
    assert.equal(document.querySelector('[data-known-bound]').dataset.knownBound, '144')
    assert.match(document.querySelector('[data-known-bound]').textContent, /144/, 'the known bound adds every reported bucket sum')
    assert.ok(!document.querySelector('[data-known-bound]').textContent.includes('135'), 'the cache-inclusive subtotal is not the bound')
    assert.match(text, /业务用量 ≥ /)
    assert.equal(document.querySelector('[data-efficiency="event-log"]').dataset.bounded, 'true')
    assert.match(text, /已知下界/)
    assert.match(text, /完整输入样本的缓存合计/)
    await act(async () => root.unmount())

    // 2. Nothing reported at all: four zero buckets are not a zero reading.
    const unknown = { ...base, historical: true, usage: null,
      efficiency: { accounting: 'event-log', host: null,
        mirrored: { settledAttempts: 0, retries: 0, withoutUsage: 2,
          uncachedInput: field(0, 0, 0), cacheRead: field(0, 0, 0), cacheWrite: field(0, 0, 0), output: field(0, 0, 0),
          cacheInclusiveInput: field(0, 0, 0), complete: false },
        differences: [], summaryAndRepair: null, maintenanceSuspects: 0, cacheHitRatio: null,
        requests: [], fingerprint: null, changes: [] } }
    root = await render(unknown)
    text = document.body.textContent
    assert.match(text, /业务用量 — 未知/, 'an all-unknown cut shows unknown instead of a zero total')
    assert.ok(!/业务用量 [≈≥] 0 Token/u.test(text), 'a zero total is never fabricated from unreported samples')
    assert.match(text, /用量未知尝试 2/)
    await act(async () => root.unmount())

    // 3. Positive control: every component reported for every settlement, so the
    //    host total is quoted as complete, and the ledger input already contains
    //    cache and must not be added a second time.
    const complete = { ...base, usage: { input: 1040, output: 30, cacheRead: 400, uncached: 600, cacheWrite: 40 },
      efficiency: { accounting: 'host-projection',
        host: { uncachedInputTokens: 600, cacheReadTokens: 400, cacheWriteTokens: 40, outputTokens: 30 },
        mirrored: { settledAttempts: 2, retries: 0, withoutUsage: 0,
          uncachedInput: field(600, 2, 0), cacheRead: field(400, 2, 0), cacheWrite: field(40, 2, 0), output: field(30, 2, 0),
          cacheInclusiveInput: field(1040, 2, 0), complete: true },
        differences: [], summaryAndRepair: { source: 'summary-ledger', input: 900, output: 120, cacheRead: 800, cacheWrite: 0,
          attempts: 1, unknownAttempts: 0, purposeSplit: false, note: '账本没有持久用途字段' },
        maintenanceSuspects: 0, cacheHitRatio: 0.4, requests: [], fingerprint: null, changes: [] },
      reduction: { mode: 'observe', pipelineReported: true, published: { references: 0, originalChars: 0, shortenedChars: 0, visibleCharsRemoved: 0 },
        pending: 0, reverted: 0, recent: [], notes: [], run: { considered: 1, unverified: 0, wouldReduce: 0, skipped: 1, failed: 0, lastSkip: 'no_savings', lastReason: null } } }
    root = await render(complete)
    text = document.body.textContent
    assert.match(text, /业务用量 ≈ 1\.1K Token/, 'a complete reading is quoted as the host total')
    assert.equal(document.querySelector('[data-efficiency="host-projection"]').dataset.bounded, 'false')
    assert.ok(!/≥/u.test(document.querySelector('[data-efficiency="host-projection"]').textContent), 'a complete reading carries no lower-bound marker')
    assert.match(text, /整理用量 ≈ 1\.0K Token/, 'the ledger total is input plus output')
    assert.ok(!/整理用量 ≈ 1\.8K/u.test(text), 'the ledger input already includes cache read and write')
    assert.match(text, /总账输入已含缓存，不再另加/)
    assert.equal(document.querySelector('[data-maintenance-split="false"]').textContent.includes('未区分用途'), true)
    await act(async () => root.unmount())
  } finally { dom.window.close(); delete globalThis.window; delete globalThis.document }
})

test('every grant of a deduplicated original renders with its own call identity', async () => {
  const dom = new JSDOM('<div id="root"></div>', { url: 'http://localhost' })
  globalThis.window = dom.window; globalThis.document = dom.window.document; globalThis.IS_REACT_ACT_ENVIRONMENT = true
  const state = { status: 'ready', writable: true, revision: 1, value: { policy: defaults } }
  const form = { subscribe: () => () => {}, getSnapshot: () => state }
  const pulse = { subscribe: () => () => {}, getSnapshot: () => 1 }
  const codec = TYPERT.invocations.find(item => item.method === 'inspect').result.create()
  // One stored original granted to two different calls of the same session.
  const owners = [{ contentId: 'sha256:shared', callId: 'call-1', tool: 'tool:bash', shortenedChars: 900, complete: true, at: 5 },
    { contentId: 'sha256:shared', callId: 'call-2', tool: 'tool:bash', shortenedChars: 700, complete: false, at: 9 }]
  const inspection = { sessionId: 'grants', cursor: 4, cutSeq: 4, sampledAt: 1000, historical: false, pressure: null, official: null,
    model: null, parts: [], rows: [], total: 0, offset: 0, pageSize: 50, activeCount: 0, archivedCount: 0, requests: [],
    requestCount: 0, pressureHistory: [], compactions: [], usage: null,
    efficiency: { accounting: 'event-log', host: null, mirrored: { settledAttempts: 1, retries: 0, withoutUsage: 0,
        uncachedInput: { sum: 10, reported: 1, missing: 0 }, cacheRead: { sum: 0, reported: 1, missing: 0 },
        cacheWrite: { sum: 0, reported: 1, missing: 0 }, output: { sum: 1, reported: 1, missing: 0 },
        cacheInclusiveInput: { sum: 10, reported: 1, missing: 0 }, complete: true },
      differences: [], summaryAndRepair: null, maintenanceSuspects: 0, cacheHitRatio: 0, requests: [], fingerprint: null, changes: [] },
    reduction: { mode: 'reduce', pipelineReported: true, published: { references: 2, originalChars: 2000, shortenedChars: 1600, visibleCharsRemoved: 400 },
      pending: 0, reverted: 0, recent: owners, notes: [], run: { considered: 2, unverified: 0, wouldReduce: 2, skipped: 0, failed: 0, lastSkip: null, lastReason: null } } }
  const api = { idleStatus: async () => ({ status: 'off', dueAt: null, message: '闲置自动压缩已关闭' }), inspect: async () => codec.parse(inspection),
    content: () => { throw new Error('content must not be read here') } }
  const root = createRoot(document.getElementById('root'))
  try {
    await act(async () => root.render(React.createElement(client.ContextInspectorView, { target: 'grants', form, api, pulse })))
    await act(async () => new Promise(resolve => setTimeout(resolve, 230)))
    // The list key is the grant identity (contentId + callId), so two grants of
    // one deduplicated original stay two distinct, ordered rows.
    const rows = document.querySelectorAll('[data-reduced-chars]')
    assert.equal(rows.length, 2, 'both grants of the shared original are rendered')
    assert.deepEqual([...rows].map(row => row.dataset.callId), ['call-1', 'call-2'])
    assert.deepEqual([...rows].map(row => row.dataset.reducedChars), ['900', '700'])
    assert.match(document.body.textContent, /sha256:shared/)
    assert.ok(!/NaN|undefined/u.test(document.body.textContent))
  } finally { await act(async () => root.unmount()); dom.window.close(); delete globalThis.window; delete globalThis.document }
})

test('settings: legacy timeout remains fixed and unchanged; adaptive is explicit with separately saved limits', async () => {
  const dom = new JSDOM('<div id="root"></div>', { url: 'http://localhost' })
  globalThis.window=dom.window;globalThis.document=dom.window.document;globalThis.IS_REACT_ACT_ENVIRONMENT=true
  const {summaryTimeoutMode,summaryTotalMs,summaryFirstOutputMs,summaryStallMs,...legacy}=defaults
  let snapshot={status:'ready',writable:true,mode:'host',revision:1,value:{policy:{...legacy,timeoutMs:135000}}}
  const listeners=new Set(),writes=[]
  const form={subscribe:cb=>{listeners.add(cb);return()=>listeners.delete(cb)},getSnapshot:()=>snapshot,
    mutate:async(ops,revision)=>{writes.push(ops[0].value);snapshot={...snapshot,revision:revision+1,value:{policy:ops[0].value}};listeners.forEach(cb=>cb());return true}}
  const root=createRoot(document.getElementById('root'))
  const button=label=>[...document.querySelectorAll('button')].find(b=>b.textContent===label)
  const click=async label=>act(async()=>button(label).click())
  try {
    await act(async()=>root.render(React.createElement(client.ContextSettings,{form})))
    assert.equal(button('固定总时限').getAttribute('aria-pressed'),'true')
    assert.equal(document.getElementById('context-manager-timeoutMs').value,'135000')
    assert.equal(writes.length,0)
    await click('切换为按进展等待')
    assert.equal(writes.length,0,'switch is a draft until native save succeeds')
    assert.equal(document.getElementById('context-manager-timeoutMs').disabled,true)
    assert.equal(document.getElementById('context-manager-summaryTotalMs').value,'600000')
    await click('保存设置')
    assert.equal(writes[0].timeoutMs,135000);assert.equal(writes[0].summaryTimeoutMode,'adaptive')
    await click('固定总时限');await click('保存设置')
    assert.equal(writes[1].timeoutMs,135000);assert.equal(writes[1].summaryTimeoutMode,'fixed')
  } finally {await act(async()=>root.unmount());dom.window.close();delete globalThis.window;delete globalThis.document}
})


test('compact panel keeps long model, failures and exact content selection reachable without the request donut', async () => {
  const dom = new JSDOM('<div id="root"></div>', { url: 'http://localhost' })
  globalThis.window = dom.window; globalThis.document = dom.window.document; globalThis.IS_REACT_ACT_ENVIRONMENT = true
  const model = 'long-model-' .repeat(12)
  const reason = 'provider result is unknown; authorization required. '.repeat(30)
  const rows = Array.from({ length: 7 }, (_, i) => ({ id: `row-${i}`, seq: i, title: `Full content title ${i}`, category: 'user', current: true, source: 'fixture', tokens: 100 + i, images: 0 }))
  const readIds = []
  const state = { revision: 1, value: { policy: defaults } }
  const api = { idleStatus: async () => ({ status: 'off', dueAt: null, message: reason }),
    inspect: async query => ({ ...query, cursor: 10, cutSeq: 10, sampledAt: 1000, historical: false, pressure: null, official: null, usage: null,
      model: { provider: 'synthetic', model, maxTokens: 8192, effort: null }, parts: [], rows, total: 7, pageSize: 50, activeCount: 7, archivedCount: 0,
      requests: [{ seq: 9, turn: 9, step: 28, input: 8000000, output: null, cacheRead: null }], requestCount: 1, pressureHistory: [],
      compactions: [{ id: 'failed', kind: 'compact', status: 'failed', startedAt: 1000, applied: false, error: reason }, { id: 'running', kind: 'compact', status: 'running', startedAt: 2000, applied: false }] }),
    content: async query => { readIds.push(query.id); return { ...query, text: 'selected original', totalChars: 17, nextOffset: null } } }
  const root = createRoot(document.getElementById('root'))
  try {
    await act(async () => root.render(React.createElement(client.ContextInspectorView, { target: 'compact', api, form: { subscribe: () => () => {}, getSnapshot: () => state }, pulse: { subscribe: () => () => {}, getSnapshot: () => 1 } })))
    await act(async () => new Promise(resolve => setTimeout(resolve, 230)))
    assert.equal(document.querySelector('.cmv-context-title .cmv-model').textContent, `synthetic / ${model}`)
    assert.equal(document.querySelectorAll('.cmv-model').length, 1)
    assert.equal(document.querySelector('.cmv-quick .cmv-donut'), null)
    assert.match(document.querySelector('.cmv-quick').textContent, /8.00M/)
    assert.doesNotMatch(document.querySelector('.cmv-quick').textContent, /9 轮/)
    assert.match(document.querySelector('.cmv-data-basis').textContent, /9 轮 · 28 步/)
    assert.equal(document.querySelector('.cmv-record-detail .cmv-error').textContent, reason)
    assert.match(document.querySelector('.cmv-compactions').textContent, /进行中/)
    assert.equal(document.querySelectorAll('.cmv-preview > button').length, 3)
    assert.equal(readIds.length, 0)
    await act(async () => document.querySelectorAll('.cmv-preview > button')[2].click())
    assert.deepEqual(readIds, ['row-2'])
    assert.equal(document.querySelector('.cmv-reader h3').textContent, 'Full content title 2')
    assert.equal(document.querySelectorAll('.cmv-events > li').length, 2)
  } finally { await act(async () => root.unmount()); dom.window.close(); delete globalThis.window; delete globalThis.document }
})
