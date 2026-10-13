/**
 * Settings-schema round trip for the checkpoint protocol choice: JSON stays
 * the default, legacy saved policies without the field normalize to JSON
 * without destructive migration, and the opt-in sections value survives the
 * real policy normalization/validation boundary.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { defaults, normalizePolicy, validatePolicy } from '../lib/policy.js'

test('checkpoint format: JSON is the default and legacy policies do not migrate', () => {
  assert.equal(defaults.checkpointFormat, 'json')
  const legacy = { ...defaults }
  delete legacy.checkpointFormat
  assert.equal(normalizePolicy(legacy).checkpointFormat, 'json')
  assert.doesNotThrow(() => validatePolicy(normalizePolicy(legacy)))
})

test('checkpoint format: sections survives normalize/validate round-trip and invalid values are rejected', () => {
  const optedIn = normalizePolicy({ ...defaults, checkpointFormat: 'sections' })
  assert.equal(optedIn.checkpointFormat, 'sections')
  assert.doesNotThrow(() => validatePolicy(optedIn))
  assert.throws(() => validatePolicy({ ...defaults, checkpointFormat: 'markdown' }), /checkpoint 协议/)
})
