/** Durable eligibility for loaded sessions; inspection never activates an Agent. */
import { createHash, randomUUID } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { CompactionResult } from '@deepseek-ai/dsh-compaction'
import type {} from '@deepseek-ai/dsh-workspace'
import type {} from '@deepseek-ai/dsh-api-session-controller/types'
import type {} from './index.ts'
import type { IdleStatus } from './idle-types.ts'
import type { IdleEligibility } from './idle-store.ts'
import { idleFloorTokens, type Policy } from './policy.ts'

interface Entry {
  epoch: number
  eligibility?: IdleEligibility
  idleSince: number
  status: IdleStatus
  timer?: ReturnType<typeof setTimeout>
  abort?: AbortController
  expectStart: boolean
  compactionId?: string
  attemptId?: string
  checks: number
  release: () => void
}

export class IdleSkipped extends Error {
  constructor(readonly reasonCode: string, message: string) { super(message) }
}

export async function withAbort<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  let onAbort: () => void = () => {}
  const cancelled = new Promise<never>((_resolve, reject) => {
    onAbort = () => reject(signal.reason)
    if (signal.aborted) onAbort()
    else signal.addEventListener('abort', onAbort, { once: true })
  })
  try { return await Promise.race([work, cancelled]) }
  finally { signal.removeEventListener('abort', onAbort) }
}

/** Hash identity and event metadata only, never transcript or credentials. */
function eligibilityOf(agent: Agent): IdleEligibility | undefined {
  const end = agent.session.snapshotEvents().findLast(event => event.type === 'turn/end')
  if (end?.type !== 'turn/end' || end.data.reason.kind !== 'completed') return
  const sessionId = String(agent.id)
  const fingerprint = createHash('sha256').update(JSON.stringify([sessionId, agent.session.header.createdAt, end.seq, end.time, end.data.turn])).digest('hex')
  return { sessionId, turnEndSeq: end.seq, completedAt: end.time, fingerprint }
}

function routeOf(agent: Agent): string {
  const route = agent.session.requestHeader()?.config
  return JSON.stringify(route && [route.provider, route.model, route.reasoningEffort, route.maxTokens])
}

/** Timers belong to one engine; persistence and concurrency are shared by the manager. */
export class IdleCompactor {
  private readonly entries = new Map<Agent, Entry>()
  private readonly jobs = new Set<Promise<unknown>>()
  private disposed = false

  constructor(
    private readonly ctx: Context,
    private readonly owns: (agent: Agent) => boolean,
    private readonly compact: (agent: Agent, signal: AbortSignal, preflight: (allowBelow?: boolean) => Promise<void>, pruned: () => void) => Promise<CompactionResult | null>,
  ) {
    ctx.on('agent/created', async ({ agent }) => { if (owns(agent)) await this.restore(agent) })
    ctx.on('agent/status', ({ agent, status }) => {
      if (owns(agent) && status === 'running') this.invalidate(this.entry(agent), 'running', '新任务正在执行')
    })
    ctx.on('session/event', (session, event) => {
      const agent = ctx.agents.get(session.id)
      if (!agent || !owns(agent)) return
      const entry = this.entry(agent)
      if (event.type === 'turn/end') {
        if (event.data.reason.kind === 'completed') this.track(this.register(agent, entry))
        else this.invalidate(entry, 'unfinished', '任务未正常完成，本轮不进行闲置压缩')
      }
      if (event.type === 'model/selection') this.invalidate(entry, 'model_changed', '模型选择已变化，等待下次任务完成后重新计时')
      if (event.type === 'compaction/start') {
        if (entry.expectStart && event.data.turn === null) {
          entry.expectStart = false
          entry.compactionId = String(event.data.compactionId)
        } else if (entry.compactionId !== String(event.data.compactionId)) {
          this.invalidate(entry, 'other_compaction', '上下文已交由其他压缩操作处理')
        }
      }
    })
    ctx.on('agent/inbox/inserted', ({ agent }) => {
      const entry = this.entries.get(agent)
      if (entry) this.invalidate(entry, 'new_input', '新消息已到达，优先继续会话')
    })
    ctx.on('agent/disposed', ({ agent }) => {
      const entry = this.entries.get(agent)
      if (!entry) return
      this.pause(entry, '会话已关闭，计划将在重新加载后核验')
      entry.release()
      this.entries.delete(agent)
    })
    ctx.on('workspace/session-stop', ({ sessionId }) => {
      for (const [agent, entry] of this.entries) if (agent.id === sessionId) this.invalidate(entry, 'stopped', '会话已停止，本轮不再整理')
    })
    ctx.on('settings/document-updated', () => {
      const policy = ctx.contextManager.snapshot()
      for (const [agent, entry] of this.entries) {
        if (!policy.enabled || !policy.idleEnabled) this.invalidate(entry, 'disabled', '闲置自动压缩已关闭')
        else if (entry.eligibility && entry.timer) this.schedule(agent, entry)
      }
      if (!policy.enabled || !policy.idleEnabled) this.track(ctx.contextManager.cancelIdlePlans('disabled'))
    })
    for (const agent of ctx.agents.list()) if (owns(agent)) this.track(this.restore(agent))
  }

