import { test } from 'node:test'
import assert from 'node:assert/strict'
import { compareCheckpointValues, previousAppliedCheckpoint, reviewRetentionEvidence } from '../src/summary-review.ts'

const checkpoint = patch => ({ goal: '继续任务', constraints: [], completed: [], pending: [], evidence: [], next: '继续', uncertainties: [], ...patch })

test('an exact pending-to-completed move is reported as a field move, not a lost fact', () => {
  const result = compareCheckpointValues(
    checkpoint({ pending: ['保留配置 /tmp/project/settings.json'] }),
    checkpoint({ completed: ['保留配置 /tmp/project/settings.json'] }),
  )
  assert.deepEqual(result.moved, [{ text: '保留配置 /tmp/project/settings.json', from: 'pending', to: 'completed' }])
  assert.deepEqual(result.missing, [])
  assert.deepEqual(result.added, [])
})

test('textual evidence reports a possible omission for human review without invalidating the summary', () => {
  const result = reviewRetentionEvidence(checkpoint({ constraints: ['保留 /tmp/project/settings.json'] }), [
    { id: 'event:4', text: '必须保留配置 /tmp/project/settings.json；版本 v1.2.3 已验收。' },
  ])
  assert.equal(result.scanComplete, true)
  assert.equal(result.scope, 'recognized-literal-anchors-only')
  assert.ok(result.items.some(item => item.text.includes('/tmp/project/settings.json') && item.status === 'found'))
  assert.ok(result.items.some(item => item.text.includes('必须保留配置') && item.status === 'review'))
})

test('evidence with no sources stays unavailable and cannot produce a quality score', () => {
  const result = reviewRetentionEvidence(checkpoint({}), [])
  assert.equal(result.scanComplete, false)
  assert.equal(result.items.length, 0)
  assert.equal(Object.hasOwn(result, 'score'), false)
})

test('numeric, version and path anchors require complete token matches', () => {
  const result = reviewRetentionEvidence(checkpoint({ constraints: ['使用 180%、v1.2.30 和 /tmp/a.json.bak'] }), [
    { id: 'event:5', text: '必须保留 80%、v1.2.3 和 /tmp/a.json。' },
  ])
  assert.ok(result.items.some(item => item.text === '80%' && item.status === 'review'))
  assert.ok(result.items.some(item => item.text === 'v1.2.3' && item.status === 'review'))
  assert.ok(result.items.some(item => item.text === '/tmp/a.json' && item.status === 'review'))
})

test('quoted local paths with spaces and CJK are recognized as limited literal evidence', () => {
  const path = '/Users/missher/项目 文件/settings.json'
  const result = reviewRetentionEvidence(checkpoint({ constraints: [`保留 ${path}`] }), [
    { id: 'event:6', text: `请保留配置路径为 \`${path}\`。` },
  ])
  assert.ok(result.items.some(item => item.text === path && item.status === 'found'))
  assert.equal(result.scope, 'recognized-literal-anchors-only')
})

test('numeric and version anchors match when directly adjacent to Chinese text', () => {
  const result = reviewRetentionEvidence(checkpoint({ constraints: ['保留80%阈值，版本v1.2.3已验收。'] }), [
    { id: 'event:7', text: '设置中保留80%阈值，版本v1.2.3已验收。' },
  ])
  assert.ok(result.items.some(item => item.text === '80%' && item.status === 'found'))
  assert.ok(result.items.some(item => item.text === 'v1.2.3' && item.status === 'found'))
})

test('a signed percentage does not match an unsigned summary anchor', () => {
  const result = reviewRetentionEvidence(checkpoint({ constraints: ['保留80%阈值。'] }), [
    { id: 'event:8', text: '该配置使用-80%阈值。' },
  ])
  assert.ok(result.items.some(item => item.text === '-80%' && item.status === 'review'))
})

test('the prior comparison checkpoint is the nearest earlier applied summary only', () => {
  const entries = [
    { id: 'old', kind: 'compact', applied: true, checkpointSeq: 3 },
    { id: 'failed', kind: 'compact', applied: false, checkpointSeq: 8 },
    { id: 'prune', kind: 'prune', applied: true, checkpointSeq: 9 },
    { id: 'previous', kind: 'compact', applied: true, checkpointSeq: 12 },
    { id: 'current', kind: 'compact', applied: true, checkpointSeq: 20 },
  ]
  assert.equal(previousAppliedCheckpoint(entries, 20)?.id, 'previous')
  assert.equal(previousAppliedCheckpoint(entries, 3), null)
})
