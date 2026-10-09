import { Context, Service } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { Volatile } from '@deepseek-ai/cosmokit'
import type {} from '@deepseek-ai/dsh-settings'
import { defaults, validatePolicy, type Policy } from './policy.ts'
import { diagnosticsProjection } from './diagnostics.ts'
import type { CompactPhase, IdleStatus } from './idle-types.ts'
import { IdleStore, type IdleRecord } from './idle-store.ts'
import type {} from '@deepseek-ai/dsh-storage-domain'
import { SummaryLedger } from './summary-ledger.ts'
import { join, isAbsolute } from 'node:path'
import { existsSync } from 'node:fs'
import type {} from '@deepseek-ai/dsh-app-boot'
import { RecoveryJournal } from './recovery-journal.ts'
import { CompactionCycles } from './compaction-cycles.ts'
import { SummaryOperations } from './summary-operations.ts'
import { registerHistoryTools } from './history-tools.ts'
import { TextArchive, type ArchiveSummary } from './archive.ts'
import type { ReductionReadout } from './inspector-types.ts'
import { registerToolResultReduction, type ReductionStats } from './tool-results.ts'

declare module '@deepseek-ai/cordis' { interface Context { contextManager: ContextManager } }
export interface Config { policy: Volatile<Policy> }

/** Bounded detail list for the per-session reduction readout. */
const REDUCTION_RECENT_LIMIT = 4

/** Capability/status readout for the new efficiency features. */
export interface ReductionStatus extends ReductionStats {
  /** `off` / `observe` / `reduce`, reloaded from the live policy. */
  readonly mode: Policy['toolResultsMode']
  /** Absolute archive directory, or undefined when it could not be opened. */
  readonly archiveDirectory?: string
  /** Why the archive is unavailable; absent when it opened. */
  readonly archiveError?: string
  /** True once the Host reported at least one final tool result through the new seam. */
  readonly pipelineReported: boolean
  /** Archived originals, whole archive rather than this session. */
  readonly archiveOriginals: number
  /** Durable published/pending/reverted facts; process counters above are diagnostics only. */
  readonly archive: ArchiveSummary | undefined
  /**
   * Confirmed counts per session id. A process-wide counter is never presented
   * as one session's total.
   */
  readonly sessions: ReadonlyMap<string, { published: number; reverted: number }>
}

/** A single live policy shared by isolated preset engines. */
export default class ContextManager extends Service {
  static inject = ['storageDomain']
  idleStore!: IdleStore
  summaryLedger!: SummaryLedger
  compactionCycles!: CompactionCycles
  /** Additive durable call outcomes; the v1 cycle table keeps its shape and semantics. */
  summaryOperations!: SummaryOperations
  supportsSafeShutdown = false
  private reductionStats!: () => ReductionStats
  private pipelineReported!: () => boolean
  private reductionSessions?: () => ReadonlyMap<string, { published: number; reverted: number }>
  private archive?: TextArchive
  private archiveFailure?: string
  private archiveAbsent?: string
  private idleActive = false
  private readonly idleReaders = new Map<string, () => IdleStatus>()
  private readonly compactReaders = new Map<string, () => CompactPhase | undefined>()
  private readonly executions = new Map<string, string>()
  private readonly stops = new Map<string, { reasonCode: string; message: string }>()
  private readonly recoveries = new Map<string, (signal: AbortSignal) => Promise<void>>()
  private readonly drains = new Set<() => Promise<void>>()
  static Config = z.object({
    policy: z.object({
      enabled: z.boolean().default(defaults.enabled),
      historyMode: z.union([z.const('automatic'), z.const('custom')]).default(defaults.historyMode),
      recentTokens: z.number().min(1000).max(128000).step(1).default(defaults.recentTokens),
      triggerPercent: z.number().min(50).max(95).default(defaults.triggerPercent),
      targetPercent: z.number().min(10).max(75).default(defaults.targetPercent),
      earlyPercent: z.number().min(0).max(5).default(defaults.earlyPercent),
      safetyPercent: z.number().min(1).max(10).default(defaults.safetyPercent),
      summaryMaxTokens: z.number().min(256).max(32768).step(1).default(defaults.summaryMaxTokens),
      maxPasses: z.number().min(1).max(2).step(1).default(defaults.maxPasses),
      // An existing policy without a mode is ambiguous: preserve fixed semantics.
      // A new installation with no policy receives the complete adaptive defaults below.
      summaryTimeoutMode: z.union([z.const('fixed'), z.const('adaptive')]).default('fixed'),
      summaryTotalMs: z.number().min(10000).max(3600000).step(1).default(defaults.summaryTotalMs),
      summaryFirstOutputMs: z.number().min(5000).max(900000).step(1).default(defaults.summaryFirstOutputMs),
      summaryStallMs: z.number().min(5000).max(1800000).step(1).default(defaults.summaryStallMs),
      timeoutMs: z.number().min(1000).max(1800000).step(1).default(defaults.timeoutMs),
      idleEnabled: z.boolean().default(defaults.idleEnabled),
      idleMinutes: z.number().min(1).max(1440).step(1).default(defaults.idleMinutes),
      idleMinPercent: z.number().min(10).max(95).default(defaults.idleMinPercent),
      summaryInstructions: z.string().max(2000).default(defaults.summaryInstructions),
      formatRepairEnabled: z.boolean().default(defaults.formatRepairEnabled),
      formatRepairMaxTokens: z.number().min(256).max(8192).step(1).default(defaults.formatRepairMaxTokens),
      absoluteEnabled: z.boolean().default(defaults.absoluteEnabled),
      absoluteTriggerTokens: z.number().min(10000).max(1000000000).step(1).default(defaults.absoluteTriggerTokens),
      absoluteTargetTokens: z.number().min(1000).max(1000000000).step(1).default(defaults.absoluteTargetTokens),
      toolResultsMode: z.union([z.const('off'), z.const('observe'), z.const('reduce')]).default(defaults.toolResultsMode),
      toolResultsMaxChars: z.number().min(2000).max(4000000).step(1).default(defaults.toolResultsMaxChars),
      toolResultsMinSavings: z.number().min(100).max(1000000).step(1).default(defaults.toolResultsMinSavings),
      archiveReadBudget: z.number().min(500).max(6000).step(1).default(defaults.archiveReadBudget),
      archiveSearchLimit: z.number().min(1).max(8).step(1).default(defaults.archiveSearchLimit),
      prefixDiagnosticsEnabled: z.boolean().default(defaults.prefixDiagnosticsEnabled),
    }).default(defaults).volatile(),
  })

