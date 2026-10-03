import { build } from 'esbuild'
import { mkdir, writeFile } from 'node:fs/promises'
await mkdir('lib', { recursive: true })
await build({ entryPoints: ['src/index.ts', 'src/engine.ts', 'src/policy.ts', 'src/diagnostics.ts', 'src/inspector.ts', 'src/inspector-fold.ts', 'src/typert.ts', 'src/chart-data.ts'], outdir: 'lib', platform: 'node', format: 'esm', bundle: true, packages: 'external', target: 'es2022', logLevel: 'warning' })
// zod is not a browser platform seed. Bundle our wire codecs; only the host's
// shared React and UI primitives cross the module-loader boundary.
const result = await build({ entryPoints: ['src/client.tsx'], outfile: 'lib/client.js', platform: 'browser', format: 'cjs', bundle: true, external: ['react', 'react/*', 'react-dom', 'react-dom/*', '@deepseek-ai/dsh-client-ui-primitives'], jsx: 'automatic', target: 'es2022', metafile: true, loader: { '.css': 'text' },
  banner: { js: 'window.__ModuleLoader__.load({id:"@missher/dsh-context-manager",factory:(require)=>{var module={exports:{}};var exports=module.exports;' }, footer: { js: 'return module.exports;}});' } })
await mkdir('verification', { recursive: true })
await writeFile('verification/client-build.json', JSON.stringify({ imports: result.metafile.outputs['lib/client.js'].imports }, null, 2) + '\n')
