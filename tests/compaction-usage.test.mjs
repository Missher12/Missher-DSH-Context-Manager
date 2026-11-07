import { test } from 'node:test'
import assert from 'node:assert/strict'
import { compactionRequestRange, postCheckpointRequestRange } from '../src/compaction-usage.ts'

const entry = (id, startSeq, checkpointSeq, kind = 'compact') => ({ id, kind, startSeq, checkpointSeq })
const request = seq => ({ seq, time: seq, turn: 1, step: 1, settledBy: 'message', routeKnown: true, retry: 0, provider: 'deepseek-official', model: 'deepseek-flash', uncachedInput: 10, cacheRead: 0, cacheWrite: 0, output: 2, maintenanceSuspect: false })

test('post-checkpoint range excludes the checkpoint and stops at the next compaction', () => {
  const range = postCheckpointRequestRange([entry('a', 4, 12), entry('b', 26, undefined)], 'a', 40, [request(12), request(13), request(20), request(26), request(30)])
  assert.deepEqual(range.rows.map(row => row.seq), [13, 20])
  assert.equal(range.startSeq, 13)
  assert.equal(range.endSeq, 26)
  assert.equal(range.boundaryKnown, true)
})

test('post-checkpoint range reports truncation and unknown next boundaries', () => {
  const requests = Array.from({ length: 200 }, (_, index) => request(index + 100))
  const range = postCheckpointRequestRange([entry('a', 4, 20), entry('b', undefined, undefined)], 'a', 400, requests)
  assert.equal(range.boundaryKnown, false)
  assert.equal(range.truncated, true)
  assert.equal(range.rows.length, 0)
})

test('checkpoint without a sequence cannot define a request range', () => {
  assert.equal(postCheckpointRequestRange([entry('a', 4, undefined)], 'a', 40, [request(10)]), null)
})

test('compression request rows are bounded by that compression start and checkpoint', () => {
  const range = compactionRequestRange([entry('a', 4, 12), entry('b', 26, undefined)], 'a', [request(4), request(5), request(10), request(12), request(13)])
  assert.deepEqual(range.rows.map(row => row.seq), [5, 10, 12])
  assert.equal(range.startSeq, 5)
  assert.equal(range.endSeq, 12)
})
