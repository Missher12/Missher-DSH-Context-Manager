import { Context, Service } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { Volatile } from '@deepseek-ai/cosmokit'
import type {} from '@deepseek-ai/dsh-settings'
import { defaults, validatePolicy, type Policy } from './policy.ts'
import { diagnosticsProjection } from './diagnostics.ts'
import type { CompactPhase, IdleStatus } from './idle-types.ts'
import { IdleStore, type IdleRecord } from './idle-store.ts'
import type {} from '@deepseek-ai/dsh-storage-domain'
import { SummaryLedger } from './summary-ledger.ts'

declare module '@deepseek-ai/cordis' { interface Context { contextManager: ContextManager } }
export interface Config { policy: Volatile<Policy> }

/** A single live policy shared by isolated preset engines. */
export default class ContextManager extends Service {
  static inject = ['storageDomain']
  idleStore!: IdleStore
  summaryLedger!: SummaryLedger
  supportsSafeShutdown = false
  private idleActive = false
  private readonly idleReaders = new Map<string, () => IdleStatus>()
  private readonly compactReaders = new Map<string, () => CompactPhase | undefined>()
  private readonly drains = new Set<() => Promise<void>>()
  static Config = z.object({
    policy: z.object({
      enabled: z.boolean().default(defaults.enabled),
      triggerPercent: z.number().min(50).max(95).default(defaults.triggerPercent),
      targetPercent: z.number().min(10).max(75).default(defaults.targetPercent),
      earlyPercent: z.number().min(0).max(5).default(defaults.earlyPercent),
      safetyPercent: z.number().min(1).max(10).default(defaults.safetyPercent),
      summaryMaxTokens: z.number().min(256).max(32768).step(1).default(defaults.summaryMaxTokens),
      maxPasses: z.number().min(1).max(2).step(1).default(defaults.maxPasses),
      timeoutMs: z.number().min(1000).max(300000).step(1).default(defaults.timeoutMs),
      idleEnabled: z.boolean().default(defaults.idleEnabled),
      idleMinutes: z.number().min(1).max(1440).step(1).default(defaults.idleMinutes),
      idleMinPercent: z.number().min(10).max(95).default(defaults.idleMinPercent),
      summaryInstructions: z.string().max(2000).default(defaults.summaryInstructions),
      formatRepairEnabled: z.boolean().default(defaults.formatRepairEnabled),
      formatRepairMaxTokens: z.number().min(256).max(8192).step(1).default(defaults.formatRepairMaxTokens),
      absoluteEnabled: z.boolean().default(defaults.absoluteEnabled),
      absoluteTriggerTokens: z.number().min(10000).max(1000000000).step(1).default(defaults.absoluteTriggerTokens),
      absoluteTargetTokens: z.number().min(1000).max(1000000000).step(1).default(defaults.absoluteTargetTokens),
    }).default(defaults).volatile(),
  })

  constructor(ctx: Context, public config: Config) {
    super(ctx, 'contextManager')
    this.snapshot()
    ctx.inject(['sessionProjections'], child => {
      child.sessionProjections.register(diagnosticsProjection)
    })
    ctx.inject(['settings'], child => {
      child.effect(() => child.settings.configure({ auto: false }, ctx.fiber))
    })
  }

  protected async [Service.init](): Promise<void> {
    this.idleStore = await IdleStore.open(this.ctx.storageDomain)
    this.summaryLedger = await SummaryLedger.open(this.ctx.storageDomain)
    let closing: Promise<void> | undefined
    const close = () => closing ??= (async () => {
      // Sibling fibers may dispose concurrently. Explicitly abort/drain all
      // engines before closing shared stores; registration order is not a lock.
      await Promise.all([...this.drains].map(drain => drain()))
      try { await this.summaryLedger.close() }
      finally { await this.idleStore.close() }
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
        this.supportsSafeShutdown = true
      } catch (error) { this.ctx.logger.warn('上下文压缩需要支持关停排空的存储后端：%s', error) }
    }
    this.ctx.effect(() => async () => {
      try { await close() }
      finally { for (const release of releases) await release() }
    })
  }

  registerDrain(drain: () => Promise<void>): () => void {
    this.drains.add(drain)
    return () => { this.drains.delete(drain) }
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
      model_changed: '模型选择已变化，等待下次任务完成后重新计时', host_capability_missing: '宿主缺少安全压缩所需能力，请更新配套宿主；任务原文保留', pruned: '旧工具结果已整理，无需生成摘要', no_range: '没有可安全缩减的历史内容', other_compaction: '其他压缩已处理，本轮不重复整理',
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

  /**
   * Read live or persisted status without loading a Session or scheduling work.
   * An in-flight compaction phase wins over the idle reader so the page shows
   * summarizing/repairing before any durable record exists.
   * @param sessionId - session whose state is requested.
   * @returns the live status, or an inactive default.
   */
  idleStatus(sessionId: string): IdleStatus {
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
