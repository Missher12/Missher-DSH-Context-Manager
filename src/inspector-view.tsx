import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import { Button, Input, Tag } from '@deepseek-ai/dsh-client-ui-primitives'
import type { ConfigForm } from '@deepseek-ai/dsh-client-ui-settings/client'
import { budget, type Policy } from './policy.ts'
import { categories, defaultQuery, type Category, type ContentPage, type ContentRow, type Inspection, type InspectorApi, type InspectQuery } from './inspector-types.ts'
import css from './inspector.css'
import { useReadonlyView } from './readonly-view.ts'

export interface ContextViewInjected {
  target: string
  form: ConfigForm<{ policy: Policy }>
  api: InspectorApi
  pulse: { subscribe(callback: () => void): () => void; getSnapshot(): unknown }
}
const number = (value: number | null | undefined) => value == null ? '—' : Math.round(value).toLocaleString()
const time = (value: number) => new Date(value).toLocaleString('zh-CN', { hour12: false })
const label = (category: Category) => categories.find(item => item.id === category)!.label
const errors = (error: unknown) => error instanceof Error ? error.message : '暂时无法读取，请重试。'

function Empty({ children }: { children: React.ReactNode }) { return <div className="cmi-empty">{children}</div> }
function PartList({ data, onCategory }: { data: Inspection; onCategory: (category: Category) => void }) {
  const [expanded, setExpanded] = useState(false)
  const total = data.parts.reduce((sum, part) => sum + part.tokens, 0)
  const parts = [...data.parts].filter(part => part.tokens > 0).sort((a, b) => b.tokens - a.tokens)
  const shown = expanded ? parts : parts.slice(0, 3)
  return <article className="cmi-card"><div className="cmi-section-title"><h3>上下文组成</h3><span className="cmi-note">≈ {number(total)} Token</span></div>
    <div className="cmi-composition" aria-label="上下文组成">{parts.map(part => <button key={part.category} data-category={part.category} style={{ width: `${part.tokens / total * 100}%` }} aria-label={`${label(part.category)}，约 ${number(part.tokens)} Token`} onClick={() => onCategory(part.category)}/>)}</div>
    <div className="cmi-parts">{shown.map(part => <button key={part.category} onClick={() => onCategory(part.category)}><span><i data-category={part.category}/>{label(part.category)}</span><span>≈ {number(part.tokens)}</span><small>{(part.tokens / total * 100).toFixed(1)}%　›</small></button>)}</div>
    {!parts.length && <p className="cmi-note">尚无有效内容。</p>}
    <div className="cmi-between cmi-card-footer"><span className="cmi-note">{expanded ? '全部有效分类' : '占用最多的 3 类'} · 点击查看内容</span>{parts.length > 3 && <Button size="sm" variant="ghost" aria-expanded={expanded} onClick={() => setExpanded(!expanded)}>{expanded ? '收起分类' : `全部 ${parts.length} 类`}</Button>}</div>
  </article>
}

function Overview({ data, policy, stale, onCategory }: { data: Inspection; policy: Policy | undefined; stale: boolean; onCategory: (category: Category) => void }) {
  const pressure = data.pressure
  const pct = pressure?.window ? pressure.projected / pressure.window * 100 : undefined
  const gate = policy && pressure?.window && data.model?.maxTokens !== null && data.model?.maxTokens !== undefined ? budget(policy, pressure.window, data.model.maxTokens) : null
  const status = stale ? '数据待刷新' : data.historical ? '历史截面' : !policy ? '等待读取策略' : !policy.enabled ? '自动压缩已关闭' : !gate || !pressure ? '等待完整参数' : pressure.projected >= gate.admission ? '预计先压缩，再执行' : '预计可继续执行'
  return <>
    <div className="cmi-metrics"><article className="cmi-card cmi-main-metric"><div className="cmi-section-title"><span className="cmi-note">当前上下文</span><span className="cmi-note">{data.historical ? '历史' : '估算'}</span></div>
      <div className="cmi-number">{number(pressure?.projected)}<small>Token</small><strong>{pct === undefined ? '—' : `${pct.toFixed(1)}%`}</strong></div>
      <div className="cmi-meter" {...pct === undefined ? {} : { role: 'meter', 'aria-label': '当前上下文占用', 'aria-valuemin': 0, 'aria-valuemax': 100, 'aria-valuenow': Math.min(100, pct), 'aria-valuetext': `${pct.toFixed(1)}%` }}><span style={{ width: `${Math.max(0, Math.min(100, pct ?? 0))}%` }}/></div>
      <div className="cmi-between cmi-note"><span>窗口 {number(pressure?.window)}</span><span>{pct !== undefined && pct > 100 ? '超出' : '余量'} {pressure?.window ? number(Math.abs(pressure.window - pressure.projected)) : '—'}</span></div>
    </article><article className="cmi-card"><span className="cmi-note">下一次请求</span><h3 className="cmi-status">{status}</h3><p className="cmi-note" title="执行器会在完整请求组装后再次检查。">{gate ? `检查线 ${number(gate.admission)} Token` : data.historical ? '历史截面不推测窗口占用' : '等待窗口和输出预留参数'}</p></article>
      <article className="cmi-card"><span className="cmi-note">最近请求输入</span><div className="cmi-small-number">{number(pressure?.input)}<small>Token</small></div><p className="cmi-note">模型回报 · 含缓存输入</p></article></div>
    <div className="cmi-meta"><span title={data.model ? `${data.model.provider} / ${data.model.model}` : '尚无请求'}>{data.model ? `${data.model.provider} / ${data.model.model}` : '尚无模型记录'}</span><span>有效内容 {number(data.activeCount)} 项</span><span>触发 {policy ? `${policy.triggerPercent}%` : '—'} → 目标 {policy ? `${policy.targetPercent}%` : '—'}</span></div>
    <div className="cmi-columns cmi-summary"><PartList data={data} onCategory={onCategory}/><Compactions data={data}/></div>
  </>
}

