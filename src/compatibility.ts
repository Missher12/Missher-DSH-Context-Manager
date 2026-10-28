import type { Context } from '@deepseek-ai/cordis'
import { BasicCompactionEngine } from '@deepseek-ai/dsh-compaction-basic'

export const COMPACTION_HOST_VERSION = 1
export const CONTEXT_MANAGER_ORIGIN = '@missher/dsh-context-manager'
export const CONTEXT_ENGINE_MODULE = '@missher/dsh-context-manager/engine'
export const BASIC_COMPACTION_MODULE = '@deepseek-ai/dsh-compaction-basic'
export const CONTEXT_MANAGER_PRESETS = Object.freeze(['standard', 'ptc', 'cordis'] as const)
/** Internal marker for an isolated Context engine used only as a Basic idle sidecar. */
export const CONTEXT_BASIC_IDLE_SIDECAR = Symbol.for('@missher/dsh-context-manager/basic-idle-sidecar/v1')

export interface CompactionProviderRegistration {
  origin: string
  revision: string
  module: string
  presets: readonly string[]
  requires?: readonly ({ rowId?: string; module?: string })[]
}

export interface CompactionRegistration extends CompactionProviderRegistration {
  ownerFiber: unknown
  revoke(): Promise<void>
}

export interface AgentPresetBinding {
  agentPreset: string
  owner: string
  generation: number
  ownerAlive: boolean
  available: boolean
  selectable: boolean
  compactionSource: 'declaration' | 'registration'
  compactionProvider?: string
  registrationOrigin?: string
  registrationRevision?: string
}

export interface CompactionHostV1 {
  readonly version: number
  readonly selected?: CompactionRegistration
  register(owner: Context, registration: CompactionProviderRegistration): Promise<CompactionRegistration>
  bindingFor(ctx: Context): AgentPresetBinding | undefined
  retained(): readonly AgentPresetBinding[]
}

export type HostCapabilityState = 'supported' | 'unsupported' | 'unknown'
export type AgentCompactionMode = 'enhanced' | 'native' | 'other' | 'unconfigured' | 'unknown' | 'unavailable'
export type ContextProviderRegistrationState = 'inactive' | 'pending' | 'registered' | 'failed' | 'unknown'
export type HostCapabilityReasonCode = 'registry-unavailable' | 'registry-unreadable' | 'compaction-host-missing'
  | 'compaction-host-unreadable' | 'version-mismatch' | 'methods-missing' | 'supported'

export type ContextCompactionPath = 'host-registration' | 'request-gate-sidecar' | 'host-provider-unchanged' | 'unknown'
export type ContextCompactionPathState = 'ready' | 'pending' | 'blocked' | 'failed' | 'inactive' | 'unknown'
export type ContextCompactionPathReasonCode = 'host-provider-ready' | 'host-provider-pending' | 'host-provider-failed'
  | 'host-provider-inactive' | 'host-provider-unknown' | 'sidecar-ready' | 'sidecar-pending' | 'sidecar-blocked' | 'sidecar-failed'
  | 'sidecar-inactive' | 'host-capability-unknown'

export interface HostRuntimeReadout {
  state: 'available' | 'unavailable'
  version?: string
  source: '@deepseek-ai/dsh-app-boot' | 'unavailable'
}

export interface ContextCompactionPathReadout {
  path: ContextCompactionPath
  state: ContextCompactionPathState
  reasonCode: ContextCompactionPathReasonCode
  /** Exact startup or activation failure, kept in folded technical details. */
  reason?: string
}

export interface ContextCooperationReadout {
  toolResults: { state: 'off' | 'observe' | 'active' | 'waiting' | 'unsupported'; finalResultSeen: boolean }
  originals: { state: 'ready' | 'empty' | 'unavailable'; count: number }
  idleMaintenance: 'active' | 'off' | 'waiting' | 'unsupported'
  /** Context pressure is an optional sidecar; Basic keeps its own native admission and overflow policy. */
  requestPressure: 'context' | 'native' | 'off' | 'waiting' | 'unsupported' | 'unknown'
}

export interface ContextProviderRegistrationReadout {
  state: ContextProviderRegistrationState
  reason?: string
}

export interface CompactionReadout {
  mode: AgentCompactionMode
  hostCapability: HostCapabilityState
  reason: string
  agentPreset?: string
  generation?: number
  provider?: string
  source?: 'declaration' | 'registration'
  selectable?: boolean
}

