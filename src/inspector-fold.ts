import { canonicalHeader, deriveEventMessage, foldSurface, isSurfaceEvent, type SessionEvent, type SessionMessageProjection } from '@deepseek-ai/dsh-session'
import { isCompactCheckpointSource } from '@deepseek-ai/dsh-compaction/checkpoint'
import type { Message } from '@deepseek-ai/dsh-llm'
import { estimateMessage, estimateToolsTokens } from '@deepseek-ai/dsh-token-meter/estimate'
import { diagnosticsProjection } from './diagnostics.ts'
import { categories, type Category, type ContentRow, type RequestRow } from './inspector-types.ts'

/** Bounds analysis work; never silently analyse a suffix as the full context. */
export const MAX_EVENTS = 50000
export interface IndexedContent { row: ContentRow; body: () => string; sourceSeqs?: readonly number[] }
const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 0
function sourceName(message: Message): string {
  const source = message.source as { kind: string; name?: unknown; path?: unknown }
  const name = typeof source.name === 'string' ? source.name : typeof source.path === 'string' ? source.path : ''
  return `${source.kind}${name ? ` · ${name}` : ''}`.slice(0, 200)
}
function textOf(message: Message): string {
  return message.content.map(block => {
    if (block.type === 'text' || block.type === 'reasoning') return `${block.type === 'reasoning' ? '[推理内容]\n' : ''}${block.text}`
    if (block.type === 'tool-call') return `[工具调用 · ${block.name}]\n${block.arguments}`
    return `[${block.type === 'image' ? '图片引用；图像实际计价由模型路由决定' : block.type}]\n${JSON.stringify(block, null, 2)}`
  }).join('\n\n')
}

