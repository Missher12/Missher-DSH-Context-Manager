/** Native-theme charts for one immutable session cut. */
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { Button, Tooltip } from '@deepseek-ai/dsh-client-ui-primitives'
import { defaultQuery, type ContentRow, type EfficiencyReadout, type FieldTotalReadout, type Inspection, type InspectorApi, type ReductionReadout, type SessionUsageReadout, type TeamUsageMemberReadout, type TeamUsageReadout } from './inspector-types.ts'
import type { CompactCapacity } from './idle-types.ts'
import { contextWindow, composition, contextGroups, usageSlices, usageCompleteness, type ContextGroup } from './chart-data.ts'
import type { InspectorLocaleKey, InspectorText } from './inspector-locales.ts'
import { capacityPercent, formatPercent, type Policy } from './policy.ts'
import { compactionRequestRange, postCheckpointRequestRange } from './compaction-usage.ts'
import { estimateRequestReferenceCost } from './session-cost.ts'

export { contextWindow } from './chart-data.ts'

export const formatTokens = (value: number | null | undefined) => value == null ? '—' : value >= 1_000_000 ? `${(value / 1_000_000).toFixed(2)}M` : value >= 1000 ? `${(value / 1000).toFixed(1)}K` : Math.round(value).toLocaleString()
export const formatCapacity = (value: number | null) => value === null ? '—' : value >= 1_000_000 ? `${(value / 1_000_000).toLocaleString(undefined, { maximumFractionDigits: 2 })}M` : formatTokens(value)
export const formatTokenK = (value: number) => `${(value / 1000).toLocaleString(undefined, { maximumFractionDigits: 2 })}K`
export const exactTokens = (value: number | null | undefined) => value == null ? '—' : Math.round(value).toLocaleString()
export const formatTime = (value: number) => new Date(value).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false })
const recordTime = (value: number) => new Date(value).toLocaleString([], { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false })

/** A percentage donut retains unknown input as an empty track. */
export function CacheDonut({ value, t }: { value: number | null; t: InspectorText }) {
  const shown = value === null ? '—' : `${Math.round(value)}%`
  return <div className="cmv-donut" role="img" aria-label={`${t('cache')} ${shown}`} style={{ background: value === null ? undefined : `conic-gradient(var(--cmv-green) ${Math.min(100, Math.max(0, value))}%, var(--dsw-alias-interactive-bg-hover) 0)` }}><span><strong>{shown}</strong><small>{t('cache')}</small></span></div>
}

/** One full-window bar includes available capacity and preserves category estimates. */
export function ContextComposition({ data, policy, stale = false, t, onGroup }: { data: Inspection; policy: Policy | undefined; stale?: boolean; t: InspectorText; onGroup: (group: ContextGroup) => void }) {
  const chart = composition(data, stale ? undefined : policy)
  const window = chart.window
  const outputReserve = data.historical ? data.model?.maxTokens : data.admission?.outputReserve ?? data.model?.maxTokens
  const isGroup = (id: typeof chart.slices[number]['id']): id is ContextGroup => id !== 'free' && id !== 'other' && id !== 'reserve' && id !== 'model-capped' && id !== 'unknown-space'
  const name = (id: typeof chart.slices[number]['id']) => id === 'model-capped' ? t('modelCapped') : id === 'unknown-space' ? t('unknownSpace') : t(id as InspectorLocaleKey)
  const hint = (slice: typeof chart.slices[number]) => slice.id === 'reserve' ? `${t('reserveHint')} ${t('gate')} ${formatPercent(chart.limit,chart.window)}` : slice.id === 'free' ? t(chart.limit === null ? 'availableHint' : 'freeHint') : slice.id === 'summary' ? t('summaryHint') : slice.id === 'unknown-space' ? t('unknownSpaceHint') : ''
  const sliceLabel = (slice: typeof chart.slices[number]) => `${name(slice.id)} ≈ ${formatTokens(slice.value)} ${t('tokens')} · ${formatPercent(slice.value,chart.window)}${hint(slice) ? ` · ${hint(slice)}` : ''}`
  const slices = chart.slices
  const labelLimit = chart.modelLimit ?? chart.configuredModelLimit
  const limitLabel = labelLimit === null ? '' : formatTokenK(labelLimit)
  const free = slices.find(slice => slice.id === 'free') ?? null
  const reserve = slices.find(slice => slice.id === 'reserve') ?? null
  const content = slices.filter(slice => isGroup(slice.id) || slice.id === 'other').filter(slice => slice.value > 0).map(slice => ({ id: slice.id as ContextGroup | 'other', value: slice.value }))
  const usedTotal = content.reduce((sum, item) => sum + item.value, 0)
  const colour: Record<string, string> = {
    tool: 'var(--cmv-blue)', message: 'var(--cmv-green)', instruction: 'var(--cmv-amber)',
    summary: 'var(--dsw-alias-label-deep-diving)', other: 'color-mix(in srgb,var(--cmv-blue) 32%,var(--dsw-alias-bg-layer-1))',
  }
  const donutStops: string[] = []
  let cursor = 0
  for (const item of content) {
    const next = cursor + (usedTotal === 0 ? 0 : item.value / usedTotal * 100)
    donutStops.push(`${colour[item.id] ?? 'var(--cmv-gray)'} ${cursor.toFixed(2)}% ${next.toFixed(2)}%`)
    cursor = next
  }
  const reading = [
    { id: 'used' as const, label: t('used'), value: chart.used, known: true, share: formatPercent(chart.used, window), title: `${t('used')} ≈ ${formatTokens(chart.used)} ${t('tokens')} · ${formatPercent(chart.used, window)}` },
    { id: 'free' as const, label: t('free'), value: free?.value ?? null, known: free !== null, share: free === null ? t('valueUnknown') : formatPercent(free.value, window), title: free === null ? t('freeUnknown') : sliceLabel(free) },
    { id: 'reserve' as const, label: t('reserve'), value: reserve?.value ?? null, known: reserve !== null, share: reserve === null ? t('valueUnknown') : formatPercent(reserve.value, window), title: reserve === null ? t('reserveUnknown') : `${t('reserveTooltip')} · ${t('gate')} ${formatPercent(chart.limit, window)}` },
  ]
  return <article className="cmv-card cmv-composition">
    <div className="cmv-heading"><div className="cmv-context-title"><h3>{t('compositionTitle')}</h3>{data.model && <Tooltip label={`${t('effort')} ${data.model.effort ?? '—'}`}><span tabIndex={0} className="cmv-muted cmv-model">{data.model.provider} / {data.model.model}</span></Tooltip>}</div><span className="cmv-muted">{stale ? t('lastRead') : `${t('current')} · ${t('estimateShort')}`}</span></div>
    <div className="cmv-composition-line">
      <Tooltip label={`${t('used')} ≈ ${formatTokens(chart.used)} ${t('tokens')} · ${t('windowBasis')} ${window === null ? t('unknownWindow') : `${formatCapacity(window)} ${t('tokens')}`}`}><div tabIndex={0} className="cmv-number"><strong>≈ {formatTokens(chart.used)} {t('tokens')}</strong><span>/ {window === null ? `— ${t('tokens')}` : `${formatCapacity(window)} ${t('tokens')}`}</span><b>{formatPercent(chart.used,window)}</b></div></Tooltip>
      <div className="cmv-capacity-readout" role="group" aria-label={t('capacity')}>
        {reading.map(item => <span key={item.id} data-slice={item.id} data-value={item.known && item.value !== null ? item.value : 'unknown'} title={item.title}>
          {item.known ? <i data-color={item.id}/> : <i data-unknown-color={item.id}/>}
          <span className="cmv-readout-label">{item.label}</span>
          <strong>{item.known && item.value !== null ? formatTokens(item.value) : '—'}</strong>
          <small>{item.share}</small>
        </span>)}
      </div>
    </div>
    <div className="cmv-capacity-track">
      <div className="cmv-stack cmv-capacity-stack" role="group" aria-label={t('windowBasis')} data-total={chart.total} data-capacity={window}>
        {window !== null && slices.filter(slice => slice.value > 0).map(slice => <Tooltip key={slice.id} label={slice.id === 'reserve' ? `${t('reserveTooltip')} · ${formatTokens(slice.value)} ${t('tokens')} · ${formatPercent(slice.value,window)}` : sliceLabel(slice)} side="bottom">
          {isGroup(slice.id) ? <button type="button" data-color={slice.id} style={{ width: `${slice.value / chart.total * 100}%` }} aria-label={sliceLabel(slice)} onClick={() => { if (isGroup(slice.id)) onGroup(slice.id) }}><span className="cmv-segment-label" aria-hidden="true">{formatPercent(slice.value, window)}</span></button> : <span data-color={slice.id} role="img" aria-label={sliceLabel(slice)} style={{ width: `${slice.value / chart.total * 100}%` }} tabIndex={0}><span className="cmv-segment-label" aria-hidden="true">{formatPercent(slice.value, window)}</span></span>}
        </Tooltip>)}
      </div>
      {chart.modelLimit !== null && window !== null && <Tooltip label={`${t('modelContextLimit')} · ${formatTokenK(chart.modelLimit)}`} side="bottom">
        <span className="cmv-model-limit-marker" data-model-context-limit={chart.modelLimit} style={{ left: `${chart.modelLimit / window * 100}%` }} role="img" aria-label={`${t('modelContextLimit')} · ${limitLabel}`} />
      </Tooltip>}
    </div>
    {chart.configuredModelLimit !== null && <div className="cmv-model-limit-caption"><span>{t('modelContextLimit')} · {limitLabel}</span>{chart.modelLimit !== null && <span className="cmv-model-limit-legend"><i data-color="model-capped"/>{t('modelCapped')}</span>}{chart.reserveUnknown && <span className="cmv-model-limit-legend"><i data-color="unknown-space"/>{t('unknownSpace')}</span>}{chart.waitingModelWindow && <span>{t('waitingCurrentWindow')}</span>}</div>}
    <div className="cmv-composition-body">
      <Tooltip label={t('compositionDonutHint')}><div className="cmv-donut cmv-composition-donut" role="img" aria-label={`${t('contentBasis')} ${formatTokens(usedTotal)} ${t('tokens')}`} style={{ background: usedTotal > 0 ? `conic-gradient(${donutStops.join(',')})` : undefined }}><span><strong>{formatTokens(usedTotal)}</strong><small>{t('contentBasis')}</small></span></div></Tooltip>
      <ul className="cmv-category-bars">{content.map(item => <li key={item.id} data-cat={item.id}>
        <button type="button" className="cmv-cat-filter" disabled={item.id === 'other'} title={item.id === 'other' ? undefined : t('filterGroupHint')} onClick={() => { if (item.id !== 'other') onGroup(item.id) }}>
          <i data-color={item.id}/><span>{t(item.id as InspectorLocaleKey)}</span>
        </button>
        <span className="cmv-category-track" aria-hidden="true"><span style={{ width: `${usedTotal === 0 ? 0 : item.value / usedTotal * 100}%` }}/></span>
        <span className="cmv-category-token">{formatTokens(item.value)}</span>
        <small className="cmv-category-share">{usedTotal === 0 ? '—' : `${(item.value / usedTotal * 100).toFixed(1)}%`}</small>
      </li>)}</ul>
    </div>
    <div className="cmv-between cmv-muted"><Tooltip label={`${t('estimateHint')}${chart.measured === null ? '' : ` ${t('hostOccupancy')} ${formatPercent(chart.measured,window)}`}`}><span tabIndex={0}>{t('estimate')} · {data.activeCount} {t('items')} · {t('reserved')} {formatPercent(outputReserve,window)}</span></Tooltip>{window === null ? <span>{t('unknownWindow')}</span> : chart.overflow ? <span>{t('overflow')} ≈ {formatPercent(chart.used - window,window)}</span> : <Tooltip label={t(chart.limit === null ? 'availableHint' : 'freeHint')}><span tabIndex={0}>{t('windowBasis')} · 100%</span></Tooltip>}</div>
  </article>
}

