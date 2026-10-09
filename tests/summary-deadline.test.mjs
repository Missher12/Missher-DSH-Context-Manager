import { test } from 'node:test'
import assert from 'node:assert/strict'
import { getEventListeners } from 'node:events'
import { build } from 'esbuild'
import { defaults, deadlineLimits } from '../lib/policy.js'
const result = await build({entryPoints:['src/summary-deadline.ts'],bundle:true,write:false,platform:'node',format:'esm'})
const {SummaryDeadline,chunkProgresses}=await import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString('base64')}`)
const limits={firstOutputMs:120000,stallMs:180000,totalMs:600000}
function harness(t,extra=[],config=limits) {
 let time=0
 const d=new SummaryDeadline(config,extra,()=>time)
 t.after(()=>d.dispose())
 return {d,advance:ms=>{time+=ms}}
}
test('deadline: absence of mode and explicit legacy values retain whole transaction limit',()=>{
 for(const timeoutMs of [1000,90000,135000,300000])assert.deepEqual(deadlineLimits({...defaults,summaryTimeoutMode:undefined,timeoutMs}),{totalMs:timeoutMs,firstOutputMs:timeoutMs,stallMs:timeoutMs})
 assert.equal(deadlineLimits({...defaults,summaryTimeoutMode:'adaptive',timeoutMs:90000}).totalMs,600000)
})
test('deadline: only nonempty reasoning/text deltas renew progress',()=>{
 for(const type of ['usage','heartbeat','block-start','block-end','tool-call-delta','finish'])assert.equal(chunkProgresses({type,text:'x'}),false)
 for(const type of ['text-delta','reasoning-delta']){assert.equal(chunkProgresses({type,text:'x'}),true);assert.equal(chunkProgresses({type,text:''}),false)}
})
test('deadline: selection time counts toward total but not first output',t=>{
 const {d,advance}=harness(t);advance(200000);d.assertAlive();d.beginCall();advance(120000)
 assert.throws(()=>d.assertAlive(),e=>e.code==='first_output_timeout')
})
test('deadline: continuing progress passes 90 seconds but cannot renew total',t=>{
 const {d,advance}=harness(t);d.beginCall()
 for(let n=0;n<5;n++){advance(100000);d.noteProgress();d.assertAlive()}
 advance(100000);d.noteProgress();assert.throws(()=>d.assertAlive(),e=>e.code==='total_timeout')
})
test('deadline: late first chunk cannot resurrect first-output wait without ticker',t=>{
 const {d,advance}=harness(t);d.beginCall();advance(120001);d.noteProgress()
 assert.equal(d.signal.reason.code,'first_output_timeout')
})
test('deadline: late progress cannot resurrect expired stall without ticker',t=>{
 const {d,advance}=harness(t);d.beginCall();advance(50000);d.noteProgress();advance(180001);d.noteProgress()
 assert.equal(d.signal.reason.code,'stall_timeout')
})
test('deadline: repair resets call window but shares remaining hard total',t=>{
 const {d,advance}=harness(t);d.beginCall();advance(100000);d.noteProgress();d.endCall();advance(400000);d.beginCall();advance(100000)
 assert.throws(()=>d.assertAlive(),e=>e.code==='total_timeout')
})
test('deadline: late begin and end cannot hide expired call',t=>{
 const {d,advance}=harness(t);d.beginCall();advance(120001);d.endCall();assert.throws(()=>d.beginCall(),e=>e.code==='first_output_timeout')
})
test('deadline: cancellation and disposal immediately detach all external listeners',t=>{
 const a=new AbortController(),b=new AbortController(),{d}=harness(t,[a.signal,b.signal]);a.abort(new Error('user cancelled'))
 assert.match(d.signal.reason.message,/user/);assert.equal(getEventListeners(b.signal,'abort').length,0)
 const next=harness(t,[b.signal]);next.d.dispose();assert.equal(getEventListeners(b.signal,'abort').length,0)
})
test('deadline: pre-aborted source detaches earlier listeners',t=>{
 const a=new AbortController(),b=new AbortController();b.abort();harness(t,[a.signal,b.signal]);assert.equal(getEventListeners(a.signal,'abort').length,0)
})
test('deadline: limits cannot be changed by caller after transaction begins',t=>{
 const settings={...limits};const {d,advance}=harness(t,[],settings);settings.totalMs=999999999;advance(600001)
 assert.throws(()=>d.assertAlive(),e=>e.code==='total_timeout')
})
