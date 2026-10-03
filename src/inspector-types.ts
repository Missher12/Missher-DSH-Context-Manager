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
export type InspectedCompaction = CompactionEntry & { trigger?: 'idle' | 'pressure' | 'overflow' | 'manual' }
export interface Inspection {
  sessionId: string; cursor: number; cutSeq: number; sampledAt: number; historical: boolean
  pressure: { projected: number; input: number; window: number | null } | null
  model: { provider: string; model: string; effort: string | null; maxTokens: number | null } | null
  parts: { category: Category; tokens: number; count: number }[]
  official: { system: number; tools: number; messages: number } | null
  usage: { input: number; output: number; cacheRead: number; uncached: number; cacheWrite: number } | null
  /** Separate metadata ledger since this version began recording summary calls. */
  summaryUsage?: { input: number; output: number; attempts: number; unknownAttempts: number; since: number }
  /** Differences between replayed host projections, never an exact token bill. */
  contextGrowth?: ContextGrowth
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
