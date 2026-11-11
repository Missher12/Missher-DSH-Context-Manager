import { useState, useEffect, useLayoutEffect, useRef, useSyncExternalStore, type ChangeEvent, type ComponentType, type CSSProperties, type ReactNode } from 'react'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import { en, zh, type InspectorLocaleKey } from './inspector-locales.ts'
import { settingsEn, settingsText, settingsZh, type SettingsLocaleKey, type SettingsText } from './settings-locales.ts'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {} from '@deepseek-ai/dsh-client-ui-model-selection/client'
import type {} from '@deepseek-ai/dsh-token-meter/client'
import type {} from '@deepseek-ai/dsh-api-remotes/client'
import type { RemoteResult } from '@deepseek-ai/dsh-typert-protocol'
import type { ModelCatalog } from '@deepseek-ai/dsh-api-session-controller/types'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { ConfigForm } from '@deepseek-ai/dsh-client-ui-settings/client'
import { Button, Input, Tooltip } from '@deepseek-ai/dsh-client-ui-primitives'
import * as uiPrimitives from '@deepseek-ai/dsh-client-ui-primitives'
import type {} from '@deepseek-ai/dsh-api-session-controller/client'
import { ContextInspectorView, type ContextViewInjected } from './inspector-view.tsx'
import { PeakIndicator, type PeakIndicatorProps } from './peak-indicator.tsx'
import { CompactionBanner, type CompactionBannerProps } from './compaction-banner.tsx'
import type { ContentPage, ContentQuery, Inspection, InspectQuery, InspectorApi, SessionUsageReadout, TeamUsageReadout } from './inspector-types.ts'
import type { HostCapabilityReadout } from './compatibility.ts'
import { TYPERT_REMOTE } from './inspector-wire.ts'
import { useStableScrollbarGutter } from './stable-gutter.ts'
import { defaults, normalizePolicy, validatePolicy, type Policy } from './policy.ts'
import type { IdleStatus } from './idle-types.ts'
import css from './client.css'
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
      sessionUsage(query: { sessionId: string }, signal: AbortSignal): Promise<RemoteResult<SessionUsageReadout>>
      teamUsage(query: { sessionId: string }, signal: AbortSignal): Promise<RemoteResult<TeamUsageReadout>>
      content(query: ContentQuery, signal: AbortSignal): Promise<RemoteResult<ContentPage>>
    }
  }
}

declare module '@deepseek-ai/dsh-client-ui-slots' { interface LocaleNamespaceMap { 'context.manager': InspectorLocaleKey; 'context.manager.settings': SettingsLocaleKey } }

type Values = { policy: Policy }
type ModelLimitOption = { provider: string; model: string; label: string; providerLabel?: string }
type ModelCatalogReader = () => Promise<readonly ModelLimitOption[]>
export const inject = ['locale', 'slots', 'configForms', 'sessions', 'remote', 'remote.session', 'modelDirectories']

// Page styles are mounted after the module factory. Explicit ownership keeps
// another plugin's later materialization from claiming and removing them.
const STYLE_OWNER = 'dsh-context-manager'
const EMPTY_USAGE_PULSE = { subscribe: (_callback: () => void) => () => {}, getSnapshot: () => null }

