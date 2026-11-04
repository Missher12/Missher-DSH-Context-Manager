import { test } from 'node:test'
import assert from 'node:assert/strict'
import vm from 'node:vm'
import { createRequire } from 'node:module'
import { buildSync } from 'esbuild'
import { JSDOM } from 'jsdom'
import React, { act } from 'react'
import { createRoot } from 'react-dom/client'

const require = createRequire(import.meta.url)
const sourceRoot = new URL('../src/', import.meta.url).pathname

const primitives = {
  Button: React.forwardRef((props, ref) => React.createElement('button', { type: 'button', ...props, ref }, props.children)),
  Input: React.forwardRef((props, ref) => React.createElement('input', { ...props, ref })),
  StateDot: () => null,
  Tooltip: ({ children }) => children,
}
const uiBuild = buildSync({
  stdin: { contents: "export * from './inspector-view.tsx'", resolveDir: sourceRoot },
  outfile: '/virtual/context-overview-ui.cjs', bundle: true, platform: 'browser', format: 'cjs', jsx: 'automatic', target: 'es2022',
  external: ['react', 'react/*', 'react-dom', 'react-dom/*', '@deepseek-ai/dsh-client-ui-primitives'], loader: { '.css': 'text' },
  tsconfigRaw: { compilerOptions: { target: 'ES2022' } }, write: false,
})
const uiScope = { module: { exports: {} }, AbortController, setTimeout, clearTimeout,
  require: name => name === '@deepseek-ai/dsh-client-ui-primitives' ? primitives : require(name) }
vm.runInNewContext(uiBuild.outputFiles[0].text, uiScope)
const client = uiScope.module.exports

const base = { sessionId: 's1', cursor: 5, cutSeq: 5, sampledAt: 1000, historical: false, pressure: null, official: null, usage: null,
  model: { provider: 'fixture', model: 'offline', maxTokens: null, effort: null }, parts: [], rows: [], total: 0, offset: 0, pageSize: 50,
  activeCount: 0, archivedCount: 0, requests: [], requestCount: 0, pressureHistory: [], compactions: [] }
const checkpointRow = { id: 'cp:1', seq: 4, title: 'applied summary', category: 'summary', current: true, source: 'fixture', tokens: 5, images: 0 }
const applied = (extra = {}) => ({ id: 'c1', kind: 'compact', status: 'completed', applied: true, startedAt: 1000, beforeTokens: 100, afterTokens: 10, checkpoint: checkpointRow, ...extra })
const policy = { enabled: true, idleEnabled: true, triggerPercent: 80, idleMinutes: 15, safetyPercent: 2, earlyPercent: 1, historyMode: 'automatic',
  toolResultsMode: 'observe', capacityMode: 'percent', summaryInstructions: '', checkpointFormat: 'json', summaryTimeoutMode: 'adaptive',
  formatRepairEnabled: true, prefixDiagnosticsEnabled: true }
const checkpointText = JSON.stringify({ goal: '完成上下文页验收', constraints: ['保留 80% 与 15 分钟'], completed: ['状态卡'], pending: ['视觉验收'], evidence: [], next: '等待验收', uncertainties: [] })

function harness(api, policyValue = policy) {
  const dom = new JSDOM('<div id="root"></div>', { url: 'http://localhost' })
  globalThis.window = dom.window; globalThis.document = dom.window.document; globalThis.IS_REACT_ACT_ENVIRONMENT = true
  const snapshot = { status: 'ready', writable: true, mode: 'host', revision: 1, value: { policy: policyValue } }
  const form = { subscribe: () => () => {}, getSnapshot: () => snapshot }
  const pulse = { subscribe: () => () => {}, getSnapshot: () => 1 }
  const root = createRoot(document.getElementById('root'))
  const settle = () => act(async () => new Promise(resolve => setTimeout(resolve, 240)))
  const render = target => act(async () => root.render(React.createElement(client.ContextInspectorView, { target, form, api, pulse })))
  const close = async () => { await act(async () => root.unmount()); dom.window.close(); delete globalThis.window; delete globalThis.document }
  return { render, settle, close }
}

test('summary preview reads only the newest applied checkpoint and drops a stale response', async () => {
  const reads = []
  const pending = []
  const api = {
    idleStatus: async () => ({ status: 'off', dueAt: null, message: '' }),
    inspect: async query => ({ ...base, ...query, compactions: [applied()] }),
    content: (query, signal) => { reads.push({ query, signal }); return new Promise(resolve => pending.push({ query, resolve })) },
  }
  const h = harness(api)
  try {
    await h.render('s1'); await h.settle()
    assert.equal(reads.length, 1, 'only the applied summary is read for the preview')
    assert.equal(reads[0].query.id, 'cp:1')
    await act(async () => pending.shift().resolve({ sessionId: 's1', cutSeq: 5, id: 'cp:1', text: checkpointText, offset: 0, totalChars: checkpointText.length, nextOffset: null }))
    assert.match(document.querySelector('.cmv-summary-preview').textContent, /完成上下文页验收/)
    assert.equal(document.querySelectorAll('.cmv-summary-list li').length, 1, 'constraints render as a list, never as a joined string')
    const expand = [...document.querySelectorAll('button')].find(button => button.textContent === '展开全部 7 项')
    assert.ok(expand, 'the preview keeps an explicit full-summary entry')
    await act(async () => expand.click())
    assert.ok(document.querySelector('.cmv-checkpoint-reader'), 'the full summary opens in the full-width closable reader instead of stretching the half-width card')
    assert.equal(reads.length, 2, 'opening the reader issues its own bounded read')
    assert.equal(reads[1].query.id, 'cp:1', 'the reader reads the same stored checkpoint')
    await h.render('s2'); await h.settle()
    assert.equal(reads[0].signal.aborted, true, 'switching sessions aborts the old read')
    assert.equal(reads.length, 3)
    assert.equal(reads[2].query.sessionId, 's2', 'the new target reads its own summary instead of reusing the old one')
    assert.equal(document.querySelector('.cmv-checkpoint-reader'), null, 'the previous session reader closes on a target change')
    assert.doesNotMatch(document.body.textContent, /完成上下文页验收/, 'the previous session preview never flashes on the new target')
    await act(async () => pending.at(-1).resolve({ sessionId: 's2', cutSeq: 5, id: 'cp:1', text: checkpointText, offset: 0, totalChars: checkpointText.length, nextOffset: null }))
    await h.settle()
    assert.match(document.querySelector('.cmv-summary-preview').textContent, /完成上下文页验收/)
  } finally { await h.close() }
})

