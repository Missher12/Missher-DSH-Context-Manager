import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile, readdir, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { test } from 'node:test'
import { spawnSync } from 'node:child_process'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { createVolatile, updateVolatile } from '@deepseek-ai/cosmokit'
import { isNativeBasicCompaction, readAgentCompaction } from '../lib/compatibility.js'

const enabled = process.env.DSH_CONTEXT_HOST_INTEGRATION === '1'
const packageRoot = resolve(fileURLToPath(new URL('..', import.meta.url)))
const hostRoot = process.env.DSH_CONTEXT_HOST_SOURCE?.trim()
const skip = enabled && hostRoot ? false : 'requires the isolated frozen Host integration stage'
const registrySource = await readFile(join(packageRoot, 'node_modules/@deepseek-ai/dsh-agent-preset-registry/lib/index.js'), 'utf8').catch(() => '')
const skipV1 = skip || (registrySource.includes('compactionHost') ? false : 'the frozen RC.2 registry does not expose Host compaction capability v1')
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
    '@deepseek-ai/dsh-tool-bash',
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

function serviceRows(storageRoot, { conflictingOwner = false, basicAuto } = {}) {
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
          { id: 'compaction-basic', name: BASIC, ...(basicAuto === undefined ? {} : { config: { auto: basicAuto } }) },
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
  conflictingOwner = false, prepareOnly = false, preparedRoot, managerPolicy, basicAuto } = {}) {
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
    const allServiceRows = serviceRows(storage, { conflictingOwner, basicAuto })
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
  const startupAt = performance.timeOrigin
  const startupFileStats = await Promise.all([
    join(packageRoot, 'lib/engine.js'), join(install, 'package.json'), join(profile, 'cordis.patch.yml'),
  ].map(async file => {
    const info = await stat(file)
    return { file, ctimeMs: info.ctimeMs, startupAt, newerThanStartup: info.ctimeMs > startupAt }
  }))
  const profileContext = {
    name: 'test', dir: profile, patchPath: join(profile, 'cordis.patch.yml'),
    installAnchor: join(install, 'package.json'), cwd: profile, home,
    startedBundles: ['@example/context-fixture'], overlays: [], telemetryDisabledEnv: undefined,
  }
  const patches = modules['@deepseek-ai/dsh-app-boot'].readProfilePatches('dsh', profileContext)
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
      path: pathToFileURL(configPath).href, patches,
    } })
    await ctx.loader.await()
    includeEntry = ctx.loader.resolve(includeId)
  } catch (error) {
    await ctx.fiber.dispose().catch(() => {})
    await rm(root, { recursive: true, force: true })
    throw error
  }
  return { ctx, modules, root, profile, install, patches, delayedServiceRows, includeEntry, loaderLogs, startupFileStats }
}

