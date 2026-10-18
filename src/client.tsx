import { useState, useEffect, useSyncExternalStore } from 'react'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import { en, zh, type InspectorLocaleKey } from './inspector-locales.ts'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {} from '@deepseek-ai/dsh-client-ui-model-selection/client'
import type {} from '@deepseek-ai/dsh-api-remotes/client'
import type { RemoteResult } from '@deepseek-ai/dsh-typert-protocol'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { ConfigForm } from '@deepseek-ai/dsh-client-ui-settings/client'
import { Button, Input, SettingsForm, SettingsValueField, Switch } from '@deepseek-ai/dsh-client-ui-primitives'
import type {} from '@deepseek-ai/dsh-api-session-controller/client'
import { ContextInspectorView, type ContextViewInjected } from './inspector-view.tsx'
import { PeakIndicator, type PeakIndicatorProps } from './peak-indicator.tsx'
import type { ContentPage, ContentQuery, Inspection, InspectQuery, InspectorApi } from './inspector-types.ts'
import type { HostCapabilityReadout } from './compatibility.ts'
import { TYPERT_REMOTE } from './inspector-wire.ts'
import { defaults, normalizePolicy, validatePolicy, type Policy } from './policy.ts'
import type { IdleStatus } from './idle-types.ts'
import css from './client.css'
export { ContextReadout } from './overview.tsx'
export { ContextInspectorView } from './inspector-view.tsx'
export { PeakIndicator } from './peak-indicator.tsx'

declare module '@deepseek-ai/dsh-typert-protocol' {
  interface TypertRemoteNamespaceMap {
    contextRecovery: { prepareEmergency(query:{sessionId:string},signal:AbortSignal):Promise<RemoteResult<{token:string;expiresAt:number;cycle:number;warning:string;model:string;deadline:string;estimatedInput:number}>>; executeEmergency(query:{sessionId:string;token:string;acceptUnknownCost:true},signal:AbortSignal):Promise<RemoteResult<{granted:true}>>; authorizeOnce(query: { sessionId: string; authorizationToken: string }, signal: AbortSignal): Promise<RemoteResult<{ granted: true }>> }
    contextInspector: {
      compatibility(query: {}, signal: AbortSignal): Promise<RemoteResult<HostCapabilityReadout>>
      idleStatus(query: { sessionId: string }, signal: AbortSignal): Promise<RemoteResult<IdleStatus>>
      inspect(query: InspectQuery, signal: AbortSignal): Promise<RemoteResult<Inspection>>
      content(query: ContentQuery, signal: AbortSignal): Promise<RemoteResult<ContentPage>>
    }
  }
}

declare module '@deepseek-ai/dsh-client-ui-slots' { interface LocaleNamespaceMap { 'context.manager': InspectorLocaleKey } }

type Values = { policy: Policy }
export const inject = ['locale', 'slots', 'configForms', 'sessions', 'remote', 'remote.session', 'modelDirectories']

// Page styles are mounted after the module factory. Explicit ownership keeps
// another plugin's later materialization from claiming and removing them.
const STYLE_OWNER = 'dsh-context-manager'

