import { test } from 'node:test'
import assert from 'node:assert/strict'
import { validateAuditReport } from '../scripts/check-archive-platform.mjs'

const valid = () => ({ summary: { pass: 3, fail: 0 },
  results: ['flush', 'corrupt', 'quota'].map(name => ({ name, status: 'pass', observed: { injected: 1 } })) })

test('accepts three executed manifest faults', () => assert.doesNotThrow(() => validateAuditReport(valid())))
test('rejects a passing quota case whose fault never ran', () => {
  const report = valid(); report.results[2].observed.injected = 0
  assert.throws(() => validateAuditReport(report), /did not execute/u)
})
test('rejects missing fault evidence', () => {
  const report = valid(); delete report.results[0].observed
  assert.throws(() => validateAuditReport(report), /did not execute/u)
})
test('rejects partial, failed and duplicate cases', () => {
  for (const alter of [r => r.results.pop(), r => r.summary.fail++, r => r.results[2].name = r.results[0].name]) {
    const report = valid(); alter(report); assert.throws(() => validateAuditReport(report))
  }
})
