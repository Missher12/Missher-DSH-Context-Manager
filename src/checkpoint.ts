/** Structure is validated; semantic fidelity still requires evidence and task-level evaluation. */
import { z } from 'zod'
const text = z.string().min(1).max(64000).refine(value => value.trim().length > 0)
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
  const lineNormalized = raw.replace(/^\uFEFF/u, '').replace(/\r\n?/g, '\n')
  const leftTrimmed = lineNormalized.trimStart()
  // In v3, trailing spaces on encoded value lines are data. The protocol
  // marker makes it safe to retain them while JSON still trims wrappers.
  if (leftTrimmed.startsWith('Checkpoint sections: context-manager/3\n')) return { body: leftTrimmed, via: 'plain' }
  const normalized = lineNormalized.trim()
  const fenced = /^```[ \t]*(?:json)?[ \t]*\n([\s\S]*?)\n```$/iu.exec(normalized)
  if (fenced) return { body: fenced[1]!, via: 'fence' }
  return { body: normalized, via: 'plain' }
}

/**
 * Versioned low-format-burden protocol: seven fixed Markdown sections, one
 * fact per `- ` line for list fields. Chosen explicitly through policy; JSON
 * checkpoints remain first-class and a switch never invalidates old history.
 */
export const CHECKPOINT_FORMAT_SECTIONS = `Return exactly seven Markdown sections in this order, using the exact headings below and no other headings or surrounding text:
## 当前目标
(one paragraph)
## 约束与纠正
- (one fact per line; use "无" when there is none)
## 已完成
- (one confirmed fact with its evidence per line)
## 待完成
- (one unfinished item per line)
## 证据与引用
- (exact paths, commands, errors and evidence references)
## 下一步
(one paragraph; say 无 when nothing remains)
## 尚未核实
- (unverified or obsolete claims; use "无" when there is none)
Do not use JSON braces, code fences or explanations. Preserve the user's language. Never claim pending work was completed.`

const V2_SECTIONS = [
  ['goal', '当前目标', 'Current goal'],
  ['constraints', '约束与纠正', 'Constraints and corrections'],
  ['completed', '已完成', 'Completed'],
  ['pending', '待完成', 'Pending'],
  ['evidence', '证据与引用', 'Evidence'],
  ['next', '下一步', 'Next action'],
  ['uncertainties', '尚未核实', 'Uncertainties'],
] as const

const sectionFailure = (reason: string): CheckpointFormatError =>
  new CheckpointFormatError({ repairable: false, reason }, `摘要结构无效（${reason}），摘要未应用，原始记录保留`)

/** True when the checkpoint body uses the versioned section protocol. */
export function isSectionCheckpoint(raw: string): boolean {
  const body = unwrapCheckpoint(raw).body
  return body.startsWith('## ') || body.startsWith('Checkpoint sections: context-manager/3\n')
}

/**
 * Strict parser for the versioned section protocol. Every heading must be
 * present exactly once in order; array sections accept only top-level `- `
 * facts and an explicit "无"; text sections are non-empty paragraphs. No
 * heuristic scan and no Markdown-to-JSON escape hatch: damaged or truncated
 * output stays rejected.
 */
