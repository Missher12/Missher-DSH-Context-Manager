import { formatPercent, capacityTokens } from './policy.ts'
/** A read-only, single-page context view registered after the native trajectory. */
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore, type ChangeEvent } from 'react'
import { Button, Input, StateDot, Tooltip } from '@deepseek-ai/dsh-client-ui-primitives'
import type { ConfigForm } from '@deepseek-ai/dsh-client-ui-settings/client'
import type { Policy } from './policy.ts'
import { categories, defaultQuery, type Category, type ContentPage, type ContentRow, type Inspection, type InspectorApi, type InspectQuery, type RequestRow } from './inspector-types.ts'
import { CompactionRecords, UsageDetails, CompactionChart, ContextComposition, PressureTrend, UsageComposition, contextWindow, formatTokens, exactTokens, formatTime } from './inspector-charts.tsx'
import { inspectorText, type InspectorLocaleKey, type InspectorText } from './inspector-locales.ts'
import { createRunDiagnostics, type IdleFreshness } from './run-diagnostics.ts'
import { useReadonlyView } from './readonly-view.ts'
import type { CompactCapacity, IdleStatus } from './idle-types.ts'
import type { CompactionReadout, ContextCooperationReadout } from './compatibility.ts'
import { admissionBudget, type ContextGroup } from './chart-data.ts'
import css from './inspector.css'

export interface ContextViewInjected {
  target: string
  form: ConfigForm<{ policy: Policy }>
  api: InspectorApi
  pulse: { subscribe(callback: () => void): () => void; getSnapshot(): unknown }
  locale?: string
}
const errorText = (error: unknown, t: InspectorText) => error instanceof Error ? error.message : t('error')
function Loading() { return <div className="cmv-empty"><StateDot state="ongoing"/></div> }
function compressionLabel(mode: NonNullable<Inspection['compression']>['mode']): InspectorLocaleKey {
  switch (mode) {
    case 'enhanced': return 'enhancedCurrent'
    case 'native': return 'nativeOnly'
    case 'other': return 'otherProvider'
    case 'unconfigured': return 'unconfigured'
    case 'unavailable': return 'unavailable'
    default: return 'unknownBinding'
  }
}
function requestPressureLabel(state: ContextCooperationReadout['requestPressure']): InspectorLocaleKey {
  switch (state) {
    case 'context': return 'coopPressureContext'
    case 'native': return 'coopPressureNative'
    case 'off': return 'coopPressureOff'
    case 'waiting': return 'coopPressureWaiting'
    case 'unsupported': return 'coopPressureUnsupported'
    default: return 'coopPressureUnknown'
  }
}

type BindingSnapshot = { target: string; state: 'loading' | 'ready' | 'missing' | 'failed'; value: CompactionReadout | null }
type BindingBadge = { mode: CompactionReadout['mode']; text: string; title: string }
type IdleDiagnosticValue = Omit<IdleStatus, 'recovery'> & { recovery?: Pick<NonNullable<IdleStatus['recovery']>, 'available' | 'message' | 'riskAcceptanceRequired'> }
type IdleDiagnostic = { target: string; value: IdleDiagnosticValue | null; freshness: IdleFreshness; signature: string }
function bindingsDisagree(left: CompactionReadout, right: CompactionReadout): boolean {
  if (left.mode !== right.mode || left.hostCapability !== right.hostCapability) return true
  return (['agentPreset', 'generation', 'provider', 'source'] as const).some(key => left[key] !== undefined && right[key] !== undefined && left[key] !== right[key])
}
function hasNativeSidecar(value: ContextCooperationReadout | undefined): boolean {
  return value !== undefined && (value.toolResults.state === 'active' || value.toolResults.state === 'observe'
    || value.toolResults.state === 'waiting' || value.originals.state === 'ready'
    || value.idleMaintenance === 'active' || value.idleMaintenance === 'waiting'
    || value.requestPressure === 'context' || value.requestPressure === 'waiting')
}
function bindingBadge(data: Inspection | null, idle: BindingSnapshot | null, target: string, historical: boolean, stale: boolean, failed: boolean, t: InspectorText): BindingBadge {
  if (historical) {
    const binding = data?.compression
    const label = binding?.mode === 'enhanced' ? t('enhancedHistorical') : binding ? t(compressionLabel(binding.mode)) : t('unknownBinding')
    return { mode: binding?.mode ?? 'unknown', text: t('historical'), title: binding ? label : t('unknownBinding') }
  }
  if (stale) {
    const message = t(failed ? 'statusRefreshFailed' : 'statusRefreshing')
    return { mode: 'unknown', text: message, title: message }
  }
  const currentIdle = idle?.target === target ? idle : null
  if (!currentIdle || currentIdle.state === 'loading') {
    return { mode: 'unknown', text: t('statusRefreshing'), title: t('statusRefreshing') }
  }
  if (currentIdle.state === 'failed') {
    return { mode: 'unknown', text: t('statusRefreshFailed'), title: t('statusRefreshFailed') }
  }
  if (currentIdle.state === 'missing' || !currentIdle.value) {
    return { mode: 'unknown', text: t('statusMissing'), title: t('statusMissing') }
  }
  const idleValue = currentIdle.value
  const inspected = data?.compression ?? null
  if (inspected && idleValue && bindingsDisagree(inspected, idleValue)) {
    return { mode: 'unknown', text: t('statusConflict'), title: t('statusConflict') }
  }
  const binding = inspected ?? idleValue
  if (!binding) return { mode: 'unknown', text: t('statusMissing'), title: t('statusMissing') }
  const cooperating = binding.mode === 'native' && hasNativeSidecar(data?.cooperation)
  const short = binding.mode === 'enhanced' ? 'statusEnhanced'
    : binding.mode === 'native' ? 'statusNative'
      : binding.mode === 'other' ? 'statusOther'
        : binding.mode === 'unconfigured' ? 'statusUnconfigured'
          : binding.mode === 'unavailable' ? 'statusUnavailable' : 'statusUnknown'
  return { mode: binding.mode, text: t(short), title: t(cooperating ? 'nativeCooperating' : short) }
}
function capabilityWarnings(value: ContextCooperationReadout, t: InspectorText): string[] {
  const warnings: string[] = []
  if (value.toolResults.state === 'unsupported') warnings.push(t('capToolUnsupported'))
  if (value.originals.state === 'unavailable') warnings.push(t('capOriginalsUnavailable'))
  if (value.idleMaintenance === 'unsupported') warnings.push(t('capIdleUnsupported'))
  if (value.requestPressure === 'unsupported') warnings.push(t('capPressureUnsupported'))
  if (value.requestPressure === 'unknown') warnings.push(t('capPressureUnknown'))
  return warnings
}
function requestWindow(data: Inspection, request: RequestRow | undefined): number | null {
  if (!request) return null
  const reply = data.pressureHistory?.find(point => point.kind === 'reply' && point.seq === request.seq && point.time === request.time)
  return reply && typeof reply.window === 'number' && Number.isFinite(reply.window) && reply.window > 0 ? reply.window : null
}

