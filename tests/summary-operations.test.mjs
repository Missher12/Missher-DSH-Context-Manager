import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { build } from 'esbuild'
import { Context } from '@deepseek-ai/cordis'
import Storage from '@deepseek-ai/dsh-storage'
import { DomainFacility } from '@deepseek-ai/dsh-storage-domain'
import { JsonStorageBackend } from '@deepseek-ai/dsh-storage-json'
const compiled = await build({ entryPoints: ['src/summary-operations.ts'], bundle: true, write: false,
  platform: 'node', format: 'esm', plugins: [{ name: 'public-api', setup(b) {
    b.onResolve({ filter: /^[^./]/ }, args => ({ path: import.meta.resolve(args.path), external: true }))
  } }] })
const { SummaryOperations } = await import(`data:text/javascript;base64,${Buffer.from(compiled.outputFiles[0].text).toString('base64')}`)
const hash = s => createHash('sha256').update(s).digest('hex')
const origins = new Map()
const input = (name = 'H1', extra = {}) => ({ sessionId: 'subject', requestHash: hash(name), routeHash: hash('route'),
  sourceHash: hash('original'), sourceWatermark: 100, recoveryRouteHash: hash('route-compact'), strategyHash: hash('strategy'), freshTokens: 0, minNewTokens: 10000,
  confirmation:{hash:hash('config'),model:'mock/large',deadline:'600s',estimatedInput:1000}, purpose: 'summary', trigger: 'pressure', compactionId: 'compact-1', legacy: [], unboundManual: false, ...extra })
const changedStrategy = (name = 'H1', extra = {}) => {
  const legacy = extra.legacy?.find(row => row.requestHash === hash(name))
  return input(`${name}-compact`, { routeHash: hash('route-compact'), strategyHash: hash('strategy-compact'),
    recoveryFrom: { ...(legacy ? { legacyCycle: legacy.cycle } : origins.has(hash(name)) ? { operationId: origins.get(hash(name)) } : {}),
      requestHash: hash(name), routeHash: hash('route'), ...(legacy?.strategyHash === undefined ? {} : { strategyHash: legacy.strategyHash }), sourceHash: hash('original'),
      sourceWatermark: 100, recoveryRouteHash: hash('route-compact'),
      ...(legacy ? { riskAcceptedOriginIds: [`legacy:${legacy.cycle}:${legacy.requestHash}`],
        authorizationRequestHash: hash(name), authorizationRouteHash: hash('route') } : {}) }, ...extra })
}
async function harness(t) {
  const root = await mkdtemp(join(tmpdir(), 'context-ops-'))
  let ctx, facility, backend, ops, blockWrite, afterWrite
  const stop = async () => { await ops?.close(); await facility?.closeAll(); await backend?.close(); await ctx?.fiber.dispose() }
  const boot = async () => {
    ctx = new Context(); await ctx.plugin(Storage); backend = new JsonStorageBackend(root)
    ctx.storage.backend.register('json', backend); facility = new DomainFacility(ctx, { backend: 'json' })
    ctx.storage.mount('domain', facility)
    ops = await SummaryOperations.open({ async open(spec) {
      const domain = await facility.open(spec)
      return { table: name => {
        const table = domain.table(name)
        return { get: k => table.get(k), entries: () => table.entries(), put: async (k, v) => {
          await blockWrite?.(name, k, v); await table.put(k, v); await afterWrite?.(name,k,v)
        } }
      }, close: () => domain.close() }
    } })
    return ops
  }
  t.after(async () => { await stop(); await rm(root, { recursive: true, force: true }) })
  return { boot, stop, facility:()=>facility, intercept: fn => { blockWrite = fn }, after: fn => { afterWrite = fn } }
}
async function failed(ops, row) { origins.set(row.requestHash, row.operationId); await ops.settle('subject', row.operationId, 'known_failed_unapplied', { usageComplete: true }) }
async function unknownCostFailed(ops, row) { origins.set(row.requestHash, row.operationId); await ops.settle('subject', row.operationId, 'known_failed_unapplied') }
async function grantCurrent(ops) {
  const status = ops.recoveryStatus('subject')
  assert.equal(status.available, true, status.message)
  assert.ok(status.authorizationToken)
  await ops.grant('subject', status.authorizationToken)
}

