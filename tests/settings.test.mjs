import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'
import { createRequire } from 'node:module'
import { buildSync } from 'esbuild'
import { JSDOM } from 'jsdom'
import React, { act } from 'react'
import { defaults } from '../lib/policy.js'
import { TYPERT } from '../lib/typert.js'

// ReactDOM detects DOM event support once, at module evaluation. Give it a real
// jsdom window before loading the client entry; individual tests then own their
// isolated windows as usual.
const bootstrapDom = new JSDOM('<!doctype html><html><body></body></html>')
globalThis.window = bootstrapDom.window
globalThis.document = bootstrapDom.window.document
const { createRoot } = await import('react-dom/client')
const { renderToStaticMarkup } = await import('react-dom/server')
bootstrapDom.window.close()
delete globalThis.window
delete globalThis.document

const require = createRequire(import.meta.url)
function setDomInput(input, value) {
  const window = input.ownerDocument.defaultView
  const prototype = input.tagName === 'TEXTAREA' ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype
  Object.getOwnPropertyDescriptor(prototype, 'value').set.call(input, value)
  input.dispatchEvent(new window.Event('input', { bubbles: true }))
}
function setDomSelect(select, value) {
  const window = select.ownerDocument.defaultView
  Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, 'value').set.call(select, value)
  select.dispatchEvent(new window.Event('change', { bubbles: true }))
}
function runFact(label) {
  const dt = [...document.querySelectorAll('.cmv-run-facts dt')].find(node => node.textContent === label)
  assert.ok(dt, `visible run fact exists: ${label}`)
  assert.equal(dt.nextElementSibling?.tagName, 'DD', `${label} has a visible value`)
  return dt.nextElementSibling.textContent ?? ''
}
function emptySessionUsage(sessionId) {
  return { sessionId, sampledAt: 0, status: 'ready', hasRecords: false, settledAttempts: 0, retries: 0,
    requestTokens: 0, requestTokensPartial: false, summary: null, peak: null, offpeak: null, total: null, partial: false, issues: [] }
}
// Render the host's actual published RC.1 control implementations. Theme
// acceptance runs separately in the isolated browser preview.
const primitivesBuild = buildSync({
  stdin: { contents: "export { Button, Input, StateDot, Tooltip } from '@deepseek-ai/dsh-client-ui-primitives'", resolveDir: process.cwd() },
  outfile: '/virtual/context-manager-primitives.cjs', bundle: true, platform: 'node', format: 'cjs',
  external: ['react', 'react/*', 'react-dom', 'react-dom/*', 'katex/dist/katex.min.css'],
  loader: { '.css': 'local-css' }, jsx: 'automatic',
  tsconfigRaw: { compilerOptions: { target: 'ES2022' } }, write: false,
})

