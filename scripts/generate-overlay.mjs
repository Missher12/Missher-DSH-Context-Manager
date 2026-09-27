/** Pin copied preset definitions instead of monkey-patching Loader or private engine state. */
import { readFile, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { load, dump, DEFAULT_SCHEMA, Type } from 'js-yaml'
const root = resolve(process.argv[2] ?? '')
const pkg = JSON.parse(await readFile(resolve(root, 'package.json'), 'utf8'))
if (pkg.version !== '0.1.7-rc.2') throw new Error('Unsupported Harness version')
const schema = DEFAULT_SCHEMA.extend([new Type('tag:yaml.org,2002:js', { kind: 'scalar', construct: text => ({ __jsExpr: text }) })])
const patches = [{ id: 'compaction-basic', name: '@deepseek-ai/dsh-compaction-basic', disabled: true }, {
  insert: [{ id: 'context-manager', name: 'dsh-context-manager' }, { id: 'context-manager-engine', name: 'dsh-context-manager/engine' }, { id: 'context-manager-inspector', name: 'dsh-context-manager/inspector' }],
}]
const sources = []
for (const preset of ['standard', 'ptc', 'cordis']) {
  const path = `packages/bundle/web-app/presets/${preset}.patch.yml`
  const raw = await readFile(resolve(root, path), 'utf8')
  const rows = load(raw, { schema }).flatMap(p => p.insert ?? [])
  const row = rows.find(r => r.id === `preset-${preset}`)
  if (!row) throw new Error('Missing expected preset: ' + preset)
  let changes = 0
  const visit = entries => { for (const entry of entries) {
    if (entry.name === '@deepseek-ai/dsh-compaction-basic') { entry.name = 'dsh-context-manager/engine'; changes++ }
    if (entry.group && Array.isArray(entry.config)) visit(entry.config)
  } }
  visit(row.config.plugins)
  if (changes !== 1) throw new Error('Expected one compaction backend in ' + preset)
  patches.push({ id: row.id, name: row.name, config: row.config })
  sources.push({ path, sha256: createHash('sha256').update(raw).digest('hex'), replacedBackends: changes })
}
await writeFile('cordis.patch.yml', '# Generated for Harness 0.1.7-rc.2; profile/user overrides remain later layers.\n' + dump(patches, { lineWidth: -1, noRefs: true }))
await writeFile('COMPATIBILITY.json', JSON.stringify({ harnessVersion: pkg.version, sourceSha: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(), sources, customPresets: 'Replace the compaction-basic provider with dsh-context-manager/engine explicitly. Saved preset overrides take precedence.' }, null, 2) + '\n')