function idleStatusLabel(value: IdleStatus | IdleDiagnosticValue): InspectorLocaleKey {
  if (value.status === 'off') {
    return value.owner === 'context-manager' && value.compression?.mode === 'enhanced' && value.message === '闲置自动压缩已关闭'
      ? 'idleOff' : 'idleNotEnabled'
  }
  switch (value.status) {
    case 'waiting': return 'idleWait'
    case 'scheduled': return 'idleScheduled'
    case 'checking': return 'idleChecking'
    case 'compacting': return 'idleCompacting'
    case 'completed': return 'idleCompleted'
    case 'skipped': return 'idleSkipped'
    case 'cancelled': return 'idleCancelled'
    case 'failed': return 'idleFailed'
  }
}

function diagnosticValue(value: IdleStatus): IdleDiagnosticValue {
  const { recovery, ...rest } = value
  return { ...rest, recovery: recovery ? { available: recovery.available, message: recovery.message, riskAcceptanceRequired: recovery.riskAcceptanceRequired } : undefined }
}

function IdleStatusLine({ target, api, revision, settingsRevision, retry, t, onCapacity, onBinding, onDiagnostic }: { target: string; api: InspectorApi; revision: unknown; settingsRevision: number | undefined; retry: number; t: InspectorText; onCapacity: (value: CompactCapacity | null) => void; onBinding: (value: BindingSnapshot) => void; onDiagnostic: (value: Omit<IdleDiagnostic, 'signature'>) => void }) {
  const [state, setState] = useState<{ target: string; value: IdleStatus } | null>(null)
  const [error, setError] = useState('')
  const [recovering, setRecovering] = useState(false)
  const [recoveryResult, setRecoveryResult] = useState('')
  const [emergencyPlan,setEmergencyPlan]=useState<{token:string;expiresAt:number;cycle:number;warning:string;model:string;deadline:string;estimatedInput:number}|null>(null)
  const action = useRef<AbortController | null>(null)
  const currentCompressionMode = useRef<string>('unknown')
  const emergencyEpoch = useRef(0)
  const lastStatus = useRef<{ target: string; value: IdleStatus } | null>(null)
  const lastBinding = useRef<{ target: string; signature: string }>({ target: '', signature: '' })
  const lastCapacity = useRef<{ target: string; signature: string }>({ target: '', signature: '' })
  const reportBinding = useCallback((snapshot: BindingSnapshot) => {
    const signature = JSON.stringify([snapshot.state, snapshot.value])
    if (lastBinding.current.target !== target || lastBinding.current.signature !== signature) {
      lastBinding.current = { target, signature }
      onBinding(snapshot)
    }
  }, [onBinding, target])
  useEffect(() => { currentCompressionMode.current = 'unknown'; emergencyEpoch.current++; lastStatus.current = null; setEmergencyPlan(null); setRecovering(false); setRecoveryResult(''); setError(''); return () => { action.current?.abort() } }, [target])
  useEffect(() => {
    const abort = new AbortController()
    let timer: ReturnType<typeof setTimeout> | undefined
    async function read() {
      const retainedAtStart = lastStatus.current?.target === target ? lastStatus.current.value : null
      onDiagnostic({ target, value: retainedAtStart ? diagnosticValue(retainedAtStart) : null, freshness: retainedAtStart ? 'refreshing' : 'unknown' })
      if (lastBinding.current.target !== target || !lastBinding.current.signature) {
        reportBinding({ target, state: 'loading', value: null })
      }
      try {
        const value = await api.idleStatus({ sessionId: target }, abort.signal)
        if (abort.signal.aborted) return
        setState({ target, value }); lastStatus.current = { target, value }; setError('')
        reportBinding({ target, state: value.compression ? 'ready' : 'missing', value: value.compression ?? null })
        onDiagnostic({ target, value: diagnosticValue(value), freshness: 'current' })
        currentCompressionMode.current = value.compression?.mode ?? 'unknown'
        if (currentCompressionMode.current !== 'enhanced') { emergencyEpoch.current++; setEmergencyPlan(null) }
        timer = setTimeout(() => { void read() }, value.status === 'compacting' ? 1000 : 5000)
      } catch (reason) {
        // A cancelled view owns no status update or follow-up timer.
        if (!abort.signal.aborted) {
          const message = errorText(reason, t)
          reportBinding({ target, state: 'failed', value: null })
          const retained = lastStatus.current?.target === target ? lastStatus.current.value : null
          onDiagnostic({ target, value: retained ? diagnosticValue(retained) : null, freshness: retained ? 'stale' : 'unknown' })
          lastCapacity.current = { target, signature: 'null' }
          onCapacity(null)
          currentCompressionMode.current = 'unknown'; emergencyEpoch.current++
          action.current?.abort(); action.current = null
          setRecovering(false); setRecoveryResult(''); setEmergencyPlan(null)
          setError(message)
          timer = setTimeout(() => { void read() }, 5000)
        }
      }
    }
    void read()
    return () => { abort.abort(); clearTimeout(timer) }
  }, [target, api, revision, settingsRevision, retry, onCapacity, reportBinding, onDiagnostic, t])
  const value = state?.target === target ? state.value : null
  useEffect(() => {
    const capacity = value?.capacity ?? null
    const signature = JSON.stringify(capacity)
    if (lastCapacity.current.target !== target || lastCapacity.current.signature !== signature) {
      lastCapacity.current = { target, signature }
      onCapacity(capacity)
    }
  }, [onCapacity, target, value])
  const message = !error && value?.status === 'scheduled' && value.dueAt !== null && !/background|busy/u.test(value.reasonCode ?? '')
    ? `${value.restored ? `${t('restored')} · ` : ''}${Math.max(0, Math.ceil((value.dueAt - Date.now()) / 60000))} ${t('minutes')}` : ''
  const recover = async () => {
    if (!value?.recovery?.authorizationToken || !api.authorizeOnce || recovering) return
    const controller = new AbortController(); action.current = controller
    setRecovering(true); setRecoveryResult('')
    try {
      await api.authorizeOnce({ sessionId: target, authorizationToken: value.recovery.authorizationToken }, controller.signal)
      if (!controller.signal.aborted) setRecoveryResult(t('recoveryDone'))
    } catch (reason) { if (!controller.signal.aborted) setRecoveryResult(errorText(reason, t)) }
    finally { if (!controller.signal.aborted) setRecovering(false) }
  }
  const emergency = async (confirm:boolean) => {
    if(recovering || !api.prepareEmergency || !api.executeEmergency)return
    const controller=new AbortController();action.current=controller;setRecovering(true);setRecoveryResult('')
    try {
      if(confirm && emergencyPlan) {
        const plan=emergencyPlan;setEmergencyPlan(null)
        const modeAtStart = currentCompressionMode.current
        const epochAtStart = emergencyEpoch.current
        const current = await api.idleStatus({ sessionId: target }, controller.signal)
        if (controller.signal.aborted || action.current !== controller
          || modeAtStart !== 'enhanced' || currentCompressionMode.current !== 'enhanced'
          || emergencyEpoch.current !== epochAtStart) return
        setState({ target, value: current }); lastStatus.current = { target, value: current }; setError('')
        reportBinding({ target, state: current.compression ? 'ready' : 'missing', value: current.compression ?? null })
        onDiagnostic({ target, value: diagnosticValue(current), freshness: 'current' })
        currentCompressionMode.current = current.compression?.mode ?? 'unknown'
        if (currentCompressionMode.current !== 'enhanced') { emergencyEpoch.current++; return }
        await api.executeEmergency({sessionId:target,token:plan.token,acceptUnknownCost:true},controller.signal)
        if(!controller.signal.aborted)setRecoveryResult('人工急救压缩完成；原任务未自动重放')
      }else{
        const modeAtStart = currentCompressionMode.current
        const epochAtStart = emergencyEpoch.current
        const plan=await api.prepareEmergency({sessionId:target},controller.signal)
        if(!controller.signal.aborted) setEmergencyPlan(modeAtStart === 'enhanced' && currentCompressionMode.current === 'enhanced' && epochAtStart === emergencyEpoch.current ? plan : null)
      }
    }catch(reason){if(!controller.signal.aborted){setEmergencyPlan(null);setRecoveryResult(errorText(reason,t))}}
    finally{if(!controller.signal.aborted)setRecovering(false)}
  }
  const shortStatus = error ? value ? `${t('lastRead')} · ${t(idleStatusLabel(value))}` : t('idleUnknown') : value ? t(idleStatusLabel(value)) : t('idleWait')
  return <span role="status" aria-label={t('idle')}>{t('idle')} · {shortStatus}{message && <> · {message}</>}
    {!error && value?.recovery?.available && api.authorizeOnce && <Button size="sm" disabled={recovering} onClick={() => { void recover() }}>{value.recovery.riskAcceptanceRequired ? t('riskRecoveryButton') : t('recoveryButton')}</Button>}
    {!error && value?.emergency?.eligible && api.prepareEmergency && !emergencyPlan && <Button size="sm" disabled={recovering} onClick={()=>{void emergency(false)}}>{t('emergencyCheck')}</Button>}
    {emergencyPlan && <><span> · {t('emergencyBatch')} {emergencyPlan.cycle} · {emergencyPlan.model} · {emergencyPlan.deadline} · {t('emergencyInput')} {emergencyPlan.estimatedInput} {t('tokens')} · {emergencyPlan.warning} {t('authorizationExpires')}</span><Button size="sm" disabled={recovering || emergencyPlan.expiresAt<=Date.now()} onClick={()=>{void emergency(true)}}>{t('emergencyConfirm')}</Button><Button size="sm" disabled={recovering} onClick={()=>setEmergencyPlan(null)}>{t('emergencyCancel')}</Button></>}
    {recoveryResult && <> · {recoveryResult}</>}
  </span>
}