/** Recorded host projections only; compaction markers come from the applied entries. */
export function PressureTrend({ data, t, onCut }: { data: Inspection; t: InspectorText; onCut: (seq: number) => void }) {
  const points = data.pressureHistory ?? []
  const window = contextWindow(data) ?? points.at(-1)?.window ?? null
  const known = points.filter(point => typeof point.tokens === 'number' && point.tokens !== null)
  const peak = known.reduce((max, point) => Math.max(max, point.tokens!), 0)
  const scale = Math.max(window ?? 0, peak, 1)
  const first = points[0]?.time ?? 0
  const last = points.at(-1)?.time ?? 0
  const axisTime = new Date(first).toDateString() === new Date(last).toDateString() ? formatTime : recordTime
  const span = Math.max(1, last - first)
  const [width, setWidth] = useState(900)
  const plot = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const element = plot.current
    if (!element || typeof ResizeObserver === 'undefined') return
    const measure = () => setWidth(Math.max(260, Math.round(element.clientWidth) || 900))
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(element)
    return () => observer.disconnect()
  }, [])
  const PAD_LEFT = 40, PAD_RIGHT = 12, TOP = 8, BOTTOM = 20
  const height = 132
  const x = (time: number) => PAD_LEFT + Math.max(0, Math.min(1, (time - first) / span)) * Math.max(10, width - PAD_LEFT - PAD_RIGHT)
  const y = (tokens: number) => TOP + (1 - Math.max(0, Math.min(1, tokens / scale))) * (height - TOP - BOTTOM)
  const segments: string[][] = []
  let current: string[] = []
  for (const point of points) {
    if (point.tokens === null) { if (current.length > 0) segments.push(current); current = []; continue }
    current.push(`${x(point.time).toFixed(1)},${y(point.tokens).toFixed(1)}`)
  }
  if (current.length > 0) segments.push(current)
  const ticks = [...new Set([0, scale / 2, scale, ...(window !== null && window < scale ? [window] : [])].map(value => Math.round(value)))].sort((a, b) => a - b)
  const markers = data.compactions.filter(entry => entry.kind === 'compact' && entry.applied && entry.startedAt >= first && entry.startedAt <= last)
  const latestMarker = markers.at(-1)
  const markerDelta = latestMarker && latestMarker.beforeTokens !== undefined && latestMarker.afterTokens !== undefined ? latestMarker.beforeTokens - latestMarker.afterTokens : null
  const triggerLabel = (entry: Inspection['compactions'][number]) => t(entry.trigger === 'idle' ? 'triggerIdle' : entry.trigger === 'pressure' ? 'triggerPressure' : entry.trigger === 'overflow' ? 'triggerOverflow' : entry.trigger === 'manual' ? 'triggerManual' : entry.manual ? 'betweenTurns' : 'duringTask')
  return <article className="cmv-card cmv-trend"><div className="cmv-heading"><h3>{t('contextChange')}</h3><Tooltip label={t('trendHint')}><span tabIndex={0} className="cmv-muted">{t('estimateShort')}</span></Tooltip></div>
    {known.length === 0 ? <div className="cmv-empty">{t('noTrend')}</div> : <>
      <div className="cmv-trend-plot" ref={plot}>
        <svg className="cmv-trend-svg" viewBox={`0 0 ${width} ${height}`} role="img" aria-label={`${t('contextChange')} ${formatTokens(known.at(-1)!.tokens)} ${t('tokens')}`}>
          <line x1={PAD_LEFT} y1={y(0).toFixed(1)} x2={width - PAD_RIGHT} y2={y(0).toFixed(1)} className="cmv-trend-base"/>
          {ticks.map(value => <g key={value}>
            <line x1={PAD_LEFT} y1={y(value).toFixed(1)} x2={width - PAD_RIGHT} y2={y(value).toFixed(1)} className={value === window ? 'cmv-trend-top' : 'cmv-trend-tick'}/>
            <text x={PAD_LEFT - 6} y={(y(value) + 3).toFixed(1)} textAnchor="end" className="cmv-trend-ticklabel">{formatCapacity(value)}</text>
          </g>)}
          {markers.map(entry => <g key={entry.id}>
            <line x1={x(entry.startedAt).toFixed(1)} y1={TOP} x2={x(entry.startedAt).toFixed(1)} y2={height - BOTTOM} className="cmv-trend-marker"/>
            <circle cx={x(entry.startedAt).toFixed(1)} cy={TOP + 2} r="2.4" className="cmv-trend-marker-dot"/>
          </g>)}
          {segments.map((segment, index) => segment.length > 1 && <g key={index}>
            <path d={`M${segment.join(' L')} L${segment.at(-1)!.split(',')[0]},${height - BOTTOM} L${segment[0]!.split(',')[0]},${height - BOTTOM} Z`} className="cmv-trend-area"/>
            <path d={`M${segment.join(' L')}`} className="cmv-trend-line" fill="none"/>
          </g>)}
          {points.filter(point => point.tokens !== null).map(point => <circle key={point.seq} cx={x(point.time).toFixed(1)} cy={y(point.tokens!).toFixed(1)} r="2.6" className="cmv-trend-point" role="button" tabIndex={0} aria-label={`${t('record')} ${point.seq} ${t(point.kind === 'reply' ? 'reply' : point.kind === 'replace' ? 'replacement' : 'cut')} ${formatTokens(point.tokens)} ${t('tokens')} · ${formatPercent(point.tokens, point.window ?? window)}`} onClick={() => onCut(point.seq)} onKeyDown={event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); onCut(point.seq) } }}/>)}
        </svg>
      </div>
      <div className="cmv-trend-axis"><span>{axisTime(first)}</span><span>{axisTime(last)}</span></div>
      <div className="cmv-trend-legend"><span data-kind="used"><i data-color="used"/>{t('contextEstimate')}</span><span data-kind="event"><i data-color="marker"/>{t('compactionEvents')}</span>{latestMarker && <span className="cmv-muted">{triggerLabel(latestMarker)}{markerDelta === null ? '' : ` · ${markerDelta > 0 ? '-' : markerDelta < 0 ? '+' : ''}${formatTokens(Math.abs(markerDelta))}`}</span>}</div>
      <p className="cmv-muted cmv-trend-hint">{t('trendScaleHint')} {formatTokens(peak)} / {window === null ? t('unknownWindow') : formatCapacity(window)}{window !== null && peak > window ? ` · ${t('trendOverflowHint')}` : ''}</p>
    </>}
  </article>
}

