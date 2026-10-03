/** A read-only, single-page context view registered after the native trajectory. */
import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import { Button, Checkbox, Input, StateDot, Tooltip } from '@deepseek-ai/dsh-client-ui-primitives'
import type { ConfigForm } from '@deepseek-ai/dsh-client-ui-settings/client'
import { budget, type Policy } from './policy.ts'
import { categories, defaultQuery, type Category, type ContentPage, type ContentRow, type Inspection, type InspectorApi, type InspectQuery } from './inspector-types.ts'
import { CacheDonut, CompactionChart, ContextComposition, PressureTrend, UsageComposition, formatTokens, exactTokens, formatTime } from './inspector-charts.tsx'
import { inspectorText, type InspectorText } from './inspector-locales.ts'
import { useReadonlyView } from './readonly-view.ts'
import type { IdleStatus } from './idle-types.ts'
import type { ContextGroup } from './chart-data.ts'
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

function IdleStatusLine({ target, api, revision, settingsRevision, retry, t }: { target: string; api: InspectorApi; revision: unknown; settingsRevision: number | undefined; retry: number; t: InspectorText }) {
  const [state, setState] = useState<{ target: string; value: IdleStatus } | null>(null)
  const [error, setError] = useState(false)
  useEffect(() => {
    const abort = new AbortController()
    let timer: ReturnType<typeof setTimeout> | undefined
    async function read() {
      try {
        const value = await api.idleStatus({ sessionId: target }, abort.signal)
        if (abort.signal.aborted) return
        setState({ target, value }); setError(false)
        if (value.status !== 'off') timer = setTimeout(() => { void read() }, value.status === 'compacting' ? 1000 : 5000)
      } catch (reason) {
        // A cancelled view owns no status update or follow-up timer.
        if (!abort.signal.aborted) { setError(true); timer = setTimeout(() => { void read() }, 5000) }
      }
    }
    void read()
    return () => { abort.abort(); clearTimeout(timer) }
  }, [target, api, revision, settingsRevision, retry])
  const value = state?.target === target ? state.value : null
  const message = value?.status === 'scheduled' && value.dueAt !== null && !/background|busy/u.test(value.reasonCode ?? '')
    ? `${value.restored ? `${t('restored')} · ` : ''}${Math.max(0, Math.ceil((value.dueAt - Date.now()) / 60000))} ${t('minutes')}` : value?.message
  return <span role="status" aria-label={t('idle')}>{t('idle')} · {error ? t('idleUnknown') : message ?? t('idleWait')}</span>
}

function RequestStatus({ data, policy, stale, t }: { data: Inspection; policy: Policy | undefined; stale: boolean; t: InspectorText }) {
  const pressure = data.pressure
  const gate = policy && pressure?.window && data.model?.maxTokens != null ? budget(policy, pressure.window, data.model.maxTokens) : null
  const status = stale ? 'stale' : data.historical ? 'historical' : policy && !policy.enabled ? 'off' : !gate || !pressure ? 'unknown' : pressure.projected >= gate.admission ? 'compactFirst' : 'continue'
  const recent = data.requests.at(-1)
  const hit = recent?.input != null && recent.input > 0 && recent.cacheRead !== null ? recent.cacheRead / recent.input * 100 : null
  return <div className="cmv-quick"><article className="cmv-card"><h3>{t('next')}</h3><div className="cmv-status"><StateDot state={status === 'compactFirst' ? 'warning' : status === 'continue' ? 'done' : 'idle'}/>{t(status)}</div><span className="cmv-muted">{t('gate')} {formatTokens(gate?.admission)} Token</span></article>
    <article className="cmv-card cmv-latest"><div><h3>{t('recent')}</h3><div className="cmv-small-number">{formatTokens(recent?.input ?? pressure?.input)} <small>Token</small></div><span className="cmv-muted">{recent ? `${recent.turn} ${t('turn')} · ${recent.step} ${t('step')}` : t('noRequest')}</span></div><CacheDonut value={hit} t={t}/></article>
  </div>
}

