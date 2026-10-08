/**
 * Safe tool-result reduction at the Host's public `tools/post-execute` seam.
 *
 * Ordering facts this module depends on (verified against the Host source):
 * `post-execute` runs after `projectContent` and before the definition-owned
 * `finalizeContent`, and `dsh-spill-policy` registers its listener with
 * `prepend: true`, so this listener sees the Host's accepted content before
 * spill enforces its own retention around the returned decision.
 *
 * What it never does: change arguments, commands, exit status, call identity,
 * permissions, the canonical value, error results, blocked results, non-text
 * content, additional contexts, or any result whose reduction cannot be
 * verified afterwards. A failure to store the original leaves the Host's own
 * treatment untouched.
 *
 * Two independent guards prevent reducing a derived copy:
 * - A decision that replaces `value` is left untouched; the Host re-renders its
 *   content from that value, so rewriting it here would be unverified.
 * - A tool whose registered definition owns `projectContent`/`finalizeContent`
 *   is skipped entirely, because that definition may overwrite the content
 *   after this waterfall. The registered definition is only ever read.
 *
 * Reduction is published only after the original bytes are durable, and the
 * short text is a pure function of those bytes, so a replayed call yields
 * byte-identical content (request-prefix stability).
 * @module
 */

import type { Context } from '@deepseek-ai/cordis'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import type { PostToolDecision, ToolDefinition, ToolExecution, ToolExecutionResult } from '@deepseek-ai/dsh-tools'
import { estimateContent } from '@deepseek-ai/dsh-token-meter/estimate'
import { hashText, type ArchiveContent, type TextArchive } from './archive.ts'
import { REFERENCE_PREFIX, reduceText, RULE_ID, RULE_VERSION, type SkipReason } from './reducer.ts'
import type { Policy } from './policy.ts'

/** Written by other policies; never reduce content that already mentions it. */
const FOREIGN_MARKERS = [REFERENCE_PREFIX, 'dsh-spill', 'Read the full result from',
  // The Host's own upstream-truncation notice: such text is not a complete
  // original and must never be archived as one.
  'output truncated; full output', 'some output was dropped from memory']
/** Plain-text result producers this rule has evidence for. Anything else passes through. */
const RECOGNIZED_TOOLS = new Set(['bash'])
/** Multi-line file-shaped results whose exact bytes and anchors must survive. */
const PROTECTED_TOOLS = new Set(['read', 'edit', 'write', 'str_replace_editor', 'read_image', 'apply_patch', 'glob', 'grep'])

export type ReductionSkip = SkipReason | 'error_result' | 'blocked_decision' | 'replaced_value' | 'protected_tool'
  | 'unrecognized_tool' | 'foreign_marker' | 'no_session' | 'archive_unavailable' | 'cancelled' | 'finalizer_tool'
  | 'non_text' | 'unverified_result' | 'no_savings' | 'skipped_disabled' | 'unloaded' | 'internal_error'

export interface ReductionStats {
  /** Host results this listener examined (successful, accepted, mode not off). */
  considered: number
  /** Results the value check refused because success could not be established. */
  unverified: number
  /** Results the rule would shorten, whether or not the mode publishes it. */
  wouldReduce: number
  /** Short results produced and confirmed by the authoritative Host result. */
  published: number
  /** Short results the Host finally dropped (finalizeContent or another policy). */
  reverted: number
  /** Short results produced but not yet confirmed; never counted as savings. */
  pending: number
  skipped: number
  failed: number
  lastSkip?: ReductionSkip
  lastReason?: string
}

interface Pending {
  readonly contentId: string
  readonly content: string
  readonly archive: TextArchive
  readonly originalChars: number
  readonly shortenedChars: number
  readonly sessionId: string
  readonly callId?: string
}

/** Resolve the exact single text block a reduction may act on. */
function plainText(content: readonly ContentBlock[]): string | undefined {
  if (content.length !== 1) return undefined
  const block = content[0]
  return block?.type === 'text' ? block.text : undefined
}

/**
 * Decide whether the Host actually proved this call succeeded.
 *
 * A non-zero exit is not always an error result, so `isError` alone is not
 * evidence: for the recognized shell tool the canonical value is inspected
 * (exit code, timeout, killed signal, and per-stream truncation). An
 * unrecognised value shape means success cannot be established at all, and the
 * result is passed through rather than reduced on a guess.
 * @param name - the producing tool.
 * @param value - the canonical result value the Host produced.
 * @returns `'complete'` only when the value proves an untruncated success.
 */
