/** Native-theme charts for one immutable session cut. */
import { useState } from 'react'
import { Button, Tooltip } from '@deepseek-ai/dsh-client-ui-primitives'
import type { Inspection } from './inspector-types.ts'
import { composition, usageSlices, type ContextGroup } from './chart-data.ts'
import type { InspectorText } from './inspector-locales.ts'
import type { Policy } from './policy.ts'

export const formatTokens = (value: number | null | undefined) => value == null ? '—' : value >= 1000 ? `${(value / 1000).toFixed(1)}K` : Math.round(value).toLocaleString()
export const formatCapacity = (value: number | null) => value === null ? '—' : value >= 1_000_000 ? `${(value / 1_000_000).toLocaleString(undefined, { maximumFractionDigits: 2 })}M` : formatTokens(value)
export const formatTokenK = (value: number) => `${(value / 1000).toLocaleString(undefined, { maximumFractionDigits: 2 })}K`
export const exactTokens = (value: number | null | undefined) => value == null ? '—' : Math.round(value).toLocaleString()
export const formatTime = (value: number) => new Date(value).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false })

/** A percentage donut retains unknown input as an empty track. */
export function CacheDonut({ value, t }: { value: number | null; t: InspectorText }) {
  const shown = value === null ? '—' : `${Math.round(value)}%`
  return <div className="cmv-donut" role="img" aria-label={`${t('cache')} ${shown}`} style={{ background: value === null ? undefined : `conic-gradient(var(--cmv-green) ${Math.min(100, Math.max(0, value))}%, var(--dsw-alias-interactive-bg-hover) 0)` }}><span><strong>{shown}</strong><small>{t('cache')}</small></span></div>
}

/** One full-window bar includes available capacity and preserves category estimates. */
export function ContextComposition({ data, policy, t, onGroup }: { data: Inspection; policy: Policy | undefined; t: InspectorText; onGroup: (group: ContextGroup) => void }) {
  const chart = composition(data, policy)
  const pct = chart.window === null ? null : chart.used / chart.window * 100
  const isGroup = (id: typeof chart.slices[number]['id']): id is ContextGroup => id !== 'free' && id !== 'other' && id !== 'reserve'
  const hint = (slice: typeof chart.slices[number]) => slice.id === 'reserve' ? `${t('reserveHint')} ${t('gate')} ${formatTokenK(chart.limit!)} Token` : slice.id === 'free' ? t(chart.limit === null ? 'availableHint' : 'freeHint') : slice.id === 'summary' ? t('summaryHint') : ''
  const sliceLabel = (slice: typeof chart.slices[number]) => `${t(slice.id)} ≈ ${exactTokens(slice.value)} Token${chart.window === null ? '' : ` · ${slice.share.toFixed(1)}%`}${hint(slice) ? ` · ${hint(slice)}` : ''}`
  return <article className="cmv-card cmv-composition">
    <div className="cmv-heading"><div><h3>{t('current')}</h3><Tooltip label={`${t('capacity')} ${exactTokens(chart.window)} Token`} portal><div tabIndex={0} className="cmv-number"><strong>{formatCapacity(chart.window)}</strong><span>{t('capacity')}</span></div></Tooltip></div>
      <div className="cmv-capacity-used"><span>{t('used')} ≈ <strong>{formatTokenK(chart.used)}</strong></span><b>{pct === null ? '—' : `${pct.toFixed(1)}%`}</b></div></div>
    <div className="cmv-stack cmv-capacity-stack" role="group" aria-label={t('windowBasis')} data-total={chart.total} data-capacity={chart.window}>
      {chart.window !== null && chart.slices.filter(slice => slice.value > 0).map(slice => <Tooltip key={slice.id} label={slice.id === 'reserve' ? t('reserveTooltip') : sliceLabel(slice)} side="bottom" portal>
        {isGroup(slice.id) ? <button type="button" data-color={slice.id} style={{ width: `${slice.value / chart.total * 100}%` }} aria-label={sliceLabel(slice)} onClick={() => { if (isGroup(slice.id)) onGroup(slice.id) }}/> : <span data-color={slice.id} role="img" aria-label={sliceLabel(slice)} style={{ width: `${slice.value / chart.total * 100}%` }} tabIndex={0}>{slice.share >= 12 && slice.id !== 'other' ? t(slice.id) : null}</span>}
      </Tooltip>)}
    </div>
    <div className="cmv-legend">{chart.slices.map(slice => <button key={slice.id} type="button" className="cmv-key" disabled={!isGroup(slice.id)} data-slice={slice.id} data-value={slice.value} data-share={slice.share} title={sliceLabel(slice)} onClick={() => { if (isGroup(slice.id)) onGroup(slice.id) }}><span><i data-color={slice.id}/>{t(slice.id)}</span><strong>{formatTokenK(slice.value)}<small>{chart.window === null ? '—' : `${slice.share.toFixed(1)}%`}</small></strong></button>)}</div>
    <div className="cmv-between cmv-muted"><Tooltip label={`${t('estimateHint')}${chart.measured === null ? '' : ` ${t('hostOccupancy')} ${exactTokens(chart.measured)} Token`}`} portal><span tabIndex={0}>{t('estimate')}</span></Tooltip>{chart.window === null ? <span>{t('unknownWindow')}</span> : chart.overflow ? <span>{t('overflow')} ≈ {formatTokenK(chart.used - chart.window)}</span> : <Tooltip label={t(chart.limit === null ? 'availableHint' : 'freeHint')} portal><span tabIndex={0}>{t('windowBasis')} · 100%</span></Tooltip>}</div>
    {!data.historical && <div className="cmv-growth cmv-muted"><span>{t('growthBasis')}</span>{(['sinceCompaction', 'lastToolResult'] as const).map(key => {
      const delta = data.contextGrowth?.[key]
      const hint = `${t('growthHint')}${delta ? ` ${t('record')} ${delta.fromSeq} → ${delta.toSeq} · ${exactTokens(delta.beforeTokens)} → ${exactTokens(delta.afterTokens)} Token` : ` ${t('growthUnknownHint')}`}`
      return <Tooltip key={key} label={hint} portal><span tabIndex={0} data-growth={key}>{t(key)} <strong>{delta ? `≈ ${delta.deltaTokens > 0 ? '+' : delta.deltaTokens < 0 ? '-' : ''}${formatTokens(Math.abs(delta.deltaTokens))} Token` : t('growthUnknown')}</strong></span></Tooltip>
    })}</div>}
  </article>
}

