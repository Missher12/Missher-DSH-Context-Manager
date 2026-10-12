import {test} from 'node:test'
import assert from 'node:assert/strict'
import {defaults,budget,capacityTokens,idleFloorTokens,formatPercent,migrateCapacity,validatePolicy} from '../lib/policy.js'
import {composition,contextWindow} from '../lib/chart-data.js'

test('percent policy follows the actual window, floor rounds and retains protocol caps',()=>{
 assert.deepEqual(capacityTokens(defaults,200000),{recent:20000,summary:8000,repair:2000})
 assert.deepEqual(capacityTokens(defaults,1000000),{recent:100000,summary:32768,repair:8192})
 assert.deepEqual(capacityTokens(defaults,1025),{recent:102,summary:41,repair:10})
 for(const window of [0,NaN,Infinity,-1])assert.throws(()=>capacityTokens(defaults,window))
 for(const window of [64000,200000,1000000]){
  const limits=budget(defaults,window,window*.16)
  assert.equal(limits.recentTokens,capacityTokens(defaults,window).recent)
  assert.equal(limits.admission,Math.floor(window*.79))
  assert.equal(idleFloorTokens(defaults,window,window*.16),window*.65)
 }
 assert.equal(formatPercent(220000,200000),'110.00%');assert.equal(formatPercent(0,null),'—')
})
test('legacy budgets preserve old bounds until explicit migration; unsupported migration refuses',()=>{
 const {capacityMode,...old}=defaults
 const legacy={...old,absoluteEnabled:true,absoluteTriggerTokens:100000,absoluteTargetTokens:50000}
 assert.equal(budget(legacy,200000,32000).admission,100000)
 assert.equal(capacityTokens(legacy,1000000).recent,20000)
 const next=migrateCapacity({...legacy,capacityMode:'legacy'},200000,32000)
 assert.equal(next.capacityMode,'percent');assert.equal(next.earlyPercent,legacy.earlyPercent);assert.equal(next.absoluteTriggerTokens,100000)
 assert.ok(budget(next,200000,32000).admission<=100000)
 assert.ok(capacityTokens(next,200000).summary<=legacy.summaryMaxTokens)
 assert.throws(()=>migrateCapacity({...legacy,capacityMode:'legacy'},1000000,32000),'cannot represent a 10% trigger under current supported range')
 assert.throws(()=>validatePolicy({...defaults,recentPercent:NaN}))
})
test('composition uses current authoritative window including null and preserves over-window shares',()=>{
 const data={historical:false,parts:[{category:'user',tokens:100000}],pressure:{window:1000000,projected:100000},pressureHistory:[],model:null,admission:{tokens:100000,window:200000,outputReserve:32000}}
 const chart=composition(data,defaults)
 assert.equal(chart.free,58000);assert.equal(chart.reserve,42000)
 assert.ok(Math.abs(chart.slices.find(s=>s.id==='free').share-29)<1e-9)
 assert.equal(chart.slices.find(s=>s.id==='reserve').share,21)
 assert.equal(composition({...data,admission:{...data.admission,window:null}},defaults).window,null)
 const over=composition({...data,parts:[{category:'user',tokens:220000}],admission:{...data.admission,tokens:220000}},defaults)
 assert.equal(over.overflow,true);assert.ok(Math.abs(over.slices[2].share-110)<1e-9);assert.equal(over.free,0);assert.equal(over.reserve,0)
})

test('historical content and composition share recorded cut window with pressure null',()=>{
 const cut={historical:true,pressure:null,admission:{window:1000000,tokens:0},pressureHistory:[{window:200000,tokens:100000}],parts:[{category:'user',tokens:20000}],model:null}
 assert.equal(contextWindow(cut),200000)
 assert.equal(composition(cut,defaults).window,contextWindow(cut))
 assert.equal(formatPercent(20000,contextWindow(cut)),'10.00%')
 assert.equal(contextWindow({...cut,historical:false,admission:{window:null}}),null)
 assert.equal(contextWindow({...cut,pressureHistory:[]}),null)
})
