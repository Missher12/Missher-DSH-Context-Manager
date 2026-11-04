/** Shared read-only readers for content, summaries and their original sources. */
import { useEffect, useMemo, useState } from 'react'
import { Button, StateDot } from '@deepseek-ai/dsh-client-ui-primitives'
import type { ContentPage, ContentRow, InspectorApi } from './inspector-types.ts'
import { exactTokens, formatTokens } from './inspector-charts.tsx'
import { formatPercent } from './policy.ts'
import type { InspectorText } from './inspector-locales.ts'
import { readStoredCheckpoint } from './checkpoint.ts'

export const errorText = (error: unknown, t: InspectorText) => error instanceof Error ? error.message : t('error')

export function Loading() { return <div className="cmv-empty"><StateDot state="ongoing"/></div> }

export type ContentDetailProps = { target: string; cutSeq: number; row: ContentRow; api: InspectorApi; t: InspectorText; window: number | null }

export function ContentDetail(props: ContentDetailProps) {
  const [trail, setTrail] = useState<ContentRow[]>([])
  const row = trail.at(-1) ?? props.row
  return <article className="cmv-reader">
    {trail.length > 0 && <Button size="sm" variant="ghost" onClick={() => setTrail(value => value.slice(0, -1))}>{props.t('backToSummary')}</Button>}
    <ContentReader key={row.id} {...props} row={row} onSource={source => setTrail(value => [...value, source])}/>
  </article>
}

/** Display validated fields without generating or rewriting the stored summary. */
export function CheckpointBody({ text, complete, t }: { text: string; complete: boolean; t: InspectorText }) {
  const value = useMemo(() => (complete ? readStoredCheckpoint(text) : null), [complete, text])
  const raw = <pre className="cmi-body" tabIndex={0}>{text || t('noText')}</pre>
  if (!value) return raw
  const fields = [['goal', 'summaryGoal'], ['constraints', 'summaryConstraints'], ['completed', 'summaryCompleted'], ['pending', 'summaryPending'], ['evidence', 'summaryEvidence'], ['next', 'summaryNext'], ['uncertainties', 'summaryUncertainties']] as const
  return <><div className="cmv-checkpoint-fields">{fields.map(([key, label]) => <section key={key} data-field={key}><h4>{t(label)}</h4>{typeof value[key] === 'string' ? <p>{value[key]}</p> : (value[key] as string[]).length ? <ul>{(value[key] as string[]).map((item, index) => <li key={index}>{item}</li>)}</ul> : <p className="cmv-muted">{t('noRecordedFacts')}</p>}</section>)}</div><details className="cmv-raw-summary"><summary>{t('originalSummaryText')}</summary>{raw}</details></>
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
    {error ? <div role="alert"><p>{error}</p><Button size="sm" onClick={() => setRetry(retry + 1)}>{t('retry')}</Button></div> : !page ? <Loading/> : <>{row.category === 'summary' ? <CheckpointBody text={page.text} complete={page.offset === 0 && page.nextOffset === null && page.text.length === page.totalChars} t={t}/> : <pre className="cmi-body" tabIndex={0}>{page.text || t('noText')}</pre>}{(offset > 0 || page.nextOffset !== null) && <div className="cmv-pagination"><Button size="sm" disabled={offsets.length === 1} onClick={() => setOffsets(value => value.slice(0, -1))}>{t('previousText')}</Button><span>{t('characters')} {exactTokens(offset + 1)}–{exactTokens(offset + page.text.length)} / {exactTokens(page.totalChars)}</span><Button size="sm" disabled={page.nextOffset === null} onClick={() => { if (page.nextOffset !== null) setOffsets(value => [...value, page.nextOffset!]) }}>{t('nextText')}</Button></div>}</>}
    {row.category === 'summary' && page && <section className="cmv-summary-source" aria-label={t('sourceOriginals')}><h3>{t('sourceOriginals')}</h3><p className="cmv-muted">{t('sourceHint')}</p>
      {page.sources?.rows.length ? (
        <>
          <div className="cmi-content-list">{page.sources.rows.map(source => <button type="button" key={source.id} onClick={() => onSource(source)}><span className="cmv-row-title"><strong>{source.title}</strong></span><span className="cmv-muted">{t('record')} {source.seq} · {t(source.category)}</span></button>)}</div>
          {(sourceOffset > 0 || page.sources.nextOffset !== null) && <div className="cmv-pagination"><Button size="sm" disabled={sourceOffset === 0} onClick={() => setSourceOffset(value => Math.max(0, value - 4))}>{t('previousSources')}</Button><span>{sourceOffset + 1}–{sourceOffset + page.sources.rows.length} / {exactTokens(page.sources.total)}</span><Button size="sm" disabled={page.sources.nextOffset === null} onClick={() => { if (page.sources?.nextOffset != null) setSourceOffset(page.sources.nextOffset) }}>{t('nextSources')}</Button></div>}
        </>
      ) : <p className="cmv-muted">{t('noSources')}</p>}
    </section>}
  </>
}
