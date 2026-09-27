import { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { Tooltip } from '@deepseek-ai/dsh-client-ui-primitives'
import type { ModelSelectionProjection } from '@deepseek-ai/dsh-api-session-controller/types'
import { beijingTime, isOfficialDeepSeek, nextPeriodChange, periodAt, PRICING_URL, RULE_CHECKED } from './deepseek-period.ts'
import css from './peak-indicator.css'

export interface PeakIndicatorProps {
  selection: { subscribe(callback: () => void): () => void; getSnapshot(): unknown }
}

/** Read the same next-request selection as the native model picker. No RPCs. */
export function PeakIndicator({ selection }: PeakIndicatorProps) {
  const model = useSyncExternalStore(callback => selection.subscribe(callback), () => selection.getSnapshot()) as ModelSelectionProjection | undefined
  return isOfficialDeepSeek(model?.next) ? <PeriodClock/> : null
}

function PeriodClock() {
  const ref = useRef<HTMLSpanElement>(null)
  const [now, setNow] = useState(Date.now)
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
    return () => {
      clearTimeout(timer)
      doc?.removeEventListener('visibilitychange', update)
      win?.removeEventListener('focus', update)
    }
  }, [])
  const period = periodAt(now)
  const label = period === 'peak' ? '高峰期' : period === 'offpeak' ? '低谷期' : '时段待核对'
  const next = nextPeriodChange(now)
  const description = period === 'unknown'
    ? '本地节假日日历尚未覆盖当前年份，请查看 DeepSeek 官方规则。'
    : `当前为${label}${period === 'offpeak' ? '，官方价格为高峰期的一半' : ''}。${next === null ? '' : `北京时间 ${beijingTime(next)} 转为${period === 'peak' ? '低谷期' : '高峰期'}。`}`
  const tip = `${description} 北京时间周一至周五 09:00–12:00、14:00–18:00 为高峰；周末和中国法定节假日全天为低谷。按官方规则显示时段，具体计费以服务方为准。规则核验：${RULE_CHECKED}。点击查看官方说明。`
  return <span ref={ref} className="dsh-context-settings cmi-peak" data-period={period}>
    <style data-plugin="dsh-context-manager" data-plugin-css="dsh-context-manager/peak">{css}</style>
    <Tooltip label={tip} side="top" delayMs={200} maxWidth={330}>
      <a href={PRICING_URL} target="_blank" rel="noopener noreferrer" aria-label={`DeepSeek 官方计费：${label}`}>
        <svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true"><circle cx="8" cy="8" r="5.5"/><path d="M8 4.5V8l2.5 1.5"/></svg>
        <span>{label}</span>
      </a>
    </Tooltip>
  </span>
}