test('operations: exact replay is refused; authorized changed strategy then changed hash cannot obtain a third primary', async t => {
  const h = await harness(t); let ops = await h.boot()
  const original = input()
  const one = await ops.claim(original); await failed(ops, one)
  await assert.rejects(ops.claim(original), /改变摘要策略/, 'same requestHash never dispatches, even after a grant')
  await grantCurrent(ops)
  const two = await ops.claim(changedStrategy()); await failed(ops, two)
  assert.equal(two.reissue, true); assert.equal(two.cycle, 1); assert.equal(two.ordinal, 2)
  assert.notEqual(two.requestHash, one.requestHash); assert.notEqual(two.strategyHash, one.strategyHash)
  await assert.rejects(ops.claim(input('H2')), /2 个主摘要/)
  await h.stop(); ops = await h.boot()
  await assert.rejects(ops.claim(input('H3')), /2 个主摘要/)
  assert.equal(ops.records('subject').length, 2)
})
test('operations: an unapplied call with unknown usage still needs explicit recovery', async t => {
  const h = await harness(t); let ops = await h.boot()
  const one = await ops.claim(input()); await unknownCostFailed(ops, one)
  assert.equal(ops.records('subject')[0].phase, 'known_failed_unapplied')
  assert.equal(ops.recoveryStatus('subject').available, true, 'uncommitted but unmeasured cost is not free')
  await assert.rejects(ops.claim(input()), /改变摘要策略/)
  await grantCurrent(ops)
  const two = await ops.claim(changedStrategy())
  assert.equal(two.ordinal, 2); assert.ok(two.authorizationId)
  await h.stop(); ops = await h.boot()
  assert.equal(ops.records('subject').length, 2)
})
test('operations: primary + repair + primary + repair consume exactly four, recovery is primary', async t => {
  const h = await harness(t), ops = await h.boot()
  for (const [name, purpose] of [['a','summary'],['b','repair'],['c','recovery'],['d','repair']]) {
    await failed(ops, await ops.claim(input(name, { purpose })))
  }
  await assert.rejects(ops.claim(input('e', { purpose: 'repair' })), /4 次总调用/)
  assert.deepEqual(ops.records('subject').map(r => r.ordinal), [1,2,3,4])
})
test('operations: unknown blocks same or changed request, route and source; restart never recharges', async t => {
  const h = await harness(t); let ops = await h.boot()
  await ops.claim(input()); await h.stop(); ops = await h.boot()
  await assert.rejects(ops.claim(input()), /未知|改变摘要策略/)
  await assert.rejects(ops.claim(input('H2')), /未知/)
  await assert.rejects(ops.claim(input('H4', { sourceWatermark: 101, sourceHash: hash('large new source'), freshTokens: 100000 })), /跨周期|未知/,
    'fresh source and ample tokens cannot open a cycle around an older unresolved attempt')
  await assert.rejects(ops.claim(input('H1', { routeHash: hash('other') })), /路由/)
  await assert.rejects(ops.claim(input('H1', { sourceHash: hash('changed') })), /来源/)
  assert.equal(ops.records('subject').length, 1)
})

