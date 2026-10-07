/** Structure is validated; semantic fidelity still requires evidence and task-level evaluation. */
import { z } from 'zod'
const text = z.string().trim().min(1).max(64000)
const items = z.array(text).max(100)
const schema = z.object({ goal: text, constraints: items, completed: items, pending: items, evidence: items, next: text, uncertainties: items }).strict()
export type CheckpointValue = z.infer<typeof schema>
export const CHECKPOINT_FORMAT = `Return exactly one JSON object with these keys:
{"goal":"current goal","constraints":["latest corrections and authorization boundaries"],"completed":["confirmed completed work"],"pending":["unfinished work"],"evidence":["exact paths, commands, errors and evidence references"],"next":"next action or no action remaining","uncertainties":["unverified or obsolete claims"]}.
Use the user's language in the values. Arrays may be empty only when no relevant facts exist.
Do not invent facts to fill fields. Keep facts distinct from assumptions. No markdown fences or surrounding explanation.`

/**
 * Lossless wrapper whitelist applied before parsing. Each accepted transform
 * preserves JSON semantics: a leading BOM, CR/LF line endings outside string
 * literals, surrounding whitespace, and exactly one whole-text code fence
 * tagged `json` (or untagged). No heuristic scans for a first `{` / last `}`,
 * and a body that fails after unwrapping is never re-scanned as prose.
 */
export function unwrapCheckpoint(raw: string): { body: string; via: 'plain' | 'fence' } {
  const normalized = raw.replace(/^\uFEFF/u, '').replace(/\r\n?/g, '\n').trim()
  const fenced = /^```[ \t]*(?:json)?[ \t]*\n([\s\S]*?)\n```$/iu.exec(normalized)
  if (fenced) return { body: fenced[1]!, via: 'fence' }
  return { body: normalized, via: 'plain' }
}

const FIELDS = ['goal', 'constraints', 'completed', 'pending', 'evidence', 'next', 'uncertainties'] as const
type Field = typeof FIELDS[number]
const ARRAY_FIELDS: readonly Field[] = ['constraints', 'completed', 'pending', 'evidence', 'uncertainties']
const TEXT_LIMIT = 64000

/**
 * Reject duplicate top-level keys: JSON.parse silently keeps the last value,
 * which would hide the fact that an earlier copy existed.
 */
function hasDuplicateTopKeys(body: string): boolean {
  const seen = new Set<string>()
  let depth = 0
  for (let i = 0; i < body.length; i++) {
    if (body[i] !== '"') {
      if (body[i] === '{' || body[i] === '[') depth++
      else if (body[i] === '}' || body[i] === ']') depth--
      continue
    }
    let j = i + 1
    let value = ''
    let closed = false
    while (j < body.length) {
      const char = body[j]!
      if (char === '\\') { value += char + (body[j + 1] ?? ''); j += 2; continue }
      if (char === '"') { closed = true; j++; break }
      value += char; j++
    }
    let k = j
    while (k < body.length && (body[k] === ' ' || body[k] === '\t' || body[k] === '\n' || body[k] === '\r')) k++
    if (closed && depth === 1 && body[k] === ':') {
      // JSON keys may use escapes: "goal" and "\\u0067oal" are the
      // same key. Compare decoded names before JSON.parse can discard one.
      let key: string
      try { key = JSON.parse('"' + value + '"') as string }
      catch { return false } // The strict JSON parser reports malformed syntax.
      if (seen.has(key)) return true
      seen.add(key)
    }
    i = j - 1
  }
  return false
}

export interface CheckpointClassification {
  /** True only when a deterministic, value-preserving repair is available. */
  repairable: boolean
  reason: string
}

/**
 * Classify a failed checkpoint without inventing facts. The only repairable
 * form is an array field holding exactly one non-empty string (the model
 * forgot the brackets): wrapping it into a one-element array preserves the
 * fact byte-for-byte. Missing fields, unknown keys, duplicate keys, damaged
 * or truncated JSON, prose, nulls, numbers, objects, nested structures, mixed
 * arrays, empty strings, string-field type breaks and over-limit values are
 * rejected outright: their facts cannot be proven complete, so no prompt may
 * reconstruct them.
 */
export function classifyCheckpoint(raw: string): CheckpointClassification {
  const { body } = unwrapCheckpoint(raw)
  if (hasDuplicateTopKeys(body)) return { repairable: false, reason: '含重复字段，无法确定唯一事实' }
  let parsed: unknown
  try { parsed = JSON.parse(body) } catch {
    return { repairable: false, reason: '损坏或截断：无损归一化后仍无法解析为 JSON' }
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return { repairable: false, reason: '顶层不是 JSON 对象' }
  }
  const record = parsed as Record<string, unknown>
  const missing = FIELDS.filter(field => !(field in record))
  if (missing.length) return { repairable: false, reason: `缺少字段：${missing.join('、')}` }
  const extra = Object.keys(record).filter(key => !FIELDS.includes(key as Field))
  if (extra.length) return { repairable: false, reason: `含未知字段：${extra.join('、')}` }
  const broken: Field[] = []
  for (const field of FIELDS) {
    const value = record[field]
    if (ARRAY_FIELDS.includes(field)) {
      if (Array.isArray(value)) {
        if (value.length > 100) return { repairable: false, reason: `字段条目超过上限：${field}` }
        if (value.some(item => typeof item !== 'string' || item.trim().length === 0 || item.length > TEXT_LIMIT)) return { repairable: false, reason: `字段条目类型或长度无效：${field}` }
        continue
      }
      if (typeof value === 'string' && value.trim().length > 0 && value.length <= TEXT_LIMIT) { broken.push(field); continue }
      return { repairable: false, reason: `字段类型或长度无法无损恢复：${field}` }
    }
    if (typeof value !== 'string' || value.trim().length === 0 || value.length > TEXT_LIMIT) {
      return { repairable: false, reason: `字段类型或长度无法无损恢复：${field}` }
    }
  }
  if (broken.length === 0) return { repairable: true, reason: '', }
  return { repairable: true, reason: `字段缺少数组包装：${broken.join('、')}` }
}

