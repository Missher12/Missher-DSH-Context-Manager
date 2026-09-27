import { useEffect, useState, useSyncExternalStore } from 'react'
import type { ISessions } from '@deepseek-ai/dsh-api-session-controller/client'
import type { SessionProjectionMap } from '@deepseek-ai/dsh-session-projection/types'
import type {} from '@deepseek-ai/dsh-token-meter/client'
import { Button } from '@deepseek-ai/dsh-client-ui-primitives'
import type { ContextDiagnostics } from './diagnostics-types.ts'
import type { Policy } from './policy.ts'

const number = (value: number | undefined) => value === undefined ? '—' : Math.round(value).toLocaleString()
const time = (value: number) => new Date(value).toLocaleString('zh-CN', { hour12: false })
const statuses = { running: '正在压缩', completed: '已完成', failed: '失败', interrupted: '已中断', unapplied: '未确认替换' }

export function ContextOverview({ sessions, policy }: { sessions: ISessions; policy: Policy }) {
  const list = useSyncExternalStore(callback => sessions.list.subscribe(callback), () => sessions.list.getSnapshot())
  const [chosen, setChosen] = useState('')
  const rows = list.ids.map(id => list.byId[id])
  const selected = rows.find(row => row.id === chosen) ?? rows.find(row => Object.entries(row.retainedBy).some(([source, count]) => source === 'mainView' && (count ?? 0) > 0)) ?? rows.find(row => !row.blank) ?? rows[0]
  const projection = selected ? list.projectionsBySession[selected.id] : undefined
  const [readError, setReadError] = useState('')
  useEffect(() => {
    setReadError('')
    if (!selected) return
    let active = true
    void sessions.refreshProjections(selected.id).catch(() => { if (active) setReadError('暂时无法读取会话信息，请重试。') })
    return () => { active = false }
  }, [sessions, selected?.id])
  if (!selected) return <p className="cm-empty">{list.phase === 'pending' ? '正在读取会话…' : '还没有会话。发送第一条任务后，这里会显示上下文信息。'}</p>
  const values = projection?.values ?? selected.projectionValues ?? {}
  const failed = projection?.state === 'error' || !!readError
  return <div>
    <div className="cm-field">
      <label htmlFor="cm-session" className="cm-label">查看会话</label>
      <select id="cm-session" className="cm-select" value={selected.id} onChange={event => setChosen(event.target.value)}>
        {rows.map(row => <option key={row.id} value={row.id}>{row.displayTitle}{row.running ? ' · 执行中' : ''}</option>)}
      </select>
      <p className="cm-hint">{selected.running ? '任务正在执行，数据随已记录的事件更新。' : '显示这段会话最近记录的数据。'} 查看信息不会发起模型请求。</p>
    </div>
    {failed && <div className="cm-field" role="alert"><p className="cm-hint">读取失败，下面可能是上次收到的数据。</p><Button size="sm" onClick={() => { setReadError(''); void sessions.refreshProjections(selected.id).catch(() => setReadError('读取失败')) }}>重试读取</Button></div>}
    {!failed && (!projection || projection.state === 'loading' || projection.state === 'idle') && <p className="cm-hint" role="status">正在读取上下文信息…</p>}
    <ContextReadout values={values} policy={policy} />
  </div>
}

