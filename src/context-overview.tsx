/** Overview cards and the on-demand summary preview for the Context page. */
import { useEffect, useMemo, useRef, useState } from 'react'
import { Button, Tooltip } from '@deepseek-ai/dsh-client-ui-primitives'
import type { ContentPage, ContentRow, Inspection, InspectorApi } from './inspector-types.ts'
import type { IdleStatus } from './idle-types.ts'
import type { Policy } from './policy.ts'
import type { InspectorText } from './inspector-locales.ts'
import { composition, contextWindow } from './chart-data.ts'
import { formatPercent } from './policy.ts'
import { formatCapacity, formatTokens, formatTime, exactTokens } from './inspector-charts.tsx'
import { errorText } from './content-reader.tsx'
import { readStoredCheckpoint } from './checkpoint.ts'

const clock = (ms: number) => {
  const total = Math.max(0, Math.round(ms / 1000))
  return `${String(Math.floor(total / 60)).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`
}
const busyReason = (value: IdleStatus) => /background|busy/u.test(value.reasonCode ?? '')
/** A positive delta means the replaced segment shrank; the sign keeps both directions honest. */
const reductionSign = (delta: number | null) => delta === null || delta === 0 ? '' : delta > 0 ? '-' : '+'
const reductionLabel = (delta: number, t: InspectorText) => delta > 0 ? t('reduced') : delta < 0 ? t('increased') : t('unchanged')

function Sparkline({ points, window, t }: { points: Inspection['pressureHistory']; window: number | null; t: InspectorText }) {
  const known = points.filter((point): point is typeof point & { tokens: number } => typeof point.tokens === 'number')
  if (window === null || known.length === 0) return <div className="cmv-spark cmv-spark-empty" aria-label={t('noTrend')}/>
  const max = Math.max(window, ...known.map(point => point.tokens))
  const first = points[0]?.time ?? 0
  const last = points.at(-1)?.time ?? 0
  const span = last - first
  const x = (time: number) => span > 0 ? 2 + Math.max(0, Math.min(1, (time - first) / span)) * 96 : 50
  const y = (value: number) => 38 - Math.min(1, Math.max(0, value / max)) * 34
  const segments: string[][] = []
  let current: string[] = []
  for (const point of points) {
    if (point.tokens === null) { if (current.length > 0) segments.push(current); current = []; continue }
    current.push(`${x(point.time).toFixed(2)},${y(point.tokens).toFixed(2)}`)
  }
  if (current.length > 0) segments.push(current)
  if (segments.length === 0) return <div className="cmv-spark cmv-spark-empty" aria-label={t('noTrend')}/>
  return <svg className="cmv-spark" viewBox="0 0 100 40" preserveAspectRatio="none" role="img" aria-label={`${t('contextChange')} · ${known.length}/${points.length} ${t('record')}`}>
    {segments.map((segment, index) => <g key={index}>
      {segment.length > 1 && <path d={`M${segment.join(' L')} L${segment.at(-1)!.split(',')[0]},40 L${segment[0]!.split(',')[0]},40 Z`} className="cmv-spark-area"/>}
      {segment.length > 1 && <path d={`M${segment.join(' L')}`} className="cmv-spark-line" fill="none"/>}
    </g>)}
  </svg>
}