/** Native conversation tab plus a separate parameter-only settings section. */
export async function apply(ctx: Context) {
  ctx.effect(() => ctx.locale.register('context.manager', { zh, en }), 'context-manager: locale')
  const t = ctx.locale.bind('context.manager')
  const form = ctx.configForms.get<Values>('context-manager')
  ctx.slots.inject('conversation.input.right', () => ctx.slots.register({
    name: 'conversation.input.right', id: 'context-manager-period', order: 100,
    inject: (sessionId: SessionId): PeakIndicatorProps => ({
      directory: ctx.modelDirectories.directoryFor(sessionId).store,
    }),
  }, PeakIndicator))
  const unmount = await ctx.remote.$mount(TYPERT_REMOTE)
  ctx.effect(() => unmount, 'context-manager: remote')
  ctx.inject(['remote.contextInspector'], scope => {
    const unwrap = <T,>(result: RemoteResult<T>): T => {
      if (!result.ok) throw new Error(`上下文读取失败：${result.error.code}`)
      return result.value
    }
    const api: InspectorApi = {
      compatibility: async signal => unwrap(await scope.remote.contextInspector.compatibility({}, signal)),
      idleStatus: async (query, signal) => unwrap(await scope.remote.contextInspector.idleStatus(query, signal)),
      inspect: async (query, signal) => unwrap(await scope.remote.contextInspector.inspect(query, signal)),
      content: async (query, signal) => unwrap(await scope.remote.contextInspector.content(query, signal)),
    }
    scope.inject(['remote.contextRecovery'], recovery => {
      api.prepareEmergency = async (query, signal) => unwrap(await recovery.remote.contextRecovery.prepareEmergency(query, signal))
      api.executeEmergency = async (query, signal) => unwrap(await recovery.remote.contextRecovery.executeEmergency(query, signal))
      api.authorizeOnce = async (query, signal) => unwrap(await recovery.remote.contextRecovery.authorizeOnce(query, signal))
    })
    scope.effect(() => scope.configForms.whileServed(['context-manager'], () => scope.slots.inject('settings.section', () => scope.slots.register({
      name: 'settings.section', id: 'context-manager', order: 65, label: '上下文管理',
      inject: () => ({ form, compatibility: api.compatibility! }),
    }, ContextPage))))
    scope.slots.inject('conversation.view', () => scope.slots.register({
      name: 'conversation.view', id: 'context-manager', order: 20, label: () => t('title'), locale: 'context.manager',
      inject: (sessionId: SessionId): ContextViewInjected => {
        const session = scope.sessions.binding(sessionId)?.session
        if (!session) throw new Error('上下文管理：当前会话尚未就绪。')
        return { target: sessionId, form, api, locale: scope.locale.getLocale().active, pulse: session.projections.faceOf('contextPressure') }
      },
    }, ContextInspectorView))
  })
}

export function ContextPage({ form, compatibility }: { form: ConfigForm<Values>; compatibility: NonNullable<InspectorApi['compatibility']> }) {
  const [host, setHost] = useState<HostCapabilityReadout | null>(null)
  useEffect(() => {
    const controller = new AbortController()
    void compatibility(controller.signal).then(setHost, () => setHost({ state: 'unknown', reason: '无法读取宿主压缩能力',
      integration: { state: 'unknown', reason: '无法读取 Context provider 注册状态' } }))
    return () => controller.abort()
  }, [compatibility])
  return <section aria-label="上下文管理" className="dsh-context-settings">
    <style data-plugin={STYLE_OWNER} data-plugin-css={`${STYLE_OWNER}/settings`}>{css}</style><h2 className="cm-title">上下文管理</h2>
    <p className="cm-intro">设置何时先压缩、再继续执行。会话数据位于“对话 / 轨迹”后的“上下文”页签。</p>
    <p className="cm-intro" role="status">
      {host?.state === 'unsupported' ? `宿主压缩 API 不可用：${host.reason}`
        : host?.state === 'supported' ? '宿主压缩 API v1 可用。'
          : '宿主压缩 API 状态未知。'}{' '}
      {host?.integration.state === 'pending' ? 'Context provider 正在注册；各会话是否增强以实际绑定为准。'
        : host?.integration.state === 'registered' ? 'Context provider selection 已注册供后续绑定使用；各会话是否增强以实际绑定为准。'
          : host?.integration.state === 'failed' ? `Context provider 注册失败：${host.integration.reason ?? '原因未知'}。请在会话页核对实际压缩绑定。`
            : host?.integration.state === 'unknown' ? `Context provider 注册状态未知${host.integration.reason ? `：${host.integration.reason}` : '。'} 请在会话页核对实际压缩绑定。`
              : `Context provider 当前未注册${host?.integration.reason ? `：${host.integration.reason}` : '。'} 各会话是否增强以实际绑定为准。`}
    </p>
    <ContextSettings form={form} />
  </section>
}

