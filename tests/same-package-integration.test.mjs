import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile, readdir, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { test } from 'node:test'
import { spawnSync } from 'node:child_process'
import { fileURLToPath, pathToFileURL } from 'node:url'

const enabled = process.env.DSH_CONTEXT_HOST_INTEGRATION === '1'
const packageRoot = resolve(fileURLToPath(new URL('..', import.meta.url)))
const hostRoot = process.env.DSH_CONTEXT_HOST_SOURCE?.trim()
const skip = enabled && hostRoot ? false : 'requires the isolated frozen Host integration stage'
const BASIC = '@deepseek-ai/dsh-compaction-basic'
const ENGINE = '@missher/dsh-context-manager/engine'
const MANAGER = '@missher/dsh-context-manager'

async function loadHostModules() {
  const names = [
    '@deepseek-ai/cordis', '@deepseek-ai/cordis-plugin-include', '@deepseek-ai/cordis-plugin-group',
    '@deepseek-ai/cordis-plugin-loader', '@deepseek-ai/dsh-session-projection', '@deepseek-ai/dsh-agent-preset',
    '@deepseek-ai/dsh-agent-preset-registry', '@deepseek-ai/dsh-agent', '@deepseek-ai/dsh-agent-loop',
    '@deepseek-ai/dsh-llm', '@deepseek-ai/dsh-session', '@deepseek-ai/dsh-settings', '@deepseek-ai/dsh-storage',
    '@deepseek-ai/dsh-storage-json', '@deepseek-ai/dsh-storage-domain', '@deepseek-ai/dsh-token-meter',
    '@deepseek-ai/dsh-tools', '@deepseek-ai/dsh-system-prompt', '@deepseek-ai/dsh-session-query-sqlite',
    '@deepseek-ai/dsh-typert-registry', '@deepseek-ai/dsh-app-boot', '@deepseek-ai/dsh-compaction-basic',
  ]
  return Object.fromEntries(await Promise.all(names.map(async name => [name, await import(name)])))
}

async function linkInstallModules(install) {
  const modulesRoot = join(packageRoot, 'node_modules')
  const targetRoot = join(install, 'node_modules')
  await mkdir(targetRoot, { recursive: true })
  for (const entry of await readdir(modulesRoot)) {
    if (entry === '@example' || entry === '@missher') continue
    await symlink(join(modulesRoot, entry), join(targetRoot, entry))
  }
  await mkdir(join(targetRoot, '@example'), { recursive: true })
  await mkdir(join(targetRoot, '@missher'), { recursive: true })
  await symlink(packageRoot, join(targetRoot, '@missher', 'dsh-context-manager'))
}

function entryContext(host, id) {
  const entry = [...host.ctx.loader.entries()].find(candidate => candidate.options.id === id)
  const loaderErrors = host.loaderLogs.slice(-6).map(({ name, type, message }) =>
    `${name}/${type}: ${message.replaceAll(host.root, '<fixture>')}`)
  assert.ok(entry?.fiber, `Loader entry ${id} is not active; recent loader errors=${JSON.stringify(loaderErrors)}`)
  return entry.fiber.ctx
}

function managerFor(host, id = 'context-manager') {
  return entryContext(host, id).contextManager
}

function registryFor(host) {
  return entryContext(host, 'agent-presets').agentPresets
}

