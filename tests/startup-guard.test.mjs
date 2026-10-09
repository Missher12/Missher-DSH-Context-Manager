import {test} from 'node:test'
import assert from 'node:assert/strict'
import {mkdtempSync,writeFileSync,symlinkSync,unlinkSync,statSync,rmSync,mkdirSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {build} from 'esbuild'
const compiled=await build({entryPoints:['src/startup-guard.ts'],bundle:true,write:false,platform:'node',format:'esm',packages:'external'})
const compileDir=mkdtempSync(join(tmpdir(),'context-guard-module-'))
const compiledPath=join(compileDir,'guard.mjs');writeFileSync(compiledPath,compiled.outputFiles[0].text)
const {inspectStartupFiles}=await import(compiledPath)
process.on('exit',()=>rmSync(compileDir,{recursive:true,force:true}))
test('startup guard: copy install and symlink hot switch reject until a new process; unreliable clock and paths fail closed',()=>{
 const root=mkdtempSync(join(tmpdir(),'context-startup-'))
 try{
  const engine=join(root,'engine.js'),other=join(root,'other.js'),link=join(root,'current.js'),anchor=join(root,'package.json')
  writeFileSync(engine,'new code');writeFileSync(other,'prebuilt');writeFileSync(anchor,'{}');symlinkSync(engine,link)
  const installed=Math.max(statSync(engine).ctimeMs,statSync(anchor).ctimeMs,Date.now())
  assert.equal(inspectStartupFiles([engine,anchor],installed-1000,installed+1000,2000).ready,false)
  assert.equal(inspectStartupFiles([engine,anchor],installed+1000,installed+2000,1000).ready,true)
  // The target was prebuilt, but the pointer switches after the old process began.
  const beforeSwitch=Date.now()+1
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,20)
  unlinkSync(link);symlinkSync(other,link)
  const afterSwitch=Date.now()
  assert.equal(inspectStartupFiles([other,anchor],beforeSwitch,afterSwitch,afterSwitch-beforeSwitch).ready,true,'prebuilt target itself predates process start')
  assert.equal(inspectStartupFiles([link,anchor],beforeSwitch,afterSwitch,afterSwitch-beforeSwitch).ready,false,'only the switched link is too new')
  const restarted=Date.now()+1000
  assert.equal(inspectStartupFiles([link,anchor],restarted,restarted+1000,1000).ready,true)
  assert.equal(inspectStartupFiles([link,anchor],restarted,restarted+100000,1000).ready,false)
  assert.equal(inspectStartupFiles([join(root,'missing')],restarted,restarted+1000,1000).ready,false)
 }finally{rmSync(root,{recursive:true,force:true})}
})


test('startup guard: a directory named .asar cannot bypass file timestamps',()=>{
 const root=mkdtempSync(join(tmpdir(),'context-asar-directory-'))
 try{
  const dir=join(root,'app.asar');mkdirSync(dir)
  const file=join(dir,'package.json');writeFileSync(file,'{}')
  const now=Date.now()+100
  assert.equal(inspectStartupFiles([file],now-1000,now,1000).ready,false)
  assert.equal(inspectStartupFiles([file],now+1000,now+2000,1000).ready,true)
 }finally{rmSync(root,{recursive:true,force:true})}
})
test('startup guard: actual Electron archive uses physical container and rejects hot archive symlink',{
 skip:!process.versions.electron||!process.env.DSH_CONTEXT_ASAR_ANCHOR,
},()=>{
 const anchor=process.env.DSH_CONTEXT_ASAR_ANCHOR
 const boundary=anchor.indexOf('.asar/')+5,archive=anchor.slice(0,boundary),member=anchor.slice(boundary+1)
 assert.ok(boundary>4)
 const proof=inspectStartupFiles([anchor],performance.timeOrigin,Date.now(),performance.now())
 assert.equal(proof.ready,true,proof.reason)
 const root=mkdtempSync(join(tmpdir(),'context-real-asar-'))
 try{
  const link=join(root,'hot.asar');symlinkSync(archive,link)
  const virtual=join(link,member)
  assert.equal(inspectStartupFiles([virtual],performance.timeOrigin,Date.now(),performance.now()).ready,false)
  const restarted=Date.now()+1000
  assert.equal(inspectStartupFiles([virtual],restarted,restarted+1000,1000).ready,true)
 }finally{rmSync(root,{recursive:true,force:true})}
})
