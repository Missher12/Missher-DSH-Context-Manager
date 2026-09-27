import { useState, useEffect, useSyncExternalStore } from 'react'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {} from '@deepseek-ai/dsh-api-remotes/client'
import type { RemoteResult } from '@deepseek-ai/dsh-typert-protocol'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { ConfigForm } from '@deepseek-ai/dsh-client-ui-settings/client'
import { Button, Input, SettingsForm, Switch } from '@deepseek-ai/dsh-client-ui-primitives'
import type {} from '@deepseek-ai/dsh-api-session-controller/client'
import { ContextInspectorView, type ContextViewInjected } from './inspector-view.tsx'
import { PeakIndicator, type PeakIndicatorProps } from './peak-indicator.tsx'
import type { ContentPage, ContentQuery, Inspection, InspectQuery, InspectorApi } from './inspector-types.ts'
import { TYPERT_REMOTE } from './inspector-wire.ts'
import { defaults, budget, validatePolicy, type Policy } from './policy.ts'
import css from './client.css'
export { ContextReadout } from './overview.tsx'
export { ContextInspectorView } from './inspector-view.tsx'
export { PeakIndicator } from './peak-indicator.tsx'

declare module '@deepseek-ai/dsh-typert-protocol' {
  interface TypertRemoteNamespaceMap {
    contextInspector: {
      inspect(query: InspectQuery, signal: AbortSignal): Promise<RemoteResult<Inspection>>
      content(query: ContentQuery, signal: AbortSignal): Promise<RemoteResult<ContentPage>>
    }
  }
}

type Values = { policy: Policy }
export const inject = ['slots', 'configForms', 'sessions', 'remote']

// Page styles are mounted after the module factory. Explicit ownership keeps
// another plugin's later materialization from claiming and removing them.
const STYLE_OWNER = 'dsh-context-manager'

/** Native conversation tab plus a separate parameter-only settings section. */
export async function apply(ctx: Context) {
  const form = ctx.configForms.get<Values>('context-manager')
  ctx.slots.inject('conversation.composer.dock', () => ctx.slots.register({
    name: 'conversation.composer.dock', id: 'context-manager-period', order: 100,
    inject: (sessionId: SessionId): PeakIndicatorProps => {
      const session = ctx.sessions.binding(sessionId)?.session
      if (!session) throw new Error('上下文管理：当前会话尚未就绪。')
      return { selection: session.projections.faceOf('modelSelection') }
    },
  }, PeakIndicator))
  ctx.effect(() => ctx.configForms.whileServed(['context-manager'], () => ctx.slots.inject('settings.section', () => ctx.slots.register({
    name: 'settings.section', id: 'context-manager', order: 65, label: '上下文管理', inject: () => ({ form }),
  }, ContextPage))))
  const unmount = await ctx.remote.$mount(TYPERT_REMOTE)
  ctx.effect(() => unmount, 'context-manager: remote')
  ctx.inject(['remote.contextInspector'], scope => {
    const unwrap = <T,>(result: RemoteResult<T>): T => {
      if (!result.ok) throw new Error(`上下文读取失败：${result.error.code}`)
      return result.value
    }
    const api: InspectorApi = {
      inspect: async (query, signal) => unwrap(await scope.remote.contextInspector.inspect(query, signal)),
      content: async (query, signal) => unwrap(await scope.remote.contextInspector.content(query, signal)),
    }
    scope.slots.inject('conversation.view', () => scope.slots.register({
      name: 'conversation.view', id: 'context-manager', order: 20, label: '上下文',
      inject: (sessionId: SessionId): ContextViewInjected => {
        const session = scope.sessions.binding(sessionId)?.session
        if (!session) throw new Error('上下文管理：当前会话尚未就绪。')
        return { target: sessionId, form, api, pulse: session.projections.faceOf('contextPressure') }
      },
    }, ContextInspectorView))
  })
}