/** The host's occupancy, heuristic composition and billed usage remain separate. */
export function ContextReadout({ values, policy }: { values: Readonly<Partial<SessionProjectionMap>>; policy: Policy }) {
  const pressure = values.contextPressure
  const parts = values.contextBreakdown
  const diagnostic: ContextDiagnostics | undefined = values.contextManagerDiagnostics
  const usage = values.tokenUsage
  const window = pressure?.contextWindow
  const occupancy = pressure?.projectedTokens
  const pct = occupancy !== undefined && window && window > 0 ? occupancy / window * 100 : undefined
  const partTotal = parts ? parts.systemTokens + parts.toolsTokens + parts.messageTokens : 0
  const latest = diagnostic?.request
  return <>
    <div className="cm-field">
      <div className="cm-row"><span className="cm-label">上下文占用</span><strong className="cm-stat">{pct === undefined ? '—' : `${pct.toFixed(1)}%`}</strong></div>
      <div className="cm-meter" role="meter" aria-label="上下文占用" aria-valuemin={0} aria-valuemax={100} aria-valuenow={pct === undefined ? undefined : Math.min(100, Math.max(0, pct))} aria-valuetext={pct === undefined ? '尚无用量数据' : `约 ${number(occupancy)} Token，占窗口 ${pct.toFixed(1)}%`}><span style={{ width: `${Math.min(100, Math.max(0, pct ?? 0))}%` }} /></div>
      <dl className="cm-facts">
        <dt>当前占用（估算）</dt><dd>{occupancy === undefined ? '等待模型返回用量' : `≈ ${number(occupancy)} Token`}</dd>
        <dt>模型上下文窗口</dt><dd>{window ? `${number(window)} Token` : '宿主尚未记录窗口'}</dd>
        <dt>{pct !== undefined && pct > 100 ? '预计超出窗口' : '距窗口上限'}</dt><dd>{occupancy !== undefined && window ? `≈ ${number(Math.abs(window - occupancy))} Token` : '—'}</dd>
        <dt>最近请求输入（实测）</dt><dd>{number(pressure?.pressureTokens)} Token</dd>
        <dt>最近组装的模型</dt><dd>{latest ? `${latest.provider} / ${latest.model}` : '暂无请求'}</dd>
        {latest?.effort && <><dt>推理级别</dt><dd>{latest.effort}</dd></>}
        <dt>记录的输出预留</dt><dd>{latest?.maxTokens === undefined ? '未记录；执行时由实际路由确定' : `${number(latest.maxTokens)} Token`}</dd>
      </dl>
      <p className="cm-hint">占用读数与 DSH 使用同一数据源：最近输入实测值加上后续内容变化的估算。图像、中文与模型切换可能带来偏差；距窗口上限包含尚需预留的输出空间。</p>
      <p className="cm-hint">{policy.enabled ? `已保存策略：${policy.triggerPercent}% 触发，提前 ${policy.earlyPercent}% 检查，压缩目标 ${policy.targetPercent}%。输出预留与安全空间可能降低检查线；执行时按实际模型和完整请求确定。` : '自动压缩已关闭，超出安全窗口时暂停。'}</p>
    </div>
    <div className="cm-field">
      <h3 className="cm-subtitle">上下文由什么组成</h3>
      {parts ? <div className="cm-breakdown">{([
        ['系统指令', parts.systemTokens], ['工具定义', parts.toolsTokens], ['消息与工具结果', parts.messageTokens],
      ] as const).map(([label, tokens]) => <div key={label}><div className="cm-row"><span>{label}</span><span>≈ {number(tokens)} Token</span></div><div className="cm-meter cm-meter-small" aria-hidden="true"><span style={{ width: `${partTotal ? tokens / partTotal * 100 : 0}%` }} /></div></div>)}</div> : <p className="cm-hint">等待宿主提供组成数据。</p>}
      <p className="cm-hint">这三项按文本密度估算，用于比较组成；相加不等于上面的模型用量。工具结果与历史消息均计入消息项。</p>
      {diagnostic && <details className="cm-detail"><summary>工具定义占用 · {diagnostic.tools.count} 个工具</summary>
        {diagnostic.tools.top.length ? <ol className="cm-tool-list">{diagnostic.tools.top.map((tool, index) => <li key={`${index}:${tool.name}`}><code>{tool.name}</code><span>≈ {number(tool.tokens)}</span></li>)}</ol> : <p className="cm-hint">最近记录的请求未包含工具定义。</p>}
        <p className="cm-hint">按定义长度列出最多 8 项，不包含工具执行返回的内容。可优先检查不常用或重复的工具；此页不会自动停用工具。</p>
      </details>}
    </div>
    <div className="cm-field">
      <h3 className="cm-subtitle">最近压缩记录</h3>
      {!diagnostic ? <p className="cm-hint">等待诊断数据。若持续未显示，请确认当前 profile 已加载新版插件。</p> : !diagnostic.compactions.length ? <p className="cm-hint">这段会话还没有压缩或裁剪记录。</p> : <ol className="cm-history">{[...diagnostic.compactions].reverse().map(entry => <li key={entry.id}>
        <div className="cm-row"><span>{entry.kind === 'prune' ? '裁剪' : entry.manual ? '手动压缩' : '任务内压缩'}</span><span>{statuses[entry.status]}</span></div>
        <p className="cm-hint">{time(entry.startedAt)}{entry.endedAt === undefined ? '' : ` · ${Math.max(0, (entry.endedAt - entry.startedAt) / 1000).toFixed(1)} 秒`}</p>
        {entry.applied && entry.beforeTokens !== undefined && entry.afterTokens !== undefined && <p className="cm-record-result">被替换内容：≈ {number(entry.beforeTokens)} → {number(entry.afterTokens)} Token{entry.beforeTokens > entry.afterTokens ? `，减少约 ${number(entry.beforeTokens - entry.afterTokens)}` : '，未缩减'}{entry.messages === undefined ? '' : ` · ${entry.messages} 条消息`}</p>}
        {entry.status === 'failed' && entry.applied && <p className="cm-hint">内容已替换，但后续收尾失败；不能视为已回滚。</p>}
        {entry.error && <p className="cm-record-error">{entry.error}</p>}
      </li>)}</ol>}
      <p className="cm-hint">最多显示 12 条。前后值仅指本次替换的历史片段，按相同方法估算，不代表整个会话；原始记录保留在宿主日志中。</p>
    </div>
    <details className="cm-detail cm-field"><summary>最近请求用量</summary>
      <p className="cm-hint">最多 12 次已有消息结算且返回用量的请求。输入含缓存；失败重试及摘要调用不在此列表中。</p>
      {diagnostic?.requests.length ? <ol className="cm-history">{[...diagnostic.requests].reverse().map(request => <li key={request.seq}>
        <div className="cm-row"><span>轮次 {request.turn} · 步骤 {request.step}</span><span>输入 {number(request.input)} / 输出 {number(request.output)}</span></div>
        <p className="cm-hint">{request.provider} / {request.model} · {time(request.time)}</p>
      </li>)}</ol> : <p className="cm-hint">暂无已报告用量的请求。</p>}
    </details>
    <details className="cm-detail cm-field"><summary>宿主累计用量</summary>
      {usage ? <dl className="cm-facts"><dt>非缓存输入</dt><dd>{number(usage.uncachedInputTokens)}</dd><dt>缓存读取</dt><dd>{number(usage.cacheReadTokens)}</dd><dt>缓存写入</dt><dd>{number(usage.cacheWriteTokens)}</dd><dt>输出</dt><dd>{number(usage.outputTokens)}</dd></dl> : <p className="cm-hint">尚无累计用量数据。</p>}
      <p className="cm-hint">沿用 DSH 的主请求与重试统计，不包含独立摘要调用，不等同于账单。推理 Token 已计入输出；缓存命中不会让对应内容退出上下文窗口。</p>
    </details>
  </>
}
