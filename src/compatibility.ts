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
  version?: number
  /** Registration is selection status only; each session's active binding is reported separately. */
  integration: ContextProviderRegistrationReadout
}

export type HostCapabilityProbe =
  | { state: 'supported'; capability: CompactionHostV1 }
  | { state: 'unsupported'; reason: string; version?: number }
  | { state: 'unknown'; reason: string }

export function hostCapabilityReadout(probe: HostCapabilityProbe,
  integration: ContextProviderRegistrationReadout = { state: 'inactive', reason: 'Context Manager service is not active' }): HostCapabilityReadout {
  return { state: probe.state,
    reason: probe.state === 'supported' ? 'Host compaction API v1 is available' : probe.reason,
    ...(probe.state === 'unsupported' && probe.version !== undefined ? { version: probe.version } : {}),
    integration: { ...integration } }
}

/** Read only the versioned public surface. This function never loads an Agent or registers behavior. */
export function resolveCompactionHost(ctx: Context): HostCapabilityProbe {
  let registry: unknown
  try { registry = ctx.get('agentPresets') } catch { registry = undefined }
  if (registry === undefined || registry === null) {
    return { state: 'unknown', reason: 'Agent preset registry is not available yet' }
  }
  let value: unknown
  try { value = (registry as { compactionHost?: unknown }).compactionHost } catch {
    return { state: 'unsupported', reason: 'Host compaction capability could not be read' }
  }
  if (value === undefined || value === null || typeof value !== 'object') {
    return { state: 'unsupported', reason: 'Host cannot register or select an enhanced Context compaction provider; per-session Basic and sidecar status is reported separately' }
  }
  const candidate = value as Partial<CompactionHostV1>
  if (candidate.version !== COMPACTION_HOST_VERSION) {
    return { state: 'unsupported', version: candidate.version, reason: `Host compaction API v${String(candidate.version ?? 'unknown')} is unsupported; expected v${COMPACTION_HOST_VERSION}` }
  }
  if (typeof candidate.register !== 'function' || typeof candidate.bindingFor !== 'function' || typeof candidate.retained !== 'function') {
    return { state: 'unsupported', version: candidate.version, reason: 'Host compaction API v1 is incomplete; per-session Basic and sidecar status is reported separately' }
  }
  return { state: 'supported', capability: candidate as CompactionHostV1 }
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
