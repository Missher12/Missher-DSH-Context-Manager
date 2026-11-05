import {test} from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import {mkdtempSync,writeFileSync,symlinkSync,unlinkSync,statSync,rmSync,mkdirSync,chmodSync,readFileSync,realpathSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {pathToFileURL} from 'node:url'
import {createHash} from 'node:crypto'
import {createRequire,syncBuiltinESMExports} from 'node:module'
import {build} from 'esbuild'
const compiled=await build({entryPoints:['src/startup-guard.ts'],bundle:true,write:false,platform:'node',format:'esm',packages:'external'})
const compileDir=mkdtempSync(join(tmpdir(),'context-guard-module-'))
const compiledPath=join(compileDir,'guard.mjs');writeFileSync(compiledPath,compiled.outputFiles[0].text)
const {inspectStartupFiles,startupProof}=await import(compiledPath)
const digest=file=>createHash('sha256').update(readFileSync(file)).digest('hex')
const pause=ms=>Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,ms)
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
  assert.equal(inspectStartupFiles([link,anchor],restarted,Number.NaN,1000).ready,false,'an unusable now never slips through')
  assert.equal(inspectStartupFiles([link,anchor],restarted,Infinity,1000).ready,false)
  assert.equal(inspectStartupFiles([link,anchor],restarted,restarted+1000,Number.NaN).ready,false,'an unusable elapsed never slips through')
  assert.equal(inspectStartupFiles([link,anchor],restarted,restarted+1000,Infinity).ready,false)
  assert.equal(inspectStartupFiles([link,anchor],restarted,restarted+1000,-1).ready,false,'negative elapsed is not a valid clock')
  assert.equal(inspectStartupFiles([link,anchor],restarted,restarted-1,1000).ready,false,'now cannot precede startedAt')
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
  // A late physical archive must never borrow a member hash as proof: other
  // executable content in the archive may have changed even if this member did not.
  const physicalFs=createRequire(import.meta.url)('original-fs')
  const archiveCtime=physicalFs.statSync(physicalFs.realpathSync(archive)).ctimeMs
  const lateStart=archiveCtime-1000, lateNow=Date.now()+2000
  const memberBytes=new Map([[realpathSync(anchor),digest(anchor)]])
  assert.equal(inspectStartupFiles([anchor],lateStart,lateNow,lateNow-lateStart,memberBytes).ready,false,
   'a member hash cannot clear a late archive container')
 }finally{rmSync(root,{recursive:true,force:true})}
})


test('startup guard: a metadata-only touch after startup reuses verified bytes, while replaced bytes stay blocked',()=>{
 const root=mkdtempSync(join(tmpdir(),'context-metadata-'))
 try{
  const engine=join(root,'engine.js'),anchor=join(root,'package.json')
  writeFileSync(engine,'generation one');writeFileSync(anchor,'{}')
  const startedAt=Math.max(statSync(engine).ctimeMs,statSync(anchor).ctimeMs)+1000
  const clock=()=>{const now=Date.now()+5000;return{now,elapsed:now-startedAt}}
  assert.equal(inspectStartupFiles([engine,anchor],startedAt,clock().now,clock().elapsed).ready,true,'the files existed before this process started')
  const evidence=new Map([[realpathSync(engine),digest(engine)],[realpathSync(anchor),digest(anchor)]])
  pause(1100)
  chmodSync(engine,0o600)
  const chmodAt=clock()
  assert.equal(inspectStartupFiles([engine,anchor],startedAt,chmodAt.now,chmodAt.elapsed).ready,false,
    'a ctime-only bump still fails closed when this process never verified the bytes')
  assert.equal(inspectStartupFiles([engine,anchor],startedAt,chmodAt.now,chmodAt.elapsed,evidence).ready,true,
    'unchanged bytes survive metadata-only changes once they were verified in this process')
  chmodSync(anchor,0o600)
  const anchorTouched=clock()
  assert.equal(inspectStartupFiles([engine,anchor],startedAt,anchorTouched.now,anchorTouched.elapsed,evidence).ready,true,
    'the anchor may only reuse its own verified bytes')
  writeFileSync(anchor,'{"changed":true}')
  const anchorReplaced=clock()
  assert.equal(inspectStartupFiles([engine,anchor],startedAt,anchorReplaced.now,anchorReplaced.elapsed,evidence).ready,false,
    'a replaced install anchor is rechecked even when the module bytes were verified')
  writeFileSync(engine,'generation two')
  const replaced=clock()
  assert.equal(inspectStartupFiles([engine,anchor],startedAt,replaced.now,replaced.elapsed,evidence).ready,false,
    'a real byte change never borrows the earlier evidence')
 }finally{rmSync(root,{recursive:true,force:true})}
})

