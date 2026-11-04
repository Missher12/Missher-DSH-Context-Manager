import { useEffect, useRef, useState } from 'react'
import type { IdleStatus } from './idle-types.ts'
import css from './compaction-banner.css'

export interface CompactionBannerProps {
  sessionId: string
  readStatus(signal: AbortSignal): Promise<IdleStatus>
  label(key: 'autoCompacting' | 'autoCompactingRepair'): string
}

/**
 * Ambient line under the composer for automatic pre-request compaction only.
 * Idle maintenance and confirmed manual runs keep their own surfaces, so this
 * banner never claims work the reader did not trigger by sending a message.
 */
export function CompactionBanner({ sessionId, readStatus, label }: CompactionBannerProps) {
  const readRef = useRef(readStatus)
  useEffect(() => { readRef.current = readStatus })
  const [state, setState] = useState<{ sessionId: string; value?: IdleStatus }>({ sessionId })
  useEffect(() => {
    let disposed = false
    let timer: ReturnType<typeof setTimeout> | undefined
    const controller = new AbortController()
    const read = async () => {
      try {
        const value = await readRef.current(controller.signal)
        if (disposed || controller.signal.aborted) return
        setState({ sessionId, value })
        timer = setTimeout(() => { void read() }, value.status === 'compacting' ? 1000 : 5000)
      } catch {
        if (disposed || controller.signal.aborted) return
        timer = setTimeout(() => { void read() }, 5000)
      }
    }
    setState({ sessionId })
    void read()
    return () => { disposed = true; controller.abort(); if (timer !== undefined) clearTimeout(timer) }
  }, [sessionId])
  const value = state.sessionId === sessionId ? state.value : undefined
  const automatic = value?.status === 'compacting'
    && (value.compactionTrigger === 'pressure' || value.compactionTrigger === 'overflow')
  if (!automatic) return null
  const repairing = value?.compactionPhase === 'repairing'
  return <div className="dsh-context-compaction-banner" data-phase={repairing ? 'repairing' : 'summarizing'} role="status" aria-live="polite">
    <style data-plugin="dsh-context-manager" data-plugin-css="dsh-context-manager/compaction">{css}</style>
    <span className="dsh-context-compaction-spinner" aria-hidden="true" />
    <span>{label(repairing ? 'autoCompactingRepair' : 'autoCompacting')}</span>
  </div>
}