function SessionFacts({ data }: { data: Inspection }) {
  return <article className="cmi-card"><h3>模型与累计用量</h3><dl className="cmi-facts"><dt>推理级别</dt><dd>{data.model?.effort ?? '未记录'}</dd><dt>输出预留</dt><dd>{number(data.model?.maxTokens)}</dd><dt>已替换内容</dt><dd>{number(data.archivedCount)} 项</dd><dt>累计输入</dt><dd>{number(data.usage?.input)}</dd><dt>累计输出</dt><dd>{number(data.usage?.output)}</dd><dt>缓存读取</dt><dd>{number(data.usage?.cacheRead)}</dd><dt>缓存读取占输入</dt><dd>{data.usage?.input ? `${(data.usage.cacheRead / data.usage.input * 100).toFixed(1)}%` : '—'}</dd></dl>
    <p className="cmi-note">组成按有效内容估算，与模型回报的窗口占用分别计量。累计消耗不代表当前窗口；独立摘要调用不在宿主主请求累计范围内。</p>
    {data.official && <details className="cmi-reference"><summary>宿主原始组成口径</summary><p className="cmi-note">系统 {number(data.official.system)} · 工具定义 {number(data.official.tools)} · 消息与工具结果 {number(data.official.messages)} Token</p><p className="cmi-note">先前系统片段归入注入内容。图片保留引用，实际图像用量由模型路由决定。</p></details>}
  </article>
}

function ContentDetail({ target, cutSeq, row, api }: { target: string; cutSeq: number; row: ContentRow; api: InspectorApi }) {
  const [offsets, setOffsets] = useState([0])
  const [page, setPage] = useState<ContentPage | null>(null)
  const [error, setError] = useState('')
  const [retry, setRetry] = useState(0)
  const offset = offsets.at(-1)!
  useEffect(() => {
    const controller = new AbortController()
    setPage(null); setError('')
    void api.content({ sessionId: target, cutSeq, id: row.id, offset }, controller.signal).then(value => {
      if (!controller.signal.aborted && value.sessionId === target && value.cutSeq === cutSeq && value.id === row.id) setPage(value)
    }).catch(reason => { if (!controller.signal.aborted) setError(errors(reason)) })
    return () => controller.abort()
  }, [api, target, cutSeq, row.id, offset, retry])
  return <article className="cmi-content-detail"><div className="cmi-between"><Tag>{row.current ? '当前有效内容' : '已替换 · 记录原文'}</Tag><span className="cmi-note">记录 {row.seq}</span></div><h3>{row.title}</h3><p className="cmi-note">{row.source}</p><div className="cmi-detail-facts"><span>{label(row.category)}</span><span>≈ {number(row.tokens)} Token</span>{row.images > 0 && <span>{row.images} 个图片引用</span>}</div>
    {error ? <div role="alert"><p>{error}</p><Button size="sm" onClick={() => setRetry(retry + 1)}>重试读取正文</Button></div> : !page ? <Empty>正在按需读取正文…</Empty> : <><pre className="cmi-body" tabIndex={0}>{page.text || '此项没有文本内容。'}</pre><div className="cmi-pagination"><Button size="sm" disabled={offsets.length === 1} onClick={() => setOffsets(value => value.slice(0, -1))}>上一段</Button><span>字符 {number(Math.min(offset + 1, page.totalChars))}–{number(offset + page.text.length)} / {number(page.totalChars)}</span><Button size="sm" disabled={page.nextOffset === null} onClick={() => { if (page.nextOffset !== null) setOffsets(value => [...value, page.nextOffset!]) }}>下一段</Button></div></>}
    <p className="cmi-note">只读正文，可选择复制；查看内容不会修改历史或发起模型请求。</p>
  </article>
}