  constructor(ctx: Context, public config: Config) {
    super(ctx, 'contextManager')
    this.snapshot()
    registerHistoryTools(ctx, () => {
      const { archive, error } = this.archiveAccess(false)
      const policy = this.snapshot()
      return { ...(archive === undefined ? {} : { archive }), ...(error === undefined ? {} : { error }),
        searchLimit: policy.archiveSearchLimit, readBudget: policy.archiveReadBudget }
    })
    ctx.inject(['sessionProjections'], child => {
      child.sessionProjections.register(diagnosticsProjection)
    })
    ctx.inject(['settings'], child => {
      child.effect(() => child.settings.configure({ auto: false }, ctx.fiber))
    })
    const reduction = registerToolResultReduction(ctx, () => this.snapshot(), () => this.archive$())
    this.reductionStats = reduction.stats
    this.pipelineReported = reduction.reported
    this.reductionSessions = reduction.sessions
  }

  protected async [Service.init](): Promise<void> {
    // The launcher owns this profile location. Never guess a user's storage
    // backend path or write directly to the Host's domain JSON documents.
    const profile = this.ctx.get('profileContext')
    const journal = profile && isAbsolute(profile.dir)
      ? RecoveryJournal.open(join(profile.dir, '.context-manager-recovery')) : undefined
    try {
      this.idleStore = await IdleStore.open(this.ctx.storageDomain, journal)
      this.summaryLedger = await SummaryLedger.open(this.ctx.storageDomain, journal)
      this.compactionCycles = await CompactionCycles.open(this.ctx.storageDomain)
      this.summaryOperations = await SummaryOperations.open(this.ctx.storageDomain)
    } catch (error) {
      try { await this.summaryOperations?.close() }
      finally {
        try { await this.compactionCycles?.close(); await this.summaryLedger?.close() }
        finally { try { await this.idleStore?.close() } finally { journal?.close() } }
      }
      throw error
    }
    let closing: Promise<void> | undefined
    const close = () => closing ??= (async () => {
      // Sibling fibers may dispose concurrently. Explicitly abort/drain all
      // engines before closing shared stores; registration order is not a lock.
      const outcomes = await Promise.allSettled([...this.drains].map(drain => drain()))
      try {
        try { await this.summaryOperations.close() }
        finally {
          try { await this.compactionCycles.close() }
          finally { try { await this.summaryLedger.close() } finally { await this.idleStore.close() } }
        }
      } finally { journal?.close() }
      const errors = outcomes.filter((result): result is PromiseRejectedResult => result.status === 'rejected')
      if (errors.length) throw new AggregateError(errors.map(result => result.reason), '上下文压缩收尾未完成')
    })()
    const releases: (() => Promise<void>)[] = []
    const facility = this.ctx.storageDomain as unknown as {
      registerDrain?: (domainName: string, drain: () => Promise<void>) => () => Promise<void>
    }
    if (typeof facility.registerDrain === 'function') {
      try {
        // Both domains may be routed to different backends. Each backend must
        // honor the same idempotent consumer drain before closing its units.
        releases.push(facility.registerDrain('context_manager_summaries', close))
        releases.push(facility.registerDrain('context_manager_idle', close))
        releases.push(facility.registerDrain('context_manager_cycles', close))
        releases.push(facility.registerDrain('context_manager_operations', close))
        this.supportsSafeShutdown = true
      } catch (error) { this.ctx.logger.warn('宿主存储排空不可用，使用插件恢复日志：%s', error) }
    }
    // A journal protects already observed usage even if an old Host closes its
    // backend first. Unobserved usage stays unknown and never causes a replayed call.
    this.supportsSafeShutdown ||= journal !== undefined
    this.ctx.effect(() => async () => {
      try { await close() }
      finally { for (const release of releases) await release() }
    })
  }

