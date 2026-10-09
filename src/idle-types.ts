/** Live or durable idle maintenance status; reads never activate an Agent. */
export interface IdleStatus {
  status: 'off' | 'waiting' | 'scheduled' | 'checking' | 'compacting' | 'completed' | 'skipped' | 'cancelled' | 'failed'
  dueAt: number | null
  message: string
  beforeTokens?: number
  afterTokens?: number
  reasonCode?: string
  restored?: boolean
  windowTokens?: number
  minimumPercent?: number
  /** Effective idle floor in tokens when the absolute soft trigger binds. */
  minimumTokens?: number
  /** Live phase of an in-flight compaction, from either request or idle path. */
  compactionPhase?: 'summarizing' | 'repairing'
  owner?: 'context-manager' | 'other' | 'unknown'
  deadline?: string
  recovery?: { available: boolean; message: string; requestHash?: string }
  updatedAt?: number
}

/** Live in-flight compaction phase reported by the engine's status reader. */
export interface CompactPhase {
  phase: 'summarizing' | 'repairing'
  message: string
}
