/** Offline development only: link an explicitly supplied built Harness checkout. */
import { readFile, mkdir, readdir, symlink, lstat, access, realpath, unlink } from 'node:fs/promises'
import { resolve, dirname } from 'node:path'
import { createRequire } from 'node:module'
const source = process.argv[2]
if (!source) throw new Error('Usage: node scripts/link-harness.mjs /path/to/built-harness')
const root = resolve(source)
const { satisfies } = createRequire(resolve(root, 'apps/desktop/package.json'))('semver')
const manifest = JSON.parse(await readFile(resolve(root, 'package.json'), 'utf8'))
const local = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'))
const expected = Object.entries(local.devDependencies).find(([name]) => name.startsWith('@deepseek-ai/dsh-'))?.[1]
if (manifest.version !== expected) throw new Error(`Expected Harness ${expected}, got ${manifest.version}`)
async function link(name, target) {
  const dest = resolve('node_modules', name)
  await mkdir(dirname(dest), { recursive: true })
  try {
    const existing = await lstat(dest)
    if (!existing.isSymbolicLink()) throw new Error(`Refusing to replace a non-link dependency: ${dest}`)
    let current
    try { current = await realpath(dest) } catch (error) { if (error.code !== 'ENOENT') throw error }
    if (current === await realpath(target)) return
    await unlink(dest)
  } catch (error) { if (error.code !== 'ENOENT') throw error }
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
for (const name of ['esbuild', 'typescript', 'react', 'react-dom', 'jsdom', 'js-yaml', 'zod', '@types/react', '@types/react-dom', '@types/node']) {
  const version = local.devDependencies?.[name] ?? local.dependencies?.[name]
  if (version === undefined) continue
  try {
    if (satisfies(JSON.parse(await readFile(resolve('node_modules', name, 'package.json'), 'utf8')).version, version)) continue
  } catch (error) { if (error.code !== 'ENOENT') throw error }
  let target = resolve(root, 'node_modules', name)
  let matches = false
  try { matches = satisfies(JSON.parse(await readFile(resolve(target, 'package.json'), 'utf8')).version, version) } catch (error) {
    if (error.code !== 'ENOENT') throw error
  }
  if (!matches) {
    const prefix = name.replace('/', '+') + '@'
    const entry = (await readdir(resolve(root, 'node_modules/.pnpm'))).sort().find(n => n.startsWith(prefix) && satisfies(n.slice(prefix.length).split('_')[0], version))
    if (!entry) throw new Error('Missing development dependency: ' + name)
    target = resolve(root, 'node_modules/.pnpm', entry, 'node_modules', name)
  }
  await access(target)
  await link(name, target)
}
console.log('Linked offline development dependencies from', root)

// Test configuration reads the Host's decorator transformer through this explicit SDK link.
try { await symlink(root, resolve('harness-sdk'), 'dir') } catch (error) {
  if (error.code !== 'EEXIST') throw error
  if (await realpath(resolve('harness-sdk')) !== await realpath(root)) throw new Error('harness-sdk already points to a different checkout; keep one explicit SDK per development checkout')
}