async function runColdStartLoaderTest(name, hostOptions = {}) {
  const prepared = await makeHost({ ...hostOptions, prepareOnly: true })
  try {
    const childEnv = { ...process.env, DSH_CONTEXT_PREPARED_ROOT: prepared.root }
    delete childEnv.NODE_TEST_CONTEXT
    const child = spawnSync(process.execPath, ['--test', '--test-concurrency=1',
      `--test-name-pattern=^${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, fileURLToPath(import.meta.url)], {
      cwd: packageRoot, env: childEnv, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024,
    })
    const output = `${child.stdout ?? ''}${child.stderr ?? ''}`
    assert.equal(child.error, undefined, `cold-start Loader child failed to spawn: ${child.error?.message ?? ''}`)
    assert.equal(child.signal, null, `cold-start Loader child received ${child.signal}:\n${output}`)
    assert.equal(child.status, 0, `cold-start Loader test failed (${name}):\n${output}`)
  } finally {
    await rm(prepared.root, { recursive: true, force: true })
  }
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
  assert.ok(read(), typeof message === 'function' ? message() : message)
}

async function drainImmediateUntil(read, message, timeoutMs = 8000) {
  const deadline = performance.now() + timeoutMs
  while (performance.now() < deadline) {
    if (read()) return
    await new Promise(resolve => setImmediate(resolve))
  }
  assert.ok(read(), typeof message === 'function' ? message() : message)
}

async function createAgent(host, suffix, { seed, provider = 'synthetic-no-call', model = 'synthetic-no-call', maxTokens } = {}) {
  const { SessionId } = host.modules['@deepseek-ai/dsh-session']
  const agentLoopContext = entryContext(host, 'agent-loop')
  const registry = registryFor(host)
  return agentLoopContext.agentLoop.createAgent(agentLoopContext, {
    sessionId: SessionId(`context-integration-${suffix}`),
    ...(seed ? { seed } : {}),
    agentOptions: { provider, model, ...(maxTokens === undefined ? {} : { maxTokens }) },
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

function oversizedHistoryAt(host, targetTokens, sessionId, parts = 3) {
  const { Session, SessionId } = host.modules['@deepseek-ai/dsh-session']
  const { createMessage, createUserMessage } = host.modules['@deepseek-ai/dsh-llm']
  const meter = entryContext(host, 'token-meter').tokenMeter
  const session = Session.create(SessionId(sessionId))
  session.append('request/header', { reason: 'initial', header: { config: {
    provider: 'synthetic-no-call', model: 'synthetic-no-call', maxTokens: 16000,
  } } })
  session.append('turn/start', { turn: 1 })
  session.append('step/start', { turn: 1, step: 1 })
  session.append('system/message', { turn: 1, step: 1,
    message: createMessage({ role: 'system', content: [], source: { kind: 'system-prompt' } }) }, { surfaceOp: 'append' })
  const partTokens = Math.floor(targetTokens / parts)
  for (let part = 1; part <= parts; part++) {
    if (part > 1) {
      session.append('turn/start', { turn: part })
      session.append('step/start', { turn: part, step: 1 })
    }
    const tokens = part === parts ? targetTokens - partTokens * (parts - 1) : partTokens
    session.append('user/message', sizedMessage(meter,
      text => createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } }),
      `synthetic eligible history ${sessionId} part ${part}`, tokens), { surfaceOp: 'append' })
    session.append('assistant/message', { stream: [], turn: part, step: 1,
      message: createMessage({ role: 'assistant', content: [{ type: 'text', text: `previous synthetic work ${part} completed` }],
        source: { kind: 'model', provider: 'synthetic-no-call', model: 'synthetic-no-call' } }) }, { surfaceOp: 'append' })
    session.append('step/end', { turn: part, step: 1 })
    session.append('turn/end', { turn: part, reason: { kind: 'completed' } })
  }
  return session.snapshotEvents()
}

function registerSyntheticBash(host, execute) {
  let definition
  host.modules['@deepseek-ai/dsh-tool-bash'].apply({
    shell: {},
    systemPrompt: { section() {}, getSectionOrder() { return 0 } },
    tools: { register(tool) { definition = tool } },
    get() { return undefined },
  }, { enableRunInBackground: false })
  assert.equal(definition?.name, 'bash', 'the RC.2 SDK Bash definition supplies the output schema and renderer')
  assert.equal(typeof definition.output?.render, 'function')
  return { ...definition, execute }
}

function syntheticCompactionAdapter(host, { toolName = 'loader-integration-work', pauseSummary = false, window = 16000, mainText, summaryText, imageTokens, mainFailureOnce = false } = {}) {
  const { LlmAdapter, ToolCallId, resolveRetryPolicy } = host.modules['@deepseek-ai/dsh-llm']
  let summaryStartedResolve
  const summaryStarted = new Promise(resolve => { summaryStartedResolve = resolve })
  return new (class extends LlmAdapter {
    summaryReady = summaryStarted
    order = []
    requests = []
    summaries = []
    modelResolutions = []
    async resolveModel(provider, model) {
      this.modelResolutions.push({ provider, model })
      return { provider, id: model, name: model, context: { contextWindow: window },
        reasoning: { efforts: [{ id: 'high', name: 'High' }] } }
    }
    imageRequestPricing() {
      return imageTokens === undefined ? undefined : { priceImages: images => images.map(() => ({ visualTokens: imageTokens, text: 'synthetic attachment estimate' })) }
    }
    providerRetryPolicy() { return resolveRetryPolicy({ mode: 'normal', maxRetries: 0 }, 'test') }
    async *stream(options) {
      if (options.purpose === 'compaction') {
        this.order.push('summary-start')
        this.summaries.push(options)
        summaryStartedResolve()
        if (typeof pauseSummary === 'function') {
          await pauseSummary(options, this.summaries.length)
        } else if (pauseSummary) {
          await new Promise(resolve => {
            if (options.signal?.aborted) resolve()
            else options.signal?.addEventListener('abort', resolve, { once: true })
          })
          if (options.signal?.aborted) throw options.signal.reason ?? new Error('synthetic summary cancelled')
        }
        const checkpoint = typeof summaryText === 'function' ? summaryText(options, this.summaries.length)
          : summaryText ?? JSON.stringify({ goal: 'Complete the current task', constraints: ['Use the synthetic integration fixture'],
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
      if (mainFailureOnce && this.requests.length === 1) {
        yield { type: 'finish', reason: { kind: 'error', failure: {
          code: 'CONTEXT_WINDOW_EXCEEDED', message: 'synthetic context-window overflow for native recovery',
        } } }
        return
      }
      if (this.requests.length === 1 && toolName !== null) {
        yield { type: 'block-start', index: 0, blockType: 'tool-call' }
        yield { type: 'block-end', index: 0, block: {
          type: 'tool-call', id: ToolCallId('loader-integration-work'), name: toolName,
          arguments: JSON.stringify(toolName === 'bash' ? { command: 'synthetic integration fixture' } : {}),
        } }
        yield { type: 'finish', reason: { kind: 'tool-calls' } }
        return
      }
      yield { type: 'block-start', index: 0, blockType: 'text' }
      yield { type: 'block-end', index: 0, block: { type: 'text', text: mainText ?? 'synthetic task completed' } }
      yield { type: 'finish', reason: { kind: 'stop' } }
    }
  })()
}

function sizedMessage(meter, create, marker, targetTokens) {
  const make = length => create(`${marker} ${'x'.repeat(length)}`)
  let low = 0, high = targetTokens * 4
  while (low < high) {
    const middle = Math.floor((low + high) / 2)
    if (meter.estimateMessage(make(middle)) < targetTokens) low = middle + 1
    else high = middle
  }
  return make(low)
}

const loaderSemanticFacts = [
  '最新纠正：只有 durable commit 的结果可以改变 RISK-17 状态；failed attempt 仍未接受。',
  '唯一写者：Context integration Agent；其他执行者只能只读检查。',
  '待办：完成 RISK-17 的重启后 not_dispatched 授权重试验收。',
  '失败证据：synthetic://context-manager/recovery/risk-17-first-attempt-failed.json',
  '精确引用：commit=ctx-op-17; source=events:41-58; tool result 必须与 callId=semantic-history-call 配对。',
]

function twoSpanHistory(host, window = 100000) {
  const { Session, SessionId } = host.modules['@deepseek-ai/dsh-session']
  const { createMessage, createUserMessage, createToolResultMessage, ToolCallId } = host.modules['@deepseek-ai/dsh-llm']
  const meter = entryContext(host, 'token-meter').tokenMeter
  const session = Session.create(SessionId('context-integration-two-span-seed'))
  const appendSystem = (marker, targetTokens) => session.append('system/message', {
    turn: 1, step: 1,
    message: sizedMessage(meter, text => createMessage({ role: 'system', content: [{ type: 'text', text }],
      source: { kind: 'system-prompt' } }), marker, targetTokens),
  }, { surfaceOp: 'append' })
  const appendUser = (marker, targetTokens) => session.append('user/message', sizedMessage(meter,
    text => createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } }), marker, targetTokens),
  { surfaceOp: 'append' })
  const appendAssistant = (marker, targetTokens) => session.append('assistant/message', {
    turn: 1, step: 1, stream: [],
    message: sizedMessage(meter, text => createMessage({ role: 'assistant', content: [{ type: 'text', text }],
      source: { kind: 'model', provider: 'synthetic-no-call', model: 'synthetic-no-call' } }), marker, targetTokens),
  }, { surfaceOp: 'append' })

  session.append('turn/start', { turn: 1 })
  session.append('step/start', { turn: 1, step: 1 })
  appendSystem('fixed header', Math.floor(window * 0.02))
  const spanFacts = {
    A: [loaderSemanticFacts[0], loaderSemanticFacts[3], loaderSemanticFacts[4]],
    B: [loaderSemanticFacts[1], loaderSemanticFacts[2]],
  }
  appendUser(`segment-A\n${spanFacts.A.join('\n')}`, Math.floor(window * 0.41))
  const callId = ToolCallId('semantic-history-call')
  session.append('assistant/message', { turn: 1, step: 1, stream: [], message: createMessage({ role: 'assistant',
    content: [{ type: 'tool-call', id: callId, name: 'semantic-history-read', arguments: '{}' }],
    source: { kind: 'model', provider: 'synthetic-no-call', model: 'synthetic-no-call' } }) }, { surfaceOp: 'append' })
  session.append('tool/result', { turn: 1, step: 1, message: createToolResultMessage({ callId,
    content: [{ type: 'text', text: '失败工具结果：synthetic://context-manager/recovery/risk-17-tool-output.json' }], isError: false }) }, { surfaceOp: 'append' })
  appendAssistant('A complete', 32)
  appendSystem('protected barrier', 32)
  appendUser(`segment-B\n${spanFacts.B.join('\n')}`, Math.floor(window * 0.30))
  appendAssistant('B complete', 32)
  appendAssistant('recent retained history pair one', Math.floor(window * 0.05))
  appendAssistant('recent retained history pair two', Math.floor(window * 0.05))
  session.append('step/end', { turn: 1, step: 1 })
  session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
  return session.snapshotEvents()
}

test('RC2 Loader batches two semantic 100K spans, preserves eight growth rounds, and reloads without replay', {
  skip,
  timeout: 90000,
}, async () => {
  const managerPolicy = { enabled: true, capacityMode: 'percent', triggerPercent: 79, targetPercent: 10, earlyPercent: 0,
    recentPercent: 10, summaryPercent: 4, safetyPercent: 2, summaryMaxTokens: 8192, maxPasses: 2, idleEnabled: false,
    toolResultsMode: 'reduce', toolResultsMaxChars: 50000, toolResultsMinSavings: 100, archiveReadBudget: 6000, archiveSearchLimit: 3 }
  const preparedRoot = process.env.DSH_CONTEXT_PREPARED_ROOT?.trim()
  if (!preparedRoot) return runColdStartLoaderTest('RC2 Loader batches two semantic 100K spans, preserves eight growth rounds, and reloads without replay',
    { managerPolicy, basicAuto: false })
  let host = await makeHost({ preparedRoot, basicAuto: false })
  let handles = []
  const root = host.root
  let toolExecutions = 0
  try {
    const manager = managerFor(host)
    const llm = entryContext(host, 'llm').llm
    const meter = entryContext(host, 'token-meter').tokenMeter
    const { createMessage } = host.modules['@deepseek-ai/dsh-llm']
    const growthMessage = sizedMessage(meter,
      text => createMessage({ role: 'assistant', content: [{ type: 'text', text }],
        source: { kind: 'model', provider: 'synthetic-no-call', model: 'synthetic-no-call' } }), 'synthetic continuation growth', 10000)
    const spanFacts = {
      A: [loaderSemanticFacts[0], loaderSemanticFacts[3], loaderSemanticFacts[4]],
      B: [loaderSemanticFacts[1], loaderSemanticFacts[2]],
    }
    const adapter = syntheticCompactionAdapter(host, { toolName: 'bash', window: 100000, imageTokens: 12000,
      mainText: growthMessage.content.find(block => block.type === 'text')?.text,
      summaryText(options, round) {
        const inputText = options.messages.map(message => message.content?.map(block => block.text ?? block.type).join(' ') ?? '').join('\n')
        const requiredFacts = round === 1 ? spanFacts.A : round === 2 ? spanFacts.B
          : loaderSemanticFacts.filter(fact => inputText.includes(fact))
        for (const fact of requiredFacts) assert.ok(inputText.includes(fact), `summary round ${round} must retain its source fact ${fact}`)
        if (round === 1) {
          assert.match(inputText, /segment-A/u)
          for (const fact of spanFacts.B) assert.ok(!inputText.includes(fact), `A must not borrow B's unselected fact ${fact}`)
        }
        if (round === 2) {
          assert.match(inputText, /segment-B/u)
          for (const fact of spanFacts.A) assert.ok(!inputText.includes(fact), `B must not borrow A's unselected fact ${fact}`)
        }
        return JSON.stringify({
          goal: '完成 RISK-17 语义压缩和重启回归',
          constraints: requiredFacts.slice(0, 2),
          completed: [`保留第 ${round} 个选区已核实事实`],
          pending: requiredFacts.includes(loaderSemanticFacts[2]) ? [loaderSemanticFacts[2]] : [],
          evidence: requiredFacts.slice(2),
          next: '重载后继续 not_dispatched 授权验收，不重派已完成工具调用',
          uncertainties: ['真实业务模型语义保真尚未由合成回放证明'],
        })
      } })
    llm.registerAdapter(['synthetic-no-call'], adapter)
    const tools = entryContext(host, 'tools').tools
    const originalText = `独有工具证据：inventory=INV-2231; receipt=REC-774; source=synthetic://context-manager/tool/one-shot\n${'one-shot paired tool evidence line\n'.repeat(120)}`
    tools.register(registerSyntheticBash(host, async () => {
      toolExecutions++
      adapter.order.push('tool')
      return { kind: 'foreground', cwd: '/synthetic', exitCode: 0, signal: null, timedOut: false, aborted: false,
        timeoutMs: 120000, stdout: { text: originalText, truncated: false }, stderr: { text: '', truncated: false } }
    }))
    const created = await createAgent(host, 'two-span-batch', { seed: twoSpanHistory(host), maxTokens: 16000 })
    handles.push(created)
    const { agent } = created
    await waitFor(() => manager.cooperationReadout(agent).requestPressure === 'context', 'Context Basic pressure sidecar did not finish loading')
    const managerContext = managerFor(host)
    const id = String(agent.id)
    const { createUserMessage } = host.modules['@deepseek-ai/dsh-llm']
    const taskText = sizedMessage(entryContext(host, 'token-meter').tokenMeter,
      text => createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } }),
      'current long task: continue the pending authorized recovery check after restart', 3000).content.find(block => block.type === 'text')?.text ?? ''
    const image = { type: 'image', attachment: { attachmentId: `sha256:${'b'.repeat(64)}`, mediaType: 'image/png', bytes: 32768,
      width: 1024, height: 1024, name: 'failure-evidence.png' } }
    const task = createUserMessage({ content: [{ type: 'text', text: taskText }, image], source: { kind: 'user' } })
    const initialPressure = meter.measure(agent.session).totalTokens
    const taskTokens = meter.estimateMessage(task)
    agent.followup(task)
    await agent.whenIdle()

    const roundTasks = []
    for (let round = 1; round <= 8; round++) {
      const continuation = sizedMessage(meter,
        text => createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } }),
        `100K continuation round ${round}`, 1000)
      roundTasks.push(continuation)
      agent.followup(continuation)
      await agent.whenIdle()
    }

    const events = agent.session.snapshotEvents()
    const summaryInputs = adapter.summaries.map(options => options.messages
      .map(message => message.content?.map(block => block.text ?? block.type).join(' ') ?? '').join('\n'))
    const diagnostic = JSON.stringify({ order: adapter.order, initialPressure, taskTokens, toolExecutions,
      startupFileStats: host.startupFileStats,
      providerInputTokens: adapter.requests[0]?.messages.reduce((sum, message) => sum + meter.estimateMessage(message), 0),
      finalSessionTokens: meter.measure(agent.session).totalTokens,
      policy: manager.snapshot(), cooperation: manager.cooperationReadout(agent),
      summaryInputs,
      requests: adapter.requests.length, ledger: managerContext.summaryLedger.stats(id),
      summaryMaxTokens: adapter.summaries.map(options => options.maxTokens),
      operations: managerContext.summaryOperations.records(id),
      compactions: events.filter(event => event.type === 'compaction/summary').map(event => ({
        id: event.data.compactionId, start: event.data.shadowedRange.start, end: event.data.shadowedRange.end,
      })),
    })
    assert.ok(adapter.summaries.length >= 3, `the initial A/B batch must be followed by another real reorganization; ${diagnostic}`)
    assert.deepEqual(adapter.order.slice(0, 6), ['summary-start', 'summary-finish', 'summary-start', 'summary-finish', 'main', 'tool'], diagnostic)
    assert.match(summaryInputs[0], /segment-A/u)
    assert.doesNotMatch(summaryInputs[0], /segment-B/u)
    assert.match(summaryInputs[1], /segment-B/u)
    assert.doesNotMatch(summaryInputs[1], /segment-A/u,
      'B summarizes its disjoint source without resending A or A’s checkpoint as source')
    assert.equal(adapter.requests.length, 10, 'the business provider resumes after A/B, once after the one-shot tool, and for each continuation')
    assert.equal(adapter.requests[0].messages.filter(message => message.id === task.id).length, 1)
    assert.deepEqual(adapter.requests[0].messages.find(message => message.id === task.id)?.content, task.content)
    assert.equal(adapter.requests[0].provider, 'synthetic-no-call')
    for (const [requestIndex, request] of adapter.requests.entries()) {
      const visibleInput = request.messages.map(message => message.content?.map(block => block.text ?? block.type).join(' ') ?? '').join('\n')
      for (const fact of loaderSemanticFacts) assert.ok(visibleInput.includes(fact), `business request ${requestIndex + 1} receives ${fact}`)
    }
    assert.ok(adapter.requests[0].messages.find(message => message.id === task.id)?.content.some(block => block.type === 'image'
      && block.attachment?.name === 'failure-evidence.png'), 'the complete image attachment reaches the business model')
    assert.equal(toolExecutions, 1, 'the side-effecting business tool executes once through later compactions')
    assert.equal(events.filter(event => event.type === 'user/message' && event.data.id === task.id).length, 1)
    const summaries = events.filter(event => event.type === 'compaction/summary')
    assert.ok(summaries.length >= 3)
    assert.notDeepEqual(summaries[0].data.shadowedSeqs, summaries[1].data.shadowedSeqs,
      'the batch cannot summarize the same source events twice')
    const pairedCall = events.find(event => event.type === 'assistant/message'
      && event.data.message.content.some(block => block.type === 'tool-call' && block.name === 'semantic-history-read'))
    const pairedResult = events.find(event => event.type === 'tool/result' && event.data.message.toolCallId?.toString() === 'semantic-history-call')
    assert.ok(pairedCall && pairedResult, 'the seed contains a complete synthetic tool pair')
    assert.ok(summaries[0].data.shadowedSeqs.includes(pairedCall.seq) && summaries[0].data.shadowedSeqs.includes(pairedResult.seq),
      'the first selected span retains both sides of its historical tool pair')
    const businessCalls = events.filter(event => event.type === 'assistant/message'
      && event.data.message.content.some(block => block.type === 'tool-call' && block.name === 'bash'))
    const businessResults = events.filter(event => event.type === 'tool/result'
      && event.data.message.toolCallId?.toString() === 'loader-integration-work')
    assert.equal(businessCalls.length, 1, 'the durable business tool-call event is created once')
    assert.equal(businessResults.length, 1, 'the durable business tool result is created once')
    assert.equal(toolExecutions, 1, 'the side effect is executed once; later provider requests may include it as history')
    for (const [requestIndex, request] of adapter.requests.entries()) {
      const calls = request.messages.flatMap(message => message.content ?? []).filter(block => block.type === 'tool-call')
      const results = request.messages.filter(message => message.role === 'tool')
      for (const call of calls) {
        assert.equal(results.filter(result => result.toolCallId?.toString() === call.id?.toString()).length, 1,
          `request ${requestIndex + 1} keeps tool call ${call.id} paired with exactly one result`)
      }
    }
    const visibleToolResult = events.find(event => event.type === 'tool/result' && event.surfaceOp === 'append'
      && event.data.message.toolCallId?.toString() === 'loader-integration-work')
    assert.ok(visibleToolResult)
    const reducedText = visibleToolResult.data.message.content[0]?.text
    assert.ok(reducedText && reducedText.length < originalText.length, 'the verified pipeline publishes a shorter tool result')
    const contentId = /id=([a-f0-9]{64})/u.exec(reducedText)?.[1]
    assert.ok(contentId, 'the shortened result has a durable original reference')
    const history = await tools.execute({ name: 'context_history_read', arguments: { contentId, archive: true, limit: 6000 },
      callId: host.modules['@deepseek-ai/dsh-llm'].ToolCallId('loader-history-read'), signal: new AbortController().signal, agent })
    assert.equal(history.isError, false, JSON.stringify(history))
    assert.equal(JSON.parse(history.value).text, originalText, 'original tool evidence is retrievable byte-for-byte')
    assert.match(JSON.parse(history.value).text, /inventory=INV-2231; receipt=REC-774/)
    const operations = managerContext.summaryOperations.allRecords(id)
    assert.ok(operations.length >= 2, `the initial batch and growing rounds must leave durable operations; ${diagnostic}`)
    assert.ok(operations.every(row => row.phase === 'committed'), `every dispatched summary is individually settled; ${diagnostic}`)
    assert.equal(operations[0].ordinal, 1)
    assert.equal(operations[1].ordinal, 2)
    assert.equal(operations[0].cycle, operations[1].cycle, 'A and B remain in one durable economic cycle')
    assert.equal(operations[0].cycleWatermark, operations[1].cycleWatermark,
      'new checkpoint sequence numbers do not open a second cycle')
    const callsByCycle = new Map()
    const sourceSeqsByCycle = new Map()
    for (const operation of operations) {
      callsByCycle.set(operation.cycle, (callsByCycle.get(operation.cycle) ?? 0) + 1)
      assert.ok(callsByCycle.get(operation.cycle) <= 2, `summary cycle ${operation.cycle} exceeds two calls`)
      const summary = events.find(event => event.type === 'compaction/summary'
        && String(event.data.compactionId) === operation.compactionId)
      assert.ok(summary, `committed operation ${operation.operationId} has a matching summary event`)
      const previous = sourceSeqsByCycle.get(operation.cycle) ?? new Set()
      for (const seq of summary.data.shadowedSeqs) assert.ok(!previous.has(seq),
        `cycle ${operation.cycle} summarized source sequence ${seq} more than once`)
      for (const seq of summary.data.shadowedSeqs) previous.add(seq)
      sourceSeqsByCycle.set(operation.cycle, previous)
    }
    assert.equal(managerContext.summaryLedger.stats(id)?.attempts, operations.length)
    assert.equal(managerContext.summaryLedger.stats(id)?.unknownAttempts, 0)
    const activeCheckpoints = agent.session.surface.nodes.map(seq => agent.session.eventAt(seq))
      .filter(event => event?.type === 'user/message' && event.data.source.kind === 'compact-checkpoint')
    const activeCheckpointTokens = activeCheckpoints.reduce((sum, event) =>
      sum + entryContext(host, 'token-meter').tokenMeter.estimateMessage(event.data), 0)
    assert.ok(activeCheckpointTokens <= 4000, `active checkpoints exceed G=4K: ${activeCheckpointTokens}; ${diagnostic}`)
    assert.ok(adapter.summaries.every(options => options.maxTokens <= 3872),
      `each summary reserves framing inside the aggregate G=4K budget; got ${JSON.stringify(adapter.summaries.map(options => options.maxTokens))}`)
    assert.ok(adapter.summaries.slice(0, 2).every(options => options.maxTokens <= 1872),
      'the initial A/B batch reserves framing inside two 2K shares')
    assert.equal(adapter.requests.length, 10, 'the initial task, tool follow-up and eight continuations reach the stub once')
    for (const round of [task, ...roundTasks]) {
      assert.equal(events.filter(event => event.type === 'user/message' && event.data.id === round.id).length, 1,
        'each business task remains present exactly once')
    }
    assert.equal(isNativeBasicCompaction(host.ctx, agent.ctx, agent), true, 'Context pressure stays a sidecar; RC.2 Basic remains selected')
    assert.equal(events.at(-1)?.type, 'turn/end')
    assert.equal(events.at(-1)?.data.reason.kind, 'completed')

    const savedEvents = events
    const attemptsBeforeReload = operations.length
    await disposeHost(host, handles, { preserveRoot: true })
    host = await makeHost({ preparedRoot: root, basicAuto: false })
    handles = []
    const managerAfterReload = managerFor(host)
    const replayAdapter = syntheticCompactionAdapter(host, { toolName: null, window: 100000 })
    entryContext(host, 'llm').llm.registerAdapter(['synthetic-no-call'], replayAdapter)
    const reopened = await createAgent(host, 'two-span-batch', { seed: savedEvents, maxTokens: 16000 })
    handles.push(reopened)
    await waitFor(() => managerAfterReload.cooperationReadout(reopened.agent).requestPressure === 'context',
      'reloaded Context sidecar did not attach to the saved Agent')
    assert.equal(replayAdapter.summaries.length, 0, 'reloading does not dispatch another maintenance request')
    assert.equal(replayAdapter.requests.length, 0, 'reloading does not replay the completed business task')
    assert.equal(toolExecutions, 1, 'reloading does not repeat the business side effect')
    assert.equal(managerAfterReload.summaryLedger.stats(id)?.attempts, attemptsBeforeReload,
      'the durable usage ledger reloads with the same committed call count')
    const postReloadTask = createUserMessage({ content: [{ type: 'text', text: '重载后继续核对已授权的 RISK-17 事实，不重做已完成工具。' }], source: { kind: 'user' } })
    reopened.agent.followup(postReloadTask)
    await reopened.agent.whenIdle()
    assert.equal(replayAdapter.summaries.length, 0, 'the small post-reload continuation needs no new maintenance dispatch')
    assert.equal(replayAdapter.requests.length, 1, 'the post-reload continuation reaches the actual business adapter once')
    const reloadedInput = replayAdapter.requests[0].messages.map(message => message.content?.map(block => block.text ?? block.type).join(' ') ?? '').join('\n')
    for (const fact of loaderSemanticFacts) assert.ok(reloadedInput.includes(fact), `post-reload business input retains ${fact}`)
    assert.equal(toolExecutions, 1, 'post-reload continuation does not re-execute the historical side effect')
    assert.equal(reopened.agent.session.snapshotEvents().filter(event => event.type === 'user/message' && event.data.id === task.id).length, 1)
    assert.equal(reopened.agent.session.snapshotEvents().filter(event => event.type === 'assistant/message'
      && event.data.message.content.some(block => block.type === 'tool-call' && block.name === 'bash')).length, 1,
    'the historical business tool call remains a single durable event after reload')
    assert.equal(reopened.agent.session.snapshotEvents().filter(event => event.type === 'user/message' && event.data.id === postReloadTask.id).length, 1)
  } catch (error) {
    const detail = error instanceof Error ? { message: error.message, stack: error.stack } : { value: String(error) }
    throw new Error(`100K continuation integration failed: ${JSON.stringify(detail)}`, { cause: error })
  } finally {
    await disposeHost(host, handles)
  }
})