  private track<T>(job: Promise<T>): Promise<T> {
    this.jobs.add(job)
    void job.finally(() => this.jobs.delete(job)).catch(error => this.ctx.logger.warn('闲置计划持久化失败：%s', error))
    return job
  }

  private entry(agent: Agent): Entry {
    let entry = this.entries.get(agent)
    if (entry) return entry
    entry = { epoch: 0, idleSince: 0, checks: 0, expectStart: false,
      status: { status: 'waiting', dueAt: null, reasonCode: 'no_plan', message: '尚无可恢复计划；下次任务正常完成后开始计时' }, release: () => {} }
    const current = entry
    current.release = this.ctx.contextManager.registerIdle(String(agent.id), () => current.status)
    this.entries.set(agent, current)
    return current
  }

  private stop(entry: Entry, message: string) {
    entry.epoch++
    clearTimeout(entry.timer)
    entry.timer = undefined
    entry.abort?.abort(new Error(message))
  }

  /** Unattempted completion writes may drain during shutdown; started calls may not resume. */
  private pause(entry: Entry, message: string) {
    clearTimeout(entry.timer)
    entry.timer = undefined
    if (entry.abort) this.stop(entry, message)
  }

  private invalidate(entry: Entry, reasonCode: string, message: string) {
    const eligibility = entry.eligibility
    const attemptId = entry.attemptId
    this.stop(entry, message)
    entry.eligibility = undefined
    entry.status = { status: reasonCode === 'disabled' ? 'off' : 'cancelled', dueAt: null, reasonCode, message }
    if (eligibility) this.track(this.ctx.contextManager.idleStore.settle(eligibility, attemptId, { status: 'cancelled', reasonCode }))
  }

  private validHistory(agent: Agent, eligibility: IdleEligibility, ownId?: string): boolean {
    if (eligibilityOf(agent)?.fingerprint !== eligibility.fingerprint) return false
    return !agent.session.snapshotEvents().slice(eligibility.turnEndSeq + 1).some(event =>
      event.type === 'turn/start' || event.type === 'model/selection' || event.type === 'user/message' && event.data.source.kind !== 'compact-checkpoint'
      || event.type === 'compaction/start' && String(event.data.compactionId) !== ownId)
  }

  private async register(agent: Agent, entry: Entry) {
    const eligibility = eligibilityOf(agent)
    if (!eligibility) return
    this.stop(entry, '正在保存新的闲置计划')
    const epoch = entry.epoch
    entry.eligibility = eligibility
    entry.attemptId = undefined
    entry.compactionId = undefined
    entry.checks = 0
    entry.idleSince = Math.min(Date.now(), eligibility.completedAt)
    entry.status = { status: 'checking', dueAt: null, reasonCode: 'saving', message: '正在保存闲置计划' }
    try {
      await this.ctx.sessions.flush(agent.session)
      const policy = this.ctx.contextManager.snapshot()
      if (entry.epoch !== epoch || !policy.enabled || !policy.idleEnabled) return
      const record = await this.ctx.contextManager.idleStore.reserve(eligibility)
      if (entry.epoch !== epoch) {
        await this.ctx.contextManager.idleStore.settle(eligibility, undefined, { status: 'cancelled', reasonCode: 'state_changed' })
        return
      }
      if (this.disposed || this.ctx.agents.get(agent.id) !== agent) return
      if (record?.status === 'eligible') this.schedule(agent, entry)
      else entry.eligibility = undefined
    } catch (error) {
      if (entry.epoch === epoch) {
        entry.eligibility = undefined
        entry.status = { status: 'failed', dueAt: null, reasonCode: 'storage', message: '闲置计划保存失败，本轮不会自动压缩' }
      }
      this.ctx.logger.warn('无法保存闲置计划：%s', error)
    }
  }