function RequestStatus({ data, policy, stale, bindingMode, t }: { data: Inspection; policy: Policy | undefined; stale: boolean; bindingMode: CompactionReadout['mode']; t: InspectorText }) {
  const reading = stale || data.historical ? undefined : data.admission
  const mode = stale ? 'unknown' : bindingMode
  const contextSidecar = mode === 'native' && data.cooperation?.requestPressure === 'context'
  const contextGate = mode === 'enhanced' || contextSidecar
  const gate = !stale && contextGate ? admissionBudget(data, policy) : undefined
  const bindingUnconfirmed = mode === 'unknown' || mode === 'unavailable'
  const status = stale ? 'stale' : data.historical ? 'historical' : bindingUnconfirmed ? 'unknown'
    : !contextGate || (policy && !policy.enabled) ? 'requestGateOff' : !gate || !reading ? 'unknown' : reading.tokens >= gate.admission ? 'compactFirst' : 'continue'
  const source = gate ? gate.admissionSource === 'absolute' ? t('gateAbsolute') : gate.admissionSource === 'hard' ? t('gateHard') : t('gatePercent') : ''
  const effectiveCapacity = policy && gate ? capacityTokens(policy,gate.window) : null
  const recent = data.requests.at(-1)
  const recentWindow = requestWindow(data, recent)
  const recentInput = !recent ? '—' : recent.input == null ? t('unknownUsage') : `${formatTokens(recent.input)} ${t('tokens')}`
  const recentRatio = !recent ? t('noRequest') : recent.input == null ? t('unknownUsage') : formatPercent(recent.input, recentWindow)
  const hit = recent?.input != null && recent.input > 0 && recent.cacheRead !== null ? recent.cacheRead / recent.input * 100 : null
  return <div className="cmv-card cmv-quick"><div><div className="cmv-request-title"><h3>{t('next')}</h3><div className="cmv-status">{status === 'compactFirst' ? <StateDot state="warning"/> : status === 'continue' ? <StateDot state="done"/> : null}{t(status)}</div></div><Tooltip label={contextGate ? t('admissionHint') : t('bindingHint')}><span tabIndex={0} className="cmv-muted" data-admission-tokens={reading?.tokens} data-context-request-gate={contextSidecar && gate ? 'active' : undefined}>{t('admissionPressure')} {reading ? `≈ ${formatTokens(reading.tokens)} ${t('tokens')} · ${formatPercent(reading.tokens,reading.window)}` : t('growthUnknown')} / {t('gate')} {formatPercent(gate?.admission,gate?.window)}{gate ? ` · ${source}` : ''}{effectiveCapacity && gate ? ` · ${t('recentBudget')} ${formatPercent(effectiveCapacity.recent,gate.window)} · ${t('summary')} ${formatPercent(Math.min(effectiveCapacity.summary,Math.floor(gate.window*0.1),data.model?.maxTokens??Infinity),gate.window)}` : ''}</span></Tooltip></div>
    <div><h3>{t('recent')}</h3><div className="cmv-request-values"><strong>{recentInput}</strong><span className="cmv-muted cmv-request-detail">{recent ? `${t('requestInputDetail')} · ${recentRatio}` : t('noRequest')}</span></div></div>
    <div><h3>{t('cache')}</h3><div className="cmv-request-values"><strong>{hit === null ? '—' : `${Math.round(hit)}%`}</strong></div></div>
  </div>
}