function ContentBrowser({ data, query, change, api, target, loading }: { data: Inspection; query: InspectQuery; change: (patch: Partial<InspectQuery>) => void; api: InspectorApi; target: string; loading: boolean }) {
  const [selected, setSelected] = useState('')
  const row = data.rows.find(row => row.id === selected) ?? data.rows[0]
  return <article className="cmi-card"><div className="cmi-section-title"><h3>模型携带了哪些内容</h3><Tag>{number(data.total)} 项</Tag></div>
    <div className="cmi-filter-toolbar"><Input aria-label="搜索内容标题或来源" placeholder="搜索标题、工具或来源…" value={query.search} onChange={event => change({ search: event.target.value.slice(0, 200) })}/><select aria-label="内容排序" value={query.sort} onChange={event => change({ sort: event.target.value as InspectQuery['sort'] })}><option value="size">占用从大到小</option><option value="position">按记录顺序</option></select></div>
    <div className="cmi-filters" role="group" aria-label="内容分类"><Button size="sm" variant={query.category === 'all' ? 'primary' : 'ghost'} aria-pressed={query.category === 'all'} onClick={() => change({ category: 'all' })}>全部</Button>{categories.map(category => <Button key={category.id} size="sm" variant={query.category === category.id ? 'primary' : 'ghost'} aria-pressed={query.category === category.id} onClick={() => change({ category: category.id })}>{category.label}</Button>)}</div>
    <label className="cmi-archive-toggle"><input type="checkbox" checked={query.archived} onChange={event => change({ archived: event.target.checked })}/>包含已被压缩替换的历史条目</label>
    <p className="cmi-note">{query.archived ? '当前与已替换记录一起显示；历史条目不计入当前组成。' : '只列当前有效内容；工具定义来自该截面最近一次请求头。'} 标题与来源检索覆盖全部条目，正文按需读取。</p>
    <div className="cmi-content-layout"><div className="cmi-content-list" aria-label="上下文条目">{data.rows.length ? data.rows.map(item => <button key={item.id} aria-pressed={row?.id === item.id} onClick={() => setSelected(item.id)}><strong><i data-category={item.category}/>{item.title}</strong><span>{item.source}</span><div><small>{label(item.category)}{item.current ? '' : ' · 已替换'}</small><small>≈ {number(item.tokens)}</small></div></button>) : <Empty>没有符合条件的内容。</Empty>}</div>{row ? <ContentDetail key={`${target}:${data.cutSeq}:${row.id}`} target={target} cutSeq={data.cutSeq} row={row} api={api}/> : <Empty>选择条目后查看正文。</Empty>}</div>
    <div className="cmi-pagination"><Button size="sm" disabled={loading || data.offset === 0} onClick={() => change({ offset: Math.max(0, data.offset - data.pageSize) })}>上一页</Button><span>{number(data.total ? data.offset + 1 : 0)}–{number(Math.min(data.offset + data.pageSize, data.total))} / {number(data.total)}</span><Button size="sm" disabled={loading || data.offset + data.pageSize >= data.total} onClick={() => change({ offset: data.offset + data.pageSize })}>下一页</Button></div>
  </article>
}