test('real frozen Host Loader binds existing Agents to Context and future Agents back to the declared Basic provider', {
  skip: skipV1,
  timeout: 20000,
}, async () => {
  const host = await makeHost()
  const handles = []
  try {
    await waitFor(() => managerFor(host)?.capabilityReadout().integration.state === 'registered', () => {
      const manager = entryContext(host, 'context-manager').contextManager
      const entries = [...host.ctx.loader.entries()].map(entry => ({ id: entry.options.id, name: entry.options.name, active: !!entry.fiber }))
      return `Context registration did not finish; capability=${JSON.stringify(manager?.capabilityReadout?.() ?? null)}; entries=${JSON.stringify(entries)}; loader logs=${JSON.stringify(host.loaderLogs)}`
    })
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
  skip: skipV1,
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
  skip: skipV1,
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
  skip: skipV1,
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
  skip: skipV1,
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
  skip: skipV1,
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

test('RC2 real Host Agent keeps its declared Basic provider when Host compaction API v1 is absent', {
  skip,
  timeout: 20000,
}, async () => {
  const host = await makeHost()
  const handles = []
  try {
    const manager = managerFor(host)
    const readout = manager.capabilityReadout()
    assert.equal(readout.state, 'unsupported')
    assert.equal(readout.integration.state, 'inactive')
    assert.match(readout.reason, /does not expose the compaction provider capability/u)

    const registry = registryFor(host)
    assert.equal(registry.compactionHost, undefined, 'the exact RC.2 registry has no v1 registration surface')
    const created = await createAgent(host, 'rc2-basic-preserved')
    handles.push(created)
    const { agent } = created

    const describeProvider = provider => provider === undefined ? null : ({
      name: provider.constructor?.name,
      prototype: Object.getPrototypeOf(provider)?.constructor?.name,
      compactIfNeeded: typeof provider.compactIfNeeded,
      compactNow: typeof provider.compactNow,
    })
    const serviceDetail = JSON.stringify({ preset: registry.composedPreset(agent.ctx),
      serviceFor: describeProvider(registry.serviceFor(agent, 'compaction')),
      agentContext: describeProvider(agent.ctx.get('compaction')), loaderLogs: host.loaderLogs })
    assert.equal(isNativeBasicCompaction(host.ctx, agent.ctx, agent), true, serviceDetail)
    assert.deepEqual(readAgentCompaction(host.ctx, agent.ctx, agent), {
      mode: 'native', hostCapability: 'unsupported', provider: BASIC,
      reason: 'Official Basic is active; Context sidecar capabilities are reported separately',
    })
    assert.equal(typeof registry.serviceFor(agent, 'compaction')?.compactIfNeeded, 'function')
    assert.equal(manager.isNativeBasicAgent(agent), true)
    await waitFor(() => manager.cooperationReadout(agent).requestPressure !== 'waiting', 'Context request sidecar did not report readiness')
    assert.equal(manager.cooperationReadout(agent).requestPressure, 'context')
    const inspector = entryContext(host, 'context-manager-inspector').contextInspector
    const idle = await inspector.idleStatus({ sessionId: String(agent.id) }, new AbortController().signal)
    assert.equal(idle.compression.mode, 'native')
    assert.equal(manager.isEnhancedAgent(agent), false)
  } finally {
    await disposeHost(host, handles)
  }
})

test('RC2 Loader lets Context pressure handling cooperate with Basic without replacing the Basic provider', {
  skip,
  timeout: 30000,
}, async () => {
  const originalText = 'synthetic report line\n'.repeat(120)
  const managerPolicy = {
    enabled: true, capacityMode: 'percent', triggerPercent: 50, targetPercent: 10, earlyPercent: 0,
    safetyPercent: 2, summaryMaxTokens: 512, maxPasses: 1, idleEnabled: false,
    toolResultsMode: 'reduce', toolResultsMaxChars: 50000, toolResultsMinSavings: 100,
    archiveReadBudget: 6000, archiveSearchLimit: 3,
  }
  const preparedRoot = process.env.DSH_CONTEXT_PREPARED_ROOT?.trim()
  if (!preparedRoot) return runColdStartLoaderTest('RC2 Loader lets Context pressure handling cooperate with Basic without replacing the Basic provider',
    { basicAuto: false, managerPolicy })
  const host = await makeHost({ preparedRoot })
  const handles = []
  let toolExecutions = 0
  let phase = 'initializing Basic pressure fixture'
  try {
    const manager = managerFor(host)
    const registry = registryFor(host)
    const llm = entryContext(host, 'llm').llm
    const tools = entryContext(host, 'tools').tools
    const adapter = syntheticCompactionAdapter(host, { toolName: 'bash' })
    llm.registerAdapter(['synthetic-no-call'], adapter)
    phase = 'registering synthetic business tool'
    const { defineTool } = host.modules['@deepseek-ai/dsh-tools']
    tools.register(defineTool({ name: 'bash', description: 'Synthetic shell result used only by this integration fixture',
      parameters: { command: { type: 'string', required: true } },
      output: { schema: { type: 'json' }, render: (_args, value) => [{ type: 'text', text: value.stdout.text }] },
      async execute() {
        toolExecutions++
        adapter.order.push('tool')
        return { kind: 'foreground', cwd: '/synthetic', exitCode: 0, signal: null, timedOut: false, aborted: false,
          timeoutMs: 120000, stdout: { text: originalText, truncated: false }, stderr: { text: '', truncated: false } }
      },
    }))
    const created = await createAgent(host, 'basic-pressure', { seed: oversizedHistory(host) })
    handles.push(created)
    const { agent } = created
    phase = 'waiting for Context pressure sidecar'
    await waitFor(() => manager.cooperationReadout(agent).requestPressure === 'context',
      'Context request sidecar did not start for the RC.2 Agent')
    const provider = registry.serviceFor(agent, 'compaction')
    assert.equal(isNativeBasicCompaction(host.ctx, agent.ctx, agent), true)
    assert.equal(typeof provider?.compactIfNeeded, 'function')
    assert.equal(manager.isEnhancedAgent(agent), false)
    assert.equal(manager.cooperationReadout(agent).requestPressure, 'context')

    const task = host.modules['@deepseek-ai/dsh-llm'].createUserMessage({
      content: [{ type: 'text', text: '新任务标记：请执行一次合成工作并正常结束。' }], source: { kind: 'user' },
    })
    phase = 'running synthetic tool task and Context compaction'
    agent.followup(task)
    await agent.whenIdle()

    const events = agent.session.snapshotEvents()
    const records = manager.summaryOperations.allRecords(String(agent.id))
    const diagnostic = JSON.stringify({ order: adapter.order, summaries: adapter.summaries.length, requests: adapter.requests.length,
      startupFileStats: host.startupFileStats,
      cooperation: manager.cooperationReadout(agent), capability: manager.capabilityReadout(),
      operations: manager.summaryOperations.records(String(agent.id)),
      events: events.slice(-16).map(event => ({ type: event.type, reason: event.data?.reason,
        failure: event.data?.reason?.failure?.message, error: event.data?.error instanceof Error ? event.data.error.message : event.data?.error })),
      loaderLogs: host.loaderLogs.slice(-8) })
    assert.deepEqual(adapter.order, ['summary-start', 'summary-finish', 'main', 'tool', 'main'], diagnostic)
    assert.equal(adapter.summaries.length, 1)
    assert.equal(toolExecutions, 1)
    assert.equal(events.filter(event => event.type === 'user/message' && event.data.id === task.id).length, 1)
    assert.equal(events.filter(event => event.type === 'compaction/summary').length, 1)
    const visibleToolResult = events.find(event => event.type === 'tool/result' && event.surfaceOp === 'append')
    assert.ok(visibleToolResult)
    const reducedText = visibleToolResult.data.message.content[0]?.text
    assert.ok(reducedText && reducedText.length < originalText.length * 0.5,
      'the actual Loader tool-result pipeline publishes a shorter verified result')
    const contentId = /id=([a-f0-9]{64})/u.exec(reducedText)?.[1]
    assert.ok(contentId, 'the shortened result contains a scoped original reference')
    const reduction = manager.reductionReadout(String(agent.id))
    assert.equal(reduction.pipelineReported, true)
    assert.equal(reduction.published.references, 1)
    assert.equal(reduction.published.originalChars, originalText.length)
    const history = await tools.execute({ name: 'context_history_read', arguments: { contentId, archive: true, limit: 6000 },
      callId: host.modules['@deepseek-ai/dsh-llm'].ToolCallId('loader-history-read'),
      signal: new AbortController().signal, agent })
    assert.equal(history.isError, false, JSON.stringify(history))
    const restored = JSON.parse(history.value)
    assert.equal(restored.status, 'ok')
    assert.equal(restored.text, originalText, 'the registered history tool retrieves the exact original bytes')
    const committed = records.filter(row => row.phase === 'committed')
    assert.equal(committed.length, 1)
    assert.equal(committed[0].usageComplete, true)
    assert.equal(events.at(-1)?.type, 'turn/end')
    assert.equal(events.at(-1)?.data.reason.kind, 'completed')
    assert.equal(isNativeBasicCompaction(host.ctx, agent.ctx, agent), true,
      'Context must leave the native Basic binding selected for this Agent')
    assert.equal(typeof registry.serviceFor(agent, 'compaction')?.compactIfNeeded, 'function',
      'the selected Basic service remains callable after Context pressure handling')
  } catch (error) {
    const detail = { phase, startupFileStats: host.startupFileStats,
      error: error instanceof Error ? { message: error.message, stack: error.stack } : { value: String(error) } }
    throw new Error(`Basic pressure integration failed: ${JSON.stringify(detail)}`, { cause: error })
  } finally {
    await disposeHost(host, handles)
  }
})

test('RC2 Loader keeps default Basic auto and Context pressure as separate one-shot paths', {
  skip,
  timeout: 60000,
}, async () => {
  const managerPolicy = { enabled: true, capacityMode: 'percent', triggerPercent: 95, targetPercent: 55, earlyPercent: 0,
    recentPercent: 10, summaryPercent: 4, safetyPercent: 2, summaryMaxTokens: 1024, maxPasses: 2, idleEnabled: false }
  const name = 'RC2 Loader keeps default Basic auto and Context pressure as separate one-shot paths'
  const preparedRoot = process.env.DSH_CONTEXT_PREPARED_ROOT?.trim()
  if (!preparedRoot) return runColdStartLoaderTest(name, { managerPolicy })
  const host = await makeHost({ preparedRoot })
  const handles = []
  let phase = 'starting default Basic profile'
  let releaseAdapter
  let activeAdapter
  try {
    const manager = managerFor(host)
    const registry = registryFor(host)
    const llm = entryContext(host, 'llm').llm
    const tools = entryContext(host, 'tools').tools
    const { defineContentToolFixture } = host.modules['@deepseek-ai/dsh-tools']
    let toolExecutions = 0
    tools.register(defineContentToolFixture({ name: 'loader-integration-work', description: 'One-shot synthetic side effect', parameters: {},
      async execute() { toolExecutions++; activeAdapter?.order.push('tool'); return [{ type: 'text', text: `synthetic side effect ${toolExecutions}` }] } }))
    const meter = entryContext(host, 'token-meter').tokenMeter
    const image = name => ({ type: 'image', attachment: { attachmentId: `sha256:${(name === 'basic-evidence' ? 'b' : 'c').repeat(64)}`, mediaType: 'image/png',
      bytes: 8192, width: 512, height: 512, name: `${name}.png` } })
    const task = (marker, attachmentName, textTokens) => {
      const text = sizedMessage(meter,
        value => host.modules['@deepseek-ai/dsh-llm'].createUserMessage({ content: [{ type: 'text', text: value }], source: { kind: 'user' } }),
        marker, textTokens).content.find(block => block.type === 'text')?.text ?? ''
      return host.modules['@deepseek-ai/dsh-llm'].createUserMessage({
        content: [{ type: 'text', text }, image(attachmentName)], source: { kind: 'user' },
      })
    }

    phase = 'running Basic-first with the unmodified auto default'
    const basicAdapter = syntheticCompactionAdapter(host, { window: 200000, imageTokens: 4000 })
    activeAdapter = basicAdapter
    releaseAdapter = llm.registerAdapter(['synthetic-no-call'], basicAdapter)
    const basicSeed = oversizedHistoryAt(host, 170000, 'basic-auto-first')
    const basicCreated = await createAgent(host, 'basic-auto-first', { seed: basicSeed, maxTokens: 16000 })
    handles.push(basicCreated)
    const basicAgent = basicCreated.agent
    await waitFor(() => manager.cooperationReadout(basicAgent).requestPressure === 'context', 'Context request sidecar did not attach to Basic-first Agent')
    const basicProvider = registry.serviceFor(basicAgent, 'compaction')
    const basicMeter = entryContext(host, 'token-meter').tokenMeter
    const basicRoute = basicAgent.session.requestHeader()?.config
    assert.equal(isNativeBasicCompaction(host.ctx, basicAgent.ctx, basicAgent), true)
    assert.equal(basicProvider?.config?.auto, true, 'the profile omits auto:false and the frozen Basic default remains enabled')
    assert.equal(basicProvider?.config?.thresholdRatio, 0.8)
    assert.equal(basicProvider?.config?.headroomTokens, 65536)
    const basicThreshold = Math.floor(Math.min(200000 * basicProvider.config.thresholdRatio,
      200000 - (basicRoute?.maxTokens ?? 0) - basicProvider.config.headroomTokens))
    assert.equal(basicThreshold, 118464, 'RC.2 pressure uses min(80% of window, window minus output reserve and default headroom)')
    assert.ok(basicMeter.measure(basicAgent.session).totalTokens > basicThreshold,
      'the Basic-first history exceeds the actual 118,464-token threshold before the current task is added')
    const basicTask = task('Basic-first task with preserved image attachment', 'basic-evidence', 1200)
    basicAgent.followup(basicTask)
    await basicAgent.whenIdle()
    const basicEvents = basicAgent.session.snapshotEvents()
    const basicId = String(basicAgent.id)
    const basicHeader = basicAgent.session.requestHeader()
    const basicDiagnostic = JSON.stringify({ order: basicAdapter.order, summaries: basicAdapter.summaries.length,
      requests: basicAdapter.requests.length, toolExecutions, ledger: manager.summaryLedger.stats(basicId),
      operations: manager.summaryOperations.records(basicId), readout: manager.cooperationReadout(basicAgent),
      measuredTokens: basicMeter.measure(basicAgent.session).totalTokens,
      requestRoute: { config: basicHeader?.config, tools: basicHeader?.tools?.map(tool => tool.name) },
      modelResolutions: basicAdapter.modelResolutions,
      loaderLogs: host.loaderLogs.slice(-8) })
    assert.deepEqual(basicAdapter.order, ['summary-start', 'summary-finish', 'main', 'tool', 'main'], basicDiagnostic)
    assert.equal(basicAdapter.summaries.length, 1, 'default Basic auto condenses the high-pressure history once before Context admission')
    assert.equal(manager.summaryOperations.records(basicId).length, 0, 'the native Basic call is not charged to Context operation limits')
    assert.equal(manager.summaryLedger.stats(basicId)?.attempts ?? 0, 0,
      'native Basic usage stays outside Context summary ledger and cycle budgets')
    assert.equal(basicEvents.filter(event => event.type === 'compaction/summary').length, 1)
    assert.equal(toolExecutions, 1, 'Basic-first retry does not repeat the tool side effect')
    assert.deepEqual(basicAdapter.requests[0].messages.find(message => message.id === basicTask.id)?.content, basicTask.content,
      'the complete text and image attachment reach the first business request after Basic compaction')
    assert.equal(basicAdapter.requests[0].messages.find(message => message.id === basicTask.id)?.content.at(-1)?.attachment?.name,
      'basic-evidence.png')
    assert.equal(basicEvents.at(-1)?.type, 'turn/end')
    assert.equal(basicEvents.at(-1)?.data.reason.kind, 'completed')

    phase = 'switching the Context gate below the actual 118,464-token Basic auto threshold'
    const contextPolicy = { ...manager.snapshot(), triggerPercent: 50, targetPercent: 10, maxPasses: 1 }
    updateVolatile(manager.config.policy, createVolatile(contextPolicy))
    host.ctx.emit('settings/document-updated', 'context-manager', 2)
    releaseAdapter()
    releaseAdapter = undefined

    phase = 'running Context-first while default Basic auto remains below threshold'
    const contextAdapter = syntheticCompactionAdapter(host, { window: 200000, imageTokens: 2000 })
    activeAdapter = contextAdapter
    releaseAdapter = llm.registerAdapter(['synthetic-no-call'], contextAdapter)
    const contextSeed = oversizedHistoryAt(host, 105000, 'context-auto-first')
    const contextCreated = await createAgent(host, 'context-auto-first', { seed: contextSeed, maxTokens: 16000 })
    handles.push(contextCreated)
    const contextAgent = contextCreated.agent
    await waitFor(() => manager.cooperationReadout(contextAgent).requestPressure === 'context', 'Context sidecar did not attach to Context-first Agent')
    const contextProvider = registry.serviceFor(contextAgent, 'compaction')
    const contextRoute = contextAgent.session.requestHeader()?.config
    assert.equal(isNativeBasicCompaction(host.ctx, contextAgent.ctx, contextAgent), true)
    assert.equal(contextProvider?.config?.auto, true)
    const contextBasicThreshold = Math.floor(Math.min(200000 * contextProvider.config.thresholdRatio,
      200000 - (contextRoute?.maxTokens ?? 0) - contextProvider.config.headroomTokens))
    assert.equal(contextBasicThreshold, basicThreshold)
    assert.ok(meter.measure(contextAgent.session).totalTokens < contextBasicThreshold,
      'the Context-first 105K history stays below Basic auto so only the Context gate dispatches')
    const contextTask = task('Context-first task with a complete image attachment', 'context-evidence', 1000)
    contextAgent.followup(contextTask)
    await contextAgent.whenIdle()
    const contextEvents = contextAgent.session.snapshotEvents()
    const contextId = String(contextAgent.id)
    const contextDiagnostic = JSON.stringify({ order: contextAdapter.order, summaries: contextAdapter.summaries.length,
      requests: contextAdapter.requests.length, toolExecutions, ledger: manager.summaryLedger.stats(contextId),
      operations: manager.summaryOperations.records(contextId), readout: manager.cooperationReadout(contextAgent),
      loaderLogs: host.loaderLogs.slice(-8) })
    assert.deepEqual(contextAdapter.order, ['summary-start', 'summary-finish', 'main', 'tool', 'main'], contextDiagnostic)
    assert.equal(contextAdapter.summaries.length, 1, 'Context compacts once; Basic auto does not add a second summary')
    assert.equal(contextEvents.filter(event => event.type === 'compaction/summary').length, 1)
    const contextOperations = manager.summaryOperations.allRecords(contextId)
    assert.equal(contextOperations.length, 1)
    assert.equal(contextOperations[0].phase, 'committed')
    assert.equal(manager.summaryLedger.stats(contextId)?.attempts, 1,
      'the Context request-pressure call is separately represented in the Context ledger')
    assert.equal(manager.summaryLedger.stats(contextId)?.input, 750,
      'Context ledger input includes both uncached and cache-read input tokens from the provider usage receipt')
    assert.equal(manager.summaryLedger.stats(contextId)?.output, 20)
    assert.equal(toolExecutions, 2, 'each Agent executes its single synthetic side effect once')
    const contextRequest = contextAdapter.requests[0]
    assert.deepEqual(contextRequest.messages.find(message => message.id === contextTask.id)?.content, contextTask.content,
      'the complete current text and image pass through the Context-first request retry unchanged')
    assert.equal(contextEvents.filter(event => event.type === 'user/message' && event.data.id === contextTask.id).length, 1)
    assert.equal(contextEvents.at(-1)?.type, 'turn/end')
    assert.equal(contextEvents.at(-1)?.data.reason.kind, 'completed')
  } catch (error) {
    const detail = { phase, startupFileStats: host?.startupFileStats,
      error: error instanceof Error ? { message: error.message, stack: error.stack } : { value: String(error) } }
    throw new Error(`Default Basic and Context Loader coexistence failed: ${JSON.stringify(detail)}`, { cause: error })
  } finally {
    releaseAdapter?.()
    await disposeHost(host, handles)
  }
})

test('RC2 Loader Basic idle sidecar commits once and reloads its durable ledger without replay', {
  skip,
  timeout: 45000,
}, async t => {
  const managerPolicy = { enabled: true, capacityMode: 'percent', triggerPercent: 95, targetPercent: 10, earlyPercent: 0,
    safetyPercent: 2, summaryMaxTokens: 512, maxPasses: 1, idleEnabled: true, idleMinutes: 1, idleMinPercent: 10 }
  const preparedRoot = process.env.DSH_CONTEXT_PREPARED_ROOT?.trim()
  if (!preparedRoot) return runColdStartLoaderTest('RC2 Loader Basic idle sidecar commits once and reloads its durable ledger without replay',
    { basicAuto: false, managerPolicy })
  let host = await makeHost({ preparedRoot })
  let handles = []
  const root = host.root
  let phase = 'initializing Basic idle fixture'
  try {
    const manager = managerFor(host)
    const llm = entryContext(host, 'llm').llm
    const adapter = syntheticCompactionAdapter(host, { toolName: null })
    llm.registerAdapter(['synthetic-no-call'], adapter)
    const created = await createAgent(host, 'basic-idle-reload', { seed: oversizedHistory(host), maxTokens: 2048 })
    handles.push(created)
    phase = 'checking Basic idle Agent state'
    const { agent } = created
    const id = String(agent.id)
    await waitFor(() => manager.cooperationReadout(agent).requestPressure === 'context',
      'the RC.2 Basic request sidecar did not activate')
    const registry = registryFor(host)
    assert.equal(isNativeBasicCompaction(host.ctx, agent.ctx, agent), true)
    assert.equal(manager.cooperationReadout(agent).idleMaintenance, 'active')
    const measured = entryContext(host, 'token-meter').tokenMeter.measure(agent.session).totalTokens
    assert.ok(measured > 16000 * 0.1, `synthetic history must exceed the idle floor; measured=${measured}`)
    assert.ok(measured < 16000 * 0.95, `the initial request must stay below admission; measured=${measured}`)

    t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: Date.now() })
    phase = 'running initial idle-eligible task'
    const task = host.modules['@deepseek-ai/dsh-llm'].createUserMessage({
      content: [{ type: 'text', text: '等待任务完成后由闲置侧路整理旧合成历史。' }], source: { kind: 'user' },
    })
    agent.followup(task)
    await agent.whenIdle()
    await drainImmediateUntil(() => manager.idleStatus(id).status === 'scheduled',
      () => `Basic idle plan was not scheduled: ${JSON.stringify({ status: manager.idleStatus(id), startupFileStats: host.startupFileStats })}`)
    assert.equal(adapter.summaries.length, 0, 'the initial request remains below the Context admission threshold')
    const dueAt = manager.idleStatus(id).dueAt
    assert.equal(typeof dueAt, 'number')
    phase = 'advancing idle timer and waiting for compaction'
    t.mock.timers.tick(Math.max(0, dueAt - Date.now()))
    await drainImmediateUntil(() => manager.idleStore.get(id)?.status === 'completed',
      () => `Basic maintenance did not commit: ${JSON.stringify(manager.idleStatus(id))}`)
    await agent.whenIdle()
    assert.equal(adapter.summaries.length, 1)
    assert.equal(agent.session.snapshotEvents().filter(event => event.type === 'compaction/summary').length, 1)
    assert.equal(manager.summaryLedger.stats(id)?.attempts, 1)
    assert.equal(manager.summaryLedger.stats(id)?.unknownAttempts, 0)
    assert.equal(isNativeBasicCompaction(host.ctx, agent.ctx, agent), true,
      'idle maintenance must leave the native Basic binding selected')
    assert.equal(typeof registry.serviceFor(agent, 'compaction')?.compactIfNeeded, 'function',
      'the selected Basic service remains callable after idle maintenance')

    const savedEvents = agent.session.snapshotEvents()
    await disposeHost(host, handles, { preserveRoot: true })
    phase = 'reloading durable idle ledger'
    host = await makeHost({ preparedRoot: root })
    handles = []
    const managerAfterReload = managerFor(host)
    const llmAfterReload = entryContext(host, 'llm').llm
    const replayAdapter = syntheticCompactionAdapter(host, { toolName: null })
    llmAfterReload.registerAdapter(['synthetic-no-call'], replayAdapter)
    const reopened = await createAgent(host, 'basic-idle-reload', { seed: savedEvents, maxTokens: 2048 })
    handles.push(reopened)
    await drainImmediateUntil(() => managerAfterReload.idleStore.get(id)?.status === 'completed',
      () => `completed idle settlement did not reload before the Agent was inspected: ${JSON.stringify(managerAfterReload.idleStatus(id))}`)
    assert.equal(managerAfterReload.summaryLedger.stats(id)?.attempts, 1)
    t.mock.timers.tick(24 * 60 * 60 * 1000)
    for (let turn = 0; turn < 4; turn++) await new Promise(resolve => setImmediate(resolve))
    assert.equal(replayAdapter.summaries.length, 0, 'a completed checkpoint is not billed again after restart')
    assert.equal(managerAfterReload.summaryLedger.stats(id)?.attempts, 1)
    assert.equal(isNativeBasicCompaction(host.ctx, reopened.agent.ctx, reopened.agent), true)
  } catch (error) {
    const detail = { phase, startupFileStats: host?.startupFileStats,
      error: error instanceof Error ? { message: error.message, stack: error.stack } : { value: String(error) } }
    throw new Error(`Basic idle integration failed: ${JSON.stringify(detail)}`, { cause: error })
  } finally {
    if (host) await disposeHost(host, handles, { preserveRoot: false })
    else await rm(root, { recursive: true, force: true })
  }
})

test('RC2 Loader cancels a paused Basic idle summary for queued input and never replays its unknown receipt', {
  skip,
  timeout: 45000,
}, async t => {
  const managerPolicy = { enabled: true, capacityMode: 'percent', triggerPercent: 95, targetPercent: 10, earlyPercent: 0,
    safetyPercent: 2, summaryMaxTokens: 512, maxPasses: 1, idleEnabled: true, idleMinutes: 1, idleMinPercent: 10 }
  const preparedRoot = process.env.DSH_CONTEXT_PREPARED_ROOT?.trim()
  if (!preparedRoot) return runColdStartLoaderTest('RC2 Loader cancels a paused Basic idle summary for queued input and never replays its unknown receipt',
    { managerPolicy })
  let host = await makeHost({ preparedRoot })
  let handles = []
  const root = host.root
  let phase = 'initializing Basic idle cancellation fixture'
  let restoreIdleSettle = () => {}
  try {
    const manager = managerFor(host)
    const store = manager.idleStore
    const originalSettle = store.settle
    const settlements = []
    store.settle = async (...args) => {
      const result = await originalSettle.apply(store, args)
      settlements.push({ eligibility: args[0], attemptId: args[1], outcome: args[2], result })
      return result
    }
    restoreIdleSettle = () => { store.settle = originalSettle }
    const llm = entryContext(host, 'llm').llm
    const adapter = syntheticCompactionAdapter(host, { toolName: 'loader-integration-work', pauseSummary: true })
    llm.registerAdapter(['synthetic-no-call'], adapter)
    let toolExecutions = 0
    const tools = entryContext(host, 'tools').tools
    const { defineContentToolFixture } = host.modules['@deepseek-ai/dsh-tools']
    tools.register(defineContentToolFixture({ name: 'loader-integration-work', description: 'One-shot synthetic side effect', parameters: {},
      async execute() { toolExecutions++; return [{ type: 'text', text: 'synthetic idle cancellation side effect' }] } }))
    const created = await createAgent(host, 'basic-idle-cancel', { seed: oversizedHistory(host), maxTokens: 2048 })
    handles.push(created)
    phase = 'scheduling first idle-eligible task'
    const { agent } = created
    const id = String(agent.id)
    await waitFor(() => manager.cooperationReadout(agent).requestPressure === 'context',
      'the RC.2 Basic request sidecar did not activate')
    assert.equal(registryFor(host).serviceFor(agent, 'compaction')?.config?.auto, true,
      'this cancellation path keeps the native Basic automatic default enabled')
    t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: Date.now() })
    const firstTask = host.modules['@deepseek-ai/dsh-llm'].createUserMessage({
      content: [{ type: 'text', text: '先完成任务，再等闲置压缩进入可取消状态。' }], source: { kind: 'user' },
    })
    agent.followup(firstTask)
    await agent.whenIdle()
    await drainImmediateUntil(() => manager.idleStatus(id).status === 'scheduled',
      () => `idle cancellation fixture did not schedule: ${JSON.stringify({ status: manager.idleStatus(id), startupFileStats: host.startupFileStats })}`)
    const oldQualification = manager.idleStore.get(id)
    assert.ok(oldQualification)
    t.mock.timers.tick(Math.max(0, manager.idleStatus(id).dueAt - Date.now()))
    await drainImmediateUntil(() => adapter.summaries.length === 1,
      () => `idle summary did not start: ${JSON.stringify(manager.idleStatus(id))}`)
    await adapter.summaryReady
    assert.equal(store.get(id)?.status, 'started', `the idle attempt must be durably started before cancellation: ${JSON.stringify(store.get(id))}`)

    phase = 'checking native manual compact mutual exclusion while Context idle work owns maintenance'
    const nativeProvider = registryFor(host).serviceFor(agent, 'compaction')
    assert.ok(nativeProvider?.compactNow, 'the real RC.2 native provider exposes the command path under test')
    let manualRejected = false
    try { await nativeProvider.compactNow(agent, new AbortController().signal) }
    catch { manualRejected = true }
    assert.equal(manualRejected, true, 'native /compact cannot overlap the Context idle maintenance transaction')
    assert.equal(adapter.summaries.length, 1, 'manual contention does not dispatch a second summary')

    const queuedTask = host.modules['@deepseek-ai/dsh-llm'].createUserMessage({
      content: [{ type: 'text', text: '新队列任务必须在取消闲置摘要后完整执行一次。' }], source: { kind: 'user' },
    })
    phase = 'queueing input to cancel the active idle summary'
    agent.followup(queuedTask)
    await agent.whenIdle()
    await drainImmediateUntil(() => settlements.some(row => row.eligibility.turnEndSeq === oldQualification.turnEndSeq
      && row.outcome.status === 'cancelled' && row.result?.status === 'cancelled'),
    () => `the old idle qualification did not settle as cancelled: ${JSON.stringify({ status: manager.idleStatus(id),
      settlements, stored: manager.idleStore.all(), ledger: manager.summaryLedger.stats(id), order: adapter.order,
      events: agent.session.snapshotEvents().slice(-12).map(event => ({ type: event.type, reason: event.data?.reason })) })}`)
    const events = agent.session.snapshotEvents()
    assert.equal(events.filter(event => event.type === 'user/message' && event.data.id === queuedTask.id).length, 1)
    assert.equal(events.filter(event => event.type === 'turn/end' && event.data.reason.kind === 'completed').length, 3,
      'the seed turn and both delivered tasks completed')
    assert.equal(adapter.requests.length, 3, 'the first tool call plus both user tasks reach the business provider once')
    assert.equal(toolExecutions, 1, 'the paused idle cancel and queued retry never replay the first task side effect')
    assert.equal(events.filter(event => event.type === 'compaction/summary').length, 0,
      'the paused idle candidate never replaces source history')
    const ledger = manager.summaryLedger.stats(id)
    assert.ok((ledger?.attempts ?? 0) >= 1)
    assert.ok((ledger?.unknownAttempts ?? 0) >= 1, 'an aborted dispatched summary keeps its unknown cost')
    const savedEvents = events

    await disposeHost(host, handles, { preserveRoot: true })
    host = await makeHost({ preparedRoot: root })
    handles = []
    const managerAfterReload = managerFor(host)
    const replayAdapter = syntheticCompactionAdapter(host, { toolName: null })
    entryContext(host, 'llm').llm.registerAdapter(['synthetic-no-call'], replayAdapter)
    const reopened = await createAgent(host, 'basic-idle-cancel', { seed: savedEvents, maxTokens: 2048 })
    handles.push(reopened)
    assert.ok((managerAfterReload.summaryLedger.stats(id)?.unknownAttempts ?? 0) >= 1,
      'the unknown settlement survives the real storage reload')
    assert.equal(replayAdapter.summaries.length, 0, 'reload cannot silently retry the unknown idle call')
    assert.equal(replayAdapter.requests.length, 0, 'reload cannot replay either completed user task or tool call')
  } catch (error) {
    const detail = { phase, startupFileStats: host?.startupFileStats,
      error: error instanceof Error ? { message: error.message, stack: error.stack } : { value: String(error) } }
    throw new Error(`Basic idle cancellation integration failed: ${JSON.stringify(detail)}`, { cause: error })
  } finally {
    restoreIdleSettle()
    if (host) await disposeHost(host, handles, { preserveRoot: false })
    else await rm(root, { recursive: true, force: true })
  }
})