function valueEvidence(name: string, value: unknown): { state: 'complete' } | { state: 'refused'; reason: string } {
  if (!RECOGNIZED_TOOLS.has(name)) return { state: 'refused', reason: 'the producing tool is not one this rule has evidence for' }
  if (value === null || typeof value !== 'object') return { state: 'refused', reason: 'the tool value has no inspectable shape' }
  const record = value as Record<string, unknown>
  if (record.kind !== 'foreground') return { state: 'refused', reason: `unrecognised shell result kind ${JSON.stringify(record.kind)}` }
  if (typeof record.exitCode !== 'number') return { state: 'refused', reason: 'the shell result carries no exit code' }
  if (record.exitCode !== 0) return { state: 'refused', reason: `exit code ${record.exitCode} is not success` }
  if (record.timedOut === true) return { state: 'refused', reason: 'the command timed out' }
  if (record.signal !== null && record.signal !== undefined) return { state: 'refused', reason: `the command was killed by ${String(record.signal)}` }
  for (const stream of ['stdout', 'stderr'] as const) {
    const output = record[stream]
    if (output === null || typeof output !== 'object') return { state: 'refused', reason: `the ${stream} shape is unrecognised` }
    const held = output as Record<string, unknown>
    if (typeof held.text !== 'string' || typeof held.truncated !== 'boolean') {
      return { state: 'refused', reason: `the ${stream} completeness is not declared` }
    }
    if (held.truncated) return { state: 'refused', reason: `${stream} was truncated upstream` }
    if (stream === 'stderr' && held.text.length > 0) return { state: 'refused', reason: 'the command wrote to stderr' }
  }
  return { state: 'complete' }
}

/**
 * Register the reduction policy when the running Host exposes the contract it
 * needs. Returns live readers for status reporting; an absent tool runtime, or
 * a Host whose pipeline never reports a final result, simply leaves the
 * plugin's existing compaction behaviour untouched.
 *
 * @param ctx - plugin context.
 * @param policy - live policy snapshot reader.
 * @param archive - lazy archive opener; must throw when the archive is unusable.
 * @returns live status readers (process totals plus per-session confirmed counts) and a capability probe.
 */