function Trend({ data, onHistory }: { data: Inspection; onHistory: (seq: number) => void }) {
  const [selected, setSelected] = useState<number | null>(null)
  const shown = data.requests.slice(-40)
  const point = shown.find(request => request.seq === selected) ?? shown.at(-1)
  const maximum = Math.max(1, ...shown.map(request => request.input ?? 0))
  return <article className="cmi-card"><div className="cmi-section-title"><h3>上下文如何变化</h3><Tag>{number(data.requestCount)} 次回复记录</Tag></div><p className="cmi-note">最近 {shown.length} 次回复回报的输入用量，包含缓存；未知用量留空。摘要调用与失败重试不在此图中。</p>
    {!point ? <Empty>模型返回回复后，这里会显示记录。</Empty> : <><div className="cmi-chart" role="group" aria-label="逐次回复的输入 Token"><span className="cmi-chart-max">{number(maximum)}</span>{shown.map((request, i) => <button key={request.seq} className={point.seq === request.seq ? 'cmi-chart-selected' : ''} onClick={() => setSelected(request.seq)} aria-pressed={point.seq === request.seq} aria-label={`记录 ${request.seq}，输入 ${number(request.input)} Token`} title={`第 ${request.turn} 轮 / 步骤 ${request.step} · ${number(request.input)} Token`}><span style={{ height: request.input === null ? 0 : `${Math.max(1, request.input / maximum * 100)}%` }}/><small>{request.input === null ? '?' : i === 0 || i === shown.length - 1 || i % 5 === 0 ? i + Math.max(0, data.requestCount - shown.length) + 1 : ''}</small></button>)}</div>
      <div className="cmi-request"><div><strong>第 {point.turn} 轮 · 步骤 {point.step}</strong><p className="cmi-note">{point.provider} / {point.model} · {time(point.time)}</p></div><dl className="cmi-facts"><dt>输入</dt><dd>{number(point.input)}</dd><dt>输出</dt><dd>{number(point.output)}</dd><dt>缓存读取</dt><dd>{number(point.cacheRead)}</dd></dl><Button size="sm" variant="outline" onClick={() => onHistory(point.seq)}>查看这次回复后的上下文</Button></div>
      <details className="cmi-request-table"><summary>查看最近 {data.requests.length} 条回复记录</summary><div><table><thead><tr><th>轮 / 步骤</th><th>输入</th><th>输出</th><th>缓存读取</th><th>时间</th></tr></thead><tbody>{[...data.requests].reverse().map(request => <tr key={request.seq}><td><button onClick={() => onHistory(request.seq)}>{request.turn} / {request.step}</button></td><td>{number(request.input)}</td><td>{number(request.output)}</td><td>{number(request.cacheRead)}</td><td>{time(request.time)}</td></tr>)}</tbody></table></div></details></>}
  </article>
}

function Compactions({ data }: { data: Inspection }) {
  const [expanded, setExpanded] = useState(false)
  const entries = [...data.compactions].reverse()
  const shown = expanded ? entries : entries.slice(0, 2)
  const names = { running: '正在压缩', completed: '已完成', failed: '失败', interrupted: '已中断', unapplied: '未确认替换' }
  return <article className="cmi-card"><div className="cmi-section-title"><h3>最近压缩</h3><span className="cmi-note">{entries.length} 条记录</span></div>{!data.compactions.length ? <Empty>当前截面还没有压缩或裁剪记录。</Empty> : <ol className="cmi-events">{shown.map(entry => <li key={entry.id}><div className="cmi-between"><strong>{entry.kind === 'prune' ? '裁剪' : entry.manual ? '手动压缩' : '任务内压缩'}</strong><Tag tone={entry.status === 'completed' ? 'success' : entry.status === 'failed' ? 'warning' : 'neutral'}>{names[entry.status]}</Tag></div><p className="cmi-note">{time(entry.startedAt)}{entry.endedAt === undefined ? '' : ` · ${((entry.endedAt - entry.startedAt) / 1000).toFixed(1)} 秒`}</p>{entry.applied && entry.beforeTokens !== undefined && entry.afterTokens !== undefined && <p>被替换内容 ≈ {number(entry.beforeTokens)} → {number(entry.afterTokens)} Token{entry.beforeTokens > entry.afterTokens ? `，减少约 ${number(entry.beforeTokens - entry.afterTokens)}` : '，未缩减'}</p>}{entry.status === 'failed' && entry.applied && <p>内容已替换，但收尾失败，不能视为回滚。</p>}{entry.error && <p className="cmi-note">{entry.error}</p>}</li>)}</ol>}<div className="cmi-between cmi-card-footer"><span className="cmi-note">前后值仅指被替换片段</span>{entries.length > 2 && <Button size="sm" variant="ghost" aria-expanded={expanded} onClick={() => setExpanded(!expanded)}>{expanded ? '收起记录' : `全部 ${entries.length} 条`}</Button>}</div></article>
}

