import { z } from 'zod'
import type { TypertRemoteContribution } from '@deepseek-ai/dsh-typert-protocol'

const count = () => z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER)
const seq = () => z.number().int().min(-1).max(Number.MAX_SAFE_INTEGER)
const category = () => z.enum(['system', 'tools', 'user', 'inject', 'skill', 'assistant', 'tool'])
const sessionId = () => z.string().min(1).max(500)
export function inspectQuerySchema() { return z.object({ sessionId: sessionId(), atSeq: seq().nullable(), offset: count(), category: z.union([category(), z.literal('all')]), search: z.string().max(200), sort: z.enum(['size', 'position']), archived: z.boolean() }).strict() }
export function contentQuerySchema() { return z.object({ sessionId: sessionId(), cutSeq: seq(), id: z.string().min(1).max(100), offset: count() }).strict() }
export function inspectionSchema() { return z.object({
  sessionId: sessionId(), cursor: seq(), cutSeq: seq(), sampledAt: count(), historical: z.boolean(),
  pressure: z.object({ projected: count(), input: count(), window: count().nullable() }).nullable(),
  model: z.object({ provider: z.string(), model: z.string(), effort: z.string().nullable(), maxTokens: count().nullable() }).nullable(),
  parts: z.array(z.object({ category: category(), tokens: count(), count: count() })).max(7),
  official: z.object({ system: count(), tools: count(), messages: count() }).nullable(),
  usage: z.object({ input: count(), output: count(), cacheRead: count() }).nullable(),
  rows: z.array(z.object({ id: z.string(), seq: seq(), title: z.string().max(160), source: z.string().max(200), category: category(), tokens: count(), current: z.boolean(), images: count() })).max(50),
  total: count(), offset: count(), pageSize: count(), activeCount: count(), archivedCount: count(),
  requests: z.array(z.object({ seq: seq(), time: count(), turn: count(), step: count(), provider: z.string(), model: z.string(), input: count().nullable(), output: count().nullable(), cacheRead: count().nullable() })).max(200),
  requestCount: count(),
  compactions: z.array(z.object({ id: z.string(), kind: z.enum(['compact', 'prune']), startedAt: count(), endedAt: count().optional(), status: z.enum(['running', 'completed', 'failed', 'interrupted', 'unapplied']), manual: z.boolean(), applied: z.boolean(), beforeTokens: count().optional(), afterTokens: count().optional(), messages: count().optional(), error: z.string().max(300).optional() })).max(12),
}) }
export function contentPageSchema() { return z.object({ sessionId: sessionId(), cutSeq: seq(), id: z.string(), text: z.string().max(16000), offset: count(), totalChars: count(), nextOffset: count().nullable() }) }
export const TYPERT_REMOTE = {
  package: 'dsh-context-manager',
  descriptors: [
    { id: 'dsh-context-manager#contextInspector/inspect', service: 'contextInspector', namespace: 'contextInspector', method: 'inspect', invocation: { kind: 'direct' },
      parameters: [{ name: 'query', wire: 'query', source: 'json', codec: { mode: 'strict', typeSymbol: 'dsh-context-manager#InspectQuery', create: inspectQuerySchema } }],
      cancellation: { parameter: 'signal' }, result: { mode: 'strict', typeSymbol: 'dsh-context-manager#Inspection', create: inspectionSchema } },
    { id: 'dsh-context-manager#contextInspector/content', service: 'contextInspector', namespace: 'contextInspector', method: 'content', invocation: { kind: 'direct' },
      parameters: [{ name: 'query', wire: 'query', source: 'json', codec: { mode: 'strict', typeSymbol: 'dsh-context-manager#ContentQuery', create: contentQuerySchema } }],
      cancellation: { parameter: 'signal' }, result: { mode: 'strict', typeSymbol: 'dsh-context-manager#ContentPage', create: contentPageSchema } },
  ],
} satisfies TypertRemoteContribution