test('operations: committed changed-strategy recovery links one unknown across cycles without erasing its cost record', async t => {
  const h = await harness(t), ops = await h.boot()
  const original = await ops.claim(input())
  origins.set(original.requestHash, original.operationId)
  await ops.settle('subject', original.operationId, 'unknown_interrupted')
  await grantCurrent(ops)
  const recovery = await ops.claim(changedStrategy())
  assert.equal(recovery.recoveryFor, original.operationId)
  await ops.settle('subject', recovery.operationId, 'committed')
  assert.equal(ops.records('subject')[0].phase, 'unknown_interrupted', 'recovery does not rewrite the original uncertain outcome')
  assert.equal(ops.records('subject')[1].recoveryFor, original.operationId)
  const nextCycle = await ops.claim(input('H2', { sourceWatermark: 101, sourceHash: hash('next source'), freshTokens: 10000 }))
  assert.equal(nextCycle.cycle, 2, 'a committed, durably linked recovery resolves only its own operation block')
})
test('operations: a changed source is recoverable only with an exact old-prefix hash and covered plan range', async t => {
  const h = await harness(t), ops = await h.boot()
  const old = input('A', { sourceHash: hash('source-A'), sourceWatermark: 100, sourceStart: 10, sourceEnd: 20 })
  const origin = await ops.claim(old)
  await ops.settle('subject', origin.operationId, 'unknown_interrupted')
  const current = input('A+B', { sourceHash: hash('source-A+B'), sourceWatermark: 200,
    sourceStart: 10, sourceEnd: 30, freshTokens: 20000,
    sourceAncestors: [{ operationId: origin.operationId, sourceHash: old.sourceHash, sourceWatermark: old.sourceWatermark,
      prefixHash: old.sourceHash, currentSourceHash: hash('source-A+B'), currentSourceWatermark: 200,
      sourceStart: old.sourceStart, sourceEnd: old.sourceEnd }] })
  await assert.rejects(ops.claim(current), /未知/)
  assert.equal(ops.recoveryStatus('subject').available, true)
  const target = ops.recoveryTarget(current)
  assert.equal(target?.operationId, origin.operationId)
  await grantCurrent(ops)
  const recovery = { ...current, requestHash: hash('A+B-compact'), routeHash: hash('route-compact'),
    strategyHash: hash('strategy-compact'), purpose: 'recovery', compactionId: 'compact-recovery', recoveryFrom: target }
  const row = await ops.claim(recovery)
  assert.equal(row.recoveryFor, origin.operationId)
  await ops.settle('subject', row.operationId, 'committed')
  assert.equal(ops.recoveryStatus('subject').available, false, 'committed association resolves the exact old risk')
})
test('operations: changed-source and legacy recovery fail closed without verifiable ancestry', async t => {
  const h = await harness(t), ops = await h.boot()
  const old = input('A', { sourceHash: hash('source-A'), sourceWatermark: 100, sourceStart: 10, sourceEnd: 20 })
  const origin = await ops.claim(old)
  await ops.settle('subject', origin.operationId, 'unknown_interrupted')
  const current = input('A+B', { sourceHash: hash('source-A+B'), sourceWatermark: 200,
    sourceStart: 11, sourceEnd: 30, freshTokens: 20000,
    sourceAncestors: [{ operationId: origin.operationId, sourceHash: old.sourceHash, sourceWatermark: 100,
      prefixHash: hash('wrong-prefix'), currentSourceHash: hash('source-A+B'), currentSourceWatermark: 200,
      sourceStart: 10, sourceEnd: 20 }] })
  await assert.rejects(ops.claim(current), /未知/)
  assert.equal(ops.recoveryStatus('subject').available, true, 'an incomplete range needs visible, explicit risk acceptance')
  assert.equal(ops.recoveryStatus('subject').riskAcceptanceRequired, true)

  const legacy = [{ sessionId: 'subject', requestHash: hash('legacy-A'), sourceWatermark: 100, freshTokens: 0,
    minNewTokens: 10000, purpose: 'summary', cycle: 1, ordinal: 1, claimedAt: 1 }]
  const fresh = input('legacy-A+B', { legacy, sourceHash: hash('legacy-A+B'), sourceWatermark: 200,
    sourceStart: 10, sourceEnd: 30, freshTokens: 20000 })
  const target = ops.recoveryTarget(fresh)
  assert.ok(target?.riskAcceptedOriginIds?.includes(`legacy:1:${hash('legacy-A')}`),
    'legacy rows without source hashes require explicit risk acceptance rather than a guessed lineage')
})
test('operations: legacy history is never marked successful by a risk-accepted current recovery', async t => {
  const h = await harness(t), ops = await h.boot()
  const legacy = [{ sessionId: 'subject', requestHash: hash('legacy-A'), sourceWatermark: 100, freshTokens: 0,
    minNewTokens: 10000, purpose: 'summary', cycle: 1, ordinal: 1, claimedAt: 1 }]
  const current = input('legacy-A+B', { legacy, sourceHash: hash('legacy-A+B'), sourceWatermark: 200,
    sourceStart: 10, sourceEnd: 30, freshTokens: 20000 })
  await assert.rejects(ops.claim(current), /未知/)
  const status = ops.recoveryStatus('subject', legacy)
  assert.equal(status.available, true)
  assert.equal(status.riskAcceptanceRequired, true)
  assert.match(status.message, /接受其费用未知/u)
  assert.equal(ops.records('subject').length, 0, 'status and read-only review do not create a paid permit')
  const target = ops.recoveryTarget(current)
  await grantCurrent(ops)
  const recovery = { ...current, requestHash: hash('legacy-A+B-compact'), routeHash: hash('route-compact'),
    strategyHash: hash('strategy-compact'), purpose: 'recovery', compactionId: 'compact-legacy-risk', recoveryFrom: target }
  const row = await ops.claim(recovery)
  assert.deepEqual(row.riskAcceptedOriginIds, [`legacy:1:${hash('legacy-A')}`])
  assert.equal(row.recoveryFor, undefined, 'risk acceptance is not recorded as a successful old call')
  assert.deepEqual(ops.allRecords('subject').filter(record => record.operationId === row.operationId)[0].riskAcceptedOriginIds,
    [`legacy:1:${hash('legacy-A')}`])
  await ops.settle('subject', row.operationId, 'committed')
  assert.equal(ops.records('subject')[0].phase, 'committed')
  assert.equal(ops.recoveryStatus('subject', legacy).available, false, 'accepted legacy risk stays acknowledged without rewriting the old ledger')
})
test('operations: a not-dispatched risk-accepted recovery cannot waive legacy unknowns across source or route after restart', async t => {
  const h = await harness(t); let ops = await h.boot()
  const legacy = [{ sessionId: 'subject', requestHash: hash('old'), sourceWatermark: 100,
    freshTokens: 1000, minNewTokens: 1000, purpose: 'summary', cycle: 1, ordinal: 1, claimedAt: 1 }]
  const current = input('current', { legacy, sourceHash: hash('A+B'), sourceWatermark: 200,
    sourceStart: 20, sourceEnd: 200, freshTokens: 20000 })
  await assert.rejects(ops.claim(current), /未知/u)
  assert.equal(ops.recoveryStatus('subject', legacy).available, true)
  const target = ops.recoveryTarget(current)
  assert.ok(target?.riskAcceptedOriginIds?.includes(`legacy:1:${hash('old')}`))
  await grantCurrent(ops)
  const row = await ops.claim({ ...current, requestHash: hash('current-compact'),
    routeHash: hash('route-compact'), strategyHash: hash('strategy-compact'), purpose: 'recovery',
    compactionId: 'compact-recovery', recoveryFrom: target })
  await ops.settle('subject', row.operationId, 'not_dispatched')
  await h.stop(); ops = await h.boot()
  await assert.rejects(ops.claim(input('unrelated-new', { legacy, sourceHash: hash('A+B+C'), sourceWatermark: 300,
    sourceStart: 21, sourceEnd: 300, freshTokens: 20000, routeHash: hash('another-route') })), /未知/u)
  assert.deepEqual(ops.records('subject').map(record => record.phase), ['not_dispatched'])
})
test('operations: a not-dispatched risk acceptance is not durable and a fresh explicit recovery can be claimed after restart', async t => {
  const h = await harness(t); let ops = await h.boot()
  const legacy = [{ sessionId: 'subject', requestHash: hash('old'), sourceWatermark: 100,
    freshTokens: 1000, minNewTokens: 1000, purpose: 'summary', cycle: 1, ordinal: 1, claimedAt: 1 }]
  const current = input('current', { legacy, sourceHash: hash('A+B'), sourceWatermark: 200,
    sourceStart: 20, sourceEnd: 200, freshTokens: 20000 })
  await assert.rejects(ops.claim(current), /未知/u)
  const firstStatus = ops.recoveryStatus('subject', legacy)
  assert.equal(firstStatus.available, true)
  assert.equal(firstStatus.riskAcceptanceRequired, true)
  await ops.grant('subject', firstStatus.authorizationToken)

  const first = await ops.claim({ ...current, requestHash: hash('recovery-1'), routeHash: hash('route-compact'),
    strategyHash: hash('strategy-1'), purpose: 'recovery', compactionId: 'compact-recovery-1',
    recoveryFrom: ops.recoveryTarget(current) })
  await ops.settle('subject', first.operationId, 'not_dispatched')
  await h.stop(); ops = await h.boot()

  await assert.rejects(ops.claim(current), /未知/u, 'restart never converts the not-dispatched permit into a free retry')
  const retryStatus = ops.recoveryStatus('subject', legacy)
  assert.equal(retryStatus.available, true)
  assert.equal(retryStatus.riskAcceptanceRequired, true)
  assert.ok(retryStatus.authorizationToken)
  await ops.grant('subject', retryStatus.authorizationToken)

  const retry = await ops.claim({ ...current, requestHash: hash('recovery-2'), routeHash: hash('route-compact'),
    strategyHash: hash('strategy-2'), purpose: 'recovery', compactionId: 'compact-recovery-2',
    recoveryFrom: ops.recoveryTarget(current) })
  assert.equal(retry.phase, 'recorded')
  assert.deepEqual(retry.riskAcceptedOriginIds, [`legacy:1:${hash('old')}`])
  await ops.settle('subject', retry.operationId, 'committed')
  assert.equal(ops.recoveryStatus('subject', legacy).available, false,
    'only the committed recovery durably records risk acceptance')
})
test('operations: one explicit recovery can migrate a bounded group of 33 legacy risks without repeat paid summaries', async t => {
  const h = await harness(t), ops = await h.boot()
  const legacy = Array.from({ length: 33 }, (_, i) => ({ sessionId: 'subject', requestHash: hash(`old-${i}`),
    sourceWatermark: (i + 1) * 100, freshTokens: 20000, minNewTokens: 1000,
    purpose: 'summary', cycle: i + 1, ordinal: 1, claimedAt: i + 1 }))
  const current = input('latest', { legacy, sourceHash: hash('latest-source'), sourceWatermark: 3400,
    sourceStart: 20, sourceEnd: 3400, freshTokens: 20000 })
  await assert.rejects(ops.claim(current), /未知/u)
  const status = ops.recoveryStatus('subject', legacy)
  assert.equal(status.available, true)
  assert.equal(status.originCount, 33)
  const target = ops.recoveryTarget(current)
  assert.equal(target?.riskAcceptedOriginIds?.length, 33)
  await grantCurrent(ops)
  const recovery = await ops.claim({ ...current, requestHash: hash('latest-compact'),
    routeHash: hash('route-compact'), strategyHash: hash('strategy-compact'), purpose: 'recovery',
    compactionId: 'compact-legacy-group', recoveryFrom: target })
  assert.equal(recovery.riskAcceptedOriginIds?.length, 33)
  await ops.settle('subject', recovery.operationId, 'committed')
  assert.equal(ops.records('subject').length, 1, 'the bounded migration uses one paid recovery call')
  assert.equal(ops.recoveryStatus('subject', legacy).available, false)
})
test('operations: explicit grant is read-only until mutation, then one atomic permit consumes it under concurrency and restart', async t => {
  const h = await harness(t); let ops = await h.boot()
  const original = await ops.claim(input()); origins.set(original.requestHash, original.operationId); await assert.rejects(ops.claim(input()), /改变摘要策略/)
  for (let n=0;n<3;n++) assert.equal(ops.recoveryStatus('subject').available, true)
  await grantCurrent(ops)
  const results = await Promise.allSettled([ops.claim(changedStrategy()),ops.claim(changedStrategy())])
  assert.equal(results.filter(r=>r.status==='fulfilled').length,1)
  const receipt = results.find(r=>r.status==='fulfilled').value
  assert.ok(receipt.authorizationId); assert.equal(receipt.ordinal,2)
  await h.stop(); ops = await h.boot()
  await assert.rejects(ops.claim(changedStrategy()), /上限/)
  assert.equal(ops.records('subject').length,2)
})
test('operations: grant source and route are exact, expiry checked at serialized consumption', async t => {
  const h = await harness(t), ops = await h.boot()
  const original = await ops.claim(input()); origins.set(original.requestHash, original.operationId); await assert.rejects(ops.claim(input())); await grantCurrent(ops)
  await assert.rejects(ops.claim(changedStrategy('H1',{sourceWatermark:101})),/来源/)
  await assert.rejects(ops.claim(changedStrategy('H1',{routeHash:hash('new')})),/路由/)
  const now = Date.now; Date.now = () => now()+120001
  try { await assert.rejects(ops.claim(changedStrategy()), /未知/) } finally { Date.now=now }
  assert.equal(ops.records('subject').length,1)
})
test('operations: v1 unknown is counted once; explicit permit starts ordinal 2; third primary denied', async t => {
  const h = await harness(t), ops = await h.boot()
  const legacy = [{ sessionId:'subject', requestHash:hash('H1'), sourceWatermark:100, freshTokens:0,
    minNewTokens:10000, purpose:'summary', cycle:1, ordinal:1, claimedAt:1 }]
  await assert.rejects(ops.claim(input('H1',{legacy,sourceStart:10,sourceEnd:100})),/未知/)
  await grantCurrent(ops)
  const row = await ops.claim(changedStrategy('H1',{legacy,sourceStart:10,sourceEnd:100}))
  assert.equal(row.ordinal,2); assert.equal(ops.records('subject').length,1)
  await assert.rejects(ops.claim(input('H2',{legacy,sourceStart:10,sourceEnd:100})),/上限/)
})
test('operations: unbound old manual attempts deny recovery instead of inventing remaining budget', async t => {
  const h = await harness(t), ops = await h.boot(), legacy = [{ sessionId:'subject', requestHash:hash('H1'), sourceWatermark:100,
    freshTokens:0, minNewTokens:10000, purpose:'summary', cycle:1, ordinal:1, claimedAt:1 }]
  await assert.rejects(ops.claim(input('H1',{legacy,unboundManual:true})),/核验/)
  assert.equal(ops.recoveryStatus('subject').available,false)
  await assert.rejects(ops.grant('subject',hash('H1')))
})
test('operations: bind validates session and immutable attempt identity, terminal never revives', async t => {
  const h = await harness(t), ops = await h.boot(), row = await ops.claim(input())
  await assert.rejects(ops.bind('other',row.operationId,{attemptId:'a'}),/身份/)
  await ops.bind('subject',row.operationId,{attemptId:'a'})
  await assert.rejects(ops.bind('subject',row.operationId,{attemptId:'b'}),/覆盖/)
  await assert.rejects(ops.bind('subject',row.operationId,{compactionId:'b'}),/覆盖/)
  await ops.settle('subject',row.operationId,'unknown_interrupted')
  await ops.settle('subject',row.operationId,'committed')
  assert.equal(ops.records('subject')[0].phase,'unknown_interrupted')
})
test('operations: failed durable write poisons dispatcher until reopen, never speculates a permit', async t => {
  const h = await harness(t), ops = await h.boot()
  h.intercept(()=>{throw new Error('disk unavailable')})
  await assert.rejects(ops.claim(input()),/disk/)
  h.intercept(undefined)
  await assert.rejects(ops.claim(input('H2')),/持久写入结果未知/)
  assert.equal(ops.records('subject').length,0)
})
test('operations: a settled failure keeps its requestHash blocked until an explicit grant', async t => {
  const h = await harness(t); let ops = await h.boot()
  const one = await ops.claim(input()); await failed(ops, one)
  assert.equal(ops.recoveryStatus('subject').available, true)
  await assert.rejects(ops.claim(input()), /恢复|未知|授权/)
  assert.equal(ops.records('subject').length, 1, 'the blocked attempt does not consume a second permit')
  await grantCurrent(ops)
  const two = await ops.claim(changedStrategy())
  assert.ok(two.authorizationId); assert.equal(two.reissue, true); assert.equal(two.ordinal, 2)
  await failed(ops, two)
  await assert.rejects(ops.claim(changedStrategy()), /恢复过一次|上限/, 'the changed strategy is authorized at most once')
  await h.stop(); ops = await h.boot()
  assert.equal(ops.records('subject').length, 2)
})