test('settings section contains only policy controls and does not read any session', async () => {
  const dom = new JSDOM('<div id="root"></div>', { url: 'http://localhost' })
  globalThis.window = dom.window; globalThis.document = dom.window.document; globalThis.IS_REACT_ACT_ENVIRONMENT = true
  const snapshot = { status: 'ready', writable: true, mode: 'host', revision: 4, value: { policy: { ...defaults } } }
  const form = { subscribe: () => () => {}, getSnapshot: () => snapshot, mutate: () => { throw new Error('unexpected write') } }
  const compatibility = async () => ({ state: 'unsupported', reason: 'Host cannot register or select an enhanced Context compaction provider', reasonCode: 'compaction-host-missing',
    missingInterfaces: ['agentPresets.compactionHost.version = 1', 'agentPresets.compactionHost.register(owner, registration)',
      'agentPresets.compactionHost.bindingFor(agentContext)', 'agentPresets.compactionHost.retained()'],
    hostRuntime: { state: 'available', version: '0.2.1-rc.4', source: '@deepseek-ai/dsh-app-boot' },
    requestPath: { path: 'request-gate-sidecar', state: 'ready', reasonCode: 'sidecar-ready' },
    integration: { state: 'inactive', reason: 'Host cannot register or select an enhanced Context compaction provider' } })
  const root = createRoot(document.getElementById('root'))
  try {
    await act(async () => root.render(React.createElement(client.ContextPage, { form, compatibility })))
    await act(async () => new Promise(resolve => setTimeout(resolve, 0)))
    const capabilityStatus = document.querySelector('[role="status"]')?.textContent ?? ''
    assert.match(capabilityStatus, /自动压缩已就绪/)
    assert.doesNotMatch(capabilityStatus, /官方 Basic/, 'the concise readiness line does not imply Basic was replaced')
    const capabilityDetails = document.querySelector('details.cm-detail')?.textContent ?? ''
    assert.match(capabilityDetails, /0\.2\.1-rc\.4/)
    assert.match(capabilityDetails, /agentPresets\.compactionHost\.register\(owner, registration\)/)
    assert.match(capabilityDetails, /请求前接入/)
    assert.match(capabilityDetails, /无需注册/)
    assert.match(capabilityDetails, /宿主引擎替换（可选）/)
    assert.doesNotMatch(capabilityDetails, /Host cannot register|宿主能力不支持|provider 注册未注册/)
    assert.equal(document.querySelectorAll('.cm-detail-interfaces li').length, 4, 'each optional interface remains a distinct accessible list item')
    assert.match(document.querySelector('.cm-native-help[aria-label^="开始压缩: "]')?.getAttribute('aria-label') ?? '', /新消息和预留空间可能让检查提前/)
    assert.equal(document.querySelectorAll('style').length, 2)
    assert.equal(document.querySelectorAll('style:not([data-plugin="dsh-context-manager"])').length, 0,
      'page and nested settings styles must not be claimed by another plugin')
    assert.equal(document.querySelectorAll('[role="tab"]').length, 0)
    assert.equal(document.querySelector('#context-manager-historyMode').value, 'automatic')
    assert.equal(document.querySelector('#context-manager-toolResultsMode').value, 'observe')
    const trigger = document.querySelector('#context-manager-triggerPercent')
    assert.ok(trigger, 'the current numeric threshold input is present')
    await act(async () => setDomInput(trigger, '70'))
    assert.equal(trigger.value, '70', 'the actual input stages the same threshold change without a removed preset button')
  } finally { await act(async () => root.unmount()); dom.window.close(); delete globalThis.window; delete globalThis.document }
})
test('optional provider registration never hides a blocked or failed active compaction path', async () => {
  for (const state of ['blocked', 'failed']) {
    const dom = new JSDOM('<div id="root"></div>', { url: 'http://localhost' })
    globalThis.window = dom.window; globalThis.document = dom.window.document; globalThis.IS_REACT_ACT_ENVIRONMENT = true
    const snapshot = { status: 'ready', writable: true, mode: 'host', revision: 4, value: { policy: { ...defaults } } }
    const form = { subscribe: () => () => {}, getSnapshot: () => snapshot, mutate: () => { throw new Error('unexpected write') } }
    const failure = '隔离引擎启动失败：storage unavailable'
    const compatibility = async () => ({ state: 'unsupported', reason: 'optional API absent', reasonCode: 'compaction-host-missing',
      integration: { state: 'inactive', reason: 'optional API absent' },
      requestPath: { path: 'request-gate-sidecar', state, reasonCode: `sidecar-${state}`, reason: failure } })
    const root = createRoot(document.getElementById('root'))
    try {
      await act(async () => root.render(React.createElement(client.ContextPage, { form, compatibility })))
      assert.ok(document.querySelector('[role="alert"]'), 'an unavailable active path remains an actionable error')
      assert.doesNotMatch(document.querySelector('[role="alert"]').textContent, /已就绪/)
      assert.equal(document.querySelector('details.cm-detail').textContent.split(failure).length - 1, 1,
        'the actual startup failure is retained once')
    } finally { await act(async () => root.unmount()); dom.window.close(); delete globalThis.window; delete globalThis.document }
  }
})
const primitivesScope = { module: { exports: {} }, require: name => name === 'katex/dist/katex.min.css' ? {} : require(name), setTimeout, clearTimeout }
for (const name of ['window', 'document', 'Node']) Object.defineProperty(primitivesScope, name, { get: () => name === 'Node' ? globalThis.window?.Node : globalThis[name] })
primitivesScope.getComputedStyle = element => globalThis.window.getComputedStyle(element)
vm.runInNewContext(primitivesBuild.outputFiles.find(file => file.path.endsWith('.cjs')).text, primitivesScope)
let client
const clientScope = {
  AbortController, setTimeout: (callback, delay) => setTimeout(callback, delay), clearTimeout: timer => clearTimeout(timer),
  window: { __ModuleLoader__: { load: module => { client = module.factory(name =>
    name === '@deepseek-ai/dsh-client-ui-primitives' ? primitivesScope.module.exports : require(name)) } } },
}
Object.defineProperty(clientScope, 'Node', { get: () => globalThis.window?.Node })
vm.runInNewContext(readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8'), clientScope)

test('client registers the native conversation tab after trajectory and binds its actual Session', async () => {
  const slots = []
  const bindings = []; const directories = []; const projectionFaces = []; const pulse = {}; const usagePulse = {}; const directory = {}; const disposers = []
  const ctx = { locale: { register: () => () => {}, bind: () => key => key === 'title' ? '上下文' : key, getLocale: () => ({ active: 'zh' }) }, configForms: { get: () => ({}), whileServed: (_ns, callback) => callback() },
    remote: { $mount: async () => () => {}, contextInspector: {} },
    sessions: { binding: id => { bindings.push(id); return { session: { projections: { faceOf: key => {
      projectionFaces.push(key)
      assert.ok(key === 'contextPressure' || key === 'tokenUsage', `unexpected projection ${key}`)
      return key === 'contextPressure' ? pulse : usagePulse
    } } } } } },
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
  assert.deepEqual([...new Set(projectionFaces)].sort(), ['contextPressure', 'tokenUsage'])
  for (const dispose of disposers) dispose?.()
})

test('tariff indicator shares the picker default without history or usage and follows accepted model switches', async () => {
  const dom = new JSDOM('<div id="root"></div>', { url: 'http://localhost' })
  globalThis.window = dom.window; globalThis.document = dom.window.document; globalThis.IS_REACT_ACT_ENVIRONMENT = true
  const listeners = new Set()
  let snapshot = { current: { provider: 'deepseek-official', model: 'deepseek-flash' }, pending: null }
  const directory = { subscribe: cb => { listeners.add(cb); return () => listeners.delete(cb) }, getSnapshot: () => snapshot }
  const sessionId = 'tariff-session'
  const usagePulse = { subscribe: () => () => {}, getSnapshot: () => 0 }
  const root = createRoot(document.getElementById('root'))
  const publish = async patch => act(async () => { snapshot = { ...snapshot, ...patch }; listeners.forEach(cb => cb()) })
  const select = current => publish({ current, pending: null })
  try {
    await act(async () => root.render(React.createElement(client.PeakIndicator, { sessionId, directory, usagePulse, readUsage: async () => emptySessionUsage(sessionId) })))
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
  const api = {
    idleStatus: async ({ sessionId }) => sessionId === 'second-session' ? new Promise(() => {}) : ({ status: 'off', dueAt: null,
      message: '闲置自动压缩已关闭', owner: 'context-manager',
      compression: { mode: 'enhanced', hostCapability: 'supported', reason: 'fixture enhanced binding' },
      emergency: { eligible: true, used: false, message: 'synthetic check only' } }),
    prepareEmergency: async () => ({ token: 'synthetic-only', expiresAt: Date.now() + 120000, cycle: 1, warning: 'synthetic warning', model: 'fixture',
      deadline: 'two minutes', estimatedInput: 100 }),
    executeEmergency: async () => ({ granted: true }),
    inspect: (query, signal) => new Promise(resolve => calls.push({ query, signal, resolve })),
    content: () => { throw new Error('content is lazy') },
  }
  const snapshot = sessionId => ({ sessionId, cursor: 1, cutSeq: 1, sampledAt: 1000, historical: false,
    pressure: null, official: null, usage: null, model: { provider: 'fixture', model: sessionId, effort: null, maxTokens: null },
    parts: [], rows: [], total: 0, offset: 0, pageSize: 50, activeCount: 0, archivedCount: 0, requests: [], requestCount: 0, pressureHistory: [], compactions: [] })
  const root = createRoot(document.getElementById('root'))
  const render = async target => { await act(async () => root.render(React.createElement(client.ContextInspectorView, { target, form, api, pulse }))); await act(async () => new Promise(resolve => setTimeout(resolve, 230))) }
  try {
    await render('first-session')
    await act(async () => [...document.querySelectorAll('button')].find(button => button.textContent === '检查一次人工恢复（不调用模型）').click())
    assert.ok([...document.querySelectorAll('button')].some(button => button.textContent === '确认未知费用风险并额外调用一次'),
      'the synthetic preflight is only a plan and does not call a model')
    await render('second-session')
    assert.ok(![...document.querySelectorAll('button')].some(button => button.textContent === '确认未知费用风险并额外调用一次'),
      'an emergency confirmation from the previous session is cleared on the first render for a new target')
    assert.equal(calls[0].signal.aborted, true)
    await act(async () => calls[0].resolve(snapshot('first-session')))
    assert.ok(!document.body.textContent.includes('fixture / first-session'))
    await act(async () => calls[1].resolve(snapshot('second-session')))
    assert.match(document.body.textContent, /fixture \/ second-session/)
    assert.match(document.querySelector('.cmv-quick')?.textContent ?? '', /等待完整参数/)
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
    assert.match(document.querySelector('.cmv-record-detail').textContent, /减少 10 Token · 50.00%/)
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
    await click('刷新'); await settle()
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
    assert.match(document.querySelector('.cm-native-help[aria-label^="开始压缩: "]')?.getAttribute('aria-label') ?? '', /新消息和预留空间可能让检查提前/)
    assert.equal(document.querySelector('#context-manager-idleMinutes').value, '15')
    assert.equal(document.getElementById(document.querySelector('#context-manager-idleMinutes').getAttribute('aria-describedby'))?.textContent, '分钟')
    assert.equal(document.querySelector('#context-manager-idleMinPercent') === null, true, 'idle compaction has no occupancy control')
    const buttons = () => [...document.querySelectorAll('button')]
    await act(async () => setDomInput(document.querySelector('#context-manager-triggerPercent'), '70'))
    assert.equal(writes.length, 0)
    assert.equal(document.querySelector('#context-manager-triggerPercent').value, '70')
    await act(async () => setDomInput(document.querySelector('#context-manager-idleMinutes'), '30'))
    await act(async () => buttons().find(b => b.textContent === '保存设置').click())
    assert.equal(writes.length, 1); assert.equal(writes[0].revision, 4)
    assert.equal(writes[0].ops[0].value.triggerPercent, 70)
    assert.equal(writes[0].ops[0].value.targetPercent, defaults.targetPercent, 'editing the trigger preserves the saved custom cap')
    assert.equal(writes[0].ops[0].value.historyMode, 'automatic')
    assert.equal(writes[0].ops[0].value.recentTokens, 20000)
    assert.equal(writes[0].ops[0].value.idleMinutes, 30, 'a real input event is included in the save')
    assert.equal(form.getSnapshot().value.policy.idleMinutes, 30, 'the form store returns the saved policy')
    assert.equal(document.querySelector('#context-manager-idleMinutes').value, '30', 'the rendered control reads back the saved value')
    const feedback = document.querySelector('.cm-feedback[role="status"]')?.textContent ?? ''
    assert.equal(feedback, '设置已保存。', 'a successful save confirms persistence without claiming unsupported features are active')
    assert.doesNotMatch(feedback, /请求前检查|闲置整理.*生效/)
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
  const edit = async (key, value) => act(async () => setDomInput(document.getElementById(`context-manager-${key}`), value))
  try {
    await act(async () => root.render(React.createElement(client.ContextSettings, { form })))
    await edit('idleMinutes', '1x')
    assert.equal(document.getElementById('context-manager-idleMinutes').value, '1x')
    assert.equal(save().disabled, true)
    await edit('idleMinutes', '30'); await edit('summaryInstructions', '保留用户约束与验收命令')
    await act(async () => { snapshot = { ...snapshot, revision: 10 }; listeners.forEach(cb => cb()) })
    await act(async () => save().click())
    assert.equal(writes[0].revision, 9, 'dirty draft retains its original revision')
    assert.match(document.body.textContent, /未保存/)
    assert.equal(writes[0].ops[0].value.idleMinutes, 30)
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

test('native price popover lazily reads real session usage, refreshes and isolates retries and session changes', async () => {
  const dom = new JSDOM('<div id="root"></div><button id="outside">Outside</button>', { url: 'http://localhost' })
  globalThis.window = dom.window; globalThis.document = dom.window.document; globalThis.IS_REACT_ACT_ENVIRONMENT = true
  const listeners = new Set()
  let snapshot = { current: { provider: 'deepseek-official', model: 'deepseek-flash' } }
  const directory = { subscribe: cb => { listeners.add(cb); return () => listeners.delete(cb) }, getSnapshot: () => snapshot }
  let usageRevision = 0
  const usageListeners = new Set()
  const usagePulse = { subscribe: cb => { usageListeners.add(cb); return () => usageListeners.delete(cb) }, getSnapshot: () => usageRevision }
  const reads = []
  const readUsage = sessionId => signal => new Promise((resolve, reject) => reads.push({ sessionId, signal, resolve, reject }))
  const props = sessionId => ({ sessionId, directory, usagePulse, readUsage: readUsage(sessionId) })
  const usage = (sessionId, patch = {}) => ({ sessionId, sampledAt: 1000, status: 'ready', hasRecords: true,
    settledAttempts: 3, retries: 1, requestTokens: 3_000_000, requestTokensPartial: true,
    summary: { tokens: 120_000, attempts: 2, unknownAttempts: 1 }, peak: 10.04, offpeak: 5.02,
    total: 15.06, partial: true, issues: ['missing-usage', 'unknown-route'], ...patch })
  const flush = async () => act(async () => new Promise(resolve => setTimeout(resolve, 0)))
  const root = createRoot(document.getElementById('root'))
  const trigger = () => document.querySelector('.cmi-peak button')
  try {
    await act(async () => root.render(React.createElement(client.PeakIndicator, props('price-session'))))
    assert.equal(reads.length, 0, 'session usage is lazy until the user opens the local panel')
    await act(async () => trigger().click())
    await flush()
    const dialog = document.querySelector('[role="dialog"]')
    assert.ok(dialog); assert.equal(dialog.parentNode, document.body, 'escapes clipping ancestors')
    assert.ok(dialog.classList.contains('cmi-price-panel'), 'the actual price panel class identifies the rendered local dialog')
    assert.equal(window.location.href, 'http://localhost/')
    assert.equal(reads.length, 1)
    assert.equal(reads[0].sessionId, 'price-session')
    assert.equal(dialog.querySelectorAll('input').length, 0, 'the popover reads recorded session usage instead of asking for hand-entered tokens')
    assert.match(dialog.querySelector('.cmi-usage-state')?.textContent ?? '', /正在读取本会话记录/)
    await act(async () => reads[0].reject(new Error('offline')))
    await flush()
    assert.match(dialog.querySelector('[role="alert"]')?.textContent ?? '', /暂时无法读取用量/)
    await act(async () => [...dialog.querySelectorAll('button')].find(button => button.textContent === '重试').click())
    await flush()
    assert.equal(reads.length, 2, 'the visible retry starts a fresh session usage read')
    await act(async () => reads[1].resolve(usage('price-session')))
    await flush()
    assert.match(dialog.querySelector('.cmi-usage-total')?.textContent ?? '', /3,000,000 Token · 部分字段未知/)
    assert.match(dialog.querySelector('.cmi-price-totals').textContent, /¥10\.04.*¥5\.02.*¥15\.06/)
    assert.match(dialog.querySelector('.cmi-price-badge')?.textContent ?? '', /部分估算/)
    assert.match(dialog.querySelector('.cmi-usage-summary')?.textContent ?? '', /120,000 Token · 另有用量未知/)
    assert.match(dialog.querySelector('.cmi-usage-issues')?.textContent ?? '', /缺少 Token 数据/)

    await act(async () => { usageRevision++; usageListeners.forEach(callback => callback()) })
    await flush()
    assert.equal(reads.length, 3, 'usagePulse refreshes the open panel from the session projection')
    assert.equal(reads[1].signal.aborted, true, 'a newer usage read cancels the previous read')
    await act(async () => reads[2].resolve(usage('price-session', { requestTokens: 4_000_000, peak: null, offpeak: null, total: null, issues: ['unknown-route'] })))
    await flush()
    assert.match(dialog.querySelector('.cmi-usage-total')?.textContent ?? '', /4,000,000 Token/)
    assert.match(dialog.querySelector('.cmi-price-totals').textContent, /高峰已估算—低谷已估算—已估算部分—/)
    assert.match(dialog.querySelector('.cmi-usage-issues')?.textContent ?? '', /没有可用的官方模型价格/)

    await act(async () => { usageRevision++; usageListeners.forEach(callback => callback()) })
    await flush()
    assert.equal(reads.length, 4)
    await act(async () => root.render(React.createElement(client.PeakIndicator, props('next-session'))))
    assert.equal(reads[3].signal.aborted, true, 'changing sessions cancels the in-flight read and remounts a closed panel')
    assert.equal(document.querySelector('[role="dialog"]'), null)
    await act(async () => reads[3].resolve(usage('price-session', { requestTokens: 99_000_000 })))
    await flush()
    assert.ok(!document.body.textContent.includes('99,000,000'), 'a late prior-session response cannot leak into the next session')

    await act(async () => trigger().click())
    await flush()
    assert.equal(reads[4].sessionId, 'next-session')
    await act(async () => reads[4].resolve(usage('next-session', { requestTokens: 420, requestTokensPartial: false,
      settledAttempts: 1, retries: 0, summary: null, peak: 0.12, offpeak: 0.03, total: 0.15, partial: false, issues: [] })))
    await flush()
    assert.match(document.querySelector('.cmi-usage-total')?.textContent ?? '', /420 Token/)

    await act(async () => { usageRevision++; usageListeners.forEach(callback => callback()) })
    await flush()
    assert.equal(reads.length, 6, 'an open same-session panel refreshes on the first usage pulse')
    assert.match(document.querySelector('.cmi-usage-total')?.textContent ?? '', /420 Token/, 'the last same-session result stays visible while refreshing')
    await act(async () => { usageRevision++; usageListeners.forEach(callback => callback()) })
    await flush()
    assert.equal(reads.length, 7, 'a second pulse starts a newer same-session read')
    assert.equal(reads[5].signal.aborted, true, 'the newer pulse cancels the earlier same-session read')
    await act(async () => reads[6].resolve(usage('next-session', { requestTokens: 0, requestTokensPartial: false,
      settledAttempts: 1, retries: 0, summary: null, peak: 0, offpeak: 0, total: 0, partial: false, issues: [] })))
    await flush()
    assert.equal(document.querySelector('.cmi-usage-total strong')?.textContent, '0 Token', 'a known zero total is distinct from any nonzero token count')
    assert.match(document.querySelector('.cmi-price-totals').textContent, /¥0.*¥0.*¥0/, 'known zero fees remain distinct from unknown fees')
    await act(async () => reads[5].reject(new Error('late cancelled read')))
    await flush()
    assert.equal(document.querySelector('.cmi-usage-state[role="alert"]'), null, 'a late cancelled failure cannot replace the newer success')
    assert.match(document.querySelector('.cmi-price-totals').textContent, /¥0.*¥0.*¥0/)

    await act(async () => document.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true })))
    assert.equal(document.querySelector('[role="dialog"]'), null); assert.equal(document.activeElement, trigger())
    const readsWhenClosed = reads.length
    await act(async () => { usageRevision++; usageListeners.forEach(callback => callback()) })
    await flush()
    assert.equal(reads.length, readsWhenClosed, 'a usage pulse does not read session data while the panel is closed')
    await act(async () => trigger().click())
    await flush()
    assert.equal(reads.length, readsWhenClosed + 1, 'reopening starts a fresh read for the same Session')
    await act(async () => document.getElementById('outside').dispatchEvent(new window.Event('pointerdown', { bubbles: true })))
    assert.equal(document.querySelector('[role="dialog"]'), null)
    assert.equal(reads[readsWhenClosed].signal.aborted, true, 'outside dismissal cancels its in-flight read')
    await act(async () => { snapshot = { current: { provider: 'deepseek-account', model: 'future-model' } }; listeners.forEach(cb => cb()) })
    await act(async () => trigger().click())
    await flush()
    assert.match(document.querySelector('[role="dialog"]').textContent, /价格尚未收录/)
    assert.equal(document.querySelector('[role="dialog"] input'), null, 'an unpriced official model never enables a calculator')
    assert.equal(document.querySelector('[role="dialog"] a').href, 'https://api-docs.deepseek.com/zh-cn/quick_start/pricing/')
    assert.equal(reads.at(-1).sessionId, 'next-session', 'the unpriced official route still displays only actual session data')
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

test('current context shows full-window percentages and keeps all original bucket measures', async () => {
  const dom = new JSDOM('<div id="root"></div>', { url: 'http://localhost' })
  globalThis.window = dom.window; globalThis.document = dom.window.document; globalThis.IS_REACT_ACT_ENVIRONMENT = true
  const snapshot = { sessionId: 'capacity', cursor: 2, cutSeq: 2, sampledAt: 1000, historical: false, compression: { mode: 'enhanced', hostCapability: 'supported', reason: 'Inspection enhanced' },
    pressure: {window:1000000,projected:320000,input:310000}, official: null, usage: null, model: {provider:'mock',model:'large',maxTokens:null,effort:null},
    admission: {tokens:320000,logRevision:3,baseline:'usage',window:1000000,outputReserve:64000},
    parts: [{category:'summary',tokens:30000,count:1},{category:'tool',tokens:200000,count:1},{category:'user',tokens:50000,count:1},{category:'system',tokens:20000,count:1}],
    rows: [], total: 0, offset: 0, pageSize: 50, activeCount: 4, archivedCount: 0, requests: [], requestCount: 0, compactions: [], pressureHistory: [] }
  const formValue = { revision: 1, value: { policy: defaults } }
  const form = { subscribe: () => () => {}, getSnapshot: () => formValue }
  const pulse = { subscribe: () => () => {}, getSnapshot: () => 1 }
  let inspected
  const ready = new Promise(resolve => { inspected = resolve })
  const api = { idleStatus: async () => ({ status: 'off', dueAt: null, message: '', compression: { mode: 'enhanced', hostCapability: 'supported', reason: 'Idle enhanced' } }), inspect: async () => { inspected(); return snapshot } }
  const root = createRoot(document.getElementById('root'))
  try {
    await act(async () => root.render(React.createElement(client.ContextInspectorView, { target: 'capacity', form, api, pulse })))
    await act(async () => ready)
    const card = document.querySelector('.cmv-composition')
    assert.equal(card.querySelector('.cmv-number strong').textContent,'≈ 320.0K Token')
    assert.equal(card.querySelector('.cmv-number span').textContent,'/ 1M Token')
    assert.equal(card.querySelector('.cmv-number b').textContent,'32.00%', 'the main readout stays Token-first with its real full-window share alongside')
    assert.ok(card.querySelector('.cmv-context-title .cmv-model'))
    assert.equal(card.querySelector('.cmv-capacity-stack').dataset.capacity,'1000000')
    assert.equal(card.querySelector('[data-color="free"]').style.width,'47%')
    assert.equal(card.querySelector('.cmv-capacity-stack').lastElementChild.dataset.color,'reserve')
    assert.equal(card.querySelector('[data-color="reserve"]').style.width,'21%')
    assert.match(card.textContent, /输出预留 6\.40%/, 'the footer uses the resolved admission reserve even without an explicit maxTokens header')
    assert.equal(card.querySelector('[data-color="other"]').style.width,'2%')
    assert.equal(card.querySelectorAll('.cmv-capacity-stack').length,1)
    assert.equal(card.querySelectorAll('[aria-pressed]').length,0,'no hidden full-window toggle')
    assert.deepEqual([...card.querySelectorAll('.cmv-key')].map(node=>[
      node.dataset.slice, node.querySelector('span')?.textContent, node.querySelector('strong')?.textContent,
    ]),[
      ['summary','记忆摘要','30.0K Token · 3.00%'],
      ['tool','工具结果','200.0K Token · 20.00%'],
      ['message','对话消息','50.0K Token · 5.00%'],
      ['instruction','指令与定义','20.0K Token · 2.00%'],
      ['other','其他占用','20.0K Token · 2.00%'],
      ['free','未占用','470.0K Token · 47.00%'],
      ['reserve','压缩预留','210.0K Token · 21.00%'],
    ])
    assert.equal(card.querySelector('[data-color="summary"]').style.width,'3%','retained memory keeps its actual share of the window')
    assert.match(card.querySelector('[data-slice="summary"]').title,/属于已用内容/)
    assert.match(card.querySelector('[data-slice="reserve"]').title,/检查线 79\.00%/)
    assert.equal(card.querySelectorAll('.cmv-key:disabled').length,3,'unclassified usage, free space and reserve are not content filters')
  } finally { await act(async () => root.unmount()); dom.window.close(); delete globalThis.window; delete globalThis.document }
})

test('request status uses live admission pressure, leaves unknown cuts unknown and preserves projection trends', async () => {
  const dom = new JSDOM('<div id="root"></div>', { url: 'http://localhost' })
  globalThis.window = dom.window; globalThis.document = dom.window.document; globalThis.IS_REACT_ACT_ENVIRONMENT = true
  const base = { sessionId: 'admission', cursor: 2, cutSeq: 2, sampledAt: 1000, historical: false, compression: { mode: 'enhanced', hostCapability: 'supported', reason: 'Inspection enhanced' },
    pressure: { window: 200000, projected: 100000, input: 99000 }, official: null, usage: null,
    model: { provider: 'offline', model: '200k', maxTokens: 8192, effort: null }, parts: [], rows: [],
    total: 0, offset: 0, pageSize: 50, activeCount: 0, archivedCount: 0, requests: [], requestCount: 0, compactions: [],
    pressureHistory: [{ seq: 2, time: 1000, kind: 'current', tokens: 100000, window: 200000 }] }
  const reading = { tokens: 170000, logRevision: 3, baseline: 'usage', window: 200000, outputReserve: 8192 }
  const formValue = { revision: 1, value: { policy: defaults } }
  const form = { subscribe: () => () => {}, getSnapshot: () => formValue }
  const pulse = { subscribe: () => () => {}, getSnapshot: () => 1 }
  const root = createRoot(document.getElementById('root'))
  const render = async (snapshot, idleMode = null, idleCapacity = null) => {
    const statusMode = idleMode ?? snapshot.compression?.mode ?? null
    const api = {
      idleStatus: async () => ({ status: 'off', dueAt: null, message: '',
        ...(statusMode ? { compression: { mode: statusMode, hostCapability: 'supported', reason: `idle ${statusMode}` } } : {}),
        ...(idleCapacity ? { capacity: idleCapacity } : {}),
        ...(statusMode === 'enhanced' ? { emergency: { eligible: true, used: false, message: 'synthetic-only' } } : {}) }),
      prepareEmergency: async () => ({ token: 'synthetic-only', expiresAt: Date.now() + 120000, cycle: 1,
        warning: 'synthetic preview only', model: 'synthetic', deadline: 'two minutes', estimatedInput: 100 }),
      executeEmergency: async () => { throw new Error('synthetic emergency must not execute') },
      inspect: async () => snapshot,
    }
    await act(async () => root.render(React.createElement(client.ContextInspectorView, { target: 'admission', form, api, pulse })))
    await act(async () => new Promise(resolve => setTimeout(resolve, 230)))
  }
  const status = () => document.querySelector('.cmv-quick')
  const binding = () => document.querySelector('.cmv-binding-status')
  const recentInput = () => status().querySelector('.cmv-request-values strong')
  const recentDetail = () => status().querySelector('.cmv-request-detail')
  try {
    await render({ ...base, admission: reading })
    assert.equal(binding().dataset.mode, 'enhanced')
    assert.match(binding().textContent, /整理功能已接入/)
    assert.match(status().textContent, /预计先压缩，再执行/)
    assert.equal(status().querySelector('[data-admission-tokens]').dataset.admissionTokens, '170000')
    assert.match(status().textContent, /检查线 79\.00%/)
    assert.match(document.querySelector('.cmv-bars > button').getAttribute('aria-label'), /50\.00%/)
    assert.equal(document.querySelector('.cmv-run-details').open, false)
    await act(async () => document.querySelector('.cmv-run-details summary').click())
    const automaticPolicy = runFact('已保存策略')
    assert.match(automaticPolicy, /自动工作集/)
    assert.match(automaticPolicy, /近期原文预算 10% · 20,000 Token/)
    assert.match(automaticPolicy, /摘要输出预算 4% · 8,000 Token/)
    assert.match(automaticPolicy, /压缩后目标由实际工作集规划/)
    assert.doesNotMatch(automaticPolicy, /目标 55%/, 'automatic mode never presents the inactive saved custom percentage as its result')
    await render({ ...base, pressure: { ...base.pressure, projected: 190000 }, admission: { ...reading, tokens: 50000 } })
    assert.match(status().textContent, /预计可继续执行/)
    for (const snapshot of [base, { ...base, admission: { ...reading, outputReserve: null } },
      { ...base, admission: { ...reading, window: null } }]) {
      await render(snapshot)
      assert.match(status().textContent, /等待完整参数/)
      assert.doesNotMatch(status().textContent, /预计可继续|预计先压缩/)
      assert.match(status().textContent, /检查线 —/)
      if(snapshot.admission?.window===null){
        const number = document.querySelector('.cmv-composition .cmv-number')
        assert.equal(number.querySelector('strong').textContent,'≈ 170.0K Token','known live meter occupancy remains a Token readout when the route window is unknown')
        assert.equal(number.querySelector('span').textContent,'/ — Token','current unknown route cannot borrow an old pressure window')
        assert.equal(number.querySelector('b').textContent,'—','an unknown denominator has no derived percentage')
        const policy = runFact('已保存策略')
        assert.match(policy, /尚无窗口容量/)
        assert.doesNotMatch(policy, /20,000 Token|8,000 Token/, 'unknown capacity never uses a default denominator to invent token budgets')
      }
    }
    for (const mode of ['native', 'other', 'unconfigured', 'unavailable', 'unknown']) {
      await render({ ...base, compression: { mode, hostCapability: 'supported', reason: `Inspection ${mode}` }, admission: reading })
      assert.doesNotMatch(status().textContent, /预计可继续|预计先压缩/)
      assert.match(status().textContent, /检查线 —/)
      assert.equal(binding().dataset.mode, mode)
      if (mode === 'native') {
        assert.equal(binding().textContent, '由系统整理', 'the first screen uses a concise native status')
        assert.match(runFact('压缩方式'), /由系统整理/)
        assert.match(runFact('压缩方式'), /说明 Inspection native/)
      }
    }
    await render({ ...base, compression: { mode: 'enhanced', hostCapability: 'supported', reason: 'Inspection enhanced' }, admission: reading }, 'native')
    assert.equal(binding().dataset.mode, 'unknown', 'conflicting current reads fail closed')
    assert.equal(binding().textContent, '状态不一致，待确认')
    assert.match(runFact('压缩方式'), /状态不一致，待确认/)
    assert.doesNotMatch(status().textContent, /预计可继续|预计先压缩/)
    const latestRequest = { seq: 3, time: 1001, turn: 1, step: 2, provider: 'offline', model: '200k', input: 43210, output: 800, cacheRead: null }
    await render({ ...base, requests: [latestRequest] })
    assert.match(recentInput().textContent, /43\.2K Token/)
    assert.equal(recentDetail().textContent, '请求输入用量 · —')
    assert.doesNotMatch(recentInput().textContent, /99,000/)
    await render({ ...base, requests: [latestRequest], pressureHistory: [{ seq: 3, time: 1001, kind: 'current', tokens: 80000, window: 100000 }] })
    assert.equal(recentDetail().textContent, '请求输入用量 · —', 'a current point cannot supply a request denominator even at the same seq')
    const requestWindowHistory = [
      { seq: 2, time: 1000, kind: 'reply', tokens: 120000, window: 200000 },
      { seq: 3, time: 1001, kind: 'reply', tokens: 80000, window: 100000 },
      { seq: 4, time: 1002, kind: 'current', tokens: 300000, window: 400000 },
    ]
    await render({ ...base, model: { provider: 'offline', model: 'switched-model', maxTokens: 4096, effort: null },
      requests: [{ ...latestRequest, seq: 2, time: 1000 }, latestRequest], pressureHistory: requestWindowHistory })
    assert.match(recentInput().textContent, /43\.2K Token/)
    assert.match(recentDetail().textContent, /43\.21%/,'same-model requests use their own windows after the current model changes')
    await render({ ...base, requests: [latestRequest], pressureHistory: requestWindowHistory.map(point => point.seq === 3 ? { ...point, time: 9999 } : point) })
    assert.equal(recentDetail().textContent, '请求输入用量 · —', 'a mismatched event time is not treated as this request denominator')
    await render({ ...base, requests: [latestRequest], pressureHistory: requestWindowHistory.map(point => point.seq === 3 ? { ...point, window: null } : point) })
    assert.equal(recentDetail().textContent, '请求输入用量 · —', 'a reply without a recorded window stays unknown')
    await render({ ...base, admission: reading }, null, { windowTokens: 200000, admission: 150000, upper: 130000, resumeHeadroom: 20000,
      requiredResumeHeadroom: 10000, resumeHeadroomLimit: 30000, recentGrowth: 9000, protectedTokens: 25000, totalTokens: 160000, incomingTokens: 5000 })
    const capacityDetails = document.querySelector('[data-compact-capacity]').textContent
    assert.match(capacityDetails, /75\.00%/)
    assert.match(capacityDetails, /100\.00%/)
    assert.doesNotMatch(capacityDetails, /Token/,'capacity details use percentages while usage ledgers retain Token units')
    await render({...base,admission:{...reading,window:1000000}})
    assert.match(document.querySelector('.cmv-bars > button').getAttribute('aria-label'),/50\.00%/,'historical point keeps its original 200K denominator after a model change')
    await render({ ...base, admission: reading })
    await act(async () => [...document.querySelectorAll('button')].find(button => button.textContent === '检查一次人工恢复（不调用模型）')?.click())
    await act(async () => new Promise(resolve => setTimeout(resolve, 0)))
    assert.ok([...document.querySelectorAll('button')].some(button => button.textContent === '确认未知费用风险并额外调用一次'),
      'the synthetic emergency plan is visible for a current session and does not dispatch a model call')
    await render({ ...base, pressure:null, admission: reading, historical: true, rows:[{id:'past',seq:1,title:'historical row',category:'user',current:true,source:'fixture',tokens:20000,images:0}], total:1 })
    assert.match(document.querySelector('.cmv-content').textContent,/10\.00%/,'historical preview uses cut window, not current admission or null pressure')
    assert.match(status().textContent, /历史截面/)
    assert.match(status().textContent, /本次请求占用 未知/)
    assert.equal(status().querySelector('[data-admission-tokens]'), null)
    assert.equal(binding().dataset.mode, 'enhanced')
    assert.equal(binding().textContent, '历史截面')
    assert.match(runFact('压缩方式'), /历史截面/)
    assert.doesNotMatch(binding().textContent, /当前会话/)
    assert.equal(document.querySelector('.cmv-meta').textContent, '', 'historical data removes current idle and emergency controls')
    assert.ok(![...document.querySelectorAll('button')].some(button => button.textContent === '确认未知费用风险并额外调用一次'),
      'a pending emergency plan is discarded when the current view becomes historical')
    assert.doesNotMatch(document.body.textContent, /synthetic preview only|synthetic-only/)
    assert.equal(document.querySelector('[data-compact-capacity]'), null, 'historical cuts do not reuse current idle-plan capacity')

    const customPolicy = { ...defaults, historyMode: 'custom', targetPercent: 61 }
    formValue.value = { policy: customPolicy }
    await render({ ...base, admission: reading })
    const customDetails = runFact('已保存策略')
    assert.match(customDetails, /自定义占用上限/)
    assert.match(customDetails, /目标 61%/, 'custom mode shows the saved custom cap')
    assert.doesNotMatch(customDetails, /目标 55%|压缩后目标由实际工作集规划/)

    const legacyAutomatic = { ...defaults, capacityMode: 'legacy', recentTokens: 12_345, summaryMaxTokens: 4_321 }
    formValue.value = { policy: legacyAutomatic }
    await render({ ...base, admission: reading })
    const legacyDetails = runFact('已保存策略')
    assert.match(legacyDetails, /旧版 Token 设置仍生效/)
    assert.match(legacyDetails, /近期原文预算 12,345 Token/)
    assert.match(legacyDetails, /摘要输出预算 4,321 Token/)
    assert.match(legacyDetails, /压缩后目标由实际工作集规划/)
    assert.doesNotMatch(legacyDetails, /目标 55%|近期原文预算 10%|摘要输出预算 4%/)
  } finally { await act(async () => root.unmount()); dom.window.close(); delete globalThis.window; delete globalThis.document }
})

test('binding badge does not present retained enhancement as current while refreshing or after a failed read', async () => {
  const dom = new JSDOM('<div id="root"></div>', { url: 'http://localhost' })
  globalThis.window = dom.window; globalThis.document = dom.window.document; globalThis.IS_REACT_ACT_ENVIRONMENT = true
  const snapshot = { sessionId: 'binding-refresh', cursor: 1, cutSeq: 1, sampledAt: 10, historical: false,
    compression: { mode: 'enhanced', hostCapability: 'supported', reason: 'Context active' }, pressure: null, official: null, usage: null,
    cooperation: { toolResults: { state: 'unsupported', finalResultSeen: false }, originals: { state: 'unavailable', count: 0 }, idleMaintenance: 'unsupported', requestPressure: 'unsupported' },
    admission: { tokens: 50000, logRevision: 1, baseline: 'usage', window: 200000, outputReserve: 8192 },
    model: null, parts: [], rows: [], total: 0, offset: 0, pageSize: 50, activeCount: 0, archivedCount: 0,
    requests: [], requestCount: 0, compactions: [], pressureHistory: [] }
  const formSnapshot = { revision: 1, value: { policy: defaults } }
  const form = { subscribe: () => () => {}, getSnapshot: () => formSnapshot }
  let pulseRevision = 1
  const pulseListeners = new Set()
  const pulse = { subscribe: callback => { pulseListeners.add(callback); return () => pulseListeners.delete(callback) }, getSnapshot: () => pulseRevision }
  let behavior = 'success', idleBehavior = 'success', rejectPending, rejectIdle
  const api = {
    idleStatus: async () => {
      if (idleBehavior === 'failure') throw new Error('idle offline')
      if (idleBehavior === 'pending') return new Promise((_, reject) => { rejectIdle = reject })
      return { status: 'off', dueAt: null, message: '闲置自动压缩已关闭', owner: 'context-manager', compression: { mode: 'enhanced', hostCapability: 'supported', reason: 'Idle active' } }
    },
    inspect: async () => {
      if (behavior === 'failure') throw new Error('offline')
      if (behavior === 'pending') return new Promise((_, reject) => { rejectPending = reject })
      return snapshot
    },
  }
  const root = createRoot(document.getElementById('root'))
  const binding = () => document.querySelector('.cmv-binding-status')
  const wait = async ms => act(async () => new Promise(resolve => setTimeout(resolve, ms)))
  const refreshPulse = async () => act(async () => { pulseRevision++; pulseListeners.forEach(callback => callback()) })
  try {
    await act(async () => root.render(React.createElement(client.ContextInspectorView, { target: 'binding-refresh', form, api, pulse })))
    await wait(230)
    assert.equal(binding().dataset.mode, 'enhanced')
    assert.match(document.querySelector('.cmv-meta').textContent, /闲置整理 · 已关闭/,
      'only an explicit enhanced idle-disabled status is labeled as off')
    assert.match(document.querySelector('.cmv-quick').textContent, /预计可继续执行/)
    idleBehavior = 'failure'
    await refreshPulse(); await wait(230)
    assert.equal(binding().dataset.mode, 'unknown', 'an idle polling failure cannot fall back to a retained Inspection binding')
    assert.equal(binding().textContent, '状态刷新失败')
    assert.match(document.querySelector('.cmv-run-details').textContent, /状态刷新失败/)
    assert.doesNotMatch(document.querySelector('.cmv-quick').textContent, /预计可继续执行|预计先压缩/)
    idleBehavior = 'success'
    await refreshPulse(); await wait(230)
    assert.equal(binding().dataset.mode, 'enhanced', 'a successful current idle read restores the actual binding')
    assert.match(document.querySelector('.cmv-quick').textContent, /预计可继续执行/)
    behavior = 'pending'
    idleBehavior = 'pending'
    await act(async () => document.querySelector('.cmv-run-details summary').click())
    assert.equal(document.querySelector('.cmv-run-details').open, true)
    await refreshPulse()
    await wait(230)
    assert.equal(binding().dataset.mode, 'enhanced', 'same-session background inspection does not clear a confirmed binding while pending')
    assert.equal(document.querySelector('.cmv-run-details').open, true, 'same-session polling does not remount or collapse run details')
    await refreshPulse()
    await wait(230)
    assert.equal(binding().dataset.mode, 'enhanced', 'a second pending refresh keeps the confirmed binding visible')
    assert.equal(document.querySelector('.cmv-run-details').open, true, 'consecutive same-session refreshes preserve the open details panel')
    rejectPending(new Error('offline')); rejectIdle(new Error('idle offline'))
    await act(async () => new Promise(resolve => setTimeout(resolve, 0)))
    assert.equal(binding().dataset.mode, 'unknown')
    assert.equal(binding().textContent, '状态刷新失败')
    assert.match(document.querySelector('.cmv-run-details').textContent, /状态刷新失败/)
    assert.equal(document.querySelector('.cmv-run-details').open, true, 'real failures remain visible without resetting the user-opened details')
    assert.match(runFact('功能状态'), /上次读数/,
      'retained cooperation capabilities are labeled as the last read after inspection fails')
    behavior = 'pending'
    idleBehavior = 'failure'
    await act(async () => root.render(React.createElement(client.ContextInspectorView, { target: 'other-session', form, api, pulse })))
    assert.equal(binding().dataset.mode, 'unknown', 'switching sessions cannot carry over the previous Agent badge')
    assert.equal(document.querySelector('.cmv-run-details').open, false, 'a new session starts with collapsed run details')
    rejectPending(new Error('cancelled'))
  } finally { await act(async () => root.unmount()); dom.window.close(); delete globalThis.window; delete globalThis.document }
})

test('native Basic shows only a current Context sidecar gate with its saved request policy', async () => {
  const dom = new JSDOM('<div id="root"></div>', { url: 'http://localhost' })
  globalThis.window = dom.window; globalThis.document = dom.window.document; globalThis.IS_REACT_ACT_ENVIRONMENT = true
  const formState = { revision: 1, value: { policy: { ...defaults } } }
  const form = { subscribe: () => () => {}, getSnapshot: () => formState }
  const pulseListeners = new Set(); let pulseRevision = 1
  const pulse = { subscribe: callback => { pulseListeners.add(callback); return () => pulseListeners.delete(callback) }, getSnapshot: () => pulseRevision }
  const baseCooperation = { toolResults: { state: 'off', finalResultSeen: false }, originals: { state: 'empty', count: 0 }, idleMaintenance: 'off', requestPressure: 'context' }
  let snapshot = { sessionId: 'basic-context-sidecar', cursor: 2, cutSeq: 2, sampledAt: 1000, historical: false,
    compression: { mode: 'native', hostCapability: 'unsupported', reason: 'Official Basic remains active',
      agentPreset: 'official-basic', generation: 4, provider: 'deepseek-official', source: 'registration' },
    cooperation: baseCooperation,
    admission: { tokens: 170000, logRevision: 3, baseline: 'usage', window: 200000, outputReserve: 0 },
    pressure: { projected: 100000, input: 99000, window: 200000 }, official: null, usage: null,
    model: { provider: 'custom', model: 'custom-without-output-cap', maxTokens: null, effort: null }, parts: [], rows: [], total: 0, offset: 0,
    pageSize: 50, activeCount: 0, archivedCount: 0, requests: [], requestCount: 0, compactions: [], pressureHistory: [] }
  let pending = false, releasePending
  const api = {
    idleStatus: async () => ({ status: 'off', dueAt: null, message: '', compression: { mode: 'native', hostCapability: 'unsupported', reason: 'Official Basic remains active' } }),
    inspect: async () => pending ? new Promise(resolve => { releasePending = resolve }) : snapshot,
  }
  const root = createRoot(document.getElementById('root'))
  const read = () => document.querySelector('.cmv-quick')
  const refresh = async () => {
    await act(async () => [...document.querySelectorAll('button')].find(button => button.textContent === '刷新')?.click())
    await act(async () => new Promise(resolve => setTimeout(resolve, 230)))
  }
  const pulseRead = async () => act(async () => { pulseRevision++; pulseListeners.forEach(callback => callback()) })
  try {
    await act(async () => root.render(React.createElement(client.ContextInspectorView, { target: 'basic-context-sidecar', form, api, pulse })))
    await act(async () => new Promise(resolve => setTimeout(resolve, 230)))
    assert.match(document.querySelector('.cmv-meta').textContent, /本会话未启用/,
      'a native Basic provider does not prove that the Context idle setting was explicitly switched off')
    assert.equal(document.querySelector('.cmv-binding-status').dataset.mode, 'native')
    assert.equal(document.querySelector('.cmv-binding-status').textContent, '由系统整理',
      'the first-screen binding label stays concise')
    assert.equal(document.querySelector('.cmv-run-details').open, false)
    await act(async () => document.querySelector('.cmv-run-details summary').click())
    const bindingDetails = runFact('压缩方式')
    assert.match(bindingDetails, /Agent 预设 official-basic/)
    assert.match(bindingDetails, /绑定代次 4/)
    assert.match(bindingDetails, /Provider deepseek-official/)
    assert.match(bindingDetails, /绑定来源 注册/)
    assert.match(bindingDetails, /说明 Official Basic remains active/)
    assert.match(runFact('功能状态'), /完整请求压力整理: 由 Context 插件侧路执行；官方 provider 保持原绑定/,
      'the visible sidecar state is separate from the native provider binding')
    assert.match(runFact('已保存策略'), /自动工作集/)
    assert.match(read().textContent, /预计先压缩，再执行/)
    assert.match(read().textContent, /检查线 79\.00%/)
    assert.equal(read().querySelector('[data-context-request-gate]').dataset.contextRequestGate, 'active')
    await act(async () => read().querySelector('[data-context-request-gate]').focus())
    assert.match(document.querySelector('[role="tooltip"]')?.textContent ?? '', /这是 Context 完整请求准入检查线。官方 Basic 仍按自身策略提前自动整理；Context 设置不会更改 Basic 原生策略。/)
    assert.ok(document.querySelector('[data-color="reserve"]'), 'the current sidecar gate separates output reserve from free capacity')
    assert.match(runFact('已保存策略'), /已启用/)
    assert.doesNotMatch(runFact('已保存策略'), /目标 55%/)

    pending = true
    await refresh()
    assert.match(read().textContent, /数据待刷新/)
    assert.equal(read().querySelector('[data-context-request-gate]'), null, 'stale reads do not present a live sidecar gate')
    assert.ok(!document.querySelector('[data-color="reserve"]'), 'stale reads do not reuse the saved-policy reserve')
    pending = false; releasePending?.(snapshot); await act(async () => new Promise(resolve => setTimeout(resolve, 0)))

    snapshot = { ...snapshot, historical: true, cooperation: undefined, pressure: null,
      pressureHistory: [{ seq: 2, time: 1000, kind: 'current', tokens: 100000, window: 200000 }] }
    await refresh()
    assert.match(read().textContent, /历史截面/)
    assert.equal(read().querySelector('[data-context-request-gate]'), null)
    assert.equal(document.querySelector('[data-color="reserve"]'), null)

    snapshot = { ...snapshot, historical: false, cooperation: { ...baseCooperation, requestPressure: 'native' } }
    await refresh()
    assert.equal(read().querySelector('[data-context-request-gate]'), null, 'Basic-only routing has no Context gate')
    assert.equal(document.querySelector('[data-color="reserve"]'), null)

    formState.value = {}
    snapshot = { ...snapshot, pressure: { projected: 100000, input: 99000, window: 200000 },
      cooperation: { ...baseCooperation, requestPressure: 'unknown' } }
    await refresh()
    assert.match(runFact('功能状态'), /完整请求压力整理: 状态未知/)
    assert.equal(runFact('已保存策略'), '未知')
    assert.equal(read().querySelector('[data-context-request-gate]'), null, 'unknown cooperation cannot claim a live Context gate')
    assert.equal(document.querySelector('[data-color="reserve"]'), null, 'unknown cooperation cannot present a Context reserve')

    formState.value = { policy: { ...defaults, enabled: false } }
    snapshot = { ...snapshot, cooperation: { ...baseCooperation, requestPressure: 'off' } }
    await refresh()
    assert.match(read().textContent, /Context 请求检查未启用/)
    assert.match(runFact('功能状态'), /完整请求压力整理: 未启用/)
    assert.match(runFact('已保存策略'), /已关闭/)
    assert.equal(read().querySelector('[data-context-request-gate]'), null)
    assert.equal(document.querySelector('[data-color="reserve"]'), null)
  } finally { await act(async () => root.unmount()); dom.window.close(); delete globalThis.window; delete globalThis.document }
})

test('percentage settings require explicit legacy migration, preserve old fields and validate percent input',async()=>{
 const dom=new JSDOM('<div id="root"></div>',{url:'http://localhost'})
 globalThis.window=dom.window;globalThis.document=dom.window.document;globalThis.IS_REACT_ACT_ENVIRONMENT=true
 const {capacityMode,recentPercent,summaryPercent,repairPercent,...legacy}=defaults
 let snapshot={status:'ready',writable:true,mode:'host',revision:12,value:{policy:{...legacy,absoluteEnabled:true,absoluteTriggerTokens:200000,absoluteTargetTokens:120000}}}
 const writes=[],listeners=new Set()
 const form={subscribe:cb=>{listeners.add(cb);return()=>listeners.delete(cb)},getSnapshot:()=>snapshot,async mutate(ops,revision){writes.push({ops,revision});snapshot={...snapshot,revision:snapshot.revision+1,value:{policy:ops[0].value}};listeners.forEach(cb=>cb());return true}}
 const root=createRoot(document.getElementById('root'))
 const button=label=>[...document.querySelectorAll('button')].find(n=>n.textContent===label)
 const click=async label=>act(async()=>button(label).click())
 const edit=async(key,value)=>act(async()=>setDomInput(document.getElementById(`context-manager-${key}`),value))
  try{
  await act(async()=>root.render(React.createElement(client.ContextSettings,{form})))
  assert.match(document.body.textContent,/旧 Token 上限仍生效/)
  assert.equal(document.getElementById('context-manager-recentPercent'),null,'legacy capacity mode does not render percentage-only controls')
  assert.equal(document.getElementById('context-manager-example'),null,'no guessed model denominator')
  await act(async()=>setDomInput(document.getElementById('context-manager-triggerPercent'),'70'))
  await click('保存设置')
  assert.equal(writes[0].revision,12)
  assert.equal(writes[0].ops[0].value.triggerPercent,70,'the real numeric control stages and saves the trigger')
  assert.equal(writes[0].ops[0].value.capacityMode,'legacy','ordinary save never migrates')
  assert.equal(writes[0].ops[0].value.absoluteTriggerTokens,200000)
  assert.equal(writes.length,1,'ordinary save does not implicitly migrate old quota fields')
  await click('改用百分比策略')
  assert.equal(writes.length,1,'explicit switch still requires native save')
  assert.equal(document.getElementById('context-manager-recentPercent').disabled,false)
  for(const value of ['', '0', '51']){await edit('recentPercent',value);assert.equal(button('保存设置').disabled,true)}
  await edit('recentPercent','12.5');await edit('summaryPercent','3.5');await click('保存设置')
  assert.equal(writes[1].revision,13);assert.equal(writes[1].ops[0].value.capacityMode,'percent')
  assert.equal(writes[1].ops[0].value.recentPercent,12.5)
  assert.equal(writes[1].ops[0].value.summaryPercent,3.5)
  assert.equal(writes[1].ops[0].value.absoluteTriggerTokens,200000,'old fields retained but explicitly deactivated')
  assert.equal(writes[1].ops[0].value.absoluteTargetTokens,120000)
  assert.equal(writes[1].ops[0].value.triggerPercent,70,'explicit migration preserves the saved trigger')
  assert.equal(form.getSnapshot().revision,14,'the acknowledged policy is read back at its new revision')
  assert.equal(document.getElementById('context-manager-recentPercent').value,'12.5')
 }finally{await act(async()=>root.unmount());dom.window.close();delete globalThis.window;delete globalThis.document}
})

test('settings: checkpoint protocol selector keeps JSON default and saves sections explicitly', async()=>{
 const dom=new JSDOM('<div id="root"></div>',{url:'http://localhost'})
 globalThis.window=dom.window;globalThis.document=dom.window.document;globalThis.IS_REACT_ACT_ENVIRONMENT=true
 const legacy={...defaults,repairPercent:8.5,formatRepairMaxTokens:777};delete legacy.checkpointFormat
 const writes=[],listeners=new Set()
 let snapshot={status:'ready',writable:true,mode:'host',revision:21,value:{policy:legacy}}
 const form={subscribe:cb=>{listeners.add(cb);return()=>listeners.delete(cb)},getSnapshot:()=>snapshot,async mutate(ops,revision){writes.push({ops,revision});snapshot={...snapshot,revision:snapshot.revision+1,value:{policy:ops[0].value}};listeners.forEach(cb=>cb());return true}}
 const root=createRoot(document.getElementById('root'))
 const button=label=>[...document.querySelectorAll('button')].find(n=>n.textContent===label)
  const click=async label=>act(async()=>button(label).click())
 try{
  await act(async()=>root.render(React.createElement(client.ContextSettings,{form})))
  await act(async()=>document.querySelector('.cm-native-advanced summary').click())
  const format=document.getElementById('context-manager-checkpointFormat')
  assert.equal(format.value,'json','legacy config reads as JSON default without migration')
  assert.equal(document.getElementById('context-manager-repairPercent'),null,'obsolete repair quota is hidden from settings')
  assert.equal(document.getElementById('context-manager-formatRepairMaxTokens'),null,'obsolete repair Token cap is hidden from settings')
  assert.equal(writes.length,0)
  await act(async()=>setDomSelect(format,'sections'));await click('保存设置')
  assert.equal(writes[0].ops[0].value.checkpointFormat,'sections','the explicit UI choice is written to the policy')
  assert.equal(writes[0].ops[0].value.repairPercent,legacy.repairPercent,'legacy repair fields stay readable, not deleted')
  assert.equal(writes[0].ops[0].value.formatRepairMaxTokens,legacy.formatRepairMaxTokens)
 }finally{await act(async()=>root.unmount());dom.window.close();delete globalThis.window;delete globalThis.document}
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
  const edit = (key, value) => act(async () => setDomInput(document.getElementById(`context-manager-${key}`), value))
  try {
    await act(async () => root.render(React.createElement(client.ContextSettings, { form })))
    // Legacy fill-in: defaults appear without overwriting anything else, and the
    // default mode stays observe.
    assert.equal(document.querySelector('#context-manager-toolResultsMaxChars').value, '200000')
    assert.equal(document.querySelector('#context-manager-toolResultsMinSavings').value, '400')
    assert.equal(document.querySelector('#context-manager-archiveReadBudget').value, '6000')
    assert.equal(document.querySelector('#context-manager-archiveSearchLimit').value, '3')
    const toolMode = document.querySelector('#context-manager-toolResultsMode')
    assert.equal(toolMode.value, 'observe')
    assert.match(document.querySelector('.cm-native-help[aria-label^="工具结果处理: "]')?.getAttribute('aria-label') ?? '', /原文保留在本机/)
    assert.match(document.querySelector('.cm-native-help[aria-label^="单次原文回读: "]')?.getAttribute('aria-label') ?? '', /单个搜索或读取结果的字符上限/)
    // An unimplemented retention switch must not be offered.
    assert.equal(document.body.textContent.includes('archiveRetention'), false)
    // Empty is invalid, never zero.
    await edit('toolResultsMaxChars', '')
    assert.equal(document.querySelector('#context-manager-toolResultsMaxChars').value, '')
    assert.equal(save().disabled, true)
    await edit('toolResultsMaxChars', '1999')
    assert.equal(save().disabled, true, 'a value below the documented minimum stays invalid')
    await act(async () => setDomSelect(toolMode, 'reduce'))
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
    assert.equal(toolMode.value, 'reduce')
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
  inspection.summaryUsage = { input: 900, output: 120, attempts: 2, unknownAttempts: 1, since: 1000 }
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
    assert.match(text, /整理用量 ≥ 1\.0K Token/)
    assert.match(text, /摘要已记录 ≥ 1\.0K Token/)
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

    const unknownLedger = { source: 'summary-ledger', input: 0, output: 0, cacheRead: null, cacheWrite: null,
      attempts: 2, unknownAttempts: 2, purposeSplit: false, note: 'Unknown attempts may contain unreported usage.' }
    const summaryUnknown = { ...base, usage: { input: 0, uncached: 0, cacheRead: 0, cacheWrite: 0, output: 0 },
      summaryUsage: { input: 0, output: 0, attempts: 2, unknownAttempts: 2, since: 1000 },
      efficiency: { accounting: 'host-projection', host: null,
        mirrored: { settledAttempts: 2, retries: 0, withoutUsage: 2,
          uncachedInput: field(0, 0, 2), cacheRead: field(0, 0, 2), cacheWrite: field(0, 0, 2), output: field(0, 0, 2),
          cacheInclusiveInput: field(0, 0, 2), complete: false },
        differences: [], summaryAndRepair: unknownLedger, maintenanceSuspects: 0, cacheHitRatio: null,
        requests: [], fingerprint: null, changes: [] } }
    root = await render(summaryUnknown)
    text = document.body.textContent
    assert.match(text, /摘要已记录 — 未知/)
    assert.match(document.querySelector('[data-efficiency]').textContent, /整理用量 — 未知/)
    assert.ok(!/摘要已记录 (?:≈\s*|≥\s*)?0 Token/u.test(text))
    assert.ok(!/整理用量 (?:≈\s*|≥\s*)?0 Token/u.test(text))
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
    await act(async()=>document.querySelector('.cm-native-advanced summary').click())
    const timeoutMode = document.getElementById('context-manager-summaryTimeoutMode')
    assert.equal(timeoutMode.value,'fixed')
    assert.equal(document.getElementById('context-manager-timeoutMs').value,'135000')
    assert.equal(writes.length,0)
    await act(async()=>setDomSelect(timeoutMode,'adaptive'))
    assert.equal(writes.length,0,'switch is a draft until native save succeeds')
    assert.equal(document.getElementById('context-manager-timeoutMs').disabled,true)
    assert.equal(document.getElementById('context-manager-summaryTotalMs').value,'600000')
    await click('保存设置')
    assert.equal(writes[0].timeoutMs,135000);assert.equal(writes[0].summaryTimeoutMode,'adaptive')
    await act(async()=>setDomSelect(timeoutMode,'fixed'));await click('保存设置')
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
      requests: [{ seq: 9, time: 1000, turn: 9, step: 28, provider: 'synthetic', model, input: 8000000, output: null, cacheRead: null }], requestCount: 1, pressureHistory: [],
      compactions: [{ id: 'failed', kind: 'compact', status: 'failed', startedAt: 1000, applied: false, error: reason }, { id: 'running', kind: 'compact', status: 'running', startedAt: 2000, applied: false }] }),
    content: async query => { readIds.push(query.id); return { ...query, text: 'selected original', totalChars: 17, nextOffset: null } } }
  const root = createRoot(document.getElementById('root'))
  try {
    await act(async () => root.render(React.createElement(client.ContextInspectorView, { target: 'compact', api, form: { subscribe: () => () => {}, getSnapshot: () => state }, pulse: { subscribe: () => () => {}, getSnapshot: () => 1 } })))
    await act(async () => new Promise(resolve => setTimeout(resolve, 230)))
    assert.equal(document.querySelector('.cmv-context-title .cmv-model').textContent, `synthetic / ${model}`)
    assert.equal(document.querySelectorAll('.cmv-model').length, 1)
    assert.equal(document.querySelector('.cmv-quick .cmv-donut'), null)
    assert.match(document.querySelector('.cmv-quick').textContent, /本次请求占用 未知 \/ 检查线 —/)
    assert.match(document.querySelector('.cmv-quick').textContent, /8\.00M Token/)
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

test('manual emergency UI requires separate preview and explicit unknown-cost confirmation; zero dispatch is not unknown usage',async()=>{
 const dom=new JSDOM('<div id="root"></div>',{url:'http://localhost'});globalThis.window=dom.window;globalThis.document=dom.window.document;globalThis.IS_REACT_ACT_ENVIRONMENT=true
 const snapshot={revision:1,value:{policy:defaults}},calls=[]
 const api={idleStatus:async()=>({status:'off',dueAt:null,message:'quota',compression:{mode:'enhanced',hostCapability:'supported',reason:'Fixture enhanced'},emergency:{eligible:true,used:false,message:'旧调用费用未知'}}),
  inspect:async q=>({...q,cursor:10,cutSeq:10,sampledAt:1,historical:false,pressure:null,official:null,usage:null,model:null,parts:[],rows:[],total:0,pageSize:50,activeCount:0,archivedCount:0,requests:[],requestCount:0,pressureHistory:[],compactions:[{id:'denied',kind:'compact',status:'failed',startedAt:1,endedAt:2,applied:false,modelCallStatus:'not_dispatched'}]}),
  prepareEmergency:async()=>{calls.push('prepare');return {token:'token',expiresAt:Date.now()+120000,cycle:1,warning:'未知费用可能再次收费',model:'mock/large',deadline:'600s',estimatedInput:8000}},
  executeEmergency:async q=>{assert.equal(q.acceptUnknownCost,true);calls.push('execute');return {granted:true}}}
 const root=createRoot(document.getElementById('root'));const click=async text=>act(async()=>[...document.querySelectorAll('button')].find(b=>b.textContent===text).click())
 try{
  await act(async()=>root.render(React.createElement(client.ContextInspectorView,{target:'rescue',api,form:{subscribe:()=>()=>{},getSnapshot:()=>snapshot},pulse:{subscribe:()=>()=>{},getSnapshot:()=>1}})))
  await act(async()=>new Promise(r=>setTimeout(r,230)))
  assert.deepEqual(calls,[])
  assert.match(document.querySelector('.cmv-compactions').textContent,/未调用模型/)
  assert.doesNotMatch(document.querySelector('.cmv-compactions').textContent,/用量未知/)
  await click('检查一次人工恢复（不调用模型）');assert.deepEqual(calls,['prepare'])
  assert.match(document.body.textContent,/mock\/large.*600s.*8,?000|mock\/large.*600s.*8000/)
  await click('确认未知费用风险并额外调用一次');assert.deepEqual(calls,['prepare','execute'])
 }finally{await act(async()=>root.unmount());dom.window.close();delete globalThis.window;delete globalThis.document}
})
