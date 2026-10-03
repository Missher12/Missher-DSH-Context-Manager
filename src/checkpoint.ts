/** Structure is validated; semantic fidelity still requires evidence and task-level evaluation. */
import { z } from 'zod'
const text = z.string().trim().min(1).max(64000)
const items = z.array(text).max(100)
const schema = z.object({ goal: text, constraints: items, completed: items, pending: items, evidence: items, next: text, uncertainties: items }).strict()
export const CHECKPOINT_FORMAT = `Return exactly one JSON object with these keys:
{"goal":"current goal","constraints":["latest corrections and authorization boundaries"],"completed":["confirmed completed work"],"pending":["unfinished work"],"evidence":["exact paths, commands, errors and evidence references"],"next":"next action or no action remaining","uncertainties":["unverified or obsolete claims"]}.
Use the user's language in the values. Arrays may be empty only when no relevant facts exist.
Do not invent facts to fill fields. Keep facts distinct from assumptions. No markdown fences or surrounding explanation.`

export function formatCheckpoint(raw: string, source: { sessionId: string; compactionId: string }): string {
  const body = raw.trim().replace(/^```(?:json)?\s*\n([\s\S]*?)\n```$/u, '$1')
  let parsed: unknown
  try { parsed = JSON.parse(body) } catch { throw new Error('摘要结构无效，摘要未应用，原始记录保留') }
  const result = schema.safeParse(parsed)
  if (!result.success) throw new Error('摘要缺少任务、约束或后续行动字段，摘要未应用，原始记录保留')
  const value = result.data
  const zh = /[\u4e00-\u9fff]/u.test(value.goal + value.next)
  const labels = zh ? ['当前目标', '约束与纠正', '已完成', '待完成', '证据与引用', '下一步', '尚未核实']
    : ['Current goal', 'Constraints and corrections', 'Completed', 'Pending', 'Evidence', 'Next action', 'Uncertainties']
  const values = [value.goal, value.constraints, value.completed, value.pending, value.evidence, value.next, value.uncertainties]
  const sections = values.map((v, i) => `## ${labels[i]}\n${typeof v === 'string' ? v : v.length ? v.map(line => `- ${line}`).join('\n') : zh ? '无已记录事项。' : 'None recorded.'}`)
  const sourceRecoveryHint = zh ? '原文保留在会话日志；需要细节时使用已有会话查询工具按引用找回。' : 'Original events remain in the session log; use the existing session query tools to recover details as needed.'
  const recovery = zh ? '继续时以当前系统指令和最新用户原文为准；按需核验计划、后台任务与文件状态，不把历史完成声明当作当前证据。' : 'Continue under the current system instructions and latest original user request. Recheck plans, background tasks and file state as needed; historical completion claims are not current evidence.'
  return `${sections.join('\n\n')}\n\n${recovery}\n${sourceRecoveryHint}\nCheckpoint schema: context-manager/1\nSession: ${source.sessionId}\nCompaction: ${source.compactionId}`
}
