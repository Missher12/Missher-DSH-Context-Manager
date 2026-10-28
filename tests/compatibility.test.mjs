import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { resolve } from 'node:path'
import { load } from 'js-yaml'
import { Context } from '@deepseek-ai/cordis'
import Storage from '@deepseek-ai/dsh-storage'
import * as StorageJson from '@deepseek-ai/dsh-storage-json'
import * as StorageDomain from '@deepseek-ai/dsh-storage-domain'
import { BasicCompactionEngine } from '@deepseek-ai/dsh-compaction-basic'
import ContextManager from '../lib/index.js'
import EngineEntry from '../lib/engine.js'
import { renderCompatibility, renderOverlay } from '../scripts/generate-overlay.mjs'
import {
  BASIC_COMPACTION_MODULE,
  CONTEXT_ENGINE_MODULE,
  CONTEXT_MANAGER_ORIGIN,
  isNativeBasicCompaction,
  readAgentCompaction,
  readContextEngineStartupState,
  resolveCompactionHost,
  resolveContextCompactionPath,
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
  assert.deepEqual(compatibility.compatibilityRanges, manifest.peerDependencies)
  assert.equal(manifest.peerDependenciesMeta?.['@deepseek-ai/dsh-app-boot']?.optional, true)
  assert.equal(compatibility.hostVersionDiagnostic?.publicFunction, 'getDshRuntimeVersion')
  assert.equal(compatibility.hostVersionDiagnostic?.peerDependencyOptional, true)
  assert.equal(compatibility.priorRollback.artifactVersion, '0.10.0-local.9')
  assert.equal(compatibility.priorRollback.artifactSha256, '670e07978d98ceb0800bee021150487d1ce4c4776f3819de84e24a7d87d9c840')
})