/** Columns use recorded host pressure only; no synthetic category history. */
export function PressureTrend({ data, t, onCut }: { data: Inspection; t: InspectorText; onCut: (seq: number) => void }) {
  const [selected, setSelected] = useState<number | null>(null)
  const points = data.pressureHistory ?? []
  const point = points.find(item => item.seq === selected) ?? points.at(-1)
  const maximum = Math.max(1, ...points.map(item => item.tokens ?? 0))
  const kind = (value: typeof points[number]) => t(value.kind === 'reply' ? 'reply' : value.kind === 'replace' ? 'replacement' : 'cut')
  return <article className="cmv-card cmv-trend"><div className="cmv-heading"><h3>{t('trend')}</h3><Tooltip label={t('trendHint')} portal><span tabIndex={0} className="cmv-muted">Token</span></Tooltip></div>
    {!points.some(item => item.tokens !== null) ? <div className="cmv-empty">{t('noTrend')}</div> : <><div className="cmv-bars" role="group" aria-label={t('trend')}><span className="cmv-scale">{formatTokens(maximum)}</span>{points.map(item => <Tooltip key={item.seq} portal label={`${t('record')} ${item.seq} · ${kind(item)} · ${exactTokens(item.tokens)} Token`}><button type="button" data-kind={item.kind} data-unknown={item.tokens === null} aria-pressed={point?.seq === item.seq} aria-label={`${t('record')} ${item.seq} ${kind(item)} ${exactTokens(item.tokens)} Token`} onFocus={() => setSelected(item.seq)} onMouseEnter={() => setSelected(item.seq)} onClick={() => { setSelected(item.seq); onCut(item.seq) }}><span style={{ height: item.tokens === null ? 0 : `${item.tokens / maximum * 100}%` }}/>{item.tokens === null && <small>?</small>}</button></Tooltip>)}</div>
      <div className="cmv-between cmv-muted"><span>{formatTime(points[0]!.time)}</span><span>{formatTime(points.at(-1)!.time)}</span></div>
      {point && <div className="cmv-caption" aria-live="polite"><span>{kind(point)}</span><strong>{formatTokens(point.tokens)}</strong><span>{formatTime(point.time)}</span></div>}
    </>}
  </article>
}

