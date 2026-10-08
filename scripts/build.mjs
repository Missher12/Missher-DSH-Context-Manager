import { build } from 'esbuild'
import { mkdir, writeFile } from 'node:fs/promises'
import { isAbsolute, join, resolve } from 'node:path'
// The isolated stage sets DSH_CONTEXT_BUILD_OUT so a regression build can never
// overwrite the canonical root lib. Default stays `lib` for normal packaging.
const outdir = process.env.DSH_CONTEXT_BUILD_OUT ? resolve(process.env.DSH_CONTEXT_BUILD_OUT) : 'lib'
if (process.env.DSH_CONTEXT_BUILD_OUT) {
  const here = resolve(process.cwd())
  if (outdir === join(here, 'lib') || !isAbsolute(outdir)) throw new Error(`DSH_CONTEXT_BUILD_OUT must be an isolated absolute directory, got ${outdir}`)
}
await mkdir(outdir, { recursive: true })
await build({ entryPoints: ['src/index.ts', 'src/engine.ts', 'src/policy.ts', 'src/diagnostics.ts', 'src/inspector.ts', 'src/inspector-fold.ts', 'src/typert.ts', 'src/chart-data.ts', 'src/working-set.ts', 'src/compaction-cycles.ts', 'src/history-tools.ts', 'src/archive.ts', 'src/reducer.ts', 'src/tool-results.ts', 'src/efficiency.ts'],
  outdir, platform: 'node', format: 'esm', bundle: true, packages: 'external', target: 'es2022', logLevel: 'warning' })
// zod is not a browser platform seed. Bundle our wire codecs; only the host's
// shared React and UI primitives cross the module-loader boundary.
const result = await build({ entryPoints: ['src/client.tsx'], outfile: join(outdir, 'client.js'), platform: 'browser', format: 'cjs', bundle: true, external: ['react', 'react/*', 'react-dom', 'react-dom/*', '@deepseek-ai/dsh-client-ui-primitives'], jsx: 'automatic', target: 'es2022', metafile: true, loader: { '.css': 'text' },
  banner: { js: 'window.__ModuleLoader__.load({id:"@missher/dsh-context-manager",factory:(require)=>{var module={exports:{}};var exports=module.exports;' }, footer: { js: 'return module.exports;}});' } })
await mkdir('verification', { recursive: true })
await writeFile('verification/client-build.json', JSON.stringify({ outdir, imports: result.metafile.outputs[join(outdir, 'client.js')].imports }, null, 2) + '\n')