type ContentDetailProps = { target: string; cutSeq: number; row: ContentRow; api: InspectorApi; t: InspectorText; window:number|null }
function ContentDetail(props: ContentDetailProps) {
  const [trail, setTrail] = useState<ContentRow[]>([])
  const row = trail.at(-1) ?? props.row
  return <article className="cmv-reader">
    {trail.length > 0 && <Button size="sm" variant="ghost" onClick={() => setTrail(value => value.slice(0, -1))}>{props.t('backToSummary')}</Button>}
    <ContentReader key={row.id} {...props} row={row} onSource={source => setTrail(value => [...value, source])}/>
  </article>
}

function ContentReader({ target, cutSeq, row, api, t, window, onSource }: ContentDetailProps & { onSource: (row: ContentRow) => void }) {
  const [offsets, setOffsets] = useState([0])
  const [sourceOffset, setSourceOffset] = useState(0)
  const [page, setPage] = useState<ContentPage | null>(null)
  const [error, setError] = useState('')
  const [retry, setRetry] = useState(0)
  const offset = offsets.at(-1)!
  useEffect(() => {
    const controller = new AbortController()
    setPage(null); setError('')
    void api.content({ sessionId: target, cutSeq, id: row.id, offset, ...(row.category === 'summary' ? { sourceOffset } : {}) }, controller.signal).then(value => {
      if (!controller.signal.aborted && value.sessionId === target && value.cutSeq === cutSeq && value.id === row.id && value.offset === offset && (!value.sources || value.sources.offset === sourceOffset)) setPage(value)
    }).catch(reason => { if (!controller.signal.aborted) setError(errorText(reason, t)) })
    return () => controller.abort()
  }, [api, target, cutSeq, row.id, row.category, offset, sourceOffset, retry, t])
  return <><div className="cmv-heading"><h3>{row.title}</h3><span className="cmv-muted">≈ {formatTokens(row.tokens)} {t('tokens')} · {formatPercent(row.tokens,window)}</span></div><div className="cmv-muted cmv-reader-meta">{t(row.category)} · {t('record')} {row.seq}{row.current ? '' : ` · ${t('replaced')}`}{row.images ? ` · ${row.images} ${t('images')}` : ''}</div><div className="cmv-muted cmv-source">{row.source}</div>
    {error ? <div role="alert"><p>{error}</p><Button size="sm" onClick={() => setRetry(retry + 1)}>{t('retry')}</Button></div> : !page ? <Loading/> : <><pre className="cmi-body" tabIndex={0}>{page.text || t('noText')}</pre>{(offset > 0 || page.nextOffset !== null) && <div className="cmv-pagination"><Button size="sm" disabled={offsets.length === 1} onClick={() => setOffsets(value => value.slice(0, -1))}>{t('previousText')}</Button><span>{t('characters')} {exactTokens(offset + 1)}–{exactTokens(offset + page.text.length)} / {exactTokens(page.totalChars)}</span><Button size="sm" disabled={page.nextOffset === null} onClick={() => { if (page.nextOffset !== null) setOffsets(value => [...value, page.nextOffset!]) }}>{t('nextText')}</Button></div>}</>}
    {row.category === 'summary' && page && <section className="cmv-summary-source" aria-label={t('sourceOriginals')}><h3>{t('sourceOriginals')}</h3><p className="cmv-muted">{t('sourceHint')}</p>
      {page.sources?.rows.length ? <><div className="cmi-content-list">{page.sources.rows.map(source => <button type="button" key={source.id} onClick={() => onSource(source)}><span className="cmv-row-title"><strong>{source.title}</strong></span><span className="cmv-muted">{t('record')} {source.seq} · {t(source.category)}</span></button>)}</div>
        {(sourceOffset > 0 || page.sources.nextOffset !== null) && <div className="cmv-pagination"><Button size="sm" disabled={sourceOffset === 0} onClick={() => setSourceOffset(value => Math.max(0, value - 4))}>{t('previousSources')}</Button><span>{sourceOffset + 1}–{sourceOffset + page.sources.rows.length} / {exactTokens(page.sources.total)}</span><Button size="sm" disabled={page.sources.nextOffset === null} onClick={() => { if (page.sources?.nextOffset != null) setSourceOffset(page.sources.nextOffset) }}>{t('nextSources')}</Button></div>}</>
        : <p className="cmv-muted">{t('noSources')}</p>}
    </section>}
  </>
}