test('operations: a verified different request may replace a known-cost failure without grant', async t => {
  const h = await harness(t), ops = await h.boot()
  await failed(ops, await ops.claim(input()))
  const next = await ops.claim(input('H2', { sourceWatermark: 101, sourceHash: hash('verified new source'), freshTokens: 10000 }))
  assert.equal(next.cycle, 2); assert.equal(next.ordinal, 1); assert.equal(next.authorizationId, undefined)
})

test('operations: only enough original source growth opens a new cycle; changed hash alone cannot', async t => {
  const h = await harness(t), ops = await h.boot()
  await failed(ops,await ops.claim(input()))
  await failed(ops,await ops.claim(input('H2')))
  await assert.rejects(ops.claim(input('H3',{sourceWatermark:101,freshTokens:10})),/上限/)
  const next = await ops.claim(input('H4',{sourceWatermark:102,sourceHash:hash('new source'),freshTokens:10000}))
  assert.equal(next.cycle,2); assert.equal(next.ordinal,1)
})

test('operations: crash after authorized permit is durable but before dispatch cannot reuse grant after reopen',async t=>{
 const h=await harness(t);let ops=await h.boot()
 const original=await ops.claim(input());origins.set(original.requestHash,original.operationId);await assert.rejects(ops.claim(input()));await grantCurrent(ops)
 h.after((name,key,row)=>{if(name==='operations'&&row.authorizationId)throw new Error('crash-after-durable-put')})
 await assert.rejects(ops.claim(changedStrategy()),/crash-after/)
 h.after(undefined);await h.stop();ops=await h.boot()
 assert.equal(ops.records('subject').length,2)
 assert.equal(ops.records('subject')[1].phase,'recorded')
 await assert.rejects(ops.claim(input()),/上限/)
})

