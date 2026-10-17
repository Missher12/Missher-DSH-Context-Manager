import type { Context } from '@deepseek-ai/cordis'
import {
  CONTEXT_ENGINE_MODULE,
  CONTEXT_MANAGER_ORIGIN,
  CONTEXT_MANAGER_PRESETS,
  type ContextProviderRegistrationReadout,
  type HostCapabilityProbe,
} from './compatibility.ts'
import { CONTEXT_MANAGER_VERSION } from './version.ts'

/** Register from the ContextManager plugin's own Context after its services are ready. */
export function registerContextCompaction(ctx: Context, probe: HostCapabilityProbe,
  report: (status: ContextProviderRegistrationReadout) => void): void {
  if (probe.state !== 'supported') return

  let active = true
  let registration: Awaited<ReturnType<typeof probe.capability.register>> | undefined
  report({ state: 'pending' })
  ctx.effect(() => async () => {
    active = false
    report({ state: 'inactive', reason: 'Context Manager stopped' })
    const current = registration
    registration = undefined
    if (current) await current.revoke()
  }, 'context-manager: compaction registration')

  void probe.capability.register(ctx, {
    origin: CONTEXT_MANAGER_ORIGIN,
    revision: CONTEXT_MANAGER_VERSION,
    module: CONTEXT_ENGINE_MODULE,
    presets: CONTEXT_MANAGER_PRESETS,
    requires: [
      { rowId: 'agent' },
      { rowId: 'llm' },
      { rowId: 'session' },
      { rowId: 'storage-domain' },
      { rowId: 'token-meter' },
    ],
  }).then(async current => {
    if (!active) {
      await current.revoke()
      return
    }
    registration = current
    report({ state: 'registered' })
  }).catch(error => {
    if (!active) return
    const reason = error instanceof Error ? error.message : String(error)
    report({ state: 'failed', reason: reason.slice(0, 300) })
    ctx.logger.warn('context-manager: Host compaction registration was not activated: %s', reason)
  })
}