export function ContextPage({ form }: { form: ConfigForm<Values> }) {
  return <section aria-label="上下文管理" className="dsh-context-settings">
    <style data-plugin={STYLE_OWNER} data-plugin-css={`${STYLE_OWNER}/settings`}>{css}</style><h2 className="cm-title">上下文管理</h2>
    <p className="cm-intro">设置何时先压缩、再继续执行。会话数据位于“对话 / 轨迹”后的“上下文”页签。</p>
    <ContextSettings form={form} />
  </section>
}

export function ContextSettings({ form }: { form: ConfigForm<Values> }) {
  const accepted = useSyncExternalStore(callback => form.subscribe(callback), () => form.getSnapshot())
  const [draft, setDraft] = useState<Policy>(accepted.value?.policy ?? defaults)
  const [revision, setRevision] = useState(accepted.revision)
  const [dirty, setDirty] = useState(false)
  const [saving, setSaving] = useState(false)
  const [feedback, setFeedback] = useState('')
  const [failed, setFailed] = useState(false)
  const [exampleWindow, setExampleWindow] = useState(128000)
  useEffect(() => {
    if (!dirty && accepted.value) { setDraft(accepted.value.policy); setRevision(accepted.revision) }
  }, [accepted, dirty])
  function edit(update: Partial<Policy>) { setDraft(p => ({ ...p, ...update })); setDirty(true); setFeedback(''); setFailed(false) }
  let invalid = ''
  try { validatePolicy(draft) } catch (error) { invalid = error instanceof Error ? error.message : String(error) }
  const preview = invalid || exampleWindow <= 0 ? undefined : budget(draft, exampleWindow, Math.ceil(exampleWindow * 0.08))
  const disabled = !accepted.writable || saving || accepted.status !== 'ready'
  async function save() {
    if (disabled || !dirty || invalid) return
    setSaving(true); setFeedback(''); setFailed(false)
    try {
      const ok = await form.mutate([{ op: 'set', path: ['policy'], value: { ...draft } }], revision)
      if (ok) { setDirty(false); setFeedback('已保存，下一个请求按新设置检查。') }
      else { setFailed(true); setFeedback('未保存：配置可能已在别处更改。请重新载入后再编辑。') }
    } catch (error) { setFailed(true); setFeedback(`保存失败：${error instanceof Error ? error.message : String(error)}`) }
    finally { setSaving(false) }
  }
  function reload() {
    setDirty(false); setFeedback(''); setFailed(false)
    setDraft(accepted.value?.policy ?? defaults); setRevision(accepted.revision)
  }
  const range = (key: 'triggerPercent' | 'targetPercent', label: string, min: number, max: number, hint: string) => (
    <div className="cm-field">
      <div className="cm-row">
        <label className="cm-label" htmlFor={`context-manager-${key}`}>{label}</label>
        <span className="cm-number"><Input id={`context-manager-${key}`} aria-label={label} aria-describedby={`context-manager-${key}-hint`} type="number" min={min} max={max} step="0.1" value={draft[key]} onChange={e => edit({ [key]: Number(e.target.value) })} /><span>%</span></span>
      </div>
      <input className="cm-range" aria-label={`${label}滑块`} aria-describedby={`context-manager-${key}-hint`} type="range" min={min} max={max} step="0.1" value={draft[key]} onChange={e => edit({ [key]: Number(e.target.value) })} />
      <p id={`context-manager-${key}-hint`} className="cm-hint">{hint}</p>
    </div>
  )
  return <section aria-label="上下文管理" className="dsh-context-settings">
    <style data-plugin={STYLE_OWNER} data-plugin-css={`${STYLE_OWNER}/settings`}>{css}</style>
    <SettingsForm labels={{ unavailable: '正在读取上下文设置…', readOnly: '当前连接不支持保存设置。', saveFailed: feedback, save: '保存设置', saving: '保存中…' }}
      state={{ available: accepted.status === 'ready', writable: accepted.writable, dirty: dirty && !disabled, invalid: !!invalid, saving, failed }}
      onSave={() => { void save() }} onDiscard={() => { /* Drafts belong to this mounted page and expire with it. */ }}>
    <fieldset disabled={disabled}>
      <div className="cm-field">
        <div className="cm-row"><span className="cm-label">自动压缩</span><Switch label="自动压缩" checked={draft.enabled} disabled={disabled} onChange={enabled => edit({ enabled })} /></div>
        <p className="cm-hint">关闭后仍保留窗口保护；上下文放不下时会暂停。</p>
      </div>
      <div className="cm-field">
        <span className="cm-label">压缩策略</span>
        <div className="cm-presets" role="group" aria-label="压缩策略">
          {([
            [70, 40, '提前整理 · 70%'], [80, 55, '均衡 · 80%'], [85, 60, '保留更多 · 85%'],
          ] as const).map(([triggerPercent, targetPercent, label]) => <Button key={triggerPercent} size="sm" variant="outline" aria-pressed={draft.triggerPercent === triggerPercent && draft.targetPercent === targetPercent} onClick={() => edit({ triggerPercent, targetPercent })}>{label}</Button>)}
        </div>
      </div>
      {range('triggerPercent', '上下文用到多少时压缩', 50, 95, '按当前模型窗口计算；输出预留和安全空间可能使实际阈值更低。')}
      {range('targetPercent', '压缩后希望保留多少', 10, 75, '这是目标值。最新任务、必要指令和完整工具调用必须保留，实际占用可能更高。')}
      <div className="cm-preview">
        <div className="cm-row cm-example-row"><span className="cm-label">触发示例</span><label className="cm-example-window">示例窗口<Input aria-label="示例窗口 Token 数" type="number" min="1000" step="1000" value={exampleWindow} onChange={e => setExampleWindow(Number(e.target.value))} /><span>Token</span></label></div>
        {draft.enabled ? preview && <p className="cm-example-result">约 {preview.admission.toLocaleString()} Token 开始检查 → 尽量压到 {preview.target.toLocaleString()} Token。<br />{draft.triggerPercent === 80 && draft.earlyPercent >= 0.1 ? '79.9% 时提交任务，会先压缩再执行。' : `本例提前 ${draft.earlyPercent}% 检查。`}</p> : <p className="cm-example-result">自动压缩已关闭，超出安全窗口时暂停。</p>}
        <p className="cm-hint">仅演示比例，假设输出预留 8%。执行时按实际模型与完整请求计算。</p>
      </div>
      <details className="cm-advanced"><summary>高级设置</summary>
        {([
          ['earlyPercent', '提前检查空间（%）', 0, 5], ['safetyPercent', '窗口安全空间（%）', 1, 10],
          ['summaryMaxTokens', '摘要输出上限（Token）', 256, 32768], ['maxPasses', '每个请求最多压缩次数', 1, 2], ['timeoutMs', '单次摘要超时（毫秒）', 1000, 300000],
        ] as const).map(([key, label, min, max]) => <label key={key} className="cm-row cm-advanced-row">{label}<Input className="cm-advanced-input" type="number" min={min} max={max} step={key.endsWith('Percent') ? 0.1 : 1} value={draft[key]} onChange={e => edit({ [key]: Number(e.target.value) })} /></label>)}
        <p className="cm-hint">摘要沿用当前模型和推理级别。取消立即停止；摘要失败、无进展或仍超限时暂停，已提交任务保留在记录中。设置适用于已接管的 Agent 预设。</p>
      </details>
      {invalid && <p role="alert" className="cm-error">{invalid}</p>}
      <div className="cm-actions">
        <Button size="sm" onClick={reload}>重新载入</Button>
        <Button size="sm" onClick={() => edit(defaults)}>恢复推荐值</Button>
      </div>
    </fieldset>
    </SettingsForm>
    {feedback && !failed && <p role="status" className="cm-hint cm-feedback">{feedback}</p>}
  </section>
}
