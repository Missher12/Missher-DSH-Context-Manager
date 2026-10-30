/** Audit an immutable release tarball without installing or changing a profile. */
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { resolve } from 'node:path'
import { load } from 'js-yaml'

const root = fileURLToPath(new URL('../', import.meta.url))
const archive = resolve(process.argv[2] ?? `${root}/missher-dsh-context-manager-${JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8')).version}.tgz`)
const members = execFileSync('tar', ['-tzf', archive], { encoding: 'utf8' }).trim().split('\n').sort()
const read = name => execFileSync('tar', ['-xOf', archive, `package/${name}`], { encoding: 'utf8' })
const manifest = JSON.parse(read('package.json'))
const compatibility = JSON.parse(read('COMPATIBILITY.json'))
const inspector = Boolean(manifest.exports?.['./inspector'])
const expected = ['COMPATIBILITY.json', 'LICENSE', 'README.md', ...(manifest.files.includes('README.en.md') ? ['README.en.md'] : []), 'THIRD_PARTY_NOTICES.md', 'cordis.patch.yml',
  ...(manifest.files.includes('docs/images') ? ['docs/images/context-session-cost-desktop.png', 'docs/images/context-session-cost-narrow.png'] : []),
  'lib/archive.js', 'lib/chart-data.js', 'lib/client.js', 'lib/compatibility.js', 'lib/compaction-cycles.js', 'lib/diagnostics.js', 'lib/efficiency.js', 'lib/engine.js',
  'lib/history-tools.js', 'lib/index.js', 'lib/policy.js', 'lib/reducer.js', 'lib/tool-results.js', 'lib/working-set.js', 'package.json',
  ...(inspector ? ['lib/inspector.js', 'lib/inspector-fold.js', 'lib/typert.js'] : [])].map(p => `package/${p}`).sort()
assert.deepEqual(members, expected, 'Package must not contain another plugin, verification fixtures, or local profiles')
assert.equal(manifest.name, '@missher/dsh-context-manager')
for (const target of Object.values(manifest.exports)) {
  assert.ok(typeof target === 'string' && target.startsWith('./'), 'Exports must be package-relative')
  assert.ok(members.includes('package/' + target.slice(2)), `Missing export: ${target}`)
}
assert.ok(members.includes('package/' + manifest.dsh.bundle.patch.replace(/^\.\//, '')), 'Missing Bundle patch')
for (const [name, spec] of Object.entries({ ...manifest.dependencies, ...manifest.optionalDependencies, ...manifest.peerDependencies })) {
  assert.ok(!/^(?:file:|link:|workspace:|\/|[A-Za-z]:[\\/])/.test(spec), `Nonportable runtime dependency: ${name}`)
}
const dependencies = Object.keys({ ...manifest.dependencies, ...manifest.optionalDependencies,
  ...manifest.peerDependencies, ...manifest.devDependencies })
assert.ok(!dependencies.some(name => /^(?:@missher\/)?dsh-session-bridge(?:\/|$)/.test(name)),
  'Session Bridge must never become an install or runtime dependency')
for (const hook of ['preinstall', 'install', 'postinstall', 'preuninstall', 'uninstall', 'postuninstall']) {
  assert.equal(manifest.scripts?.[hook], undefined, `No lifecycle hook may patch other plugin files: ${hook}`)
}
assert.deepEqual(manifest.dsh.client.inject, ['@deepseek-ai/dsh-client-ui-settings', '@deepseek-ai/dsh-api-session-controller',
  ...(inspector ? ['@deepseek-ai/dsh-client-ui-conversation', '@deepseek-ai/dsh-api-remotes'] : []),
  ...(manifest.devDependencies?.['@deepseek-ai/dsh-client-ui-model-selection'] ? ['@deepseek-ai/dsh-client-ui-model-selection'] : []), '@deepseek-ai/dsh-client-locale'])
const overlayText = read('cordis.patch.yml')
const overlay = load(overlayText)
assert.equal(compatibility.bundleMode, 'neutral-runtime-capability')
assert.equal(compatibility.presetMode, 'host-declared-provider-with-read-only-fallback')
assert.equal(compatibility.overlayContract.presetSnapshots, false)
assert.equal(compatibility.overlayContract.disablesBasicProvider, false)
assert.equal(compatibility.overlayContract.insertsEngineAtRoot, false)
assert.equal(compatibility.overlayContract.runtimeCapabilityDetection, true)
const targetIds = [], insertedIds = []
for (const entry of overlay) {
  assert.ok(entry && typeof entry === 'object' && Array.isArray(entry.insert), 'Neutral overlay may only insert plugin entries')
  assert.deepEqual(Object.keys(entry), ['insert'], 'Neutral overlay cannot patch Host preset/config')
  for (const row of entry.insert) insertedIds.push(row.id)
}
assert.deepEqual(targetIds, [])
assert.deepEqual(insertedIds, ['context-manager', ...(inspector ? ['context-manager-inspector'] : [])])
assert.doesNotMatch(overlayText, /compactionProvider|compaction-basic|preset-standard|preset-ptc|preset-cordis/u)
assert.ok(!/dsh-session-bridge|dsh-sbc-|session-bridge/.test(overlayText))
for (const member of members.filter(p => p.startsWith('package/lib/'))) {
  assert.ok(!/dsh-session-bridge|dsh-sbc-|session-bridge/.test(read(member.slice('package/'.length))),
    `Foreign plugin reference in ${member}`)
}
const localBuildPath = /(?:\/home\/[^/]+\/Projects\/|\/Users\/[^/]+\/|(?:\.\.\/)+coordinator\/|node_modules\/\.pnpm\/|candidate-plugin-[^/\s]+)/u
for (const member of members) {
  assert.ok(!localBuildPath.test(read(member.slice('package/'.length))),
    `Local workspace or dependency-cache path leaked in ${member}`)
}
const result = {
  package: archive, sha256: createHash('sha256').update(readFileSync(archive)).digest('hex'),
  fileCount: members.length, containsBridgeCode: false, dependsOnBridge: false, lifecyclePatchHooks: false,
  clientProviders: manifest.dsh.client.inject, hostConfigTargets: targetIds, insertedIds,
  verificationFilesBundled: false, note: 'Read-only package audit; does not replace behavior or native UI acceptance.',
}
writeFileSync(resolve(root, 'verification/package-boundary.json'), JSON.stringify(result, null, 2) + '\n')
console.log(JSON.stringify(result, null, 2))