/** Mounted only as the selected, Session-scoped conversation.view entry. */
export function ContextInspectorView({ target, form, api, pulse }: ContextViewInjected) {
  const viewRef = useReadonlyView(target)
  const contentRef = useRef<HTMLDivElement>(null)
  const [expanded, setExpanded] = useState(false)
  useEffect(() => setExpanded(false), [target])
  const scrollToContent = useRef(false)
  const [query, setQuery] = useState<InspectQuery>({ sessionId: target, ...defaultQuery })
  const [data, setData] = useState<Inspection | null>(null)
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(true)
  const [retry, setRetry] = useState(0)
  const accepted = useSyncExternalStore(callback => form.subscribe(callback), () => form.getSnapshot())
  const revision = useSyncExternalStore(callback => pulse.subscribe(callback), () => pulse.getSnapshot())
  const effective = useMemo(() => query.sessionId === target ? query : { sessionId: target, ...defaultQuery }, [query, target])
  const automatic = effective.atSeq === null ? revision : null
  const safeData = data?.sessionId === target && data.historical === (effective.atSeq !== null)
    && (effective.atSeq === null || data.cutSeq === effective.atSeq) ? data : null
  useEffect(() => {
    const controller = new AbortController()
    setLoading(true); setError('')
    const timer = setTimeout(() => {
      void api.inspect(effective, controller.signal).then(value => {
        if (!controller.signal.aborted && value.sessionId === target) { setData(value); setLoading(false) }
      }).catch(reason => { if (!controller.signal.aborted) { setError(errors(reason)); setLoading(false) } })
    }, 200)
    return () => { clearTimeout(timer); controller.abort() }
  }, [api, effective, automatic, retry, target])
  useEffect(() => {
    if (safeData && scrollToContent.current && contentRef.current) {
      contentRef.current.scrollIntoView?.({ block: 'start' })
      scrollToContent.current = false
    }
  }, [safeData, effective])
  function change(patch: Partial<InspectQuery>) { setQuery({ ...effective, offset: 0, ...patch }) }
  function showContent(category: Category) { setExpanded(true); scrollToContent.current = true; change({ category, archived: false, search: '' }) }
  function showHistory(seq: number) { scrollToContent.current = true; change({ atSeq: seq, category: 'all', search: '', archived: false }) }
  return <section ref={viewRef} className="dsh-context-settings cmi-view" aria-label="当前会话上下文" key={target}>
    <style data-plugin="dsh-context-manager" data-plugin-css="dsh-context-manager/inspector">{css}</style>
    <div className="cmi-inner"><header className="cmi-header"><div className="cmi-section-title"><h2>上下文</h2><span className="cmi-note">只读</span></div><Button size="sm" variant="outline" disabled={loading} onClick={() => setRetry(retry + 1)}>刷新数据</Button></header>
      <div className="cmi-data-status"><span>{loading ? '正在读取…' : error ? '读取失败' : safeData ? `更新于 ${time(safeData.sampledAt)}` : '等待数据'}</span><span>压缩参数：设置 → 上下文管理</span></div>
      {effective.atSeq !== null && <div className="cmi-notice"><div><strong>历史截面 · 截至记录 {effective.atSeq}</strong><p>重放这次回复之后的有效内容，包含该回复；不是当次模型请求原文。</p></div><Button size="sm" onClick={() => change({ ...defaultQuery })}>返回当前上下文</Button></div>}
      {error && <div className="cmi-notice" role="alert"><div><strong>{error}</strong>{safeData && <p>以下保留上次成功读取的数据。</p>}</div><Button size="sm" onClick={() => setRetry(retry + 1)}>重试</Button></div>}
      {!safeData ? <Empty>{loading ? '正在读取这段会话的上下文…' : '没有可用数据。'}</Empty> : <>
        <div key={target} id="cmi-overview-panel"><Overview data={safeData} policy={accepted.value?.policy} stale={!!error || loading} onCategory={showContent}/></div>
        <div ref={contentRef} className="cmi-expand-row"><Button size="sm" variant="ghost" aria-expanded={expanded} onClick={() => setExpanded(!expanded)}>{expanded ? '收起详细内容与记录' : '展开详细内容与记录'}</Button><span className="cmi-note">内容正文、逐次变化、累计用量</span></div>
        {expanded && <div className="cmi-details">
          <div id="cmi-content-panel"><ContentBrowser key={target} data={safeData} query={effective} change={change} api={api} target={target} loading={loading}/></div>
          <div id="cmi-history-panel" className="cmi-columns"><Trend data={safeData} onHistory={showHistory}/><SessionFacts data={safeData}/></div>
        </div>}
      </>}
    </div>
  </section>
}