type CompactionEntry = Inspection['compactions'][number]
function compactionSource(entry: CompactionEntry, historical: boolean) {
  const sources = { idle: 'triggerIdle', pressure: 'triggerPressure', overflow: 'triggerOverflow', manual: 'triggerManual' } as const
  return entry.kind === 'prune' ? 'toolCleanup' : !historical && entry.trigger ? sources[entry.trigger] : entry.manual ? 'betweenTurns' : 'duringTask'
}
const entryStatus = (entry: CompactionEntry) => entry.status === 'completed' ? 'completed' : entry.status === 'failed' ? 'failed' : entry.status === 'interrupted' ? 'interrupted' : entry.status === 'unapplied' ? 'unapplied' : 'running'
const callPurposeKey = (purpose: 'summary' | 'repair' | 'recovery' | 'unknown') => purpose === 'summary' ? 'compactionCallSummary' : purpose === 'repair' ? 'compactionCallRepair' : purpose === 'recovery' ? 'compactionCallRecovery' : 'compactionCallUnknown'
const callStatusKey = (status: 'started' | 'generated' | 'failed' | 'cancelled' | 'not_dispatched') => status === 'started' ? 'compactionCallStarted' : status === 'generated' ? 'compactionCallGenerated' : status === 'failed' ? 'compactionCallFailed' : status === 'cancelled' ? 'compactionCallCancelled' : 'compactionCallNotDispatched'
function requestParts(row: NonNullable<Inspection['efficiency']>['requests'][number]) {
  const fields = [row.uncachedInput, row.cacheRead, row.cacheWrite, row.output]
  const known = fields.filter((value): value is number => value !== null)
  return { total: known.reduce((sum, value) => sum + value, 0), missing: fields.length - known.length }
}
function RecordedRequest({ row, t, includeMaintenance = false }: { row: NonNullable<Inspection['efficiency']>['requests'][number]; t: InspectorText; includeMaintenance?: boolean }) {
  const parts = requestParts(row)
  const price = estimateRequestReferenceCost(row, includeMaintenance)
  return <div className="cmv-compaction-request-row">
    <div><strong>{row.provider} · {row.model}</strong><span>seq {row.seq} · {row.turn}/{row.step}{row.retry > 0 ? ` · ${t('teamRetries')} ${row.retry}` : ''}</span></div>
    <span>{parts.missing > 0 ? '≥ ' : ''}{formatTokens(parts.total)} Token · {t('uncached')} {formatTokens(row.uncachedInput)} · {t('read')} {formatTokens(row.cacheRead)} · {t('write')} {formatTokens(row.cacheWrite)} · {t('output')} {formatTokens(row.output)}</span>
    <small>{t('requestRangeReferenceCost')} {price.total === null ? `— · ${t('costUnknown')}` : `${price.partial ? '≥ ' : ''}${money(price.total)}`}</small>
  </div>
}