  registerDrain(drain: () => Promise<void>): () => void {
    this.drains.add(drain)
    return () => { this.drains.delete(drain) }
  }

  /**
   * Open the original-text archive lazily, inside the Host-chosen profile
   * directory. An unusable location is a bounded feature downgrade: it is
   * reported and the reducer keeps the Host's own result, while compaction,
   * settings and the history tools keep working. A read-only caller uses
   * {@link archiveAccess}, which opens an existing archive but never creates
   * storage as a side effect of being observed.
   * @returns the archive, or undefined when it could not be opened.
   */
  private archive$(options: { readonly create: boolean } = { create: true }): TextArchive | undefined {
    if (this.archive !== undefined) return this.archive
    if (this.archiveFailure !== undefined) return undefined
    const profile = this.ctx.get('profileContext')
    if (!profile || !isAbsolute(profile.dir)) {
      this.archiveFailure = '当前环境没有可用的 profile 目录，原文档案已停用'
      return undefined
    }
    const root = join(profile.dir, '.context-manager-archive')
    if (!options.create && !existsSync(root)) {
      this.archiveAbsent = '尚未创建原文档案；启用 reduce 后才有档案'
      return undefined
    }
    try {
      // `create` is forwarded from the caller: only the reducer may create the
      // archive directory as a side effect, and a read-only observer must be
      // able to open an existing archive without ever creating one.
      this.archive = TextArchive.open(root, { create: options.create })
    } catch (error) {
      this.archiveFailure = error instanceof Error ? error.message : String(error)
      this.ctx.logger.warn('context-manager: 原文档案不可用（工具结果精简保持宿主原结果）：%s', this.archiveFailure)
      return undefined
    }
    this.ctx.effect(() => () => { this.archive?.close(); this.archive = undefined })
    return this.archive
  }

  /**
   * Read-only archive access for the history tools. Never creates storage and
   * never loads a session; an unavailable archive is reported, not thrown.
   * @param create - only the reducer may create the archive directory.
   * @returns the archive plus the reason it is unavailable, if any.
   */
  archiveAccess(create = false): { archive?: TextArchive; error?: string } {
    const archive = this.archive$({ create })
    if (archive !== undefined) return { archive }
    return { error: this.archiveFailure ?? this.archiveAbsent ?? '原文档案不可用' }
  }

  /** Capability, policy and live reduction counters for the inspector. */
  reductionStatus(): ReductionStatus {
    const policy = this.snapshot()
    const stats = this.reductionStats?.() ?? { considered: 0, unverified: 0, wouldReduce: 0, published: 0,
      reverted: 0, pending: 0, skipped: 0, failed: 0 }
    const { archive, error } = this.archiveAccess(false)
    const summary = this.reductionSummary(undefined, 8)
    return { ...stats, mode: policy.toolResultsMode,
      ...(archive === undefined ? {} : { archiveDirectory: archive.directory }),
      ...(error === undefined ? {} : { archiveError: error }),
      pipelineReported: this.pipelineReported?.() ?? false,
      archiveOriginals: archive?.size ?? 0,
      archive: summary,
      sessions: this.reductionSessions?.() ?? new Map() }
  }

  /** Bounded reduction summary for one session; never reads an original. */
  reductionSummary(sessionId?: string, limit = 16) {
    const { archive } = this.archiveAccess(false)
    if (archive === undefined) return undefined
    return archive.summary(sessionId, limit)
  }

