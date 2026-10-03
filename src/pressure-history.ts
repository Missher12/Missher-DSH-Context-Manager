import { isSurfaceEvent, SessionLogOffset } from '@deepseek-ai/dsh-session'
import type { SessionObservation } from '@deepseek-ai/dsh-session-query'
import type { ProjectionCheckpoint, SessionProjectionRegistry } from '@deepseek-ai/dsh-session-projection'
import type {} from '@deepseek-ai/dsh-token-meter/client'
import type { PressurePoint } from './inspector-types.ts'

/** Replay the public host projections at bounded key cuts. Checkpoints are local
 * to this read: no Agent, live cache, transcript or persisted state is changed.
 * Missing measurements remain gaps; surface replacement is sampled after apply.
 */
export function pressureHistory(registry: Pick<SessionProjectionRegistry, 'restore'>, observation: Pick<SessionObservation, 'events' | 'header' | 'inheritedEventCount'>, cut: number, signal: AbortSignal): PressurePoint[] {
  const ends: { seq: number; kind: PressurePoint['kind'] }[] = []
  for (const event of observation.events) {
    if (event.seq > cut) break
    if (isSurfaceEvent(event) && typeof event.surfaceOp === 'object') ends.push({ seq: event.seq, kind: 'replace' })
    else if (event.type === 'assistant/message' && event.surfaceOp === 'append') ends.push({ seq: event.seq, kind: 'reply' })
  }
  if (cut >= 0 && ends.at(-1)?.seq !== cut) ends.push({ seq: cut, kind: 'current' })
  let checkpoint: ProjectionCheckpoint = {}
  let start = 0
  return ends.slice(-40).map(({ seq, kind }) => {
    signal.throwIfAborted()
    const result = registry.restore(checkpoint, observation.events.slice(start, seq + 1), SessionLogOffset(start), observation.header, observation.inheritedEventCount)
    checkpoint = result.checkpoint
    start = seq + 1
    const pressure = result.snapshot.values.contextPressure
    const valid = (value: number | undefined) => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null
    return { seq, time: observation.events[seq]!.time, kind, tokens: valid(pressure?.projectedTokens), window: valid(pressure?.contextWindow) }
  })
}
