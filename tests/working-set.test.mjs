import { test } from 'node:test'
import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'

// Root lib can remain bound to an installed version: exercise this pure helper in memory.
const compiled = await build({
  entryPoints: [fileURLToPath(new URL('../src/working-set.ts', import.meta.url))],
  bundle: true, write: false, platform: 'node', format: 'esm', target: 'es2022',
  tsconfigRaw: { compilerOptions: { target: 'ES2022' } },
})
const { planWorkingSet, validateWorkingCandidate } = await import(
  `data:text/javascript;base64,${Buffer.from(compiled.outputFiles[0].text).toString('base64')}`,
)

const node = (seq, tokens, extra = {}) => ({ seq, tokens, protected: false,
  balancedBefore: true, balancedAfter: true, ...extra })
const limits = (total, extra = {}) => ({ total, admission: 180000, hard: 190000,
  recentTokens: 20000, summaryTokens: 8000, ...extra })
const selected = (nodes, plan) => {
  assert.ok(plan)
  return nodes.slice(nodes.findIndex(n => n.seq === plan.start), nodes.findIndex(n => n.seq === plan.end) + 1)
}
function assertSafe(nodes, plan) {
  const span = selected(nodes, plan)
  assert.equal(span[0].balancedBefore, true)
  assert.equal(span.at(-1).balancedAfter, true)
  assert.ok(span.every(n => !n.protected))
  assert.equal(plan.tokens, span.reduce((sum, n) => sum + n.tokens, 0))
  assert.ok(plan.estimatedAfter <= plan.upper)
  assert.equal(validateWorkingCandidate(plan, plan.summaryTokens + 128), plan.estimatedAfter)
}

test('working set: keep the preferred recent groups when the first plan already fits', () => {
  // Rewritten checkpoints can have larger sequence numbers at earlier surface positions.
  const nodes = [node(900, 100000), node(5, 12000), node(6, 1000, { protected: true })]
  const plan = planWorkingSet(nodes, limits(113000))
  assertSafe(nodes, plan)
  assert.equal(plan.start, 900)
  assert.equal(plan.end, 900)
  assert.equal(plan.retainedTokens, 12000, 'protected request is not also counted as recent history')
  assert.equal(plan.remaining, 13000)
  assert.equal(plan.summaryTokens, 8000)
  assert.ok(plan.estimatedAfter < 30000, 'an admission ceiling does not fill the working set')
})

test('working set: reviewed 30K/20K counterexample shrinks the recency preference', () => {
  const nodes = [node(1, 10000), node(2, 18000), node(3, 2000, { protected: true })]
  const plan = planWorkingSet(nodes, limits(30000, { admission: 20000, hard: 24000 }))
  assertSafe(nodes, plan)
  assert.equal(plan.start, 1)
  assert.equal(plan.end, 2)
  assert.equal(plan.remaining, 2000)
  assert.equal(plan.retainedTokens, 0)
  assert.equal(plan.estimatedAfter, 10128)
})

test('working set: a small window can lower the tail and summary budget together', () => {
  const nodes = [node(1, 2000), node(2, 8000), node(3, 2000, { protected: true })]
  const plan = planWorkingSet(nodes, limits(12000, { admission: 6000, hard: 8000, recentTokens: 8000 }))
  assertSafe(nodes, plan)
  assert.equal(plan.end, 2)
  assert.equal(plan.remaining, 2000)
  assert.equal(plan.summaryTokens, 3871)
  assert.equal(plan.estimatedAfter, 5999)
})

test('working set: a huge final completed tool group is eligible whole', () => {
  const nodes = [node(1, 8000), node(2, 2000, { protected: true }),
    node(3, 1000, { balancedAfter: false }), node(4, 60000, { balancedBefore: false })]
  const plan = planWorkingSet(nodes, limits(71000, { admission: 65000, hard: 70000 }))
  assertSafe(nodes, plan)
  assert.equal(plan.start, 3)
  assert.equal(plan.end, 4)
  assert.equal(plan.tokens, 61000)
  assert.equal(plan.retainedTokens, 0)
})

test('working set: the recent boundary never separates a tool call from its results', () => {
  const nodes = [node(1, 50000), node(2, 1000, { balancedAfter: false }),
    node(3, 2000, { balancedBefore: false, balancedAfter: false }),
    node(4, 9000, { balancedBefore: false }), node(5, 1000, { protected: true })]
  const plan = planWorkingSet(nodes, limits(63000, { recentTokens: 10000 }))
  assertSafe(nodes, plan)
  assert.equal(plan.start, 1)
  assert.equal(plan.end, 4, '12K group cannot be partly retained inside a 10K preference')
  assert.equal(plan.tokens, 62000)
})

test('working set: a protected member preserves its whole group and does not count as T', () => {
  const nodes = [node(1, 10000), node(2, 500, { balancedAfter: false }),
    node(3, 1500, { protected: true, balancedBefore: false })]
  const plan = planWorkingSet(nodes, limits(12000, { recentTokens: 1000 }))
  assertSafe(nodes, plan)
  assert.equal(plan.start, 1)
  assert.equal(plan.end, 1)
  assert.equal(plan.remaining, 2000)
  assert.equal(plan.retainedTokens, 0)
})

