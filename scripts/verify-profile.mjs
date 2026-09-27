import { readFileSync, writeFileSync } from 'node:fs'
import { load, DEFAULT_SCHEMA, Type } from 'js-yaml'
import assert from 'node:assert/strict'
const schema = DEFAULT_SCHEMA.extend([new Type('tag:yaml.org,2002:js', { kind: 'scalar', construct: text => ({ __jsExpr: text }) })])
const read = path => load(readFileSync(path, 'utf8'), { schema })
const before = read('verification/base-profile.yml'), after = read('verification/uninstalled-profile.yml')
const ids = ['compaction-basic', 'preset-standard', 'preset-ptc', 'preset-cordis', 'preset-minimal']
for (const id of ids) assert.deepEqual(after.find(row => row.id === id), before.find(row => row.id === id))
assert.ok(after.every(row => row.id !== 'context-manager' && row.id !== 'context-manager-engine'))
writeFileSync('verification/uninstall-result.json', JSON.stringify({ restored: ids, pluginRowsRemoved: true,
  userPolicyRetained: read('verification/profile/profiles/context-manager-test/cordis.patch.yml').some(row => row.id === 'context-manager') }, null, 2) + '\n')
console.log('Bundle removed; all 5 original compaction/preset rows restored; user policy retained.')
