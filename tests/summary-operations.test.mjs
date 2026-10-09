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
const input = (name = 'H1', extra = {}) => ({ sessionId: 'subject', requestHash: hash(name), routeHash: hash('route'),
  sourceHash: hash('original'), sourceWatermark: 100, freshTokens: 0, minNewTokens: 10000,
  confirmation:{hash:hash('config'),model:'mock/large',deadline:'600s',estimatedInput:1000}, purpose: 'summary', trigger: 'pressure', compactionId: 'compact-1', legacy: [], unboundManual: false, ...extra })
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
async function failed(ops, row) { await ops.settle('subject', row.operationId, 'known_failed_unapplied') }

test('operations: fresh, exact retry, then changed hash cannot obtain third primary; survives restart', async t => {
  const h = await harness(t); let ops = await h.boot()
  const one = await ops.claim(input()); await failed(ops, one)
  const two = await ops.claim(input()); await failed(ops, two)
  assert.equal(two.reissue, true); assert.equal(two.cycle, 1); assert.equal(two.ordinal, 2)
  await assert.rejects(ops.claim(input('H2')), /2 个主摘要/)
  await h.stop(); ops = await h.boot()
  await assert.rejects(ops.claim(input('H3')), /2 个主摘要/)
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
  await assert.rejects(ops.claim(input()), /未知/)
  await assert.rejects(ops.claim(input('H2')), /未知/)
  await assert.rejects(ops.claim(input('H1', { routeHash: hash('other') })), /路由/)
  await assert.rejects(ops.claim(input('H1', { sourceHash: hash('changed') })), /来源/)
  assert.equal(ops.records('subject').length, 1)
})
test('operations: explicit grant is read-only until mutation, then one atomic permit consumes it under concurrency and restart', async t => {
  const h = await harness(t); let ops = await h.boot()
  await ops.claim(input()); await assert.rejects(ops.claim(input()), /未知/)
  for (let n=0;n<3;n++) assert.equal(ops.recoveryStatus('subject').available, true)
  await ops.grant('subject', hash('H1'))
  const results = await Promise.allSettled([ops.claim(input()),ops.claim(input())])
  assert.equal(results.filter(r=>r.status==='fulfilled').length,1)
  const receipt = results.find(r=>r.status==='fulfilled').value
  assert.ok(receipt.authorizationId); assert.equal(receipt.ordinal,2)
  await h.stop(); ops = await h.boot()
  await assert.rejects(ops.claim(input()), /上限/)
  assert.equal(ops.records('subject').length,2)
})
test('operations: grant source and route are exact, expiry checked at serialized consumption', async t => {
  const h = await harness(t), ops = await h.boot()
  await ops.claim(input()); await assert.rejects(ops.claim(input())); await ops.grant('subject',hash('H1'))
  await assert.rejects(ops.claim(input('H1',{sourceWatermark:101})),/来源/)
  await assert.rejects(ops.claim(input('H1',{routeHash:hash('new')})),/路由/)
  const now = Date.now; Date.now = () => now()+120001
  try { await assert.rejects(ops.claim(input()), /未知/) } finally { Date.now=now }
  assert.equal(ops.records('subject').length,1)
})
test('operations: v1 unknown is counted once; explicit permit starts ordinal 2; third primary denied', async t => {
  const h = await harness(t), ops = await h.boot()
  const legacy = [{ ...input(), cycle:1, ordinal:1, claimedAt:1 }]
  await assert.rejects(ops.claim(input('H1',{legacy})),/未知/)
  await ops.grant('subject',hash('H1'))
  const row = await ops.claim(input('H1',{legacy}))
  assert.equal(row.ordinal,2); assert.equal(ops.records('subject').length,1)
  await assert.rejects(ops.claim(input('H2',{legacy})),/上限/)
})
test('operations: unbound old manual attempts deny recovery instead of inventing remaining budget', async t => {
  const h = await harness(t), ops = await h.boot(), legacy = [{...input(),cycle:1,ordinal:1,claimedAt:1}]
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
 await ops.claim(input());await assert.rejects(ops.claim(input()));await ops.grant('subject',hash('H1'))
 h.after((name,key,row)=>{if(name==='operations'&&row.authorizationId)throw new Error('crash-after-durable-put')})
 await assert.rejects(ops.claim(input()),/crash-after/)
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
 const first=await ops.claim(input());await ops.settle('subject',first.operationId,'unknown_interrupted')
 await ops.grant('subject',hash('H1'))
 const second=await ops.claim(input());await ops.settle('subject',second.operationId,'unknown_interrupted')
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
 const a=await ops.claim(input());await ops.settle('subject',a.operationId,'unknown_interrupted')
 await ops.grant('subject',hash('H1'));const b=await ops.claim(input());await ops.settle('subject',b.operationId,'unknown_interrupted')
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
 const a=await ops.claim(input());await ops.settle('subject',a.operationId,'unknown_interrupted')
 await ops.grant('subject',hash('H1'));const b=await ops.claim(input());await ops.settle('subject',b.operationId,'unknown_interrupted')
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
 const a=await ops.claim(input());await ops.settle('subject',a.operationId,'unknown_interrupted')
 await ops.grant('subject',hash('H1'));const b=await ops.claim(input());await ops.settle('subject',b.operationId,'unknown_interrupted')
 const plan=ops.prepareEmergency(input());await ops.claimEmergency(input(),plan.token);await ops.close()
 const old=await Old.open(h.facility());await assert.rejects(old.claim(input('changed')),/上限/)
 await old.bind('subject',a.operationId,{attemptId:'old-version-read-write'});await old.close()
 ops=await SummaryOperations.open(h.facility())
 assert.equal(ops.emergencyStatus('subject').used,true);assert.equal(ops.allRecords('subject').length,3)
 assert.throws(()=>ops.prepareEmergency(input()));await ops.close()
})