type ContentDetailProps = { target: string; cutSeq: number; row: ContentRow; api: InspectorApi; t: InspectorText }
function ContentDetail(props: ContentDetailProps) {
  const [trail, setTrail] = useState<ContentRow[]>([])
  const row = trail.at(-1) ?? props.row
  return <article className="cmv-reader">
    {trail.length > 0 && <Button size="sm" variant="ghost" onClick={() => setTrail(value => value.slice(0, -1))}>{props.t('backToSummary')}</Button>}
    <ContentReader key={row.id} {...props} row={row} onSource={source => setTrail(value => [...value, source])}/>
  </article>
}

function ContentReader({ target, cutSeq, row, api, t, onSource }: ContentDetailProps & { onSource: (row: ContentRow) => void }) {
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
  return <><div className="cmv-heading"><h3>{row.title}</h3><span className="cmv-muted">{formatTokens(row.tokens)}</span></div><div className="cmv-muted cmv-reader-meta">{t(row.category)} · {t('record')} {row.seq}{row.current ? '' : ` · ${t('replaced')}`}{row.images ? ` · ${row.images} ${t('images')}` : ''}</div><div className="cmv-muted cmv-source">{row.source}</div>
    {error ? <div role="alert"><p>{error}</p><Button size="sm" onClick={() => setRetry(retry + 1)}>{t('retry')}</Button></div> : !page ? <Loading/> : <><pre className="cmi-body" tabIndex={0}>{page.text || t('noText')}</pre>{(offset > 0 || page.nextOffset !== null) && <div className="cmv-pagination"><Button size="sm" disabled={offsets.length === 1} onClick={() => setOffsets(value => value.slice(0, -1))}>{t('previousText')}</Button><span>{t('characters')} {exactTokens(offset + 1)}–{exactTokens(offset + page.text.length)} / {exactTokens(page.totalChars)}</span><Button size="sm" disabled={page.nextOffset === null} onClick={() => { if (page.nextOffset !== null) setOffsets(value => [...value, page.nextOffset!]) }}>{t('nextText')}</Button></div>}</>}
    {row.category === 'summary' && page && <section className="cmv-summary-source" aria-label={t('sourceOriginals')}><h3>{t('sourceOriginals')}</h3><p className="cmv-muted">{t('sourceHint')}</p>
      {page.sources?.rows.length ? <><div className="cmi-content-list">{page.sources.rows.map(source => <button type="button" key={source.id} onClick={() => onSource(source)}><span className="cmv-row-title"><strong>{source.title}</strong></span><span className="cmv-muted">{t('record')} {source.seq} · {t(source.category)}</span></button>)}</div>
        {(sourceOffset > 0 || page.sources.nextOffset !== null) && <div className="cmv-pagination"><Button size="sm" disabled={sourceOffset === 0} onClick={() => setSourceOffset(value => Math.max(0, value - 4))}>{t('previousSources')}</Button><span>{sourceOffset + 1}–{sourceOffset + page.sources.rows.length} / {exactTokens(page.sources.total)}</span><Button size="sm" disabled={page.sources.nextOffset === null} onClick={() => { if (page.sources?.nextOffset != null) setSourceOffset(page.sources.nextOffset) }}>{t('nextSources')}</Button></div>}</>
        : <p className="cmv-muted">{t('noSources')}</p>}
    </section>}
  </>
}

