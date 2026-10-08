import type { CompactionEntry } from './diagnostics-types.ts'
import type { IdleStatus } from './idle-types.ts'

export const categories = [
  { id: 'summary', label: '压缩摘要' }, { id: 'system', label: '系统指令' }, { id: 'tools', label: '工具定义' },
  { id: 'user', label: '用户消息' }, { id: 'inject', label: '注入内容' },
  { id: 'skill', label: '技能内容' }, { id: 'assistant', label: '助手回复' },
  { id: 'tool', label: '工具结果' },
] as const
export type Category = typeof categories[number]['id']
export interface InspectQuery {
  sessionId: string
  /** null follows the current immutable cut; a number replays through that record. */
  atSeq: number | null
  offset: number
  category: Category | 'all'
  group?: 'summary' | 'tool' | 'message' | 'instruction'
  search: string
  sort: 'size' | 'position'
  archived: boolean
}
export interface ContentRow {
  id: string; seq: number; title: string; source: string; category: Category
  tokens: number; current: boolean; images: number
}
export interface RequestRow {
  seq: number; time: number; turn: number; step: number; provider: string; model: string
  input: number | null; output: number | null; cacheRead: number | null
}
export interface PressurePoint {
  seq: number; time: number; tokens: number | null; window: number | null
  kind: 'reply' | 'replace' | 'current'
}
export interface ContextDelta { fromSeq: number; toSeq: number; beforeTokens: number; afterTokens: number; deltaTokens: number }
export interface ContextGrowth { sinceCompaction: ContextDelta | null; lastToolResult: ContextDelta | null }
/** Same public meter used by admission, sampled only from an already-live session. */
export interface AdmissionReadout {
  tokens: number; logRevision: number; baseline: 'none' | 'estimated' | 'usage'
  /** Recorded metadata for the measured route; missing values never imply zero. */
  window: number | null; outputReserve: number | null
}
/** One usage component: a known sum plus how many samples did not report it. */
export interface FieldTotalReadout { sum: number; reported: number; missing: number }
/** One settlement folded from this cut's event log; a missing component stays null. */
export interface EfficiencyRequestRow {
  seq: number; time: number; turn: number; step: number
  /** How the settlement was observed; `attempt` usually means a failed or cancelled call. */
  settledBy: 'message' | 'attempt'
  routeKnown: boolean; retry: number; provider: string; model: string
  uncachedInput: number | null; cacheRead: number | null; cacheWrite: number | null; output: number | null
  /** Settled while a compaction transaction owned the turn; the purpose stays unconfirmed. */
  maintenanceSuspect: boolean
}
export interface EfficiencyChange { seq: number; time: number; changed: ('prefix' | 'toolSchema' | 'toolOrder')[]; note: string }
export interface EfficiencyFingerprint { prefix: string; toolSchema: string; toolOrder: string; tools: number; systemChars: number }
/**
 * Read-only attribution for one immutable cut. `accounting` says which source
 * is authoritative: `host-projection` quotes `host` and keeps the mirrored fold
 * as a cross-check, while `event-log` (a historical cut or a missing
 * projection) quotes only the fold and must be read with its completeness
 * fields. Summary and repair usage stays one undivided figure because the
 * existing ledger has no durable purpose field.
 */
export interface EfficiencyReadout {
  accounting: 'host-projection' | 'event-log'
  host: { uncachedInputTokens: number; cacheReadTokens: number; cacheWriteTokens: number; outputTokens: number } | null
  mirrored: {
    settledAttempts: number; retries: number; withoutUsage: number
    uncachedInput: FieldTotalReadout; cacheRead: FieldTotalReadout; cacheWrite: FieldTotalReadout
    output: FieldTotalReadout; cacheInclusiveInput: FieldTotalReadout
    complete: boolean
  }
  /** Non-empty entries mean the log could not reproduce the Host's own total. */
  differences: { field: 'uncachedInputTokens' | 'cacheReadTokens' | 'cacheWriteTokens' | 'outputTokens'; host: number; mirrored: number; delta: number }[]
  /** Cache components stay null when no attempt reported them; the ledger input already includes cache. */
  summaryAndRepair: { source: string; input: number; output: number; cacheRead: number | null; cacheWrite: number | null; attempts: number
    unknownAttempts: number; purposeSplit: false; note: string } | null
  maintenanceSuspects: number
  cacheHitRatio: number | null
  requests: EfficiencyRequestRow[]
  /** Null when prefix diagnostics are switched off or no request header was seen. */
  fingerprint: EfficiencyFingerprint | null
  changes: EfficiencyChange[]
}
/**
 * Per-session confirmed tool-result reduction. `published`/`pending`/`reverted`
 * come from the durable archive rows filtered by this session; `run` is a
 * process-wide diagnostic for the current run and is labelled as such, never
 * presented as this session's total.
 */
