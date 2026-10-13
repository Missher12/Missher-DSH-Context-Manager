import { test } from 'node:test'
import { TYPERT } from '../lib/typert.js'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { createHash } from 'node:crypto'
import { dirname, join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { load, dump, DEFAULT_SCHEMA, Type } from 'js-yaml'
import { DEPRECATED_CWD_CLAUSE, hasCompactionProviderCapability, normalizePersonaSuffix, renderOverlay } from '../scripts/generate-overlay.mjs'

const require = createRequire(import.meta.url)
const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
const compatibility = JSON.parse(readFileSync(new URL('../COMPATIBILITY.json', import.meta.url), 'utf8'))
const schema = DEFAULT_SCHEMA.extend([new Type('tag:yaml.org,2002:js', { kind: 'scalar', construct: text => ({ __jsExpr: text }) })])
const overlay = load(readFileSync(new URL('../cordis.patch.yml', import.meta.url), 'utf8'), { schema })
const legacyRaw = readFileSync(new URL('./fixtures/context-local.5-cordis.patch.yml', import.meta.url))
const LEGACY_SHA256 = 'dee6b8134e94c7a136e5a9e2b02efe71c8ba7657337c95aafb1d1c90351dfd69'
const PRESETS = ['standard', 'ptc', 'cordis']
const scriptPath = fileURLToPath(new URL('../scripts/generate-overlay.mjs', import.meta.url))

/** The local.5 preset snapshot is the frozen rc.2 baseline this candidate derives from. */
const loadLegacy = () => {
  assert.equal(createHash('sha256').update(legacyRaw).digest('hex'), LEGACY_SHA256, 'legacy fixture must be the frozen local.5 overlay')
  return load(legacyRaw.toString('utf8'), { schema })
}

const flattenLeaves = rows => rows.flatMap(row => row.group && Array.isArray(row.config) ? flattenLeaves(row.config) : [row])
const findPersona = row => flattenLeaves(row.config.plugins).find(entry => entry.id === 'persona')
/** Rebuild the legacy rc.2 preset source from the frozen overlay for the generator round-trip. */
const restoreLegacySource = entries => { for (const entry of entries) {
  if (entry.name === '@missher/dsh-context-manager/engine') entry.name = '@deepseek-ai/dsh-compaction-basic'
  if (entry.name === '@deepseek-ai/dsh-persona') entry.config.suffix = DEPRECATED_CWD_CLAUSE
  if (entry.group && Array.isArray(entry.config)) restoreLegacySource(entry.config)
} }

const seedGeneratorRoot = (root, capability = false) => {
  mkdirSync(join(root, 'packages/bundle/web-app/presets'), { recursive: true })
  writeFileSync(join(root, 'package.json'), JSON.stringify({ version: manifest.devDependencies['@deepseek-ai/dsh-agent'] }))
  const legacy = loadLegacy()
  for (const preset of PRESETS) {
    const row = structuredClone(legacy.find(entry => entry.id === `preset-${preset}`))
    restoreLegacySource(row.config.plugins)
    writeFileSync(join(root, `packages/bundle/web-app/presets/${preset}.patch.yml`), dump([{ insert: [row] }], { lineWidth: -1, noRefs: true }))
  }
  if (capability) {
    mkdirSync(join(root, 'packages/preset/agent-preset/src'), { recursive: true })
    mkdirSync(join(root, 'packages/preset/agent-preset-registry/src'), { recursive: true })
    mkdirSync(join(root, 'vendor/include/src'), { recursive: true })
    writeFileSync(join(root, 'packages/preset/agent-preset/src/index.ts'), 'compactionProvider: z.string()\n')
    writeFileSync(join(root, 'vendor/include/src/index.ts'), [
      'function applyPresetCompactionProviderPatch(target, compactionProvider) {',
      "  if (target.name !== '@deepseek-ai/dsh-agent-preset') return false",
      '  target.config = { ...target.config, compactionProvider }',
      '}',
    ].join('\n'))
    writeFileSync(join(root, 'packages/preset/agent-preset-registry/src/compaction-provider.ts'), 'export function replaceCompactionProvider() {}\n')
    writeFileSync(join(root, 'packages/preset/agent-preset-registry/src/index.ts'), [
      'entryListProblem(record.config.plugins)',
      'replaceCompactionProvider(record.config.plugins, record.config.compactionProvider)',
      'await mountPreset(context, record.config.id, plugins)',
    ].join('\n'))
  }
  return legacy
}

const basePackage = name => name.startsWith('@') ? name.split('/').slice(0, 2).join('/') : name.split('/')[0]
/**
 * Strictly compare one bundle preset snapshot against one host preset row.
 * Only the host persona row receives the exact deprecated cwd-suffix
 * normalization; every other field stays byte-strict.
 */
const assertHostPresetLedger = ({ preset, raw, ours, hostVersion }) => {
  const rc2Host = hostVersion.startsWith('0.2.0')
  const expectedHostOnly = rc2Host ? [] : ['time-context', 'tool-schedule']
  const expectedOurOnly = rc2Host ? [] : ['tool-subagent-codex', 'tool-subagent-claude-code', 'tool-ralph']
  const knownChanged = rc2Host ? [] : ['plan-mode', 'tool-subagent', 'tool-subagent-fork']
  assert.equal((raw.match(/\{\{cwd\}\}/g) ?? []).length, rc2Host ? 1 : 0, `${preset} preset cwd references`)
  const source = load(raw, { schema }).flatMap(row => row.insert ?? []).find(row => row.id === `preset-${preset}`)
  // The persona row must agree after normalizing only the deprecated suffix; {{model}} stays intact.
  const hostPersona = structuredClone(findPersona(source))
  normalizePersonaSuffix(hostPersona.config)
  assert.deepEqual(findPersona(ours), hostPersona, preset)
  assert.equal(findPersona(ours).config.prefix, findPersona(source).config.prefix)
  // Strict row-by-row comparison. The same exact normalization is applied to the host persona leaf
  // only; every other row and field must match without weakening.
  const hostLeaves = new Map(flattenLeaves(structuredClone(source.config.plugins)).map(row => [row.id, row]))
  normalizePersonaSuffix(hostLeaves.get('persona').config)
  const ourLeaves = new Map(flattenLeaves(ours.config.plugins).map(row => [row.id, row]))
  assert.deepEqual([...ourLeaves.keys()].filter(id => !hostLeaves.has(id)).sort(), [...expectedOurOnly].sort(), preset)
  assert.deepEqual([...hostLeaves.keys()].filter(id => !ourLeaves.has(id)).sort(), [...expectedHostOnly].sort(), preset)
  let replaced = 0
  for (const [id, row] of ourLeaves) {
    const hostRow = hostLeaves.get(id)
    if (hostRow === undefined) {
      assert.equal(row.disabled, true, `${preset}:${id} is a disabled legacy row`)
      continue
    }
    if (row.name === '@missher/dsh-context-manager/engine') {
      assert.equal(hostRow.name, '@deepseek-ai/dsh-compaction-basic', `${preset}:${id} backend`)
      replaced++
      continue
    }
    if (knownChanged.includes(id)) {
      assert.notDeepEqual(row, hostRow, `${preset}:${id} is a documented alpha.2 change`)
      continue
    }
    assert.deepEqual(row, hostRow, `${preset}:${id}`)
  }
  assert.equal(replaced, 1, `${preset} replaces exactly one compaction backend`)
  // The original tool plugin packages stay resolvable in the installed host.
  for (const row of ourLeaves.values()) {
    if (!row.name.startsWith('@deepseek-ai/')) continue
    require.resolve(basePackage(row.name))
  }
}

test('declared runtime peers include the built SDK; generated presets never carry {{cwd}}', () => {
  for (const [name, version] of Object.entries(manifest.peerDependencies)) {
    if (!name.startsWith('@deepseek-ai/dsh-')) continue
    assert.equal(version, '*', 'Host version numbers must not block installation: ' + name)
    const installed = JSON.parse(readFileSync(require.resolve(`${name}/package.json`), 'utf8')).version
    assert.ok(compatibility.verifiedHarnessVersions.includes(installed), name)
  }
  if (compatibility.presetMode === 'registry-compaction-provider') {
    assert.deepEqual(overlay[0], { id: 'compaction-basic', name: '@deepseek-ai/dsh-compaction-basic', disabled: true })
    assert.deepEqual(overlay[1].insert.map(row => row.name), ['@missher/dsh-context-manager', '@missher/dsh-context-manager/engine', '@missher/dsh-context-manager/inspector'])
    for (const preset of PRESETS) {
      const row = overlay.find(entry => entry.id === `preset-${preset}`)
      assert.deepEqual(Object.keys(row).sort(), ['compactionProvider', 'id', 'name'])
      assert.equal(row.compactionProvider, '@missher/dsh-context-manager/engine')
    }
  } else {
    assert.deepEqual(overlay[0], { id: 'compaction-basic', name: '@deepseek-ai/dsh-compaction-basic', disabled: true })
    assert.deepEqual(overlay[1].insert.map(row => row.name), ['@missher/dsh-context-manager', '@missher/dsh-context-manager/engine', '@missher/dsh-context-manager/inspector'])
  }
  assert.equal(JSON.stringify(overlay).match(/\{\{model\}\}/g)?.length ?? 0, compatibility.presetMode === 'registry-compaction-provider' ? 0 : 3,
    'narrow patches do not snapshot preset prompt config')
  assert.ok(!JSON.stringify(overlay).includes('{{cwd}}'))
})

test('the generator retains an installable legacy full-preset fallback for Hosts without the capability', async () => {
  const root = mkdtempSync(join(tmpdir(), 'context-overlay-legacy-host-'))
  try {
    seedGeneratorRoot(root)
    assert.equal(await hasCompactionProviderCapability(root), false)
    const result = await renderOverlay(root)
    assert.equal(result.presetMode, 'legacy-full-preset-override')
    assert.deepEqual(result.patches[0], { id: 'compaction-basic', name: '@deepseek-ai/dsh-compaction-basic', disabled: true })
    assert.deepEqual(result.patches[1].insert.map(row => row.name), ['@missher/dsh-context-manager', '@missher/dsh-context-manager/engine', '@missher/dsh-context-manager/inspector'])
    for (const preset of PRESETS) {
      const row = result.patches.find(entry => entry.id === `preset-${preset}`)
      const leaves = flattenLeaves(row.config.plugins)
      assert.equal(leaves.filter(entry => entry.name === '@missher/dsh-context-manager/engine').length, 1)
      assert.equal(leaves.filter(entry => entry.name === '@deepseek-ai/dsh-compaction-basic').length, 0)
      assert.ok(!JSON.stringify(row).includes('{{cwd}}'))
    }
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('the generator is deterministic for the declared mode and its CLI output is idempotent', async () => {
  const root = mkdtempSync(join(tmpdir(), 'context-overlay-src-'))
  const out = mkdtempSync(join(tmpdir(), 'context-overlay-out-'))
  try {
    seedGeneratorRoot(root, compatibility.presetMode === 'registry-compaction-provider')
    const first = await renderOverlay(root)
    const second = await renderOverlay(root)
    assert.deepEqual(first, second, 'generator output is deterministic')
    assert.equal(first.presetMode, compatibility.presetMode)
    if (compatibility.presetMode === 'registry-compaction-provider') {
      assert.deepEqual(first.patches, overlay, 'narrow generator output matches the shipped capability-gated artifact')
    } else {
      for (const preset of PRESETS) {
        const row = first.patches.find(entry => entry.id === `preset-${preset}`)
        const leaves = flattenLeaves(row.config.plugins)
        assert.equal(leaves.filter(entry => entry.name === '@deepseek-ai/dsh-compaction-basic').length, 0)
        assert.equal(leaves.filter(entry => entry.name === '@missher/dsh-context-manager/engine').length, 1)
      }
    }
    assert.deepEqual(first.sources.map(source => source.normalizedDeprecatedPersonaSuffixes), [1, 1, 1])

    execFileSync('git', ['init', '-q'], { cwd: root })
    execFileSync('git', ['add', '-A'], { cwd: root })
    execFileSync('git', ['-c', 'user.email=test@example.com', '-c', 'user.name=test', 'commit', '-qm', 'fixture'], { cwd: root })
    execFileSync(process.execPath, [scriptPath, root], { cwd: out })
    const written = readFileSync(join(out, 'cordis.patch.yml'), 'utf8')
    assert.deepEqual(load(written, { schema }), first.patches, 'CLI output matches the deterministic generator result')
    execFileSync(process.execPath, [scriptPath, root], { cwd: out })
    assert.equal(readFileSync(join(out, 'cordis.patch.yml'), 'utf8'), written, 'CLI rewrite is byte-idempotent')
  } finally {
    rmSync(root, { recursive: true, force: true })
    rmSync(out, { recursive: true, force: true })
  }
})

test('the registry capability leaves Basic in the preset rows and selects the narrow activation mode', async () => {
  const root = mkdtempSync(join(tmpdir(), 'context-overlay-capability-'))
  try {
    mkdirSync(join(root, 'packages/bundle/web-app/presets'), { recursive: true })
    mkdirSync(join(root, 'packages/preset/agent-preset/src'), { recursive: true })
    mkdirSync(join(root, 'packages/preset/agent-preset-registry/src'), { recursive: true })
    mkdirSync(join(root, 'vendor/include/src'), { recursive: true })
    writeFileSync(join(root, 'package.json'), JSON.stringify({ version: manifest.devDependencies['@deepseek-ai/dsh-agent'] }))
    const legacy = loadLegacy()
    for (const preset of PRESETS) {
      const row = structuredClone(legacy.find(entry => entry.id === `preset-${preset}`))
      restoreLegacySource(row.config.plugins)
      writeFileSync(join(root, `packages/bundle/web-app/presets/${preset}.patch.yml`), dump([{ insert: [row] }], { lineWidth: -1, noRefs: true }))
    }
    writeFileSync(join(root, 'packages/preset/agent-preset/src/index.ts'), 'compactionProvider: z.string()\n')
    writeFileSync(join(root, 'vendor/include/src/index.ts'), [
      'function applyPresetCompactionProviderPatch(target, compactionProvider) {',
      "  if (target.name !== '@deepseek-ai/dsh-agent-preset') return false",
      '  target.config = { ...target.config, compactionProvider }',
      '}',
    ].join('\n'))
    writeFileSync(join(root, 'packages/preset/agent-preset-registry/src/compaction-provider.ts'), 'export function replaceCompactionProvider() {}\n')
    writeFileSync(join(root, 'packages/preset/agent-preset-registry/src/index.ts'), [
      'entryListProblem(record.config.plugins)',
      'replaceCompactionProvider(record.config.plugins, record.config.compactionProvider)',
      'await mountPreset(context, record.config.id, plugins)',
    ].join('\n'))
    assert.equal(await hasCompactionProviderCapability(root), true)
    const result = await renderOverlay(root)
    assert.equal(result.presetMode, 'registry-compaction-provider')
    assert.deepEqual(result.patches[1].insert.map(row => row.name), ['@missher/dsh-context-manager', '@missher/dsh-context-manager/engine', '@missher/dsh-context-manager/inspector'])
    const rootBasic = result.patches.find(row => row.id === 'compaction-basic')
    assert.equal(rootBasic?.disabled, true, 'the root Basic provider is disabled before inserting the Context manager engine')
    for (const preset of PRESETS) {
      const row = result.patches.find(entry => entry.id === `preset-${preset}`)
      assert.deepEqual(Object.keys(row).sort(), ['compactionProvider', 'id', 'name'])
      assert.equal(row.compactionProvider, '@missher/dsh-context-manager/engine')
      assert.equal('config' in row, false, 'the narrow patch never snapshots the preset config')
      const original = structuredClone(legacy.find(entry => entry.id === `preset-${preset}`))
      restoreLegacySource(original.config.plugins)
      const leaves = flattenLeaves(original.config.plugins)
      assert.equal(leaves.filter(entry => entry.name === '@deepseek-ai/dsh-compaction-basic').length, 1)
      assert.equal(leaves.filter(entry => entry.name === '@missher/dsh-context-manager/engine').length, 0,
        'the Host activation hook performs provider substitution without embedding a preset snapshot')
    }
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('generator normalization preserves unrelated suffix prose and fails closed on non-persona {{cwd}}', async () => {
  const prose = { suffix: `Keep this sentence. ${DEPRECATED_CWD_CLAUSE}` }
  assert.equal(normalizePersonaSuffix(prose), true)
  assert.equal(prose.suffix, 'Keep this sentence.')
  const empty = { suffix: DEPRECATED_CWD_CLAUSE }
  assert.equal(normalizePersonaSuffix(empty), true)
  assert.ok(!('suffix' in empty))
  const untouched = { suffix: 'A suffix that stays.' }
  assert.equal(normalizePersonaSuffix(untouched), false)
  assert.equal(untouched.suffix, 'A suffix that stays.')

  const root = mkdtempSync(join(tmpdir(), 'context-overlay-bad-'))
  try {
    mkdirSync(join(root, 'packages/bundle/web-app/presets'), { recursive: true })
    writeFileSync(join(root, 'package.json'), JSON.stringify({ version: manifest.devDependencies['@deepseek-ai/dsh-agent'] }))
    const legacy = loadLegacy()
    for (const preset of PRESETS) {
      const row = structuredClone(legacy.find(entry => entry.id === `preset-${preset}`))
      restoreLegacySource(row.config.plugins)
      if (preset === 'standard') {
        flattenLeaves(row.config.plugins).find(entry => entry.id === 'plan-mode').config.section += '\nCurrent directory: {{cwd}}\n'
      }
      writeFileSync(join(root, `packages/bundle/web-app/presets/${preset}.patch.yml`), dump([{ insert: [row] }], { lineWidth: -1, noRefs: true }))
    }
    await assert.rejects(renderOverlay(root), /Deprecated \{\{cwd\}\} reference survived overlay generation/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('installed host preset facts stay inside the documented compatibility ledger', () => {
  const host = dirname(require.resolve('@deepseek-ai/dsh-web-app/package.json'))
  const hostVersion = JSON.parse(readFileSync(resolve(host, 'package.json'), 'utf8')).version
  assert.ok(compatibility.verifiedHarnessVersions.includes(hostVersion), hostVersion)
  if (compatibility.presetMode === 'registry-compaction-provider') {
    assert.equal(compatibility.hostCapabilityRequirement?.id, 'preset-compaction-provider-patch-v1')
    assert.equal(compatibility.hostCapabilityRequirement?.status, 'candidate-only')
    assert.equal(compatibility.hostCapabilityRequirement?.hostPackageVersion, manifest.devDependencies['@deepseek-ai/dsh-agent'])
    assert.deepEqual(compatibility.hostCapabilityRequirement?.sourceFiles, [
      'vendor/include/src/index.ts',
      'packages/preset/agent-preset/src/index.ts',
      'packages/preset/agent-preset-registry/src/index.ts',
      'packages/preset/agent-preset-registry/src/compaction-provider.ts',
    ])
    assert.match(compatibility.hostCapabilityRequirement?.fingerprintSha256 ?? '', /^[0-9a-f]{64}$/u)
    assert.equal(compatibility.hostCapabilityRequirement?.officialVersionClaim, false)
    for (const preset of PRESETS) {
      const source = compatibility.sources.find(row => row.path.endsWith(`/${preset}.patch.yml`))
      const raw = readFileSync(resolve(host, 'presets', `${preset}.patch.yml`))
      assert.equal(createHash('sha256').update(raw).digest('hex'), source?.sha256, preset)
      const patch = overlay.find(row => row.id === `preset-${preset}`)
      assert.deepEqual(Object.keys(patch).sort(), ['compactionProvider', 'id', 'name'])
    }
    assert.equal(compatibility.legacyFallback?.available, true)
    assert.equal(compatibility.legacyFallback?.artifactVersion, '0.10.0-local.9-legacy.1')
    assert.equal(compatibility.legacyFallback?.presetMode, 'legacy-full-preset-override')
    assert.equal(compatibility.priorRollback?.artifactVersion, '0.10.0-local.8')
    assert.match(compatibility.priorRollback?.role ?? '', /rollback-only/u)
    return
  }
  if (compatibility.presetMode === 'legacy-full-preset-override') {
    assert.equal(compatibility.hostCapabilityRequirement, null)
    assert.match(compatibility.sourceSha ?? '', /^[0-9a-f]{40}$/u, 'legacy snapshots record the exact Host source commit')
    assert.equal(compatibility.legacyFallback?.pairedNarrowArtifactVersion, '0.10.0-local.9')
    for (const preset of PRESETS) {
      const row = overlay.find(entry => entry.id === `preset-${preset}`)
      assert.ok(row.config?.plugins, `${preset} includes the full legacy fallback snapshot`)
      const leaves = flattenLeaves(row.config.plugins)
      assert.equal(leaves.filter(entry => entry.name === '@deepseek-ai/dsh-compaction-basic').length, 0, preset)
      assert.equal(leaves.filter(entry => entry.name === '@missher/dsh-context-manager/engine').length, 1, preset)
    }
    return
  }
  for (const preset of PRESETS) {
    const raw = readFileSync(resolve(host, 'presets', `${preset}.patch.yml`), 'utf8')
    assertHostPresetLedger({ preset, raw, ours: overlay.find(row => row.id === `preset-${preset}`), hostVersion })
  }
  // The rc.2 SDK is no longer installed on this host. Exercise the rc.2 branch against the frozen
  // local.5 preset bytes (rc.2 shape: compaction-basic + persona cwd suffix); this is a fixture
  // check, not a live rc.2 SDK acceptance, and no rc.2 run is claimed.
  const legacy = loadLegacy()
  for (const preset of PRESETS) {
    const row = structuredClone(legacy.find(entry => entry.id === `preset-${preset}`))
    restoreLegacySource(row.config.plugins)
    const raw = dump([{ insert: [row] }], { lineWidth: -1, noRefs: true })
    assertHostPresetLedger({ preset, raw, ours: overlay.find(entry => entry.id === `preset-${preset}`), hostVersion: '0.2.0-rc.2' })
  }
})

test('remote manifest and descriptor identities belong to the published package', () => {
  assert.equal(TYPERT.package, manifest.name)
  for (const descriptor of TYPERT.invocations) {
    assert.ok(descriptor.id.startsWith(manifest.name + '#'))
    assert.ok(descriptor.result.typeSymbol.startsWith(manifest.name + '#'))
    for (const parameter of descriptor.parameters) assert.ok(parameter.codec.typeSymbol.startsWith(manifest.name + '#'))
  }
})
