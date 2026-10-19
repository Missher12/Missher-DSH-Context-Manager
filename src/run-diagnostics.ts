import type { Inspection } from './inspector-types.ts'
import type { IdleStatus } from './idle-types.ts'

export type RunFreshness = 'current' | 'refreshing' | 'stale'
export type IdleFreshness = 'current' | 'refreshing' | 'stale' | 'unknown'
type IdleCopyState = Partial<Pick<IdleStatus, 'status' | 'updatedAt' | 'restored'>> & { freshness: IdleFreshness }

const enumValue = <T extends string>(value: unknown, allowed: readonly T[]): T | null =>
  typeof value === 'string' && (allowed as readonly string[]).includes(value) ? value as T : null
const finiteCount = (value: unknown): number | null =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null

/** Serialize only bounded status enums, timestamps and token counts. Never copy raw messages or session content. */
export function createRunDiagnostics(inspection: Inspection, idle: IdleCopyState | null, freshness: RunFreshness): string {
  const historical = inspection.historical === true
  const entry = inspection.compactions.at(-1)
  const startedAt = finiteCount(entry?.startedAt)
  const endedAt = finiteCount(entry?.endedAt)
  const idleStatus = historical || !idle ? null : {
    status: enumValue(idle.status, ['off', 'waiting', 'scheduled', 'checking', 'compacting', 'completed', 'skipped', 'cancelled', 'failed'] as const),
    restored: typeof idle.restored === 'boolean' ? idle.restored : null,
    updatedAt: finiteCount(idle.updatedAt),
    freshness: enumValue(idle.freshness, ['current', 'refreshing', 'stale', 'unknown'] as const),
  }
  const cooperation = historical || !inspection.cooperation ? null : {
    toolResults: enumValue(inspection.cooperation.toolResults.state, ['off', 'observe', 'active', 'waiting', 'unsupported'] as const),
    finalResultSeen: inspection.cooperation.toolResults.finalResultSeen === true,
    idleMaintenance: enumValue(inspection.cooperation.idleMaintenance, ['active', 'off', 'waiting', 'unsupported'] as const),
    requestPressure: enumValue(inspection.cooperation.requestPressure, ['context', 'native', 'off', 'waiting', 'unsupported', 'unknown'] as const),
  }
  const latest = entry ? {
    kind: enumValue(entry.kind, ['compact', 'prune'] as const),
    status: enumValue(entry.status, ['running', 'completed', 'failed', 'interrupted', 'unapplied'] as const),
    trigger: enumValue(entry.trigger, ['idle', 'pressure', 'overflow', 'manual'] as const),
    modelCallStatus: enumValue(entry.modelCallStatus, ['not_dispatched', 'dispatched'] as const),
    applied: entry.applied === true,
    startedAt,
    endedAt,
    durationMs: startedAt !== null && endedAt !== null && endedAt >= startedAt ? endedAt - startedAt : null,
    inputTokens: finiteCount(entry.inputTokens),
    outputTokens: finiteCount(entry.outputTokens),
  } : null

  return JSON.stringify({
    schema: 'context-manager-run-diagnostics-v1',
    sampledAt: finiteCount(inspection.sampledAt),
    cut: finiteCount(inspection.cutSeq),
    historical,
    freshness: historical ? 'historical' : freshness,
    compactionMode: enumValue(inspection.compression?.mode, ['enhanced', 'native', 'other', 'unconfigured', 'unavailable', 'unknown'] as const),
    cooperation,
    idle: idleStatus,
    latestCompaction: latest,
  }, null, 2)
}
