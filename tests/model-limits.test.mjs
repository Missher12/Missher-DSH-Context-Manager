import { test } from 'node:test'
import assert from 'node:assert/strict'
import { defaults, normalizePolicy, validatePolicy, budget } from '../lib/policy.js'
import Manager from '../lib/index.js'
import { admissionBudget, composition } from '../lib/chart-data.js'

const route = { provider: 'first', model: 'million' }
const policy = { ...defaults, modelLimits: [{ ...route, tokens: 128000 }] }

test('model limit budgets the whole working window while preserving the real capacity', () => {
  const result = budget(policy, 1000000, 8192, route)
  assert.equal(result.window, 1000000)
  assert.equal(result.workingWindow, 128000)
  assert.equal(result.hard, 117248)
  assert.equal(result.admission, 101120)
  assert.equal(result.recentTokens, 12800)
  assert.equal(budget(policy, 1000000, 8192, { provider: 'second', model: 'million' }).admission, 790000)
  assert.equal(budget(policy, 1000000, 8192, { provider: 'first', model: 'other' }).admission, 790000)
  assert.equal(budget(policy, 64000, 8192, route).workingWindow, 64000)
  assert.equal(budget(policy, 1000000, 8192).workingWindow, 1000000)
  assert.equal(budget(policy, 1000000, 256000, route).hard, 0)
})

test('model limits survive the real settings schema and absent legacy values stay unrestricted', () => {
  const saved = Manager.Config({ policy }).policy.get()
  assert.deepEqual(saved.modelLimits, policy.modelLimits)
  assert.equal(budget(saved, 1000000, 8192, route).admission, 101120)
  const legacy = { ...defaults }; delete legacy.modelLimits
  assert.deepEqual(normalizePolicy(legacy).modelLimits, [])
  assert.doesNotThrow(() => validatePolicy(normalizePolicy(legacy)))
})

test('invalid or ambiguous model limits cannot be saved', () => {
  for (const tokens of [0, 9999, 128000.5, NaN, Infinity, 1000000001]) {
    assert.throws(() => validatePolicy({ ...defaults, modelLimits: [{ ...route, tokens }] }), /上下文上限/)
  }
  for (const modelLimits of [[{ ...route, provider: '', tokens: 128000 }], [...policy.modelLimits, ...policy.modelLimits]]) {
    assert.throws(() => validatePolicy({ ...defaults, modelLimits }), /模型/)
  }
})

test('inspector checks the saved limit for the exact current model without changing the chart capacity', () => {
  const data = { historical: false, model: route, admission: { window: 1000000, outputReserve: 8192 } }
  assert.equal(admissionBudget(data, policy).admission, 101120)
  assert.equal(admissionBudget(data, policy).window, 1000000)
  assert.equal(admissionBudget({ ...data, model: { ...route, provider: 'second' } }, policy).admission, 790000)
  assert.equal(admissionBudget({ ...data, historical: true }, policy), null)
})

test('capacity chart clamps a larger saved limit to the real window and keeps unknown reserve unclassified', () => {
  const clamped = composition({ historical: false, model: route, parts: [], pressure: null, pressureHistory: [],
    admission: { tokens: 10000, window: 64000, outputReserve: 8192 }, compression: { mode: 'native' },
    cooperation: { requestPressure: 'context' } }, policy)
  assert.equal(clamped.workingWindow, 64000)
  assert.equal(clamped.modelLimit, 64000)
  assert.equal(clamped.total, 64000)
  assert.equal(clamped.slices.some(slice => slice.id === 'model-capped'), false)

  const unknown = composition({ historical: false, model: route, parts: [], pressure: null, pressureHistory: [],
    admission: { tokens: 60000, window: 1000000, outputReserve: null }, compression: { mode: 'native' },
    cooperation: { requestPressure: 'context' } }, policy)
  assert.equal(unknown.free, null)
  assert.equal(unknown.reserve, null)
  assert.equal(unknown.reserveUnknown, true)
  assert.equal(unknown.total, 1000000)
  assert.equal(unknown.slices.find(slice => slice.id === 'unknown-space')?.value, 68000)
  assert.equal(unknown.slices.find(slice => slice.id === 'model-capped')?.value, 872000)
})