function CompactionUsageDetails({ entry, data, t }: { entry: CompactionEntry; data: Inspection; t: InspectorText }) {
  const efficiency = data.efficiency
  const requests = efficiency?.requests ?? []
  const calls = 'summaryCalls' in entry ? entry.summaryCalls : undefined
  const callCoverage = 'summaryCallCoverage' in entry ? entry.summaryCallCoverage : undefined
  const compression = compactionRequestRange(data.compactions, entry.id, requests)
  const following = postCheckpointRequestRange(data.compactions, entry.id, data.cutSeq, requests)
  const summarize = (rows: typeof requests, includeMaintenance = false) => {
    let total = 0, missing = 0, costTotal = 0, priced = 0, costPartial = false
    for (const row of rows) {
      const parts = requestParts(row); total += parts.total; missing += parts.missing
      const cost = estimateRequestReferenceCost(row, includeMaintenance)
      if (cost.total !== null) { costTotal += cost.total; priced++ }
      if (cost.partial || cost.total === null) costPartial = true
    }
    return { total, missing, costTotal: priced > 0 ? costTotal : null, costPartial }
  }
  const compressionTotal = compression ? summarize(compression.rows, true) : null
  const followingTotal = following ? summarize(following.rows) : null
  const compactionSourceRows = compression?.rows ?? []
  return <div className="cmv-compaction-usage-details">
    <details className="cmv-request-details"><summary>{t('compactionCalls')}</summary><div>
      {calls?.length ? <>
        {calls.map((call, index) => <p key={index}>{t(callPurposeKey(call.purpose))} · {t(callStatusKey(call.status))} · {t('input')} {call.input === null ? '—' : formatTokens(call.input)} · {t('read')} {call.cacheRead === null ? '—' : formatTokens(call.cacheRead)} · {t('write')} {call.cacheWrite === null ? '—' : formatTokens(call.cacheWrite)} · {t('output')} {call.output === null ? '—' : formatTokens(call.output)}</p>)}
        <p className="cmv-muted">{t('teamSummaryCacheNote')}</p>
      </> : <p className="cmv-muted">{t('unknownUsage')}</p>}
      {callCoverage !== undefined && callCoverage !== 'complete' && <p className="cmv-muted">{t('compactionUsageCoverage')}</p>}
    </div></details>
    <details className="cmv-request-details"><summary>{t('compactionRange')}{compression ? ` · ${compression.startSeq}–${compression.endSeq}` : ''}</summary><div>
      {!compression ? <p className="cmv-muted">{t('requestRangeNoCheckpoint')}</p> : <>
        <p>{t('requestRangeTotal')} {compressionTotal!.missing > 0 || compression.truncated ? '≥ ' : ''}{formatTokens(compressionTotal!.total)} Token · {t('requestRangeReferenceCost')} {compressionTotal!.costTotal === null ? `— · ${t('costUnknown')}` : `${compressionTotal!.costPartial || compression.truncated ? '≥ ' : ''}${money(compressionTotal!.costTotal)}`}</p>
        {compression.truncated && <p className="cmv-muted">{t('requestRangeTruncated')}</p>}
        {compactionSourceRows.length ? compactionSourceRows.map(row => <RecordedRequest key={row.seq} row={row} t={t} includeMaintenance/>) : <p className="cmv-muted">{t('requestRangeNoRecords')}</p>}
      </>}
    </div></details>
    {entry.applied && <details className="cmv-request-details"><summary>{t('postCheckpointRequests')}</summary><div>
      {!following ? <p className="cmv-muted">{t('requestRangeNoCheckpoint')}</p> : !following.boundaryKnown
        ? <p className="cmv-muted">{t('requestRangeBoundaryUnknown')}</p> : <>
        <p>{t('compactionRange')} · {following.startSeq}–{Math.max(following.startSeq, following.endSeq - 1)} · {t('requestRangeTotal')} {followingTotal!.missing > 0 || following.truncated ? '≥ ' : ''}{formatTokens(followingTotal!.total)} Token · {t('requestRangeReferenceCost')} {followingTotal!.costTotal === null ? `— · ${t('costUnknown')}` : `${followingTotal!.costPartial || following.truncated ? '≥ ' : ''}${money(followingTotal!.costTotal)}`}</p>
        {following.truncated && <p className="cmv-muted">{t('requestRangeTruncated')}</p>}
        {following.rows.length ? following.rows.map(row => <RecordedRequest key={row.seq} row={row} t={t}/>) : <p className="cmv-muted">{t('requestRangeNoRecords')}</p>}
      </>}
    </div></details>}
  </div>
}
/** A failed attempt or tool cleanup must not hide the last applied summary. */
export function CompactionChart({ data, t, onRecord, onInspect }: { data: Inspection; t: InspectorText; onRecord: () => void; onInspect?: (row: ContentRow) => void }) {
  const entry = data.compactions.findLast(item => item.kind === 'compact' && item.applied && item.checkpoint)
  const latestAttempt = data.compactions.at(-1)
  const known = entry?.applied && entry.beforeTokens !== undefined && entry.afterTokens !== undefined
  const window = entry?.beforeTokens && entry.beforeTokens > 0 ? entry.beforeTokens : null
  const maximum = Math.max(window ?? 1, entry?.beforeTokens ?? 0, entry?.afterTokens ?? 0)
  const delta = known ? entry.beforeTokens! - entry.afterTokens! : null
  const duration = entry?.endedAt !== undefined && entry.endedAt >= entry.startedAt ? `${((entry.endedAt - entry.startedAt) / 1000).toFixed(1)} s` : entry?.status === 'running' ? t('running') : t('unknown')
  return <article className="cmv-card cmv-compactions" data-compaction-id={entry?.id}><div className="cmv-heading"><h3>{t('latestPanel')}</h3>{entry && <span className="cmv-chips-inline"><span className="cmv-chip" data-tone={entry.status === 'completed' ? 'done' : 'warn'}>{t(entryStatus(entry))}</span><span className="cmv-chip">{t(compactionSource(entry, data.historical))}</span><time className="cmv-muted" dateTime={new Date(entry.startedAt).toISOString()}>{formatTime(entry.startedAt)}</time></span>}</div>
    {!entry ? <div className="cmv-empty">{t('noAppliedSummary')}</div> : <>
      <div className="cmv-compaction-hero"><div>
        <p className="cmv-muted cmv-segment-note">{t('segmentNote')}</p>
        {known ? <><div className="cmv-compare"><span>{t('before')}</span><div><i data-color="tool" style={{ width: window === null ? '0%' : `${entry.beforeTokens! / maximum * 100}%` }}/></div><b>{formatTokens(entry.beforeTokens)} <small>{t('tokens')}</small></b></div>
          <div className="cmv-compare"><span>{t('after')}</span><div><i data-color="summary" style={{ width: window === null ? '0%' : `${entry.afterTokens! / maximum * 100}%` }}/></div><b>{formatTokens(entry.afterTokens)} <small>{t('tokens')}</small></b></div></> : <p className="cmv-muted">{t('unknownUsage')}</p>}
      </div><div className="cmv-compaction-facts">
        {known && <div className="cmv-reduction-badge" data-delta={delta! > 0 ? 'reduced' : delta! < 0 ? 'increased' : 'unchanged'}><strong>{delta === 0 ? '0' : `${delta! > 0 ? '-' : '+'}${formatTokens(Math.abs(delta!))}`}</strong><span>{delta! > 0 ? t('reduced') : delta! < 0 ? t('increased') : t('unchanged')} · {formatPercent(Math.abs(delta!), window)}</span></div>}
        <dl className="cmv-fact-list">
          <div><dt>{t('sourceRecords')}</dt><dd>{entry.messages === undefined ? '—' : `${entry.messages} ${t('sourceMessages')}`}</dd></div>
          <div><dt>{t('duration')}</dt><dd>{duration}</dd></div>
          <div><dt>{t('summaryOutput')}</dt><dd>{entry.outputTokens === undefined ? '—' : `${formatTokens(entry.outputTokens)} ${t('tokens')}`}</dd></div>
        </dl>
      </div></div>
      {entry.status === 'failed' && <p role="status">{t('committedFailure')}</p>}
    </>}
    {latestAttempt && latestAttempt.id !== entry?.id && <p className="cmv-muted cmv-latest-attempt" role="status">{t('latestAttempt')} · {t(entryStatus(latestAttempt))}{latestAttempt.modelCallStatus === 'not_dispatched' ? ` · ${t('notDispatched')}` : ''}</p>}
    <div className="cmv-compaction-actions">{entry?.checkpoint && onInspect && <Button size="sm" variant="primary" onClick={() => entry.checkpoint && onInspect(entry.checkpoint)}>{t('viewSummarySources')}</Button>}<Button size="sm" variant="outline" onClick={onRecord}>{t('recordDetails')}</Button><span className="cmv-muted cmv-actions-note">{t('summaryReadHint')}</span></div>
  </article>
}

export function CompactionRecords({ data, t, openLatest, onInspect }: { data: Inspection; t: InspectorText; openLatest: number; onInspect?: (row: ContentRow) => void }) {
  const [expanded, setExpanded] = useState(false)
  const entries = [...data.compactions].reverse()
  return <article className="cmv-card cmv-records"><div className="cmv-heading"><h3>{t('recordList')}</h3>{entries.length > 2 && <Button size="sm" variant="ghost" aria-expanded={expanded} onClick={() => setExpanded(!expanded)}>{t(expanded ? 'collapse' : 'allRecords')}</Button>}</div>
    <p className="cmv-muted cmv-timeline-hint">{t('timelineHint')}</p>
    {!entries.length ? <p className="cmv-muted">{t('noCompaction')}</p> : <ol className="cmv-events">{(expanded ? entries : entries.slice(0, 2)).map((entry, index) => <li key={entry.id} data-status={entry.status} data-applied={entry.applied}><details key={`${entry.id}:${index === 0 ? openLatest : 0}`} open={index === 0 && openLatest > 0 ? true : undefined}>
      <summary><span>{recordTime(entry.startedAt)} · {t(compactionSource(entry, data.historical))}</span><span className="cmv-event-status">{t(entry.status)}</span><span>{entry.applied && entry.beforeTokens !== undefined && entry.afterTokens !== undefined ? `${formatTokens(entry.beforeTokens)} ${t('tokens')} → ${formatTokens(entry.afterTokens)} ${t('tokens')} · ${formatPercent(entry.afterTokens,entry.beforeTokens)}` : entry.modelCallStatus==='not_dispatched'?t('notDispatched'):t('unknownUsage')}</span></summary>
      <div className="cmv-record-detail">{entry.applied && entry.beforeTokens !== undefined && entry.afterTokens !== undefined && <p>{t(entry.beforeTokens >= entry.afterTokens ? 'reduced' : 'increased')} {formatTokens(Math.abs(entry.beforeTokens - entry.afterTokens))} {t('tokens')} · {formatPercent(Math.abs(entry.beforeTokens - entry.afterTokens),entry.beforeTokens)}</p>}<p>{t('segment')} · {t('compactions')} {formatTokens(entry.beforeTokens)} → {formatTokens(entry.afterTokens)} {t('tokens')}</p><p>{t('input')} {formatTokens(entry.inputTokens)} · {t('output')} {formatTokens(entry.outputTokens)} {t('tokens')}{entry.endedAt === undefined ? '' : ` · ${((entry.endedAt - entry.startedAt) / 1000).toFixed(1)}s`}</p>
        {entry.status === 'failed' && entry.applied && <p role="status">{t('committedFailure')}</p>}{entry.error && <p className="cmv-error">{entry.error}</p>}{entry.execution && <p>{entry.execution}</p>}
        {entry.kind === 'compact' && <CompactionUsageDetails entry={entry} data={data} t={t}/>}
        {entry.checkpoint && onInspect && <Button size="sm" variant="outline" onClick={() => entry.checkpoint && onInspect(entry.checkpoint)}>{t('viewCheckpoint')}</Button>}
      </div></details></li>)}</ol>}
  </article>
}

/** A known sum with unreported samples is a lower bound, never a precise bill. */
const lowerBound = (fields: readonly FieldTotalReadout[]) => fields.some(field => field.missing > 0)

