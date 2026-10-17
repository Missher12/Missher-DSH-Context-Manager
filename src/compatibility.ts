import type { Context } from '@deepseek-ai/cordis'

export const COMPACTION_HOST_VERSION = 1
export const CONTEXT_MANAGER_ORIGIN = '@missher/dsh-context-manager'
export const CONTEXT_ENGINE_MODULE = '@missher/dsh-context-manager/engine'
export const BASIC_COMPACTION_MODULE = '@deepseek-ai/dsh-compaction-basic'
export const CONTEXT_MANAGER_PRESETS = Object.freeze(['standard', 'ptc', 'cordis'] as const)

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
    return { state: 'unsupported', reason: 'Host does not expose the compaction provider capability; saved Context policies are not active' }
  }
  const candidate = value as Partial<CompactionHostV1>
  if (candidate.version !== COMPACTION_HOST_VERSION) {
    return { state: 'unsupported', version: candidate.version, reason: `Host compaction API v${String(candidate.version ?? 'unknown')} is unsupported; expected v${COMPACTION_HOST_VERSION}` }
  }
  if (typeof candidate.register !== 'function' || typeof candidate.bindingFor !== 'function' || typeof candidate.retained !== 'function') {
    return { state: 'unsupported', version: candidate.version, reason: 'Host compaction API v1 is incomplete; saved Context policies are not active' }
  }
  return { state: 'supported', capability: candidate as CompactionHostV1 }
}

/** Classify an Agent from its installed binding, never from the future selection. */
export function readAgentCompaction(ctx: Context, agentContext?: Context): CompactionReadout {
  const probe = resolveCompactionHost(ctx)
  if (probe.state !== 'supported') {
    return { mode: 'unknown', hostCapability: probe.state, reason: probe.reason }
  }
  if (!agentContext) {
    return { mode: 'unknown', hostCapability: 'supported', reason: 'No active Agent binding is available for this session' }
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