const numericKeys = ['recentPercent', 'summaryPercent', 'repairPercent', 'triggerPercent', 'targetPercent', 'recentTokens', 'earlyPercent', 'safetyPercent', 'summaryMaxTokens', 'maxPasses', 'timeoutMs', 'summaryTotalMs', 'summaryFirstOutputMs', 'summaryStallMs', 'idleMinutes', 'idleMinPercent', 'formatRepairMaxTokens', 'absoluteTriggerTokens', 'absoluteTargetTokens', 'toolResultsMaxChars', 'toolResultsMinSavings', 'archiveReadBudget', 'archiveSearchLimit'] as const
type NumericKey = typeof numericKeys[number]
type Draft = Omit<Policy, NumericKey> & Record<NumericKey, string>
function toDraft(policy: Policy): Draft {
  const normalized = normalizePolicy(policy)
  const fields = Object.fromEntries(numericKeys.map(key => [key, String(normalized[key])])) as Record<NumericKey, string>
  return { ...normalized, ...fields }
}
function toPolicy(draft: Draft): Policy {
  const fields = Object.fromEntries(numericKeys.map(key => [key, draft[key].trim() ? Number(draft[key]) : NaN])) as Record<NumericKey, number>
  return { ...draft, ...fields }
}

/** Native DSH value fields share the host's typography, borders and save footer. */
export function ContextSettings({ form }: { form: ConfigForm<Values> }) {
  const accepted = useSyncExternalStore(callback => form.subscribe(callback), () => form.getSnapshot())
  const [draft, setDraft] = useState(() => toDraft(accepted.value?.policy ?? defaults))
  const [revision, setRevision] = useState(accepted.revision)
  const [dirty, setDirty] = useState(false)
  const [saving, setSaving] = useState(false)
  const [feedback, setFeedback] = useState('')
  const [failed, setFailed] = useState(false)
  useEffect(() => {
    if (!dirty && accepted.value) { setDraft(toDraft(accepted.value.policy)); setRevision(accepted.revision) }
  }, [accepted, dirty])
  function edit(update: Partial<Draft>) { setDraft(p => ({ ...p, ...update })); setDirty(true); setFeedback(''); setFailed(false) }
  const policy = toPolicy(draft)
  let invalid = ''
  try { validatePolicy(policy) } catch (error) { invalid = error instanceof Error ? error.message : String(error) }
  const disabled = !accepted.writable || saving || accepted.status !== 'ready'
  async function save() {
    if (disabled || !dirty || invalid) return
    setSaving(true); setFeedback(''); setFailed(false)
    try {
      const ok = await form.mutate([{ op: 'set', path: ['policy'], value: { ...policy } }], revision)
      if (ok) { setDirty(false); setFeedback('设置已保存。') }
      else { setFailed(true); setFeedback('未保存：配置可能已在别处更改。请重新载入后再编辑。') }
    } catch (error) { setFailed(true); setFeedback(`保存失败：${error instanceof Error ? error.message : String(error)}`) }
    finally { setSaving(false) }
  }
  function reload() {
    setDirty(false); setFeedback(''); setFailed(false)
    setDraft(toDraft(accepted.value?.policy ?? defaults)); setRevision(accepted.revision)
  }
  const numeric = (key: NumericKey, label: string, hint: string, blocked = false) => <SettingsValueField
    key={key} id={`context-manager-${key}`} label={label} hint={hint} numeric
    text={draft[key]} disabled={disabled || blocked} invalid={!Number.isFinite(policy[key])}
    overridden={draft[key] !== String(defaults[key])} overriddenLabel="自定义" resetLabel="恢复推荐值" invalidLabel="请输入有效数字"
    onEdit={text => edit({ [key]: text })} onReset={() => edit({ [key]: String(defaults[key]) })}/>
  const toggle = (key: 'enabled' | 'idleEnabled' | 'formatRepairEnabled' | 'absoluteEnabled' | 'prefixDiagnosticsEnabled', label: string, hint: string, blocked = false) => <div className="cm-native-toggle">
    <div className="cm-row"><span>{label}</span><Switch label={label} checked={draft[key]} disabled={disabled || blocked} onChange={value => edit({ [key]: value })}/></div>
    <p className="cm-hint">{hint}</p>
  </div>
  const automatic = policy.historyMode === 'automatic'
  return <section aria-label="上下文压缩设置" className="dsh-context-settings">
    <style data-plugin={STYLE_OWNER} data-plugin-css={`${STYLE_OWNER}/settings`}>{css}</style>
    <SettingsForm labels={{ unavailable: '正在读取上下文设置…', readOnly: '当前连接不支持保存设置。', saveFailed: feedback, save: '保存设置', saving: '保存中…' }}
      state={{ available: accepted.status === 'ready', writable: accepted.writable, dirty: dirty && !disabled, invalid: !!invalid, saving, failed }}
      onSave={() => { void save() }} onDiscard={() => { /* Unmount releases this form's draft. */ }}>
      <fieldset disabled={disabled} className="cm-native-fields">
        {draft.summaryTimeoutMode === 'fixed' && <div role="status">
          <p className="cm-hint">当前保留固定总时限 {Number(draft.timeoutMs) / 1000} 秒；即使摘要持续输出也会到时停止。长任务建议按输出进展等待，成功后自动继续当前任务。</p>
          <Button size="sm" disabled={disabled} onClick={() => edit({ summaryTimeoutMode: 'adaptive' })}>切换为按进展等待</Button>
          <p className="cm-hint">点击后保存设置才生效；保留原固定值及现有分层时限。不会恢复已经结束的任务，也不会重试未知收费请求。</p>
        </div>}
        {toggle('enabled', '自动压缩', '在执行前检查完整请求，必要时先压缩。关闭后停止自动整理，超出安全窗口时暂停。')}
        <div className="cm-native-presets" role="group" aria-label="压缩策略">
          {([[70, '提前整理 · 70%'], [80, '均衡 · 80%'], [85, '稍后整理 · 85%']] as const).map(([triggerPercent, label]) =>
            <Button key={triggerPercent} size="sm" variant="outline" aria-pressed={policy.triggerPercent === triggerPercent}
              onClick={() => edit({ triggerPercent: String(triggerPercent) })}>{label}</Button>)}
        </div>
        {numeric('triggerPercent', '上下文用到多少时压缩（%）', '按当前模型窗口计算。新消息会计入检查，输出预留和安全空间可能使实际阈值更低。')}
        <div className="cm-native-presets" role="group" aria-label="历史保留策略">
          {([['automatic', '自动工作集'], ['custom', '自定义占用上限']] as const).map(([historyMode, label]) =>
            <Button key={historyMode} size="sm" variant="outline" aria-pressed={policy.historyMode === historyMode} disabled={!draft.enabled}
              onClick={() => edit({ historyMode })}>{label}</Button>)}
        </div>
        <p className="cm-hint">{automatic
          ? '保留受保护任务、有界近期原文与滚动检查点。压后总占用按实际内容计算，不使用保存的百分比或绝对占用上限；旧值仍保留。'
          : '在工作集规划上增加压后总占用上限。必要指令和当前任务不能为满足上限而被删除；无法达到时说明原因并保留任务。切回自动工作集不会删除这些设置。'}</p>
        {!automatic && numeric('targetPercent', '压后占用上限（%）', '按真实完整窗口计算；须比检查阈值至少低 10 个百分点，输出预留可能进一步降低有效上限。', !draft.enabled)}
        {draft.capacityMode !== 'percent' && <div role="status"><p className="cm-hint">旧配置兼容：原近期原文、摘要、修复及已启用的绝对预算继续执行。各会话按真实模型窗口显示实际百分比；此全局设置页不假定窗口。下方百分比尚未启用。</p>
          <Button size="sm" disabled={disabled} onClick={() => edit({ capacityMode: 'percent' })}>改用下方百分比并解除旧绝对上限</Button>
          <p className="cm-hint">保存后生效。模型窗口变化会改变实际额度；请先检查下方百分比。原配置值保留供回退，旧费用和恢复额度不变。</p></div>}
        {draft.capacityMode === 'percent' && <p className="cm-hint">容量按每次请求的真实模型窗口计算；不再使用旧绝对上限。输出仍受模型限制及摘要的协议安全上限约束；本地结构修复不调用模型。小窗口向下取整，不扩大额度。各会话显示实际有效百分比。</p>}
        {toggle('idleEnabled', '闲置自动压缩', '任务正常结束后计时。新消息到达时取消整理；摘要会使用当前模型并消耗 Token。', !draft.enabled)}
        {numeric('idleMinutes', '任务结束后闲置时长（分钟）', '推荐 15 分钟，可设 1–1440 分钟。只处理本次运行中使用过的会话，应用退出后不执行。', !draft.enabled || !draft.idleEnabled)}
        <div className="cm-native-presets" role="group" aria-label="工具结果精简模式">
          {([['off', '关闭'], ['observe', '观察'], ['reduce', '安全精简']] as const).map(([toolResultsMode, label]) =>
            <Button key={toolResultsMode} size="sm" variant="outline" aria-pressed={policy.toolResultsMode === toolResultsMode}
              disabled={!draft.enabled} onClick={() => edit({ toolResultsMode })}>{label}</Button>)}
        </div>
        <p className="cm-hint">工具结果精简：关闭时不介入；观察模式只按规则测算并记录，不改动宿主工具结果；安全精简在确认最终结果保留短文后发布，未确认的引用不计入成果。字符阈值是可见文本长度，不是 Token 口径。引用原文长期保留，卸载不会删除；本版没有清理动作或配额设置。</p>
        {toggle('prefixDiagnosticsEnabled', '请求前缀指纹诊断', '只读采集并比较请求前缀（系统指令、工具定义与顺序）的指纹，用于说明前缀变化；关闭只停止这项诊断，不删除任何业务用量。', !draft.enabled)}
        <details className="cm-native-advanced"><summary>高级设置</summary>
          {numeric('recentPercent', '近期原文预算（%）', '按真实模型窗口计算；指令、受保护任务及检查点另计。仍受窗口安全空间和近期原文安全上限约束。', !draft.enabled || draft.capacityMode !== 'percent')}
          {numeric('idleMinPercent', '闲置压缩最低占用（%）', automatic
            ? `当前按 ${policy.idleMinPercent || '—'}% 检查，不受保存的压后占用上限影响。实际门槛不会超过请求准入线。`
            : `实际至少高于自定义占用上限 10 个百分点；当前为 ${Math.max(policy.idleMinPercent, policy.targetPercent + 10) || '—'}%，并受请求准入线限制。`)}
          <SettingsValueField id="context-manager-summaryInstructions" label="摘要保留重点" hint="可补充需要保留的内容，例如报错、修改文件、待办事项。最多 2000 字符，基础保护始终保留。"
            text={draft.summaryInstructions} disabled={disabled} invalid={draft.summaryInstructions.length > 2000}
            overridden={!!draft.summaryInstructions} overriddenLabel="自定义" resetLabel="清空" invalidLabel="最多 2000 字符"
            onEdit={summaryInstructions => edit({ summaryInstructions })} onReset={() => edit({ summaryInstructions: '' })}/>
          {numeric('toolResultsMaxChars', '工具结果输入上限（字符）', '超过该字符数的结果不会被精简，只按远原文处理。可设 2,000–4,000,000。', !draft.enabled || draft.toolResultsMode === 'off')}
          {numeric('toolResultsMinSavings', '发布精简的最小节省（字符）', '短文至少比原文短这么多字符才值得发布；达到上限与最小节省按可见文本字符比较。可设 100–1,000,000。', !draft.enabled || draft.toolResultsMode === 'off')}
          {numeric('archiveReadBudget', '单次原文回读预算（字符）', '搜索或读取原文时单个结果返回的字符上限，仍受工具自身输出上限约束。可设 500–6,000。', !draft.enabled)}
          {numeric('archiveSearchLimit', '搜索原文结果上限（条）', '一次搜索最多返回多少条已存原文命中，超出部分需要收窄关键词。可设 1–8。', !draft.enabled)}
          {numeric('earlyPercent', '提前检查空间（%）', '推荐 1%。为新任务与估算误差提前留出空间。')}
          {numeric('safetyPercent', '窗口安全空间（%）', '推荐 2%，在模型输出预留之外保留。')}
          {numeric('summaryPercent', '摘要输出上限（%）', '按真实模型窗口计算，沿用当前模型与推理级别；实际输出上限可能更低。', draft.capacityMode !== 'percent')}
          {numeric('maxPasses', '每个请求最多压缩次数', '可设 1 或 2。闲置整理只尝试一次，没有新增任务不会重复整理。')}
          <div role="group" aria-label="摘要 checkpoint 协议">
            {(['json', 'sections'] as const).map(protocol => <Button key={protocol} size="sm" aria-pressed={draft.checkpointFormat === protocol} disabled={disabled} onClick={() => edit({ checkpointFormat: protocol })}>{protocol === 'json' ? 'JSON 七字段' : 'Markdown 段落'}</Button>)}
          </div>
          <p className="cm-hint">当前协议：{draft.checkpointFormat === 'json' ? 'JSON 七字段（历史默认，兼容旧 checkpoint）' : 'Markdown 固定段落（模型输出转义负担更低）'}。切换只影响后续摘要；旧 JSON checkpoint 继续可读，不迁移或删除已保存配置。</p>
          {toggle('formatRepairEnabled', '本地结构修复', '结构校验失败且确定属于“单字符串误写为数组”时，由程序按原值包装后提交；不再重发模型，也不产生第二次收费。关闭后此类失败直接保留原文并终止。', !draft.enabled)}
          <div role="group" aria-label="压缩时限模式">
            {(['fixed', 'adaptive'] as const).map(summaryTimeoutMode => <Button key={summaryTimeoutMode} size="sm" aria-pressed={draft.summaryTimeoutMode === summaryTimeoutMode} disabled={disabled} onClick={() => edit({ summaryTimeoutMode })}>{summaryTimeoutMode === 'fixed' ? '固定总时限' : '按输出进展等待'}</Button>)}
          </div>
          {numeric('timeoutMs', '原固定总时限（毫秒）', draft.summaryTimeoutMode === 'fixed' ? '整笔压缩共享此上限；本地结构修复不另发模型、不另计时。保留原配置。' : '此模式不使用该值；切回固定模式恢复。', disabled || draft.summaryTimeoutMode !== 'fixed')}
          {draft.summaryTimeoutMode === 'adaptive' && <>
            {numeric('summaryTotalMs', '整笔压缩硬总限（毫秒）', '所有摘要调用、本地结构检查与提交共享；输出进展不会延长。')}
            {numeric('summaryFirstOutputMs', '首个有效输出等待（毫秒）', '每次调用重新计时；空数据和用量不算进展。')}
            {numeric('summaryStallMs', '输出停滞上限（毫秒）', '仅非空正文或思考增量续期，仍受硬总限约束。')}
          </>}

        </details>
        {invalid && <p role="alert" className="cm-error">{invalid}</p>}
        <div className="cm-actions"><Button size="sm" onClick={reload}>重新载入</Button><Button size="sm" onClick={() => edit(toDraft(defaults))}>恢复全部推荐值</Button></div>
      </fieldset>
    </SettingsForm>
    {feedback && !failed && <p role="status" className="cm-hint cm-feedback">{feedback}</p>}
  </section>
}