/**
 * Current-cut attribution only. The four buckets are mutually exclusive, so
 * their per-bucket sums add up to every component that was actually reported;
 * the derived cache-inclusive input covers complete input samples only and must
 * never stand in for that lower bound. The Host projection is quoted when it
 * exists, but completeness is judged from the fold's own reported/missing and
 * unknown-attempt counts: neither source proves a complete bill, so an
 * incomplete reading is shown as a bound with its unknowns, and a cut with
 * nothing reported shows unknown instead of a fabricated zero.
 */
function EfficiencyLine({ efficiency, t }: { efficiency: EfficiencyReadout; t: InspectorText }) {
  const host = efficiency.host
  const mirrored = efficiency.mirrored
  const components = [mirrored.uncachedInput, mirrored.cacheRead, mirrored.cacheWrite, mirrored.output]
  const componentSum = components.reduce((total, field) => total + field.sum, 0)
  const anyReported = components.some(field => field.reported > 0)
  const hostTotal = host === null ? null : host.uncachedInputTokens + host.cacheReadTokens + host.cacheWriteTokens + host.outputTokens
  const business = Math.max(hostTotal ?? 0, componentSum)
  // A Host projection with zero fields is not evidence of zero usage when the
  // event fold has only unknown attempts. Explicitly reported component zeros
  // remain known, including a complete zero-usage cut.
  const known = anyReported || (hostTotal !== null && hostTotal > 0)
  const bounded = !mirrored.complete || lowerBound(components)
  const source = host === null ? t('effEventSource') : t('effHostSource')
  const difference = efficiency.differences.length > 0 ? t('effDifference') : t('effNoDifference')
  const usageAmount = (field: FieldTotalReadout) => field.reported === 0
    ? `— ${t('effUnknownValue')}`
    : `${field.missing > 0 ? '≥ ' : ''}${exactTokens(field.sum)}`
  const componentsHint = components.map((field, index) => `${t((['uncached', 'read', 'write', 'output'] as const)[index]!)} ${usageAmount(field)}${field.missing > 0 ? ` (${field.missing} ${t('effUnknownValue')})` : ''}`).join(' · ')
  const maintenance = efficiency.summaryAndRepair
  const maintenanceTotal = maintenance === null ? null : maintenance.input + maintenance.output
  const maintenanceUnknown = maintenance !== null && maintenance.unknownAttempts > 0
  const maintenanceDisplay = maintenanceTotal === null ? '—' : maintenanceUnknown
    ? maintenanceTotal > 0 ? '≥ ' + formatTokens(maintenanceTotal) + ' Token' : '— ' + t('effUnknownValue')
    : '≈ ' + formatTokens(maintenanceTotal) + ' Token'
  const maintenanceValue = (value: number) => maintenanceUnknown ? value > 0 ? '≥ ' + exactTokens(value) : '—' : exactTokens(value)
  return <>
    <p className="cmv-muted cmv-summary-usage" data-efficiency={efficiency.accounting} data-bounded={String(bounded)}><Tooltip label={`${source} · ${difference} · ${t('usageHint')}`}>
      <span tabIndex={0}>{t('effBusiness')} {known ? `${bounded ? '≥ ' : '≈ '}${formatTokens(business)} Token` : `— ${t('effUnknownValue')}`}</span></Tooltip>
      <span> · {t('effMaintenance')} {maintenanceDisplay}</span>
      <span> · {t('effUnknownRuns')} {exactTokens(mirrored.withoutUsage)}{mirrored.retries > 0 ? ` · ${t('effRetryCount')} ${exactTokens(mirrored.retries)}` : ''}{host === null ? ` · ${t('effEventSource')}` : ''}{efficiency.cacheHitRatio === null ? ` · ${t('effCacheUnknown')}` : ''}</span>
    </p>
    <details className="cmv-request-details"><summary>{t('details')} · {t('effLine')}</summary>
      <div>
        <p className="cmv-muted" data-attribution-source={efficiency.accounting}>{source} · {difference}{bounded ? ` · ${t('effBoundHint')}` : ''}{host === null ? ` ${t('effEventHint')}` : ''}</p>
        <dl className="cmv-usage-legend">{components.map((field, index) => <div key={index}><dt>{t((['uncached', 'read', 'write', 'output'] as const)[index]!)}</dt><dd>{usageAmount(field)}<small>{field.reported} {t('record')}{field.missing > 0 ? ` · ${field.missing} ${t('effUnknownValue')}` : ''}</small></dd></div>)}</dl>
        <p className="cmv-muted" data-known-bound={componentSum}>{known ? `${t('effBusiness')} ${bounded ? '≥' : '≈'} ${exactTokens(business)} Token` : `${t('effBusiness')} —`} · {componentsHint}</p>
        <p className="cmv-muted">{t('effInclusiveNote')} {usageAmount(mirrored.cacheInclusiveInput)} Token · {mirrored.cacheInclusiveInput.reported} {t('record')}{mirrored.cacheInclusiveInput.missing > 0 ? ` · ${mirrored.cacheInclusiveInput.missing} ${t('effUnknownValue')}` : ''}</p>
        {efficiency.differences.map(item => <p key={item.field} className="cmv-muted">{item.field} · {t('effDifference')} {item.delta > 0 ? '+' : ''}{exactTokens(item.delta)} Token</p>)}
        {maintenance !== null && <p className="cmv-muted" data-maintenance-split={String(maintenance.purposeSplit)}>{t('effPurposeUndivided')} · {maintenanceValue(maintenance.input)} + {maintenanceValue(maintenance.output)} Token · {maintenance.attempts} {t('summaryCalls')}{maintenance.unknownAttempts > 0 ? ` · ${maintenance.unknownAttempts} ${t('summaryUnknown')}` : ''} · {t('effLedgerInputNote')}</p>}
        {efficiency.maintenanceSuspects > 0 && <p className="cmv-muted">{efficiency.maintenanceSuspects} {t('effSuspects')}</p>}
        {efficiency.fingerprint === null ? <p className="cmv-muted">{t('effPrefixOff')}</p> : efficiency.changes.length === 0
          ? <p className="cmv-muted">{t('effPrefixNone')}</p>
          : <div className="cmv-muted"><p>{t('effPrefixChanges')}</p>{efficiency.changes.map(change => <p key={change.seq} data-prefix-change={change.changed.join(',')}>{t('record')} {change.seq} · {change.changed.join(' / ')} · {change.note}</p>)}</div>}
      </div>
    </details>
  </>
}

/** Session-scoped confirmed reduction facts; the run counters stay labelled as process-wide. */
function ReductionLine({ reduction, t }: { reduction: ReductionReadout; t: InspectorText }) {
  const published = reduction.published
  const mode = reduction.mode === 'off' ? t('reductionOff') : reduction.mode === 'observe' ? t('reductionObserve') : t('reductionReduce')
  const skip = reduction.run.lastSkip === null ? null : reduction.run.lastSkip + (reduction.run.lastReason === null ? '' : ` · ${reduction.run.lastReason}`)
  return <>
    <p className="cmv-muted cmv-summary-usage" data-reduction-mode={reduction.mode}><Tooltip label={`${mode} · ${reduction.pipelineReported ? t('reductionPipelineOk') : t('reductionPipelineUnknown')} · ${t('reductionCharsHint')}`}>
      <span tabIndex={0}>{t('reductionTitle')} · {mode}</span></Tooltip>
      <span> · {t('reductionConfirmed')} {exactTokens(published.references)} · {t('reductionRemoved')} {exactTokens(published.visibleCharsRemoved)} {t('characters')}</span>
      <span> · {t('reductionPending')} {exactTokens(reduction.pending)} · {t('reductionReverted')} {exactTokens(reduction.reverted)}</span>
      {!reduction.pipelineReported && <span> · {t('reductionPipelineUnknown')}</span>}
      {reduction.archiveError !== undefined && <span className="cmv-error"> · {t('reductionArchiveError')}：{reduction.archiveError}</span>}
    </p>
    <details className="cmv-request-details"><summary>{t('details')} · {t('reductionTitle')}</summary>
      <div>
        <p className="cmv-muted">{t('reductionCharsHint')}</p>
        <p className="cmv-muted">{reduction.recent.length === 0 ? t('reductionNoRecent') : t('reductionRecent')}</p>
        {reduction.recent.map(owner => <p key={`${owner.contentId}:${owner.callId ?? ''}`} className="cmv-muted" data-reduced-chars={owner.shortenedChars} data-call-id={owner.callId ?? ''}>{owner.tool} · {owner.contentId} · {exactTokens(owner.shortenedChars)} {t('characters')}{owner.complete ? '' : ` · ${t('reductionRowTruncated')}`}</p>)}
        <p className="cmv-muted" data-run-scope="process">{t('reductionRunScope')} · {t('runConsidered')} {exactTokens(reduction.run.considered)} · {t('runWouldReduce')} {exactTokens(reduction.run.wouldReduce)} · {t('runSkipped')} {exactTokens(reduction.run.skipped)} · {t('runUnverified')} {exactTokens(reduction.run.unverified)} · {t('failed')} {exactTokens(reduction.run.failed)}</p>
        {skip !== null && <p className="cmv-muted">{t('reductionSkip')}：{skip}</p>}
        {reduction.notes.map((note, index) => <p key={index} className="cmv-muted">{note}</p>)}
      </div>
    </details>
  </>
}

