/** Offline development only: link an explicitly supplied built Harness checkout. */
import { readFile, mkdir, readdir, symlink, lstat, access } from 'node:fs/promises'
import { resolve, dirname } from 'node:path'
const source = process.argv[2]
if (!source) throw new Error('Usage: node scripts/link-harness.mjs /path/to/built-harness')
const root = resolve(source)
const manifest = JSON.parse(await readFile(resolve(root, 'package.json'), 'utf8'))
if (manifest.version !== '0.1.7-rc.2') throw new Error('Expected Harness 0.1.7-rc.2')
async function link(name, target) {
  const dest = resolve('node_modules', name)
  await mkdir(dirname(dest), { recursive: true })
  try { await lstat(dest); return } catch (error) { if (error.code !== 'ENOENT') throw error }
  await symlink(target, dest, 'dir')
}
for (const family of ['vendor', 'packages']) {
  for (const name of (await readdir(resolve(root, family), { withFileTypes: true })).filter(e => e.isDirectory()).map(e => e.name)) {
    const base = resolve(root, family, name)
    let children = [base]
    if (family === 'packages') children = (await readdir(base, { withFileTypes: true })).filter(e => e.isDirectory()).map(e => resolve(base, e.name))
    for (const child of children) {
      try { const p = JSON.parse(await readFile(resolve(child, 'package.json'), 'utf8')); await link(p.name, child) }
      catch (error) { if (error.code !== 'ENOENT') throw error }
    }
  }
}
for (const name of ['esbuild', 'typescript', 'react', 'react-dom', 'jsdom', 'js-yaml', 'zod', '@types/react', '@types/node']) {
  let target = resolve(root, 'node_modules', name)
  try { await access(target) } catch (error) {
    if (error.code !== 'ENOENT') throw error
    const entry = (await readdir(resolve(root, 'node_modules/.pnpm'))).find(n => n.startsWith(name.replace('/', '+') + '@'))
    if (!entry) throw new Error('Missing development dependency: ' + name)
    target = resolve(root, 'node_modules/.pnpm', entry, 'node_modules', name)
  }
  await link(name, target)
}
console.log('Linked offline development dependencies from', root)
