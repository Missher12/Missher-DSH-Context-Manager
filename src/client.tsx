import { useState, useEffect, useSyncExternalStore } from 'react'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import { en, zh, type InspectorLocaleKey } from './inspector-locales.ts'
import { settingsEn, settingsText, settingsZh, type SettingsLocaleKey, type SettingsText } from './settings-locales.ts'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {} from '@deepseek-ai/dsh-client-ui-model-selection/client'
import type {} from '@deepseek-ai/dsh-api-remotes/client'
import type { RemoteResult } from '@deepseek-ai/dsh-typert-protocol'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { ConfigForm } from '@deepseek-ai/dsh-client-ui-settings/client'
import { Button } from '@deepseek-ai/dsh-client-ui-primitives'
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

declare module '@deepseek-ai/dsh-client-ui-slots' { interface LocaleNamespaceMap { 'context.manager': InspectorLocaleKey; 'context.manager.settings': SettingsLocaleKey } }

type Values = { policy: Policy }
export const inject = ['locale', 'slots', 'configForms', 'sessions', 'remote', 'remote.session', 'modelDirectories']

// Page styles are mounted after the module factory. Explicit ownership keeps
// another plugin's later materialization from claiming and removing them.
const STYLE_OWNER = 'dsh-context-manager'

/** Native conversation tab plus a separate parameter-only settings section. */
export async function apply(ctx: Context) {
  ctx.effect(() => ctx.locale.register('context.manager', { zh, en }), 'context-manager: locale')
  const t = ctx.locale.bind('context.manager')
  ctx.effect(() => ctx.locale.register('context.manager.settings', { zh: settingsZh, en: settingsEn }), 'context-manager: settings locale')
  const settingsT = ctx.locale.bind('context.manager.settings')
  const form = ctx.configForms.get<Values>('context-manager')
  ctx.slots.inject('conversation.input.right', () => ctx.slots.register({
    name: 'conversation.input.right', id: 'context-manager-period', order: 100,
    inject: (sessionId: string): PeakIndicatorProps => ({
      directory: ctx.modelDirectories.directoryFor(sessionId as SessionId).store,
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
      name: 'settings.section', id: 'context-manager', order: 65, label: () => settingsT('title'), locale: 'context.manager.settings',
      inject: () => ({ form, compatibility: api.compatibility!, t: settingsT }),
    }, ContextPage))))
    scope.slots.inject('conversation.view', () => scope.slots.register({
      name: 'conversation.view', id: 'context-manager', order: 20, label: () => t('title'), locale: 'context.manager',
      inject: (sessionId: string): ContextViewInjected => {
        const id = sessionId as SessionId
        const session = scope.sessions.binding(id)?.session
        if (!session) throw new Error('上下文管理：当前会话尚未就绪。')
        return { target: id, form, api, locale: scope.locale.getLocale().active, pulse: session.projections.faceOf('contextPressure') }
      },
    }, ContextInspectorView))
  })
}