export function parseCheckpointSections(raw: string): CheckpointValue {
  const body = unwrapCheckpoint(raw).body
  const marker = 'Checkpoint sections: context-manager/3'
  const encodedV3 = body.startsWith(`${marker}\n`)
  const lines = (encodedV3 ? body.slice(marker.length + 1) : body).split('\n')
  const collected = new Map<string, string[]>()
  const programTrailer = new Set([
    '继续时以当前系统指令和最新用户原文为准；按需核验计划、后台任务与文件状态，不把历史完成声明当作当前证据。',
    'Continue under the current system instructions and latest original user request. Recheck plans, background tasks and file state as needed; historical completion claims are not current evidence.',
    '原文保留在会话日志；需要细节时使用已有会话查询工具按引用找回。',
    'Original events remain in the session log; use the existing session query tools to recover details as needed.',
  ])
  let current: string | undefined
  let seen = 0
  let afterSchema = false
  const metadata = new Set<string>()
  for (const line of lines) {
    const trimmed = line.trim()
    if (afterSchema) {
      if (trimmed.length === 0) continue
      const key = /^(Session|Compaction): .+$/u.exec(trimmed)?.[1]
      if (key && !metadata.has(key)) { metadata.add(key); continue }
      throw sectionFailure(`schema 标记后含未识别或重复尾项：${trimmed.slice(0, 80)}`)
    }
    if (/^Checkpoint schema: context-manager\/[123]$/.test(trimmed)) {
      if (seen !== V2_SECTIONS.length || afterSchema) throw sectionFailure('schema 标记位置无效')
      afterSchema = true
      continue
    }
    if (programTrailer.has(trimmed)) {
      if (seen !== V2_SECTIONS.length) throw sectionFailure('固定恢复说明出现在段落结束之前')
      continue
    }
    if (trimmed.length === 0) { if (current !== undefined) collected.get(current)!.push(''); continue }
    if (trimmed.startsWith('```')) throw sectionFailure('段落协议不允许代码围栏')
    const heading = /^##\s+(.+?)\s*$/.exec(trimmed)
    if (heading) {
      const index = V2_SECTIONS.findIndex(([, zh, en]) => zh === heading[1] || en === heading[1])
      if (index < 0) throw sectionFailure(`含未知段落：${heading[1]}`)
      if (index !== seen) throw sectionFailure(`段落顺序或重复无效：${heading[1]}`)
      current = V2_SECTIONS[index][0]
      collected.set(current, [])
      seen++
      continue
    }
    if (current === undefined) throw sectionFailure('段落正文出现在首个标题之前')
    collected.get(current)!.push(line)
  }
  if (seen !== V2_SECTIONS.length) {
    const missing = V2_SECTIONS.filter(([key]) => !collected.has(key)).map(([, zh]) => zh)
    throw sectionFailure(`缺少段落：${missing.join('、') || '完整标题序列'}`)
  }
  if (afterSchema && (metadata.size !== 2 || !metadata.has('Session') || !metadata.has('Compaction'))) {
    throw sectionFailure('schema 标记后的 Session/Compaction 元数据不完整')
  }
  const record: Record<string, unknown> = {}
  const trimSectionEdges = (lines: string[]) => {
    let start = 0, end = lines.length
    while (start < end && lines[start] === '') start++
    while (end > start && lines[end - 1] === '') end--
    return lines.slice(start, end)
  }
  const decodeLine = (line: string): string => {
    let result = ''
    for (let index = 0; index < line.length; index++) {
      const char = line[index]!
      if (char !== '\\') { result += char; continue }
      const next = line[++index]
      if (next === '\\') result += '\\'
      else if (next === 'r') result += '\r'
      else throw sectionFailure('v3 行编码中的反斜线转义无效')
    }
    return result
  }
  for (const [key, zh] of V2_SECTIONS) {
    const rawContent = trimSectionEdges(collected.get(key)!)
    if (key === 'goal' || key === 'next') {
      const value = encodedV3
        ? rawContent.map(line => {
          if (!line.startsWith('>')) throw sectionFailure(`v3 文本段落每行必须以 “>” 编码：${zh}`)
          return decodeLine(line.slice(1))
        }).join('\n')
        : rawContent.join('\n')
      if (value.length === 0 || value.length > TEXT_LIMIT || value.trim().length === 0) throw sectionFailure(`段落内容为空或过长：${zh}`)
      record[key] = value
      continue
    }
    const items: string[] = []
    if (encodedV3) {
      const emptySentinels = ['- 无已记录事项。', '- None recorded.']
      if (rawContent.length === 1 && emptySentinels.includes(rawContent[0]!)) {
        record[key] = []
        continue
      }
      let itemLines: string[] | undefined
      const finishItem = () => {
        if (!itemLines) return
        const item = itemLines.map(decodeLine).join('\n')
        if (item.length === 0 || item.length > TEXT_LIMIT || item.trim().length === 0) throw sectionFailure(`列表条目为空或过长：${zh}`)
        items.push(item)
        itemLines = undefined
      }
      for (const line of rawContent) {
        if (line.startsWith('- >')) { finishItem(); itemLines = [line.slice(3)]; continue }
        if (line.startsWith('  >') && itemLines) { itemLines.push(line.slice(3)); continue }
        throw sectionFailure(`v3 列表段落必须使用 “- >” 与 “  >” 行编码：${zh}`)
      }
      finishItem()
    } else {
      const emptySentinels = ['无', '无已记录事项。', 'None recorded.', 'None recorded']
      if (rawContent.length === 1 && emptySentinels.includes(rawContent[0]!)) {
        record[key] = []
        continue
      }
      for (const line of rawContent) {
        if (line === '') continue
        if (!line.startsWith('- ')) throw sectionFailure(`列表段落必须每行以 “- ” 开头：${zh}`)
        const item = line.slice(2)
        if (item.length === 0 || item.length > TEXT_LIMIT || item.trim().length === 0) throw sectionFailure(`列表条目为空或过长：${zh}`)
        items.push(item)
      }
    }
    if (items.length > 100) throw sectionFailure(`列表条目超过上限：${zh}`)
    record[key] = items
  }
  const result = schema.safeParse(record)
  if (!result.success) throw sectionFailure('段落内容不符合结构要求')
  return result.data
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
  if (isSectionCheckpoint(raw)) {
    try { parseCheckpointSections(raw); return { repairable: false, reason: '版本化段落协议已完整；该协议不做模型重写修复' } }
    catch (error) {
      return { repairable: false, reason: error instanceof CheckpointFormatError ? error.classification.reason : '段落协议损坏' }
    }
  }
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
  if (isSectionCheckpoint(raw)) return parseCheckpointSections(raw)
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
  // The schema validates without transforming values, so wrapping an array
  // field preserves the original string byte-for-byte.
  return result.success ? repaired as CheckpointValue : null
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
  return formatCheckpointValue(parseCheckpoint(raw), source, 3)
}