test('startup guard: a config patch is not a code generation, and a cached proof still rechecks the anchor',()=>{
 const root=mkdtempSync(join(tmpdir(),'context-patch-'))
 try{
  const anchor=join(root,'package.json'),patch=join(root,'patch.json')
  writeFileSync(anchor,'{}')
  const startedAt=Math.max(statSync(compiledPath).ctimeMs,statSync(anchor).ctimeMs)+300
  const clock=()=>{const now=Date.now()+5000;return{startedAt,now,elapsed:now-startedAt}}
  writeFileSync(patch,'{"policy":1}')
  pause(400)
  writeFileSync(patch,'{"policy":2}')
  const profile={dir:root,installAnchor:anchor,patchPath:patch}
  const first=startupProof(pathToFileURL(compiledPath).href,profile,clock())
  assert.equal(first.ready,true,first.reason)
  writeFileSync(patch,'{"policy":3}')
  const second=startupProof(pathToFileURL(compiledPath).href,profile,clock())
  assert.equal(second.ready,true,'editing configuration after startup does not invent an old transport')
  writeFileSync(anchor,'{"version":"2"}')
  const anchorChanged=startupProof(pathToFileURL(compiledPath).href,profile,clock())
  assert.equal(anchorChanged.ready,false,'a ready proof is rechecked instead of skipping the anchor forever')
 }finally{rmSync(root,{recursive:true,force:true})}
})


test('startup guard: verified bytes survive a cache-busted module reload for the same startup boundary',async()=>{
 const root=mkdtempSync(join(tmpdir(),'context-reload-'))
 try{
  const anchor=join(root,'package.json'),patch=join(root,'patch.json')
  writeFileSync(anchor,'{}');writeFileSync(patch,'{}')
  const startedAt=Math.max(statSync(compiledPath).ctimeMs,statSync(anchor).ctimeMs)+1000
  const clock=()=>{const now=Date.now()+5000;return{startedAt,now,elapsed:now-startedAt}}
  const profile={dir:root,installAnchor:anchor,patchPath:patch}
  const url=pathToFileURL(compiledPath).href
  assert.equal(startupProof(url,profile,clock()).ready,true,'the first module instance crosses the boundary')
  const reloaded=await import(`${url}?reload=1`)
  assert.notEqual(reloaded.startupProof,startupProof,'the cache-busted import is a fresh module instance')
  pause(1100)
  chmodSync(compiledPath,0o600)
  assert.equal(reloaded.startupProof(url,profile,clock()).ready,true,
   'the reloaded module reuses the process-wide bytes verified at the same boundary')
  assert.equal(reloaded.inspectStartupFiles([compiledPath,anchor],startedAt,clock().now,clock().elapsed).ready,false,
   'without the shared evidence the metadata-only change still fails closed')
 }finally{rmSync(root,{recursive:true,force:true})}
})

test('startup guard: a replacement during verification is rejected and never becomes trusted evidence',t=>{
 const root=mkdtempSync(join(tmpdir(),'context-changing-install-'))
 const engine=join(root,'engine.js'),anchor=join(root,'package.json')
 try{
  writeFileSync(engine,'original code');writeFileSync(anchor,'{}')
  const startedAt=Math.max(statSync(engine).ctimeMs,statSync(anchor).ctimeMs)+1
  pause(20)
  const clock=()=>{const now=Date.now();return{startedAt,now,elapsed:now-startedAt}}
  const originalRead=fs.readFileSync
  let changed=false
  t.mock.method(fs,'readFileSync',function(file,...args){
   if(file===engine&&!changed){changed=true;writeFileSync(engine,'replacement code')}
   return originalRead.call(this,file,...args)
  })
  syncBuiltinESMExports()
  const profile={dir:root,installAnchor:anchor,patchPath:join(root,'patch.yml')}
  const first=startupProof(pathToFileURL(engine).href,profile,clock())
  assert.ok(changed,'the install changes exactly while its bytes are being inspected')
  assert.equal(first.ready,false,'a changing install is not a verified startup snapshot')
  assert.equal(startupProof(pathToFileURL(engine).href,profile,clock()).ready,false,
   'failed verification must never bless the replacement for the next attempt')
 }finally{t.mock.restoreAll();syncBuiltinESMExports();rmSync(root,{recursive:true,force:true})}
})
