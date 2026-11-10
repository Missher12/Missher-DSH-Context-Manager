import { test } from 'node:test'
import assert from 'node:assert/strict'
import vm from 'node:vm'
import { createRequire } from 'node:module'
import { buildSync } from 'esbuild'
import { JSDOM } from 'jsdom'
import React, { act } from 'react'
import { createRoot } from 'react-dom/client'
import { defaults } from '../lib/policy.js'

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
  const subscribers = new Set()
  let revision = 1
  const pulse = { subscribe: callback => { subscribers.add(callback); return () => subscribers.delete(callback) }, getSnapshot: () => revision }
  const root = createRoot(document.getElementById('root'))
  const settle = () => act(async () => new Promise(resolve => setTimeout(resolve, 240)))
  const render = target => act(async () => root.render(React.createElement(client.ContextInspectorView, { target, form, api, pulse })))
  const close = async () => { await act(async () => root.unmount()); dom.window.close(); delete globalThis.window; delete globalThis.document }
  const tick = () => { revision++; for (const callback of subscribers) callback() }
  return { render, settle, close, tick }
}

test('context capacity shows the current model limit as a dashed marker against the real window', async () => {
  let current = { ...base, admission: { tokens: 60000, logRevision: 6, baseline: 'estimated', window: 1000000, outputReserve: 8192 } }
  const api = { idleStatus: async () => ({ status: 'off', dueAt: null, message: '' }), inspect: async query => ({ ...current, ...query }), content: () => new Promise(() => {}) }
  const h = harness(api, { ...defaults, modelLimits: [{ provider: 'fixture', model: 'offline', tokens: 128000 }] })
  try {
    await h.render('s1'); await h.settle()
    const marker = document.querySelector('[data-model-context-limit="128000"]')
    assert.ok(marker, 'the configured per-model cap is visible on the capacity bar')
    assert.equal(marker.style.left, '12.8%')
    assert.match(document.querySelector('.cmv-model-limit-caption').textContent, /模型上下文上限.*128K/)
    const capped = document.querySelector('.cmv-capacity-stack [data-color="model-capped"]')
    assert.match(capped.getAttribute('aria-label'), /模型上限外/)
    assert.equal(document.querySelector('.cmv-capacity-stack [data-color="reserve"]').getAttribute('aria-label').includes('模型上限外'), false)
    assert.equal(document.querySelector('.cmv-capacity-stack').dataset.capacity, '1000000')
    current = { ...current, model: { ...current.model, provider: 'other' } }
    await act(async () => h.tick()); await h.settle()
    assert.equal(document.querySelector('[data-model-context-limit]'), null, 'another provider does not inherit the limit')
    current = { ...current, model: { provider: 'fixture', model: 'offline', maxTokens: null, effort: null },
      admission: { ...current.admission, tokens: 10000, window: 64000 } }
    await act(async () => h.tick()); await h.settle()
    const clamped = document.querySelector('[data-model-context-limit="64000"]')
    assert.equal(clamped.style.left, '100%')
    assert.equal(document.querySelector('.cmv-capacity-stack [data-color="model-capped"]'), null)
    assert.equal(document.querySelector('.cmv-capacity-stack').dataset.total, '64000')
    current = { ...current, admission: { ...current.admission, tokens: 60000, window: 1000000, outputReserve: null } }
    await act(async () => h.tick()); await h.settle()
    assert.equal(document.querySelector('.cmv-capacity-readout [data-slice="free"]').dataset.value, 'unknown')
    assert.equal(document.querySelector('.cmv-capacity-readout [data-slice="reserve"]').dataset.value, 'unknown')
    assert.match(document.querySelector('.cmv-capacity-stack [data-color="unknown-space"]').getAttribute('aria-label'), /预留未知/)
    assert.equal(document.querySelector('.cmv-capacity-stack').dataset.total, '1000000')
    current = { ...current, historical: true }
    await act(async () => h.tick()); await h.settle()
    assert.equal(document.querySelector('[data-model-context-limit]'), null, 'a historical cut does not use the current saved cap')
  } finally { await h.close() }
})

