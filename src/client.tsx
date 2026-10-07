import { useState, useEffect, useSyncExternalStore } from 'react'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import { en, zh, type InspectorLocaleKey } from './inspector-locales.ts'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {} from '@deepseek-ai/dsh-client-ui-model-selection/client'
import type {} from '@deepseek-ai/dsh-api-remotes/client'
import type { RemoteResult } from '@deepseek-ai/dsh-typert-protocol'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { ConfigForm } from '@deepseek-ai/dsh-client-ui-settings/client'
import { Button, Input, SettingsForm, SettingsValueField, Switch } from '@deepseek-ai/dsh-client-ui-primitives'
import type {} from '@deepseek-ai/dsh-api-session-controller/client'
import { ContextInspectorView, type ContextViewInjected } from './inspector-view.tsx'
import { PeakIndicator, type PeakIndicatorProps } from './peak-indicator.tsx'
import type { ContentPage, ContentQuery, Inspection, InspectQuery, InspectorApi } from './inspector-types.ts'
import { TYPERT_REMOTE } from './inspector-wire.ts'
import { defaults, budget, validatePolicy, type Policy } from './policy.ts'
import type { IdleStatus } from './idle-types.ts'
import css from './client.css'
export { ContextReadout } from './overview.tsx'
export { ContextInspectorView } from './inspector-view.tsx'
export { PeakIndicator } from './peak-indicator.tsx'

declare module '@deepseek-ai/dsh-typert-protocol' {
  interface TypertRemoteNamespaceMap {
    contextInspector: {
      idleStatus(query: { sessionId: string }, signal: AbortSignal): Promise<RemoteResult<IdleStatus>>
      inspect(query: InspectQuery, signal: AbortSignal): Promise<RemoteResult<Inspection>>
      content(query: ContentQuery, signal: AbortSignal): Promise<RemoteResult<ContentPage>>
    }
  }
}

declare module '@deepseek-ai/dsh-client-ui-slots' { interface LocaleNamespaceMap { 'context.manager': InspectorLocaleKey } }

type Values = { policy: Policy }
export const inject = ['locale', 'slots', 'configForms', 'sessions', 'remote', 'remote.session', 'modelDirectories']

// Page styles are mounted after the module factory. Explicit ownership keeps
// another plugin's later materialization from claiming and removing them.
const STYLE_OWNER = 'dsh-context-manager'