test('RC2 Loader verifies command-compact mutual exclusion in both directions around pending Context idle work', {
  skip,
  timeout: 60000,
}, async t => {
  const name = 'RC2 Loader verifies command-compact mutual exclusion in both directions around pending Context idle work'
  const managerPolicy = { enabled: true, capacityMode: 'percent', triggerPercent: 95, targetPercent: 10, earlyPercent: 0,
    safetyPercent: 2, summaryMaxTokens: 512, maxPasses: 1, idleEnabled: true, idleMinutes: 1, idleMinPercent: 10 }
  const preparedRoot = process.env.DSH_CONTEXT_PREPARED_ROOT?.trim()
  if (!preparedRoot) return runColdStartLoaderTest(name, { managerPolicy })
  const host = await makeHost({ preparedRoot })
  const handles = []
  let phase = 'starting default Basic with the Context idle sidecar active'
  let releaseManualSummary = () => {}
  let releaseActivity = () => {}
  let removeActivity = () => {}
  let restoreIdleSettle = () => {}
  try {
    const manager = managerFor(host)
    const idleStore = manager.idleStore
    const originalSettle = idleStore.settle
    const settlements = []
    idleStore.settle = async (...args) => {
      const result = await originalSettle.apply(idleStore, args)
      settlements.push({ eligibility: args[0], attemptId: args[1], outcome: args[2], result })
      return result
    }
    restoreIdleSettle = () => { idleStore.settle = originalSettle }
    const llm = entryContext(host, 'llm').llm
    const adapter = syntheticCompactionAdapter(host, { toolName: null, window: 200000,
      pauseSummary: async (options, round) => {
        if (round === 1) {
          await new Promise(resolve => {
            if (options.signal?.aborted) resolve()
            else options.signal?.addEventListener('abort', resolve, { once: true })
          })
          throw options.signal?.reason ?? new Error('synthetic idle summary cancelled')
        }
        if (round === 2) await new Promise(resolve => { releaseManualSummary = resolve })
      } })
    llm.registerAdapter(['synthetic-no-call'], adapter)
    const created = await createAgent(host, 'compact-command-mutual-exclusion', {
      seed: oversizedHistoryAt(host, 105000, 'compact-command-mutual-exclusion'), maxTokens: 16000,
    })
    handles.push(created)
    const { agent } = created
    const id = String(agent.id)
    const commands = entryContext(host, 'commands').commands
    const nativeBasic = registryFor(host).serviceFor(agent, 'compaction')
    assert.equal(nativeBasic?.config?.auto, true, 'the frozen RC.2 Basic auto default remains enabled')
    await waitFor(() => manager.cooperationReadout(agent).requestPressure === 'context', 'Context idle sidecar did not attach')
    t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: Date.now() })

    phase = 'starting a completed turn and waiting for Context idle to enter its first summary'
    agent.followup(host.modules['@deepseek-ai/dsh-llm'].createUserMessage({
      content: [{ type: 'text', text: '安排 Context 闲置整理互斥验证。' }], source: { kind: 'user' },
    }))
    await agent.whenIdle()
    await drainImmediateUntil(() => manager.idleStatus(id).status === 'scheduled', () => JSON.stringify(manager.idleStatus(id)))
    const firstQualification = idleStore.get(id)
    assert.ok(firstQualification)
    t.mock.timers.tick(Math.max(0, manager.idleStatus(id).dueAt - Date.now()))
    await drainImmediateUntil(() => adapter.summaries.length === 1, () => JSON.stringify(manager.idleStatus(id)))
    const idleStarts = agent.session.snapshotEvents().filter(event => event.type === 'compaction/start')
    assert.equal(idleStarts.length, 1)
    assert.equal(idleStarts[0].data.sourceCommandId, undefined, 'the Context idle transaction has no command owner')

    phase = 'calling the real /compact command while Context idle owns Agent maintenance'
    const busyCommand = await commands.execute(agent, '/compact', [], new AbortController().signal)
    assert.equal(busyCommand?.result.kind, 'error')
    assert.equal(busyCommand?.result.text,
      'Compaction is unavailable because this process has an active compaction, or the agent is not idle.')
    assert.equal(adapter.summaries.length, 1, 'the refused command does not dispatch a second summary')
    let events = agent.session.snapshotEvents()
    let run = events.findLast(event => event.type === 'command/run' && event.data.name === 'compact')
    let done = events.findLast(event => event.type === 'command/done' && event.data.commandId === run?.data.commandId)
    assert.ok(run && done)
    assert.equal(done.data.kind, 'error')
    assert.equal(String(done.data.commandId), String(run.data.commandId))
    assert.equal(events.filter(event => event.type === 'compaction/start').length, 1,
      'the refused native command opens no overlapping compaction transaction')

    phase = 'cancelling the first idle job and producing a fresh idle qualification'
    agent.followup(host.modules['@deepseek-ai/dsh-llm'].createUserMessage({
      content: [{ type: 'text', text: '取消第一轮后，重新安排闲置检查。' }], source: { kind: 'user' },
    }))
    await agent.whenIdle()
    await drainImmediateUntil(() => settlements.some(row => row.eligibility.turnEndSeq === firstQualification.turnEndSeq
      && row.outcome.status === 'cancelled' && row.result?.status === 'cancelled'),
    () => JSON.stringify({ idle: manager.idleStatus(id), stored: idleStore.get(id), settlements, order: adapter.order }))
    await drainImmediateUntil(() => manager.idleStatus(id).status === 'scheduled', () => JSON.stringify(manager.idleStatus(id)))
    const secondQualification = idleStore.get(id)
    assert.ok(secondQualification)

    phase = 'holding the real Context idle activity preflight through the public Host waterfall'
    let activityEntered = false
    const activityGate = Promise.withResolvers()
    removeActivity = host.ctx.on('workspace/session-activity', async ({ sessionId }, next) => {
      if (String(sessionId) !== id) return next()
      activityEntered = true
      await activityGate.promise
      return []
    })
    t.mock.timers.tick(Math.max(0, manager.idleStatus(id).dueAt - Date.now()))
    await drainImmediateUntil(() => activityEntered && manager.idleStatus(id).status === 'checking',
      'Context idle did not reach the asynchronous activity preflight')

    phase = 'starting the real Basic /compact command while Context idle waits at activity preflight'
    const manualPromise = commands.execute(agent, '/compact', [], new AbortController().signal)
    await drainImmediateUntil(() => adapter.summaries.length === 2,
      () => JSON.stringify({ idle: manager.idleStatus(id), order: adapter.order }))
    events = agent.session.snapshotEvents()
    run = events.findLast(event => event.type === 'command/run' && event.data.name === 'compact')
    const manualStart = events.findLast(event => event.type === 'compaction/start')
    assert.ok(run && manualStart)
    assert.equal(String(manualStart.data.sourceCommandId), String(run.data.commandId),
      'Basic manual compaction start is paired with the actual /compact commandId')
    assert.ok(['cancelled', 'failed'].includes(manager.idleStatus(id).status),
      `the pending Context idle attempt must leave its preflight when Basic starts; observed ${JSON.stringify(manager.idleStatus(id))}`)
    assert.equal(adapter.summaries.length, 2, 'Context idle has not overlapped the in-flight Basic summary')

    phase = 'releasing stale activity and checking the durable idle cancellation'
    activityGate.resolve()
    await drainImmediateUntil(() => settlements.some(row => row.eligibility.turnEndSeq === secondQualification.turnEndSeq
      && row.outcome.status === 'cancelled' && row.result?.status === 'cancelled'),
    () => JSON.stringify({ idle: manager.idleStatus(id), stored: idleStore.get(id), settlements, order: adapter.order }))
    assert.equal(adapter.summaries.length, 2, 'releasing stale activity cannot dispatch another Context summary')
    assert.equal(manager.summaryOperations.records(id).length, 1,
      'the preflight-only Context idle cancellation creates no summary receipt')
    assert.deepEqual(adapter.order.filter(item => item.startsWith('summary')), ['summary-start', 'summary-start'])

    phase = 'settling and checking Basic command lifecycle pairing'
    releaseManualSummary()
    const manual = await manualPromise
    assert.equal(manual?.result.kind, 'success')
    events = agent.session.snapshotEvents()
    const commandRun = events.findLast(event => event.type === 'command/run' && event.data.name === 'compact')
    const commandDone = events.findLast(event => event.type === 'command/done' && event.data.commandId === commandRun?.data.commandId)
    const starts = events.filter(event => event.type === 'compaction/start')
    const ends = events.filter(event => event.type === 'compaction/end')
    assert.equal(starts.length, 2, 'only the first Context idle attempt and one Basic command opened transactions')
    assert.equal(ends.length, 2, 'each opened transaction has a closing marker')
    const successfulStart = starts.find(event => String(event.data.sourceCommandId) === String(commandRun?.data.commandId))
    const successfulEnd = ends.find(event => String(event.data.compactionId) === String(successfulStart?.data.compactionId))
    assert.ok(commandRun && commandDone && successfulStart && successfulEnd)
    assert.equal(String(commandDone.data.commandId), String(commandRun.data.commandId))
    assert.equal(String(successfulEnd.data.sourceCommandId), String(commandRun.data.commandId))
    assert.equal(adapter.summaries.length, 2)
    assert.equal(manager.summaryOperations.records(id).length, 1,
      'only the Context idle call is charged to the Context operation ledger; Basic stays native')
    assert.equal(isNativeBasicCompaction(host.ctx, agent.ctx, agent), true,
      'the native Basic provider remains selected after both contention directions')
  } catch (error) {
    const detail = { phase, startupFileStats: host.startupFileStats,
      error: error instanceof Error ? { message: error.message, stack: error.stack } : { value: String(error) } }
    throw new Error(`Basic command and Context idle mutual exclusion failed: ${JSON.stringify(detail)}`, { cause: error })
  } finally {
    restoreIdleSettle()
    releaseActivity()
    removeActivity()
    releaseManualSummary()
    await disposeHost(host, handles)
  }
})