function serviceRows(storageRoot, { conflictingOwner = false } = {}) {
  const rows = [
    { id: 'llm', name: '@deepseek-ai/dsh-llm' },
    { id: 'session', name: '@deepseek-ai/dsh-session' },
    { id: 'session-projection', name: '@deepseek-ai/dsh-session-projection' },
    { id: 'typert', name: '@deepseek-ai/dsh-typert-registry' },
    { id: 'settings', name: '@deepseek-ai/dsh-settings' },
    { id: 'storage', name: '@deepseek-ai/dsh-storage' },
    { id: 'storage-json', name: '@deepseek-ai/dsh-storage-json', config: { root: storageRoot } },
    { id: 'storage-domain', name: '@deepseek-ai/dsh-storage-domain', config: { backend: 'json' } },
    { id: 'token-meter', name: '@deepseek-ai/dsh-token-meter' },
    { id: 'tools', name: '@deepseek-ai/dsh-tools' },
    { id: 'commands', name: '@deepseek-ai/dsh-commands' },
    { id: 'system-prompt', name: '@deepseek-ai/dsh-system-prompt' },
    { id: 'agent', name: '@deepseek-ai/dsh-agent' },
    { id: 'agent-loop', name: '@deepseek-ai/dsh-agent-loop', config: { agents: [] } },
    { id: 'session-query', name: '@deepseek-ai/dsh-session-query-sqlite', config: { path: ':memory:', openAt: 'never' } },
    { id: 'agent-presets', name: '@deepseek-ai/dsh-agent-preset-registry', config: { default: 'standard' } },
    { id: 'preset-standard', name: '@deepseek-ai/dsh-agent-preset', config: {
      id: 'standard', plugins: [{
        id: 'compaction', name: 'cordis:group', group: true,
        isolate: { compaction: true, toolResultPruner: true },
        config: [
          { id: 'compaction-basic', name: BASIC },
          { id: 'command-compact', name: '@deepseek-ai/dsh-command-compact' },
          { id: 'tool-result-pruner', name: '@deepseek-ai/dsh-compaction-tool-result-pruner', config: {
            thresholdChars: 8192, headChars: 4096, tailChars: 1024,
          } },
        ],
      }],
    } },
  ]
  if (conflictingOwner) rows.push({ id: 'context-test-owner', name: '@example/context-test-owner' })
  return rows
}