function ContentBrowser({ data, query, change, api, target, loading, t }: { data: Inspection; query: InspectQuery; change: (patch: Partial<InspectQuery>) => void; api: InspectorApi; target: string; loading: boolean; t: InspectorText }) {
  const [selected, setSelected] = useState('')
  const [shown, setShown] = useState(4)
  const row = data.rows.slice(0, shown).find(item => item.id === selected) ?? data.rows[0]
  const grouped = query.group === 'message' || query.group === 'instruction'
  const filter = grouped ? `group:${query.group}` : query.group ?? query.category
  return <div><div className="cmv-content-tools"><Input aria-label={t('search')} placeholder={t('search')} value={query.search} onChange={event => change({ search: event.target.value.slice(0, 200) })}/><select aria-label={t('types')} value={filter} onChange={event => { const value = event.target.value; change(value.startsWith('group:') ? { group: value.slice(6) as ContextGroup, category: 'all' } : { group: undefined, category: value as Category | 'all' }) }}><option value="all">{t('all')}</option>{grouped && query.group && <option value={`group:${query.group}`}>{t(query.group)}</option>}{categories.map(item => <option key={item.id} value={item.id}>{t(item.id)}</option>)}</select><select aria-label={t('sort')} value={query.sort} onChange={event => change({ sort: event.target.value as InspectQuery['sort'] })}><option value="size">{t('size')}</option><option value="position">{t('position')}</option></select></div>
    <div className="cmv-content-layout"><div className="cmi-content-list" aria-label={t('content')}>{data.rows.slice(0, shown).map(item => <button type="button" key={item.id} aria-pressed={row?.id === item.id} onClick={() => setSelected(item.id)}><span className="cmv-row-title"><i data-category={item.category}/><strong>{item.title}</strong><b>{formatTokens(item.tokens)}</b></span><span className="cmv-muted">{t(item.category)}{item.current ? '' : ` · ${t('replaced')}`}</span></button>)}{!data.rows.length && <div className="cmv-empty">{t('emptyContents')}</div>}{shown < data.rows.length && <Button size="sm" variant="ghost" onClick={() => setShown(value => value + 4)}>{t('more')}</Button>}</div>{row ? <ContentDetail key={`${target}:${data.cutSeq}:${row.id}`} target={target} cutSeq={data.cutSeq} row={row} api={api} t={t}/> : <div className="cmv-empty">{t('selectContent')}</div>}</div>
    <div className="cmv-content-footer"><Checkbox label={t('archived')} checked={query.archived} onChange={archived => change({ archived })}/><div className="cmv-pagination"><Button size="sm" disabled={loading || data.offset === 0} onClick={() => change({ offset: Math.max(0, data.offset - data.pageSize) })}>{t('previous')}</Button><span>{data.total ? data.offset + 1 : 0}–{Math.min(data.offset + Math.min(shown, data.rows.length), data.total)} / {exactTokens(data.total)}</span><Button size="sm" disabled={loading || data.offset + data.pageSize >= data.total} onClick={() => change({ offset: data.offset + data.pageSize })}>{t('nextPage')}</Button></div></div>
  </div>
}