export function registerToolResultReduction(
  ctx: Context,
  policy: () => Readonly<Policy>,
  archive: () => TextArchive | undefined,
): { stats: () => ReductionStats; reported: () => boolean; sessions: () => ReadonlyMap<string, { published: number; reverted: number }> } {
  const stats: ReductionStats = { considered: 0, unverified: 0, wouldReduce: 0, published: 0, reverted: 0, pending: 0, skipped: 0, failed: 0 }
  /** Short texts this listener produced for a dispatch, awaiting final confirmation. */
  const pending = new WeakSet<object>()
  /** Exact short text this listener produced, keyed by the frozen execution object. */
  const entries = new WeakMap<object, string>()
  /** Archive facts needed to record the final outcome for the right grant. */
  const records = new WeakMap<object, Pending>()
  /** Per-session confirmed counts; a global counter is not a session total. */
  const sessions = new Map<string, { published: number; reverted: number }>()
  let reported = false

  /**
   * Read the registered definition only to refuse reducing a tool that owns a
   * content transform. The Host strips both callbacks from model-facing
   * schemas, so a read-only borrow is the only honest way to know — and no
   * invented "supportsContentOnlyRewrite" flag stands in for it. An unavailable
   * registry is treated as "owns a transform": not reducing is always safe.
   * @param exec - the execution whose tool registration is inspected.
   */
  const ownsContentTransform = (exec: ToolExecution): boolean => {
    const tools = ctx.get('tools') as unknown as { get?: (name: string, agent?: unknown) => ToolDefinition | undefined }
    if (typeof tools?.get !== 'function') return true
    let definition: ToolDefinition | undefined
    try { definition = tools.get(exec.name, exec.agent) } catch { return true }
    if (definition === undefined) return true
    return typeof definition.projectContent === 'function' || typeof definition.finalizeContent === 'function'
  }

  ctx.inject(['tools'], scope => {
    /**
     * Public fiber-lifecycle fence for this registration.
     *
     * Disposal and an in-flight listener can interleave: `tools/post-execute`
     * suspends at `await next()`, the owning fiber is disposed, and the
     * continuation would otherwise still save an original and hand a short text
     * back to a Host whose `tools/result` listener is already gone — a reduction
     * that can be delivered but never confirmed. The flag is cleared by the
     * fiber's own disposal, so the delivery is refused instead, and the Host's
     * own cancellation stays the authoritative stop.
     */
    let registered = true
    scope.effect(() => () => { registered = false })
    // The check is handed to `reduceDecision` as a closure, never shared as a
    // module-level flag: each registration owns its own lifetime, so a
    // re-mounted listener can never re-authorise an old, disposed continuation.
    const live = (): boolean => registered
    scope.events.on('tools/post-execute', async (exec: ToolExecution, result: Readonly<ToolExecutionResult>, next: () => Promise<PostToolDecision>): Promise<PostToolDecision> => {
      // The decision is produced first: another policy's block or value
      // replacement decides what, if anything, may still be reduced.
      const decision = await next()
      // Checked again after the suspension: the registration may have been
      // disposed while this listener was waiting on the downstream waterfall.
      if (!live()) { stats.lastSkip = 'unloaded'; return decision }
      try {
        return reduceDecision(exec, result, decision, live)
      } catch (error) {
        // A failure inside this policy is not an archive failure: they are
        // reported separately so diagnostics never blame the wrong subsystem.
        stats.failed++
        stats.lastSkip = 'internal_error'
        stats.lastReason = error instanceof Error ? error.message : String(error)
        ctx.logger.warn('context-manager: tool result reduction skipped: %s', stats.lastReason)
        return decision
      }
    })
    scope.events.on('tools/result', (exec: Readonly<ToolExecution>, result: Readonly<ToolExecutionResult>): undefined => {
      reported = true
      try { confirm(exec, result) } catch (error) {
        stats.failed++
        stats.lastReason = error instanceof Error ? error.message : String(error)
        ctx.logger.warn('context-manager: could not record the final tool result outcome: %s', stats.lastReason)
      }
      return undefined
    })
  })

  /**
   * The acceptance-critical link: the Host applies the tool's own
   * `finalizeContent` after this waterfall, so a short text only counts once the
   * authoritative result is observed to still carry those exact bytes. The
   * outcome is durable per grant and idempotent per dispatch, so a repeated
   * notification cannot double-count and a restart re-derives the truth.
   */
  function confirm(exec: Readonly<ToolExecution>, result: Readonly<ToolExecutionResult>): void {
    if (!pending.has(exec as object)) return
    pending.delete(exec as object)
    stats.pending = Math.max(0, stats.pending - 1)
    const record = records.get(exec as object)
    const final = plainText(result.content)
    const published = record !== undefined && final === entries.get(exec as object)
    if (published) {
      record.archive.notePublished(record.contentId, record.sessionId, record.callId)
      stats.published++
      bump(record.sessionId, 'published')
      return
    }
    stats.reverted++
    if (record !== undefined) {
      record.archive.noteReverted(record.contentId, record.sessionId, record.callId, 'the final Host result did not carry the reduced text')
      bump(record.sessionId, 'reverted')
    }
  }

  function bump(sessionId: string, field: 'published' | 'reverted'): void {
    const held = sessions.get(sessionId) ?? { published: 0, reverted: 0 }
    held[field]++
    sessions.set(sessionId, held)
  }

  function skip(reason: ReductionSkip, detail?: string): void {
    stats.skipped++
    stats.lastSkip = reason
    if (detail !== undefined) stats.lastReason = detail
  }

  function reduceDecision(exec: ToolExecution, result: Readonly<ToolExecutionResult>, decision: PostToolDecision, live: () => boolean): PostToolDecision {
    const settings = policy()
    if (settings.toolResultsMode === 'off') return decision
    if (result.isError) { skip('error_result'); return decision }
    if (decision.kind !== 'accept') { skip('blocked_decision'); return decision }
    // A value replacement re-renders content from the value in the registry;
    // treating the pre-replacement content as the input would attribute a
    // reduction to bytes the Host never sent. The union is read structurally
    // because its discriminant does not separate the two accept variants.
    const accepted = decision as Extract<PostToolDecision, { kind: 'accept' }>
    if (accepted.value !== undefined) { skip('replaced_value'); return decision }
    if (exec.signal.aborted) { skip('cancelled'); return decision }
    stats.considered++
    if (PROTECTED_TOOLS.has(exec.name)) { skip('protected_tool'); return decision }
    if (!RECOGNIZED_TOOLS.has(exec.name)) { skip('unrecognized_tool'); return decision }
    if (ownsContentTransform(exec)) { skip('finalizer_tool'); return decision }
    // Success has to be proven from the Host's own value: a non-zero exit can
    // arrive with isError false, and an unknown shape is not evidence.
    const evidence = valueEvidence(exec.name, accepted.value ?? result.value)
    if (evidence.state !== 'complete') { stats.unverified++; skip('unverified_result', evidence.reason); return decision }
    const content = accepted.content ?? result.content
    const text = plainText(content)
    if (text === undefined) { skip('non_text'); return decision }
    if (FOREIGN_MARKERS.some(marker => text.includes(marker))) { skip('foreign_marker'); return decision }
    if (text.length > settings.toolResultsMaxChars) { skip('above_max_input'); return decision }
    const outcome = reduceText(text, { maxInputChars: settings.toolResultsMaxChars, minSavingsChars: settings.toolResultsMinSavings })
    if (outcome.reduced === undefined) { skip(outcome.reason); return decision }
    stats.wouldReduce++
    if (settings.toolResultsMode === 'observe') return decision
    const sessionId = exec.agent?.session.header.id
    if (sessionId === undefined) { skip('no_session'); return decision }
    // Do not store an original that could never be published: the registration
    // may already have been disposed during the downstream waterfall.
    if (!live()) { skip('unloaded'); return decision }
    const store = archive()
    if (store === undefined) { skip('archive_unavailable'); return decision }
    const before = estimateContent([{ type: 'text', text }])
    let content$: ArchiveContent
    let shortened = ''
    try {
      // The original is durable before any short text can be observed. The
      // content id is the digest of the original bytes, so the reference and
      // the short text are pure functions of those bytes and the call
      // identity, never of wall-clock time.
      const contentId = hashText(text)
      const render = (reducedChars: number): string => `${outcome.reduced}\n\n${REFERENCE_PREFIX} id=${contentId} session=${JSON.stringify(sessionId)} call=${JSON.stringify(exec.callId)} rule=${RULE_ID} v${RULE_VERSION} reduced=${reducedChars}]]`
      // `reduced=` describes the exact byte length of the very text it is
      // embedded in, so the number of digits it needs is part of its own value.
      // The render is iterated to that fixed point instead of being written once
      // and left one digit short of the truth; a reader that binds the declared
      // length to the bytes it received would otherwise refuse a real reference.
      shortened = render(0)
      for (let pass = 0; pass < 4; pass++) {
        const next = render(shortened.length)
        if (next === shortened) break
        shortened = next
      }
      content$ = store.save({ text, source: `tool:${exec.name}`, rule: RULE_ID, ruleVersion: RULE_VERSION,
        shortenedChars: shortened.length, sessionId, callId: exec.callId, complete: true })
      if (content$.contentId !== contentId) throw new Error('archive returned a different content id than the original digest')
    } catch (error) {
      stats.failed++
      stats.lastSkip = 'archive_unavailable'
      stats.lastReason = error instanceof Error ? error.message : String(error)
      ctx.logger.warn('context-manager: keeping the Host result; original text was not archived: %s', stats.lastReason)
      return decision
    }
    const after = estimateContent([{ type: 'text', text: shortened }])
    if (after >= before) { skip('no_savings'); return decision }
    // Final fence before the short text leaves this listener: a disposal that
    // happened while the original was being stored must not deliver a
    // reduction that can no longer be confirmed.
    if (!live()) { skip('unloaded'); return decision }
    // Publish the same accepted decision, unchanged apart from the single text
    // block: additional contexts and every other field are carried over as they
    // were so no unrelated content is dropped.
    const decided: PostToolDecision = { kind: 'accept', content: [{ type: 'text', text: shortened }],
      ...(accepted.additionalContexts === undefined ? {} : { additionalContexts: accepted.additionalContexts }) }
    pending.add(exec as object)
    entries.set(exec as object, shortened)
    records.set(exec as object, { contentId: content$.contentId, content: shortened, archive: store,
      originalChars: text.length, shortenedChars: shortened.length, sessionId,
      ...(exec.callId === undefined ? {} : { callId: exec.callId }) })
    stats.pending++
    return decided
  }

  return { stats: () => ({ ...stats }), reported: () => reported, sessions: () => new Map(sessions) }
}
