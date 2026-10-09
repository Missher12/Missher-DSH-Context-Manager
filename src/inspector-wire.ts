import { z } from 'zod'
import type { TypertRemoteContribution } from '@deepseek-ai/dsh-typert-protocol'

const count = () => z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER)
const seq = () => z.number().int().min(-1).max(Number.MAX_SAFE_INTEGER)
const signed = () => z.number().int().min(-Number.MAX_SAFE_INTEGER).max(Number.MAX_SAFE_INTEGER)
const category = () => z.enum(['summary', 'system', 'tools', 'user', 'inject', 'skill', 'assistant', 'tool'])
const sessionId = () => z.string().min(1).max(500)
export function recoveryGrantSchema() { return z.object({ sessionId: sessionId(), requestHash: z.string().regex(/^[a-f0-9]{64}$/) }).strict() }
export function emergencyConfirmSchema(){return z.object({sessionId:sessionId(),token:z.string().uuid(),acceptUnknownCost:z.literal(true)}).strict()}
export function emergencyPlanSchema(){return z.object({token:z.string().uuid(),expiresAt:count(),cycle:count(),warning:z.string().max(300),model:z.string().max(240),deadline:z.string().max(200),estimatedInput:count()}).strict()}
export function recoveryResultSchema() { return z.object({ granted: z.literal(true) }).strict() }
export function idleQuerySchema() { return z.object({ sessionId: sessionId() }).strict() }
export function idleStatusSchema() { return z.object({
  status: z.enum(['off', 'waiting', 'scheduled', 'checking', 'compacting', 'completed', 'skipped', 'cancelled', 'failed']),
  dueAt: count().nullable(), message: z.string().max(300), beforeTokens: count().optional(), afterTokens: count().optional(),
  reasonCode: z.string().max(100).optional(), restored: z.boolean().optional(), windowTokens: count().optional(), minimumPercent: z.number().min(0).max(100).optional(), updatedAt: count().optional(),
  owner: z.enum(['context-manager', 'other', 'unknown']).optional(),
  minimumTokens: count().optional(), deadline: z.string().max(200).optional(), execution: z.string().max(400).optional(), emergency:z.object({eligible:z.boolean(),used:z.boolean(),message:z.string().max(300)}).strict().optional(),
  recovery: z.object({ available: z.boolean(), message: z.string().max(300), requestHash: z.string().regex(/^[a-f0-9]{64}$/).optional() }).strict().optional(),
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
const fieldTotalSchema = () => z.object({ sum: count(), reported: count(), missing: count() }).strict()
const efficiencySchema = () => z.object({
  accounting: z.enum(['host-projection', 'event-log']),
  host: z.object({ uncachedInputTokens: count(), cacheReadTokens: count(), cacheWriteTokens: count(), outputTokens: count() }).strict().nullable(),
  mirrored: z.object({
    settledAttempts: count(), retries: count(), withoutUsage: count(),
    uncachedInput: fieldTotalSchema(), cacheRead: fieldTotalSchema(), cacheWrite: fieldTotalSchema(),
    output: fieldTotalSchema(), cacheInclusiveInput: fieldTotalSchema(), complete: z.boolean(),
  }).strict(),
  differences: z.array(z.object({ field: z.enum(['uncachedInputTokens', 'cacheReadTokens', 'cacheWriteTokens', 'outputTokens']),
    host: count(), mirrored: count(), delta: signed() }).strict()).max(4),
  summaryAndRepair: z.object({ source: z.string().min(1).max(200), input: count(), output: count(), cacheRead: count().nullable(), cacheWrite: count().nullable(),
    attempts: count(), unknownAttempts: count(), purposeSplit: z.literal(false), note: z.string().min(1).max(600) }).strict().nullable(),
  maintenanceSuspects: count(),
  cacheHitRatio: z.number().min(0).max(1).nullable(),
  requests: z.array(z.object({ seq: seq(), time: count(), turn: count(), step: count(), settledBy: z.enum(['message', 'attempt']),
    routeKnown: z.boolean(), retry: count(), provider: z.string().max(200), model: z.string().max(200),
    uncachedInput: count().nullable(), cacheRead: count().nullable(), cacheWrite: count().nullable(), output: count().nullable(),
    maintenanceSuspect: z.boolean() }).strict()).max(200),
  fingerprint: z.object({ prefix: z.string().max(64), toolSchema: z.string().max(64), toolOrder: z.string().max(64),
    tools: count(), systemChars: count() }).strict().nullable(),
  changes: z.array(z.object({ seq: seq(), time: count(), changed: z.array(z.enum(['prefix', 'toolSchema', 'toolOrder'])).min(1).max(3), note: z.string().max(400) }).strict()).max(16),
}).strict()
const reductionSchema = () => z.object({
  mode: z.enum(['off', 'observe', 'reduce']),
  pipelineReported: z.boolean(),
  published: z.object({ references: count(), originalChars: count(), shortenedChars: count(), visibleCharsRemoved: count() }).strict(),
  pending: count(), reverted: count(),
  recent: z.array(z.object({ contentId: z.string().min(1).max(200), callId: z.string().min(1).max(200).nullable(),
    tool: z.string().max(200), shortenedChars: count(), complete: z.boolean(), at: count() }).strict()).max(8),
  notes: z.array(z.string().max(400)).max(8),
  run: z.object({ considered: count(), unverified: count(), wouldReduce: count(), skipped: count(), failed: count(),
    lastSkip: z.string().max(100).nullable(), lastReason: z.string().max(300).nullable() }).strict(),
  archiveError: z.string().max(400).optional(),
}).strict()
export function inspectionSchema() { return z.object({
  sessionId: sessionId(), cursor: seq(), cutSeq: seq(), sampledAt: count(), historical: z.boolean(),
  pressure: z.object({ projected: count(), input: count(), window: count().nullable() }).nullable(),
  admission: z.object({ tokens: count(), logRevision: count(), baseline: z.enum(['none', 'estimated', 'usage']),
    window: count().positive().nullable(), outputReserve: count().nullable() }).strict().optional(),
  model: z.object({ provider: z.string(), model: z.string(), effort: z.string().nullable(), maxTokens: count().nullable() }).nullable(),
  parts: z.array(z.object({ category: category(), tokens: count(), count: count() })).max(8),
  official: z.object({ system: count(), tools: count(), messages: count() }).nullable(),
  usage: z.object({ input: count(), output: count(), cacheRead: count(), uncached: count(), cacheWrite: count() }).nullable(),
  summaryUsage: z.object({ input: count(), output: count(), attempts: count(), unknownAttempts: count(), since: count() }).strict().optional(),
  contextGrowth: z.object({ sinceCompaction: contextDeltaSchema().nullable(), lastToolResult: contextDeltaSchema().nullable() }).strict().optional(),
  efficiency: efficiencySchema().optional(),
  reduction: reductionSchema().optional(),
  goal: goalReadoutSchema().optional(),
  pressureHistory: z.array(z.object({ seq: seq(), time: count(), tokens: count().nullable(), window: count().nullable(), kind: z.enum(['reply', 'replace', 'current']) })).max(40),
  rows: z.array(contentRowSchema()).max(50),
  total: count(), offset: count(), pageSize: count(), activeCount: count(), archivedCount: count(),
  requests: z.array(z.object({ seq: seq(), time: count(), turn: count(), step: count(), provider: z.string(), model: z.string(), input: count().nullable(), output: count().nullable(), cacheRead: count().nullable() })).max(200),
  requestCount: count(),
  compactions: z.array(z.object({ id: z.string(), kind: z.enum(['compact', 'prune']), startedAt: count(), endedAt: count().optional(), status: z.enum(['running', 'completed', 'failed', 'interrupted', 'unapplied']), manual: z.boolean(), execution:z.string().max(400).optional(), modelCallStatus:z.enum(['not_dispatched','dispatched']).optional(), applied: z.boolean(), beforeTokens: count().optional(), afterTokens: count().optional(), messages: count().optional(), inputTokens: count().optional(), outputTokens: count().optional(), error: z.string().max(300).optional(), trigger: z.enum(['idle', 'pressure', 'overflow', 'manual']).optional() })).max(12),
}) }
export function contentPageSchema() { return z.object({ sessionId: sessionId(), cutSeq: seq(), id: z.string(), text: z.string().max(16000), offset: count(), totalChars: count(), nextOffset: count().nullable(),
  sources: z.object({ rows: z.array(contentRowSchema()).max(4), offset: count(), total: count(), nextOffset: count().nullable() }).strict().optional(),
}).strict() }
export const TYPERT_REMOTE = {
  package: '@missher/dsh-context-manager',
  descriptors: [
    {id:'@missher/dsh-context-manager#contextRecovery/prepareEmergency',service:'contextRecovery',namespace:'contextRecovery',method:'prepareEmergency',invocation:{kind:'direct'},
      parameters:[{name:'query',wire:'query',source:'json',codec:{mode:'strict',typeSymbol:'@missher/dsh-context-manager#IdleQuery',create:idleQuerySchema}}],
      cancellation:{parameter:'signal'},result:{mode:'strict',typeSymbol:'@missher/dsh-context-manager#EmergencyPlan',create:emergencyPlanSchema}},
    {id:'@missher/dsh-context-manager#contextRecovery/executeEmergency',service:'contextRecovery',namespace:'contextRecovery',method:'executeEmergency',invocation:{kind:'direct'},
      parameters:[{name:'query',wire:'query',source:'json',codec:{mode:'strict',typeSymbol:'@missher/dsh-context-manager#EmergencyConfirm',create:emergencyConfirmSchema}}],
      cancellation:{parameter:'signal'},result:{mode:'strict',typeSymbol:'@missher/dsh-context-manager#RecoveryResult',create:recoveryResultSchema}},

    { id: '@missher/dsh-context-manager#contextRecovery/authorizeOnce', service: 'contextRecovery', namespace: 'contextRecovery', method: 'authorizeOnce', invocation: { kind: 'direct' },
      parameters: [{ name: 'query', wire: 'query', source: 'json', codec: { mode: 'strict', typeSymbol: '@missher/dsh-context-manager#RecoveryGrant', create: recoveryGrantSchema } }],
      cancellation: { parameter: 'signal' }, result: { mode: 'strict', typeSymbol: '@missher/dsh-context-manager#RecoveryResult', create: recoveryResultSchema } },
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