export interface HostCapabilityReadout {
  state: HostCapabilityState
  reason: string
  reasonCode?: HostCapabilityReasonCode
  version?: number
  /** Exact public interfaces the Host did not expose for Context provider binding. */
  missingInterfaces?: readonly string[]
  /** Optional host release from the public app-boot runtime version API. */
  hostRuntime?: HostRuntimeReadout
  /** Active Context path, separate from whether the Host can bind a replacement provider. */
  requestPath?: ContextCompactionPathReadout
  /** Registration is selection status only; each session's active binding is reported separately. */
  integration: ContextProviderRegistrationReadout
}

export type HostCapabilityProbe =
  | { state: 'supported'; capability: CompactionHostV1; reasonCode: 'supported'; missingInterfaces: readonly [] }
  | { state: 'unsupported'; reason: string; reasonCode: Exclude<HostCapabilityReasonCode, 'registry-unavailable' | 'registry-unreadable' | 'supported'>; missingInterfaces: readonly string[]; version?: number }
  | { state: 'unknown'; reason: string; reasonCode: 'registry-unavailable' | 'registry-unreadable'; missingInterfaces: readonly [] }

const COMPACTION_HOST_V1_INTERFACES = Object.freeze([
  'agentPresets.compactionHost.version = 1',
  'agentPresets.compactionHost.register(owner, registration)',
  'agentPresets.compactionHost.bindingFor(agentContext)',
  'agentPresets.compactionHost.retained()',
])

/** Read the official runtime's public version helper without making it a load-time requirement on older Hosts. */
let hostRuntimeReadout: Promise<HostRuntimeReadout> | undefined
export function readHostRuntimeVersion(): Promise<HostRuntimeReadout> {
  return hostRuntimeReadout ??= (async () => {
    try {
      const appBoot = await import('@deepseek-ai/dsh-app-boot') as unknown as { getDshRuntimeVersion?: () => unknown }
      const version = appBoot.getDshRuntimeVersion?.()
      if (typeof version === 'string' && version.trim()) {
        return { state: 'available', version: version.trim(), source: '@deepseek-ai/dsh-app-boot' }
      }
    } catch { /* Older or community Hosts may not expose the official helper. */ }
    return { state: 'unavailable', source: 'unavailable' }
  })()
}

/** Report which safe Context path is active; this never changes the selected Host provider. */
export function resolveContextCompactionPath(probe: HostCapabilityProbe,
  integration: ContextProviderRegistrationReadout,
  sidecar: 'inactive' | 'pending' | 'active' | 'blocked' | 'failed', sidecarReason?: string): ContextCompactionPathReadout {
  if (probe.state === 'supported') {
    if (integration.state === 'registered') return { path: 'host-registration', state: 'ready', reasonCode: 'host-provider-ready' }
    if (integration.state === 'pending') return { path: 'host-registration', state: 'pending', reasonCode: 'host-provider-pending' }
    if (integration.state === 'failed') return { path: 'host-registration', state: 'failed', reasonCode: 'host-provider-failed' }
    if (integration.state === 'inactive') return { path: 'host-registration', state: 'inactive', reasonCode: 'host-provider-inactive' }
    return { path: 'host-registration', state: 'unknown', reasonCode: 'host-provider-unknown' }
  }
  if (sidecar === 'active') return { path: 'request-gate-sidecar', state: 'ready', reasonCode: 'sidecar-ready' }
  if (sidecar === 'pending') return { path: 'request-gate-sidecar', state: 'pending', reasonCode: 'sidecar-pending' }
  if (sidecar === 'blocked') return { path: 'request-gate-sidecar', state: 'blocked', reasonCode: 'sidecar-blocked',
    ...(sidecarReason ? { reason: sidecarReason } : {}) }
  if (sidecar === 'failed') return { path: 'request-gate-sidecar', state: 'failed', reasonCode: 'sidecar-failed',
    ...(sidecarReason ? { reason: sidecarReason } : {}) }
  if (probe.state === 'unsupported') return { path: 'host-provider-unchanged', state: 'inactive', reasonCode: 'sidecar-inactive' }
  return { path: 'unknown', state: 'unknown', reasonCode: 'host-capability-unknown' }
}