async function makeHost({ candidate = true, inspectorFirst = false, delayEngineServices = false,
  conflictingOwner = false, prepareOnly = false, preparedRoot, managerPolicy } = {}) {
  const root = preparedRoot ?? await mkdtemp(join(tmpdir(), 'dsh-context-same-package-'))
  const install = join(root, 'install')
  const profile = join(root, 'profile')
  const home = join(root, 'home')
  const storage = join(root, 'storage')
  const delayedServiceRows = []
  if (!preparedRoot) {
    const { dump } = await import('js-yaml')
    const bundle = join(install, 'node_modules', '@example', 'context-fixture')
    await mkdir(bundle, { recursive: true })
    await Promise.all([mkdir(profile), mkdir(home), mkdir(storage)])
    await linkInstallModules(install)

    await writeFile(join(install, 'package.json'), JSON.stringify({
      name: 'dsh-context-integration-install', version: '1.0.0',
      dependencies: {
        '@example/context-fixture': '1.0.0', '@missher/dsh-context-manager': '0.10.0-local.11',
        ...(conflictingOwner ? { '@example/context-test-owner': '1.0.0' } : {}),
      },
    }, null, 2))
    await writeFile(join(bundle, 'package.json'), JSON.stringify({
      name: '@example/context-fixture', version: '1.0.0',
      dsh: { bundle: { patch: './cordis.patch.yml' } },
    }, null, 2))
    if (conflictingOwner) {
      const ownerPackage = join(install, 'node_modules', '@example', 'context-test-owner')
      await mkdir(ownerPackage, { recursive: true })
      await writeFile(join(ownerPackage, 'package.json'), JSON.stringify({
        name: '@example/context-test-owner', version: '1.0.0', type: 'module', main: './index.js',
      }, null, 2))
      await writeFile(join(ownerPackage, 'index.js'), `export default Object.assign(async ctx => {
  await ctx.agentPresets.compactionHost.register(ctx, {
    origin: 'integration-test-owner', revision: '1', module: '${BASIC}', presets: ['standard'], requires: [],
  })
}, { inject: ['agentPresets'] })\n`)
    }

    let candidatePatches = []
    if (candidate) {
      candidatePatches = (await import('js-yaml')).load(await readFile(join(packageRoot, 'cordis.patch.yml'), 'utf8'))
      if (inspectorFirst) {
        candidatePatches = candidatePatches.map(patch => ({
          ...patch,
          insert: [...(patch.insert ?? [])].sort((a, b) => a.id === 'context-manager-inspector' ? -1 : b.id === 'context-manager-inspector' ? 1 : 0),
        }))
      }
      if (managerPolicy) {
        candidatePatches = candidatePatches.map(patch => ({
          ...patch,
          insert: (patch.insert ?? []).map(row => row.id === 'context-manager'
            ? { ...row, config: { policy: managerPolicy } } : row),
        }))
      }
    }
    const allServiceRows = serviceRows(storage, { conflictingOwner })
    const delayedServiceIds = new Set(['agent', 'agent-loop', 'llm', 'session', 'token-meter'])
    delayedServiceRows.push(...(delayEngineServices ? allServiceRows.filter(row => delayedServiceIds.has(row.id)) : []))
    const initialServiceRows = delayEngineServices
      ? allServiceRows.filter(row => !delayedServiceIds.has(row.id))
      : allServiceRows
    const bundlePatch = [
      { insert: initialServiceRows },
      ...candidatePatches,
    ]
    await writeFile(join(bundle, 'cordis.patch.yml'), dump(bundlePatch, { lineWidth: -1 }))
    await writeFile(join(profile, 'package.json'), JSON.stringify({
      name: 'dsh-context-integration-profile', private: true,
      dsh: { profile: { bundles: ['@example/context-fixture'] } },
    }, null, 2))
    await writeFile(join(profile, 'cordis.patch.yml'), dump([], { lineWidth: -1 }))

    // Include resets baseUrl to the directory containing its config. Keep that
    // config beside the synthetic installation anchor so Host package imports
    // resolve from the install's node_modules, as they do in the real app.
    await writeFile(join(install, 'cordis.yml'), dump([], { lineWidth: -1 }))
  }

  if (prepareOnly) return { root, install, profile, home, storage }

  const modules = await loadHostModules()
  const profileContext = {
    name: 'test', dir: profile, patchPath: join(profile, 'cordis.patch.yml'),
    installAnchor: join(install, 'package.json'), cwd: profile, home,
    startedBundles: ['@example/context-fixture'], overlays: [], telemetryDisabledEnv: undefined,
  }
  const layers = modules['@deepseek-ai/dsh-app-boot'].readProfilePatchLayers('dsh', profileContext)
  modules['@deepseek-ai/dsh-app-boot'].applyProfileComposition(profileContext, layers)
  const configPath = join(install, 'cordis.yml')

  const ctx = new modules['@deepseek-ai/cordis'].Context()
  const loaderLogs = []
  ctx.logger.exporter({
    levels: { default: 2 },
    export: ({ name, type, args }) => {
      if (type === 'warn' || type === 'error') loaderLogs.push({ name, type, message: args.map(String).join(' ') })
    },
  })
  ctx.baseUrl = pathToFileURL(`${install}/`).href
  ctx.provide('profileContext', profileContext)
  await ctx.plugin(modules['@deepseek-ai/cordis-plugin-loader'].default)
  ctx.loader.builtins.include = modules['@deepseek-ai/cordis-plugin-include'].default
  ctx.loader.builtins.group = modules['@deepseek-ai/cordis-plugin-group'].default
  let includeEntry
  try {
    const includeId = await ctx.loader.create({ name: 'cordis:include', config: {
      path: pathToFileURL(configPath).href, patches: layers.flatMap(layer => layer.patches),
    } })
    await ctx.loader.await()
    includeEntry = ctx.loader.resolve(includeId)
  } catch (error) {
    await ctx.fiber.dispose().catch(() => {})
    await rm(root, { recursive: true, force: true })
    throw error
  }
  return { ctx, modules, root, profile, install, layers, delayedServiceRows, includeEntry, loaderLogs }
}

