/** Pin copied preset definitions instead of monkey-patching Loader or private engine state. */
import { readFile, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { pathToFileURL } from 'node:url'
import { load, dump, DEFAULT_SCHEMA, Type } from 'js-yaml'

/**
 * Harness releases whose prompt loop registers only `provider` and `model`.
 * `{{cwd}}` is not a prompt variable; the working-directory service supplies
 * the current directory as literal runtime context instead.
 */
export const VERIFIED_HARNESS_VERSIONS = ['0.2.0-rc.2', '0.2.1-alpha.2']
/** Persona suffix copied from the rc.2 presets; it must never reach the overlay. */
export const DEPRECATED_CWD_CLAUSE = 'Your working directory is {{cwd}}.'
const PRESETS = ['standard', 'ptc', 'cordis']
const schema = DEFAULT_SCHEMA.extend([new Type('tag:yaml.org,2002:js', { kind: 'scalar', construct: text => ({ __jsExpr: text }) })])

/**
 * Remove the deprecated cwd clause from a persona suffix while preserving the
 * rest of the prose. An otherwise-empty suffix is omitted, matching the host
 * guidance for custom persona templates.
 * @param config - persona plugin config copied from a preset row.
 * @returns whether the deprecated clause was present.
 */
export function normalizePersonaSuffix(config) {
  if (config === undefined || config === null || typeof config.suffix !== 'string') return false
  if (!config.suffix.includes(DEPRECATED_CWD_CLAUSE)) return false
  const remaining = config.suffix.split(DEPRECATED_CWD_CLAUSE).join('').trim()
  if (remaining.length === 0) delete config.suffix
  else config.suffix = remaining
  return true
}

/** Collect JSON paths whose strings still reference the deprecated variable. */
function findDeprecatedReference(value, path = '$', found = []) {
  if (typeof value === 'string') {
    if (value.includes('{{cwd}}')) found.push(path)
  } else if (Array.isArray(value)) {
    value.forEach((entry, index) => findDeprecatedReference(entry, `${path}[${index}]`, found))
  } else if (value !== null && typeof value === 'object') {
    for (const [key, entry] of Object.entries(value)) findDeprecatedReference(entry, `${path}.${key}`, found)
  }
  return found
}

/**
 * Read the host preset sources under `root` and return the overlay entries and
 * their fingerprints. The compaction backend is replaced and the deprecated
 * persona suffix is normalized; any surviving `{{cwd}}` reference fails loud.
 * @param root - Harness source root containing packages/bundle/web-app/presets.
 * @returns patches for cordis.patch.yml plus source fingerprints.
 */
export async function renderOverlay(root) {
  const pkg = JSON.parse(await readFile(resolve(root, 'package.json'), 'utf8'))
  const expected = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8')).devDependencies['@deepseek-ai/dsh-agent']
  if (pkg.version !== expected) throw new Error(`Expected Harness ${expected}, got ${pkg.version}`)
  const patches = [{ id: 'compaction-basic', name: '@deepseek-ai/dsh-compaction-basic', disabled: true }, {
    insert: [{ id: 'context-manager', name: '@missher/dsh-context-manager' }, { id: 'context-manager-engine', name: '@missher/dsh-context-manager/engine' }, { id: 'context-manager-inspector', name: '@missher/dsh-context-manager/inspector' }],
  }]
  const sources = []
  for (const preset of PRESETS) {
    const path = `packages/bundle/web-app/presets/${preset}.patch.yml`
    const raw = await readFile(resolve(root, path), 'utf8')
    const rows = load(raw, { schema }).flatMap(p => p.insert ?? [])
    const row = rows.find(r => r.id === `preset-${preset}`)
    if (!row) throw new Error('Missing expected preset: ' + preset)
    let changes = 0
    let normalized = 0
    const visit = entries => { for (const entry of entries) {
      if (entry.name === '@deepseek-ai/dsh-compaction-basic') { entry.name = '@missher/dsh-context-manager/engine'; changes++ }
      if (entry.name === '@deepseek-ai/dsh-persona' && normalizePersonaSuffix(entry.config)) normalized++
      if (entry.group && Array.isArray(entry.config)) visit(entry.config)
    } }
    visit(row.config.plugins)
    if (changes !== 1) throw new Error('Expected one compaction backend in ' + preset)
    patches.push({ id: row.id, name: row.name, config: row.config })
    sources.push({
      path,
      sha256: createHash('sha256').update(raw).digest('hex'),
      replacedBackends: changes,
      normalizedDeprecatedPersonaSuffixes: normalized,
    })
  }
  const leftover = findDeprecatedReference(patches)
  if (leftover.length > 0) throw new Error('Deprecated {{cwd}} reference survived overlay generation: ' + leftover.join(', '))
  return { patches, sources }
}

const invoked = process.argv[1] !== undefined && import.meta.url === pathToFileURL(resolve(process.argv[1])).href
if (invoked) {
  const root = resolve(process.argv[2] ?? '')
  const { patches, sources } = await renderOverlay(root)
  const pkg = JSON.parse(await readFile(resolve(root, 'package.json'), 'utf8'))
  await writeFile('cordis.patch.yml', `# Generated for Harness ${pkg.version}; profile/user overrides remain later layers.\n` + dump(patches, { lineWidth: -1, noRefs: true }))
  const sourceSha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim()
  await writeFile('COMPATIBILITY.json', JSON.stringify({ harnessVersion: pkg.version, verifiedHarnessVersions: VERIFIED_HARNESS_VERSIONS, sourceSha, sources, customPresets: 'Replace the compaction-basic provider with @missher/dsh-context-manager/engine explicitly. Saved preset overrides take precedence.' }, null, 2) + '\n')
}