test('operations: a failed primary whose repair committed cannot be granted or replayed',async t=>{
 const h=await harness(t),ops=await h.boot(),primary=await ops.claim(input())
 await failed(ops,primary)
 const repair=await ops.claim(input('repair',{purpose:'repair'}))
 await ops.settle('subject',repair.operationId,'committed')
 await assert.rejects(ops.claim(input()),/已经提交/)
 assert.equal(ops.recoveryStatus('subject').available,false)
})

test('operations: exhausted budget remains visible after restart without a recoverable in-memory plan',async t=>{
 const h=await harness(t);let ops=await h.boot()
 const first=await ops.claim(input());origins.set(first.requestHash,first.operationId);await ops.settle('subject',first.operationId,'unknown_interrupted')
 await grantCurrent(ops)
 const second=await ops.claim(changedStrategy());await ops.settle('subject',second.operationId,'unknown_interrupted')
 await assert.rejects(ops.claim(input('H2')),error=>error.code==='budget_exhausted')
 assert.equal(ops.recoveryStatus('subject').available,false)
 assert.match(ops.recoveryStatus('subject').message,/本次未调用摘要模型/)
 await h.stop();ops=await h.boot()
 const before=ops.records('subject')
 assert.equal(ops.recoveryStatus('subject').available,false)
 assert.match(ops.recoveryStatus('subject').message,/主摘要 2\/2/)
 assert.deepEqual(ops.records('subject'),before)
 await assert.rejects(ops.grant('subject',hash('H1')))
 assert.equal(ops.records('subject').length,2)
})