async function disposeHost(host, handles = [], { preserveRoot = false } = {}) {
  const errors = []
  for (const handle of handles.reverse()) {
    try { await handle.dispose() } catch (error) { errors.push(error) }
  }
  try { await host.ctx.fiber.dispose() } catch (error) { errors.push(error) }
  if (!preserveRoot) await rm(host.root, { recursive: true, force: true })
  if (errors.length) throw new AggregateError(errors, 'synthetic Host cleanup failed')
}

async function waitFor(read, message, timeoutMs = 6000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (read()) return
    await new Promise(resolve => setTimeout(resolve, 10))
  }
  assert.ok(read(), message)
}

async function createAgent(host, suffix, { seed, provider = 'synthetic-no-call', model = 'synthetic-no-call' } = {}) {
  const { SessionId } = host.modules['@deepseek-ai/dsh-session']
  const agentLoopContext = entryContext(host, 'agent-loop')
  const registry = registryFor(host)
  return agentLoopContext.agentLoop.createAgent(agentLoopContext, {
    sessionId: SessionId(`context-integration-${suffix}`),
    ...(seed ? { seed } : {}),
    agentOptions: { provider, model },
    setup: async agentCtx => { await registry.mount(agentCtx, 'standard') },
  })
}

function oversizedHistory(host) {
  const { Session, SessionId } = host.modules['@deepseek-ai/dsh-session']
  const { createMessage, createUserMessage } = host.modules['@deepseek-ai/dsh-llm']
  const session = Session.create(SessionId('context-integration-seed'))
  session.append('turn/start', { turn: 1 })
  session.append('step/start', { turn: 1, step: 1 })
  session.append('system/message', { turn: 1, step: 1,
    message: createMessage({ role: 'system', content: [], source: { kind: 'system-prompt' } }) }, { surfaceOp: 'append' })
  session.append('user/message', createUserMessage({
    content: [{ type: 'text', text: 'synthetic prior context '.repeat(1600) }], source: { kind: 'user' },
  }), { surfaceOp: 'append' })
  session.append('assistant/message', { stream: [], turn: 1, step: 1,
    message: createMessage({ role: 'assistant', content: [{ type: 'text', text: 'previous synthetic work completed' }],
      source: { kind: 'model', provider: 'synthetic-no-call', model: 'synthetic-no-call' } }) }, { surfaceOp: 'append' })
  session.append('step/end', { turn: 1, step: 1 })
  session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
  return session.snapshotEvents()
}

function syntheticCompactionAdapter(host) {
  const { LlmAdapter, ToolCallId, resolveRetryPolicy } = host.modules['@deepseek-ai/dsh-llm']
  return new (class extends LlmAdapter {
    order = []
    requests = []
    summaries = []
    modelResolutions = []
    async resolveModel(provider, model) {
      this.modelResolutions.push({ provider, model })
      return { provider, id: model, name: model, context: { contextWindow: 16000 },
        reasoning: { efforts: [{ id: 'high', name: 'High' }] } }
    }
    providerRetryPolicy() { return resolveRetryPolicy({ mode: 'normal', maxRetries: 0 }, 'test') }
    async *stream(options) {
      if (options.purpose === 'compaction') {
        this.order.push('summary-start')
        this.summaries.push(options)
        const checkpoint = JSON.stringify({ goal: 'Complete the current task', constraints: ['Use the synthetic integration fixture'],
          completed: ['Prior synthetic context summarized'], pending: ['Run the requested task once'], evidence: [],
          next: 'Continue the current task', uncertainties: [] })
        yield { type: 'block-start', index: 0, blockType: 'text' }
        yield { type: 'block-end', index: 0, block: { type: 'text', text: checkpoint } }
        yield { type: 'usage', usage: { inputTokens: 500, outputTokens: 20, cacheReadTokens: 250 } }
        this.order.push('summary-finish')
        yield { type: 'finish', reason: { kind: 'stop' } }
        return
      }

      this.order.push('main')
      this.requests.push(options)
      if (this.requests.length === 1) {
        yield { type: 'block-start', index: 0, blockType: 'tool-call' }
        yield { type: 'block-end', index: 0, block: {
          type: 'tool-call', id: ToolCallId('loader-integration-work'), name: 'loader-integration-work', arguments: '{}',
        } }
        yield { type: 'finish', reason: { kind: 'tool-calls' } }
        return
      }
      yield { type: 'block-start', index: 0, blockType: 'text' }
      yield { type: 'block-end', index: 0, block: { type: 'text', text: 'synthetic task completed' } }
      yield { type: 'finish', reason: { kind: 'stop' } }
    }
  })()
}