/** A strict-schema failure carrying its repair eligibility classification. */
export class CheckpointFormatError extends Error {
  constructor(readonly classification: CheckpointClassification, message: string) { super(message) }
}

/** Strict seven-field parse after the lossless wrapper whitelist. */
export function parseCheckpoint(raw: string): CheckpointValue {
  const { body } = unwrapCheckpoint(raw)
  if (hasDuplicateTopKeys(body)) {
    const reason = '含重复字段，无法确定唯一事实'
    throw new CheckpointFormatError({ repairable: false, reason }, `摘要结构无效（${reason}），摘要未应用，原始记录保留`)
  }
  let parsed: unknown
  try { parsed = JSON.parse(body) } catch {
    const reason = '损坏或截断：无损归一化后仍无法解析为 JSON'
    throw new CheckpointFormatError({ repairable: false, reason }, `摘要结构无效（${reason}），摘要未应用，原始记录保留`)
  }
  const result = schema.safeParse(parsed)
  if (!result.success) {
    const classified = classifyCheckpoint(raw)
    throw new CheckpointFormatError(classified, classified.repairable
      ? `摘要字段类型不符合要求（${classified.reason}），摘要未应用，原始记录保留`
      : `摘要结构无效（${classified.reason}），摘要未应用，原始记录保留`)
  }
  return result.data
}

/**
 * The deterministic repair a repairable checkpoint admits: every array field
 * holding a single string becomes a one-element array of that exact string;
 * everything else stays byte-identical. Returns null when the input is not
 * repairable, so callers never ask a model to invent the transformation.
 */
export function expectedRepair(raw: string): CheckpointValue | null {
  const classification = classifyCheckpoint(raw)
  if (!classification.repairable) return null
  const { body } = unwrapCheckpoint(raw)
  const original = JSON.parse(body) as Record<string, unknown>
  const repaired: Record<string, unknown> = { ...original }
  for (const field of ARRAY_FIELDS) {
    if (typeof repaired[field] === 'string') repaired[field] = [repaired[field]]
  }
  const result = schema.safeParse(repaired)
  return result.success ? result.data : null
}

/**
 * Verify a repaired checkpoint against the deterministic expectation: every
 * field must equal the expected repair value exactly. A repaired value that
 * adds, drops, splits, reorders or rephrases anything fails this comparison.
 * @param raw - the original failed output.
 * @param repaired - the strictly parsed repair result.
 * @returns the fields that differ, or an empty array when the repair is exact.
 */
export function repairDeviations(raw: string, repaired: CheckpointValue): Field[] {
  const expected = expectedRepair(raw)
  if (!expected) return FIELDS.slice()
  return FIELDS.filter(field => JSON.stringify(repaired[field]) !== JSON.stringify(expected[field]))
}

export function formatCheckpoint(raw: string, source: { sessionId: string; compactionId: string }): string {
  const value = parseCheckpoint(raw)
  const zh = /[\u4e00-\u9fff]/u.test(value.goal + value.next)
  const labels = zh ? ['当前目标', '约束与纠正', '已完成', '待完成', '证据与引用', '下一步', '尚未核实']
    : ['Current goal', 'Constraints and corrections', 'Completed', 'Pending', 'Evidence', 'Next action', 'Uncertainties']
  const values = [value.goal, value.constraints, value.completed, value.pending, value.evidence, value.next, value.uncertainties]
  const sections = values.map((v, i) => `## ${labels[i]}\n${typeof v === 'string' ? v : v.length ? v.map(line => `- ${line}`).join('\n') : zh ? '无已记录事项。' : 'None recorded.'}`)
  const sourceRecoveryHint = zh ? '原文保留在会话日志；需要细节时使用已有会话查询工具按引用找回。' : 'Original events remain in the session log; use the existing session query tools to recover details as needed.'
  const recovery = zh ? '继续时以当前系统指令和最新用户原文为准；按需核验计划、后台任务与文件状态，不把历史完成声明当作当前证据。' : 'Continue under the current system instructions and latest original user request. Recheck plans, background tasks and file state as needed; historical completion claims are not current evidence.'
  return `${sections.join('\n\n')}\n\n${recovery}\n${sourceRecoveryHint}\nCheckpoint schema: context-manager/1\nSession: ${source.sessionId}\nCompaction: ${source.compactionId}`
}
