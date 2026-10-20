import { useEffect, useId, useRef, useState, useSyncExternalStore } from 'react'
import { createPortal } from 'react-dom'
import { Button, Tooltip } from '@deepseek-ai/dsh-client-ui-primitives'
import type { ModelDirectoryState } from '@deepseek-ai/dsh-client-ui-model-selection/client'
import type { SessionUsageReadout } from './inspector-types.ts'
import { beijingTime, isOfficialDeepSeek, modelPrice, nextPeriodChange, periodAt, PRICING_URL, RULE_CHECKED } from './deepseek-period.ts'
import css from './peak-indicator.css'

export interface PeakIndicatorProps {
  sessionId: string
  directory: { subscribe(callback: () => void): () => void; getSnapshot(): Pick<ModelDirectoryState, 'current'> }
  usagePulse: { subscribe(callback: () => void): () => void; getSnapshot(): unknown }
  readUsage(signal: AbortSignal): Promise<SessionUsageReadout>
}

/** Keep the indicator scoped to this session; current-model changes never rewrite historical estimates. */
export function PeakIndicator({ sessionId, directory, usagePulse, readUsage }: PeakIndicatorProps) {
  const model = useSyncExternalStore(callback => directory.subscribe(callback), () => directory.getSnapshot())
  return isOfficialDeepSeek(model.current) && model.current
    ? <PeriodClock key={sessionId} sessionId={sessionId} usagePulse={usagePulse} readUsage={readUsage} model={model.current.model}/> : null
}

const fields = [{ key: 'cache', label: '缓存命中输入' }, { key: 'input', label: '未命中输入' }, { key: 'output', label: '输出' }] as const
const money = (value: number) => `¥${value.toLocaleString('zh-CN', { maximumFractionDigits: 8 })}`
const tokenNumber = (value: number) => value.toLocaleString('zh-CN')
const issueText = {
  'missing-usage': '部分结算缺少 Token 数据，金额只估算了已知部分。',
  'unknown-route': '部分请求没有可用的官方模型价格，未计入金额。',
  'unknown-period': '部分记录超出已核对的 2026 年日历，未计入金额。',
  'cache-write': '缓存写入没有单独的官方价格，未计入金额。',
  'maintenance-overlap': '部分维护请求可能与摘要用量重叠，已从金额估算中排除。',
  'summary-unpriced': '摘要与修复用量另列；缺少逐次模型和时间，未计入金额。',
  'host-difference': '用量记录与会话累计数字不一致，金额估算不完整。',
} as const

type UsageState = { sessionId: string; loading: boolean; value?: SessionUsageReadout; failed?: boolean }

