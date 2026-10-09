/** Conservative filesystem proof for standard installations, not provider billing proof. */
import { createHash } from 'node:crypto'
import * as fs from 'node:fs'
import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, isAbsolute, parse, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
const key=Symbol.for('@missher/context-manager/transport-generation/v1')
type Proof={ready:boolean;reason:string}
const global=globalThis as unknown as Record<symbol,Map<string,Proof>>
const generations=global[key]??=new Map<string,Proof>()
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
export function inspectStartupFiles(files:readonly string[],startedAt:number,now:number,elapsed:number):Proof {
  try {
    if(!Number.isFinite(startedAt)||startedAt<=0||Math.abs(now-startedAt-elapsed)>5000)throw new Error('进程启动时钟无法核验')
    // original-fs is Electron's built-in unpatched filesystem, not a dependency.
    // Failure to obtain it stays fail-closed; never trust synthetic archive stats.
    const physicalFs:typeof fs=process.versions.electron?createRequire(import.meta.url)('original-fs'):fs
    for(const file of files){
      if(!isAbsolute(file))throw new Error('安装路径不是绝对路径')
      if(!statSync(file).isFile())throw new Error('安装路径不是文件')
      const physical=physicalContainer(file,physicalFs),actual=physicalFs.realpathSync(physical),stat=physicalFs.statSync(actual)
      if(!stat.isFile()||!Number.isFinite(stat.ctimeMs)||stat.ctimeMs>startedAt||stat.ctimeMs>now)throw new Error('安装文件晚于本进程启动')
      for(const candidate of [physical,actual]){
        let part=resolve(candidate)
        while(part!==parse(part).root){
          const link=physicalFs.lstatSync(part)
          if(link.isSymbolicLink()&&link.ctimeMs>startedAt)throw new Error('安装链接在本进程中切换过')
          part=dirname(part)
        }
      }
    }
    return {ready:true,reason:''}
  }catch(error){return {ready:false,reason:`无法排除旧版本遗留的本地传输：${error instanceof Error?error.message:'安装元数据不可读取'}。请正常退出应用并重新启动后再预检；不会清除未知费用记录。`}}
}
export function startupProof(moduleUrl:string,profile?:{dir:string;installAnchor:string;patchPath:string}):Proof {
  try{
    const file=fileURLToPath(moduleUrl),actual=realpathSync(file),digest=createHash('sha256').update(readFileSync(actual)).digest('hex')
    const anchor=profile?.installAnchor??resolve(dirname(actual),'../package.json')
    const identity=`${profile?realpathSync(profile.dir):dirname(anchor)}:${digest}`
    const cached=generations.get(identity);if(cached?.ready)return cached
    const files=[file,anchor];if(profile?.patchPath&&existsSync(profile.patchPath))files.push(profile.patchPath)
    const proof=inspectStartupFiles(files,performance.timeOrigin,Date.now(),performance.now())
    generations.set(identity,proof);return proof
  }catch{return {ready:false,reason:'无法核验实际安装字节与进程启动边界，请正常退出并重新启动；元数据仍不可用时禁止人工急救。'}}
}