function ContentBrowser({ data, query, change, api, target, loading, t, initialSelected }: { data: Inspection; initialSelected?: string; query: InspectQuery; change: (patch: Partial<InspectQuery>) => void; api: InspectorApi; target: string; loading: boolean; t: InspectorText }) {
  const [selected, setSelected] = useState(initialSelected ?? '')
  const [shown, setShown] = useState(4)
  const row = data.rows.slice(0, shown).find(item => item.id === selected) ?? data.rows[0]
  const grouped = query.group === 'message' || query.group === 'instruction'
  const filter = grouped ? `group:${query.group}` : query.group ?? query.category
  return <div><div className="cmv-content-tools"><Input aria-label={t('search')} placeholder={t('search')} value={query.search} onChange={(event: ChangeEvent<HTMLInputElement>) => change({ search: event.target.value.slice(0, 200) })}/><select aria-label={t('types')} value={filter} onChange={event => { const value = event.target.value; change(value.startsWith('group:') ? { group: value.slice(6) as ContextGroup, category: 'all' } : { group: undefined, category: value as Category | 'all' }) }}><option value="all">{t('all')}</option>{grouped && query.group && <option value={`group:${query.group}`}>{t(query.group)}</option>}{categories.map(item => <option key={item.id} value={item.id}>{t(item.id)}</option>)}</select><select aria-label={t('sort')} value={query.sort} onChange={event => change({ sort: event.target.value as InspectQuery['sort'] })}><option value="size">{t('size')}</option><option value="position">{t('position')}</option></select></div>
    <div className="cmv-content-layout"><div className="cmi-content-list" aria-label={t('content')}>{data.rows.slice(0, shown).map(item => <button type="button" key={item.id} aria-pressed={row?.id === item.id} onClick={() => setSelected(item.id)}><span className="cmv-row-title"><i data-category={item.category}/><strong>{item.title}</strong><b>{formatTokens(item.tokens)} <small>{t('tokens')} · {formatPercent(item.tokens,contextWindow(data))}</small></b></span><span className="cmv-muted">{t(item.category)}{item.current ? '' : ` · ${t('replaced')}`}</span></button>)}{!data.rows.length && <div className="cmv-empty">{t('emptyContents')}</div>}{shown < data.rows.length && <Button size="sm" variant="ghost" onClick={() => setShown(value => value + 4)}>{t('more')}</Button>}</div>{row ? <ContentDetail key={`${target}:${data.cutSeq}:${row.id}`} target={target} cutSeq={data.cutSeq} row={row} api={api} t={t} window={contextWindow(data)}/> : <div className="cmv-empty">{t('selectContent')}</div>}</div>
    <div className="cmv-content-footer"><label className="cmv-checkbox"><input type="checkbox" checked={query.archived} onChange={event => change({ archived: event.currentTarget.checked })}/><span>{t('archived')}</span></label><div className="cmv-pagination"><Button size="sm" disabled={loading || data.offset === 0} onClick={() => change({ offset: Math.max(0, data.offset - data.pageSize) })}>{t('previous')}</Button><span>{data.total ? data.offset + 1 : 0}–{Math.min(data.offset + Math.min(shown, data.rows.length), data.total)} / {exactTokens(data.total)}</span><Button size="sm" disabled={loading || data.offset + data.pageSize >= data.total} onClick={() => change({ offset: data.offset + data.pageSize })}>{t('nextPage')}</Button></div></div>
  </div>
}

