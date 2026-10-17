import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { resolve } from 'node:path'
import { load } from 'js-yaml'
import { Context } from '@deepseek-ai/cordis'
import ContextManager from '../lib/index.js'
import EngineEntry from '../lib/engine.js'
import { renderCompatibility, renderOverlay } from '../scripts/generate-overlay.mjs'
import {
  BASIC_COMPACTION_MODULE,
  CONTEXT_ENGINE_MODULE,
  CONTEXT_MANAGER_ORIGIN,
  readAgentCompaction,
  resolveCompactionHost,
} from '../lib/compatibility.js'

const packageRoot = resolve(process.env.DSH_CONTEXT_PACKAGE_ROOT?.trim() || fileURLToPath(new URL('..', import.meta.url)))
const manifest = JSON.parse(readFileSync(resolve(packageRoot, 'package.json'), 'utf8'))
const compatibility = JSON.parse(readFileSync(resolve(packageRoot, 'COMPATIBILITY.json'), 'utf8'))
const overlayText = readFileSync(resolve(packageRoot, 'cordis.patch.yml'), 'utf8')
const overlay = load(overlayText)

test('the shipped overlay is neutral and leaves preset declarations to the Host', () => {
  assert.equal(compatibility.candidatePackageVersion, manifest.version)
  assert.equal(compatibility.runtimeDiagnosticVersion, manifest.version)
  assert.equal(compatibility.bundleMode, 'neutral-runtime-capability')
  assert.equal(compatibility.presetMode, 'host-declared-provider-with-read-only-fallback')
  assert.deepEqual(overlay, load(renderOverlay()))
  assert.deepEqual(overlay, [{ insert: [
    { id: 'context-manager', name: '@missher/dsh-context-manager' },
    { id: 'context-manager-inspector', name: '@missher/dsh-context-manager/inspector' },
  ] }])
  const serialized = JSON.stringify(overlay)
  assert.doesNotMatch(serialized, /preset-(standard|ptc|cordis)|dsh-compaction-basic|\/engine/u)
  assert.equal(compatibility.overlayContract.presetSnapshots, false)
  assert.equal(compatibility.overlayContract.disablesBasicProvider, false)
  assert.equal(compatibility.overlayContract.insertsEngineAtRoot, false)
  assert.equal(compatibility.priorRollback.artifactVersion, '0.10.0-local.9')
  assert.equal(compatibility.priorRollback.artifactSha256, '670e07978d98ceb0800bee021150487d1ce4c4776f3819de84e24a7d87d9c840')
})

test('compatibility metadata is deterministic and does not claim runtime proof', () => {
  assert.deepEqual(compatibility, renderCompatibility(manifest))
  assert.equal(compatibility.hostCapability.version, 1)
  assert.deepEqual(compatibility.hostCapability.selectionSemantics, ['new-bindings-only', 'future-selection-only'])
  assert.equal(compatibility.hostCapability.missingCapability.includes('Keep Host provider'), true)
  assert.equal(compatibility.overlayContract.runtimeCompatibilityIsNotProvenByGeneration, true)
  assert.match(compatibility.plannedIntegrationTarget.hostCommit, /^[0-9a-f]{40}$/u)
  assert.match(compatibility.plannedIntegrationTarget.sourceManifestSha256, /^[0-9a-f]{64}$/u)
  for (const [name, version] of Object.entries(manifest.peerDependencies)) {
    if (name.startsWith('@deepseek-ai/dsh-')) assert.equal(version, '>=0.2.0-rc.2 <0.2.1-0 || >=0.2.1-alpha.2 <0.3.0-0', name)
  }
})

test('capability probing fails closed without loading or registering provider behavior', () => {
  const calls = { register: 0, bindingFor: 0, retained: 0 }
  const valid = {
    version: 1,
    register: async () => { calls.register++; throw new Error('not expected') },
    bindingFor: () => { calls.bindingFor++; return undefined },
    retained: () => { calls.retained++; return [] },
  }
  const context = registry => ({ get: name => name === 'agentPresets' ? registry : undefined })

  assert.equal(resolveCompactionHost(context(undefined)).state, 'unknown')
  assert.equal(resolveCompactionHost(context({ compactionHost: { ...valid, version: 2 } })).state, 'unsupported')
  assert.equal(resolveCompactionHost(context({ compactionHost: { version: 1 } })).state, 'unsupported')
  assert.equal(resolveCompactionHost(context({ compactionHost: valid })).state, 'supported')
  assert.deepEqual(calls, { register: 0, bindingFor: 0, retained: 0 })
})

test('a Host without API v1 keeps Context stores and provider registration unopened', async () => {
  const ctx = new Context()
  const storageCalls = []
  const registry = { compactionHost: { version: 2, register() { storageCalls.push('register') } } }
  ctx.provide('storageDomain', new Proxy({}, { get(_target, name) {
    return (...args) => { storageCalls.push([String(name), ...args]); throw new Error('not expected') }
  } }))
  ctx.provide('agentPresets', registry)
  await ctx.plugin(ContextManager)
  try {
    assert.equal(ctx.contextManager.enhancementCapable, false)
    assert.equal(ctx.contextManager.idleStore, undefined)
    assert.equal(ctx.contextManager.summaryLedger, undefined)
    assert.deepEqual(ctx.contextManager.capabilityReadout().integration, {
      state: 'inactive', reason: ctx.contextManager.hostCapability.reason,
    })
    assert.deepEqual(storageCalls, [])
    await assert.rejects(() => EngineEntry(ctx), /Host v1 binding capability/u)
    assert.equal(ctx.get('compaction'), undefined)
  } finally {
    await ctx.fiber.dispose()
  }
})

test('classification follows each Agent binding, not the future selected provider', () => {
  const enhanced = {
    agentPreset: 'standard', owner: 'preset-standard', generation: 4, ownerAlive: true, available: true, selectable: true,
    compactionSource: 'registration', compactionProvider: CONTEXT_ENGINE_MODULE,
    registrationOrigin: CONTEXT_MANAGER_ORIGIN, registrationRevision: 'local.11',
  }
  const native = {
    agentPreset: 'custom', owner: 'preset-custom', generation: 2, ownerAlive: true, available: true, selectable: true,
    compactionSource: 'declaration', compactionProvider: BASIC_COMPACTION_MODULE,
  }
  const bindings = new Map([[{}, enhanced], [{}, native]])
  const agentContexts = [...bindings.keys()]
  const capability = {
    version: 1,
    selected: { module: CONTEXT_ENGINE_MODULE, origin: CONTEXT_MANAGER_ORIGIN },
    register: async () => { throw new Error('read path must not register') },
    bindingFor: agentContext => bindings.get(agentContext),
    retained: () => [...bindings.values()],
  }
  const context = { get: name => name === 'agentPresets' ? { compactionHost: capability } : undefined }

  assert.equal(readAgentCompaction(context, agentContexts[0]).mode, 'enhanced')
  assert.equal(readAgentCompaction(context, agentContexts[1]).mode, 'native')
  // A registration can be explicitly revoked while an already mounted Agent
  // still has a live retained binding to its generation.
  capability.selected = undefined
  assert.equal(readAgentCompaction(context, agentContexts[0]).mode, 'enhanced')
})