test('RC2 Loader drains a pending Context summary on owner disposal and preserves Basic for the same Agent', {
  skip,
  timeout: 60000,
}, async t => {
  const name = 'RC2 Loader drains a pending Context summary on owner disposal and preserves Basic for the same Agent'
  const managerPolicy = { enabled: true, capacityMode: 'percent', triggerPercent: 50, targetPercent: 10, earlyPercent: 0,
    safetyPercent: 2, recentTokens: 20000, summaryMaxTokens: 512, maxPasses: 1, idleEnabled: true, idleMinutes: 1, idleMinPercent: 10 }
  const preparedRoot = process.env.DSH_CONTEXT_PREPARED_ROOT?.trim()
  if (!preparedRoot) return runColdStartLoaderTest(name, { managerPolicy })
  const host = await makeHost({ preparedRoot })
  const handles = []
  let phase = 'starting the same Agent under the native Basic provider and Context request sidecar'
  let releaseLateProvider = () => {}
  try {
    const manager = managerFor(host)
    const llm = entryContext(host, 'llm').llm
    let summarySignal
    let summaryEntered = false
    const adapter = syntheticCompactionAdapter(host, { toolName: null, window: 200000,
      pauseSummary: async (options, round) => {
        if (round === 1) {
          summarySignal = options.signal
          summaryEntered = true
          await new Promise(resolve => { releaseLateProvider = resolve })
        }
      } })
    llm.registerAdapter(['synthetic-no-call'], adapter)
    const created = await createAgent(host, 'context-owner-dispose-drain', {
      seed: oversizedHistoryAt(host, 105000, 'context-owner-dispose-drain'), maxTokens: 16000,
    })
    handles.push(created)
    const { agent } = created
    const id = String(agent.id)
    const nativeBasic = registryFor(host).serviceFor(agent, 'compaction')
    const commands = entryContext(host, 'commands').commands
    await waitFor(() => manager.cooperationReadout(agent).requestPressure === 'context', 'Context sidecar did not attach')
    assert.equal(nativeBasic?.config?.auto, true, 'default Basic auto remains selected and enabled')

    phase = 'starting the Context request-pressure summary and holding its provider stream'
    const cancelledTask = host.modules['@deepseek-ai/dsh-llm'].createUserMessage({
      content: [{ type: 'text', text: '开始 Context 请求前压缩，随后只卸载 Context 所有者。' }], source: { kind: 'user' },
    })
    agent.followup(cancelledTask)
    await drainImmediateUntil(() => summaryEntered && adapter.summaries.length === 1,
      () => JSON.stringify({ order: adapter.order, ledger: manager.summaryLedger.stats(id) }))
    const startsBeforeDispose = agent.session.snapshotEvents().filter(event => event.type === 'compaction/start')
    assert.equal(startsBeforeDispose.length, 1)
    const ownerFiber = manager.ctx.fiber
    assert.ok(ownerFiber?.dispose, 'the manager Context exposes its owner fiber for isolated unload')

    phase = 'disposing only the Context manager owner, then draining late provider output'
    const disposeOwner = ownerFiber.dispose()
    await waitFor(() => summarySignal?.aborted === true, 'Context owner disposal did not abort the pending summary')
    releaseLateProvider()
    await Promise.race([disposeOwner, new Promise((_, reject) => setTimeout(() => reject(new Error('Context owner drain exceeded 15s')), 15000))])
    await agent.whenIdle()

    let events = agent.session.snapshotEvents()
    let starts = events.filter(event => event.type === 'compaction/start')
    let ends = events.filter(event => event.type === 'compaction/end')
    assert.equal(adapter.summaries.length, 1, 'owner disposal does not replay the summary request')
    assert.equal(events.filter(event => event.type === 'compaction/summary').length, 0,
      'late checkpoint content is drained for accounting and never committed')
    assert.equal(starts.length, 1)
    assert.equal(ends.length, 1, 'the cancelled Context transaction closes its start marker')
    assert.equal(String(ends[0].data.compactionId), String(starts[0].data.compactionId))
    assert.ok(ends[0].data.error, 'the canceled transaction closes as an error without replacing history')
    const ledger = manager.summaryLedger.stats(id)
    assert.deepEqual({ input: ledger?.input, output: ledger?.output, cacheRead: ledger?.cacheRead,
      cacheWrite: ledger?.cacheWrite, attempts: ledger?.attempts, unknownAttempts: ledger?.unknownAttempts },
    { input: 750, output: 20, cacheRead: 250, cacheWrite: 0, attempts: 1, unknownAttempts: 0 },
    'the late provider usage is recorded exactly once and the delivered cost is not left unknown')
    assert.equal(ledger?.recent.length, 1)
    assert.equal(ledger?.recent[0].status, 'cancelled')
    assert.deepEqual({ input: ledger?.recent[0].input, output: ledger?.recent[0].output, cacheRead: ledger?.recent[0].cacheRead },
      { input: 750, output: 20, cacheRead: 250 })
    const operationRecords = manager.summaryOperations.allRecords(id)
    assert.equal(operationRecords.length, 1)
    assert.notEqual(operationRecords[0].phase, 'running', 'owner drain settles the dispatched operation before closing storage')
    assert.equal(isNativeBasicCompaction(host.ctx, agent.ctx, agent), true,
      'disposing Context leaves the same Agent bound to its original Basic provider')

    phase = 'running a fresh task and manual Basic command on the same Agent after Context unload'
    const followupTask = host.modules['@deepseek-ai/dsh-llm'].createUserMessage({
      content: [{ type: 'text', text: 'Context 已卸载后，这条新任务由原生 Agent 继续处理一次。' }], source: { kind: 'user' },
    })
    agent.followup(followupTask)
    await agent.whenIdle()
    assert.equal(adapter.requests.length, 1, 'only the newly submitted business task reaches the provider')
    assert.deepEqual(adapter.requests[0].messages.find(message => message.id === followupTask.id)?.content, followupTask.content)
    assert.equal(agent.session.snapshotEvents().filter(event => event.type === 'user/message' && event.data.id === cancelledTask.id).length, 1,
      'the canceled input remains once in history and is not automatically replayed')

    const manualPromise = commands.execute(agent, '/compact', [], new AbortController().signal)
    await drainImmediateUntil(() => adapter.summaries.length === 2,
      () => JSON.stringify({ order: adapter.order, provider: registryFor(host).serviceFor(agent, 'compaction')?.constructor?.name }))
    const commandRun = agent.session.snapshotEvents().findLast(event => event.type === 'command/run' && event.data.name === 'compact')
    const manualStart = agent.session.snapshotEvents().findLast(event => event.type === 'compaction/start')
    assert.ok(commandRun && manualStart)
    assert.equal(String(manualStart.data.sourceCommandId), String(commandRun.data.commandId))
    const manual = await manualPromise
    assert.equal(manual?.result.kind, 'success')
    assert.deepEqual({ input: manager.summaryLedger.stats(id)?.input, output: manager.summaryLedger.stats(id)?.output,
      attempts: manager.summaryLedger.stats(id)?.attempts, unknownAttempts: manager.summaryLedger.stats(id)?.unknownAttempts },
    { input: 750, output: 20, attempts: 1, unknownAttempts: 0 },
    'the native Basic manual summary stays outside the disposed Context ledger')
    events = agent.session.snapshotEvents()
    starts = events.filter(event => event.type === 'compaction/start')
    ends = events.filter(event => event.type === 'compaction/end')
    assert.equal(starts.length, 2)
    assert.equal(ends.length, 2)
    assert.equal(events.filter(event => event.type === 'compaction/summary').length, 1,
      'only the later native Basic manual command commits a summary')
    assert.equal(isNativeBasicCompaction(host.ctx, agent.ctx, agent), true)
  } catch (error) {
    const detail = { phase, startupFileStats: host.startupFileStats,
      error: error instanceof Error ? { message: error.message, stack: error.stack } : { value: String(error) } }
    throw new Error(`Context owner drain with live Basic failed: ${JSON.stringify(detail)}`, { cause: error })
  } finally {
    releaseLateProvider()
    await disposeHost(host, handles)
  }
})