test('compatibility metadata updates package fields while preserving accepted and extension evidence', () => {
  const nextManifest = {
    ...manifest,
    version: '0.10.0-local.14-fixture',
    peerDependencies: {
      ...manifest.peerDependencies,
      '@deepseek-ai/dsh-agent': '^0.3.0-fixture',
    },
  }
  const pendingFutureEvidence = { status: 'not-run', note: 'future extension evidence' }
  const currentCompatibility = {
    ...structuredClone(compatibility),
    futureCompatibilityExtension: { schemaVersion: 7, retained: ['unknown-field', 'accepted-evidence'] },
    verification: {
      ...structuredClone(compatibility.verification),
      local13Package: {
        ...structuredClone(compatibility.verification.local13Package),
        futureTest: pendingFutureEvidence,
      },
    },
  }

  const rendered = renderCompatibility(nextManifest, currentCompatibility)
  const expected = {
    ...currentCompatibility,
    candidatePackageVersion: nextManifest.version,
    runtimeDiagnosticVersion: nextManifest.version,
    compatibilityRanges: nextManifest.peerDependencies,
  }
  assert.deepEqual(rendered, expected)
  assert.deepEqual(rendered.verification.acceptedCandidate, currentCompatibility.verification.acceptedCandidate)
  assert.deepEqual(rendered.futureCompatibilityExtension, currentCompatibility.futureCompatibilityExtension)
  assert.deepEqual(rendered.verification.local13Package.futureTest, pendingFutureEvidence)
  assert.equal(rendered.verification.local13Package.futureTest.status, 'not-run')
  assert.equal(rendered.hostCapability.version, 1)
  assert.deepEqual(rendered.hostCapability.selectionSemantics, ['new-bindings-only', 'future-selection-only'])
  assert.equal(rendered.hostCapability.missingCapability.includes('Keep the Host provider and user presets unchanged'), true)
  assert.equal(rendered.overlayContract.runtimeCompatibilityIsNotProvenByGeneration, true)
  assert.match(rendered.plannedIntegrationTarget.hostCommit, /^[0-9a-f]{40}$/u)
  assert.match(rendered.plannedIntegrationTarget.sourceManifestSha256, /^[0-9a-f]{64}$/u)
  for (const [name, version] of Object.entries(nextManifest.peerDependencies)) {
    assert.equal(rendered.compatibilityRanges[name], version, name)
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
  const incomplete = resolveCompactionHost(context({ compactionHost: { version: 1 } }))
  assert.equal(incomplete.state, 'unsupported')
  assert.deepEqual(incomplete.missingInterfaces, [
    'agentPresets.compactionHost.register(owner, registration)',
    'agentPresets.compactionHost.bindingFor(agentContext)',
    'agentPresets.compactionHost.retained()',
  ])
  assert.equal(resolveCompactionHost(context({ compactionHost: valid })).state, 'supported')
  assert.equal(resolveCompactionHost({ get() { throw new Error('registry read failed') } }).reasonCode, 'registry-unreadable')
  const unreadable = { version: 1 }
  Object.defineProperty(unreadable, 'register', { get() { throw new Error('member read failed') } })
  assert.equal(resolveCompactionHost(context({ compactionHost: unreadable })).reasonCode, 'compaction-host-unreadable')
  assert.deepEqual(calls, { register: 0, bindingFor: 0, retained: 0 })
})

test('sidecar startup readiness fails closed for false, missing, malformed, and throwing proofs', () => {
  const exactReason = '隔离引擎启动文件校验未通过：候选路径与启动快照不一致'
  assert.deepEqual(readContextEngineStartupState({ startupReadiness: () => ({ ready: true }) }), { state: 'ready' })
  assert.deepEqual(readContextEngineStartupState({ startupReadiness: () => ({ ready: false, reason: exactReason }) }), {
    state: 'blocked', reason: exactReason,
  })
  assert.deepEqual(readContextEngineStartupState({ startupReadiness: () => undefined }), {
    state: 'blocked', reason: '隔离引擎启动核验未通过',
  })
  assert.deepEqual(readContextEngineStartupState({}), {
    state: 'blocked', reason: '隔离引擎未公开启动核验状态',
  })
  assert.deepEqual(readContextEngineStartupState({ startupReadiness() { throw new Error('proof unavailable') } }), {
    state: 'blocked', reason: '读取隔离引擎启动核验失败：proof unavailable',
  })
})

test('request-path readout distinguishes Host registration from the plugin-owned Basic sidecar', () => {
  const unsupported = resolveCompactionHost({ get: name => name === 'agentPresets' ? { compactionHost: { version: 2 } } : undefined })
  const sidecar = resolveContextCompactionPath(unsupported, { state: 'inactive' }, 'active')
  assert.deepEqual(sidecar, { path: 'request-gate-sidecar', state: 'ready', reasonCode: 'sidecar-ready' })
  assert.deepEqual(resolveContextCompactionPath(unsupported, { state: 'inactive' }, 'pending'), {
    path: 'request-gate-sidecar', state: 'pending', reasonCode: 'sidecar-pending',
  })
  assert.deepEqual(resolveContextCompactionPath(unsupported, { state: 'inactive' }, 'inactive'), {
    path: 'host-provider-unchanged', state: 'inactive', reasonCode: 'sidecar-inactive',
  })
})

test('a Host without API v1 opens plugin-owned stores but leaves Basic provider registration alone', async t => {
  const ctx = new Context()
  const root = await mkdtemp(join(tmpdir(), 'ctx-compat-basic-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  await ctx.plugin(Storage)
  await ctx.plugin(StorageJson, { root: join(root, 'storage') })
  await ctx.plugin(StorageDomain, { backend: 'json' })
  const profile = join(root, 'profile')
  await mkdir(profile, { recursive: true })
  ctx.provide('profileContext', { dir: profile })
  let registrations = 0
  const registry = { compactionHost: { version: 2, register() { registrations++; throw new Error('not expected') } } }
  ctx.provide('agentPresets', registry)
  await ctx.plugin(ContextManager)
  try {
    assert.equal(ctx.contextManager.enhancementCapable, false)
    assert.ok(ctx.contextManager.idleStore)
    assert.ok(ctx.contextManager.summaryLedger)
    assert.deepEqual(ctx.contextManager.capabilityReadout().integration, {
      state: 'inactive', reason: ctx.contextManager.hostCapability.reason,
    })
    assert.equal(registrations, 0)
    await assert.rejects(() => EngineEntry(ctx), /Host v1 binding capability/u)
    assert.equal(ctx.get('compaction'), undefined)
  } finally {
    await ctx.fiber.dispose()
  }
})

test('an unsupported Host still reports the exact official Basic service as native', () => {
  const ctx = new Context()
  const basic = Object.create(BasicCompactionEngine.prototype)
  const CustomCompaction = class extends BasicCompactionEngine {}
  const custom = Object.create(CustomCompaction.prototype)
  const agent = service => ({ get: name => name === 'compaction' ? service : undefined })
  assert.equal(isNativeBasicCompaction(ctx, agent(basic)), true)
  assert.equal(readAgentCompaction(ctx, agent(basic)).mode, 'native')
  assert.equal(isNativeBasicCompaction(ctx, agent(custom)), false)
  assert.equal(readAgentCompaction(ctx, agent(custom)).mode, 'other')
})

test('a Cordis context-bound Basic proxy remains the exact native provider', async t => {
  const ctx = new Context()
  t.after(async () => { await ctx.fiber.dispose() })
  const basic = Object.create(BasicCompactionEngine.prototype)
  ctx.provide('compaction', basic)
  let readout
  await ctx.plugin(scope => {
    const agentContext = scope.isolate('agent')
    readout = { native: isNativeBasicCompaction(ctx, agentContext), mode: readAgentCompaction(ctx, agentContext).mode }
  })
  assert.deepEqual(readout, { native: true, mode: 'native' })
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