test('emergency: separate durable single-call budget survives restart and old automatic writes',async t=>{
 const h=await harness(t);let ops=await h.boot()
 const a=await ops.claim(input());origins.set(a.requestHash,a.operationId);await ops.settle('subject',a.operationId,'unknown_interrupted')
 await grantCurrent(ops);const b=await ops.claim(changedStrategy());await ops.settle('subject',b.operationId,'unknown_interrupted')
 const normal=ops.records('subject'),plan=ops.prepareEmergency(input())
 const results=await Promise.allSettled([ops.claimEmergency(input(),plan.token),ops.claimEmergency(input(),plan.token)])
 assert.equal(results.filter(r=>r.status==='fulfilled').length,1)
 assert.deepEqual(ops.records('subject'),normal)
 await h.stop();ops=await h.boot()
 assert.equal(ops.emergencyStatus('subject').used,true)
 assert.throws(()=>ops.prepareEmergency(input()))
 await assert.rejects(ops.claim(input('changed')),e=>e.code==='budget_exhausted')
 assert.equal(ops.allRecords('subject').length,3)
})

test('emergency: expired or mismatched confirmation never consumes budget',async t=>{
 const h=await harness(t),ops=await h.boot()
 const a=await ops.claim(input());origins.set(a.requestHash,a.operationId);await ops.settle('subject',a.operationId,'unknown_interrupted')
 await grantCurrent(ops);const b=await ops.claim(changedStrategy());await ops.settle('subject',b.operationId,'unknown_interrupted')
 const plan=ops.prepareEmergency(input())
 await assert.rejects(ops.claimEmergency(input('changed'),plan.token))
 t.mock.timers.enable({apis:['Date'],now:Date.now()});t.mock.timers.tick(120001)
 await assert.rejects(ops.claimEmergency(input(),plan.token))
 assert.equal(ops.allRecords('subject').length,2)
})

