/** Small read-only wire view. No message text, prompts or tool arguments. */
export interface CompactionEntry {
  id: string
  kind: 'compact' | 'prune'
  startedAt: number
  endedAt?: number
  status: 'running' | 'completed' | 'failed' | 'interrupted' | 'unapplied'
  manual: boolean
  applied: boolean
  beforeTokens?: number
  afterTokens?: number
  messages?: number
  error?: string
  inputTokens?: number
  outputTokens?: number
}

export interface ContextDiagnostics {
  request: { provider: string; model: string; effort?: string; maxTokens?: number; time: number } | null
  tools: { count: number; top: { name: string; tokens: number }[] }
  requests: { seq: number; time: number; provider: string; model: string; turn: number; step: number; input: number; output: number }[]
  compactions: CompactionEntry[]
}

declare module '@deepseek-ai/dsh-session-projection/types' {
  interface SessionProjectionMap { contextManagerDiagnostics: ContextDiagnostics }
}

export const HISTORY_LIMIT = 12