/** Mount only for the selected session; release requests, timers and composer overrides on exit. */
export function ContextInspectorView({ target, form, api, pulse, locale = 'zh' }: ContextViewInjected) {
  const t = useMemo(() => inspectorText(locale), [locale])
  const viewRef = useReadonlyView(target)
  const contentRef = useRef<HTMLDivElement>(null)
  const [expanded, setExpanded] = useState(true)
  useEffect(() => setExpanded(true), [target])
  const scrollToContent = useRef(false)
  const [query, setQuery] = useState<InspectQuery>({ sessionId: target, ...defaultQuery })
  const [data, setData] = useState<{ value: Inspection; key: string } | null>(null)
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(true)
  const [retry, setRetry] = useState(0)
  const accepted = useSyncExternalStore(callback => form.subscribe(callback), () => form.getSnapshot())
  const revision = useSyncExternalStore(callback => pulse.subscribe(callback), () => pulse.getSnapshot())
  const effective = useMemo(() => query.sessionId === target ? query : { sessionId: target, ...defaultQuery }, [query, target])
  const key = JSON.stringify(effective)
  const automatic = effective.atSeq === null ? revision : null
  const safeData = data?.key === key && data.value.sessionId === target ? data.value : null
  useEffect(() => {
    const controller = new AbortController()
    setLoading(true); setError('')
    const timer = setTimeout(() => {
      void api.inspect(effective, controller.signal).then(value => {
        if (!controller.signal.aborted && value.sessionId === target) { setData({ value, key }); setLoading(false) }
      }).catch(reason => { if (!controller.signal.aborted) { setError(errorText(reason, t)); setLoading(false) } })
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
    <div className="cmv-inner"><header className="cmv-header"><div className="cmv-heading"><h2>{t('title')}</h2><span className="cmv-muted">{t('readonly')}</span></div><Tooltip label={t('settingsHint')} portal><span className="cmv-muted" tabIndex={0}>{t('settingsHint')}</span></Tooltip><Button size="sm" variant="outline" disabled={loading} onClick={() => setRetry(retry + 1)}>{t('refresh')}</Button></header>
      <div className="cmv-meta">{effective.atSeq === null && <IdleStatusLine target={target} api={api} revision={automatic} settingsRevision={accepted.revision} retry={retry} t={t}/>}<span>{accepted.value ? `${t('trigger')} ${accepted.value.policy.triggerPercent}% → ${t('target')} ${accepted.value.policy.targetPercent}%` : ''}</span></div>
      {effective.atSeq !== null && <div className="cmv-notice"><Tooltip label={t('historyHint')} portal><span tabIndex={0}>{t('historical')} · {t('record')} {effective.atSeq}</span></Tooltip><Button size="sm" onClick={() => change({ ...defaultQuery, group: undefined })}>{t('currentReturn')}</Button></div>}
      {error && <div className="cmv-notice" role="alert"><span>{error}{safeData ? ` · ${t('retained')}` : ''}</span><Button size="sm" onClick={() => setRetry(retry + 1)}>{t('retry')}</Button></div>}
      {!safeData ? loading ? <Loading/> : <div className="cmv-empty">{t('noData')}</div> : <>
        <div id="cmi-overview-panel" className="cmv-metrics"><ContextComposition key={target} data={safeData} policy={accepted.value?.policy} t={t} onGroup={showGroup}/><RequestStatus data={safeData} policy={accepted.value?.policy} stale={loading || !!error} t={t}/></div>
        <div className="cmv-meta"><Tooltip label={`${t('effort')} ${safeData.model?.effort ?? '—'} · ${t('reserved')} ${exactTokens(safeData.model?.maxTokens)} Token`} portal><span tabIndex={0}>{safeData.model ? `${safeData.model.provider} / ${safeData.model.model}` : t('noRequest')}</span></Tooltip><span>{safeData.activeCount} {t('items')} · {t('reserved')} {formatTokens(safeData.model?.maxTokens)}</span></div>
        <div id="cmi-history-panel" className="cmv-chart-grid"><PressureTrend key={target} data={safeData} t={t} onCut={showCut}/><CompactionChart key={target + ':compactions'} data={safeData} t={t}/><UsageComposition data={safeData} t={t} onCut={showCut}/></div>
        <div ref={contentRef} className="cmv-card cmv-content"><div className="cmv-heading"><h3>{t(safeData.historical ? 'historicalContent' : 'content')} <span className="cmv-muted">{exactTokens(safeData.total)} {t('items')}</span></h3><Button size="sm" variant="ghost" aria-expanded={expanded} onClick={() => setExpanded(!expanded)}>{t(expanded ? 'collapseDetails' : 'expandDetails')}</Button></div>
          {expanded && <div id="cmi-content-panel"><ContentBrowser key={`${target}:${key}`} data={safeData} query={effective} change={change} api={api} target={target} loading={loading} t={t}/></div>}
        </div>
        <footer className="cmv-footer"><span>{t('updated')} {formatTime(safeData.sampledAt)}</span><span>{t('readonly')} · {t('record')} {safeData.cutSeq}</span></footer>
      </>}
    </div>
  </section>
}
