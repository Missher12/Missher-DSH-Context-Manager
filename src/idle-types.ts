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
  emergency?: {eligible:boolean;used:boolean;message:string}
  execution?: string
  /** Live compaction planning numbers, when a plan exists for this transaction. */
  capacity?: CompactCapacity
  deadline?: string
  recovery?: { available: boolean; message: string; requestHash?: string; authorizationToken?: string; riskAcceptanceRequired?: boolean }
  updatedAt?: number
}

/** Live in-flight compaction phase reported by the engine's status reader. */
export interface CompactPhase {
  phase: 'summarizing' | 'repairing'
  message: string
  /** Read-only plan numbers for the same in-flight transaction, when available. */
  capacity?: CompactCapacity
}

/**
 * Read-only plan numbers for the compact status line. Values are token counts
 * from the current transaction and are never used to admit work.
 */
export interface CompactCapacity {
  /** Actual model context window used as the percentage denominator. */
  windowTokens: number
  /** Effective admission/check boundary for this transaction. */
  admission: number
  /** Highest post-compaction occupancy the plan admits (admission minus headroom). */
  upper: number
  /** Reserve kept free below admission for the next work steps. */
  resumeHeadroom: number
  /** Reserve estimated from the recent peak net growth and bounded input margin. */
  requiredResumeHeadroom: number
  /** Maximum reserve allowed by the planner's window/admission bounds. */
  resumeHeadroomLimit: number
  /** Peak positive net growth observed across up to four comparable steps. */
  recentGrowth: number
  /** Tokens in protected (never summarised) content of the measured surface. */
  protectedTokens: number
  /** Total measured surface when the plan was built. */
  totalTokens: number
  /** Tokens of the current new input/attachments included in the measurement. */
  incomingTokens: number
}