test('a cold session keeps the saved model limit label while waiting for a current window', async () => {
  const current = { ...base, model: { provider: 'fixture', model: 'offline', maxTokens: null, effort: null },
    pressure: { projected: 60000, window: 1000000 } }
  const api = { idleStatus: async () => ({ status: 'off', dueAt: null, message: '' }), inspect: async query => ({ ...current, ...query }), content: () => new Promise(() => {}) }
  const h = harness(api, { ...defaults, modelLimits: [{ provider: 'fixture', model: 'offline', tokens: 128000 }] })
  try {
    await h.render('s1'); await h.settle()
    assert.match(document.querySelector('.cmv-model-limit-caption').textContent, /模型上下文上限.*128K.*等待当前窗口/)
    assert.equal(document.querySelector('[data-model-context-limit]'), null, 'a pressure projection cannot place the current cap marker')
    assert.equal(document.querySelector('.cmv-capacity-stack').dataset.capacity, '1000000')
  } finally { await h.close() }
})

test('model context limit marker and caption stay in K units above one million tokens', async () => {
  const current = { ...base, admission: { tokens: 60000, logRevision: 6, baseline: 'estimated', window: 1000000, outputReserve: 8192 } }
  const api = { idleStatus: async () => ({ status: 'off', dueAt: null, message: '' }), inspect: async query => ({ ...current, ...query }), content: () => new Promise(() => {}) }
  const h = harness(api, { ...defaults, modelLimits: [{ provider: 'fixture', model: 'offline', tokens: 2000000 }] })
  try {
    await h.render('s1'); await h.settle()
    const marker = document.querySelector('[data-model-context-limit="1000000"]')
    assert.ok(marker)
    assert.match(marker.getAttribute('aria-label'), /模型上下文上限 · 1[,.]?000K/)
    assert.match(document.querySelector('.cmv-model-limit-caption').textContent, /模型上下文上限.*1[,.]?000K/)
    assert.doesNotMatch(document.querySelector('.cmv-model-limit-caption').textContent, /M|Token/)
  } finally { await h.close() }
})

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