  private async restore(agent: Agent) {
    if (this.disposed) return
    const entry = this.entry(agent)
    const record = this.ctx.contextManager.idleStore.get(String(agent.id))
    if (!record) return
    entry.status = this.ctx.contextManager.savedIdleStatus(record)
    if (record.status === 'started') {
      const done = agent.session.snapshotEvents().findLast(event => event.type === 'compaction/end' && String(event.data.compactionId) === record.compactionId && !event.data.error)
      await this.ctx.contextManager.idleStore.settle(record, record.attemptId, { status: done ? 'completed' : 'interrupted', reasonCode: done ? 'recovered_commit' : 'interrupted', ...(done ? { afterTokens: this.ctx.tokenMeter.measure(agent.session).totalTokens } : {}) })
      entry.status = this.ctx.contextManager.savedIdleStatus(this.ctx.contextManager.idleStore.get(String(agent.id))!)
      return
    }
    if (record.status !== 'eligible') return
    const policy = this.ctx.contextManager.snapshot()
    if (!policy.enabled || !policy.idleEnabled || !this.validHistory(agent, record) || agent.inbox.nextTurn.length || agent.inbox.nextStep.length) {
      await this.ctx.contextManager.idleStore.settle(record, undefined, { status: 'cancelled', reasonCode: !policy.enabled || !policy.idleEnabled ? 'disabled' : 'history_changed' })
      entry.status = this.ctx.contextManager.savedIdleStatus(this.ctx.contextManager.idleStore.get(String(agent.id))!)
      return
    }
    entry.eligibility = record
    entry.idleSince = Math.min(record.completedAt, Date.now())
    entry.status = { ...entry.status, restored: true }
    this.schedule(agent, entry, 5000)
  }

  private schedule(agent: Agent, entry: Entry, minimumDelay = 0) {
    if (this.disposed || entry.abort || !entry.eligibility) return
    clearTimeout(entry.timer)
    const policy = this.ctx.contextManager.snapshot()
    if (!policy.enabled || !policy.idleEnabled) { this.invalidate(entry, 'disabled', '闲置自动压缩已关闭'); return }
    const dueAt = Math.max(entry.idleSince + policy.idleMinutes * 60000, Date.now() + minimumDelay)
    const deferred = minimumDelay >= 30000 && ['background', 'busy'].includes(entry.status.reasonCode ?? '')
    entry.status = { ...entry.status, status: 'scheduled', reasonCode: deferred ? entry.status.reasonCode : entry.status.restored ? 'restored' : 'scheduled', dueAt,
      restored: entry.status.restored, message: deferred ? `${entry.status.message}；30 秒后复查` : entry.status.restored ? '已恢复闲置计划，到期后核验' : '任务已完成，等待闲置检查' }
    entry.timer = setTimeout(() => {
      entry.timer = undefined
      this.track(this.run(agent, entry))
    }, Math.max(0, dueAt - Date.now()))
    entry.timer.unref?.()
  }

  private assertReady(agent: Agent, entry: Entry, epoch: number, generation: number, route: string, policy: Readonly<Policy>) {
    if (this.disposed || entry.epoch !== epoch || !this.owns(agent) || this.ctx.agents.get(agent.id) !== agent || !entry.eligibility
      || !policy.enabled || !policy.idleEnabled || agent.status !== 'idle' || agent.inbox.nextTurn.length || agent.inbox.nextStep.length
      || agent.session.surface.replaceGeneration !== generation || routeOf(agent) !== route || !this.validHistory(agent, entry.eligibility, entry.compactionId)) {
      throw new IdleSkipped('state_changed', '会话状态已变化，本轮不整理')
    }
  }