test('real frozen Host Loader binds existing Agents to Context and future Agents back to the declared Basic provider', {
  skip,
  timeout: 20000,
}, async () => {
  const host = await makeHost()
  const handles = []
  try {
    await waitFor(() => managerFor(host)?.capabilityReadout().integration.state === 'registered', 'Context registration did not finish')
    const registry = registryFor(host)
    const manager = managerFor(host)
    const registration = registry.compactionHost.selected
    assert.equal(registration?.module, ENGINE)
    assert.equal(registration?.ownerFiber, manager.ctx.fiber)

    const first = await createAgent(host, 'first')
    handles.push(first)
    const firstBinding = registry.compactionHost.bindingFor(first.agent.ctx)
    assert.equal(firstBinding?.compactionProvider, ENGINE)
    assert.equal(firstBinding?.compactionSource, 'registration')
    assert.equal(firstBinding?.registrationOrigin, registration?.origin)
    assert.equal(firstBinding?.registrationRevision, registration?.revision)
    assert.equal(firstBinding?.generation > 0, true)
    assert.equal(typeof firstBinding?.owner, 'string')
    assert.equal(firstBinding?.ownerAlive, true)
    assert.equal(firstBinding?.available, true)
    assert.equal(firstBinding?.selectable, true)
    assert.equal(typeof registry.serviceFor(first.agent, 'compaction')?.prepareEmergency, 'function')
    assert.equal(manager.isEnhancedAgent(first.agent), true)

    await registration.revoke()
    assert.equal(manager.capabilityReadout().integration.state, 'inactive')
    assert.equal(registry.compactionHost.selected, undefined)
    assert.equal(registry.compactionHost.bindingFor(first.agent.ctx)?.available, true)
    assert.equal(registry.compactionHost.bindingFor(first.agent.ctx)?.ownerAlive, true)
    assert.equal(manager.isEnhancedAgent(first.agent), true)

    const second = await createAgent(host, 'second')
    handles.push(second)
    const secondBinding = registry.compactionHost.bindingFor(second.agent.ctx)
    assert.equal(secondBinding?.compactionSource, 'declaration')
    assert.equal(secondBinding?.compactionProvider, BASIC)
    assert.notEqual(typeof registry.serviceFor(second.agent, 'compaction')?.prepareEmergency, 'function')
    assert.equal(manager.isEnhancedAgent(second.agent), false)
  } finally {
    await disposeHost(host, handles)
  }
})

test('Inspector loaded before Manager waits for the real Manager and then exposes Recovery', {
  skip,
  timeout: 20000,
}, async () => {
  const host = await makeHost({ inspectorFirst: true })
  try {
    await waitFor(() => managerFor(host)?.capabilityReadout().integration.state === 'registered', 'Context registration did not finish')
    const manager = managerFor(host)
    const inspector = entryContext(host, 'context-manager-inspector').contextInspector
    assert.ok(inspector)
    const readout = await inspector.compatibility({}, new AbortController().signal)
    assert.equal(readout.state, 'supported')
    assert.equal(readout.integration.state, 'registered')
    await waitFor(() => inspector.ctx.get('contextRecovery') !== undefined,
      'Inspector did not attach Recovery', 1200)
    const recovery = inspector.ctx.get('contextRecovery')
    const recoveryManager = recovery.ctx.get('contextManager')
    assert.ok(recoveryManager, 'Recovery Context did not receive Context Manager')
    assert.equal(recoveryManager.enhancementCapable, true)
    // Cordis binds service proxies to their consumer Context, so identity is
    // not stable across this Recovery and Manager Context boundary.
    assert.deepEqual(recoveryManager.capabilityReadout(), manager.capabilityReadout())
  } finally {
    await disposeHost(host)
  }
})

