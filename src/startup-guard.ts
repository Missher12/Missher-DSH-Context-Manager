/** Conservative filesystem proof for standard installations, not provider billing proof. */
import { createHash } from 'node:crypto'
import * as fs from 'node:fs'
import { readFileSync, realpathSync, statSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, isAbsolute, parse, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
type Proof={ready:boolean;reason:string}
type Clock={startedAt:number;now:number;elapsed:number}
// Process-wide verified bytes, isolated per startup boundary. A new schema key
// keeps the old v1 Proof cache unreadable here, and a shared Symbol.for map
// survives cache-busted module reloads without trusting local module state.
const EVIDENCE=Symbol.for('@missher/context-manager/startup-bytes/v2')
type EvidenceStore=Map<number,Map<string,string>>
const shared=(globalThis as unknown as Record<symbol,unknown>)
if(!(shared[EVIDENCE] instanceof Map))shared[EVIDENCE]=new Map<number,Map<string,string>>()
const evidenceStore=shared[EVIDENCE] as EvidenceStore
function evidenceFor(startedAt:number):Map<string,string>{
  let bytes=evidenceStore.get(startedAt)
  if(!bytes){bytes=new Map();evidenceStore.set(startedAt,bytes)}
  return bytes
}
const digestOf=(file:string)=>createHash('sha256').update(readFileSync(file)).digest('hex')
// Electron reports synthetic timestamps for archive members. Only an actual
// file container qualifies; a directory named *.asar stays a normal path.
function physicalContainer(file:string,physicalFs:typeof fs):string {
  let part=resolve(file),container=file
  while(part!==parse(part).root){
    if(part.endsWith('.asar')&&physicalFs.statSync(part).isFile())container=part
    part=dirname(part)
  }
  return container
}
export function inspectStartupFiles(files:readonly string[],startedAt:number,now:number,elapsed:number,verified?:Map<string,string>):Proof {
  try {
    if(!Number.isFinite(startedAt)||startedAt<=0||!Number.isFinite(now)||!Number.isFinite(elapsed)||elapsed<0||now<startedAt||Math.abs(now-startedAt-elapsed)>5000)throw new Error('进程启动时钟无法核验')
    // original-fs is Electron's built-in unpatched filesystem, not a dependency.
    // Failure to obtain it stays fail-closed; never trust synthetic archive stats.
    const physicalFs:typeof fs=process.versions.electron?createRequire(import.meta.url)('original-fs'):fs
    const observed=new Map<string,string>()
    for(const file of files){
      if(!isAbsolute(file))throw new Error('安装路径不是绝对路径')
      if(!statSync(file).isFile())throw new Error('安装路径不是文件')
      const physical=physicalContainer(file,physicalFs),actual=physicalFs.realpathSync(physical),stat=physicalFs.statSync(actual)
      if(!stat.isFile()||!Number.isFinite(stat.ctimeMs)||stat.ctimeMs>now)throw new Error('安装元数据晚于本进程时钟或不可读取')
      // ctime moves for chmod/copy without proving a code generation. Reuse the
      // bytes only when this process already verified the very same file bytes.
      // An archive container is different: its member stat is synthetic and one
      // member hash cannot prove the rest of the archive, so a late container
      // always requires a restart regardless of that member's bytes.
      if(stat.ctimeMs>startedAt&&physical!==file)throw new Error('安装归档晚于本进程启动，无法确认归档内其余可执行内容的代际')
      const path=realpathSync(file),known=verified?.get(path)
      if(stat.ctimeMs>startedAt&&known===undefined)throw new Error('安装文件晚于本进程启动，且本进程没有它的启动前字节证据，无法识别代码代际')
      if(verified){
        const current=digestOf(file),after=physicalFs.statSync(actual)
        if(stat.dev!==after.dev||stat.ino!==after.ino||stat.size!==after.size
          ||stat.ctimeMs!==after.ctimeMs||stat.mtimeMs!==after.mtimeMs)throw new Error('核验期间安装文件发生变化，无法确认代码代际')
        if(stat.ctimeMs>startedAt&&current!==known)throw new Error('安装文件在本进程内被替换，字节与启动前证据不一致')
        observed.set(path,current)
      }
      for(const candidate of [physical,actual]){
        let part=resolve(candidate)
        while(part!==parse(part).root){
          const link=physicalFs.lstatSync(part)
          if(link.isSymbolicLink()&&link.ctimeMs>startedAt)throw new Error('安装链接在本进程中切换过')
          part=dirname(part)
        }
      }
    }
    // Publish evidence only after all bytes, metadata and links passed. Reading
    // the bytes again here could accidentally bless a concurrent replacement.
    for(const [path,digest] of observed)verified!.set(path,digest)
    return {ready:true,reason:''}
  }catch(error){return {ready:false,reason:`上下文管理尚未就绪：${error instanceof Error?error.message:'安装元数据不可读取'}。请正常退出应用并重新启动后再预检；不会清除未知费用记录。`}}
}
export function startupProof(moduleUrl:string,profile?:{dir:string;installAnchor:string;patchPath:string},clock?:Clock):Proof {
  try{
    const file=fileURLToPath(moduleUrl),actual=realpathSync(file)
    const anchor=profile?.installAnchor??resolve(dirname(actual),'../package.json')
    const startedAt=clock?.startedAt??performance.timeOrigin,now=clock?.now??Date.now(),elapsed=clock?.elapsed??performance.now()
    // The profile patch file is configuration, not an executable generation:
    // editing it after startup must never claim a stale local transport.
    return inspectStartupFiles([file,anchor],startedAt,now,elapsed,evidenceFor(startedAt))
  }catch{return {ready:false,reason:'无法核验实际安装字节与进程启动边界，请正常退出并重新启动；元数据仍不可用时禁止人工急救。'}}
}
// Take the earliest possible evidence: the engine may be instantiated long
// after activation, and a later first read cannot tell a hot install from an
// ordinary in-process metadata change. Failures stay silent here and are
// reported by the caller's proof.
try{startupProof(import.meta.url)}catch{}
