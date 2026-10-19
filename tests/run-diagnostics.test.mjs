import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createRunDiagnostics } from '../src/run-diagnostics.ts'

const inspection = (patch = {}) => ({
  sessionId: 'private-session-identifier', cursor: 99, cutSeq: 12, sampledAt: 1700000000000, historical: false,
  compression: { mode: 'enhanced', provider: 'private-provider-name', model: 'private-route-name' },
  cooperation: {
    toolResults: { state: 'active', finalResultSeen: true, detail: 'private-sidecar-detail' },
    idleMaintenance: 'waiting', requestPressure: 'context',
  },
  goal: { phase: 'blocked', blockedReason: { code: 'private-goal-code', message: 'private-goal-message' } },
  summaryUsage: { input: 8000, output: 500, attempts: 4, secret: 'private-ledger-data' },
  requests: [{ provider: 'private-request-provider', model: 'private-request-model', input: 9000 }],
  compactions: [{
    kind: 'compact', status: 'failed', trigger: 'pressure', modelCallStatus: 'dispatched', applied: false,
    startedAt: 1700000000100, endedAt: 1700000000450, inputTokens: 12345, outputTokens: 678,
    execution: 'private-execution-id', provider: 'private-entry-provider', message: 'private-entry-message',
  }],
  ...patch,
})

test('diagnostics copies only allowlisted status and per-entry usage, never private text or route data', () => {
  const json = createRunDiagnostics(inspection(), {
    status: 'failed', updatedAt: 1700000000500, restored: false,
    message: 'private-idle-message', error: 'private-error-text', token: 'private-recovery-token',
    freshness: 'stale',
  }, 'stale')
  const answer = JSON.parse(json)

  assert.equal(answer.schema, 'context-manager-run-diagnostics-v1')
  assert.equal(answer.freshness, 'stale')
  assert.equal(answer.compactionMode, 'enhanced')
  assert.deepEqual(answer.cooperation, {
    toolResults: 'active', finalResultSeen: true, idleMaintenance: 'waiting', requestPressure: 'context',
  })
  assert.deepEqual(answer.idle, { status: 'failed', restored: false, updatedAt: 1700000000500, freshness: 'stale' })
  assert.deepEqual(answer.latestCompaction, {
    kind: 'compact', status: 'failed', trigger: 'pressure', modelCallStatus: 'dispatched', applied: false,
    startedAt: 1700000000100, endedAt: 1700000000450, durationMs: 350, inputTokens: 12345, outputTokens: 678,
  })
  for (const privateValue of [
    'private-session-identifier', 'private-provider-name', 'private-route-name', 'private-sidecar-detail',
    'private-goal-code', 'private-goal-message', 'private-ledger-data', 'private-request-provider',
    'private-request-model', 'private-execution-id', 'private-entry-provider', 'private-entry-message',
    'private-idle-message', 'private-error-text', 'private-recovery-token',
  ]) assert.equal(json.includes(privateValue), false, privateValue)
  assert.equal(json.includes('summaryUsage'), false)
  assert.equal(json.includes('sessionId'), false)

  const refreshingIdle = JSON.parse(createRunDiagnostics(inspection(), { status: 'completed', freshness: 'refreshing' }, 'current')).idle
  assert.deepEqual(refreshingIdle, { status: 'completed', restored: null, updatedAt: null, freshness: 'refreshing' })
  const invalidIdle = JSON.parse(createRunDiagnostics(inspection(), { status: 'private-status', restored: 'yes', updatedAt: -1, freshness: 'private-state' }, 'current')).idle
  assert.deepEqual(invalidIdle, { status: null, restored: null, updatedAt: null, freshness: null })
})

test('missing, invalid and historical values stay unknown and history omits live status', () => {
  const answer = JSON.parse(createRunDiagnostics(inspection({
    historical: true,
    sampledAt: Number.POSITIVE_INFINITY,
    compression: { mode: 'private-mode-name' },
    cooperation: undefined,
    compactions: [{
      kind: 'unexpected', status: 'unexpected', trigger: 'unexpected', modelCallStatus: 'unexpected',
      startedAt: 200, endedAt: 100, inputTokens: -1, outputTokens: Number.POSITIVE_INFINITY,
    }],
  }), { status: 'completed', updatedAt: 1700000000500, restored: true, message: 'private-history-message' }, 'refreshing'))

  assert.equal(answer.sampledAt, null)
  assert.equal(answer.historical, true)
  assert.equal(answer.freshness, 'historical')
  assert.equal(answer.compactionMode, null)
  assert.equal(answer.cooperation, null)
  assert.equal(answer.idle, null)
  assert.deepEqual(answer.latestCompaction, {
    kind: null, status: null, trigger: null, modelCallStatus: null, applied: false,
    startedAt: 200, endedAt: 100, durationMs: null, inputTokens: null, outputTokens: null,
  })
  assert.equal(JSON.stringify(answer).includes('private-history-message'), false)
})
