import { test } from 'node:test'
import { TYPERT } from '../lib/typert.js'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { createHash } from 'node:crypto'
import { dirname, resolve } from 'node:path'
import { load, DEFAULT_SCHEMA, Type } from 'js-yaml'

const require = createRequire(import.meta.url)
const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
const compatibility = JSON.parse(readFileSync(new URL('../COMPATIBILITY.json', import.meta.url), 'utf8'))
const schema = DEFAULT_SCHEMA.extend([new Type('tag:yaml.org,2002:js', { kind: 'scalar', construct: text => ({ __jsExpr: text }) })])

test('declared runtime peers include the built SDK; generated presets preserve every host option', () => {
  for (const [name, version] of Object.entries(manifest.peerDependencies)) {
    if (!name.startsWith('@deepseek-ai/dsh-')) continue
    assert.equal(version, '*', 'Host version numbers must not block installation: ' + name)
    const installed = JSON.parse(readFileSync(require.resolve(`${name}/package.json`), 'utf8')).version
    assert.ok(compatibility.verifiedHarnessVersions.includes(installed), name)
  }
  const host = dirname(require.resolve('@deepseek-ai/dsh-web-app/package.json'))
  const overlay = load(readFileSync(new URL('../cordis.patch.yml', import.meta.url), 'utf8'), { schema })
  assert.deepEqual(overlay[0], { id: 'compaction-basic', name: '@deepseek-ai/dsh-compaction-basic', disabled: true })
  assert.deepEqual(overlay[1].insert.map(row => row.name), ['@missher/dsh-context-manager', '@missher/dsh-context-manager/engine', '@missher/dsh-context-manager/inspector'])
  for (const preset of ['standard', 'ptc', 'cordis']) {
    const raw = readFileSync(resolve(host, 'presets', `${preset}.patch.yml`), 'utf8')
    const fingerprint = compatibility.sources.find(row => row.path.endsWith(`/presets/${preset}.patch.yml`))
    assert.equal(fingerprint.sha256, createHash('sha256').update(raw).digest('hex'), preset)
    const source = load(raw, { schema }).flatMap(row => row.insert ?? []).find(row => row.id === `preset-${preset}`)
    let replacements = 0
    const replace = rows => rows.forEach(row => {
      if (row.name === '@deepseek-ai/dsh-compaction-basic') { row.name = '@missher/dsh-context-manager/engine'; replacements++ }
      if (row.group && Array.isArray(row.config)) replace(row.config)
    })
    replace(source.config.plugins)
    assert.equal(replacements, 1, preset)
    assert.deepEqual(overlay.find(row => row.id === source.id), { id: source.id, name: source.name, config: source.config })
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