/** Mount only for the selected session; release requests, timers and composer overrides on exit. */
export function ContextInspectorView({ target, form, api, pulse, locale = 'zh' }: ContextViewInjected) {
  const t = useMemo(() => inspectorText(locale), [locale])
  const viewRef = useReadonlyView(target)
  const contentRef = useRef<HTMLDivElement>(null)
  const [expanded, setExpanded] = useState(false)
  const [selectedContent, setSelectedContent] = useState('')
  const [selectedCompaction, setSelectedCompaction] = useState<ContentRow | null>(null)
  const [openLatest, setOpenLatest] = useState(0)
  const [idleCapacity, setIdleCapacity] = useState<CompactCapacity | null>(null)
  const [idleBinding, setIdleBinding] = useState<BindingSnapshot | null>(null)
  const [idleDiagnostics, setIdleDiagnostics] = useState<IdleDiagnostic | null>(null)
  const [runDetailsTarget, setRunDetailsTarget] = useState('')
  const [copyFeedback, setCopyFeedback] = useState('')
  const [copyFailed, setCopyFailed] = useState(false)
  const recordsRef = useRef<HTMLDivElement>(null)
  const copyGeneration = useRef(0)
  const copyTarget = useRef(target)
  copyTarget.current = target
  useEffect(() => {
    copyGeneration.current++
    setExpanded(false); setSelectedContent(''); setSelectedCompaction(null); setOpenLatest(0); setIdleCapacity(null); setIdleBinding(null); setIdleDiagnostics(null); setRunDetailsTarget(''); setCopyFeedback(''); setCopyFailed(false)
    return () => { copyGeneration.current++ }
  }, [target])
  const reportIdleDiagnostics = useCallback((value: Omit<IdleDiagnostic, 'signature'>) => {
    const signature = JSON.stringify([value.target, value.freshness, value.value])
    setIdleDiagnostics(current => current?.signature === signature ? current : { ...value, signature })
  }, [])
  const scrollToContent = useRef(false)
  const [query, setQuery] = useState<InspectQuery>({ sessionId: target, ...defaultQuery })
  const [data, setData] = useState<{ value: Inspection; key: string } | null>(null)
  const [requestState, setRequestState] = useState<{ key: string; loading: boolean; error: string }>({ key: '', loading: true, error: '' })
  const [retry, setRetry] = useState(0)
  const accepted = useSyncExternalStore(callback => form.subscribe(callback), () => form.getSnapshot())
  const revision = useSyncExternalStore(callback => pulse.subscribe(callback), () => pulse.getSnapshot())
  const effective = useMemo(() => query.sessionId === target ? query : { sessionId: target, ...defaultQuery }, [query, target])
  const key = JSON.stringify(effective)
  const automatic = effective.atSeq === null ? revision : null
  const safeData = data?.key === key && data.value.sessionId === target ? data.value : null
  const error = requestState.key === key ? requestState.error : ''
  const refreshing = requestState.key === key && requestState.loading
  const loading = !safeData && (requestState.key !== key || requestState.loading)
  const requestStale = loading || refreshing || !!error
  const historical = effective.atSeq !== null || !!safeData?.historical
  const binding = bindingBadge(safeData, idleBinding, target, historical, loading || !!error, !!error, t)
  const latestRun = safeData?.compactions.at(-1)
  const idleRun = idleDiagnostics?.target === target ? idleDiagnostics.value : null
  const autoRunLabel = historical ? safeData?.compression ? `${t(compressionLabel(safeData.compression.mode))} · ${t('historical')}` : t('unknown') : binding.text
  const toolRun = safeData?.cooperation?.toolResults.state
  const toolRunLabel = toolRun === 'off' ? t('coopOff') : toolRun === 'observe' ? t('coopObserve') : toolRun === 'active' ? t('coopActive') : toolRun === 'waiting' ? t('coopWaiting') : toolRun === 'unsupported' ? t('coopUnsupported') : t('unknown')
  const cooperation = safeData?.cooperation
  const originalsRunLabel = cooperation?.originals.state === 'ready' ? t('coopOriginalsReady')
    : cooperation?.originals.state === 'empty' ? t('coopOriginalsEmpty')
      : cooperation?.originals.state === 'unavailable' ? t('coopOriginalsUnavailable') : t('unknown')
  const idleCooperationLabel = cooperation?.idleMaintenance === 'active' ? t('coopActive')
    : cooperation?.idleMaintenance === 'waiting' ? t('coopWaiting')
      : cooperation?.idleMaintenance === 'off' ? t('coopOff')
        : cooperation?.idleMaintenance === 'unsupported' ? t('coopUnsupported') : t('unknown')
  const cooperationDetails = cooperation
    ? `${requestStale ? `${t('lastRead')} · ` : ''}${t('coopRequestPressure')}: ${t(requestPressureLabel(cooperation.requestPressure))} · ${t('coopToolResults')}: ${toolRunLabel} · ${t('coopOriginals')}: ${originalsRunLabel} · ${t('coopIdle')}: ${idleCooperationLabel}`
    : t('unknown')
  const savedRequestPolicy = accepted.value?.policy
  const policyWindow = safeData && !historical && !requestStale ? contextWindow(safeData) : null
  const policyBudgets = (policy: Policy) => {
    if (policy.capacityMode !== 'percent') {
      return `${t('legacyCapacity')} · ${t('recentBudget')} ${exactTokens(policy.recentTokens)} ${t('tokens')} · ${t('summaryBudget')} ${exactTokens(policy.summaryMaxTokens)} ${t('tokens')}`
    }
    const capacity = policyWindow === null ? null : capacityTokens(policy, policyWindow)
    const recent = capacity === null ? `${policy.recentPercent}% · ${t('unknownWindow')}` : `${policy.recentPercent}% · ${exactTokens(capacity.recent)} ${t('tokens')}`
    const summary = capacity === null ? `${policy.summaryPercent}% · ${t('unknownWindow')}` : `${policy.summaryPercent}% · ${exactTokens(capacity.summary)} ${t('tokens')}`
    return `${t('recentBudget')} ${recent} · ${t('summaryBudget')} ${summary}`
  }
  const savedRequestPolicyDetails = savedRequestPolicy
    ? [
      t(savedRequestPolicy.enabled ? 'coopPolicyEnabled' : 'coopPolicyDisabled'),
      t(savedRequestPolicy.historyMode === 'automatic' ? 'historyAutomatic' : 'historyCustom'),
      `${t('trigger')} ${savedRequestPolicy.triggerPercent}%`,
      `${t('savedEarlyCheck')} ${savedRequestPolicy.earlyPercent}%`,
      policyBudgets(savedRequestPolicy),
      savedRequestPolicy.historyMode === 'automatic'
        ? t('automaticWorkingSetNote')
        : `${t('target')} ${savedRequestPolicy.targetPercent}%`,
      t('policySessionNote'),
    ].join(' · ')
    : t('coopPolicyUnknown')
  const currentCompression = requestStale ? undefined : safeData?.compression
  const bindingDetails = [
    binding.text,
    currentCompression?.agentPreset ? `${t('bindingPreset')} ${currentCompression.agentPreset}` : '',
    currentCompression?.generation !== undefined ? `${t('bindingGeneration')} ${currentCompression.generation}` : '',
    currentCompression?.provider ? `${t('bindingProvider')} ${currentCompression.provider}` : '',
    currentCompression?.source ? `${t('bindingSource')} ${t(currentCompression.source === 'declaration' ? 'sourceDeclaration' : 'sourceRegistration')}` : '',
    currentCompression?.reason ? `${t('runMessage')} ${currentCompression.reason}` : '',
  ].filter(Boolean).join(' · ')
  const idleFreshness = idleDiagnostics?.target === target ? idleDiagnostics.freshness : 'unknown'
  const idleRunPrefix = idleFreshness === 'current' ? '' : `${t(idleFreshness === 'refreshing' ? 'runRefreshing' : 'lastRead')} · `
  const idleRunLabel = historical ? t('histUnavailable') : idleRun ? `${idleRunPrefix}${t(idleStatusLabel(idleRun))}${idleRun.restored ? ` · ${t('restored')}` : ''}${idleRun.updatedAt ? ` · ${formatTime(idleRun.updatedAt)}` : ''}` : idleFreshness === 'stale' ? t('idleUnknown') : t('unknown')
  const latestRunLabel = !latestRun ? t('noCompaction') : `${t(latestRun.kind === 'prune' ? 'prune' : 'compact')} · ${t(latestRun.status)}`
  const runDuration = latestRun?.endedAt !== undefined && latestRun.endedAt >= latestRun.startedAt
    ? `${((latestRun.endedAt - latestRun.startedAt) / 1000).toFixed(1)} s` : latestRun?.status === 'running' ? t('running') : t('unknown')
  const runUsage = !latestRun ? t('noCompaction') : latestRun.modelCallStatus === 'not_dispatched' ? t('notDispatched')
    : latestRun.inputTokens === undefined && latestRun.outputTokens === undefined ? t('unknownUsage')
      : `${latestRun.inputTokens === undefined ? '—' : formatTokens(latestRun.inputTokens)} / ${latestRun.outputTokens === undefined ? '—' : formatTokens(latestRun.outputTokens)} ${t('tokens')}${latestRun.inputTokens === undefined || latestRun.outputTokens === undefined ? ` · ${t('usageIntegrityUnknown')}` : ''}`
  const runFreshness = historical ? 'historical' : requestStale ? error ? 'stale' : 'refreshing' : 'current'
  const idleCopy = historical ? null : { ...(idleRun ?? {}), freshness: idleFreshness }
  async function copyRunDiagnostics() {
    if (!safeData) return
    const generation = ++copyGeneration.current
    const targetAtStart = target
    setCopyFeedback(''); setCopyFailed(false)
    try {
      if (!navigator.clipboard?.writeText) throw new Error('Clipboard unavailable')
      await navigator.clipboard.writeText(createRunDiagnostics(safeData, idleCopy, runFreshness === 'historical' ? 'current' : runFreshness))
      if (copyGeneration.current !== generation || copyTarget.current !== targetAtStart) return
      setCopyFeedback(t('copySuccess'))
    } catch {
      if (copyGeneration.current !== generation || copyTarget.current !== targetAtStart) return
      setCopyFailed(true); setCopyFeedback(t('copyFailed'))
    }
  }
  useEffect(() => {
    const controller = new AbortController()
    setRequestState(current => current.key === key ? { ...current, loading: true } : { key, loading: true, error: '' })
    const timer = setTimeout(() => {
      void api.inspect(effective, controller.signal).then(value => {
        if (controller.signal.aborted) return
        if (value.sessionId !== target) {
          setRequestState({ key, loading: false, error: t('targetMismatch') })
          return
        }
        setData({ value, key })
        setRequestState({ key, loading: false, error: '' })
      }).catch(reason => { if (!controller.signal.aborted) setRequestState({ key, loading: false, error: errorText(reason, t) }) })
    }, 200)
    return () => { clearTimeout(timer); controller.abort() }
  }, [api, effective, key, automatic, retry, target, t])
  useEffect(() => {
    if (safeData && scrollToContent.current && contentRef.current) { contentRef.current.scrollIntoView?.({ block: 'start' }); scrollToContent.current = false }
  }, [safeData])
  function change(patch: Partial<InspectQuery>) { setQuery({ ...effective, offset: 0, ...patch }) }
  function showGroup(group: ContextGroup) { setExpanded(true); scrollToContent.current = true; change({ group, category: 'all', archived: false, search: '' }) }
  function showCut(seq: number) { change({ ...defaultQuery, group: undefined, atSeq: seq }) }
  return <section ref={viewRef} className="dsh-context-settings cmv-view" aria-label={t('title')}>
    <style data-plugin="dsh-context-manager" data-plugin-css="dsh-context-manager/inspector">{css}</style>
    <div className="cmv-inner"><header className="cmv-header"><div className="cmv-heading"><h2>{t('title')}</h2><span className="cmv-muted">{t('readonly')}</span><span className="cmv-binding-status" data-mode={binding.mode} role="status" title={binding.title}>{binding.text}</span>{refreshing && <span className="cmv-binding-refresh">{t('runRefreshing')}</span>}</div><Tooltip label={t('settingsHint')}><span className="cmv-muted" tabIndex={0}>{t('settingsLink')}</span></Tooltip><Button size="sm" variant="outline" disabled={loading} onClick={() => setRetry(value => value + 1)}>{t('refresh')}</Button></header>
      <div className="cmv-meta">{!historical && <IdleStatusLine key={target} target={target} api={api} revision={automatic} settingsRevision={accepted.revision} retry={retry} t={t} onCapacity={setIdleCapacity} onBinding={setIdleBinding} onDiagnostic={reportIdleDiagnostics}/>}</div>
      {!historical && safeData?.cooperation && capabilityWarnings(safeData.cooperation, t).length > 0 && <div className="cmv-notice" role="status">{requestStale && <>{t('lastRead')} · </>}{capabilityWarnings(safeData.cooperation, t).join(' · ')}</div>}
      {safeData?.goal?.blockedReason && !historical && <div className="cmv-notice"><span role="status">{requestStale && <>{t('lastRead')} · </>}{t('goalStopShort')}：{safeData.goal.blockedReason.message}</span></div>}
      <details key={target} className="cmv-run-details" open={runDetailsTarget === target} onToggle={event => setRunDetailsTarget(event.currentTarget.open ? target : '')}>
        <summary>{t('runDetails')}</summary>
        <div className="cmv-run-panel">
          <div className="cmv-run-head"><span className="cmv-muted">{t('sampledAt')} {safeData ? formatTime(safeData.sampledAt) : '—'}{requestStale ? ` · ${error ? t('lastRead') : t('runRefreshing')}` : ''}</span><Button size="sm" variant="outline" disabled={!safeData} onClick={() => { void copyRunDiagnostics() }}>{t('copyDiagnostics')}</Button></div>
          {copyFeedback && <p className={copyFailed ? 'cmv-error' : 'cmv-muted'} role={copyFailed ? 'alert' : 'status'}>{copyFeedback}</p>}
          {!safeData ? <p className="cmv-muted">{loading ? t('statusRefreshing') : t('noData')}</p> : <dl className="cmv-run-facts">
            <div><dt>{t('runAuto')}</dt><dd>{autoRunLabel}</dd></div>
            <div><dt>{t('runToolResults')}</dt><dd>{historical ? t('histUnavailable') : toolRunLabel}</dd></div>
            <div><dt>{t('runPostTask')}</dt><dd>{idleRunLabel}</dd></div>
            <div><dt>{t('runRecent')}</dt><dd>{latestRunLabel}</dd></div>
            <div><dt>{t('runDuration')}</dt><dd>{runDuration}</dd></div>
            <div><dt>{t('runUsage')}</dt><dd>{runUsage}</dd></div>
            <div><dt>{t('bindingDiagnostic')}</dt><dd>{bindingDetails}</dd></div>
            <div><dt>{t('cooperationDiagnostic')}</dt><dd>{cooperationDetails}</dd></div>
            <div><dt>{t('policyDiagnostic')}</dt><dd>{savedRequestPolicyDetails}</dd></div>
          </dl>}
        </div>
      </details>
      {effective.atSeq !== null && <div className="cmv-notice"><Tooltip label={t('historyHint')}><span tabIndex={0}>{t('historical')} · {t('record')} {effective.atSeq}</span></Tooltip><Button size="sm" onClick={() => change({ ...defaultQuery, group: undefined })}>{t('currentReturn')}</Button></div>}
      {error && <div className="cmv-notice" role="alert"><span>{error}{safeData ? ` · ${t('retained')}` : ''}</span><Button size="sm" onClick={() => setRetry(value => value + 1)}>{t('retry')}</Button></div>}
      {!safeData ? loading ? <Loading/> : <div className="cmv-empty">{t('noData')}</div> : <>
        <div id="cmi-overview-panel" className="cmv-metrics"><ContextComposition key={target} data={safeData} policy={accepted.value?.policy} stale={requestStale} t={t} onGroup={showGroup}/><RequestStatus data={safeData} policy={accepted.value?.policy} stale={requestStale} bindingMode={binding.mode} t={t}/></div>
        <div id="cmi-history-panel" className="cmv-chart-grid"><PressureTrend key={target} data={safeData} t={t} onCut={showCut}/><CompactionChart key={target + ':compactions'} data={safeData} t={t} onRecord={() => { setOpenLatest(value => value + 1); recordsRef.current?.scrollIntoView?.({ block: 'start' }) }}/><UsageComposition data={safeData} t={t}/></div>
        <div ref={recordsRef}><CompactionRecords key={target} data={safeData} t={t} openLatest={openLatest} onInspect={setSelectedCompaction}/></div>
        {selectedCompaction && selectedCompaction.seq <= safeData.cutSeq && <article className="cmv-card cmv-checkpoint-reader">
          <div className="cmv-heading"><h3>{t('checkpointContent')}</h3><Button size="sm" variant="ghost" onClick={() => setSelectedCompaction(null)}>{t('closeCheckpoint')}</Button></div>
          <ContentDetail key={`${target}:${safeData.cutSeq}:${selectedCompaction.id}`} target={target} cutSeq={safeData.cutSeq} row={selectedCompaction} api={api} t={t} window={contextWindow(safeData)}/>
        </article>}
        <div ref={contentRef} className="cmv-card cmv-content"><div className="cmv-heading"><h3>{t(safeData.historical ? 'historicalContent' : 'content')} <span className="cmv-muted">{exactTokens(safeData.total)} {t('items')}</span></h3><Button size="sm" variant="ghost" aria-expanded={expanded} onClick={() => setExpanded(!expanded)}>{t(expanded ? 'collapseDetails' : 'expandDetails')}</Button></div>
          {!expanded && <div className="cmi-content-list cmv-preview">{safeData.rows.slice(0, 3).map(row => <button type="button" key={row.id} onClick={() => { setSelectedContent(row.id); setExpanded(true) }}><span className="cmv-row-title"><i data-category={row.category}/><strong>{row.title}</strong><span className="cmv-muted">{t(row.category)}</span><b>{formatTokens(row.tokens)} <small>{t('tokens')} · {formatPercent(row.tokens,contextWindow(safeData))}</small></b></span></button>)}{!safeData.rows.length && <p className="cmv-muted">{t('emptyContents')}</p>}</div>}
          {expanded && <div id="cmi-content-panel"><ContentBrowser key={`${target}:${key}`} initialSelected={selectedContent} data={safeData} query={effective} change={change} api={api} target={target} loading={loading} t={t}/></div>}
        </div>
        <UsageDetails data={safeData} t={t} onCut={showCut} capacity={safeData.historical ? null : idleCapacity}/>
        <footer className="cmv-footer"><span>{t('updated')} {formatTime(safeData.sampledAt)}</span><span>{t('readonly')} · {t('record')} {safeData.cutSeq}</span></footer>
      </>}
    </div>
  </section>
}