const money = (value: number) => `¥${value.toLocaleString('zh-CN', { maximumFractionDigits: 6 })}`

function TeamMemberDetails({ member, api, t, renderContent }: { member: TeamUsageMemberReadout; api: InspectorApi; t: InspectorText; renderContent?: (data: Inspection, row: ContentRow) => ReactNode }) {
  const [open, setOpen] = useState(false)
  const [inspection, setInspection] = useState<Inspection | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [retry, setRetry] = useState(0)
  useEffect(() => {
    if (!open || member.status !== 'ready') { setInspection(null); setLoading(false); setError(''); return }
    const controller = new AbortController()
    setLoading(true); setError('')
    void api.inspect({ sessionId: member.sessionId, ...defaultQuery }, controller.signal).then(value => {
      if (!controller.signal.aborted) setInspection(value)
    }).catch(() => { if (!controller.signal.aborted) setError(t('error')) })
      .finally(() => { if (!controller.signal.aborted) setLoading(false) })
    return () => controller.abort()
  }, [api, member.sessionId, member.status, open, retry, t])
  const checkpoint = inspection?.compactions.findLast(entry => entry.kind === 'compact' && entry.applied && entry.checkpoint)?.checkpoint
  const parts = inspection?.parts ?? []
  return <>
    <button type="button" className="cmv-team-member-more" aria-expanded={open} disabled={member.status !== 'ready'} onClick={() => setOpen(value => !value)}>{t('teamDetails')}</button>
    {open && <div className="cmv-team-member-detail">
      {loading ? <p className="cmv-muted">{t('summaryLoading')}</p> : error ? <div className="cmv-error" role="alert"><p>{error}</p><Button size="sm" onClick={() => setRetry(value => value + 1)}>{t('retry')}</Button></div> : inspection && <>
        <div className="cmv-team-detail-usage"><div className="cmv-team-detail-block"><strong>{t('teamComponents')}</strong>
          <dl className="cmv-team-breakdown"><div><dt>{t('uncached')}</dt><dd>{teamField(member.uncachedInput, t)}</dd></div><div><dt>{t('read')}</dt><dd>{teamField(member.cacheRead, t)}</dd></div><div><dt>{t('write')}</dt><dd>{teamField(member.cacheWrite, t)}</dd></div><div><dt>{t('output')}</dt><dd>{teamField(member.output, t)}</dd></div></dl>
        </div><div className="cmv-team-summary"><strong>{t('teamSummary')}</strong><span>{t('input')} {member.summaryInput === null ? '—' : formatTokens(member.summaryInput)} · {t('read')} {member.summaryCacheRead === null ? '—' : formatTokens(member.summaryCacheRead)} · {t('write')} {member.summaryCacheWrite === null ? '—' : formatTokens(member.summaryCacheWrite)} · {t('output')} {member.summaryOutput === null ? '—' : formatTokens(member.summaryOutput)} · {teamSummaryAmount(member, t)}</span>
          <small>{member.summaryCoverage !== 'complete' ? `${t('teamSummaryCoverage')}${member.summarySince === null ? '' : ` · ${t('teamSummarySince')} ${new Date(member.summarySince).toLocaleDateString()}`} · ${member.summaryAttempts ?? '—'} ${t('summaryCalls')}` : t('teamSummaryCacheNote')}{member.maintenanceSuspects > 0 ? ` · ${t('teamMaintenanceOverlap')}` : ''}</small>
        </div>
        </div>
        <div className="cmv-team-context"><strong>{t('teamContext')}</strong><span>{inspection.model ? `${inspection.model.provider} · ${inspection.model.model}` : t('teamNoModel')}</span>
          {inspection.pressure && <span>{formatTokens(inspection.pressure.projected)} / {formatTokens(inspection.pressure.window)} Token</span>}</div>
        <dl className="cmv-team-breakdown">{parts.map(part => <div key={part.category}><dt>{t(part.category)}</dt><dd>{formatTokens(part.tokens)} <small>{part.count}</small></dd></div>)}</dl>
        <div className="cmv-team-source-list"><strong>{t('teamSummarySources')}</strong>
          {!checkpoint ? <p className="cmv-muted">{t('teamNoSummarySources')}</p> : renderContent ? renderContent(inspection, checkpoint) : <p className="cmv-muted">{t('teamNoSummarySources')}</p>}
        </div>
      </>}
    </div>}
  </>
}

function teamField(field: FieldTotalReadout | null, t: InspectorText) {
  if (field === null || field.reported === 0) return `— · ${t('effUnknownValue')}`
  return `${field.missing > 0 ? '≥ ' : ''}${formatTokens(field.sum)}${field.missing > 0 ? ` · ${field.missing} ${t('effUnknownValue')}` : ''}`
}
function teamSummaryAmount(member: TeamUsageMemberReadout, t: InspectorText) {
  return member.summaryTokens === null ? `— · ${t('teamSummaryUnknown')}`
    : `${member.summaryCoverage !== 'complete' || (member.summaryUnknownAttempts ?? 0) > 0 ? '≥ ' : ''}${formatTokens(member.summaryTokens)} Token`
}