/** Native conversation tab plus a separate parameter-only settings section. */
export async function apply(ctx: Context) {
  ctx.effect(() => ctx.locale.register('context.manager', { zh, en }), 'context-manager: locale')
  const t = ctx.locale.bind('context.manager')
  ctx.effect(() => ctx.locale.register('context.manager.settings', { zh: settingsZh, en: settingsEn }), 'context-manager: settings locale')
  const settingsT = ctx.locale.bind('context.manager.settings')
  const form = ctx.configForms.get<Values>('context-manager')
  const unmount = await ctx.remote.$mount(TYPERT_REMOTE)
  ctx.effect(() => unmount, 'context-manager: remote')
  ctx.inject(['remote.contextInspector', 'remote.session'], scope => {
    const unwrap = <T,>(result: RemoteResult<T>): T => {
      if (!result.ok) throw new Error(`上下文读取失败：${result.error.code}`)
      return result.value
    }
    const api: InspectorApi = {
      compatibility: async signal => unwrap(await scope.remote.contextInspector.compatibility({}, signal)),
      idleStatus: async (query, signal) => unwrap(await scope.remote.contextInspector.idleStatus(query, signal)),
      inspect: async (query, signal) => unwrap(await scope.remote.contextInspector.inspect(query, signal)),
      sessionUsage: async (query, signal) => unwrap(await scope.remote.contextInspector.sessionUsage(query, signal)),
      teamUsage: async (query, signal) => unwrap(await scope.remote.contextInspector.teamUsage(query, signal)),
      content: async (query, signal) => unwrap(await scope.remote.contextInspector.content(query, signal)),
    }
    const modelCatalog: ModelCatalogReader = async () => {
      const catalog: ModelCatalog = unwrap(await scope.remote.session.modelCatalog())
      return catalog.groups.flatMap(group => group.models.map(model => ({
        provider: group.id, model: model.id, label: model.name, providerLabel: group.name,
      })))
    }
    scope.slots.inject('conversation.input.right', () => scope.slots.register({
      name: 'conversation.input.right', id: 'context-manager-period', order: 100,
      inject: (sessionId: string): PeakIndicatorProps => {
        const id = sessionId as SessionId
        const session = ctx.sessions.binding(id)?.session
        return {
          sessionId,
          directory: ctx.modelDirectories.directoryFor(id).store,
          usagePulse: session?.projections.faceOf('tokenUsage') ?? EMPTY_USAGE_PULSE,
          readUsage: signal => api.sessionUsage({ sessionId }, signal),
        }
      },
    }, PeakIndicator))
    scope.slots.inject('conversation.composer.dock', () => scope.slots.register({
      name: 'conversation.composer.dock', id: 'context-manager-compaction', order: 10,
      inject: (sessionId: string): CompactionBannerProps => ({
        sessionId,
        readStatus: signal => api.idleStatus({ sessionId }, signal),
        label: t,
      }),
    }, CompactionBanner))
    scope.inject(['remote.contextRecovery'], recovery => {
      api.prepareEmergency = async (query, signal) => unwrap(await recovery.remote.contextRecovery.prepareEmergency(query, signal))
      api.executeEmergency = async (query, signal) => unwrap(await recovery.remote.contextRecovery.executeEmergency(query, signal))
      api.authorizeOnce = async (query, signal) => unwrap(await recovery.remote.contextRecovery.authorizeOnce(query, signal))
    })
    scope.effect(() => scope.configForms.whileServed(['context-manager'], () => scope.slots.inject('settings.section', () => scope.slots.register({
      name: 'settings.section', id: 'context-manager', order: 65, label: () => settingsT('title'), locale: 'context.manager.settings',
      inject: () => ({ form, compatibility: api.compatibility!, modelCatalog, t: settingsT }),
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

export function ContextPage({ form, compatibility, modelCatalog, t = settingsText() }: { form: ConfigForm<Values>; compatibility: NonNullable<InspectorApi['compatibility']>; modelCatalog?: ModelCatalogReader; t?: SettingsText }) {
  const [host, setHost] = useState<HostCapabilityReadout | null>(null)
  const [models, setModels] = useState<readonly ModelLimitOption[]>([])
  const [catalogUnavailable, setCatalogUnavailable] = useState(false)
  useEffect(() => {
    const controller = new AbortController()
    void compatibility(controller.signal).then(setHost, () => setHost({ state: 'unknown', reason: '无法读取宿主压缩能力',
      integration: { state: 'unknown', reason: '无法读取 Context provider 注册状态' } }))
    return () => controller.abort()
  }, [compatibility])
  useEffect(() => {
    if (!modelCatalog) return
    let active = true
    void modelCatalog().then(value => { if (active) setModels(value) }, () => { if (active) setCatalogUnavailable(true) })
    return () => { active = false }
  }, [modelCatalog])
  const requestPath = host?.requestPath
  const missingInterfaces = host?.missingInterfaces ?? []
  const sidecarState = requestPath?.path === 'request-gate-sidecar' ? requestPath.state : undefined
  const registrationOptional = host?.state === 'unsupported' && sidecarState !== undefined
  const status: SettingsLocaleKey = !host ? 'statusChecking'
    : sidecarState === 'ready' ? 'statusSidecarReady'
      : sidecarState === 'pending' ? 'statusSidecarPending'
        : sidecarState === 'blocked' ? 'statusSidecarBlocked'
        : sidecarState === 'failed' ? 'statusSidecarFailed'
          : host.state === 'unsupported' ? 'statusUnsupported'
            : host.state === 'unknown' ? 'statusUnknown'
              : host.integration.state === 'registered' ? 'statusAvailable'
                : host.integration.state === 'pending' ? 'statusPending'
                  : host.integration.state === 'failed' ? 'statusFailed'
                    : host.integration.state === 'inactive' ? 'statusInactive' : 'statusUnknown'
  const statusFailed = status === 'statusFailed' || status === 'statusSidecarFailed' || status === 'statusSidecarBlocked'
  return <section aria-label="上下文管理" className="dsh-context-settings">
    <style data-plugin={STYLE_OWNER} data-plugin-css={`${STYLE_OWNER}/settings`}>{css}</style><h2 className="cm-title">{t('title')}</h2>
    {!host && <p className="cm-intro" role="status">{t(status)}</p>}
    {host && <details className="cm-detail">
      <summary>
        <span className="cm-readiness" role={statusFailed ? 'alert' : 'status'}>{t(status)}</span>
        <span className="cm-disclosure-label">{t('technicalDetails')}</span>
      </summary>
      <dl className="cm-facts">
        <dt>{t('hostVersion')}</dt><dd>{host.hostRuntime?.state === 'available' && host.hostRuntime.version ? host.hostRuntime.version : t('hostVersionUnknown')}</dd>
        <dt>{t('hostCapability')}</dt><dd>{t(host.state === 'supported' ? 'capabilitySupported' : host.state === 'unsupported' ? 'capabilityUnsupported' : 'capabilityUnknown')}</dd>
        {host.version !== undefined && <><dt>{t('hostApiVersion')}</dt><dd>{host.version}</dd></>}
        <dt>{t('requestPath')}</dt><dd>{t(requestPath ? requestPathLabel(requestPath.path) : 'requestPathUnknown')} · {t(requestPath ? requestPathStateLabel(requestPath.state) : 'requestPathUnknownState')}</dd>
        <dt>{t('runtimeRegistration')}</dt><dd>{t(registrationOptional ? 'registrationNotRequired' : registrationStateLabel(host.integration.state))}</dd>
        <dt>{t('missingInterfaces')}</dt><dd className="cm-detail-interfaces">{host.state === 'unknown'
          ? t('interfacesNotChecked')
          : missingInterfaces.length
            ? <ul>{missingInterfaces.map(name => <li key={name}><code className="cm-interface">{name}</code></li>)}</ul>
            : t('noMissingInterfaces')}</dd>
      </dl>
      <p className="cm-intro">{t(hostReasonLabel(host.reasonCode))}{!host.reasonCode && <> {host.reason}</>}</p>
      {requestPath && <p className="cm-intro">{t('detailReason')}: {t(pathReasonLabel(requestPath.reasonCode))}
        {requestPath.reason && <> · <code>{requestPath.reason}</code></>}</p>}
      {host.integration.reason && host.integration.reason !== host.reason && !registrationOptional &&
        <p className="cm-intro">{t('detailReason')}: {host.integration.reason}</p>}
    </details>}
    <ContextSettings form={form} models={models} catalogUnavailable={catalogUnavailable} t={t} />
  </section>
}

function requestPathLabel(path: NonNullable<HostCapabilityReadout['requestPath']>['path']): SettingsLocaleKey {
  switch (path) {
    case 'host-registration': return 'requestPathHostRegistration'
    case 'request-gate-sidecar': return 'requestPathSidecar'
    case 'host-provider-unchanged': return 'requestPathHostUnchanged'
    default: return 'requestPathUnknown'
  }
}
function requestPathStateLabel(state: NonNullable<HostCapabilityReadout['requestPath']>['state']): SettingsLocaleKey {
  switch (state) {
    case 'ready': return 'requestPathReady'
    case 'pending': return 'requestPathPending'
    case 'blocked': return 'requestPathBlocked'
    case 'failed': return 'requestPathFailed'
    case 'inactive': return 'requestPathInactive'
    default: return 'requestPathUnknownState'
  }
}
function registrationStateLabel(state: HostCapabilityReadout['integration']['state']): SettingsLocaleKey {
  switch (state) {
    case 'registered': return 'registrationRegistered'
    case 'pending': return 'registrationPending'
    case 'failed': return 'registrationFailed'
    case 'inactive': return 'registrationInactive'
    default: return 'registrationUnknown'
  }
}
function hostReasonLabel(code: HostCapabilityReadout['reasonCode']): SettingsLocaleKey {
  switch (code) {
    case 'registry-unavailable': return 'apiReasonRegistryUnavailable'
    case 'registry-unreadable': return 'apiReasonRegistryUnreadable'
    case 'compaction-host-unreadable': return 'apiReasonHostUnreadable'
    case 'compaction-host-missing': return 'apiReasonHostMissing'
    case 'version-mismatch': return 'apiReasonVersionMismatch'
    case 'methods-missing': return 'apiReasonMethodsMissing'
    case 'supported': return 'apiReasonSupported'
    default: return 'apiReasonUnavailable'
  }
}
function pathReasonLabel(code: NonNullable<HostCapabilityReadout['requestPath']>['reasonCode']): SettingsLocaleKey {
  switch (code) {
    case 'host-provider-ready': return 'pathReasonHostReady'
    case 'host-provider-pending': return 'pathReasonHostPending'
    case 'host-provider-failed': return 'pathReasonHostFailed'
    case 'host-provider-inactive': return 'pathReasonHostInactive'
    case 'host-provider-unknown': return 'pathReasonHostUnknown'
    case 'sidecar-ready': return 'pathReasonSidecarReady'
    case 'sidecar-pending': return 'pathReasonSidecarPending'
    case 'sidecar-blocked': return 'pathReasonSidecarBlocked'
    case 'sidecar-failed': return 'pathReasonSidecarFailed'
    case 'sidecar-inactive': return 'pathReasonSidecarInactive'
    default: return 'pathReasonUnknown'
  }
}

const numericKeys = ['recentPercent', 'summaryPercent', 'repairPercent', 'triggerPercent', 'targetPercent', 'recentTokens', 'earlyPercent', 'safetyPercent', 'summaryMaxTokens', 'maxPasses', 'timeoutMs', 'summaryTotalMs', 'summaryFirstOutputMs', 'summaryStallMs', 'idleMinutes', 'formatRepairMaxTokens', 'absoluteTriggerTokens', 'absoluteTargetTokens', 'toolResultsMaxChars', 'toolResultsMinSavings', 'archiveReadBudget', 'archiveSearchLimit'] as const
type NumericKey = typeof numericKeys[number]
type Draft = Omit<Policy, NumericKey> & Record<NumericKey, string>
const routeKey = (provider: string, model: string) => JSON.stringify([provider, model])
function routeFromKey(key: string): { provider: string; model: string } | undefined {
  try {
    const value = JSON.parse(key)
    return Array.isArray(value) && value.length === 2 && value.every(item => typeof item === 'string' && item.length > 0)
      ? { provider: value[0], model: value[1] } : undefined
  } catch { return undefined }
}
function limitDrafts(policy: Policy): Record<string, string> {
  return Object.fromEntries((policy.modelLimits ?? []).map(item => [routeKey(item.provider, item.model), modelLimitDisplay(item.tokens)]))
}
function modelLimitDisplay(tokens: number): string {
  const whole = Math.floor(tokens / 1000)
  const fraction = String(tokens % 1000).padStart(3, '0').replace(/0+$/, '')
  return fraction ? `${whole}.${fraction}` : String(whole)
}
function modelLimitTokens(text: string): number | null {
  const value = text.trim()
  if (!value) return null
  const match = /^(\d+)(?:\.(\d{0,3}))?$/.exec(value)
  if (!match) return Number.NaN
  const whole = Number(match[1])
  if (!Number.isSafeInteger(whole) || whole > 1_000_000) return Number.NaN
  const fraction = Number((match[2] ?? '').padEnd(3, '0'))
  const tokens = whole * 1000 + fraction
  return Number.isSafeInteger(tokens) ? tokens : Number.NaN
}
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
  overridden: boolean; overriddenLabel: string; resetLabel: string; invalidLabel: string; numeric?: boolean; unit?: string; multiline?: boolean; inlineHint?: boolean
  copy?: ReactNode; className?: string
  choiceMenu?: ContextFieldMenu
  onEdit: (text: string) => void; onReset: () => void
}
type ContextSelectOption = { value: string; label: string; secondaryLabel?: string }
type ContextFieldMenu = { options: readonly ContextSelectOption[]; selectedId?: string; onSelect: (value: string) => void; triggerLabel: string }
function AnchoredOptions({ options, selectedId, disabled, onSelect, renderAnchor, menuClass, measureRef }: {
  options: readonly ContextSelectOption[]; selectedId?: string; disabled: boolean; onSelect: (value: string) => void
  renderAnchor: (toggle: () => void, triggerRef: { current: HTMLButtonElement | null }, open: boolean) => ReactNode; menuClass?: string
  measureRef?: { current: HTMLElement | null }
}) {
  const [open, setOpen] = useState(false)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const outsidePointer = useRef(false)
  const restoreFocus = useRef(false)
  useEffect(() => {
    if (disabled && open) { restoreFocus.current = false; setOpen(false) }
  }, [disabled, open])
  useLayoutEffect(() => {
    if (!open) return
    const currentMenu = () => [...document.querySelectorAll<HTMLElement>('[role="menu"]')]
      .filter(item => item.querySelector('.cm-context-menu-option')).at(-1) ?? null
    const syncWidth = () => {
      const panel = currentMenu()
      const anchor = measureRef?.current ?? triggerRef.current
      const width = anchor?.getBoundingClientRect().width ?? 0
      if (!panel || width <= 0) return
      const cssWidth = `${width}px`
      if (panel.style.width === cssWidth && panel.style.minWidth === cssWidth) return
      panel.style.width = cssWidth
      panel.style.minWidth = cssWidth
      panel.style.maxWidth = cssWidth
      panel.style.boxSizing = 'border-box'
      const view = document.defaultView
      if (view) view.dispatchEvent(new view.Event('resize'))
    }
    const view = document.defaultView
    syncWidth()
    view?.addEventListener('resize', syncWidth)
    return () => view?.removeEventListener('resize', syncWidth)
  }, [open, measureRef])
  useEffect(() => {
    if (!open) {
      if (restoreFocus.current) { triggerRef.current?.focus(); restoreFocus.current = false }
      return
    }
    const menu = () => [...document.querySelectorAll<HTMLElement>('[role="menu"]')]
      .filter(item => item.querySelector('.cm-context-menu-option')).at(-1) ?? null
    const pointerDown = (event: PointerEvent) => {
      const target = event.target as Node | null
      const element = target as (HTMLElement & { closest?: (selector: string) => Element | null }) | null
      outsidePointer.current = !(target && triggerRef.current?.contains(target)) && !element?.closest?.('[role="menu"]')
      Promise.resolve().then(() => { outsidePointer.current = false })
    }
    const keyDown = (event: KeyboardEvent) => {
      const list = menu()
      if (!list?.contains(document.activeElement)) return
      const entries = [...list.querySelectorAll<HTMLButtonElement>('[role="menuitem"]:not(:disabled)')]
      const current = entries.indexOf(document.activeElement as HTMLButtonElement)
      if (current < 0 || !entries.length) return
      let next = -1
      if (event.key === 'ArrowDown') next = (current + 1) % entries.length
      else if (event.key === 'ArrowUp') next = (current + entries.length - 1) % entries.length
      else if (event.key === 'Home') next = 0
      else if (event.key === 'End') next = entries.length - 1
      if (next >= 0) { event.preventDefault(); entries[next]?.focus() }
    }
    const first = menu()?.querySelector<HTMLButtonElement>('[role="menuitem"]:not(:disabled)')
    first?.focus()
    document.addEventListener('pointerdown', pointerDown, true)
    document.addEventListener('keydown', keyDown)
    return () => {
      document.removeEventListener('pointerdown', pointerDown, true)
      document.removeEventListener('keydown', keyDown)
    }
  }, [open])
  return <uiPrimitives.Menu open={open} anchor={renderAnchor(() => setOpen(value => !value), triggerRef, open)}
    items={options.map(option => ({ id: option.value, label: <span className="cm-context-menu-option">
      <span className="cm-context-menu-primary">{option.label}</span>
      {option.secondaryLabel && <span className="cm-context-menu-secondary">{option.secondaryLabel}</span>}
    </span> }))}
    selectedId={selectedId} onSelect={value => { if (disabled) { setOpen(false); return }; restoreFocus.current = true; setOpen(false); onSelect(value) }}
    onClose={() => { if (!outsidePointer.current) restoreFocus.current = true; setOpen(false) }}
    align="start" side="bottom" portal compact className={menuClass ?? 'cm-native-menu-root'}
    getAnchorRect={() => (measureRef?.current ?? triggerRef.current)?.getBoundingClientRect() ?? null}/>
}
function ContextHelp({ label, hint }: { label: string; hint: string }) {
  return <Tooltip label={hint} side="bottom"><span className="cm-native-help" tabIndex={0} role="note" aria-label={`${label}: ${hint}`}>?</span></Tooltip>
}
function ContextValueField({ id, label, hint, text, disabled, invalid, overridden, overriddenLabel, resetLabel, invalidLabel, numeric, unit, multiline, inlineHint = false, copy, className, choiceMenu, onEdit, onReset }: ContextValueFieldProps) {
  const inputWrapRef = useRef<HTMLDivElement>(null)
  return <div className={`cm-native-value${className ? ` ${className}` : ''}`}>
    <div className={`cm-native-copy${copy ? ' cm-model-limit-copy' : ''}`}>
      {copy ?? <><label htmlFor={id} className="cm-label">{label}</label>{!inlineHint && <ContextHelp label={label} hint={hint}/>}</>}
      {overridden && <Button type="button" className="cm-field-reset" size="sm" variant="ghost" disabled={disabled}
        aria-label={`${label} · ${overriddenLabel} · ${resetLabel}`} onClick={onReset}>{resetLabel}</Button>}
    </div>
    <div className="cm-native-value-control">
      {multiline
        ? <textarea id={id} value={text} disabled={disabled} aria-invalid={invalid || undefined} onChange={event => onEdit(event.currentTarget.value)}/>
        : <div ref={choiceMenu ? inputWrapRef : undefined} className={`cm-native-input-wrap${choiceMenu ? ' cm-native-input-wrap--menu' : ''}`} style={unit ? { '--cm-unit-padding': choiceMenu ? `calc(${unit.length + 3}ch + 26px)` : `${unit.length + 3}ch` } as CSSProperties : undefined}>
          <Input className="cm-native-input" id={id} type="text" inputMode={numeric ? 'decimal' : 'text'} value={text} disabled={disabled} aria-invalid={invalid || undefined} aria-describedby={unit ? `${id}-unit` : undefined} onChange={(event: ChangeEvent<HTMLInputElement>) => onEdit(event.currentTarget.value)}/>
          {unit && <span id={`${id}-unit`} className="cm-native-unit">{unit}</span>}
          {choiceMenu && <AnchoredOptions options={choiceMenu.options} selectedId={choiceMenu.selectedId} disabled={disabled} onSelect={choiceMenu.onSelect} menuClass="cm-native-input-menu-root" measureRef={inputWrapRef}
            renderAnchor={(toggle, triggerRef, open) => <button type="button" className="cm-native-input-menu" aria-label={choiceMenu.triggerLabel} aria-haspopup="menu" aria-expanded={open} disabled={disabled} ref={triggerRef} onClick={toggle}><span aria-hidden="true"/></button>}/>}
        </div>}
    </div>
    {inlineHint && <p className="cm-hint cm-native-inline-hint">{hint}</p>}
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
function ContextSelect({ id, label, hint, value, options, disabled, onChange, inlineHint = false, showHelp = true, compactModelLabel = false }: { id: string; label: string; hint?: string; value: string; options: readonly ContextSelectOption[]; disabled: boolean; onChange: (value: string) => void; inlineHint?: boolean; showHelp?: boolean; compactModelLabel?: boolean }) {
  const selected = options.find(option => option.value === value)
  return <div className="cm-native-select-row"><div className="cm-native-copy"><label htmlFor={id} className="cm-label">{label}</label>{!inlineHint && showHelp && hint && <ContextHelp label={label} hint={hint}/>}</div>
    <div className="cm-native-select"><AnchoredOptions options={options} selectedId={value} disabled={disabled} onSelect={onChange}
      renderAnchor={(toggle, triggerRef, open) => <button type="button" className={`cm-native-select-trigger${compactModelLabel ? ' cm-native-select-trigger--model' : ''}`} id={id} aria-label={`${label}: ${selected?.label ?? ''}`} aria-haspopup="menu" aria-expanded={open} disabled={disabled} ref={triggerRef} onClick={toggle}><span className="cm-native-choice-label">{selected?.label ?? ''}</span></button>}/></div>
    {inlineHint && <p className="cm-hint cm-native-inline-hint">{hint}</p>}
  </div>
}
function ContextDropdownField({ id, label, hint, displayValue, options, selectedId, disabled, inlineHint = false, showHelp = true, copy, className, onSelect }: {
  id: string; label: string; hint: string; displayValue: string; options: readonly ContextSelectOption[]; selectedId: string
  disabled: boolean; inlineHint?: boolean; showHelp?: boolean; copy?: ReactNode; className?: string; onSelect: (value: string) => void
}) {
  return <div className={`cm-native-value${className ? ` ${className}` : ''}`}>
    <div className={`cm-native-copy${copy ? ' cm-model-limit-copy' : ''}`}>{copy ?? <><label htmlFor={id} className="cm-label">{label}</label>{!inlineHint && showHelp && <ContextHelp label={label} hint={hint}/>}</>}</div>
    <div className="cm-native-value-control"><div className="cm-native-select"><AnchoredOptions options={options} selectedId={selectedId} disabled={disabled} onSelect={onSelect}
      renderAnchor={(toggle, triggerRef, open) => <button type="button" className="cm-native-select-trigger" id={id} aria-label={`${label}: ${displayValue}`} aria-haspopup="menu" aria-expanded={open} disabled={disabled} ref={triggerRef} onClick={toggle}><span className="cm-native-choice-label">{displayValue}</span></button>}/></div></div>
    {inlineHint && <p className="cm-hint cm-native-inline-hint">{hint}</p>}
  </div>
}

/** Context settings controls use the actual RC.2 UI primitives where available and scoped native controls for removed form atoms. */
export function ContextSettings({ form, models = [], catalogUnavailable = false, t = settingsText() }: { form: ConfigForm<Values>; models?: readonly ModelLimitOption[]; catalogUnavailable?: boolean; t?: SettingsText }) {
  const accepted = useSyncExternalStore(callback => form.subscribe(callback), () => form.getSnapshot())
  const acceptedPolicy = accepted.value?.policy ?? defaults
  const [draft, setDraft] = useState(() => toDraft(acceptedPolicy))
  const [modelDrafts, setModelDrafts] = useState(() => limitDrafts(acceptedPolicy))
  const [customNumericKeys, setCustomNumericKeys] = useState<Set<NumericKey>>(() => new Set())
  const [customModelKeys, setCustomModelKeys] = useState<Set<string>>(() => new Set())
  const [revision, setRevision] = useState(accepted.revision)
  const [dirty, setDirty] = useState(false)
  const [saving, setSaving] = useState(false)
  const [feedback, setFeedback] = useState('')
  const [failed, setFailed] = useState(false)
  const rootRef = useRef<HTMLElement>(null)
  useStableScrollbarGutter(rootRef)
  useEffect(() => {
    if (!dirty && accepted.value) {
      setDraft(toDraft(accepted.value.policy)); setModelDrafts(limitDrafts(accepted.value.policy)); setRevision(accepted.revision)
    }
  }, [accepted, dirty])
  const modelOptions = new Map<string, ModelLimitOption>()
  for (const item of models) modelOptions.set(routeKey(item.provider, item.model), item)
  for (const item of acceptedPolicy.modelLimits ?? []) {
    const key = routeKey(item.provider, item.model)
    if (!modelOptions.has(key)) modelOptions.set(key, { provider: item.provider, model: item.model, label: item.model, providerLabel: item.provider })
  }
  for (const key of Object.keys(modelDrafts)) {
    const route = routeFromKey(key)
    if (route && !modelOptions.has(key)) modelOptions.set(key, { ...route, label: route.model, providerLabel: route.provider })
  }
  const modelOptionList = [...modelOptions.entries()]
  function edit(update: Partial<Draft>) { setDraft(p => ({ ...p, ...update })); setDirty(true); setFeedback(''); setFailed(false) }
  const modelLimits = Object.entries(modelDrafts).flatMap(([key, text]) => {
    const route = routeFromKey(key)
    const tokens = modelLimitTokens(text)
    return route && tokens !== null ? [{ ...route, tokens }] : []
  })
  const policy: Policy = { ...toPolicy(draft), modelLimits }
  const modelLimitPresets = ['32', '64', '128', '200', '256', '300', '512', '1024']
  const invalidModelLimitDraft = Object.values(modelDrafts).some(text => {
    const tokens = modelLimitTokens(text)
    return tokens !== null && (!Number.isSafeInteger(tokens) || tokens < 10000 || tokens > 1000000000)
  })
  let invalid = invalidModelLimitDraft ? t('modelLimitInvalid') : ''
  if (!invalid) {
    try { validatePolicy(policy) } catch (error) { invalid = error instanceof Error ? error.message : String(error) }
  }
  if (!invalid && draft.summaryInstructions.length > 2000) invalid = t('instructionsTooLong')
  const disabled = !accepted.writable || saving || accepted.status !== 'ready'
  async function save() {
    if (disabled || !dirty || invalid) return
    setSaving(true); setFeedback(''); setFailed(false)
    try {
      const ok = await form.mutate([{ op: 'set', path: ['policy'], value: { ...policy, modelLimits: [...policy.modelLimits] } }], revision)
      if (ok) { setDirty(false); setFeedback(t('savedSettings')) }
      else { setFailed(true); setFeedback(t('conflictSettings')) }
    } catch (error) {
      setFailed(true); setFeedback(`${t('failedSettings')} · ${safeSaveReason(error, t)}`)
    }
    finally { setSaving(false) }
  }
  function reload() {
    setDirty(false); setFeedback(''); setFailed(false)
    const policy = accepted.value?.policy ?? defaults
    setDraft(toDraft(policy)); setModelDrafts(limitDrafts(policy)); setRevision(accepted.revision)
    setCustomNumericKeys(new Set()); setCustomModelKeys(new Set())
  }
  function restoreDefaults() {
    edit(toDraft(defaults)); setModelDrafts({}); setCustomNumericKeys(new Set()); setCustomModelKeys(new Set())
  }
  function editModelLimit(key: string, text: string) {
    setModelDrafts(current => ({ ...current, [key]: text }))
    setDirty(true); setFeedback(''); setFailed(false)
  }
  function chooseModelLimit(key: string, choice: string, text: string) {
    if (choice === '@custom') {
      setCustomModelKeys(current => new Set(current).add(key))
      return
    }
    setCustomModelKeys(current => { const next = new Set(current); next.delete(key); return next })
    if (choice === '@follow') {
      if (text !== '') editModelLimit(key, '')
      return
    }
    if (choice !== '@current' && choice !== text) editModelLimit(key, choice)
  }
  const numeric = (key: NumericKey, label: string, hint: string, unit = '', blocked = false) => {
    const id = `context-manager-${key}`
    const value = draft[key]
    const display = (text: string) => unit === '%' ? `${text}%` : `${text} ${unit}`
    const defaultsLabel = `${display(String(defaults[key]))} · ${t('recommendedValue')}`
    const presetEntries = key === 'triggerPercent'
      ? [{ value: '70', label: t('presetEarly') }, { value: '80', label: t('presetBalanced') }, { value: '85', label: t('presetLate') }]
      : key === 'idleMinutes'
        ? [5, 15, 30, 60, 120].map(minutes => ({ value: String(minutes), label: `${display(String(minutes))}${minutes === defaults.idleMinutes ? ` · ${t('recommendedValue')}` : ''}` }))
        : [{ value: String(defaults[key]), label: defaultsLabel }]
    const presetMap = new Map(presetEntries.map(option => [option.value, option]))
    if (!presetMap.has(value)) presetMap.set(value, { value, label: `${t('currentValue')} · ${display(value)}` })
    const options: ContextSelectOption[] = [...presetMap.values(), { value: '@custom', label: `${t('customValue')}…` }]
    const onChoice = (choice: string) => {
      if (choice === '@custom') {
        setCustomNumericKeys(current => new Set(current).add(key))
        return
      }
      setCustomNumericKeys(current => { const next = new Set(current); next.delete(key); return next })
      if (choice !== value) edit({ [key]: choice })
    }
    if (customNumericKeys.has(key)) return <ContextValueField key={key} id={id} label={label} hint={hint} numeric unit={unit} text={value}
      disabled={disabled || blocked} invalid={!Number.isFinite(policy[key])} overridden={false} overriddenLabel={t('customValue')} resetLabel={t('resetValue')} invalidLabel={t('invalidNumber')}
      choiceMenu={{ options, selectedId: '@custom', onSelect: onChoice, triggerLabel: `${label} · ${t('openOptions')}` }}
      onEdit={text => edit({ [key]: text })} onReset={() => {}}/>
    return <ContextDropdownField key={key} id={id} label={label} hint={hint} displayValue={display(value)} options={options}
      selectedId={value} disabled={disabled || blocked} onSelect={onChoice}/>
  }
  const toggle = (key: 'enabled' | 'idleEnabled' | 'formatRepairEnabled' | 'absoluteEnabled' | 'prefixDiagnosticsEnabled', label: string, hint: string, blocked = false, note?: string) =>
    <div className="cm-native-toggle">
      <div>
        <div className="cm-native-copy"><span className="cm-label">{label}</span><ContextHelp label={label} hint={hint}/></div>
        {note && <p className="cm-native-cost-note" role="note">{note}</p>}
      </div>
      <ContextSwitch label={label} checked={draft[key]} disabled={disabled || blocked} onChange={value => edit({ [key]: value })}/>
    </div>
  const automatic = policy.historyMode === 'automatic'
  return <section ref={rootRef} aria-label="上下文压缩设置" className="dsh-context-settings">
    <style data-plugin={STYLE_OWNER} data-plugin-css={`${STYLE_OWNER}/settings`}>{css}</style>
    <div className="cm-settings-form" aria-busy={saving}>
      {accepted.status !== 'ready' && <p className="cm-hint" role="status">{t('waitingSettings')}</p>}
      {accepted.status === 'ready' && !accepted.writable && <p className="cm-hint" role="status">{t('readonlySettings')}</p>}
      <fieldset disabled={disabled} className="cm-native-fields">
        <section className="cm-native-group">
          <h3>{t('compressionGroup')}</h3>
          {toggle('enabled', t('autoLabel'), t('autoHint'))}
          {numeric('triggerPercent', t('thresholdLabel'), t('thresholdHint'), '%')}
          <ContextSelect id="context-manager-historyMode" label={t('historyGroup')} hint={automatic ? t('historyAutomaticHint') : t('historyCustomHint')}
            value={draft.historyMode} disabled={disabled || !draft.enabled} onChange={value => edit({ historyMode: value as Policy['historyMode'] })}
            options={[{ value: 'automatic', label: t('historyAutomatic') }, { value: 'custom', label: t('historyCustom') }]}/>
          {!automatic && numeric('targetPercent', t('targetLabel'), t('targetHint'), '%', !draft.enabled)}
          {draft.capacityMode !== 'percent' && <div className="cm-native-legacy" role="status"><span>{t('legacyConfigNote')}</span><Button size="sm" disabled={disabled} onClick={() => edit({ capacityMode: 'percent' })}>{t('switchPercent')}</Button><p className="cm-hint">{t('capacitySavedNote')}</p></div>}
          <ContextSelect id="context-manager-toolResultsMode" label={t('toolGroup')} hint={t('toolResultsHint')} value={draft.toolResultsMode}
            disabled={disabled || !draft.enabled} onChange={value => edit({ toolResultsMode: value as Policy['toolResultsMode'] })}
            options={[{ value: 'off', label: t('toolOff') }, { value: 'observe', label: t('toolObserve') }, { value: 'reduce', label: t('toolReduce') }]}/>
        </section>
        <section className="cm-native-group">
          <h3>{t('modelLimitGroup')}</h3>
          {catalogUnavailable && <p className="cm-hint" role="status">{t('modelCatalogUnavailable')}</p>}
          {!modelOptionList.length && <p className="cm-hint" role="status">{t('modelCatalogEmpty')}</p>}
          {modelOptionList.map(([key, item]) => {
            const text = modelDrafts[key] ?? ''
            const provider = item.providerLabel ?? item.provider
            const rowLabel = `${t('modelLimitLabel')} · ${item.label} · ${provider}`
            const id = `context-manager-modelLimit-${encodeURIComponent(key)}`
            const tokens = modelLimitTokens(text)
            const limitInvalid = tokens !== null && (!Number.isSafeInteger(tokens) || tokens < 10000 || tokens > 1000000000)
            const hasPreset = modelLimitPresets.includes(text.trim())
            const options: ContextSelectOption[] = [
              { value: '@follow', label: t('followModelCapacity') },
              ...(!text.trim() || hasPreset ? [] : [{ value: '@current', label: `${t('currentValue')} · ${text}K` }]),
              ...modelLimitPresets.map(value => ({ value, label: `${value}K` })),
              { value: '@custom', label: `${t('customValue')}…` },
            ]
            const selectedId = customModelKeys.has(key) ? '@custom' : !text.trim() ? '@follow' : hasPreset ? text.trim() : '@current'
            const copy = <label htmlFor={id} className="cm-label"><span>{item.label}</span><span className="cm-model-limit-provider">{provider}</span></label>
            return customModelKeys.has(key)
              ? <ContextValueField key={key} id={id} className="cm-model-limit-row" copy={copy} label={rowLabel} hint={t('modelLimitHint')}
                text={text} disabled={disabled} invalid={limitInvalid} numeric unit={t('unitK')} inlineHint
                overridden={false} overriddenLabel={t('customValue')} resetLabel={t('clear')} invalidLabel={t('modelLimitInvalid')}
                choiceMenu={{ options, selectedId: '@custom', onSelect: choice => chooseModelLimit(key, choice, text), triggerLabel: `${rowLabel} · ${t('openOptions')}` }}
                onEdit={value => editModelLimit(key, value)} onReset={() => {}}/>
              : <ContextDropdownField key={key} id={id} className="cm-model-limit-row" copy={copy} label={rowLabel} hint={t('modelLimitHint')}
                displayValue={text.trim() ? `${text}K` : t('followModelCapacity')} options={options} selectedId={selectedId}
                disabled={disabled} showHelp={false} onSelect={choice => chooseModelLimit(key, choice, text)}/>
          })}
        </section>
        <section className="cm-native-group">
          <h3>{t('idleGroup')}</h3>
          {toggle('idleEnabled', t('idleLabel'), t('idleHint'), !draft.enabled, draft.idleEnabled ? t('idleCostNote') : undefined)}
          {numeric('idleMinutes', t('idleMinutesLabel'), t('idleMinutesHint'), t('unitMinutes'), !draft.enabled || !draft.idleEnabled)}
        </section>
        <details className="cm-native-advanced"><summary>{t('advanced')}</summary>
          {toggle('prefixDiagnosticsEnabled', t('prefixLabel'), t('prefixHint'), !draft.enabled)}
          {draft.capacityMode === 'percent' && numeric('recentPercent', t('recentPercentLabel'), t('recentPercentHint'), '%', !draft.enabled)}
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
        {invalid && <p role="alert" className="cm-error">{invalid.replace('triggerPercent', t('thresholdLabel'))}</p>}
      </fieldset>
      {feedback && <p role={failed ? 'alert' : 'status'} className={failed ? 'cm-error cm-feedback' : 'cm-hint cm-feedback'}>{feedback}</p>}
      <div className="cm-native-save">
        <Button size="sm" disabled={!dirty || disabled} onClick={reload}>{t('cancelChanges')}</Button>
        <Button size="sm" disabled={disabled} onClick={restoreDefaults}>{t('restoreDefaults')}</Button>
        <Button type="button" size="sm" variant="primary" disabled={disabled || !dirty || !!invalid} onClick={() => { void save() }}>{saving ? t('saving') : t('save')}</Button>
      </div>
    </div>
  </section>
}
