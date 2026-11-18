import { test } from 'node:test'
import assert from 'node:assert/strict'
import { budget, normalizePolicy, validatePolicy } from '../lib/policy.js'
import Manager from '../lib/index.js'

test('a legacy config can open with retired limits and keeps its active compression settings', () => {
  const config = Manager.Config({ policy: {
    modelLimits: [{ provider: 'fixture', model: 'old', tokens: 128000 }],
    triggerPercent: 80, idleMinutes: 15, recentTokens: 12345, timeoutMs: 74000,
  } })
  const effective = normalizePolicy(config.policy.get())
  validatePolicy(effective)
  assert.equal(Object.hasOwn(effective, 'modelLimits'), false)
  assert.equal(effective.idleMinutes, 15)
  assert.equal(effective.recentTokens, 12345)
  assert.equal(effective.capacityMode, 'legacy')
  assert.equal(effective.summaryTimeoutMode, 'fixed')
  assert.equal(effective.timeoutMs, 74000)
  assert.equal(budget(effective, 1000000, 8192).admission, 790000)
  const obsoleteInput = { ...effective, modelLimits: { discarded: true } }
  assert.doesNotThrow(() => validatePolicy(normalizePolicy(Manager.Config({ policy: obsoleteInput }).policy.get())))
})