test('emergency: actual local.3 read and write cannot erase independent rescue consumption',{skip:!process.env.DSH_CONTEXT_PREVIOUS_SOURCE},async t=>{
 const previous=await build({entryPoints:[process.env.DSH_CONTEXT_PREVIOUS_SOURCE],bundle:true,write:false,platform:'node',format:'esm',plugins:[{name:'public-api',setup(b){b.onResolve({filter:/^[^./]/},args=>({path:import.meta.resolve(args.path),external:true}))}}]})
 const {SummaryOperations:Old}=await import(`data:text/javascript;base64,${Buffer.from(previous.outputFiles[0].text).toString('base64')}`)
 const h=await harness(t);let ops=await h.boot()
 const a=await ops.claim(input());origins.set(a.requestHash,a.operationId);await ops.settle('subject',a.operationId,'unknown_interrupted')
 await grantCurrent(ops);const b=await ops.claim(changedStrategy());await ops.settle('subject',b.operationId,'unknown_interrupted')
 const plan=ops.prepareEmergency(input());await ops.claimEmergency(input(),plan.token);await ops.close()
 const old=await Old.open(h.facility());await assert.rejects(old.claim(input('changed')),/上限/)
 await old.bind('subject',a.operationId,{attemptId:'old-version-read-write'});await old.close()
 ops=await SummaryOperations.open(h.facility())
 assert.equal(ops.emergencyStatus('subject').used,true);assert.equal(ops.allRecords('subject').length,3)
 assert.throws(()=>ops.prepareEmergency(input()));await ops.close()
})
