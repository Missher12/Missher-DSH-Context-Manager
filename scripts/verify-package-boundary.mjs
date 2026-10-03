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
const inspector = Boolean(manifest.exports?.['./inspector'])
const expected = ['COMPATIBILITY.json', 'LICENSE', 'README.md', 'THIRD_PARTY_NOTICES.md', 'cordis.patch.yml',
  'lib/chart-data.js', 'lib/client.js', 'lib/diagnostics.js', 'lib/engine.js', 'lib/index.js', 'lib/policy.js', 'package.json',
  ...(inspector ? ['lib/inspector.js', 'lib/inspector-fold.js', 'lib/typert.js'] : [])].map(p => `package/${p}`).sort()
assert.deepEqual(members, expected, 'Package must not contain another plugin, verification fixtures, or local profiles')
assert.equal(manifest.name, '@missher/dsh-context-manager')
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
const ownedTargets = new Set(['compaction-basic', 'preset-standard', 'preset-ptc', 'preset-cordis', 'preset-minimal'])
const targetIds = [], insertedIds = []
for (const entry of overlay) {
  if (entry.insert) {
    for (const row of entry.insert) insertedIds.push(row.id)
  } else {
    assert.ok(ownedTargets.has(entry.id), `Unexpected host config target: ${entry.id}`)
    targetIds.push(entry.id)
  }
}
assert.deepEqual(insertedIds, ['context-manager', 'context-manager-engine', ...(inspector ? ['context-manager-inspector'] : [])])
assert.ok(!/dsh-session-bridge|dsh-sbc-|session-bridge/.test(overlayText))
for (const member of members.filter(p => p.startsWith('package/lib/'))) {
  assert.ok(!/dsh-session-bridge|dsh-sbc-|session-bridge/.test(read(member.slice('package/'.length))),
    `Foreign plugin reference in ${member}`)
}
const result = {
  package: archive, sha256: createHash('sha256').update(readFileSync(archive)).digest('hex'),
  fileCount: members.length, containsBridgeCode: false, dependsOnBridge: false, lifecyclePatchHooks: false,
  clientProviders: manifest.dsh.client.inject, hostConfigTargets: targetIds, insertedIds,
  verificationFilesBundled: false, note: 'Read-only package audit; does not replace behavior or native UI acceptance.',
}
writeFileSync(resolve(root, 'verification/package-boundary.json'), JSON.stringify(result, null, 2) + '\n')
console.log(JSON.stringify(result, null, 2))