test('Manager waits for Engine services before registering and binds the real Context Engine afterward', {
  skip,
  timeout: 20000,
}, async () => {
  const host = await makeHost({ delayEngineServices: true })
  try {
    await waitFor(() => managerFor(host)?.capabilityReadout().integration.state === 'pending', 'Manager did not remain pending while Engine services were absent')
    assert.equal(registryFor(host).compactionHost.selected, undefined)

    for (const row of host.delayedServiceRows) await host.includeEntry.subtree.create(row)
    await host.ctx.loader.await()
    await waitFor(() => managerFor(host).capabilityReadout().integration.state === 'registered', 'registration did not start after Engine services became ready')
    const agent = await createAgent(host, 'late-services')
    try {
      const binding = registryFor(host).compactionHost.bindingFor(agent.agent.ctx)
      assert.equal(binding?.compactionProvider, ENGINE)
      assert.equal(binding?.compactionSource, 'registration')
      assert.equal(binding?.available, true)
      assert.equal(typeof registryFor(host).serviceFor(agent.agent, 'compaction')?.prepareEmergency, 'function')
      assert.equal(managerFor(host).isEnhancedAgent(agent.agent), true)
    } finally {
      await agent.dispose()
    }
  } finally {
    await disposeHost(host)
  }
})

test('a real competing Host registration is reported as failed and remains selected', {
  skip,
  timeout: 20000,
}, async () => {
  const host = await makeHost({ conflictingOwner: true })
  try {
    await waitFor(() => managerFor(host)?.capabilityReadout().integration.state === 'failed', 'Host registration conflict was not surfaced')
    const manager = managerFor(host)
    const registry = registryFor(host)
    const readout = manager.capabilityReadout()
    assert.equal(readout.state, 'supported')
    assert.equal(readout.integration.state, 'failed')
    assert.match(readout.integration.reason ?? '', /already registered/u)
    assert.equal(registry.compactionHost.selected?.origin, 'integration-test-owner')
    assert.equal(registry.compactionHost.selected?.module, BASIC)
  } finally {
    await disposeHost(host)
  }
})

test('late Host handle delivery is idempotently revoked after Manager owner disposal', {
  skip,
  timeout: 20000,
}, async () => {
  const host = await makeHost({ candidate: false })
  const capability = registryFor(host).compactionHost
  const originalRegister = capability.register.bind(capability)
  let deliver
  let handleReady
  let lateRevokeCalls = 0
  const delivery = new Promise(resolve => { deliver = resolve })
  const ready = new Promise(resolve => { handleReady = resolve })
  capability.register = async (owner, registration) => {
    const handle = await originalRegister(owner, registration)
    const delayedHandle = new Proxy(handle, {
      get(target, property, receiver) {
        if (property === 'revoke') return async () => {
          lateRevokeCalls++
          return target.revoke()
        }
        return Reflect.get(target, property, receiver)
      },
    })
    handleReady(delayedHandle)
    await delivery
    return delayedHandle
  }

  try {
    await host.includeEntry.subtree.create({ id: 'late-context-manager', name: MANAGER })
    await host.ctx.loader.await()
    const manager = managerFor(host, 'late-context-manager')
    await ready
    assert.equal(capability.selected?.ownerFiber, manager.ctx.fiber)
    await manager.ctx.fiber.dispose()
    assert.equal(manager.capabilityReadout().integration.state, 'inactive')
    assert.equal(capability.selected, undefined)

    deliver()
    await waitFor(() => lateRevokeCalls === 1, 'late Host handle was not idempotently revoked after disposal')
    assert.equal(capability.selected, undefined)
  } finally {
    deliver?.()
    await disposeHost(host)
  }
})