export function ContextPage({ form, compatibility, t = settingsText() }: { form: ConfigForm<Values>; compatibility: NonNullable<InspectorApi['compatibility']>; t?: SettingsText }) {
  const [host, setHost] = useState<HostCapabilityReadout | null>(null)
  useEffect(() => {
    const controller = new AbortController()
    void compatibility(controller.signal).then(setHost, () => setHost({ state: 'unknown', reason: '无法读取宿主压缩能力',
      integration: { state: 'unknown', reason: '无法读取 Context provider 注册状态' } }))
    return () => controller.abort()
  }, [compatibility])
  const status = !host ? 'statusChecking'
    : host.state === 'unsupported' ? 'statusUnsupported'
      : host.state === 'unknown' ? 'statusUnknown'
        : host.integration.state === 'registered' ? 'statusAvailable'
          : host.integration.state === 'pending' ? 'statusPending'
            : host.integration.state === 'failed' ? 'statusFailed'
              : host.integration.state === 'inactive' ? 'statusInactive' : 'statusUnknown'
  const capability = !host || host.state === 'unknown' ? 'capabilityUnknown'
    : host.state === 'supported' ? 'capabilitySupported' : 'capabilityUnsupported'
  const registration = !host ? 'registrationUnknown'
    : host.integration.state === 'registered' ? 'registrationRegistered'
      : host.integration.state === 'pending' ? 'registrationPending'
        : host.integration.state === 'failed' ? 'registrationFailed'
          : host.integration.state === 'inactive' ? 'registrationInactive' : 'registrationUnknown'
  return <section aria-label="上下文管理" className="dsh-context-settings">
    <style data-plugin={STYLE_OWNER} data-plugin-css={`${STYLE_OWNER}/settings`}>{css}</style><h2 className="cm-title">{t('title')}</h2>
    <p className="cm-intro">{t('intro')}</p>
    <p className="cm-intro" role={status === 'statusFailed' ? 'alert' : 'status'}>{t(status)}</p>
    <p className="cm-hint" role="note">{t('savedPolicyNote')}</p>
    <details className="cm-native-advanced">
      <summary>{t('technicalDetails')}</summary>
      <p className="cm-hint">{t('hostCapability')} · {t(capability)}{host?.version === undefined ? '' : ` · v${host.version}`}</p>
      <p className="cm-hint">{t('detailReason')} · {host?.reason ?? t('statusChecking')}</p>
      <p className="cm-hint">{t('registration')} · {t(registration)}</p>
      {host?.integration.reason && <p className="cm-hint">{t('detailReason')} · {host.integration.reason}</p>}
      <p className="cm-hint">{t('sessionStatusNote')}</p>
    </details>
    <ContextSettings form={form} t={t} />
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

type ContextValueFieldProps = {
  id: string; label: string; hint: string; text: string; disabled: boolean; invalid: boolean
  overridden: boolean; overriddenLabel: string; resetLabel: string; invalidLabel: string; numeric?: boolean
  onEdit: (text: string) => void; onReset: () => void
}
function ContextValueField({ id, label, hint, text, disabled, invalid, overridden, overriddenLabel, resetLabel, invalidLabel, numeric, onEdit, onReset }: ContextValueFieldProps) {
  return <div className="cm-native-value">
    <label htmlFor={id} className="cm-label">{label}</label>
    <p className="cm-hint">{hint}</p>
    <div className="cm-row cm-native-value-control">
      <input id={id} type="text" inputMode={numeric ? 'decimal' : 'text'} value={text} disabled={disabled} aria-invalid={invalid || undefined}
        onChange={event => onEdit(event.currentTarget.value)}/>
      {overridden && <><span className="cm-native-overridden">{overriddenLabel}</span><Button type="button" size="sm" variant="ghost" disabled={disabled} onClick={onReset}>{resetLabel}</Button></>}
    </div>
    {invalid && <p className="cm-error" role="alert">{invalidLabel}</p>}
  </div>
}
function ContextSwitch({ label, checked, disabled, onChange }: { label: string; checked: boolean; disabled: boolean; onChange: (value: boolean) => void }) {
  return <button type="button" className="cm-native-switch" role="switch" aria-label={label} aria-checked={checked} disabled={disabled} onClick={() => onChange(!checked)}>
    <span aria-hidden="true"/>
  </button>
}

/** Context settings controls use the actual RC.2 UI primitives where available and scoped native controls for removed form atoms. */
export function ContextSettings({ form, t = settingsText() }: { form: ConfigForm<Values>; t?: SettingsText }) {
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
  const numeric = (key: NumericKey, label: string, hint: string, blocked = false) => <ContextValueField
    key={key} id={`context-manager-${key}`} label={label} hint={hint} numeric
    text={draft[key]} disabled={disabled || blocked} invalid={!Number.isFinite(policy[key])}
    overridden={draft[key] !== String(defaults[key])} overriddenLabel="自定义" resetLabel="恢复推荐值" invalidLabel="请输入有效数字"
    onEdit={text => edit({ [key]: text })} onReset={() => edit({ [key]: String(defaults[key]) })}/>
  const toggle = (key: 'enabled' | 'idleEnabled' | 'formatRepairEnabled' | 'absoluteEnabled' | 'prefixDiagnosticsEnabled', label: string, hint: string, blocked = false) => <div className="cm-native-toggle">
    <div className="cm-row"><span>{label}</span><ContextSwitch label={label} checked={draft[key]} disabled={disabled || blocked} onChange={value => edit({ [key]: value })}/></div>
    <p className="cm-hint">{hint}</p>
  </div>
  const automatic = policy.historyMode === 'automatic'
  return <section aria-label="上下文压缩设置" className="dsh-context-settings">
    <style data-plugin={STYLE_OWNER} data-plugin-css={`${STYLE_OWNER}/settings`}>{css}</style>
    <div className="cm-settings-form" aria-busy={saving}>
      {accepted.status !== 'ready' && <p className="cm-hint" role="status">正在读取上下文设置…</p>}
        {accepted.status === 'ready' && !accepted.writable && <p className="cm-hint" role="status">当前连接不支持保存设置。</p>}
      <fieldset disabled={disabled} className="cm-native-fields">
        {draft.summaryTimeoutMode === 'fixed' && <div role="status">
          <p className="cm-hint">{t('fixedTimeoutPrefix')} {Number(draft.timeoutMs) / 1000} {t('seconds')}</p>
          <Button size="sm" disabled={disabled} onClick={() => edit({ summaryTimeoutMode: 'adaptive' })}>{t('switchAdaptive')}</Button>
          <p className="cm-hint">{t('timeoutSaveNote')}</p>
        </div>}
        {toggle('enabled', t('autoLabel'), t('autoHint'))}
        <div className="cm-native-presets" role="group" aria-label={t('presetGroup')}>
          {([[70, t('presetEarly')], [80, t('presetBalanced')], [85, t('presetLate')]] as const).map(([triggerPercent, label]) =>
            <Button key={triggerPercent} size="sm" variant="outline" aria-pressed={policy.triggerPercent === triggerPercent}
              onClick={() => edit({ triggerPercent: String(triggerPercent) })}>{label}</Button>)}
        </div>
        {numeric('triggerPercent', t('thresholdLabel'), t('thresholdHint'))}
        <div className="cm-native-presets" role="group" aria-label={t('historyGroup')}>
          {([['automatic', t('historyAutomatic')], ['custom', t('historyCustom')]] as const).map(([historyMode, label]) =>
            <Button key={historyMode} size="sm" variant="outline" aria-pressed={policy.historyMode === historyMode} disabled={!draft.enabled}
              onClick={() => edit({ historyMode })}>{label}</Button>)}
        </div>
        <p className="cm-hint">{automatic
          ? t('historyAutomaticHint') : t('historyCustomHint')}</p>
        {!automatic && numeric('targetPercent', t('targetLabel'), t('targetHint'), !draft.enabled)}
        {draft.capacityMode !== 'percent' && <div role="status"><p className="cm-hint">{t('legacyConfigNote')}</p>
          <Button size="sm" disabled={disabled} onClick={() => edit({ capacityMode: 'percent' })}>{t('switchPercent')}</Button>
          <p className="cm-hint">{t('capacitySavedNote')}</p></div>}
        {draft.capacityMode === 'percent' && <p className="cm-hint">{t('capacityPercentHint')}</p>}
        {toggle('idleEnabled', t('idleLabel'), t('idleHint'), !draft.enabled)}
        {numeric('idleMinutes', t('idleMinutesLabel'), t('idleMinutesHint'), !draft.enabled || !draft.idleEnabled)}
        <div className="cm-native-presets" role="group" aria-label={t('toolGroup')}>
          {([['off', t('toolOff')], ['observe', t('toolObserve')], ['reduce', t('toolReduce')]] as const).map(([toolResultsMode, label]) =>
            <Button key={toolResultsMode} size="sm" variant="outline" aria-pressed={policy.toolResultsMode === toolResultsMode}
              disabled={!draft.enabled} onClick={() => edit({ toolResultsMode })}>{label}</Button>)}
        </div>
        <p className="cm-hint">{t('toolResultsHint')}</p>
        <details className="cm-native-advanced"><summary>高级设置</summary>
          {toggle('prefixDiagnosticsEnabled', t('prefixLabel'), t('prefixHint'), !draft.enabled)}
          {numeric('recentPercent', '近期原文预算（%）', '按真实模型窗口计算；指令、受保护任务及检查点另计。仍受窗口安全空间和近期原文安全上限约束。', !draft.enabled || draft.capacityMode !== 'percent')}
          {numeric('idleMinPercent', '闲置压缩最低占用（%）', automatic
            ? `当前按 ${policy.idleMinPercent || '—'}% 检查，不受保存的压后占用上限影响。实际门槛不会超过请求准入线。`
            : `实际至少高于自定义占用上限 10 个百分点；当前为 ${Math.max(policy.idleMinPercent, policy.targetPercent + 10) || '—'}%，并受请求准入线限制。`)}
          <ContextValueField id="context-manager-summaryInstructions" label="摘要保留重点" hint="可补充需要保留的内容，例如报错、修改文件、待办事项。最多 2000 字符，基础保护始终保留。"
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
      {feedback && <p role={failed ? 'alert' : 'status'} className={failed ? 'cm-error cm-feedback' : 'cm-hint cm-feedback'}>{feedback}</p>}
      <div className="cm-native-save"><Button type="button" size="sm" variant="primary" disabled={disabled || !dirty || !!invalid} onClick={() => { void save() }}>{saving ? '保存中…' : '保存设置'}</Button></div>
    </div>
  </section>
}
