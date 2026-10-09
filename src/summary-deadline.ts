/**
 * One owner for the compaction time bound.
 *
 * A transaction owns exactly one hard total bound. Inside it, each provider
 * call gets a first-output wait and a stall bound that progress may renew —
 * never the total. The bound is logical: an abort never proves the provider
 * stopped generating, so callers must treat a timeout as an unknown physical
 * outcome (never as a settled failure that may be retried automatically).
 */

export type DeadlineKind = 'first_output' | 'stall' | 'total'

export interface DeadlineLimits {
  /** How long one call may take before its first non-empty output block. */
  firstOutputMs: number
  /** How long one call's output may stop progressing once it has started. */
  stallMs: number
  /** Hard bound for the whole transaction. Never renewed by progress or by a new call. */
  totalMs: number
}

export type DeadlineCode = 'first_output_timeout' | 'stall_timeout' | 'total_timeout'

const CODE: Record<DeadlineKind, DeadlineCode> = {
  first_output: 'first_output_timeout', stall: 'stall_timeout', total: 'total_timeout',
}

/** A bounded stop with the exact boundary that fired; no summary content is carried. */
export class DeadlineError extends Error {
  readonly code: DeadlineCode
  constructor(readonly kind: DeadlineKind, readonly limits: DeadlineLimits,
    readonly elapsedMs: number, readonly sawProgress: boolean, readonly callElapsedMs = 0) {
    super(`压缩已停止：${kind === 'first_output'
      ? `本次调用等待首个有效输出超过 ${Math.round(limits.firstOutputMs / 1000)} 秒`
      : kind === 'stall'
        ? `本次调用输出停止进展超过 ${Math.round(limits.stallMs / 1000)} 秒`
        : `整笔压缩（含选区、摘要、修复与提交）超过总上限 ${Math.round(limits.totalMs / 1000)} 秒`}；任务原文保留，停止后不再提交新摘要`)
    this.name = 'DeadlineError'
    this.code = CODE[kind]
  }
}

/**
 * One ticker drives every boundary, so no timer race can end a productive call
 * early. Only a non-empty text or reasoning delta counts as progress;
 * `block-start`, `block-end`, `usage`, `finish`, empty deltas and tool-call
 * argument deltas (a summary never legitimately produces tool calls) do not.
 */
export class SummaryDeadline {
  readonly signal: AbortSignal
  private readonly controller = new AbortController()
  private readonly startedAt: number
  private readonly listeners: (() => void)[] = []
  private lastProgressAt: number
  private callStartedAt: number
  private progressedInCall = false
  private activeCall = false
  private stopped = false
  private ticker?: ReturnType<typeof setInterval>

  constructor(readonly limits: DeadlineLimits, external: readonly AbortSignal[] = [],
    private readonly now: () => number = () => Date.now()) {
    this.limits = Object.freeze({ ...limits })
    this.signal = this.controller.signal
    this.startedAt = now()
    this.lastProgressAt = this.startedAt
    this.callStartedAt = this.startedAt
    for (const source of external) this.link(source)
    if (!this.controller.signal.aborted) {
      const period = Math.max(20, Math.min(1000, Math.floor(Math.min(limits.firstOutputMs, limits.stallMs, limits.totalMs) / 4)))
      this.ticker = setInterval(() => this.check(), period)
      this.ticker.unref?.()
    }
  }

  /** Compose one more cancellation source; removed again by {@link dispose}. */
  link(source: AbortSignal): void {
    if (this.stopped) return
    if (source.aborted) { this.stop(); this.controller.abort(source.reason); return }
    const onAbort = () => { this.stop(); this.controller.abort(source.reason) }
    source.addEventListener('abort', onAbort, { once: true })
    this.listeners.push(() => source.removeEventListener('abort', onAbort))
  }

  /** A new provider call inside the same transaction: re-arm first-output/stall only. */
  beginCall(): void {
    this.assertAlive()
    this.activeCall = true
    this.progressedInCall = false
    this.callStartedAt = this.now()
    this.lastProgressAt = this.callStartedAt
  }

  /** Between calls the stall bound is paused; the hard total keeps running. */
  endCall(): void {
    this.check()
    this.activeCall = false
  }

  /** Valid, non-empty output progress renews the current call's stall bound only. */
  noteProgress(): void {
    this.check()
    if (this.stopped || !this.activeCall || this.controller.signal.aborted) return
    this.progressedInCall = true
    this.lastProgressAt = this.now()
  }

  /** Release timers and every composed listener; a finished transaction aborts nothing. */
  dispose(): void {
    this.stop()
  }

  /** Synchronous guard after awaited persistence and immediately before commit. */
  assertAlive(): void {
    this.check()
    this.signal.throwIfAborted()
    if (this.stopped) throw new Error("压缩时限已释放")
  }

  /** Milliseconds left on the hard total; never extends it. */
  remainingMs(): number {
    return Math.max(0, this.limits.totalMs - (this.now() - this.startedAt))
  }

  private check(): void {
    if (this.stopped) return
    const now = this.now()
    const elapsed = now - this.startedAt
    if (elapsed >= this.limits.totalMs) return this.fire('total', elapsed)
    if (!this.activeCall) return
    const callElapsed = now - this.callStartedAt
    if (!this.progressedInCall) {
      if (callElapsed >= this.limits.firstOutputMs) this.fire('first_output', elapsed)
      return
    }
    if (now - this.lastProgressAt >= this.limits.stallMs) this.fire('stall', elapsed)
  }

  private fire(kind: DeadlineKind, elapsed: number): void {
    const error = new DeadlineError(kind, this.limits, elapsed, this.progressedInCall, this.now() - this.callStartedAt)
    this.stop()
    this.controller.abort(error)
  }

  private stop(): void {
    if (this.stopped) return
    this.stopped = true
    while (this.listeners.length) this.listeners.pop()!()
    if (this.ticker !== undefined) { clearInterval(this.ticker); this.ticker = undefined }
  }
}

/** Progress evidence for one stream chunk; heartbeats and empty deltas are not progress. */
export function chunkProgresses(chunk: { type: string; text?: string }): boolean {
  if (chunk.type === 'text-delta' || chunk.type === 'reasoning-delta') return (chunk.text ?? '').length > 0
  return false
}