function TeamUsagePanel({ enabled, target, historical, api, t, renderMemberContent }: { enabled: boolean; target?: string; historical: boolean; api?: InspectorApi; t: InspectorText; renderMemberContent?: (data: Inspection, row: ContentRow) => ReactNode }) {
  const [refresh, setRefresh] = useState(0)
  const [readout, setReadout] = useState<TeamUsageReadout | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  useEffect(() => {
    if (!enabled || historical || !api?.teamUsage || !target) { setReadout(null); setLoading(false); setError(''); return }
    const controller = new AbortController()
    setLoading(true); setError('')
    void api.teamUsage({ sessionId: target }, controller.signal).then(value => {
      if (!controller.signal.aborted) setReadout(value)
    }).catch(() => { if (!controller.signal.aborted) setError(t('error')) })
      .finally(() => { if (!controller.signal.aborted) setLoading(false) })
    return () => controller.abort()
  }, [api, enabled, historical, refresh, t, target])
  const current = readout?.targetSessionId === target ? readout : null
  const total = current?.knownTokens ?? 0
  return <section className="cmv-team-usage" data-team-included={enabled}>
    {enabled && current?.status === 'ready' && <div className="cmv-team-controls"><Button size="sm" variant="ghost" disabled={loading} onClick={() => { setReadout(null); setRefresh(value => value + 1) }}>{t('teamRefresh')}</Button></div>}
    {enabled && (loading ? <p className="cmv-muted">{t('teamLoading')}</p> : error ? <p className="cmv-error" role="alert">{error}</p>
      : !current ? null : current.status === 'not-team' ? <p className="cmv-muted">{t('teamNotTeam')}</p>
        : current.status === 'unavailable' ? <p className="cmv-muted">{t('teamUnavailable')}</p>
          : <div className="cmv-team-content">
            <div className="cmv-team-total"><strong>{t('teamKnownTotal')} {current.tokensPartial ? '≥ ' : ''}{formatTokens(current.knownTokens)} Token</strong>
              <span>{current.shareBasis === 'known-subtotal' ? t('teamMemberShare') : `${current.members.length} ${t('teamMember')}`}</span>
              {current.unknownMembers > 0 && <span>{current.unknownMembers} {t('teamUnknownMembers')}</span>}
              <span>{t('teamCost')} {current.referenceCost === null ? `— · ${t('costUnknown')}` : `${current.costPartial ? '≥ ' : ''}${money(current.referenceCost)}`}</span>
            </div>
            {total > 0 && <div className="cmv-stack cmv-team-stack" role="img" aria-label={`${t('teamKnownTotal')} ${formatTokens(total)} Token`}>{current.members.filter(member => member.totalTokens !== null && member.totalTokens > 0).map(member => <span key={member.sessionId} data-team-member={member.sessionId} title={`${member.name} · ${formatTokens(member.totalTokens)} Token`} style={{ width: `${member.totalTokens! / total * 100}%` }}/>)}</div>}
            <p className="cmv-muted cmv-team-cost-note">{t('teamCostHint')}</p>
            <ul className="cmv-team-members">{current.members.map(member => {
              const share = member.totalTokens !== null && total > 0 ? `${(member.totalTokens / total * 100).toFixed(1)}%` : '—'
              const role = member.role === 'lead' ? t('teamLead') : t('teamMember')
              const phase = member.phase === 'active' ? t('teamActive') : member.phase === 'provisioning' ? t('teamProvisioning') : t('teamFailed')
              const shareWidth = member.totalTokens !== null && total > 0 ? member.totalTokens / total * 100 : null
              return <li key={member.sessionId} data-member-status={member.status}>
                <div className="cmv-team-member-heading"><strong>{member.name}</strong><span>{role} · {phase}</span><b>{member.totalTokens === null ? '—' : `${member.tokensPartial ? '≥ ' : ''}${formatTokens(member.totalTokens)} Token · ${share}`}</b></div>
                {shareWidth !== null && <div className="cmv-team-member-sharebar" role="img" aria-label={`${member.name} · ${share}`} title={`${member.name} · ${share}`}><span style={{ width: `${shareWidth}%` }}/></div>}
                {member.status !== 'ready' ? <p className="cmv-muted">{member.status === 'analysis-limit' ? t('teamAnalysisLimit') : t('teamUnavailableMember')}</p> : <>
                  <div className="cmv-team-member-meta"><span>{member.provider && member.model ? `${t('teamModel')} · ${member.provider} / ${member.model}` : t('teamNoModel')}</span><span>{t('teamRequestTokens')} {member.requestTokens === null ? '—' : `${member.requestTokensPartial ? '≥ ' : ''}${formatTokens(member.requestTokens)}`} · {t('teamCacheReadWrite')} {teamField(member.cacheRead, t)} / {teamField(member.cacheWrite, t)} · {t('teamSummary')} {teamSummaryAmount(member, t)}</span><span>{t('teamSettled')} {member.settledAttempts ?? '—'} · {t('teamRetries')} {member.retries ?? '—'}</span><span>{t('cost')} {member.referenceCost === null ? `— · ${t('costUnknown')}` : `${member.costPartial ? '≥ ' : ''}${money(member.referenceCost)}`}</span></div>
                  <TeamMemberDetails member={member} api={api!} t={t} renderContent={renderMemberContent}/>
                </>}
              </li>
            })}</ul>
          </div>)}
  </section>
}

/** Session consumption is disjoint from the current context composition. */
export function UsageComposition({ data, t, api, target, renderMemberContent }: { data: Inspection; t: InspectorText; api?: InspectorApi; target?: string; renderMemberContent?: (data: Inspection, row: ContentRow) => ReactNode }) {
  const chart = usageSlices(data.usage)
  const efficiency = data.efficiency
  const [mode, setMode] = useState<'session' | 'team'>('session')
  const modeTarget = useRef(target)
  useEffect(() => { if (modeTarget.current !== target) { modeTarget.current = target; setMode('session') } }, [target])
  const [usage, setUsage] = useState<{ target: string; value: SessionUsageReadout | null } | null>(null)
  useEffect(() => { if (data.historical) setMode('session') }, [data.historical])
  useEffect(() => {
    if (mode !== 'session' || data.historical || !api?.sessionUsage || !target) { setUsage(null); return }
    const controller = new AbortController()
    void api.sessionUsage({ sessionId: target }, controller.signal).then(value => {
      if (!controller.signal.aborted) setUsage({ target, value })
    }).catch(() => { if (!controller.signal.aborted) setUsage({ target, value: null }) })
    return () => controller.abort()
  }, [api, data.historical, data.cutSeq, data.requestCount, mode, target])
  const cost = mode === 'session' && usage !== null && usage.target === target && !data.historical ? usage.value : null
  const summary = data.historical ? undefined : data.summaryUsage
  const summaryUnknown = summary !== undefined && summary.unknownAttempts > 0
  const summaryTotal = summary ? summary.input + summary.output : null
  const summaryAmount = (value: number) => summaryUnknown ? value > 0 ? '≥ ' + exactTokens(value) : '— ' + t('effUnknownValue') : exactTokens(value)
  const summaryDisplay = summaryTotal === null ? null : summaryUnknown
    ? summaryTotal > 0 ? '≥ ' + formatTokens(summaryTotal) + ' Token' : '— ' + t('effUnknownValue')
    : formatTokens(summaryTotal) + ' Token'
  const labels = ['uncached', 'read', 'write', 'output'] as const
  const completeness = usageCompleteness(data.efficiency)
  const unknownTotal = completeness === 'unknown'
  const boundedTotal = completeness === 'partial'
  const unqualifiedTotal = completeness === null
  const missing = completeness === null || data.efficiency === undefined ? [0, 0, 0, 0]
    : [data.efficiency.mirrored.uncachedInput, data.efficiency.mirrored.cacheRead,
      data.efficiency.mirrored.cacheWrite, data.efficiency.mirrored.output].map(field => field.missing)
  const recent = (efficiency?.requests ?? []).slice(-8)
  const rows = recent.map(row => ({ row, values: [row.uncachedInput, row.cacheRead, row.output] as const }))
  const max = Math.max(1, ...rows.map(item => item.values.reduce<number>((sum, value) => sum + (typeof value === 'number' ? value : 0), 0)))
  const outputSum = efficiency?.host ? efficiency.host.outputTokens : efficiency ? efficiency.mirrored.output.sum : null
  const maintenance = efficiency?.summaryAndRepair ?? null
  const maintenanceValue = maintenance === null ? null : maintenance.input + maintenance.output
  const maintenanceUnknown = maintenance !== null && maintenance.unknownAttempts > 0
  return <article className="cmv-card cmv-usage"><div className="cmv-heading cmv-usage-heading"><h3>{t('requestPanel')}</h3>
      <div className="cmv-usage-mode" role="group" aria-label={t('requestPanel')}>
        <Button size="sm" variant={mode === 'session' ? 'primary' : 'ghost'} aria-pressed={mode === 'session'} onClick={() => setMode('session')}>{t('teamSessionView')}</Button>
        <Button size="sm" variant={mode === 'team' ? 'primary' : 'ghost'} disabled={data.historical || !api?.teamUsage || !target} aria-pressed={mode === 'team'} onClick={() => setMode('team')}>{t('teamAggregateView')}</Button>
      </div>
    </div>
    {mode === 'session' && <div className="cmv-usage-metrics">
        <Tooltip label={t('cacheHitHint')}><span tabIndex={0} className="cmv-chip">{t('cacheHit')} {chart?.hit == null ? '—' : `${Math.round(chart.hit * 10) / 10}%`}</span></Tooltip>
        <Tooltip label={t('cumulativeOutputHint')}><span tabIndex={0} className="cmv-chip">{t('cumulativeOutput')} {outputSum === null ? '—' : `${boundedTotal ? '≥ ' : ''}${formatTokens(outputSum)}`}</span></Tooltip>
      </div>}
    {mode === 'team' ? <TeamUsagePanel key={target} enabled target={target} historical={data.historical} api={api} t={t} renderMemberContent={renderMemberContent}/> : <>
    {!chart ? <div className="cmv-empty">{t('noUsage')}</div> : <div className="cmv-usage-top">
      <div className="cmv-request-values" data-usage-completeness={completeness ?? 'unqualified'}><div className="cmv-number">
        {unknownTotal ? <><strong>—</strong><span>{t('effUnknownValue')}</span></> : <><strong>{boundedTotal ? '≥ ' : ''}{formatTokens(chart.total)}</strong><span>Token</span></>}</div></div>
      {unqualifiedTotal && <p className="cmv-muted" data-usage-bound="unqualified">{t('usageIntegrityUnknown')}</p>}
      {unknownTotal && <p className="cmv-muted" data-usage-bound="unknown">{t('effUnknownValue')}</p>}
      {boundedTotal && <p className="cmv-muted" data-usage-bound="partial">{t('knownBound')}</p>}
      {chart.total > 0 && !unknownTotal && <div className="cmv-stack cmv-usage-stack" role="img" aria-label={`${t('usage')} ${exactTokens(chart.total)} Token`}>{chart.values.map((value, index) => <span key={labels[index]} data-usage={labels[index]} style={{ width: `${value / chart.total * 100}%` }}/>)}</div>}
      <dl className="cmv-usage-legend">{chart.values.map((value, index) => <div key={labels[index]} data-legend-missing={unknownTotal ? 'unknown' : String(missing[index]!)}><dt><i data-usage={labels[index]}/>{t(labels[index]!)}</dt><dd>{unknownTotal ? '—' : formatTokens(value)}<small>{unknownTotal ? t('effUnknownValue') : <>{chart.total ? `${chart.shares[index]!.toFixed(1)}%` : '—'}{missing[index]! > 0 ? ` · ${missing[index]} ${t('effUnknownValue')}` : ''}</>}</small></dd></div>)}</dl>
    </div>}
    {rows.length > 0 && <div className="cmv-request-rows" role="group" aria-label={t('recentRequests')} data-max={max}>
      {rows.map(({ row, values }) => {
        const known = values.filter((value): value is number => typeof value === 'number')
        const partial = known.length !== values.length
        const sum = known.reduce((total, value) => total + value, 0)
        const unknown = known.length === 0
        const amount = unknown ? t('effUnknownValue') : partial ? `≥ ${formatTokens(sum)}` : formatTokens(sum)
        return <Tooltip key={row.seq} label={`${t('request')} ${row.turn}/${row.step} · ${t('uncached')} ${values[0] === null ? t('effUnknownValue') : formatTokens(values[0])} · ${t('read')} ${values[1] === null ? t('effUnknownValue') : formatTokens(values[1])} · ${t('output')} ${values[2] === null ? t('effUnknownValue') : formatTokens(values[2])}${partial ? ` · ${t('knownBound')}` : ''}`}>
          <div className="cmv-request-row" data-partial={partial ? 'true' : undefined} data-unknown={unknown ? 'true' : undefined} tabIndex={0}>
            <small className="cmv-request-seq">{row.turn}/{row.step}</small>
            <span className="cmv-request-track" aria-hidden="true">{sum > 0 && <span className="cmv-request-fill" style={{ width: `${sum / max * 100}%` }}>
              {values[0] !== null && values[0] > 0 && <i data-usage="uncached" style={{ width: `${values[0] / sum * 100}%` }}/>}
              {values[1] !== null && values[1] > 0 && <i data-usage="read" style={{ width: `${values[1] / sum * 100}%` }}/>}
              {values[2] !== null && values[2] > 0 && <i data-usage="output" style={{ width: `${values[2] / sum * 100}%` }}/>}
            </span>}</span>
            <span className="cmv-request-amount">{amount}</span>
          </div>
        </Tooltip>
      })}
      <div className="cmv-trend-legend"><span data-kind="uncached"><i data-usage="uncached"/>{t('uncached')}</span><span data-kind="read"><i data-usage="read"/>{t('cacheHit')}</span><span data-kind="output"><i data-usage="output"/>{t('output')}</span></div>
    </div>}
    {!data.historical && <p className="cmv-muted cmv-summary-usage">{summary
      ? <Tooltip label={`${t('summaryUsageHint')} ${t('summarySince')} ${new Date(summary.since).toLocaleString()} · ${t('input')} ${summaryAmount(summary.input)} / ${t('output')} ${summaryAmount(summary.output)} Token`}><span tabIndex={0}>{t('summaryRecorded')} {summaryDisplay} · {summary.attempts} {t('summaryCalls')}{summary.unknownAttempts > 0 ? ` · ${summary.unknownAttempts} ${t('summaryUnknown')}` : ''}</span></Tooltip>
      : t('noSummaryUsage')}</p>}
    <div className="cmv-usage-footer">
      <span><Tooltip label={t('maintenanceHint')}><span tabIndex={0}>{t('maintenanceUsage')} {maintenanceValue === null ? '—' : `${maintenanceUnknown ? '≥ ' : '≈ '}${formatTokens(maintenanceValue)} Token`}</span></Tooltip></span>
      <span>{t('cost')} {cost && cost.total !== null ? `${cost.partial ? '≥ ' : ''}${money(cost.total)}` : `— · ${t('costUnknown')}`}{cost && cost.total !== null && cost.partial ? ` · ${t('costPartial')}` : ''}</span>
    </div>
    </>}
  </article>
}