test('RC2 Loader runs native Basic before Context on the same task and retains native overflow recovery', {
  skip,
  timeout: 60000,
}, async t => {
  const name = 'RC2 Loader runs native Basic before Context on the same task and retains native overflow recovery'
  const managerPolicy = { enabled: true, capacityMode: 'percent', triggerPercent: 50, targetPercent: 10, earlyPercent: 0,
    safetyPercent: 2, recentTokens: 20000, summaryMaxTokens: 512, maxPasses: 1, idleEnabled: false, idleMinutes: 1, idleMinPercent: 10 }
  const preparedRoot = process.env.DSH_CONTEXT_PREPARED_ROOT?.trim()
  if (!preparedRoot) return runColdStartLoaderTest(name, { managerPolicy })
  const host = await makeHost({ preparedRoot })
  const handles = []
  let phase = 'starting default Basic and Context sidecar without changing Basic auto'
  let releaseAdapter
  try {
    const manager = managerFor(host)
    const llm = entryContext(host, 'llm').llm
    const tools = entryContext(host, 'tools').tools
    const { defineContentToolFixture } = host.modules['@deepseek-ai/dsh-tools']
    let toolExecutions = 0
    let activeAdapter
    const meter = entryContext(host, 'token-meter').tokenMeter
    let agentForPressure
    const pressureAtSummary = []
    tools.register(defineContentToolFixture({ name: 'loader-integration-work', description: 'One-shot synthetic side effect', parameters: {},
      async execute() { toolExecutions++; activeAdapter?.order.push('tool'); return [{ type: 'text', text: 'native Basic then Context synthetic effect' }] } }))
    const initialAdapter = syntheticCompactionAdapter(host, { window: 200000, imageTokens: 0,
      pauseSummary: async (_options, round) => { pressureAtSummary[round - 1] = meter.measure(agentForPressure.session).totalTokens } })
    activeAdapter = initialAdapter
    releaseAdapter = llm.registerAdapter(['synthetic-no-call'], initialAdapter)
    const created = await createAgent(host, 'basic-then-context-same-task', {
      seed: oversizedHistoryAt(host, 170000, 'basic-then-context-same-task', 5), maxTokens: 16000,
    })
    handles.push(created)
    const { agent } = created
    agentForPressure = agent
    const id = String(agent.id)
    const provider = registryFor(host).serviceFor(agent, 'compaction')
    assert.equal(provider?.config?.auto, true, 'the profile omits auto:false and retains frozen RC.2 Basic auto')
    assert.equal(provider?.config?.thresholdRatio, 0.8)
    assert.equal(provider?.config?.headroomTokens, 65536)
    await waitFor(() => manager.cooperationReadout(agent).requestPressure === 'context', 'Context sidecar did not attach')
    const before = meter.measure(agent.session).totalTokens
    const basicThreshold = Math.floor(Math.min(200000 * provider.config.thresholdRatio,
      200000 - 16000 - provider.config.headroomTokens))
    assert.equal(basicThreshold, 118464)
    assert.ok(before > basicThreshold)
    assert.ok(before >= 170000 && before < 171000,
      `five history segments should create approximately 170K pressure inside the 200K window; got ${before}`)
    const taskText = sizedMessage(meter,
      value => host.modules['@deepseek-ai/dsh-llm'].createUserMessage({
        content: [{ type: 'text', text: value }], source: { kind: 'user' },
      }), 'same task must survive both native and Context summaries', 70000)
    const taskMessage = host.modules['@deepseek-ai/dsh-llm'].createUserMessage({
      content: [...taskText.content, { type: 'image', attachment: {
        attachmentId: `sha256:${'d'.repeat(64)}`, mediaType: 'image/png', bytes: 4096, width: 256, height: 256, name: 'serial-evidence.png',
      } }], source: { kind: 'user' },
    })

    phase = 'forcing default Basic pressure compaction followed by the Context request gate'
    agent.followup(taskMessage)
    await agent.whenIdle()
    let events = agent.session.snapshotEvents()
    const summaries = events.filter(event => event.type === 'compaction/summary')
    const diagnostic = JSON.stringify({ order: initialAdapter.order, pressureAtSummary,
      summaries: summaries.map(event => ({ id: event.data.compactionId, seqs: event.data.shadowedSeqs })),
      measured: meter.measure(agent.session).totalTokens, threshold: basicThreshold, ledger: manager.summaryLedger.stats(id),
      operations: manager.summaryOperations.records(id), requests: initialAdapter.requests.length, tools: toolExecutions })
    assert.deepEqual(initialAdapter.order, ['summary-start', 'summary-finish', 'summary-start', 'summary-finish', 'main', 'tool', 'main'], diagnostic)
    assert.equal(summaries.length, 2, 'one default Basic summary and one Context summary are both needed on this task')
    assert.ok(pressureAtSummary[0] > basicThreshold,
      `the first native Basic summary must see its actual pressure above ${basicThreshold}; observed ${pressureAtSummary}`)
    assert.ok(pressureAtSummary[1] > 100000 && pressureAtSummary[1] < basicThreshold,
      `after Basic and before Context, the 70K input and remaining pressure must cross Context's 100K line but stay below Basic's ${basicThreshold}; observed ${pressureAtSummary}`)
    const spans = summaries.map(event => event.data.shadowedSeqs)
    assert.ok(spans[0].length > 0 && spans[1].length > 0)
    assert.ok(spans[0].some(seq => !spans[1].includes(seq)) && spans[1].some(seq => !spans[0].includes(seq)),
      'each serial summary advances to a changed source span rather than replaying the same selection')
    assert.equal(manager.summaryOperations.records(id).length, 1,
      'the native Basic operation stays outside the Context operation ledger')
    const contextOperation = manager.summaryOperations.records(id)[0]
    assert.equal(contextOperation.phase, 'committed', 'the Context request gate must durably commit its own summary')
    assert.equal(String(contextOperation.compactionId), String(summaries[1].data.compactionId),
      'the committed Context operation must identify the second emitted summary')
    assert.equal(manager.summaryLedger.stats(id)?.attempts, 1,
      'only the Context request-pressure call contributes to Context summary usage')
    assert.equal(manager.summaryLedger.stats(id)?.input, 750)
    assert.equal(manager.summaryLedger.stats(id)?.output, 20)
    assert.equal(toolExecutions, 1, 'the business side effect runs once after both serial summaries')
    assert.deepEqual(initialAdapter.requests[0].messages.find(message => message.id === taskMessage.id)?.content, taskMessage.content,
      'the full new text and attachment reach the business request after both compaction paths')
    assert.equal(events.filter(event => event.type === 'user/message' && event.data.id === taskMessage.id).length, 1)
    assert.equal(events.at(-1)?.type, 'turn/end')
    assert.equal(events.at(-1)?.data.reason.kind, 'completed')

    phase = 'installing a one-overflow native recovery adapter while Context remains enabled below its gate'
    releaseAdapter()
    releaseAdapter = undefined
    const overflowAdapter = syntheticCompactionAdapter(host, { window: 200000, toolName: null, mainFailureOnce: true })
    releaseAdapter = llm.registerAdapter(['synthetic-no-call'], overflowAdapter)
    const overflowCreated = await createAgent(host, 'native-basic-overflow-recovery', {
      seed: oversizedHistoryAt(host, 70000, 'native-basic-overflow-recovery'), maxTokens: 16000,
    })
    handles.push(overflowCreated)
    const overflowAgent = overflowCreated.agent
    const overflowId = String(overflowAgent.id)
    const overflowProvider = registryFor(host).serviceFor(overflowAgent, 'compaction')
    assert.equal(overflowProvider?.config?.auto, true, 'the overflow path also retains default Basic auto')
    await waitFor(() => manager.cooperationReadout(overflowAgent).requestPressure === 'context',
      'Context request gate did not attach to the native overflow recovery Agent')

    phase = 'executing one native CONTEXT_WINDOW_EXCEEDED recovery and bounded retry'
    const overflowTask = host.modules['@deepseek-ai/dsh-llm'].createUserMessage({
      content: [{ type: 'text', text: '真实 Basic overflow recovery fixture，只能自动重试一次。' }], source: { kind: 'user' },
    })
    const overflowBefore = meter.measure(overflowAgent.session).totalTokens
    const overflowInput = meter.estimateMessage(overflowTask)
    assert.equal(manager.snapshot().enabled, true, 'Context remains enabled during native overflow recovery')
    assert.ok(overflowBefore + overflowInput < 100000,
      `overflow starts below the Context 50% admission line: ${overflowBefore}+${overflowInput}`)
    overflowAgent.followup(overflowTask)
    await overflowAgent.whenIdle()
    const overflowEvents = overflowAgent.session.snapshotEvents()
    const overflowStarts = overflowEvents.filter(event => event.type === 'compaction/start')
    const overflowEnds = overflowEvents.filter(event => event.type === 'compaction/end')
    assert.equal(overflowAdapter.requests.length, 2, 'one overflow response is followed by exactly one retried business request')
    assert.deepEqual(overflowAdapter.order, ['main', 'summary-start', 'summary-finish', 'main'])
    assert.equal(overflowStarts.length, 1, 'Basic compactIfNeeded(context-overflow) opens one transaction')
    assert.equal(overflowEnds.length, 1)
    assert.equal(String(overflowEnds[0].data.compactionId), String(overflowStarts[0].data.compactionId))
    assert.equal(overflowEvents.filter(event => event.type === 'compaction/summary').length, 1)
    assert.equal(overflowEvents.at(-1)?.type, 'turn/end')
    assert.equal(overflowEvents.at(-1)?.data.reason.kind, 'completed', 'the native recovery ends in one completed turn')
    assert.equal(overflowAgent.session.snapshotEvents().filter(event => event.type === 'user/message' && event.data.id === overflowTask.id).length, 1)
    assert.equal(manager.summaryOperations.records(overflowId).length, 0,
      'native overflow usage does not enter Context operation limits or ledger')
    assert.equal(manager.summaryLedger.stats(overflowId)?.attempts ?? 0, 0)
    assert.equal(isNativeBasicCompaction(host.ctx, overflowAgent.ctx, overflowAgent), true)
  } catch (error) {
    const detail = { phase, startupFileStats: host.startupFileStats,
      error: error instanceof Error ? { message: error.message, stack: error.stack } : { value: String(error) } }
    throw new Error(`Default Basic plus Context request and overflow recovery failed: ${JSON.stringify(detail)}`, { cause: error })
  } finally {
    releaseAdapter?.()
    await disposeHost(host, handles)
  }
})
