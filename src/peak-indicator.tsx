import { useEffect, useId, useRef, useState, useSyncExternalStore } from 'react'
import { createPortal } from 'react-dom'
import { Button, Input, IconClockOutlineRegular, MenuSurface, Tooltip, useAnchoredPosition, useDismissOnOutsidePointer } from '@deepseek-ai/dsh-client-ui-primitives'
import type { ModelDirectoryState } from '@deepseek-ai/dsh-client-ui-model-selection/client'
import { beijingTime, compareCost, isOfficialDeepSeek, modelPrice, nextPeriodChange, periodAt, PRICING_URL, RULE_CHECKED, tokenCount } from './deepseek-period.ts'
import css from './peak-indicator.css'

export interface PeakIndicatorProps {
  directory: { subscribe(callback: () => void): () => void; getSnapshot(): Pick<ModelDirectoryState, 'current'> }
}

/** Share the native picker's accepted selection, including a new Session's
 * default before usage exists. Pending/failed switches keep that selection.
 */
export function PeakIndicator({ directory }: PeakIndicatorProps) {
  const model = useSyncExternalStore(callback => directory.subscribe(callback), () => directory.getSnapshot())
  return isOfficialDeepSeek(model.current) && model.current
    ? <PeriodClock key={`${model.current.provider}/${model.current.model}`} model={model.current.model}/> : null
}

const fields = [{ key: 'cache', label: '缓存命中输入' }, { key: 'input', label: '未命中输入' }, { key: 'output', label: '输出' }] as const
const money = (value: number) => `¥${value.toLocaleString('zh-CN', { maximumFractionDigits: 8 })}`

function PeriodClock({ model }: { model: string }) {
  const ref = useRef<HTMLSpanElement>(null)
  const trigger = useRef<HTMLButtonElement>(null)
  const panel = useRef<HTMLDivElement>(null)
  const [now, setNow] = useState(Date.now)
  const [open, setOpen] = useState(false)
  const [counts, setCounts] = useState({ cache: '', input: '', output: '' })
  const id = useId()
  const position = useAnchoredPosition({ open, anchorRef: trigger, panelRef: panel, side: 'top', align: 'end', gap: 8, margin: 12 })
  useDismissOnOutsidePointer(ref, open, setOpen, panel)
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
  const cost = price ? compareCost(price, counts) : null
  const invalid = fields.some(({ key }) => counts[key].trim() !== '' && tokenCount(counts[key]) === null)
  const close = () => { setOpen(false); trigger.current?.focus() }
  const doc = ref.current?.ownerDocument
  return <span ref={ref} className="dsh-context-settings cmi-peak" data-period={period}>
    <style data-plugin="dsh-context-manager" data-plugin-css="dsh-context-manager/peak">{css}</style>
    <Tooltip label={`${label} · 查看官方价格与用量估算`} side="top" delayMs={200} disabled={open}>
      <button ref={trigger} type="button" aria-label={`DeepSeek 官方计费：${label}`} aria-haspopup="dialog" aria-expanded={open} aria-controls={open ? id : undefined} onClick={() => setOpen(value => !value)}>
        <IconClockOutlineRegular size={14}/><span>{label}</span>
      </button>
    </Tooltip>
    {open && doc && createPortal(<MenuSurface ref={panel} id={id} role="dialog" aria-label="DeepSeek 官方价格与估算" tabIndex={-1} className="dsh-context-settings cmi-price-panel" style={{ ...position, visibility: position ? 'visible' : 'hidden' }}>
      <div className="cmi-price-heading"><div><h3>{price?.name ?? model}</h3><span className="cmi-price-note">人民币 / 百万 Token</span></div><Button size="sm" variant="ghost" onClick={close}>关闭</Button></div>
      <p className="cmi-price-period" data-period={period}>{label}<span>{next === null ? ' · 当前日历信息待核对' : ` · 北京时间 ${beijingTime(next)} 切换`}</span></p>
      {price ? <><table className="cmi-price-table"><thead><tr><th scope="col">类型</th><th scope="col" data-current={period === 'peak'}>高峰期</th><th scope="col" data-current={period === 'offpeak'}>低谷期</th></tr></thead><tbody>{fields.map(({ key, label: fieldLabel }) => <tr key={key}><th scope="row">{fieldLabel}</th><td>{money(price[key])}</td><td>{money(price[key] / 2)}</td></tr>)}</tbody></table>
        <div className="cmi-price-heading"><h4>同等用量估算</h4><span className="cmi-price-note">手动输入 Token</span></div>
        <div className="cmi-price-inputs">{fields.map(({ key, label: fieldLabel }) => <label key={key} htmlFor={`${id}-${key}`}><span>{fieldLabel}</span><Input id={`${id}-${key}`} inputMode="numeric" autoComplete="off" placeholder="填写数量" value={counts[key]} aria-invalid={counts[key].trim() !== '' && tokenCount(counts[key]) === null} onChange={event => setCounts(value => ({ ...value, [key]: event.target.value.slice(0, 20) }))}/></label>)}</div>
        <div className="cmi-price-totals" aria-live="polite"><div><span>高峰预估</span><strong>{cost ? money(cost.peak) : '—'}</strong></div><div><span>低谷预估</span><strong>{cost ? money(cost.offpeak) : '—'}</strong></div></div>
        <p className="cmi-price-note" role={invalid ? 'alert' : undefined}>{invalid ? '请输入有效的非负整数' : '填齐三项后计算，没有用量请填 0。仅按同一组用量比较，不是实际账单。'}</p>
      </> : <p className="cmi-price-unavailable">该官方模型的价格尚未收录，请查看官方说明。</p>}
      <details className="cmi-price-rules"><summary>时段规则</summary><p>北京时间周一至周五 09:00–12:00、14:00–18:00 为高峰期，其余时间、周末及中国法定节假日为低谷期。本地日历覆盖 2026 年。</p></details>
      <div className="cmi-price-source"><span>核对于 {RULE_CHECKED} · 计费以官方为准</span><a href={PRICING_URL} target="_blank" rel="noopener noreferrer">官方价格说明</a></div>
    </MenuSurface>, doc.body)}
  </span>
}