  /**
   * Session-scoped reduction readout for the read-only context panel. The
   * durable published/pending/reverted rows come from the archive filtered by
   * this session; `run` is explicitly the process-wide diagnostic of the
   * current run, so a process counter is never presented as one session's
   * total. Nothing here creates the archive, reads an original, or prices
   * anything: character counts are not a bill.
   * @param sessionId - the session whose confirmed references are reported.
   * @returns a plain JSON readout, safe for the strict remote codec.
   */
  reductionReadout(sessionId: string): ReductionReadout {
    const policy = this.snapshot()
    const stats = this.reductionStats?.() ?? { considered: 0, unverified: 0, wouldReduce: 0, published: 0,
      reverted: 0, pending: 0, skipped: 0, failed: 0 }
    const { archive, error } = this.archiveAccess(false)
    const summary = this.reductionSummary(sessionId, REDUCTION_RECENT_LIMIT)
    return {
      mode: policy.toolResultsMode,
      pipelineReported: this.pipelineReported?.() ?? false,
      published: summary?.published ?? { references: 0, originalChars: 0, shortenedChars: 0, visibleCharsRemoved: 0 },
      pending: summary?.pending ?? 0,
      reverted: summary?.reverted ?? 0,
      recent: (summary?.recent ?? []).map(owner => ({ contentId: owner.contentId, callId: owner.callId ?? null,
        tool: owner.tool, shortenedChars: owner.shortenedChars, complete: owner.complete, at: owner.at })),
      notes: [...(summary?.notes ?? [])],
      run: { considered: stats.considered, unverified: stats.unverified, wouldReduce: stats.wouldReduce,
        skipped: stats.skipped, failed: stats.failed, lastSkip: stats.lastSkip ?? null, lastReason: stats.lastReason ?? null },
      ...(error === undefined ? {} : { archiveError: error }),
    }
  }

  /** One background summary across isolated engines; main request admission is independent. */
  acquireIdle(): (() => void) | undefined {
    if (this.idleActive) return
    this.idleActive = true
    let released = false
    return () => { if (!released) { released = true; this.idleActive = false } }
  }

  async cancelIdlePlans(reasonCode: string): Promise<void> {
    for (const record of this.idleStore.all()) {
      if (record.status === 'eligible' || record.status === 'started') await this.idleStore.settle(record, record.attemptId, { status: 'cancelled', reasonCode })
    }
  }

  savedIdleStatus(record: IdleRecord): IdleStatus {
    const messages: Record<string, string> = {
      disabled: '闲置自动压缩已关闭', interrupted: '上次整理被中断，费用状态未知；本轮不自动重试',
      history_changed: '会话内容已变化，旧闲置计划已取消', completed: '闲置压缩已完成', recovered_commit: '已恢复上次成功压缩记录',
      below_threshold: '未达到闲置整理门槛，本轮无需压缩', background: '后台任务尚未结束，本轮未整理',
      model_changed: '模型选择已变化，等待下次任务完成后重新计时', host_capability_missing: '当前环境无法保证压缩用量落盘，请检查插件数据目录；任务原文保留', pruned: '旧工具结果已整理，无需生成摘要', no_range: '没有可安全缩减的历史内容', other_compaction: '其他压缩已处理，本轮不重复整理',
      new_input: '新消息已到达，旧计划已取消', running: '新任务正在执行', stopped: '会话已停止，本轮不再整理',
      failed: '上次闲置整理失败，本轮不再重试', state_changed: '会话状态已变化，旧计划已取消',
      commit_incomplete: '内容已替换，压缩收尾未完成；本轮不自动重试',
    }
    const status = record.status === 'eligible' ? 'waiting' : record.status === 'started' || record.status === 'interrupted' ? 'failed' : record.status
    return { status, dueAt: null, reasonCode: record.reasonCode ?? record.status, updatedAt: record.updatedAt,
      message: record.status === 'eligible' ? '会话未加载，恢复后继续核验闲置计划' : messages[record.reasonCode ?? record.status] ?? '本轮整理已结束，等待下次任务正常完成',
      ...(record.beforeTokens === undefined ? {} : { beforeTokens: record.beforeTokens }), ...(record.afterTokens === undefined ? {} : { afterTokens: record.afterTokens }) }
  }

  /** Freeze one admission's policy; edits take effect on the next request. */
  snapshot(): Readonly<Policy> {
    const result = { ...this.config.policy.get() }
    validatePolicy(result)
    return Object.freeze(result)
  }