/** Native conversation tab plus a separate parameter-only settings section. */
export async function apply(ctx: Context) {
  ctx.effect(() => ctx.locale.register('context.manager', { zh, en }), 'context-manager: locale')
  const t = ctx.locale.bind('context.manager')
  const form = ctx.configForms.get<Values>('context-manager')
  ctx.slots.inject('conversation.input.right', () => ctx.slots.register({
    name: 'conversation.input.right', id: 'context-manager-period', order: 100,
    inject: (sessionId: SessionId): PeakIndicatorProps => ({
      directory: ctx.modelDirectories.directoryFor(sessionId).store,
    }),
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
      idleStatus: async (query, signal) => unwrap(await scope.remote.contextInspector.idleStatus(query, signal)),
      inspect: async (query, signal) => unwrap(await scope.remote.contextInspector.inspect(query, signal)),
      content: async (query, signal) => unwrap(await scope.remote.contextInspector.content(query, signal)),
    }
    scope.slots.inject('conversation.view', () => scope.slots.register({
      name: 'conversation.view', id: 'context-manager', order: 20, label: () => t('title'), locale: 'context.manager',
      inject: (sessionId: SessionId): ContextViewInjected => {
        const session = scope.sessions.binding(sessionId)?.session
        if (!session) throw new Error('上下文管理：当前会话尚未就绪。')
        return { target: sessionId, form, api, locale: scope.locale.getLocale().active, pulse: session.projections.faceOf('contextPressure') }
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

const numericKeys = ['triggerPercent', 'targetPercent', 'earlyPercent', 'safetyPercent', 'summaryMaxTokens', 'maxPasses', 'timeoutMs', 'idleMinutes', 'idleMinPercent', 'formatRepairMaxTokens', 'absoluteTriggerTokens', 'absoluteTargetTokens'] as const
type NumericKey = typeof numericKeys[number]
type Draft = Omit<Policy, NumericKey> & Record<NumericKey, string>
function toDraft(policy: Policy): Draft {
  const fields = Object.fromEntries(numericKeys.map(key => [key, String(policy[key])])) as Record<NumericKey, string>
  return { ...policy, ...fields }
}
function toPolicy(draft: Draft): Policy {
  const fields = Object.fromEntries(numericKeys.map(key => [key, draft[key].trim() ? Number(draft[key]) : NaN])) as Record<NumericKey, number>
  return { ...draft, ...fields }
}

/** Native DSH value fields share the host's typography, borders and save footer. */
export function ContextSettings({ form }: { form: ConfigForm<Values> }) {
  const accepted = useSyncExternalStore(callback => form.subscribe(callback), () => form.getSnapshot())
  const [draft, setDraft] = useState(() => toDraft(accepted.value?.policy ?? defaults))
  const [revision, setRevision] = useState(accepted.revision)
  const [dirty, setDirty] = useState(false)
  const [saving, setSaving] = useState(false)
  const [feedback, setFeedback] = useState('')
  const [failed, setFailed] = useState(false)
  const [exampleWindow, setExampleWindow] = useState(128000)
  useEffect(() => {
    if (!dirty && accepted.value) { setDraft(toDraft(accepted.value.policy)); setRevision(accepted.revision) }
  }, [accepted, dirty])
  function edit(update: Partial<Draft>) { setDraft(p => ({ ...p, ...update })); setDirty(true); setFeedback(''); setFailed(false) }
  const policy = toPolicy(draft)
  let invalid = ''
  try { validatePolicy(policy) } catch (error) { invalid = error instanceof Error ? error.message : String(error) }
  const preview = invalid || !Number.isSafeInteger(exampleWindow) || exampleWindow <= 0 ? undefined : budget(policy, exampleWindow, Math.ceil(exampleWindow * 0.08))
  const disabled = !accepted.writable || saving || accepted.status !== 'ready'
  async function save() {
    if (disabled || !dirty || invalid) return
    setSaving(true); setFeedback(''); setFailed(false)
    try {
      const ok = await form.mutate([{ op: 'set', path: ['policy'], value: { ...policy } }], revision)
      if (ok) { setDirty(false); setFeedback('已保存。请求前检查与闲置整理按新设置生效。') }
      else { setFailed(true); setFeedback('未保存：配置可能已在别处更改。请重新载入后再编辑。') }
    } catch (error) { setFailed(true); setFeedback(`保存失败：${error instanceof Error ? error.message : String(error)}`) }
    finally { setSaving(false) }
  }
  function reload() {
    setDirty(false); setFeedback(''); setFailed(false)
    setDraft(toDraft(accepted.value?.policy ?? defaults)); setRevision(accepted.revision)
  }
  const numeric = (key: NumericKey, label: string, hint: string, blocked = false) => <SettingsValueField
    key={key} id={`context-manager-${key}`} label={label} hint={hint} numeric
    text={draft[key]} disabled={disabled || blocked} invalid={!Number.isFinite(policy[key])}
    overridden={draft[key] !== String(defaults[key])} overriddenLabel="自定义" resetLabel="恢复推荐值" invalidLabel="请输入有效数字"
    onEdit={text => edit({ [key]: text })} onReset={() => edit({ [key]: String(defaults[key]) })}/>
  const toggle = (key: 'enabled' | 'idleEnabled' | 'formatRepairEnabled' | 'absoluteEnabled', label: string, hint: string, blocked = false) => <div className="cm-native-toggle">
    <div className="cm-row"><span>{label}</span><Switch label={label} checked={draft[key]} disabled={disabled || blocked} onChange={value => edit({ [key]: value })}/></div>
    <p className="cm-hint">{hint}</p>
  </div>
  const admissionLabel = preview ? preview.admissionSource === 'absolute' ? '绝对软预算' : preview.admissionSource === 'hard' ? '硬上限' : '百分比' : ''
  const targetLabel = preview ? preview.targetSource === 'absolute' ? '绝对软目标' : '百分比目标' : ''
  return <section aria-label="上下文压缩设置" className="dsh-context-settings">
    <style data-plugin={STYLE_OWNER} data-plugin-css={`${STYLE_OWNER}/settings`}>{css}</style>
    <SettingsForm labels={{ unavailable: '正在读取上下文设置…', readOnly: '当前连接不支持保存设置。', saveFailed: feedback, save: '保存设置', saving: '保存中…' }}
      state={{ available: accepted.status === 'ready', writable: accepted.writable, dirty: dirty && !disabled, invalid: !!invalid, saving, failed }}
      onSave={() => { void save() }} onDiscard={() => { /* Unmount releases this form's draft. */ }}>
      <fieldset disabled={disabled} className="cm-native-fields">
        {toggle('enabled', '自动压缩', '在执行前检查完整请求，必要时先压缩。关闭后停止自动整理，超出安全窗口时暂停。')}
        <div className="cm-native-presets" role="group" aria-label="压缩策略">
          {([[70, 40, '提前整理 · 70%'], [80, 55, '均衡 · 80%'], [85, 60, '保留更多 · 85%']] as const).map(([triggerPercent, targetPercent, label]) =>
            <Button key={triggerPercent} size="sm" variant="outline" aria-pressed={policy.triggerPercent === triggerPercent && policy.targetPercent === targetPercent}
              onClick={() => edit({ triggerPercent: String(triggerPercent), targetPercent: String(targetPercent) })}>{label}</Button>)}
        </div>
        {numeric('triggerPercent', '上下文用到多少时压缩（%）', '按当前模型窗口计算。新消息会计入检查，输出预留和安全空间可能使实际阈值更低。')}
        {numeric('targetPercent', '压缩后目标占用（%）', '这是软目标。必要指令、任务信息和完整工具调用优先保留，实际结果可能不同。')}
        {toggle('absoluteEnabled', '绝对工作历史软预算', '按会话当前实际占用 Token 设置独立的软触发与软目标，与百分比、输出预留和窗口硬约束取更保守值。不修改模型窗口声明；关闭后沿用原百分比策略。', !draft.enabled)}
        {numeric('absoluteTriggerTokens', '绝对软触发（Token）', '以会话当前实际占用 Token 为单位，达到后即先压缩，即使百分比门槛尚未满足。', !draft.enabled || !draft.absoluteEnabled)}
        {numeric('absoluteTargetTokens', '绝对软目标（Token）', '压缩后的软目标占用；须比绝对软触发至少低 20%。与百分比目标取更保守值。', !draft.enabled || !draft.absoluteEnabled)}
        {toggle('idleEnabled', '闲置自动压缩', '任务正常结束后计时。新消息到达时取消整理；摘要会使用当前模型并消耗 Token。', !draft.enabled)}
        {numeric('idleMinutes', '任务结束后闲置时长（分钟）', '推荐 15 分钟，可设 1–1440 分钟。只处理本次运行中使用过的会话，应用退出后不执行。', !draft.enabled || !draft.idleEnabled)}
        <details className="cm-native-advanced"><summary>高级设置</summary>
          {numeric('idleMinPercent', '闲置压缩最低占用（%）', `实际至少高于压缩目标 10 个百分点；当前为 ${Math.max(policy.idleMinPercent, policy.targetPercent + 10) || '—'}%。短对话不会触发。`)}
          <SettingsValueField id="context-manager-summaryInstructions" label="摘要保留重点" hint="可补充需要保留的内容，例如报错、修改文件、待办事项。最多 2000 字符，基础保护始终保留。"
            text={draft.summaryInstructions} disabled={disabled} invalid={draft.summaryInstructions.length > 2000}
            overridden={!!draft.summaryInstructions} overriddenLabel="自定义" resetLabel="清空" invalidLabel="最多 2000 字符"
            onEdit={summaryInstructions => edit({ summaryInstructions })} onReset={() => edit({ summaryInstructions: '' })}/>
          {numeric('earlyPercent', '提前检查空间（%）', '推荐 1%。为新任务与估算误差提前留出空间。')}
          {numeric('safetyPercent', '窗口安全空间（%）', '推荐 2%，在模型输出预留之外保留。')}
          {numeric('summaryMaxTokens', '摘要输出上限（Token）', '摘要沿用当前会话实际使用的模型和推理级别。')}
          {numeric('maxPasses', '每个请求最多压缩次数', '可设 1 或 2。闲置整理只尝试一次，没有新增任务不会重复整理。')}
          {toggle('formatRepairEnabled', '摘要格式修复', '摘要结构校验失败时，仅把失败输出与结构要求重发一次（不重发历史）。关闭后格式失败直接保留原文并终止。', !draft.enabled)}
          {numeric('formatRepairMaxTokens', '格式修复输出上限（Token）', '修复请求的输出上限；其输入只包含有界失败输出与结构要求。', !draft.enabled || !draft.formatRepairEnabled)}
          {numeric('timeoutMs', '单次摘要超时（毫秒）', '超时后停止；不会自动循环重试。')}
          <div className="cm-native-example"><label htmlFor="context-manager-example">触发示例窗口（Token）</label><Input id="context-manager-example" type="number" min="1000" step="1000" value={exampleWindow} onChange={e => setExampleWindow(Number(e.target.value))}/>
            <p className="cm-hint">{preview ? `约 ${preview.admission.toLocaleString()} Token 开始检查（${admissionLabel}），目标约 ${preview.target.toLocaleString()} Token（${targetLabel}）。` : '填写有效参数后查看示例。'} 示例假设输出预留 8%，执行按实际模型计算。</p>
          </div>
        </details>
        {invalid && <p role="alert" className="cm-error">{invalid}</p>}
        <div className="cm-actions"><Button size="sm" onClick={reload}>重新载入</Button><Button size="sm" onClick={() => edit(toDraft(defaults))}>恢复全部推荐值</Button></div>
      </fieldset>
    </SettingsForm>
    {feedback && !failed && <p role="status" className="cm-hint cm-feedback">{feedback}</p>}
  </section>
}