test('reduction card keeps the newest applied entry and reports an increase or unknown honestly', async () => {
  const increasing = { ...base, compactions: [applied({ id: 'grow', beforeTokens: 100, afterTokens: 150 })] }
  const api = { idleStatus: async () => ({ status: 'off', dueAt: null, message: '' }), inspect: async query => ({ ...increasing, ...query }), content: () => new Promise(() => {}) }
  const h = harness(api)
  try {
    await h.render('s1'); await h.settle()
    const value = document.querySelector('.cmv-stat[data-stat="reduction"] .cmv-stat-value')
    assert.equal(value.dataset.delta, 'increased')
    assert.equal(value.textContent, '+50')
    assert.match(document.querySelector('.cmv-stat[data-stat="reduction"]').textContent, /增加/)
  } finally { await h.close() }

  const latestWithoutValues = { ...base, compactions: [applied({ id: 'older' }), applied({ id: 'newer', beforeTokens: undefined, afterTokens: undefined })] }
  const api2 = { idleStatus: async () => ({ status: 'off', dueAt: null, message: '' }), inspect: async query => ({ ...latestWithoutValues, ...query }), content: () => new Promise(() => {}) }
  const h2 = harness(api2)
  try {
    await h2.render('s1'); await h2.settle()
    const value = document.querySelector('.cmv-stat[data-stat="reduction"] .cmv-stat-value')
    assert.equal(value.dataset.delta, 'unknown', 'the newest applied entry decides the card')
    assert.equal(value.textContent, '—')
  } finally { await h2.close() }
})

test('capacity legend keeps an unknown reserve without inventing free space', async () => {
  const data = { ...base, admission: { tokens: 100, logRevision: 1, baseline: 'usage', window: 1000, outputReserve: 100 },
    parts: [{ category: 'tool', tokens: 100, count: 1 }] }
  const api = { idleStatus: async () => ({ status: 'off', dueAt: null, message: '' }), inspect: async query => ({ ...data, ...query }) }
  const h = harness(api, { ...policy, enabled: false })
  try {
    await h.render('s1'); await h.settle()
    assert.equal(document.querySelector('.cmv-composition [data-color="reserve"]'), null, 'no gray segment is fabricated without a recorded gate')
    const unknown = document.querySelector('.cmv-composition .cmv-capacity-readout [data-slice="reserve"]')
    assert.ok(unknown)
    assert.equal(unknown.dataset.value, 'unknown')
    assert.match(unknown.textContent, /未提供/)
    assert.equal(document.querySelector('.cmv-composition .cmv-capacity-readout [data-slice="free"]')?.dataset.value, '900', 'free space still comes from the recorded window minus occupancy')
  } finally { await h.close() }
})

test('an unknown route window keeps unknown free and reserve legend entries', async () => {
  const data = { ...base, admission: { tokens: 100, logRevision: 1, baseline: 'usage', window: null, outputReserve: null },
    parts: [{ category: 'tool', tokens: 100, count: 1 }] }
  const api = { idleStatus: async () => ({ status: 'off', dueAt: null, message: '' }), inspect: async query => ({ ...data, ...query }) }
  const h = harness(api)
  try {
    await h.render('s1'); await h.settle()
    const free = document.querySelector('.cmv-composition .cmv-capacity-readout [data-slice="free"]')
    const reserve = document.querySelector('.cmv-composition .cmv-capacity-readout [data-slice="reserve"]')
    assert.ok(free, 'free space keeps an explicit unknown legend entry')
    assert.ok(reserve, 'the gray reserve never disappears just because the window is unknown')
    assert.equal(free.dataset.value, 'unknown'); assert.equal(reserve.dataset.value, 'unknown')
    assert.match(reserve.textContent, /未提供/)
    assert.equal(document.querySelector('.cmv-composition [data-color="reserve"]'), null, 'no fabricated gray segment is drawn')
    assert.equal(document.querySelector('.cmv-composition [data-color="free"]'), null, 'no fabricated free segment is drawn')
  } finally { await h.close() }
})

test('trend points locate a historical cut from the keyboard', async () => {
  const data = { ...base, pressureHistory: [{ seq: 1, time: 1000, tokens: 50000, window: 200000, kind: 'reply' }, { seq: 2, time: 2000, tokens: 60000, window: 200000, kind: 'reply' }] }
  const api = { idleStatus: async () => ({ status: 'off', dueAt: null, message: '' }), inspect: async query => ({ ...data, ...query }) }
  const h = harness(api)
  try {
    await h.render('s1'); await h.settle()
    const point = document.querySelector('.cmv-trend-point')
    assert.ok(point)
    point.focus()
    await act(async () => { point.dispatchEvent(new globalThis.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true })) })
    await h.settle()
    assert.ok(document.querySelector('.cmv-notice')?.textContent?.includes('历史截面'))
  } finally { await h.close() }
})