  /**
   * Register a live Agent's status reader; the owner releases it on disposal.
   * @param sessionId - owning session, without loading it.
   * @param read - current idle maintenance status.
   * @returns an identity-guarded release function.
   */
  registerIdle(sessionId: string, read: () => IdleStatus): () => void {
    this.idleReaders.set(sessionId, read)
    return () => { if (this.idleReaders.get(sessionId) === read) this.idleReaders.delete(sessionId) }
  }

  /**
   * Register a live in-flight compaction phase reader (request or idle path).
   * @param sessionId - owning session, without loading it.
   * @param read - current compacting phase, or undefined when not compacting.
   * @returns an identity-guarded release function.
   */
  registerCompact(sessionId: string, read: () => CompactPhase | undefined): () => void {
    this.compactReaders.set(sessionId, read)
    return () => { if (this.compactReaders.get(sessionId) === read) this.compactReaders.delete(sessionId) }
  }

  reportExecution(sessionId: string, value: string): void { this.executions.set(sessionId, value) }

  reportStop(sessionId: string, reasonCode?: string): void {
    if (!reasonCode) { this.stops.delete(sessionId); return }
    const labels: Record<string, string> = { prepared:'人工急救预检完成，尚未调用模型', first_output_timeout: '等待首个有效输出超时', stall_timeout: '摘要输出停滞超时',
      total_timeout: '整笔压缩达到硬总时限', provider_timeout: '供应商返回超时', aborted: '压缩被取消',
      budget_exhausted: '本批历史调用额度已满，本次未调用摘要模型', invalid_structure: '摘要结构不合格', operation_state: '持久调用许可阻止重复收费', failed: '压缩未完成' }
    this.stops.set(sessionId, { reasonCode, message: labels[reasonCode] ?? labels.failed! })
  }

  registerRecovery(sessionId: string, run: (signal: AbortSignal) => Promise<void>): () => void {
    this.recoveries.set(sessionId, run)
    return () => { if (this.recoveries.get(sessionId) === run) this.recoveries.delete(sessionId) }
  }

  async authorizeRecovery(sessionId: string, requestHash: string, signal: AbortSignal): Promise<void> {
    signal.throwIfAborted()
    const run = this.recoveries.get(sessionId)
    if (!run) throw new Error('该会话没有可恢复的原压缩计划，请重新检查上下文状态')
    await this.summaryOperations.grant(sessionId, requestHash)
    signal.throwIfAborted()
    await run(signal)
  }

  /**
   * Read live or persisted status without loading a Session or scheduling work.
   * An in-flight compaction phase wins over the idle reader so the page shows
   * summarizing/repairing before any durable record exists.
   * @param sessionId - session whose state is requested.
   * @returns the live status, or an inactive default.
   */
  idleStatus(sessionId: string): IdleStatus {
    const base = this.readIdleStatus(sessionId)
    const stop = this.stops.get(sessionId)
    const status: IdleStatus = stop && base.status !== 'compacting' ? { ...base, ...stop } : base
    const policy = this.snapshot()
    const agent = this.ctx.get('agents')?.get(SessionId(sessionId))
    const engine = agent && (this.ctx.get('agentPresets')?.serviceFor(agent, 'compaction') ?? agent.ctx.get('compaction'))
    const owner: IdleStatus['owner'] = engine ? ('contextManagerOwner' in engine ? 'context-manager' : 'other') : 'unknown'
    return { ...status, owner, emergency: this.summaryOperations.emergencyStatus(sessionId,this.compactionCycles.records(sessionId)), execution: this.executions.get(sessionId), deadline: policy.summaryTimeoutMode === 'adaptive'
      ? `总限 ${policy.summaryTotalMs / 1000}s · 首输出 ${policy.summaryFirstOutputMs / 1000}s · 停滞 ${policy.summaryStallMs / 1000}s`
      : `固定整事务上限 ${policy.timeoutMs / 1000}s`, recovery: this.summaryOperations.recoveryStatus(sessionId, this.compactionCycles.records(sessionId)) }
  }

  private readIdleStatus(sessionId: string): IdleStatus {
    const compact = this.compactReaders.get(sessionId)?.()
    if (compact) return { status: 'compacting', dueAt: null, message: compact.message, compactionPhase: compact.phase }
    const policy = this.snapshot()
    if (!policy.enabled || !policy.idleEnabled) return { status: 'off', dueAt: null, message: '闲置自动压缩已关闭' }
    const live = this.idleReaders.get(sessionId)?.()
    if (live) return live
    const saved = this.idleStore.get(sessionId)
    return saved ? this.savedIdleStatus(saved) : { status: 'waiting', dueAt: null, reasonCode: 'no_plan', message: '尚无可恢复计划；下次任务正常完成后开始计时' }
  }
}
