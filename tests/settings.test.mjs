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
    for (const title of ['当前上下文', '压缩前后', '收起当前有效内容', '当前有效内容', '占用变化', '本会话累计']) assert.ok(document.body.textContent.includes(title), title)
    assert.ok(document.querySelector('#cmi-content-panel'), 'details open on entering the view')
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
    assert.equal(reads, 1, 'expanded details fetch only the selected body')
    assert.equal(document.querySelectorAll('.cmv-legend > button').length, 4)
    assert.equal(document.querySelectorAll('.cmv-events > li').length, 2)
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

test('details reopen for each visit or target, stay collapsed on refresh, and cancel stale paginated bodies', async () => {
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
    assert.ok(content(), 'changing target resets collapsed state to open')
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
    assert.ok(content(), 'reopening the same target starts expanded')
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
    assert.equal(writes[0].ops[0].value.targetPercent, 40)
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
    assert.deepEqual(cards, ['占用变化', '压缩前后', '本会话累计'])
    assert.ok(document.querySelector('.cmv-content').compareDocumentPosition(document.querySelector('.cmv-chart-grid')) & 2, 'content follows every chart')
    assert.equal(document.querySelectorAll('[role="tab"]').length, 0)
  } finally { await act(async () => root.unmount()); dom.window.close(); delete globalThis.window; delete globalThis.document }
})

test('current context shows one full 1M window and every K bucket without a basis switch', async () => {
  const dom = new JSDOM('<div id="root"></div>', { url: 'http://localhost' })
  globalThis.window = dom.window; globalThis.document = dom.window.document; globalThis.IS_REACT_ACT_ENVIRONMENT = true
  const snapshot = { sessionId: 'capacity', cursor: 2, cutSeq: 2, sampledAt: 1000, historical: false,
    pressure: {window:1000000,projected:320000,input:310000}, official: null, usage: null, model: {provider:'mock',model:'large',maxTokens:64000,effort:null},
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
    assert.equal(card.querySelector('.cmv-number strong').textContent,'1M')
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

test('settings renders the absolute soft budget and repair controls with explainable preview and validation', async () => {
  const dom = new JSDOM('<div id="root"></div>', { url: 'http://localhost' })
  globalThis.window = dom.window; globalThis.document = dom.window.document; globalThis.IS_REACT_ACT_ENVIRONMENT = true
  const snapshot = { status: 'ready', writable: true, mode: 'host', revision: 4, value: { policy: { ...defaults } } }
  const form = { subscribe: () => () => {}, getSnapshot: () => snapshot, mutate: () => { throw new Error('unexpected write') } }
  const root = createRoot(document.getElementById('root'))
  try {
    await act(async () => root.render(React.createElement(client.ContextPage, { form })))
    const trigger = document.querySelector('#context-manager-absoluteTriggerTokens')
    const target = document.querySelector('#context-manager-absoluteTargetTokens')
    const repair = document.querySelector('#context-manager-formatRepairMaxTokens')
    assert.ok(trigger && target && repair, 'new controls must render')
    assert.equal(trigger.disabled, true, 'absolute fields start blocked until the strategy is enabled')
    const toggle = [...document.querySelectorAll('.cm-row')].find(row => row.textContent.includes('绝对工作历史软预算'))?.querySelector('button[role="switch"]')
    assert.ok(toggle, 'absolute budget toggle renders')
    await act(async () => toggle.click())
    assert.equal(trigger.disabled, false)
    // The example window must exceed the absolute trigger for it to bind.
    await act(async () => Simulate.change(document.querySelector('#context-manager-example'), { target: { value: '1000000' } }))
    await act(async () => Simulate.change(trigger, { target: { value: '200000' } }))
    await act(async () => Simulate.change(target, { target: { value: '100000' } }))
    const preview = document.querySelector('.cm-native-example .cm-hint').textContent
    assert.match(preview, /绝对软预算/)
    assert.match(preview, /200,000/)
    await act(async () => Simulate.change(target, { target: { value: '170000' } }))
    assert.match(document.querySelector('.cm-error')?.textContent ?? '', /至少低 20%/)
  } finally { await act(async () => root.unmount()); dom.window.close(); delete globalThis.window; delete globalThis.document }
})
