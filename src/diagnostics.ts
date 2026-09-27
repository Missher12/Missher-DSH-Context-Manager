import { z } from 'zod'
import { canonicalHeader, type SessionEvent } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-compaction/types'
import type { ProjectionDefinition } from '@deepseek-ai/dsh-session-projection'
import { estimateMessage } from '@deepseek-ai/dsh-token-meter/estimate'
import { HISTORY_LIMIT, type ContextDiagnostics, type CompactionEntry } from './diagnostics-types.ts'

interface State {
  view: ContextDiagnostics
  pending: { id: string; seq: number; start: number; end: number } | null
}
declare module '@deepseek-ai/dsh-session-projection/types' {
  interface SessionProjectionStateMap { contextManagerDiagnostics: State }
}
const count = z.number().finite().nonnegative()
const entrySchema = z.object({
  id: z.string(), kind: z.enum(['compact', 'prune']), startedAt: count, endedAt: count.optional(),
  status: z.enum(['running', 'completed', 'failed', 'interrupted', 'unapplied']),
  manual: z.boolean(), applied: z.boolean(), beforeTokens: count.optional(), afterTokens: count.optional(),
  messages: count.optional(), error: z.string().max(300).optional(),
})
const viewSchema = z.object({
  request: z.object({ provider: z.string(), model: z.string(), effort: z.string().optional(), maxTokens: count.optional(), time: count }).nullable(),
  tools: z.object({ count, top: z.array(z.object({ name: z.string().max(120), tokens: count })).max(8) }),
  requests: z.array(z.object({ seq: count, time: count, provider: z.string(), model: z.string(), turn: count, step: count, input: count, output: count })).max(HISTORY_LIMIT),
  compactions: z.array(entrySchema).max(HISTORY_LIMIT),
})
const stateSchema = z.object({ view: viewSchema, pending: z.object({ id: z.string(), seq: count, start: count, end: count }).nullable() })

function update(state: State, id: string, patch: Partial<CompactionEntry>): State {
  const entries = state.view.compactions
  if (!entries.some(entry => entry.id === id)) return state
  return { ...state, view: { ...state.view, compactions: entries.map(entry => entry.id === id ? { ...entry, ...patch } : entry) } }
}
function append(state: State, entry: CompactionEntry): State {
  return { ...state, view: { ...state.view, compactions: [...state.view.compactions, entry].slice(-HISTORY_LIMIT) } }
}

/** Pure log fold; observing it never invokes a model, opens an Agent or edits history. */
export function foldDiagnostics(previous: State, event: SessionEvent): State {
  let state = previous
  if (state.pending) {
    const pending = state.pending
    state = { ...state, pending: null }
    // Match the contractual adjacent replacement, including reversed seq endpoints.
    if (event.seq === pending.seq + 1 && event.type === 'user/message' && event.surfaceOp !== 'append'
      && event.surfaceOp.startSeq === pending.start && event.surfaceOp.endSeq === pending.end) {
      state = update(state, pending.id, { applied: true, afterTokens: estimateMessage(event.data) })
      if (state.view.compactions.find(entry => entry.id === pending.id)?.kind === 'prune') {
        state = update(state, pending.id, { status: 'completed', endedAt: event.time })
      }
    } else if (state.view.compactions.find(entry => entry.id === pending.id)?.kind === 'prune') {
      state = update(state, pending.id, { status: 'unapplied', endedAt: event.time })
    }
  }
  switch (event.type) {
    case 'request/header': {
      const header = canonicalHeader(event.data.header)
      const { provider, model, reasoningEffort, maxTokens } = header.config
      const cap = maxTokens
      return { ...state, view: { ...state.view,
        request: { provider, model, time: event.time,
          ...(reasoningEffort === undefined ? {} : { effort: String(reasoningEffort) }),
          ...(typeof cap === 'number' && Number.isFinite(cap) && cap >= 0 ? { maxTokens: cap } : {}) },
        tools: { count: header.tools?.length ?? 0, top: (header.tools ?? []).map(tool => ({
          name: tool.name.slice(0, 120), tokens: Math.ceil(JSON.stringify(tool).length / 4),
        })).sort((a, b) => b.tokens - a.tokens).slice(0, 8) },
      } }
    }
    case 'assistant/message': {
      const { usage, turn, step } = event.data
      const route = state.view.request
      if (!usage || !route || event.surfaceOp !== 'append') return state
      return { ...state, view: { ...state.view, requests: [...state.view.requests, {
        seq: event.seq, time: event.time, provider: route.provider, model: route.model, turn, step,
        input: usage.inputTokens + (usage.cacheReadTokens ?? 0) + (usage.cacheWriteTokens ?? 0), output: usage.outputTokens,
      }].slice(-HISTORY_LIMIT) } }
    }
    case 'compaction/start':
      return append(state, { id: event.data.compactionId, kind: 'compact', startedAt: event.time,
        status: 'running', manual: event.data.turn === null, applied: false })
    case 'compaction/summary': {
      const { compactionId, shadowedRange, shadowedTokenCount, shadowedSeqs } = event.data
      state = update(state, compactionId, { beforeTokens: shadowedTokenCount, messages: shadowedSeqs.length })
      return { ...state, pending: { id: compactionId, seq: event.seq, start: shadowedRange.start, end: shadowedRange.end } }
    }
    case 'compaction/prune': {
      const { shadowedRange, shadowedTokenCount, shadowedSeqs } = event.data
      const id = `prune:${event.seq}`
      state = append(state, { id, kind: 'prune', startedAt: event.time, status: 'running', manual: false,
        applied: false, beforeTokens: shadowedTokenCount, messages: shadowedSeqs.length })
      return { ...state, pending: { id, seq: event.seq, start: shadowedRange.start, end: shadowedRange.end } }
    }
    case 'compaction/end': {
      const entry = state.view.compactions.find(item => item.id === event.data.compactionId)
      return update(state, event.data.compactionId, { endedAt: event.time,
        status: event.data.error ? 'failed' : entry?.applied ? 'completed' : 'unapplied',
        ...(event.data.error ? { error: event.data.error.slice(0, 300) } : {}) })
    }
    case 'session/end-seed':
      return state.view.compactions.some(entry => entry.status === 'running') ? { ...state,
        view: { ...state.view, compactions: state.view.compactions.map(entry => entry.status === 'running'
          ? { ...entry, status: 'interrupted' as const } : entry) } } : state
    default: return state
  }
}

export const diagnosticsProjection = {
  key: 'contextManagerDiagnostics', stateSchema,
  init: (): State => ({ view: { request: null, tools: { count: 0, top: [] }, requests: [], compactions: [] }, pending: null }),
  apply: foldDiagnostics,
  wire: { viewSchema, view: (state: State) => state.view },
  stateVersion: 1,
} satisfies ProjectionDefinition<'contextManagerDiagnostics', State>