  private async run(agent: Agent, entry: Entry) {
    if (!entry.eligibility) return
    const eligibility = entry.eligibility
    const controller = new AbortController()
    const epoch = entry.epoch
    let generation = agent.session.surface.replaceGeneration
    const route = routeOf(agent)
    const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(this.ctx.contextManager.snapshot().timeoutMs)])
    entry.abort = controller
    let release: (() => void) | undefined
    let rearm = 0
    let claimed = false
    let before = 0
    let refusal: IdleSkipped | undefined
    const store = this.ctx.contextManager.idleStore
    const attemptId = randomUUID()
    try {
      let policy = this.ctx.contextManager.snapshot()
      this.assertReady(agent, entry, epoch, generation, route, policy)
      entry.status = { status: 'checking', dueAt: null, reasonCode: 'checking', message: '正在检查会话是否可以整理' }
      const activity = await withAbort(this.ctx.waterfall('workspace/session-activity', { sessionId: agent.id }, () => Promise.resolve([])), signal)
      signal.throwIfAborted()
      this.assertReady(agent, entry, epoch, generation, route, this.ctx.contextManager.snapshot())
      if (activity.length) {
        if (++entry.checks <= 3) rearm = 30000
        throw new IdleSkipped('background', '后台任务尚未结束，本轮暂不整理')
      }
      const config = agent.session.requestHeader()?.config
      if (!config) throw new IdleSkipped('no_route', '尚无实际模型路由，暂不整理')
      const info = await withAbort(this.ctx.llm.resolveModelInfo(config.provider, config.model, signal), signal)
      signal.throwIfAborted()
      policy = this.ctx.contextManager.snapshot()
      this.assertReady(agent, entry, epoch, generation, route, policy)
      if (entry.idleSince + policy.idleMinutes * 60000 > Date.now()) { rearm = 1; return }
      const window = info.context?.contextWindow
      if (!window) throw new IdleSkipped('no_window', '当前模型未提供上下文窗口，暂不整理')
      const checkPressure = (allowBelow = false) => {
        const current = this.ctx.contextManager.snapshot()
        this.assertReady(agent, entry, epoch, generation, route, current)
        if (entry.idleSince + current.idleMinutes * 60000 > Date.now()) throw new IdleSkipped('delay_changed', '闲置时长已调整，等待下次检查')
        before = this.ctx.tokenMeter.measure(agent.session).totalTokens
        const minimumPercent = Math.max(current.idleMinPercent, current.targetPercent + 10)
        // The idle floor keeps its percentage meaning but never exceeds the
        // effective request admission (output reserve, safety, absolute soft
        // trigger included), so the settings page and both maintenance paths
        // show one consistent threshold.
        const minimumTokens = idleFloorTokens(current, window, config.maxTokens ?? info.defaultMaxTokens ?? 0)
        const percentFloor = window * minimumPercent / 100
        entry.status = { ...entry.status, beforeTokens: before, windowTokens: window, minimumPercent, ...(minimumTokens < percentFloor ? { minimumTokens } : {}) }
        if (!allowBelow && before < minimumTokens) throw new IdleSkipped('below_threshold', minimumTokens < percentFloor
          ? `当前约 ${(before / window * 100).toFixed(1)}%，未达到闲置整理门槛（有效阈值 ${minimumTokens.toLocaleString()} Token）`
          : `当前约 ${(before / window * 100).toFixed(1)}%，未达到闲置整理门槛 ${minimumPercent}%`)
      }
      checkPressure()
      release = this.ctx.contextManager.acquireIdle()
      if (!release) { if (++entry.checks <= 3) rearm = 30000; throw new IdleSkipped('busy', '其他会话正在整理，稍后检查') }
      const record = await store.claim(eligibility, attemptId, before)
      if (!record) throw new IdleSkipped('already_attempted', '本轮已经处理，不重复压缩')
      claimed = true
      if (entry.epoch !== epoch || this.disposed) {
        await store.settle(eligibility, attemptId, { status: 'cancelled', reasonCode: 'state_changed' })
        return
      }
      entry.attemptId = attemptId
      signal.throwIfAborted()
      checkPressure()
      entry.status = { ...entry.status, status: 'compacting', dueAt: null, reasonCode: 'compacting', message: '正在闲置压缩；新消息到达时让出' }
      entry.expectStart = true
      const operation = this.compact(agent, signal, async (allowBelow = false) => {
          try {
            signal.throwIfAborted()
            checkPressure(allowBelow)
            const bound = !entry.compactionId || await store.bindCompaction(eligibility, attemptId, entry.compactionId)
            if (!bound) throw new IdleSkipped('state_changed', '闲置资格已改变，本轮不整理')
            signal.throwIfAborted()
            checkPressure(allowBelow)
          } catch (error) { if (error instanceof IdleSkipped) refusal = error; throw error }
      }, () => {
        // Called synchronously inside our maintenance claim, immediately after
        // the protected pruner. New input still invalidates the epoch/signal.
        signal.throwIfAborted()
        if (entry.epoch !== epoch) throw new IdleSkipped('state_changed', '会话状态已变化')
        generation = agent.session.surface.replaceGeneration
      })
      const result = await operation
      signal.throwIfAborted()
      if (entry.epoch !== epoch) return
      const after = this.ctx.tokenMeter.measure(agent.session).totalTokens
      await store.settle(eligibility, attemptId, { status: result ? 'completed' : 'skipped', reasonCode: result ? 'completed' : after < (record.beforeTokens ?? before) ? 'pruned' : 'no_range', beforeTokens: record.beforeTokens ?? before, afterTokens: after, compactionId: entry.compactionId })
      if (entry.epoch === epoch) entry.status = this.ctx.contextManager.savedIdleStatus(store.get(String(agent.id))!)
    } catch (error) {
      if (entry.epoch !== epoch) return
      const skipped = refusal ?? (error instanceof IdleSkipped ? error : undefined)
      const applied = agent.session.surface.replaceGeneration > generation && entry.compactionId !== undefined
      entry.status = { ...entry.status, status: skipped ? 'skipped' : controller.signal.aborted ? 'cancelled' : 'failed', dueAt: null,
        reasonCode: applied ? 'commit_incomplete' : skipped?.reasonCode ?? (controller.signal.aborted ? 'cancelled' : 'failed'),
        message: applied ? '内容已替换，但压缩收尾未完成，请查看记录' : skipped?.message ?? (controller.signal.aborted ? '闲置压缩已取消' : '闲置压缩失败，本轮不再重试'),
        ...(applied ? { beforeTokens: before, afterTokens: this.ctx.tokenMeter.measure(agent.session).totalTokens } : {}),
      }
      if (!rearm) {
        try { await store.settle(eligibility, claimed ? attemptId : undefined, { status: skipped ? 'skipped' : 'failed', reasonCode: entry.status.reasonCode, compactionId: entry.compactionId, beforeTokens: before, afterTokens: entry.status.afterTokens }) }
        catch (persistError) { this.ctx.logger.warn('无法保存闲置结果：%s', persistError) }
      }
      if (!skipped && !controller.signal.aborted) this.ctx.logger.warn('闲置压缩失败：%s', error)
    } finally {
      release?.()
      if (entry.abort === controller) entry.abort = undefined
      entry.expectStart = false
      if (entry.epoch === epoch) {
        if (rearm && !claimed) this.schedule(agent, entry, rearm)
        else entry.eligibility = undefined
      } else if (entry.eligibility && agent.status === 'idle') this.schedule(agent, entry)
    }
  }

  async dispose(): Promise<void> {
    this.disposed = true
    for (const entry of this.entries.values()) this.pause(entry, '上下文插件正在关闭')
    while (this.jobs.size) await Promise.allSettled([...this.jobs])
    for (const entry of this.entries.values()) entry.release()
    this.entries.clear()
  }
}
