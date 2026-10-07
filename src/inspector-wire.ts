import { z } from 'zod'
import type { TypertRemoteContribution } from '@deepseek-ai/dsh-typert-protocol'

const count = () => z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER)
const seq = () => z.number().int().min(-1).max(Number.MAX_SAFE_INTEGER)
const category = () => z.enum(['summary', 'system', 'tools', 'user', 'inject', 'skill', 'assistant', 'tool'])
const sessionId = () => z.string().min(1).max(500)
export function idleQuerySchema() { return z.object({ sessionId: sessionId() }).strict() }
export function idleStatusSchema() { return z.object({
  status: z.enum(['off', 'waiting', 'scheduled', 'checking', 'compacting', 'completed', 'skipped', 'cancelled', 'failed']),
  dueAt: count().nullable(), message: z.string().max(300), beforeTokens: count().optional(), afterTokens: count().optional(),
  reasonCode: z.string().max(100).optional(), restored: z.boolean().optional(), windowTokens: count().optional(), minimumPercent: z.number().min(0).max(100).optional(), updatedAt: count().optional(),
  compactionPhase: z.enum(['summarizing', 'repairing']).optional(),
}) }
export function inspectQuerySchema() { return z.object({ sessionId: sessionId(), atSeq: seq().nullable(), offset: count(), category: z.union([category(), z.literal('all')]), group: z.enum(['summary', 'tool', 'message', 'instruction']).optional(), search: z.string().max(200), sort: z.enum(['size', 'position']), archived: z.boolean() }).strict() }
export function contentQuerySchema() { return z.object({ sessionId: sessionId(), cutSeq: seq(), id: z.string().min(1).max(100), offset: count(), sourceOffset: count().optional() }).strict() }
const contentRowSchema = () => z.object({ id: z.string(), seq: seq(), title: z.string().max(160), source: z.string().max(200), category: category(), tokens: count(), current: z.boolean(), images: count() }).strict()
const contextDeltaSchema = () => z.object({ fromSeq: count(), toSeq: count(), beforeTokens: count(), afterTokens: count(), deltaTokens: z.number().int().min(-Number.MAX_SAFE_INTEGER).max(Number.MAX_SAFE_INTEGER) }).strict()
const goalReadoutSchema = () => z.object({
  phase: z.string().min(1).max(100),
  blockedReason: z.object({ code: z.string().min(1).max(100), message: z.string().max(4000) }).strict().nullable(),
  roundsStarted: count(), maxGoalRounds: count(),
}).strict()
export function inspectionSchema() { return z.object({
  sessionId: sessionId(), cursor: seq(), cutSeq: seq(), sampledAt: count(), historical: z.boolean(),
  pressure: z.object({ projected: count(), input: count(), window: count().nullable() }).nullable(),
  model: z.object({ provider: z.string(), model: z.string(), effort: z.string().nullable(), maxTokens: count().nullable() }).nullable(),
  parts: z.array(z.object({ category: category(), tokens: count(), count: count() })).max(8),
  official: z.object({ system: count(), tools: count(), messages: count() }).nullable(),
  usage: z.object({ input: count(), output: count(), cacheRead: count(), uncached: count(), cacheWrite: count() }).nullable(),
  summaryUsage: z.object({ input: count(), output: count(), attempts: count(), unknownAttempts: count(), since: count() }).strict().optional(),
  contextGrowth: z.object({ sinceCompaction: contextDeltaSchema().nullable(), lastToolResult: contextDeltaSchema().nullable() }).strict().optional(),
  goal: goalReadoutSchema().optional(),
  pressureHistory: z.array(z.object({ seq: seq(), time: count(), tokens: count().nullable(), window: count().nullable(), kind: z.enum(['reply', 'replace', 'current']) })).max(40),
  rows: z.array(contentRowSchema()).max(50),
  total: count(), offset: count(), pageSize: count(), activeCount: count(), archivedCount: count(),
  requests: z.array(z.object({ seq: seq(), time: count(), turn: count(), step: count(), provider: z.string(), model: z.string(), input: count().nullable(), output: count().nullable(), cacheRead: count().nullable() })).max(200),
  requestCount: count(),
  compactions: z.array(z.object({ id: z.string(), kind: z.enum(['compact', 'prune']), startedAt: count(), endedAt: count().optional(), status: z.enum(['running', 'completed', 'failed', 'interrupted', 'unapplied']), manual: z.boolean(), applied: z.boolean(), beforeTokens: count().optional(), afterTokens: count().optional(), messages: count().optional(), inputTokens: count().optional(), outputTokens: count().optional(), error: z.string().max(300).optional(), trigger: z.enum(['idle', 'pressure', 'overflow', 'manual']).optional() })).max(12),
}) }
export function contentPageSchema() { return z.object({ sessionId: sessionId(), cutSeq: seq(), id: z.string(), text: z.string().max(16000), offset: count(), totalChars: count(), nextOffset: count().nullable(),
  sources: z.object({ rows: z.array(contentRowSchema()).max(4), offset: count(), total: count(), nextOffset: count().nullable() }).strict().optional(),
}).strict() }
export const TYPERT_REMOTE = {
  package: '@missher/dsh-context-manager',
  descriptors: [
    { id: '@missher/dsh-context-manager#contextInspector/idleStatus', service: 'contextInspector', namespace: 'contextInspector', method: 'idleStatus', invocation: { kind: 'direct' },
      parameters: [{ name: 'query', wire: 'query', source: 'json', codec: { mode: 'strict', typeSymbol: '@missher/dsh-context-manager#IdleQuery', create: idleQuerySchema } }],
      cancellation: { parameter: 'signal' }, result: { mode: 'strict', typeSymbol: '@missher/dsh-context-manager#IdleStatus', create: idleStatusSchema } },
    { id: '@missher/dsh-context-manager#contextInspector/inspect', service: 'contextInspector', namespace: 'contextInspector', method: 'inspect', invocation: { kind: 'direct' },
      parameters: [{ name: 'query', wire: 'query', source: 'json', codec: { mode: 'strict', typeSymbol: '@missher/dsh-context-manager#InspectQuery', create: inspectQuerySchema } }],
      cancellation: { parameter: 'signal' }, result: { mode: 'strict', typeSymbol: '@missher/dsh-context-manager#Inspection', create: inspectionSchema } },
    { id: '@missher/dsh-context-manager#contextInspector/content', service: 'contextInspector', namespace: 'contextInspector', method: 'content', invocation: { kind: 'direct' },
      parameters: [{ name: 'query', wire: 'query', source: 'json', codec: { mode: 'strict', typeSymbol: '@missher/dsh-context-manager#ContentQuery', create: contentQuerySchema } }],
      cancellation: { parameter: 'signal' }, result: { mode: 'strict', typeSymbol: '@missher/dsh-context-manager#ContentPage', create: contentPageSchema } },
  ],
} satisfies TypertRemoteContribution
