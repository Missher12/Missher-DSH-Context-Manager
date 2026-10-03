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
  updatedAt?: number
}