export function UsageDetails({ data, t, onCut, capacity }: { data: Inspection; t: InspectorText; onCut: (seq: number) => void; capacity?: CompactCapacity | null }) {
  const recent = data.requests.at(-1)
  return <details className="cmv-card cmv-data-basis"><summary>{t('dataBasis')}</summary><div>
    {recent && <p className="cmv-muted">{t('recent')} · {recent.turn} {t('turn')} · {recent.step} {t('step')}</p>}
    {!data.historical && <div className="cmv-growth cmv-muted"><span>{t('growthBasis')}</span>{(['sinceCompaction', 'lastToolResult'] as const).map(key => {
      const delta = data.contextGrowth?.[key]
      const window = contextWindow(data)
      const hint = `${t('growthHint')}${delta ? ` ${t('record')} ${delta.fromSeq} → ${delta.toSeq} · ${formatPercent(delta.beforeTokens,contextWindow(data))} → ${formatPercent(delta.afterTokens,contextWindow(data))}` : ` ${t('growthUnknownHint')}`}`
      const amount = delta && window !== null ? formatPercent(Math.abs(delta.deltaTokens), window) : t('growthUnknown')
      const sign = delta && window !== null && delta.deltaTokens !== 0 ? delta.deltaTokens > 0 ? '+' : '-' : ''
      return <Tooltip key={key} label={hint}><span tabIndex={0} data-growth={key}>{t(key)} <strong>{delta && window !== null ? `≈ ${sign}${amount}` : amount}</strong></span></Tooltip>
    })}</div>}
    {capacity && <div className="cmv-growth cmv-muted" data-compact-capacity data-window={capacity.windowTokens}>
      <span>{t('window')} <strong>{formatPercent(capacity.windowTokens, capacity.windowTokens)}</strong></span>
      <span>{t('gate')} <strong>{formatPercent(capacity.admission, capacity.windowTokens)}</strong></span>
      <span>{t('planUpper')} <strong>{formatPercent(capacity.upper, capacity.windowTokens)}</strong></span>
      <span>{t('protectedContent')} <strong>{formatPercent(capacity.protectedTokens, capacity.windowTokens)}</strong></span>
      <span>{t('continuationReserve')} <strong>{formatPercent(capacity.resumeHeadroom, capacity.windowTokens)}</strong></span>
      <span>{t('reserveNeed')} <strong>{formatPercent(capacity.requiredResumeHeadroom, capacity.windowTokens)}</strong></span>
      <span>{t('reserveMax')} <strong>{formatPercent(capacity.resumeHeadroomLimit, capacity.windowTokens)}</strong></span>
      <span>{t('observedGrowth')} <strong>{formatPercent(capacity.recentGrowth, capacity.windowTokens)}</strong></span>
      <span>{t('incomingEstimate')} <strong>{formatPercent(capacity.incomingTokens, capacity.windowTokens)}</strong></span>
    </div>}
    {data.efficiency && <EfficiencyLine efficiency={data.efficiency} t={t}/>}
    {data.reduction ? <ReductionLine reduction={data.reduction} t={t}/> : data.historical ? <p className="cmv-muted cmv-summary-usage">{t('histUnavailable')}</p> : null}
    {data.requests.length > 0 && <details className="cmv-request-details"><summary>{t('requests')} · {data.requestCount}</summary><div><table><thead><tr><th>{t('record')}</th><th>{t('input')}</th><th>{t('output')}</th><th>{t('read')}</th></tr></thead><tbody>{[...data.requests].reverse().map(request => <tr key={request.seq}><td><button type="button" onClick={() => onCut(request.seq)}>{request.turn} / {request.step}</button></td><td>{formatTokens(request.input)}</td><td>{formatTokens(request.output)}</td><td>{formatTokens(request.cacheRead)}</td></tr>)}</tbody></table></div></details>}
  </div></details>
}