function IdleCard({ idle, policy, t }: { idle: IdleStatus | null; policy: Policy | undefined; t: InspectorText }) {
  const minutes = policy?.idleMinutes ?? null
  const scheduled = idle !== null && idle.status === 'scheduled' && idle.dueAt !== null && !busyReason(idle)
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!scheduled) return
    let timer: ReturnType<typeof setTimeout> | undefined
    let cancelled = false
    const tick = () => {
      if (cancelled) return
      setNow(Date.now())
      timer = setTimeout(tick, 1000)
    }
    timer = setTimeout(tick, 1000)
    return () => { cancelled = true; clearTimeout(timer) }
  }, [scheduled])
  let value = '—'
  let suffix: string | null = null
  let note = ''
  let progress: number | null = null
  let label = t('idleUnknown')
  let state = 'unknown'
  if (policy && !policy.idleEnabled) { label = t('idleOff'); note = t('idleDisabledHint'); state = 'off' }
  else if (idle === null) { label = t('idleUnknown'); note = t('idleUnknown') }
  else if (scheduled && minutes !== null) {
    const total = minutes * 60000
    const remaining = Math.max(0, idle.dueAt! - now)
    value = clock(remaining); suffix = `/ ${clock(total)}`
    progress = total === 0 ? 1 : 1 - remaining / total
    label = t('idleScheduled'); state = 'counting'
    note = t('idleCountingHint')
  } else {
    state = idle.status
    label = t(statusKey(idle))
    if (idle.status === 'waiting') note = t('idleWaitHint')
    else if (idle.status === 'off') note = t('idleDisabledHint')
    else if (idle.status === 'compacting') note = t('idleCompactingNote')
    else if (idle.status === 'completed' && idle.updatedAt != null) {
      value = formatTime(idle.updatedAt)
      note = new Date(idle.updatedAt).toLocaleDateString()
    } else if (idle.updatedAt) note = `${t('updated')} ${formatTime(idle.updatedAt)}`
    else if (idle.status === 'scheduled') note = t('idleNoTimer')
  }
  return <article className="cmv-card cmv-stat" data-stat="idle" data-idle-state={state}>
    <div className="cmv-stat-head"><span className="cmv-stat-icon" aria-hidden="true">◷</span><h3>{t('idleTimer')}</h3><span className="cmv-chip" data-tone={state === 'counting' ? 'active' : undefined}>{label}</span></div>
    <div className="cmv-stat-value">{value}{suffix && <span className="cmv-stat-suffix"> {suffix}</span>}</div>
    {progress !== null && <div className="cmv-meter" role="img" aria-label={`${t('idleProgress')} ${Math.round(Math.max(0, Math.min(1, progress)) * 100)}%`} data-idle-progress={Math.round(Math.max(0, Math.min(1, progress)) * 100)}><span style={{ width: `${Math.max(2, Math.min(100, progress * 100))}%` }}/></div>
    }
    {note && <p className="cmv-stat-note">{note}</p>}
  </article>
}

function statusKey(value: IdleStatus) {
  if (value.status === 'off') return value.owner === 'context-manager' ? 'idleOff' : 'idleNotEnabled'
  const map = { waiting: 'idleWait', scheduled: 'idleScheduled', checking: 'idleChecking', compacting: 'idleCompacting', completed: 'idleCompleted', skipped: 'idleSkipped', cancelled: 'idleCancelled', failed: 'idleFailed' } as const
  return map[value.status]
}

export function StatCards({ data, policy, idle, t }: { data: Inspection; policy: Policy | undefined; idle: IdleStatus | null; t: InspectorText }) {
  const chart = composition(data, policy)
  const window = chart.window
  const applied = data.compactions.filter(entry => entry.kind === 'compact' && entry.applied)
  const notApplied = data.compactions.filter(entry => entry.kind === 'compact' && !entry.applied && entry.status !== 'running')
  // The newest applied entry decides this card: a missing before/after pair stays
  // unknown and is never silently replaced by an older successful figure.
  const latestApplied = data.compactions.findLast(entry => entry.kind === 'compact' && entry.applied)
  const known = latestApplied !== undefined && latestApplied.beforeTokens !== undefined && latestApplied.afterTokens !== undefined
  const delta = known ? latestApplied!.beforeTokens! - latestApplied!.afterTokens! : null
  const share = known && latestApplied!.beforeTokens! > 0 ? Math.abs(delta!) / latestApplied!.beforeTokens! * 100 : null
  return <div className="cmv-stats">
    <article className="cmv-card cmv-stat" data-stat="used">
      <div className="cmv-stat-head"><span className="cmv-stat-icon" aria-hidden="true">▤</span><h3>{t('currentUsage')}</h3><span className="cmv-chip">{t('estimateShort')}</span></div>
      <div className="cmv-stat-value">{formatCapacity(chart.used)}</div>
      <p className="cmv-stat-note">{window === null ? t('unknownWindow') : `${formatPercent(chart.used, window)} / ${formatCapacity(window)} Token`}</p>
      <Sparkline points={data.pressureHistory} window={window} t={t}/>
    </article>
    <article className="cmv-card cmv-stat" data-stat="reduction">
      <div className="cmv-stat-head"><span className="cmv-stat-icon" aria-hidden="true">↓</span><h3>{t('recentReduction')}</h3></div>
      <div className="cmv-stat-value" data-delta={delta === null ? 'unknown' : delta > 0 ? 'reduced' : delta < 0 ? 'increased' : 'unchanged'}>{known ? `${reductionSign(delta)}${formatTokens(Math.abs(delta!))}` : '—'}</div>
      <p className="cmv-stat-note">{latestApplied === undefined ? t('noAppliedSummaryShort') : known ? `${reductionLabel(delta!, t)} · ${formatPercent(share, 100)}` : t('unknownUsage')}</p>
    </article>
    <article className="cmv-card cmv-stat" data-stat="applied">
      <div className="cmv-stat-head"><span className="cmv-stat-icon" aria-hidden="true">▥</span><h3>{t('appliedCount')}</h3><span className="cmv-chip">{t('recentOnly')}</span></div>
      <div className="cmv-stat-value">{applied.length}<span className="cmv-stat-unit"> {t('times')}</span></div>
      <p className="cmv-stat-note">{notApplied.length > 0 ? `${t('unappliedPrefix')} ${notApplied.length} ${t('times')} ${t('unappliedSuffix')}` : t('noUnapplied')}</p>
    </article>
    <IdleCard idle={idle} policy={policy} t={t}/>
  </div>
}