/** Render an already-validated checkpoint value; used by deterministic local repair. */
export function formatCheckpointValue(value: CheckpointValue, source: { sessionId: string; compactionId: string }, schemaVersion: 3 = 3): string {
  const validated = schema.parse(value)
  const zh = /[\u4e00-\u9fff]/u.test(validated.goal + validated.next)
  const labels = zh ? ['当前目标', '约束与纠正', '已完成', '待完成', '证据与引用', '下一步', '尚未核实']
    : ['Current goal', 'Constraints and corrections', 'Completed', 'Pending', 'Evidence', 'Next action', 'Uncertainties']
  const values = [validated.goal, validated.constraints, validated.completed, validated.pending, validated.evidence, validated.next, validated.uncertainties]
  const encodeLine = (line: string) => line.replaceAll('\\', '\\\\').replaceAll('\r', '\\r')
  const encodeText = (value: string) => value.split('\n').map(line => `>${encodeLine(line)}`).join('\n')
  const encodeList = (value: string[]) => value.length === 0 ? (zh ? '- 无已记录事项。' : '- None recorded.')
    : value.map(item => item.split('\n').map((line, index) => `${index === 0 ? '- >' : '  >'}${encodeLine(line)}`).join('\n')).join('\n')
  const sections = values.map((v, i) => `## ${labels[i]}\n${typeof v === 'string' ? encodeText(v) : encodeList(v)}`)
  const sourceRecoveryHint = zh ? '原文保留在会话日志；需要细节时使用已有会话查询工具按引用找回。' : 'Original events remain in the session log; use the existing session query tools to recover details as needed.'
  const recovery = zh ? '继续时以当前系统指令和最新用户原文为准；按需核验计划、后台任务与文件状态，不把历史完成声明当作当前证据。' : 'Continue under the current system instructions and latest original user request. Recheck plans, background tasks and file state as needed; historical completion claims are not current evidence.'
  const rendered = `Checkpoint sections: context-manager/3\n${sections.join('\n\n')}\n\n${recovery}\n${sourceRecoveryHint}\nCheckpoint schema: context-manager/${schemaVersion}\nSession: ${source.sessionId}\nCompaction: ${source.compactionId}`
  const roundTrip = parseCheckpointSections(rendered)
  if (FIELDS.some(field => JSON.stringify(roundTrip[field]) !== JSON.stringify(validated[field]))) {
    throw new CheckpointFormatError({ repairable: false, reason: 'checkpoint 渲染后无法精确回读' }, '摘要结构无效（checkpoint 渲染后无法精确回读），摘要未应用，原始记录保留')
  }
  return rendered
}