export type ContextEngineStartupState = { state: 'ready' } | { state: 'blocked'; reason: string }

/** Fail closed when the isolated engine does not expose a valid startup proof. */
export function readContextEngineStartupState(engine: unknown): ContextEngineStartupState {
  try {
    const read = (engine as { startupReadiness?: () => unknown } | null)?.startupReadiness
    if (typeof read !== 'function') return { state: 'blocked', reason: '隔离引擎未公开启动核验状态' }
    const proof = read.call(engine)
    if (proof && typeof proof === 'object' && (proof as { ready?: unknown }).ready === true) return { state: 'ready' }
    const reason = proof && typeof proof === 'object' && typeof (proof as { reason?: unknown }).reason === 'string'
      ? (proof as { reason: string }).reason.trim() : ''
    return { state: 'blocked', reason: reason || '隔离引擎启动核验未通过' }
  } catch (error) {
    return { state: 'blocked', reason: `读取隔离引擎启动核验失败：${error instanceof Error ? error.message : String(error)}` }
  }
}

export function hostCapabilityReadout(probe: HostCapabilityProbe,
  integration: ContextProviderRegistrationReadout = { state: 'inactive', reason: 'Context Manager service is not active' }): HostCapabilityReadout {
  return { state: probe.state,
    reason: probe.state === 'supported' ? 'Host compaction API v1 is available' : probe.reason,
    reasonCode: probe.reasonCode,
    missingInterfaces: [...probe.missingInterfaces],
    ...(probe.state === 'unsupported' && probe.version !== undefined ? { version: probe.version } : {}),
    integration: { ...integration } }
}

/** Read only the versioned public surface. This function never loads an Agent or registers behavior. */
export function resolveCompactionHost(ctx: Context): HostCapabilityProbe {
  let registry: unknown
  try { registry = ctx.get('agentPresets') } catch {
    return { state: 'unknown', reason: 'Agent preset registry could not be read', reasonCode: 'registry-unreadable', missingInterfaces: [] }
  }
  if (registry === undefined || registry === null) {
    return { state: 'unknown', reason: 'Agent preset registry is not available yet', reasonCode: 'registry-unavailable', missingInterfaces: [] }
  }
  let value: unknown
  try { value = (registry as { compactionHost?: unknown }).compactionHost } catch {
    return { state: 'unsupported', reason: 'Host compaction capability could not be read', reasonCode: 'compaction-host-unreadable',
      missingInterfaces: ['agentPresets.compactionHost'] }
  }
  if (value === undefined || value === null || typeof value !== 'object') {
    return { state: 'unsupported', reason: 'Host cannot register or select an enhanced Context compaction provider; per-session Basic and sidecar status is reported separately',
      reasonCode: 'compaction-host-missing', missingInterfaces: COMPACTION_HOST_V1_INTERFACES }
  }
  const candidate = value as Partial<CompactionHostV1>
  let version: number | undefined
  try {
    version = candidate.version
  } catch {
    return { state: 'unsupported', reason: 'Host compaction API members could not be read', reasonCode: 'compaction-host-unreadable',
      missingInterfaces: ['agentPresets.compactionHost.version'] }
  }
  if (version !== COMPACTION_HOST_VERSION) {
    return { state: 'unsupported', version, reason: `Host compaction API v${String(version ?? 'unknown')} is unsupported; expected v${COMPACTION_HOST_VERSION}`,
      reasonCode: 'version-mismatch', missingInterfaces: ['agentPresets.compactionHost.version = 1'] }
  }
  let register: unknown
  let bindingFor: unknown
  let retained: unknown
  try {
    register = candidate.register
    bindingFor = candidate.bindingFor
    retained = candidate.retained
  } catch {
    return { state: 'unsupported', version, reason: 'Host compaction API methods could not be read', reasonCode: 'compaction-host-unreadable',
      missingInterfaces: ['agentPresets.compactionHost methods'] }
  }
  const missingInterfaces = [
    ...(typeof register !== 'function' ? ['agentPresets.compactionHost.register(owner, registration)'] : []),
    ...(typeof bindingFor !== 'function' ? ['agentPresets.compactionHost.bindingFor(agentContext)'] : []),
    ...(typeof retained !== 'function' ? ['agentPresets.compactionHost.retained()'] : []),
  ]
  if (missingInterfaces.length > 0) {
    return { state: 'unsupported', version, reason: 'Host compaction API v1 is incomplete; per-session Basic and sidecar status is reported separately',
      reasonCode: 'methods-missing', missingInterfaces }
  }
  return { state: 'supported', capability: candidate as CompactionHostV1, reasonCode: 'supported', missingInterfaces: [] }
}