function PeriodClock({ sessionId, model, usagePulse, readUsage }: Pick<PeakIndicatorProps, 'sessionId' | 'usagePulse' | 'readUsage'> & { model: string }) {
  const ref = useRef<HTMLSpanElement>(null)
  const trigger = useRef<HTMLButtonElement>(null)
  const panel = useRef<HTMLDivElement>(null)
  const readUsageRef = useRef(readUsage)
  const requestEpoch = useRef(0)
  const [now, setNow] = useState(Date.now)
  const [open, setOpen] = useState(false)
  const [usage, setUsage] = useState<UsageState | null>(null)
  const [retry, setRetry] = useState(0)
  const [position, setPosition] = useState<{ left: number; top: number } | null>(null)
  const revision = useSyncExternalStore(callback => usagePulse.subscribe(callback), () => usagePulse.getSnapshot())
  const id = useId()

  useEffect(() => { readUsageRef.current = readUsage }, [readUsage])
  useEffect(() => {
    if (!open) return
    const controller = new AbortController()
    const epoch = ++requestEpoch.current
    setUsage(current => ({ sessionId, loading: true, ...(current?.sessionId === sessionId && current.value ? { value: current.value } : {}) }))
    void readUsageRef.current(controller.signal).then(value => {
      if (controller.signal.aborted || requestEpoch.current !== epoch || value.sessionId !== sessionId) return
      setUsage({ sessionId, loading: false, value })
    }, () => {
      if (controller.signal.aborted || requestEpoch.current !== epoch) return
      setUsage(current => ({ sessionId, loading: false, failed: true, ...(current?.sessionId === sessionId && current.value ? { value: current.value } : {}) }))
    })
    return () => { controller.abort(); requestEpoch.current++ }
  }, [open, sessionId, revision, retry])

  useEffect(() => {
    if (!open) { setPosition(null); return }
    const doc = ref.current?.ownerDocument
    const win = doc?.defaultView
    if (!doc || !win) return
    const place = () => {
      const anchor = trigger.current?.getBoundingClientRect()
      if (!anchor) return
      const height = panel.current?.getBoundingClientRect().height ?? 300
      const width = Math.min(388, Math.max(0, win.innerWidth - 24))
      const margin = 12
      const left = Math.max(margin, Math.min(anchor.right - width, win.innerWidth - width - margin))
      const above = anchor.top - height - 8
      const top = above >= margin ? above : Math.max(margin, Math.min(anchor.bottom + 8, win.innerHeight - height - margin))
      setPosition({ left, top })
    }
    place()
    doc.addEventListener('scroll', place, true)
    win.addEventListener('resize', place)
    return () => { doc.removeEventListener('scroll', place, true); win.removeEventListener('resize', place) }
  }, [open, usage])
  useEffect(() => {
    if (!open) return
    const doc = ref.current?.ownerDocument
    if (!doc) return
    const outside = (event: PointerEvent) => {
      const target = event.target
      if (!(target instanceof Node) || ref.current?.contains(target) || panel.current?.contains(target)) return
      setOpen(false)
    }
    doc.addEventListener('pointerdown', outside, true)
    return () => doc.removeEventListener('pointerdown', outside, true)
  }, [open])
  useEffect(() => {
    const doc = ref.current?.ownerDocument
    const win = doc?.defaultView
    let timer: ReturnType<typeof setTimeout>
    const update = () => {
      clearTimeout(timer)
      const time = Date.now()
      setNow(time)
      timer = setTimeout(update, 60_000 - time % 60_000 + 5)
    }
    update()
    doc?.addEventListener('visibilitychange', update)
    win?.addEventListener('focus', update)
    return () => { clearTimeout(timer); doc?.removeEventListener('visibilitychange', update); win?.removeEventListener('focus', update) }
  }, [])
  useEffect(() => {
    if (!open) return
    const doc = ref.current?.ownerDocument
    const escape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      event.preventDefault(); event.stopPropagation(); setOpen(false); trigger.current?.focus()
    }
    panel.current?.focus()
    doc?.addEventListener('keydown', escape, true)
    return () => doc?.removeEventListener('keydown', escape, true)
  }, [open])

  const period = periodAt(now)
  const label = period === 'peak' ? '高峰期' : period === 'offpeak' ? '低谷期' : '时段待核对'
  const next = nextPeriodChange(now)
  const price = modelPrice(model)
  const currentUsage = usage?.sessionId === sessionId ? usage : null
  const readout = currentUsage?.value
  const close = () => { setOpen(false); trigger.current?.focus() }
  const doc = ref.current?.ownerDocument

  return <span ref={ref} className="dsh-context-settings cmi-peak" data-period={period}>
    <style data-plugin="dsh-context-manager" data-plugin-css="dsh-context-manager/peak">{css}</style>
    <Tooltip label={`${label} · 查看本会话用量与估算`} side="top" delayMs={200} disabled={open}>
      <button ref={trigger} type="button" aria-label={`DeepSeek 官方计费：查看本会话用量，当前${label}`} aria-haspopup="dialog" aria-expanded={open} aria-controls={open ? id : undefined} onClick={() => setOpen(value => !value)}>
        <span aria-hidden="true" className="cmi-clock">◷</span><span>{label}</span>
      </button>
    </Tooltip>
    {open && doc && createPortal(<div ref={panel} id={id} role="dialog" aria-label="DeepSeek 官方价格与本会话用量" tabIndex={-1} className="dsh-context-settings cmi-price-panel" style={{ left: position?.left ?? 0, top: position?.top ?? 0, visibility: position ? 'visible' : 'hidden' }}>
      <div className="cmi-price-heading"><div><h3>{price?.name ?? model}</h3><span className="cmi-price-note">当前选择参考价 · 人民币 / 百万 Token</span></div><Button size="sm" variant="ghost" onClick={close}>关闭</Button></div>
      <p className="cmi-price-period" data-period={period}>{label}<span>{next === null ? ' · 当前日历信息待核对' : ` · 北京时间 ${beijingTime(next)} 切换`}</span></p>
      {price ? <table className="cmi-price-table"><thead><tr><th scope="col">类型</th><th scope="col" data-current={period === 'peak'}>高峰期</th><th scope="col" data-current={period === 'offpeak'}>低谷期</th></tr></thead><tbody>{fields.map(({ key, label: fieldLabel }) => <tr key={key}><th scope="row">{fieldLabel}</th><td>{money(price[key])}</td><td>{money(price[key] / 2)}</td></tr>)}</tbody></table>
        : <p className="cmi-price-unavailable">当前选择的模型价格尚未收录。</p>}
      <section className="cmi-session-usage" aria-label="本会话用量与费用估算">
          <div className="cmi-price-heading"><h4>本会话已记录用量</h4>{readout?.partial && <span className="cmi-price-badge">部分估算</span>}</div>
          {currentUsage?.loading && <p className="cmi-usage-state" role="status">正在读取本会话记录…</p>}
          {currentUsage?.failed && <div className="cmi-usage-state" role="alert"><span>暂时无法读取用量。</span><Button size="sm" variant="ghost" onClick={() => setRetry(value => value + 1)}>重试</Button></div>}
          {readout?.status === 'analysis-limit' && <p className="cmi-usage-state" role="status">会话记录超过统计上限，无法完整统计用量与费用。</p>}
          {readout?.status === 'ready' && !readout.hasRecords && <p className="cmi-usage-state" role="status">暂无已记录用量</p>}
          {readout?.hasRecords && <>
            {(readout.settledAttempts > 0 || readout.requestTokens > 0) && <div className="cmi-usage-total"><span>会话请求累计</span><strong>{tokenNumber(readout.requestTokens)} Token{readout.requestTokensPartial ? ' · 部分字段未知' : ''}</strong><small>{readout.status === 'analysis-limit' ? '逐次记录超过统计上限，金额未估算' : `${tokenNumber(readout.settledAttempts)} 次结算${readout.retries ? ` · 含 ${tokenNumber(readout.retries)} 次重试` : ''}`}</small></div>}
            <div className="cmi-price-totals" aria-live="polite"><div><span>高峰已估算</span><strong>{readout.peak === null ? '—' : money(readout.peak)}</strong></div><div><span>低谷已估算</span><strong>{readout.offpeak === null ? '—' : money(readout.offpeak)}</strong></div><div><span>{readout.partial ? '已估算部分' : '估算合计'}</span><strong>{readout.total === null ? '—' : money(readout.total)}</strong></div></div>
            {readout.summary && readout.summary.attempts > 0 && <p className="cmi-usage-summary">摘要与修复另记：{tokenNumber(readout.summary.tokens)} Token{readout.summary.unknownAttempts ? ' · 另有用量未知' : ''}</p>}
            {readout.issues.length > 0 && <ul className="cmi-usage-issues" aria-label="估算说明">{readout.issues.map(issue => <li key={issue}>{issueText[issue]}</li>)}</ul>}
          </>}
          {!currentUsage && <p className="cmi-usage-state" role="status">打开后读取本会话记录</p>}
      </section>
      <p className="cmi-price-note">历史请求按各自记录的模型、时段与当前参考价估算；无法定价的用量未计入费用估算。金额不是历史账单。</p>
      <details className="cmi-price-rules"><summary>时段规则</summary><p>北京时间周一至周五 09:00–12:00、14:00–18:00 为高峰期，其余时间、周末及中国法定节假日为低谷期。本地日历覆盖 2026 年。</p></details>
      <div className="cmi-price-source"><span>价格核对于 {RULE_CHECKED} · 计费以官方为准</span><a href={PRICING_URL} target="_blank" rel="noopener noreferrer">官方价格说明</a></div>
    </div>, doc.body)}
  </span>
}