/** Compaction comparisons use replaced-region counts on a shared per-card scale. */
export function CompactionChart({ data, t }: { data: Inspection; t: InspectorText }) {
  const [expanded, setExpanded] = useState(false)
  const entries = [...data.compactions].reverse()
  const shown = expanded ? entries : entries.slice(0, 2)
  const maximum = Math.max(1, ...shown.flatMap(entry => [entry.beforeTokens ?? 0, entry.afterTokens ?? 0]))
  return <article className="cmv-card cmv-compactions"><div className="cmv-heading"><h3>{t('compactions')}</h3><span className="cmv-muted">{t('segment')}</span></div>
    {!entries.length ? <div className="cmv-empty">{t('noCompaction')}</div> : <ol className="cmv-events">{shown.map(entry => {
      const known = entry.applied && entry.beforeTokens !== undefined && entry.afterTokens !== undefined
      const delta = known ? entry.beforeTokens! - entry.afterTokens! : null
      const trigger = data.historical ? undefined : entry.trigger
      const sources = { idle: 'triggerIdle', pressure: 'triggerPressure', overflow: 'triggerOverflow', manual: 'triggerManual' } as const
      const source = entry.kind === 'prune' ? 'toolCleanup' : trigger ? sources[trigger] : entry.manual ? 'betweenTurns' : 'duringTask'
      return <li key={entry.id}><div className="cmv-between"><Tooltip label={`${t('input')} ${exactTokens(entry.inputTokens)} · ${t('output')} ${exactTokens(entry.outputTokens)} Token${entry.endedAt === undefined ? '' : ` · ${((entry.endedAt - entry.startedAt) / 1000).toFixed(1)}s`}`} portal><span tabIndex={0}>{formatTime(entry.startedAt)} · {t(source)}</span></Tooltip><span className="cmv-muted">{t(entry.status)}</span></div>
        {known ? <><div className="cmv-compare"><span>{t('before')}</span><div><i data-color="tool" style={{ width: `${entry.beforeTokens! / maximum * 100}%` }}/></div><b>{formatTokens(entry.beforeTokens)}</b></div><div className="cmv-compare"><span>{t('after')}</span><div><i data-color="summary" style={{ width: `${entry.afterTokens! / maximum * 100}%` }}/></div><b>{formatTokens(entry.afterTokens)}</b></div><div className="cmv-between cmv-muted"><span>{delta! >= 0 ? t('reduced') : t('increased')} {formatTokens(Math.abs(delta!))}</span><span>{entry.beforeTokens! > 0 ? `${Math.round(Math.abs(delta!) / entry.beforeTokens! * 100)}%` : '—'}</span></div></> : <p className="cmv-muted">{t('unknownUsage')}</p>}
        {entry.status === 'failed' && entry.applied && <p role="status">{t('committedFailure')}</p>}{entry.error && <p className="cmv-error">{entry.error}</p>}
      </li>
    })}</ol>}
    {entries.length > 2 && <Button size="sm" variant="ghost" aria-expanded={expanded} onClick={() => setExpanded(!expanded)}>{expanded ? t('collapse') : t('allRecords')}</Button>}
  </article>
}

/** Session consumption is disjoint from the current context composition. */
export function UsageComposition({ data, t, onCut }: { data: Inspection; t: InspectorText; onCut: (seq: number) => void }) {
  const chart = usageSlices(data.usage)
  const summary = data.historical ? undefined : data.summaryUsage
  const labels = ['uncached', 'read', 'write', 'output'] as const
  return <article className="cmv-card cmv-usage"><div className="cmv-heading"><h3>{t('usage')}</h3><Tooltip label={t('usageHint')} portal><span tabIndex={0} className="cmv-muted">Token</span></Tooltip></div>
    {!chart ? <div className="cmv-empty">{t('noUsage')}</div> : <><div className="cmv-usage-total"><div className="cmv-number"><strong>{formatTokens(chart.total)}</strong><span>Token</span></div><CacheDonut value={chart.hit} t={t}/></div>
      {chart.total > 0 && <div className="cmv-stack cmv-usage-stack" role="img" aria-label={`${t('usage')} ${exactTokens(chart.total)} Token`}>{chart.values.map((value, index) => <span key={labels[index]} data-usage={labels[index]} style={{ width: `${value / chart.total * 100}%` }}/>)}</div>}
      <dl className="cmv-usage-legend">{chart.values.map((value, index) => <div key={labels[index]}><dt><i data-usage={labels[index]}/>{t(labels[index]!)}</dt><dd>{formatTokens(value)}<small>{chart.total ? `${chart.shares[index]!.toFixed(1)}%` : '—'}</small></dd></div>)}</dl>
    </>}
    {!data.historical && <p className="cmv-muted cmv-summary-usage">{summary
      ? <Tooltip label={`${t('summaryUsageHint')} ${t('summarySince')} ${new Date(summary.since).toLocaleString()} · ${t('input')} ${exactTokens(summary.input)} / ${t('output')} ${exactTokens(summary.output)} Token`} portal><span tabIndex={0}>{t('summaryRecorded')} {formatTokens(summary.input + summary.output)} Token · {summary.attempts} {t('summaryCalls')}{summary.unknownAttempts > 0 ? ` · ${summary.unknownAttempts} ${t('summaryUnknown')}` : ''}</span></Tooltip>
      : t('noSummaryUsage')}</p>}
    {data.requests.length > 0 && <details className="cmv-request-details"><summary>{t('requests')} · {data.requestCount}</summary><div><table><thead><tr><th>{t('record')}</th><th>{t('input')}</th><th>{t('output')}</th><th>{t('read')}</th></tr></thead><tbody>{[...data.requests].reverse().map(request => <tr key={request.seq}><td><button type="button" onClick={() => onCut(request.seq)}>{request.turn} / {request.step}</button></td><td>{formatTokens(request.input)}</td><td>{formatTokens(request.output)}</td><td>{formatTokens(request.cacheRead)}</td></tr>)}</tbody></table></div></details>}
  </article>
}