function activeCompactionService(ctx: Context, agentContext?: Context, agent?: unknown): unknown {
  if (agent !== undefined) {
    let registry: unknown
    try { registry = ctx.get('agentPresets') } catch { registry = undefined }
    try {
      const service = (registry as { serviceFor?: (agent: unknown, service: string) => unknown } | undefined)
        ?.serviceFor?.(agent, 'compaction')
      if (service !== undefined) return service
    } catch { /* fall through to the Agent's public Context service */ }
  }
  try { return agentContext?.get('compaction') } catch { return undefined }
}

/** Cordis returns a context-bound proxy whose `constructor` can differ from its prototype. */
function isExactBasicService(service: unknown): service is BasicCompactionEngine {
  if (!(service instanceof BasicCompactionEngine)) return false
  try { return Object.getPrototypeOf(service) === BasicCompactionEngine.prototype }
  catch { return false }
}

/** Match the exact official Basic implementation; a custom subclass is not treated as Basic. */
export function isNativeBasicCompaction(ctx: Context, agentContext?: Context, agent?: unknown): boolean {
  const service = activeCompactionService(ctx, agentContext, agent)
  return isExactBasicService(service)
}

/** Classify an Agent from its installed binding, never from the future selection. */
export function readAgentCompaction(ctx: Context, agentContext?: Context, agent?: unknown): CompactionReadout {
  const probe = resolveCompactionHost(ctx)
  if (!agentContext) {
    return { mode: 'unknown', hostCapability: probe.state, reason: 'No active Agent binding is available for this session' }
  }
  if (probe.state !== 'supported') {
    const service = activeCompactionService(ctx, agentContext, agent)
    if (isExactBasicService(service)) {
      return { mode: 'native', hostCapability: probe.state, provider: BASIC_COMPACTION_MODULE,
        reason: 'Official Basic is active; Context sidecar capabilities are reported separately' }
    }
    if (service !== undefined) {
      return { mode: 'other', hostCapability: probe.state,
        reason: 'A compaction provider is active, but its Host binding is not exposed' }
    }
    return { mode: 'unknown', hostCapability: probe.state, reason: probe.reason }
  }
  let binding: AgentPresetBinding | undefined
  try { binding = probe.capability.bindingFor(agentContext) } catch {
    return { mode: 'unknown', hostCapability: 'supported', reason: 'Host could not read this Agent binding' }
  }
  if (!binding) return { mode: 'unknown', hostCapability: 'supported', reason: 'Host returned no binding for this Agent' }
  const detail = {
    hostCapability: 'supported' as const,
    agentPreset: binding.agentPreset,
    generation: binding.generation,
    ...(binding.compactionProvider === undefined ? {} : { provider: binding.compactionProvider }),
    source: binding.compactionSource,
    selectable: binding.selectable,
  }
  // Availability describes this exact retained binding. ownerAlive reports
  // the generation's dependency fibers; revoking future selection can leave an
  // already-mounted provider available while those fibers remain alive.
  if (!binding.available) {
    return { ...detail, mode: 'unavailable', reason: 'This Agent binding is retained but its provider or owner is unavailable' }
  }
  if (binding.compactionProvider === undefined) {
    return { ...detail, mode: 'unconfigured', reason: 'This preset has no compaction provider in its actual binding' }
  }
  if (binding.compactionProvider === CONTEXT_ENGINE_MODULE
    && (binding.compactionSource === 'declaration' || binding.registrationOrigin === CONTEXT_MANAGER_ORIGIN)) {
    return { ...detail, mode: 'enhanced', reason: 'Context enhancement is active for this Agent' }
  }
  if (binding.compactionProvider === BASIC_COMPACTION_MODULE) {
    return { ...detail, mode: 'native', reason: 'The Host compaction provider is active for this Agent' }
  }
  return { ...detail, mode: 'other', reason: 'A different compaction provider is active for this Agent' }
}

export function isEnhancedBinding(readout: CompactionReadout): boolean {
  return readout.mode === 'enhanced'
}
