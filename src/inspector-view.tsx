import { formatPercent, capacityTokens } from './policy.ts'
/** A read-only, single-page context view registered after the native trajectory. */
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore, type ChangeEvent } from 'react'
import { Button, Input, StateDot, Tooltip } from '@deepseek-ai/dsh-client-ui-primitives'
import type { ConfigForm } from '@deepseek-ai/dsh-client-ui-settings/client'
import type { Policy } from './policy.ts'
import { categories, defaultQuery, type Category, type ContentPage, type ContentRow, type Inspection, type InspectorApi, type InspectQuery, type RequestRow } from './inspector-types.ts'
import { CompactionRecords, UsageDetails, CompactionChart, ContextComposition, PressureTrend, UsageComposition, contextWindow, formatTokens, exactTokens, formatTime } from './inspector-charts.tsx'
import { inspectorText, type InspectorLocaleKey, type InspectorText } from './inspector-locales.ts'
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

type BindingSnapshot = { target: string; state: 'loading' | 'ready' | 'missing' | 'failed'; value: CompactionReadout | null }
type BindingBadge = { mode: CompactionReadout['mode']; text: string; detail: string; title: string }
type IdleDiagnosticValue = Omit<IdleStatus, 'recovery'> & { recovery?: Pick<NonNullable<IdleStatus['recovery']>, 'available' | 'message' | 'riskAcceptanceRequired'> }
type IdleDiagnostic = { target: string; value: IdleDiagnosticValue | null; error: string; signature: string }
function bindingsDisagree(left: CompactionReadout, right: CompactionReadout): boolean {
  if (left.mode !== right.mode || left.hostCapability !== right.hostCapability) return true
  return (['agentPreset', 'generation', 'provider', 'source'] as const).some(key => left[key] !== undefined && right[key] !== undefined && left[key] !== right[key])
}
function inactivityReason(binding: CompactionReadout): InspectorLocaleKey | null {
  switch (binding.mode) {
    case 'enhanced': return null
    case 'native': return 'reasonNative'
    case 'other': return 'reasonOther'
    case 'unconfigured': return 'reasonUnconfigured'
    case 'unavailable': return 'reasonUnavailable'
    default: return binding.hostCapability === 'unsupported' ? 'reasonHostUnsupported' : 'reasonUnknown'
  }
}
function bindingMetadata(binding: CompactionReadout, t: InspectorText): string {
  const values: string[] = []
  if (binding.agentPreset) values.push(`${t('bindingPreset')} · ${binding.agentPreset}`)
  if (binding.generation !== undefined) values.push(`${t('bindingGeneration')} · ${binding.generation}`)
  if (binding.provider) values.push(`${t('bindingProvider')} · ${binding.provider}`)
  if (binding.source) values.push(`${t('bindingSource')} · ${t(binding.source === 'declaration' ? 'sourceDeclaration' : 'sourceRegistration')}`)
  return values.join(' · ')
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
    return { mode: binding?.mode ?? 'unknown', text: t('historical'), detail: `${t('historicalBinding')} · ${label}`, title: binding?.reason ?? '' }
  }
  if (stale) {
    const message = t(failed ? 'statusRefreshFailed' : 'statusRefreshing')
    return { mode: 'unknown', text: message, detail: `${t('currentAgent')} · ${t(failed ? 'bindingRefreshFailed' : 'bindingRefreshing')}`, title: '' }
  }
  const currentIdle = idle?.target === target ? idle : null
  if (!currentIdle || currentIdle.state === 'loading') {
    return { mode: 'unknown', text: t('statusRefreshing'), detail: `${t('currentAgent')} · ${t('bindingRefreshing')}`, title: '' }
  }
  if (currentIdle.state === 'failed') {
    return { mode: 'unknown', text: t('statusRefreshFailed'), detail: `${t('currentAgent')} · ${t('bindingRefreshFailed')}`, title: '' }
  }
  if (currentIdle.state === 'missing' || !currentIdle.value) {
    return { mode: 'unknown', text: t('statusMissing'), detail: `${t('currentAgent')} · ${t('bindingMissing')}`, title: '' }
  }
  const idleValue = currentIdle.value
  const inspected = data?.compression ?? null
  if (inspected && idleValue && bindingsDisagree(inspected, idleValue)) {
    return { mode: 'unknown', text: t('statusConflict'), detail: `${t('currentAgent')} · ${t('bindingConflict')} · ${inspected.reason} / ${idleValue.reason}`, title: `${inspected.reason} / ${idleValue.reason}` }
  }
  const binding = inspected ?? idleValue
  if (!binding) return { mode: 'unknown', text: t('statusMissing'), detail: `${t('currentAgent')} · ${t('bindingMissing')}`, title: '' }
  const cooperating = binding.mode === 'native' && hasNativeSidecar(data?.cooperation)
  const reason = cooperating ? null : inactivityReason(binding)
  const label = t(compressionLabel(binding.mode))
  const detail = `${t('currentAgent')} · ${label}${cooperating ? ` · ${t('nativeCooperating')}` : ''}${reason ? ` · ${t(reason)}` : ''} · ${binding.reason}`
  const short = binding.mode === 'enhanced' ? 'statusEnhanced'
    : binding.mode === 'native' ? 'statusNative'
      : binding.mode === 'other' ? 'statusOther'
        : binding.mode === 'unconfigured' ? 'statusUnconfigured'
          : binding.mode === 'unavailable' ? 'statusUnavailable' : 'statusUnknown'
  return { mode: binding.mode, text: t(short), detail, title: binding.reason }
}

