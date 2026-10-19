import { useState, useEffect, useSyncExternalStore, type ChangeEvent, type ComponentType } from 'react'
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
import { Button, Input, Tooltip } from '@deepseek-ai/dsh-client-ui-primitives'
import * as uiPrimitives from '@deepseek-ai/dsh-client-ui-primitives'
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

// RC.2's runtime exports Switch. The checked-in development type package is
// still RC.1, so keep the narrow verified prop shape local instead of adding a
// missing primitive or changing the shared dependency tree.
type HostSwitchProps = { checked: boolean; disabled?: boolean; label: string; onChange: (checked: boolean) => void }
const HostSwitch = (uiPrimitives as unknown as { Switch?: ComponentType<HostSwitchProps> }).Switch

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
  return <section aria-label="上下文管理" className="dsh-context-settings">
    <style data-plugin={STYLE_OWNER} data-plugin-css={`${STYLE_OWNER}/settings`}>{css}</style><h2 className="cm-title">{t('title')}</h2>
    {status !== 'statusAvailable' && <p className="cm-intro" role={status === 'statusFailed' ? 'alert' : 'status'}>{t(status)}</p>}
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
  overridden: boolean; overriddenLabel: string; resetLabel: string; invalidLabel: string; numeric?: boolean; unit?: string; multiline?: boolean
  onEdit: (text: string) => void; onReset: () => void
}
function ContextHelp({ label, hint }: { label: string; hint: string }) {
  return <Tooltip label={hint} side="bottom"><span className="cm-native-help" tabIndex={0} role="note" aria-label={`${label}: ${hint}`}>?</span></Tooltip>
}
function ContextValueField({ id, label, hint, text, disabled, invalid, overridden, overriddenLabel, resetLabel, invalidLabel, numeric, unit, multiline, onEdit, onReset }: ContextValueFieldProps) {
  return <div className="cm-native-value">
    <div className="cm-native-copy"><label htmlFor={id} className="cm-label">{label}</label><ContextHelp label={label} hint={hint}/></div>
    <div className="cm-native-value-control">
      {multiline
        ? <textarea id={id} value={text} disabled={disabled} aria-invalid={invalid || undefined} onChange={event => onEdit(event.currentTarget.value)}/>
        : <Input className="cm-native-input" id={id} type="text" inputMode={numeric ? 'decimal' : 'text'} value={text} disabled={disabled} aria-invalid={invalid || undefined} onChange={(event: ChangeEvent<HTMLInputElement>) => onEdit(event.currentTarget.value)}/>}
      {unit && <span className="cm-native-unit">{unit}</span>}
      {overridden && <><span className="cm-native-overridden">{overriddenLabel}</span><Button type="button" size="sm" variant="ghost" disabled={disabled} onClick={onReset}>{resetLabel}</Button></>}
    </div>
    {invalid && <p className="cm-error" role="alert">{invalidLabel}</p>}
  </div>
}
function ContextSwitch({ label, checked, disabled, onChange }: HostSwitchProps) {
  if (HostSwitch) return <HostSwitch label={label} checked={checked} disabled={disabled} onChange={onChange}/>
  // Older compatible Hosts may not expose Switch yet; keep an accessible fallback.
  return <button type="button" className="cm-native-switch" role="switch" aria-label={label} aria-checked={checked} disabled={disabled} onClick={() => onChange(!checked)}><span aria-hidden="true"/></button>
}
function safeSaveReason(error: unknown, t: SettingsText) {
  if (!(error instanceof Error)) return t('unknownSaveReason')
  const reason = error.message
    .replace(/\b(token|authorization|secret|password)\b\s*[:=]\s*[^\s,;]+/gi, '$1=[redacted]')
    .replace(/[A-Za-z]:[\\/][^\s"'<>]+/g, '[path]')
    .replace(/(?:\/[^\s/]+){2,}/g, '[path]')
    .replace(/[\u0000-\u001f]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 180)
  return reason || t('unknownSaveReason')
}
type ContextSelectOption = { value: string; label: string }
function ContextSelect({ id, label, hint, value, options, disabled, onChange }: { id: string; label: string; hint: string; value: string; options: readonly ContextSelectOption[]; disabled: boolean; onChange: (value: string) => void }) {
  return <div className="cm-native-select-row"><div className="cm-native-copy"><label htmlFor={id} className="cm-label">{label}</label><ContextHelp label={label} hint={hint}/></div>
    <select id={id} value={value} disabled={disabled} onChange={event => onChange(event.currentTarget.value)}>{options.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}</select>
  </div>
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
  if (!invalid && draft.summaryInstructions.length > 2000) invalid = t('instructionsTooLong')
  const disabled = !accepted.writable || saving || accepted.status !== 'ready'
  async function save() {
    if (disabled || !dirty || invalid) return
    setSaving(true); setFeedback(''); setFailed(false)
    try {
      const ok = await form.mutate([{ op: 'set', path: ['policy'], value: { ...policy } }], revision)
      if (ok) { setDirty(false); setFeedback(t('savedSettings')) }
      else { setFailed(true); setFeedback(t('conflictSettings')) }
    } catch (error) {
      setFailed(true); setFeedback(`${t('failedSettings')} · ${safeSaveReason(error, t)}`)
    }
    finally { setSaving(false) }
  }
  function reload() {
    setDirty(false); setFeedback(''); setFailed(false)
    setDraft(toDraft(accepted.value?.policy ?? defaults)); setRevision(accepted.revision)
  }
  const numeric = (key: NumericKey, label: string, hint: string, unit = '', blocked = false) => <ContextValueField
    key={key} id={`context-manager-${key}`} label={label} hint={hint} numeric
    unit={unit}
    text={draft[key]} disabled={disabled || blocked} invalid={!Number.isFinite(policy[key])}
    overridden={draft[key] !== String(defaults[key])} overriddenLabel={t('customValue')} resetLabel={t('resetValue')} invalidLabel={t('invalidNumber')}
    onEdit={text => edit({ [key]: text })} onReset={() => edit({ [key]: String(defaults[key]) })}/>
  const toggle = (key: 'enabled' | 'idleEnabled' | 'formatRepairEnabled' | 'absoluteEnabled' | 'prefixDiagnosticsEnabled', label: string, hint: string, blocked = false) =>
    <div className="cm-native-toggle"><div className="cm-native-copy"><span className="cm-label">{label}</span><ContextHelp label={label} hint={hint}/></div><ContextSwitch label={label} checked={draft[key]} disabled={disabled || blocked} onChange={value => edit({ [key]: value })}/></div>
  const automatic = policy.historyMode === 'automatic'
  return <section aria-label="上下文压缩设置" className="dsh-context-settings">
    <style data-plugin={STYLE_OWNER} data-plugin-css={`${STYLE_OWNER}/settings`}>{css}</style>
    <div className="cm-settings-form" aria-busy={saving}>
      {accepted.status !== 'ready' && <p className="cm-hint" role="status">{t('waitingSettings')}</p>}
      {accepted.status === 'ready' && !accepted.writable && <p className="cm-hint" role="status">{t('readonlySettings')}</p>}
      <fieldset disabled={disabled} className="cm-native-fields">
        {toggle('enabled', t('autoLabel'), t('autoHint'))}
        {numeric('triggerPercent', t('thresholdLabel'), t('thresholdHint'), '%')}
        <ContextSelect id="context-manager-historyMode" label={t('historyGroup')} hint={automatic ? t('historyAutomaticHint') : t('historyCustomHint')}
          value={draft.historyMode} disabled={disabled || !draft.enabled} onChange={value => edit({ historyMode: value as Policy['historyMode'] })}
          options={[{ value: 'automatic', label: t('historyAutomatic') }, { value: 'custom', label: t('historyCustom') }]}/>
        {!automatic && numeric('targetPercent', t('targetLabel'), t('targetHint'), '%', !draft.enabled)}
        {draft.capacityMode !== 'percent' && <div className="cm-native-legacy" role="status"><span>{t('legacyConfigNote')}</span><Button size="sm" disabled={disabled} onClick={() => edit({ capacityMode: 'percent' })}>{t('switchPercent')}</Button><p className="cm-hint">{t('capacitySavedNote')}</p></div>}
        {draft.capacityMode === 'percent' && <p className="cm-native-note">{t('capacityPercentHint')}</p>}
        {toggle('idleEnabled', t('idleLabel'), t('idleHint'), !draft.enabled)}
        {draft.idleEnabled && <p className="cm-native-cost-note" role="note">{t('idleCostNote')}</p>}
        {numeric('idleMinutes', t('idleMinutesLabel'), t('idleMinutesHint'), t('unitMinutes'), !draft.enabled || !draft.idleEnabled)}
        <ContextSelect id="context-manager-toolResultsMode" label={t('toolGroup')} hint={t('toolResultsHint')} value={draft.toolResultsMode}
          disabled={disabled || !draft.enabled} onChange={value => edit({ toolResultsMode: value as Policy['toolResultsMode'] })}
          options={[{ value: 'off', label: t('toolOff') }, { value: 'observe', label: t('toolObserve') }, { value: 'reduce', label: t('toolReduce') }]}/>
        <details className="cm-native-advanced"><summary>{t('advanced')}</summary>
          {toggle('prefixDiagnosticsEnabled', t('prefixLabel'), t('prefixHint'), !draft.enabled)}
          {draft.capacityMode === 'percent' && numeric('recentPercent', t('recentPercentLabel'), t('recentPercentHint'), '%', !draft.enabled)}
          {numeric('idleMinPercent', t('idleMinPercentLabel'), t('idleMinPercentHint'), '%')}
          <ContextValueField id="context-manager-summaryInstructions" label={t('summaryInstructionsLabel')} hint={t('summaryInstructionsHint')}
            text={draft.summaryInstructions} disabled={disabled} invalid={draft.summaryInstructions.length > 2000} multiline
            overridden={!!draft.summaryInstructions} overriddenLabel={t('customValue')} resetLabel={t('clear')} invalidLabel={t('instructionsTooLong')}
            onEdit={summaryInstructions => edit({ summaryInstructions })} onReset={() => edit({ summaryInstructions: '' })}/>
          {numeric('toolResultsMaxChars', t('toolResultsMaxCharsLabel'), t('toolResultsMaxCharsHint'), t('unitCharacters'), !draft.enabled || draft.toolResultsMode === 'off')}
          {numeric('toolResultsMinSavings', t('toolResultsMinSavingsLabel'), t('toolResultsMinSavingsHint'), t('unitCharacters'), !draft.enabled || draft.toolResultsMode === 'off')}
          {numeric('archiveReadBudget', t('archiveReadBudgetLabel'), t('archiveReadBudgetHint'), t('unitCharacters'), !draft.enabled)}
          {numeric('archiveSearchLimit', t('archiveSearchLimitLabel'), t('archiveSearchLimitHint'), t('unitItems'), !draft.enabled)}
          {numeric('earlyPercent', t('earlyPercentLabel'), t('earlyPercentHint'), '%')}
          {numeric('safetyPercent', t('safetyPercentLabel'), t('safetyPercentHint'), '%')}
          {draft.capacityMode === 'percent' && numeric('summaryPercent', t('summaryPercentLabel'), t('summaryPercentHint'), '%')}
          {numeric('maxPasses', t('maxPassesLabel'), t('maxPassesHint'), t('unitCount'))}
          <ContextSelect id="context-manager-checkpointFormat" label={t('checkpointFormatLabel')} hint={t('checkpointHint')} value={draft.checkpointFormat} disabled={disabled}
            onChange={value => edit({ checkpointFormat: value as Policy['checkpointFormat'] })}
            options={[{ value: 'json', label: t('checkpointJson') }, { value: 'sections', label: t('checkpointSections') }]}/>
          {toggle('formatRepairEnabled', t('formatRepairLabel'), t('formatRepairHint'), !draft.enabled)}
          <ContextSelect id="context-manager-summaryTimeoutMode" label={t('timeoutModeLabel')} hint={t('timeoutSaveNote')} value={draft.summaryTimeoutMode} disabled={disabled}
            onChange={value => edit({ summaryTimeoutMode: value as Policy['summaryTimeoutMode'] })}
            options={[{ value: 'fixed', label: t('timeoutFixed') }, { value: 'adaptive', label: t('timeoutAdaptive') }]}/>
          {numeric('timeoutMs', t('timeoutMsLabel'), t('timeoutMsHint'), t('unitMilliseconds'), draft.summaryTimeoutMode !== 'fixed')}
          {draft.summaryTimeoutMode === 'adaptive' && <>
            {numeric('summaryTotalMs', t('summaryTotalMsLabel'), t('summaryTotalMsHint'), t('unitMilliseconds'))}
            {numeric('summaryFirstOutputMs', t('summaryFirstOutputMsLabel'), t('summaryFirstOutputMsHint'), t('unitMilliseconds'))}
            {numeric('summaryStallMs', t('summaryStallMsLabel'), t('summaryStallMsHint'), t('unitMilliseconds'))}
          </>}

        </details>
        {invalid && <p role="alert" className="cm-error">{invalid}</p>}
        <div className="cm-actions"><Button size="sm" disabled={!dirty || disabled} onClick={reload}>{t('cancelChanges')}</Button><Button size="sm" disabled={disabled} onClick={() => edit(toDraft(defaults))}>{t('restoreDefaults')}</Button></div>
      </fieldset>
      {feedback && <p role={failed ? 'alert' : 'status'} className={failed ? 'cm-error cm-feedback' : 'cm-hint cm-feedback'}>{feedback}</p>}
      <div className="cm-native-save"><Button type="button" size="sm" variant="primary" disabled={disabled || !dirty || !!invalid} onClick={() => { void save() }}>{saving ? t('saving') : t('save')}</Button></div>
    </div>
  </section>
}