export interface ReductionReadout {
  mode: 'off' | 'observe' | 'reduce'
  /** True once the Host reported a final tool result through the new seam. */
  pipelineReported: boolean
  published: { references: number; originalChars: number; shortenedChars: number; visibleCharsRemoved: number }
  pending: number
  reverted: number
  /**
   * This session's durable confirmed references, newest first and bounded. The
   * pair (contentId, callId) is the grant identity: cross-call dedup lets one
   * stored original carry several owners, so contentId alone is not unique.
   */
  recent: { contentId: string; callId: string | null; tool: string; shortenedChars: number; complete: boolean; at: number }[]
  notes: string[]
  run: { considered: number; unverified: number; wouldReduce: number; skipped: number; failed: number; lastSkip: string | null; lastReason: string | null }
  /** Why the archive is unavailable for this run; absent when it opened. */
  archiveError?: string
}
export type InspectedCompaction = CompactionEntry & { trigger?: 'idle' | 'pressure' | 'overflow' | 'manual' }
/** Read-only host goal projection; the context page never mutates it. */
export interface GoalReadout { phase: string; blockedReason: { code: string; message: string } | null; roundsStarted: number; maxGoalRounds: number }
export interface Inspection {
  sessionId: string; cursor: number; cutSeq: number; sampledAt: number; historical: boolean
  pressure: { projected: number; input: number; window: number | null } | null
  /** Absent for history, unloaded sessions, or an unavailable/concurrently advanced meter. */
  admission?: AdmissionReadout
  model: { provider: string; model: string; effort: string | null; maxTokens: number | null } | null
  parts: { category: Category; tokens: number; count: number }[]
  official: { system: number; tools: number; messages: number } | null
  usage: { input: number; output: number; cacheRead: number; uncached: number; cacheWrite: number } | null
  /** Separate metadata ledger since this version began recording summary calls. */
  summaryUsage?: { input: number; output: number; attempts: number; unknownAttempts: number; since: number }
  /**
   * Attribution of this cut. A historical cut carries only the event-log fold
   * (no host projection, no ledger), so current figures are never shown as
   * historical ones.
   */
  efficiency?: EfficiencyReadout
  /** Confirmed per-session tool-result reduction; absent for a historical cut. */
  reduction?: ReductionReadout
  /** Differences between replayed host projections, never an exact token bill. */
  contextGrowth?: ContextGrowth
  /** Goal stop reason as recorded by the host, distinct from context pressure. */
  goal?: GoalReadout
  pressureHistory: PressurePoint[]
  rows: ContentRow[]; total: number; offset: number; pageSize: number; activeCount: number; archivedCount: number
  requests: RequestRow[]; requestCount: number; compactions: InspectedCompaction[]
}
export interface ContentQuery { sessionId: string; cutSeq: number; id: string; offset: number; sourceOffset?: number }
/** Direct, recorded inputs; a source may itself be an earlier summary. */
export interface ContentSources { rows: ContentRow[]; offset: number; total: number; nextOffset: number | null }
export interface ContentPage { sessionId: string; cutSeq: number; id: string; text: string; offset: number; totalChars: number; nextOffset: number | null; sources?: ContentSources }
export interface InspectorApi {
  idleStatus(query: { sessionId: string }, signal: AbortSignal): Promise<IdleStatus>
  inspect(query: InspectQuery, signal: AbortSignal): Promise<Inspection>
  content(query: ContentQuery, signal: AbortSignal): Promise<ContentPage>
}
export const defaultQuery = { atSeq: null, offset: 0, category: 'all', search: '', sort: 'size', archived: false } as const