/** Canonical positional replay, including replacements whose seq endpoints are reversed. */
export function indexContext(events: readonly SessionEvent[], projections: readonly SessionMessageProjection[] = []) {
  if (events.length > MAX_EVENTS) throw new Error(`当前日志超过 ${MAX_EVENTS.toLocaleString()} 条记录的分析上限；未返回不完整的上下文。`)
  const surface = foldSurface(events, projections)
  const active = new Set<number>(surface.nodes)
  const lastSystem = [...surface.nodes].reverse().find(seq => {
    const event = events[seq]!
    return event.type === 'system/message' && deriveEventMessage(event, surface.projectedMessages) !== null
  })
  const calls = new Map<string, string>()
  let header: ReturnType<typeof canonicalHeader> | undefined
  let headerSeq = -1
  let diagnostics = diagnosticsProjection.init()
  const requests: RequestRow[] = []
  let requestCount = 0
  for (const event of events) {
    diagnostics = diagnosticsProjection.apply(diagnostics, event)
    if (event.type === 'request/header') { header = canonicalHeader(event.data.header); headerSeq = event.seq }
    if (event.type !== 'assistant/message') continue
    for (const block of event.data.message.content) if (block.type === 'tool-call') calls.set(block.id, block.name)
    if (event.surfaceOp !== 'append') continue
    const usage = event.data.usage
    const input = usage && finite(usage.inputTokens) ? usage.inputTokens + (usage.cacheReadTokens ?? 0) + (usage.cacheWriteTokens ?? 0) : null
    requests.push({ seq: event.seq, time: event.time, turn: event.data.turn, step: event.data.step,
      provider: event.data.message.source.provider, model: event.data.message.source.model, input,
      output: usage && finite(usage.outputTokens) ? usage.outputTokens : null,
      cacheRead: usage && finite(usage.cacheReadTokens) ? usage.cacheReadTokens : null })
    requestCount++
    if (requests.length > 200) requests.shift()
  }
  const indexed: IndexedContent[] = []
  for (const event of events) {
    if (!isSurfaceEvent(event)) continue
    const current = active.has(event.seq)
    const message = deriveEventMessage(event, current ? surface.projectedMessages : undefined)
    if (message === null) continue
    const source = message.source as { kind: string }
    const toolName = message.role === 'tool' ? calls.get(message.toolCallId) : undefined
    const category: Category = isCompactCheckpointSource(message.source) ? 'summary' : message.role === 'system' && event.seq === lastSystem ? 'system'
      : message.role === 'assistant' ? 'assistant'
      : source.kind === 'skill-invocation' || source.kind === 'skill-catalog' || (message.role === 'tool' && toolName === 'skill') ? 'skill'
      : message.role === 'tool' ? 'tool'
      : source.kind === 'user' ? 'user' : 'inject'
    const firstText = message.content.find(block => block.type === 'text')
    const title = category === 'summary' ? `压缩摘要 · 记录 ${event.seq}` : message.role === 'tool' ? `${toolName ?? '未记录工具名称'} · 工具结果`
      : message.role === 'system' ? event.seq === lastSystem ? '当前系统指令' : '先前系统片段'
      : firstText?.type === 'text' && firstText.text.trim() ? firstText.text.trim().replace(/\s+/gu, ' ').slice(0, 110)
      : `${categories.find(item => item.id === category)!.label} · 记录 ${event.seq}`
    // Summary source events identify exact earlier events, never an inferred numerical range.
    // Compaction metadata is log-only, so only its explicitly correlated inputs
    // (and direct surface references) become readable source links.
    const sourceSeqs = new Set<number>()
    if (isCompactCheckpointSource(message.source)) {
      for (const seq of event.sourceEventSeqs ?? []) {
        if (seq < 0 || seq >= event.seq) continue
        const origin = events[seq]
        if (!origin) continue
        if (isSurfaceEvent(origin)) sourceSeqs.add(seq)
        if (origin.type === 'compaction/summary' && origin.data.compactionId === message.source.compactionId) {
          for (const sourceSeq of origin.data.shadowedSeqs) {
            if (sourceSeq >= 0 && sourceSeq < origin.seq && events[sourceSeq] && isSurfaceEvent(events[sourceSeq]!)) sourceSeqs.add(sourceSeq)
          }
        }
      }
    }
    indexed.push({ row: { id: `event:${event.seq}`, seq: event.seq, title: title.slice(0, 160),
      source: `${sourceName(message)}${!current ? ' · 已替换，查看记录原文' : ''}`.slice(0, 200),
      category, tokens: estimateMessage(message), current, images: message.content.filter(block => block.type === 'image').length }, body: () => textOf(message),
      ...(category === 'summary' ? { sourceSeqs: [...sourceSeqs] } : {}) })
  }
  let toolItemTokens = 0
  for (const [index, tool] of (header?.tools ?? []).entries()) {
    const tokens = Math.floor(JSON.stringify(tool).length / 4)
    toolItemTokens += tokens
    indexed.push({ row: { id: `tool:${headerSeq}:${index}`, seq: headerSeq, title: tool.name.slice(0, 160),
      source: '请求工具定义 · 注册插件来源未记录', category: 'tools', tokens, current: true, images: 0 }, body: () => JSON.stringify(tool, null, 2) })
  }
  const overhead = estimateToolsTokens(header) - toolItemTokens
  if (overhead > 0) indexed.push({ row: { id: `tool-frame:${headerSeq}`, seq: headerSeq, title: '工具定义结构与取整',
    source: 'DSH 统一估算器', category: 'tools', tokens: overhead, current: true, images: 0 },
    body: () => '工具定义列表的括号、分隔符、结构开销及统一取整。此项使工具定义合计与宿主 estimateToolsTokens 保持一致。' })
  const parts = categories.map(({ id }) => {
    const rows = indexed.filter(item => item.row.current && item.row.category === id)
    return { category: id, tokens: rows.reduce((total, item) => total + item.row.tokens, 0), count: rows.length }
  })
  return { indexed, parts, header, diagnostics: diagnostics.view, requests, requestCount }
}