test('real Host Loader compacts an oversized Agent before task/tool work and resumes exactly once', {
  skip,
  timeout: 30000,
}, async () => {
  const preparedRoot = process.env.DSH_CONTEXT_PREPARED_ROOT?.trim()
  if (!preparedRoot) {
    const prepared = await makeHost({ prepareOnly: true, managerPolicy: {
      enabled: true, capacityMode: 'percent', triggerPercent: 50, targetPercent: 10, earlyPercent: 0,
      safetyPercent: 2, summaryMaxTokens: 512, maxPasses: 1, idleEnabled: false,
    } })
    const resultPath = join(prepared.root, 'loader-replay-result.json')
    try {
      const childEnv = { ...process.env, DSH_CONTEXT_PREPARED_ROOT: prepared.root, DSH_CONTEXT_CHILD_RESULT: resultPath }
      // node:test marks its worker environment; passing that marker through
      // would make the independent cold-start runner skip its own test file.
      delete childEnv.NODE_TEST_CONTEXT
      const child = spawnSync(process.execPath, [
        '--test', '--test-concurrency=1',
        '--test-name-pattern=^real Host Loader compacts an oversized Agent before task/tool work and resumes exactly once$',
        fileURLToPath(import.meta.url),
      ], {
        cwd: packageRoot,
        env: childEnv,
        encoding: 'utf8', maxBuffer: 16 * 1024 * 1024,
      })
      const output = `${child.stdout ?? ''}${child.stderr ?? ''}`
      assert.equal(child.error, undefined, `cold-start Loader child failed to spawn: ${child.error?.message ?? ''}`)
      assert.equal(child.signal, null, `cold-start Loader child received ${child.signal}:\n${output}`)
      assert.equal(child.status, 0, `cold-start Loader integration failed:\n${output}`)
      let result
      try { result = JSON.parse(await readFile(resultPath, 'utf8')) }
      catch (error) { assert.fail(`cold-start Loader child did not report a result: ${error instanceof Error ? error.message : error}\n${output}`) }
      assert.equal(result.registration, 'registered')
      assert.deepEqual(result.order, ['summary-start', 'summary-finish', 'main', 'tool', 'main'])
      assert.equal(result.toolExecutions, 1)
      assert.equal(result.summaryAttempts, 1)
      assert.equal(result.finalReason, 'completed')
    } finally {
      await rm(prepared.root, { recursive: true, force: true })
    }
    return
  }

  const host = await makeHost({ preparedRoot })
  const handles = []
  let toolExecutions = 0
  try {
    const installAnchor = await stat(join(host.install, 'package.json'))
    const profilePatch = await stat(join(host.profile, 'cordis.patch.yml'))
    assert.ok(installAnchor.ctimeMs < performance.timeOrigin, 'the child process must start after the synthetic install anchor exists')
    assert.ok(profilePatch.ctimeMs < performance.timeOrigin, 'the child process must start after the synthetic profile patch exists')
    const managerContext = entryContext(host, 'context-manager')
    await waitFor(() => managerContext.get('contextManager')?.capabilityReadout().integration.state === 'registered',
      `Context registration did not finish; loader logs=${JSON.stringify(host.loaderLogs)}`)
    const llm = entryContext(host, 'llm').llm
    const tools = entryContext(host, 'tools').tools
    const adapter = syntheticCompactionAdapter(host)
    llm.registerAdapter(['synthetic-no-call'], adapter)
    const { defineContentToolFixture } = host.modules['@deepseek-ai/dsh-tools']
    tools.register(defineContentToolFixture({
      name: 'loader-integration-work', description: 'Synthetic side effect counted by the integration test', parameters: {},
      async execute() { toolExecutions++; adapter.order.push('tool'); return [{ type: 'text', text: 'synthetic work complete' }] },
    }))

    const created = await createAgent(host, 'automatic-compaction', { seed: oversizedHistory(host) })
    handles.push(created)
    const { agent } = created
    const registry = registryFor(host)
    const binding = registry.compactionHost.bindingFor(agent.ctx)
    assert.equal(binding?.compactionProvider, ENGINE)
    assert.equal(binding?.compactionSource, 'registration')
    assert.equal(binding?.available, true)
    assert.equal(managerFor(host).isEnhancedAgent(agent), true)

    const task = host.modules['@deepseek-ai/dsh-llm'].createUserMessage({
      content: [{ type: 'text', text: '新任务标记：请执行一次合成工作并正常结束。' }], source: { kind: 'user' },
    })
    agent.followup(task)
    await agent.whenIdle()

    const events = agent.session.snapshotEvents()
    const loopDiagnostic = JSON.stringify({
      order: adapter.order, requestCount: adapter.requests.length, summaryCount: adapter.summaries.length,
      modelResolutions: adapter.modelResolutions,
      binding: registry.compactionHost.bindingFor(agent.ctx), integration: managerFor(host).capabilityReadout().integration,
      events: events.slice(-12).map(event => ({ type: event.type, reason: event.data?.reason,
        error: event.data?.error instanceof Error ? event.data.error.message : event.data?.error,
        failure: event.data?.reason?.failure?.message, message: event.data?.message?.content?.map(block => block.text ?? block.type) })),
      loaderLogs: host.loaderLogs.slice(-8),
    })
    assert.deepEqual(adapter.order, ['summary-start', 'summary-finish', 'main', 'tool', 'main'],
      `the real Loader-registered Context Engine must settle compaction before business work; ${loopDiagnostic}`)
    assert.equal(adapter.summaries.length, 1, 'one pressure event must dispatch one synthetic summary')
    assert.equal(toolExecutions, 1, 'the business tool must not be replayed after compaction')
    assert.equal(events.filter(event => event.type === 'user/message' && event.data.id === task.id).length, 1,
      'the new task must enter the session once')
    const firstRequest = adapter.requests[0]
    const currentTask = firstRequest.messages.filter(message => message.id === task.id)
    assert.equal(currentTask.length, 1)
    assert.deepEqual(currentTask[0].content, task.content, 'the new task content must survive compaction unchanged')
    const requestBlocks = adapter.requests.flatMap(request => request.messages.flatMap(message => message.content ?? []))
    assert.equal(requestBlocks.filter(block => block.type === 'tool-call' && block.name === 'loader-integration-work').length, 1,
      'the synthetic business tool call must not be replayed')
    assert.equal(events.filter(event => event.type === 'compaction/summary').length, 1)
    const usage = managerFor(host).summaryLedger.stats(String(agent.id))
    assert.deepEqual({ input: usage?.input, output: usage?.output, cacheRead: usage?.cacheRead,
      attempts: usage?.attempts, unknownAttempts: usage?.unknownAttempts },
    { input: 750, output: 20, cacheRead: 250, attempts: 1, unknownAttempts: 0 },
    'summary provider usage must be attributed once through the loaded Context Manager')
    assert.equal(events.at(-1)?.type, 'turn/end')
    assert.equal(events.at(-1)?.data.reason.kind, 'completed', 'the resumed turn must complete normally')
    const resultPath = process.env.DSH_CONTEXT_CHILD_RESULT?.trim()
    assert.ok(resultPath, 'the cold-start child must report its integration result to the parent')
    await writeFile(resultPath, JSON.stringify({
      registration: managerFor(host).capabilityReadout().integration.state,
      order: adapter.order,
      toolExecutions,
      summaryAttempts: usage?.attempts,
      finalReason: events.at(-1)?.data.reason.kind,
    }, null, 2) + '\n')
  } finally {
    await disposeHost(host, handles, { preserveRoot: true })
  }
})
