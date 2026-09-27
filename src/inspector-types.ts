import type { CompactionEntry } from './diagnostics-types.ts'

export const categories = [
  { id: 'system', label: '系统指令' }, { id: 'tools', label: '工具定义' },
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
export interface Inspection {
  sessionId: string; cursor: number; cutSeq: number; sampledAt: number; historical: boolean
  pressure: { projected: number; input: number; window: number | null } | null
  model: { provider: string; model: string; effort: string | null; maxTokens: number | null } | null
  parts: { category: Category; tokens: number; count: number }[]
  official: { system: number; tools: number; messages: number } | null
  usage: { input: number; output: number; cacheRead: number } | null
  rows: ContentRow[]; total: number; offset: number; pageSize: number; activeCount: number; archivedCount: number
  requests: RequestRow[]; requestCount: number; compactions: CompactionEntry[]
}
export interface ContentQuery { sessionId: string; cutSeq: number; id: string; offset: number }
export interface ContentPage { sessionId: string; cutSeq: number; id: string; text: string; offset: number; totalChars: number; nextOffset: number | null }
export interface InspectorApi {
  inspect(query: InspectQuery, signal: AbortSignal): Promise<Inspection>
  content(query: ContentQuery, signal: AbortSignal): Promise<ContentPage>
}
export const defaultQuery = { atSeq: null, offset: 0, category: 'all', search: '', sort: 'size', archived: false } as const