test('a single applied summary can run literal source-anchor review without a previous summary', async () => {
  const source = { id: 'event:1', seq: 1, title: '原始任务说明', category: 'user', current: true, source: 'fixture', tokens: 8, images: 0 }
  const reads = []
  let currentCut = 5
  const api = {
    idleStatus: async () => ({ status: 'off', dueAt: null, message: '' }),
    inspect: async query => ({ ...base, ...query, cutSeq: currentCut, compactions: [applied({ checkpointSeq: 4 })] }),
    content: async query => {
      reads.push(query)
      if (query.id === 'event:1') return { sessionId: 's1', cutSeq: query.cutSeq, id: query.id, text: '请保留配置路径，阈值为 80%。', offset: 0, totalChars: 16, nextOffset: null }
      if (query.sourceOffset !== undefined) return { sessionId: 's1', cutSeq: query.cutSeq, id: 'cp:1', text: checkpointText, offset: 0, totalChars: checkpointText.length, nextOffset: null,
        sources: { rows: [source], offset: 0, total: 1, nextOffset: null } }
      return { sessionId: 's1', cutSeq: query.cutSeq, id: 'cp:1', text: checkpointText, offset: 0, totalChars: checkpointText.length, nextOffset: null }
    },
  }
  const h = harness(api)
  try {
    await h.render('s1'); await h.settle()
    const button = [...document.querySelectorAll('button')].find(item => item.textContent === '核对当前摘要与来源')
    assert.ok(button, 'the current summary has an independent review action')
    await act(async () => button.click())
    await h.settle()
    assert.ok(reads.some(query => query.id === 'event:1'), 'the original source is read on demand')
    assert.ok(document.querySelector('[data-anchor-status="found"]'), 'the literal 80% anchor is visible even without a prior summary')
    assert.doesNotMatch(document.querySelector('.cmv-summary-review-body').textContent, /无法完整解析/)
    const count = reads.length
    currentCut++
    await act(async () => h.tick())
    await h.settle()
    assert.equal(reads.length, count, 'a new cut with the same summary IDs does not rescan the source')
    assert.ok(document.querySelector('[data-anchor-status="found"]'), 'the finished review stays visible across an ordinary pulse')
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

test('long idle failure reasons stay compact while remaining fully keyboard-readable', async () => {
  const message = `失败原因：${'模型路由暂不可用，系统保留当前会话并等待下一次检查；'.repeat(12)}`
  const api = {
    idleStatus: async () => ({ status: 'failed', dueAt: null, message, reasonCode: 'fixture' }),
    inspect: async query => ({ ...base, ...query }),
  }
  const h = harness(api)
  try {
    await h.render('s1'); await h.settle()
    const reason = document.querySelector('.cmv-stat[data-stat="idle"] .cmv-idle-reason')
    assert.ok(reason)
    assert.ok(reason.textContent.length <= 97, 'the card shows a short, bounded reason')
    assert.equal(reason.getAttribute('aria-label'), message, 'keyboard users can read the full reason')
  } finally { await h.close() }
})

test('team usage stays idle until selected and aborts when the view switches back', async () => {
  const reads = []
  const api = {
    idleStatus: async () => ({ status: 'off', dueAt: null, message: '' }),
    inspect: async query => ({ ...base, ...query }),
    teamUsage: (query, signal) => { reads.push({ query, signal }); return new Promise(() => {}) },
  }
  const h = harness(api)
  try {
    await h.render('s1'); await h.settle()
    assert.equal(reads.length, 0, 'the default session view makes no aggregate request')
    const team = [...document.querySelectorAll('button')].find(item => item.textContent === '包含团队')
    assert.ok(team)
    await act(async () => team.click()); await h.settle()
    assert.equal(reads.length, 1)
    assert.equal(reads[0].query.sessionId, 's1')
    const session = [...document.querySelectorAll('button')].find(item => item.textContent === '本会话')
    await act(async () => session.click()); await h.settle()
    assert.equal(reads[0].signal.aborted, true, 'switching modes cancels the outstanding aggregate')
  } finally { await h.close() }
})

test('team phase labels describe readiness and creation outcome without implying active work', async () => {
  const member = (sessionId, name, role, phase) => ({
    sessionId, name, role, phase, status: 'ready', cutSeq: 1, provider: null, model: null,
    requestTokens: 0, requestTokensPartial: false, settledAttempts: 0, retries: 0,
    uncachedInput: null, cacheRead: null, cacheWrite: null, output: null,
    summaryInput: 0, summaryOutput: 0, summaryTokens: 0, summaryCacheRead: 0, summaryCacheWrite: 0,
    summaryAttempts: 0, summaryUnknownAttempts: 0, summarySince: 0, summaryCoverage: 'complete',
    maintenanceSuspects: 0, totalTokens: 0, tokensPartial: false, referenceCost: 0, costPartial: false,
  })
  const result = { targetSessionId: 's1', teamId: 's1', sampledAt: 1, status: 'ready',
    members: [member('s1', 'Lead', 'lead', 'active'), member('s2', 'Starting', 'teammate', 'provisioning'), member('s3', 'Failed', 'teammate', 'failed')],
    knownTokens: 0, unknownMembers: 0, tokensPartial: false, shareBasis: 'complete', referenceCost: 0, costPartial: false }
  const api = { idleStatus: async () => ({ status: 'off', dueAt: null, message: '' }), inspect: async query => ({ ...base, ...query }), teamUsage: async () => result }
  const h = harness(api)
  try {
    await h.render('s1'); await h.settle()
    await act(async () => [...document.querySelectorAll('button')].find(button => button.textContent === '包含团队').click())
    await h.settle()
    const text = document.querySelector('.cmv-team-members').textContent
    assert.match(text, /已就绪/); assert.match(text, /创建中/); assert.match(text, /创建失败/)
    assert.doesNotMatch(text, /进行中|已结束/)
  } finally { await h.close() }
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