function CooperationDetails({ value, t, stale = false }: { value: ContextCooperationReadout; t: InspectorText; stale?: boolean }) {
  const tool = ({ off: 'coopOff', observe: 'coopObserve', active: 'coopActive', waiting: 'coopWaiting', unsupported: 'coopUnsupported' } as const)[value.toolResults.state]
  const originals = ({ ready: 'coopOriginalsReady', empty: 'coopOriginalsEmpty', unavailable: 'coopOriginalsUnavailable' } as const)[value.originals.state]
  const idle = ({ active: 'coopActive', off: 'coopOff', waiting: 'coopWaiting', unsupported: 'coopUnsupported' } as const)[value.idleMaintenance]
  const pressure = ({ context: 'coopPressureContext', native: 'coopPressureNative', off: 'coopPressureOff', waiting: 'coopPressureWaiting', unsupported: 'coopPressureUnsupported', unknown: 'coopPressureUnknown' } as const)[value.requestPressure]
  return <div className="cmv-request-details" data-context-cooperation="true">
    <h4>{stale ? `${t('lastRead')} · ${t('cooperationDiagnostic')}` : t('cooperationDiagnostic')}</h4>
    <div>
      <p className="cmv-muted">{t('coopToolResults')} · {t(tool)}{value.toolResults.finalResultSeen ? ` · ${t('reductionPipelineOk')}` : ` · ${t('reductionPipelineUnknown')}`}</p>
      <p className="cmv-muted">{t('coopOriginals')} · {t(originals)}{value.originals.count > 0 ? ` · ${exactTokens(value.originals.count)}` : ''}</p>
      <p className="cmv-muted">{t('coopIdle')} · {t(idle)}</p>
      <p className="cmv-muted">{t('coopRequestPressure')} · {t(pressure)}</p>
    </div>
  </div>
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
  delete rest.updatedAt
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
      if (lastBinding.current.target !== target || !lastBinding.current.signature) {
        reportBinding({ target, state: 'loading', value: null })
      }
      try {
        const value = await api.idleStatus({ sessionId: target }, abort.signal)
        if (abort.signal.aborted) return
        setState({ target, value }); lastStatus.current = { target, value }; setError('')
        reportBinding({ target, state: value.compression ? 'ready' : 'missing', value: value.compression ?? null })
        onDiagnostic({ target, value: diagnosticValue(value), error: '' })
        currentCompressionMode.current = value.compression?.mode ?? 'unknown'
        if (currentCompressionMode.current !== 'enhanced') { emergencyEpoch.current++; setEmergencyPlan(null) }
        timer = setTimeout(() => { void read() }, value.status === 'compacting' ? 1000 : 5000)
      } catch (reason) {
        // A cancelled view owns no status update or follow-up timer.
        if (!abort.signal.aborted) {
          const message = errorText(reason, t)
          reportBinding({ target, state: 'failed', value: null })
          const retained = lastStatus.current?.target === target ? lastStatus.current.value : null
          onDiagnostic({ target, value: retained ? diagnosticValue(retained) : null, error: message })
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
        onDiagnostic({ target, value: diagnosticValue(current), error: '' })
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
  const shortStatus = error ? t('idleUnknown') : value ? t(idleStatusLabel(value)) : t('idleWait')
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
  const recentCapacity = !recent ? '—' : recent.input == null ? t('unknownUsage') : recentWindow === null ? t('requestWindowUnknown') : formatPercent(recent.input, recentWindow)
  const hit = recent?.input != null && recent.input > 0 && recent.cacheRead !== null ? recent.cacheRead / recent.input * 100 : null
  return <div className="cmv-card cmv-quick"><div><div className="cmv-request-title"><h3>{t('next')}</h3><div className="cmv-status">{status === 'compactFirst' ? <StateDot state="warning"/> : status === 'continue' ? <StateDot state="done"/> : null}{t(status)}</div></div><Tooltip label={contextGate ? t('admissionHint') : t('bindingHint')}><span tabIndex={0} className="cmv-muted" data-admission-tokens={reading?.tokens} data-context-request-gate={contextSidecar && gate ? 'active' : undefined}>{t('admissionPressure')} {reading ? `≈ ${formatPercent(reading.tokens,reading.window)}` : t('growthUnknown')} / {t('gate')} {formatPercent(gate?.admission,gate?.window)}{gate ? ` · ${source}` : ''}{effectiveCapacity && gate ? ` · ${t('recentBudget')} ${formatPercent(effectiveCapacity.recent,gate.window)} · ${t('summary')} ${formatPercent(Math.min(effectiveCapacity.summary,Math.floor(gate.window*0.1),data.model?.maxTokens??Infinity),gate.window)}` : ''}</span></Tooltip></div>
    <div><h3>{t('recent')}</h3><div className="cmv-request-values"><strong>{recentCapacity}</strong><span className="cmv-muted cmv-request-detail">{recent ? `${t('requestInputDetail')} · ${recent.input == null ? t('unknownUsage') : `${exactTokens(recent.input)} Token`}` : t('noRequest')}</span></div></div>
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
  return <><div className="cmv-heading"><h3>{row.title}</h3><span className="cmv-muted">{formatPercent(row.tokens,window)}</span></div><div className="cmv-muted cmv-reader-meta">{t(row.category)} · {t('record')} {row.seq}{row.current ? '' : ` · ${t('replaced')}`}{row.images ? ` · ${row.images} ${t('images')}` : ''}</div><div className="cmv-muted cmv-source">{row.source}</div>
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
    <div className="cmv-content-layout"><div className="cmi-content-list" aria-label={t('content')}>{data.rows.slice(0, shown).map(item => <button type="button" key={item.id} aria-pressed={row?.id === item.id} onClick={() => setSelected(item.id)}><span className="cmv-row-title"><i data-category={item.category}/><strong>{item.title}</strong><b>{formatPercent(item.tokens,contextWindow(data))}</b></span><span className="cmv-muted">{t(item.category)}{item.current ? '' : ` · ${t('replaced')}`}</span></button>)}{!data.rows.length && <div className="cmv-empty">{t('emptyContents')}</div>}{shown < data.rows.length && <Button size="sm" variant="ghost" onClick={() => setShown(value => value + 4)}>{t('more')}</Button>}</div>{row ? <ContentDetail key={`${target}:${data.cutSeq}:${row.id}`} target={target} cutSeq={data.cutSeq} row={row} api={api} t={t} window={contextWindow(data)}/> : <div className="cmv-empty">{t('selectContent')}</div>}</div>
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
  const [openLatest, setOpenLatest] = useState(0)
  const [idleCapacity, setIdleCapacity] = useState<CompactCapacity | null>(null)
  const [idleBinding, setIdleBinding] = useState<BindingSnapshot | null>(null)
  const [idleDiagnostics, setIdleDiagnostics] = useState<IdleDiagnostic | null>(null)
  const [runDetailsTarget, setRunDetailsTarget] = useState('')
  const recordsRef = useRef<HTMLDivElement>(null)
  useEffect(() => { setExpanded(false); setSelectedContent(''); setOpenLatest(0); setIdleCapacity(null); setIdleBinding(null); setIdleDiagnostics(null); setRunDetailsTarget('') }, [target])
  const reportIdleDiagnostics = useCallback((value: Omit<IdleDiagnostic, 'signature'>) => {
    const signature = JSON.stringify([value.target, value.error, value.value])
    setIdleDiagnostics(current => current?.signature === signature ? current : { ...value, signature })
  }, [])
  const scrollToContent = useRef(false)
  const [query, setQuery] = useState<InspectQuery>({ sessionId: target, ...defaultQuery })
  const [data, setData] = useState<{ value: Inspection; key: string } | null>(null)
  const [requestState, setRequestState] = useState<{ key: string; loading: boolean; error: string }>({ key: '', loading: true, error: '' })
  const [retry, setRetry] = useState(0)
  const accepted = useSyncExternalStore(callback => form.subscribe(callback), () => form.getSnapshot())
  const savedPolicy = accepted.value?.policy
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
    <div className="cmv-inner"><header className="cmv-header"><div className="cmv-heading"><h2>{t('title')}</h2><span className="cmv-muted">{t('readonly')}</span><span className="cmv-binding-status" data-mode={binding.mode} role="status" title={binding.title}>{binding.text}</span></div><Tooltip label={t('settingsHint')}><span className="cmv-muted" tabIndex={0}>{t('settingsHint')}</span></Tooltip><Button size="sm" variant="outline" disabled={loading} onClick={() => setRetry(value => value + 1)}>{t('refresh')}</Button></header>
      <div className="cmv-meta">{!historical && <IdleStatusLine key={target} target={target} api={api} revision={automatic} settingsRevision={accepted.revision} retry={retry} t={t} onCapacity={setIdleCapacity} onBinding={setIdleBinding} onDiagnostic={reportIdleDiagnostics}/>}</div>
      {!historical && safeData?.cooperation && capabilityWarnings(safeData.cooperation, t).length > 0 && <div className="cmv-notice" role="status">{error && <>{t('lastRead')} · </>}{capabilityWarnings(safeData.cooperation, t).join(' · ')}</div>}
      {safeData?.goal?.blockedReason && !historical && <div className="cmv-notice"><span role="status">{error && <>{t('lastRead')} · </>}{t('goalStopShort')}：{safeData.goal.blockedReason.message}</span></div>}
      <details key={target} className="cmv-run-details" open={runDetailsTarget === target} onToggle={event => setRunDetailsTarget(event.currentTarget.open ? target : '')}>
        <summary>{t('runDetails')}</summary>
        <div className="cmv-request-details">
          <section><h4>{t('bindingDiagnostic')}</h4><p>{binding.text}{binding.detail && <> · {binding.detail}</>}</p>
            {!historical && safeData?.compression && <p>{error ? `${t('lastRead')} · ` : ''}{t('inspectionBinding')} · {bindingMetadata(safeData.compression, t) || t('unknownBinding')} · {safeData.compression.reason}</p>}
            {!historical && idleDiagnostics?.target === target && idleDiagnostics.value?.compression && <p>{idleDiagnostics.error ? `${t('lastRead')} · ` : ''}{t('idleBinding')} · {bindingMetadata(idleDiagnostics.value.compression, t) || t('unknownBinding')} · {idleDiagnostics.value.compression.reason}</p>}
          </section>
          {!historical && idleDiagnostics?.target === target && <section>
            <h4>{idleDiagnostics?.error ? `${t('lastRead')} · ${t('idleDiagnostic')}` : t('idleDiagnostic')}</h4>
            {idleDiagnostics.error && <p role="alert">{idleDiagnostics.error}</p>}
            {idleDiagnostics.value && <>
              <p>{t('runStatus')} · {t(idleStatusLabel(idleDiagnostics.value))}{idleDiagnostics.value.restored && <> · {t('restored')}</>}</p>
              {idleDiagnostics.value.message && <p>{t('runMessage')} · {idleDiagnostics.value.message}</p>}
              {idleDiagnostics.value.reasonCode && <p>{t('runMessage')} · {idleDiagnostics.value.reasonCode}</p>}
              {idleDiagnostics.value.deadline && <p>{t('runDeadline')} · {idleDiagnostics.value.deadline}</p>}
              {idleDiagnostics.value.execution && <p>{t('runExecution')} · {idleDiagnostics.value.execution}</p>}
              {idleDiagnostics.value.capacity && <p>{t('runCapacity')} · {t('gate')} {formatPercent(idleDiagnostics.value.capacity.admission, idleDiagnostics.value.capacity.windowTokens)} ({exactTokens(idleDiagnostics.value.capacity.admission)}) · {t('planUpper')} {formatPercent(idleDiagnostics.value.capacity.upper, idleDiagnostics.value.capacity.windowTokens)} ({exactTokens(idleDiagnostics.value.capacity.upper)}) · {t('continuationReserve')} {formatPercent(idleDiagnostics.value.capacity.resumeHeadroom, idleDiagnostics.value.capacity.windowTokens)} ({exactTokens(idleDiagnostics.value.capacity.resumeHeadroom)}) · {t('reserveNeed')} {exactTokens(idleDiagnostics.value.capacity.requiredResumeHeadroom)} · {t('reserveMax')} {exactTokens(idleDiagnostics.value.capacity.resumeHeadroomLimit)}</p>}
              {idleDiagnostics.value.recovery && <><p>{t('runRecovery')} · {idleDiagnostics.value.recovery.available ? t('recoveryAvailable') : t('recoveryUnavailable')}{idleDiagnostics.value.recovery.riskAcceptanceRequired && <> · {t('riskRecoveryButton')}</>}</p><p>{idleDiagnostics.value.recovery.message}</p><p>{t('recoveryStrategy')}</p></>}
              {idleDiagnostics.value.emergency && <><p>{t('runEmergency')} · {idleDiagnostics.value.emergency.eligible ? t('emergencyAvailable') : t('emergencyUnavailable')}{idleDiagnostics.value.emergency.used && <> · {t('completed')}</>}</p><p>{idleDiagnostics.value.emergency.message}</p></>}
            </>}
          </section>}
          {!historical && safeData?.cooperation && <CooperationDetails value={safeData.cooperation} t={t} stale={!!error}/>}
          {!historical && <section>
            <h4>{t('policyDiagnostic')}</h4>
            <p data-saved-context-policy={savedPolicy ? (savedPolicy.enabled ? 'enabled' : 'disabled') : 'unknown'}>{t('coopSavedPolicy')} · {savedPolicy ? (savedPolicy.enabled ? t('coopPolicyEnabled') : t('coopPolicyDisabled')) : t('coopPolicyUnknown')}</p>
            {savedPolicy && <>
              <p>{savedPolicy.enabled ? t('coopPolicyEnabled') : t('coopPolicyDisabled')} · {t('trigger')} {savedPolicy.triggerPercent}% · {savedPolicy.capacityMode === 'percent' ? <>{t(savedPolicy.historyMode === 'automatic' ? 'historyAutomatic' : 'historyCustom')} · {t('target')} {savedPolicy.targetPercent}% · {t('recentBudget')} {savedPolicy.recentPercent}%</> : <>{t('legacyCapacity')} · {exactTokens(savedPolicy.absoluteTriggerTokens)} / {exactTokens(savedPolicy.absoluteTargetTokens)} Token</>}</p>
              <p>{t('savedAbsolutePolicy')} · {savedPolicy.absoluteEnabled ? t('coopPolicyEnabled') : t('coopPolicyDisabled')} · {t('absoluteTrigger')} {exactTokens(savedPolicy.absoluteTriggerTokens)} / {exactTokens(savedPolicy.absoluteTargetTokens)} Token</p>
              <p>{savedPolicy.capacityMode === 'percent' ? <>{t('recentBudget')} · {savedPolicy.recentPercent}% · {t('savedEarlyCheck')} {savedPolicy.earlyPercent}% · {t('savedSafetySpace')} {savedPolicy.safetyPercent}%</> : <>{t('savedLegacyRecent')} · {exactTokens(savedPolicy.recentTokens)} Token · {t('savedEarlyCheck')} {savedPolicy.earlyPercent}% · {t('savedSafetySpace')} {savedPolicy.safetyPercent}%</>}</p>
              <p>{savedPolicy.idleEnabled ? t('coopActive') : t('coopOff')} · {t('idle')} {savedPolicy.idleMinutes} {t('minutes')} · {t('savedIdleFloor')} {savedPolicy.idleMinPercent}%</p>
              {savedPolicy.summaryTimeoutMode === 'fixed'
                ? <p>{t('fixedTimeout')} · {savedPolicy.timeoutMs / 1000} {t('seconds')}</p>
                : <p>{t('adaptiveTimeout')} · {savedPolicy.summaryTotalMs / 1000} {t('seconds')} · {t('firstOutputWait')} {savedPolicy.summaryFirstOutputMs / 1000} {t('seconds')} · {t('progressWait')} {savedPolicy.summaryStallMs / 1000} {t('seconds')}</p>}
              <p>{t('savedOutputPolicy')} · {savedPolicy.capacityMode === 'percent' ? <>{t('savedSummaryPercent')} {savedPolicy.summaryPercent}% · {t('savedRepairPercent')} {savedPolicy.repairPercent}%</> : <>{t('legacyCapacity')} · {t('savedSummaryPercent')} {exactTokens(savedPolicy.summaryMaxTokens)} Token</>} · {t('savedPasses')} {savedPolicy.maxPasses} · {t('savedCheckpoint')} {savedPolicy.checkpointFormat === 'json' ? 'JSON' : 'Markdown'} · {t('savedFormatRepair')} {savedPolicy.formatRepairEnabled ? t('coopPolicyEnabled') : t('coopPolicyDisabled')}</p>
              <p>{t('savedToolPolicy')} · {savedPolicy.toolResultsMode === 'off' ? t('reductionOff') : savedPolicy.toolResultsMode === 'observe' ? t('reductionObserve') : t('reductionReduce')} · {t('savedToolLimits')} {exactTokens(savedPolicy.toolResultsMaxChars)} {t('characters')} / {exactTokens(savedPolicy.toolResultsMinSavings)} {t('characters')}</p>
              <p>{t('savedArchiveLimits')} · {exactTokens(savedPolicy.archiveReadBudget)} {t('characters')} / {savedPolicy.archiveSearchLimit} {t('items')} · {t('savedPrefixPolicy')} {savedPolicy.prefixDiagnosticsEnabled ? t('coopPolicyEnabled') : t('coopPolicyDisabled')}</p>
              <p>{t('policySessionNote')}</p>
            </>}
          </section>}
          {safeData?.goal?.blockedReason && !historical && <section><h4>{error ? `${t('lastRead')} · ${t('goalDiagnostic')}` : t('goalDiagnostic')}</h4><p>{safeData.goal.blockedReason.code} · {safeData.goal.blockedReason.message}</p><p>{safeData.goal.roundsStarted}/{safeData.goal.maxGoalRounds} {t('goalRounds')} · {t('goalIndependent')}</p></section>}
        </div>
      </details>
      {effective.atSeq !== null && <div className="cmv-notice"><Tooltip label={t('historyHint')}><span tabIndex={0}>{t('historical')} · {t('record')} {effective.atSeq}</span></Tooltip><Button size="sm" onClick={() => change({ ...defaultQuery, group: undefined })}>{t('currentReturn')}</Button></div>}
      {error && <div className="cmv-notice" role="alert"><span>{error}{safeData ? ` · ${t('retained')}` : ''}</span><Button size="sm" onClick={() => setRetry(value => value + 1)}>{t('retry')}</Button></div>}
      {!safeData ? loading ? <Loading/> : <div className="cmv-empty">{t('noData')}</div> : <>
        <div id="cmi-overview-panel" className="cmv-metrics"><ContextComposition key={target} data={safeData} policy={accepted.value?.policy} stale={requestStale} t={t} onGroup={showGroup}/><RequestStatus data={safeData} policy={accepted.value?.policy} stale={requestStale} bindingMode={binding.mode} t={t}/></div>
        <div id="cmi-history-panel" className="cmv-chart-grid"><PressureTrend key={target} data={safeData} t={t} onCut={showCut}/><CompactionChart key={target + ':compactions'} data={safeData} t={t} onRecord={() => { setOpenLatest(value => value + 1); recordsRef.current?.scrollIntoView?.({ block: 'start' }) }}/><UsageComposition data={safeData} t={t}/></div>
        <div ref={recordsRef}><CompactionRecords key={target} data={safeData} t={t} openLatest={openLatest}/></div>
        <div ref={contentRef} className="cmv-card cmv-content"><div className="cmv-heading"><h3>{t(safeData.historical ? 'historicalContent' : 'content')} <span className="cmv-muted">{exactTokens(safeData.total)} {t('items')}</span></h3><Button size="sm" variant="ghost" aria-expanded={expanded} onClick={() => setExpanded(!expanded)}>{t(expanded ? 'collapseDetails' : 'expandDetails')}</Button></div>
          {!expanded && <div className="cmi-content-list cmv-preview">{safeData.rows.slice(0, 3).map(row => <button type="button" key={row.id} onClick={() => { setSelectedContent(row.id); setExpanded(true) }}><span className="cmv-row-title"><i data-category={row.category}/><strong>{row.title}</strong><span className="cmv-muted">{t(row.category)}</span><b>{formatPercent(row.tokens,contextWindow(safeData))}</b></span></button>)}{!safeData.rows.length && <p className="cmv-muted">{t('emptyContents')}</p>}</div>}
          {expanded && <div id="cmi-content-panel"><ContentBrowser key={`${target}:${key}`} initialSelected={selectedContent} data={safeData} query={effective} change={change} api={api} target={target} loading={loading} t={t}/></div>}
        </div>
        <UsageDetails data={safeData} t={t} onCut={showCut} capacity={safeData.historical ? null : idleCapacity}/>
        <footer className="cmv-footer"><span>{t('updated')} {formatTime(safeData.sampledAt)}</span><span>{t('readonly')} · {t('record')} {safeData.cutSeq}</span></footer>
      </>}
    </div>
  </section>
}