test('working set: an unfinished or orphaned pair is never selected', () => {
  const pending = [node(1, 10000), node(2, 2000, { balancedAfter: false }),
    node(3, 4000, { balancedBefore: false, balancedAfter: false })]
  const plan = planWorkingSet(pending, limits(16000, { recentTokens: 0 }))
  assertSafe(pending, plan)
  assert.equal(plan.end, 1)
  assert.equal(plan.remaining, 6000)
  const orphan = [node(1, 5000, { balancedBefore: false }), node(2, 12000)]
  const orphanPlan = planWorkingSet(orphan, limits(17000, { recentTokens: 0 }))
  assertSafe(orphan, orphanPlan)
  assert.equal(orphanPlan.start, 2)
})

test('working set: protection barriers remain in place; select one complete span', () => {
  const nodes = [node(1, 18000), node(2, 2000, { protected: true }), node(3, 30000),
    node(4, 1000, { protected: true })]
  const plan = planWorkingSet(nodes, limits(51000, { recentTokens: 0 }))
  assertSafe(nodes, plan)
  assert.equal(plan.start, 3)
  assert.equal(plan.end, 3)
  assert.equal(plan.remaining, 21000, 'unselected history and protected facts remain counted')
})

test('working set: an actual protected floor above the envelope declines every tail preference', () => {
  const nodes = [node(1, 8000), node(2, 22000, { protected: true })]
  assert.equal(planWorkingSet(nodes, limits(30000, { admission: 20000, hard: 24000 })), undefined)
  assert.equal(planWorkingSet(nodes, limits(30000, { admission: 20000, hard: 24000, overflow: true })), undefined)
  assert.equal(planWorkingSet([node(1, 10000, { protected: true })], limits(10000)), undefined)
})

test('working set: a custom upper bound can reduce T but never erase protected facts', () => {
  const nodes = [node(1, 70000), node(2, 20000), node(3, 1000, { protected: true })]
  const plan = planWorkingSet(nodes, limits(91000, { target: 18000 }))
  assertSafe(nodes, plan)
  assert.equal(plan.end, 2)
  assert.equal(plan.upper, 18000)
  assert.equal(plan.retainedTokens, 0)
  assert.equal(planWorkingSet(nodes, limits(91000, { target: 500 })), undefined)
})

test('working set: low-yield candidates do not spend another summary call', () => {
  const nodes = [node(1, 1000), node(2, 100000, { protected: true })]
  assert.equal(planWorkingSet(nodes, limits(101000, { recentTokens: 0 })), undefined)
  assert.equal(planWorkingSet([node(1, 400)], limits(400, { recentTokens: 0 })), undefined)
})

test('working set: confirmed overflow removes T for the deepest eligible reduction', () => {
  const nodes = [node(1, 20000), node(2, 10000), node(3, 2000, { protected: true })]
  const ordinary = planWorkingSet(nodes, limits(32000, { admission: 60000, hard: 64000 }))
  const overflow = planWorkingSet(nodes, limits(32000, { admission: 60000, hard: 64000, overflow: true }))
  assertSafe(nodes, ordinary)
  assertSafe(nodes, overflow)
  assert.equal(ordinary.end, 1)
  assert.equal(ordinary.retainedTokens, 10000)
  assert.equal(overflow.end, 2)
  assert.equal(overflow.retainedTokens, 0)
  assert.ok(overflow.estimatedAfter < ordinary.estimatedAfter)
  assert.equal(overflow.upper, ordinary.upper, 'do not invent another model capacity percentage')
})

test('working set: actual framed output must satisfy both occupancy and net gain', () => {
  const nodes = [node(1, 10000), node(2, 1000, { protected: true })]
  const plan = planWorkingSet(nodes, limits(11000, { recentTokens: 0, admission: 9000 }))
  assertSafe(nodes, plan)
  assert.throws(() => validateWorkingCandidate(plan, plan.upper - plan.remaining + 1), /超过有效上限/)
  const loosePlan = planWorkingSet(nodes, limits(11000, { recentTokens: 0 }))
  assert.throws(() => validateWorkingCandidate(loosePlan, loosePlan.tokens - 64), /收益不足/)
  for (const invalid of [-1, NaN, Infinity]) {
    assert.throws(() => validateWorkingCandidate(plan, invalid), /超过有效上限/)
  }
})

test('working set: unknown/invalid measurements do not create a payable plan or mutate inputs', () => {
  const nodes = Object.freeze([Object.freeze(node(1, 10000)), Object.freeze(node(2, 2000, { protected: true }))])
  const input = Object.freeze(limits(12000, { recentTokens: 0 }))
  assertSafe(nodes, planWorkingSet(nodes, input))
  for (const key of ['total', 'admission', 'hard', 'recentTokens', 'summaryTokens', 'target']) {
    for (const value of [NaN, Infinity, -1]) assert.equal(planWorkingSet(nodes, { ...input, [key]: value }), undefined)
  }
  assert.equal(planWorkingSet([node(1, NaN)], input), undefined)
  assert.equal(planWorkingSet([node(1, -1)], input), undefined)
  assert.equal(planWorkingSet([], input), undefined)
})