export function WindowChips({ data, policy, t }: { data: Inspection; policy: Policy | undefined; t: InspectorText }) {
  const window = contextWindow(data)
  return <div className="cmv-window-chips">
    <Tooltip label={t('windowHint')}><span tabIndex={0} className="cmv-chip">{t('window')} {window === null ? '—' : formatCapacity(window)} Token</span></Tooltip>
    {policy && <><span className="cmv-chip">{t('trigger')} {policy.triggerPercent}%</span><span className="cmv-chip">{t('idle')} {policy.idleMinutes} {t('minuteShort')}</span></>}
  </div>
}

/**
 * Read the newest applied summary once from this cut. The request is keyed by
 * session and checkpoint identity, so cut polling keeps the same stored summary
 * visible and a stale response can never replace a newer one.
 */
export function SummaryCard({ entry, target, cutSeq, api, t, onOpen }: { entry: ContentRow | undefined; target: string; cutSeq: number; api: InspectorApi; t: InspectorText; onOpen: (row: ContentRow) => void }) {
  const [mode, setMode] = useState<'structured' | 'raw' | 'sources'>('structured')
  const [page, setPage] = useState<ContentPage | null>(null)
  const [offsets, setOffsets] = useState([0])
  const [sourceOffset, setSourceOffset] = useState(0)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const identity = `${target}:${entry?.id ?? ''}`
  const identityRef = useRef(identity)
  identityRef.current = identity
  const cutRef = useRef(cutSeq)
  cutRef.current = cutSeq
  const request = useRef<AbortController | null>(null)
  useEffect(() => {
    request.current?.abort()
    setPage(null); setError(''); setMode('structured'); setOffsets([0]); setSourceOffset(0)
    if (!entry) { setLoading(false); return }
    const abort = new AbortController(); request.current = abort
    setLoading(true)
    void api.content({ sessionId: target, cutSeq: cutRef.current, id: entry.id, offset: 0 }, abort.signal).then(next => {
      if (!abort.signal.aborted && identityRef.current === identity) setPage(next)
    }).catch(reason => { if (!abort.signal.aborted && identityRef.current === identity) setError(errorText(reason, t)) })
      .finally(() => { if (!abort.signal.aborted && identityRef.current === identity) setLoading(false) })
    return () => abort.abort()
  }, [api, entry?.id, identity, t])
  useEffect(() => () => request.current?.abort(), [])
  const complete = page !== null && page.offset === 0 && page.nextOffset === null && page.text.length === page.totalChars
  const value = useMemo(() => (page && complete && mode !== 'raw' ? readStoredCheckpoint(page.text) : null), [complete, mode, page])
  async function load(offset: number, source: number) {
    if (!entry) return
    request.current?.abort()
    const abort = new AbortController(); request.current = abort
    const keyAtStart = identityRef.current
    setLoading(true); setError('')
    try {
      const next = await api.content({ sessionId: target, cutSeq: cutRef.current, id: entry.id, offset, ...(source > 0 ? { sourceOffset: source } : {}) }, abort.signal)
      if (abort.signal.aborted || identityRef.current !== keyAtStart) return
      setPage(next); setSourceOffset(source)
    } catch (reason) {
      if (!abort.signal.aborted && identityRef.current === keyAtStart) setError(errorText(reason, t))
    } finally {
      if (!abort.signal.aborted && identityRef.current === keyAtStart) setLoading(false)
    }
  }
  const counts = value ? { completed: value.completed.length, pending: value.pending.length, uncertainties: value.uncertainties.length } : null
  const list = (items: readonly string[], limit?: number) => {
    const shown = limit === undefined ? items : items.slice(0, limit)
    return <ul className="cmv-summary-list">{shown.map((item, index) => <li key={index}>{item}</li>)}{limit !== undefined && items.length > limit && <li className="cmv-muted">+{items.length - limit}</li>}</ul>
  }
  return <article className="cmv-card cmv-summary">
    <div className="cmv-heading"><h3>{t('summaryPanel')}</h3>{entry && <span className="cmv-muted">{entry.title}</span>}</div>
    {!entry ? <div className="cmv-empty">{t('summaryNoEntry')}</div> : <>
      <div className="cmv-summary-actions">
        <div className="cmv-tabs" role="group" aria-label={t('summaryPanel')}>
          {([['structured', 'structuredSummary'], ['raw', 'rawSummary'], ['sources', 'sourceOriginals']] as const).map(([id, label]) => <button type="button" key={id} aria-pressed={mode === id} onClick={() => { setMode(id); if (id === 'sources' && page === null) void load(0, 0) }}>{t(label)}</button>)}
        </div>
        <Button size="sm" variant="ghost" onClick={() => onOpen(entry)}>{t('viewSummarySources')}</Button>
      </div>
      {error && <p className="cmv-error" role="alert">{error}</p>}
      {page === null && !error && <p className="cmv-muted">{loading ? t('summaryLoading') : t('summaryNoEntry')}</p>}
      {page !== null && mode === 'structured' && (value
        ? <><div className="cmv-summary-preview">
          <div className="cmv-summary-row" data-field="goal"><span>{t('summaryGoal')}</span><p>{value.goal}</p></div>
          <div className="cmv-summary-row" data-field="constraints"><span>{t('summaryConstraints')}</span>{value.constraints.length ? list(value.constraints, 4) : <p className="cmv-muted">{t('noRecordedFacts')}</p>}</div>
          <div className="cmv-summary-row" data-field="next"><span>{t('summaryNext')}</span><p>{value.next}</p></div>
        </div>
          <div className="cmv-between cmv-summary-counts"><span>{t('completedCount')} {counts!.completed} {t('items')} · {t('pendingCount')} {counts!.pending} {t('items')} · {t('uncertaintyCount')} {counts!.uncertainties} {t('items')}</span><Button size="sm" variant="ghost" onClick={() => onOpen(entry)}>{t('expandAllFields')}</Button></div></>
        : <><pre className="cmi-body" tabIndex={0}>{page.text || t('noText')}</pre><p className="cmv-muted">{complete ? t('summaryUnparsed') : t('summaryPartial')}</p></>)}
      {page !== null && mode === 'raw' && <><pre className="cmi-body" tabIndex={0}>{page.text || t('noText')}</pre>{(offsets.length > 1 || page.nextOffset !== null) && <div className="cmv-pagination"><Button size="sm" disabled={offsets.length === 1} onClick={() => { const next = offsets.slice(0, -1); setOffsets(next); void load(next.at(-1)!, sourceOffset) }}>{t('previousText')}</Button><span>{t('characters')} {exactTokens(page.offset + 1)}–{exactTokens(page.offset + page.text.length)} / {exactTokens(page.totalChars)}</span><Button size="sm" disabled={page.nextOffset === null} onClick={() => { if (page.nextOffset === null) return; setOffsets(current => [...current, page.nextOffset!]); void load(page.nextOffset!, sourceOffset) }}>{t('nextText')}</Button></div>}</>}
      {page !== null && mode === 'sources' && <div className="cmv-summary-source-block">
        {page.sources?.rows.length ? (
          <>
            <div className="cmi-content-list">{page.sources.rows.map(source => <button type="button" key={source.id} onClick={() => onOpen(source)}><span className="cmv-row-title"><strong>{source.title}</strong><b>{formatTokens(source.tokens)} <small>{t('tokens')}</small></b></span><span className="cmv-muted">{t('record')} {source.seq} · {t(source.category)}</span></button>)}</div>
            {(sourceOffset > 0 || page.sources.nextOffset !== null) && <div className="cmv-pagination"><Button size="sm" disabled={sourceOffset === 0} onClick={() => { void load(0, Math.max(0, sourceOffset - 4)) }}>{t('previousSources')}</Button><span>{sourceOffset + 1}–{sourceOffset + page.sources.rows.length} / {exactTokens(page.sources.total)}</span><Button size="sm" disabled={page.sources.nextOffset === null} onClick={() => { if (page.sources?.nextOffset != null) void load(0, page.sources.nextOffset) }}>{t('nextSources')}</Button></div>}
          </>
        ) : <p className="cmv-muted">{t('noSources')}</p>}
      </div>}
    </>}
  </article>
}
