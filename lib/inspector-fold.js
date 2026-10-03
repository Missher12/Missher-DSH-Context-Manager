// src/inspector-fold.ts
import { canonicalHeader as canonicalHeader2, deriveEventMessage, foldSurface, isSurfaceEvent } from "@deepseek-ai/dsh-session";
import { isCompactCheckpointSource } from "@deepseek-ai/dsh-compaction/checkpoint";
import { estimateMessage as estimateMessage2, estimateToolsTokens } from "@deepseek-ai/dsh-token-meter/estimate";

// src/diagnostics.ts
import { z } from "zod";
import { canonicalHeader } from "@deepseek-ai/dsh-session";
import { estimateMessage } from "@deepseek-ai/dsh-token-meter/estimate";

// src/diagnostics-types.ts
var HISTORY_LIMIT = 12;

// src/diagnostics.ts
var count = z.number().finite().nonnegative();
var entrySchema = z.object({
  id: z.string(),
  kind: z.enum(["compact", "prune"]),
  startedAt: count,
  endedAt: count.optional(),
  status: z.enum(["running", "completed", "failed", "interrupted", "unapplied"]),
  manual: z.boolean(),
  applied: z.boolean(),
  beforeTokens: count.optional(),
  afterTokens: count.optional(),
  messages: count.optional(),
  error: z.string().max(300).optional(),
  inputTokens: count.optional(),
  outputTokens: count.optional()
});
var viewSchema = z.object({
  request: z.object({ provider: z.string(), model: z.string(), effort: z.string().optional(), maxTokens: count.optional(), time: count }).nullable(),
  tools: z.object({ count, top: z.array(z.object({ name: z.string().max(120), tokens: count })).max(8) }),
  requests: z.array(z.object({ seq: count, time: count, provider: z.string(), model: z.string(), turn: count, step: count, input: count, output: count })).max(HISTORY_LIMIT),
  compactions: z.array(entrySchema).max(HISTORY_LIMIT)
});
var stateSchema = z.object({ view: viewSchema, pending: z.object({ id: z.string(), seq: count, start: count, end: count }).nullable() });
function update(state, id, patch) {
  const entries = state.view.compactions;
  if (!entries.some((entry) => entry.id === id)) return state;
  return { ...state, view: { ...state.view, compactions: entries.map((entry) => entry.id === id ? { ...entry, ...patch } : entry) } };
}
function append(state, entry) {
  return { ...state, view: { ...state.view, compactions: [...state.view.compactions, entry].slice(-HISTORY_LIMIT) } };
}
function foldDiagnostics(previous, event) {
  let state = previous;
  if (state.pending) {
    const pending = state.pending;
    state = { ...state, pending: null };
    if (event.seq === pending.seq + 1 && event.type === "user/message" && event.surfaceOp !== "append" && event.surfaceOp.startSeq === pending.start && event.surfaceOp.endSeq === pending.end) {
      state = update(state, pending.id, { applied: true, afterTokens: estimateMessage(event.data) });
      if (state.view.compactions.find((entry) => entry.id === pending.id)?.kind === "prune") {
        state = update(state, pending.id, { status: "completed", endedAt: event.time });
      }
    } else if (state.view.compactions.find((entry) => entry.id === pending.id)?.kind === "prune") {
      state = update(state, pending.id, { status: "unapplied", endedAt: event.time });
    }
  }
  switch (event.type) {
    case "request/header": {
      const header = canonicalHeader(event.data.header);
      const { provider, model, reasoningEffort, maxTokens } = header.config;
      const cap = maxTokens;
      return { ...state, view: {
        ...state.view,
        request: {
          provider,
          model,
          time: event.time,
          ...reasoningEffort === void 0 ? {} : { effort: String(reasoningEffort) },
          ...typeof cap === "number" && Number.isFinite(cap) && cap >= 0 ? { maxTokens: cap } : {}
        },
        tools: { count: header.tools?.length ?? 0, top: (header.tools ?? []).map((tool) => ({
          name: tool.name.slice(0, 120),
          tokens: Math.ceil(JSON.stringify(tool).length / 4)
        })).sort((a, b) => b.tokens - a.tokens).slice(0, 8) }
      } };
    }
    case "assistant/message": {
      const { usage, turn, step } = event.data;
      const route = state.view.request;
      if (!usage || !route || event.surfaceOp !== "append") return state;
      return { ...state, view: { ...state.view, requests: [...state.view.requests, {
        seq: event.seq,
        time: event.time,
        provider: route.provider,
        model: route.model,
        turn,
        step,
        input: usage.inputTokens + (usage.cacheReadTokens ?? 0) + (usage.cacheWriteTokens ?? 0),
        output: usage.outputTokens
      }].slice(-HISTORY_LIMIT) } };
    }
    case "compaction/start":
      return append(state, {
        id: event.data.compactionId,
        kind: "compact",
        startedAt: event.time,
        status: "running",
        manual: event.data.turn === null,
        applied: false
      });
    case "compaction/summary": {
      const { compactionId, shadowedRange, shadowedTokenCount, shadowedSeqs } = event.data;
      state = update(state, compactionId, { beforeTokens: shadowedTokenCount, messages: shadowedSeqs.length });
      const usage = event.data.usage;
      if (usage) state = update(state, compactionId, { inputTokens: usage.inputTokens + (usage.cacheReadTokens ?? 0) + (usage.cacheWriteTokens ?? 0), outputTokens: usage.outputTokens });
      return { ...state, pending: { id: compactionId, seq: event.seq, start: shadowedRange.start, end: shadowedRange.end } };
    }
    case "compaction/prune": {
      const { shadowedRange, shadowedTokenCount, shadowedSeqs } = event.data;
      const id = `prune:${event.seq}`;
      state = append(state, {
        id,
        kind: "prune",
        startedAt: event.time,
        status: "running",
        manual: false,
        applied: false,
        beforeTokens: shadowedTokenCount,
        messages: shadowedSeqs.length
      });
      return { ...state, pending: { id, seq: event.seq, start: shadowedRange.start, end: shadowedRange.end } };
    }
    case "compaction/end": {
      const entry = state.view.compactions.find((item) => item.id === event.data.compactionId);
      return update(state, event.data.compactionId, {
        endedAt: event.time,
        status: event.data.error ? "failed" : entry?.applied ? "completed" : "unapplied",
        ...event.data.error ? { error: event.data.error.slice(0, 300) } : {}
      });
    }
    case "session/end-seed":
      return state.view.compactions.some((entry) => entry.status === "running") ? {
        ...state,
        view: { ...state.view, compactions: state.view.compactions.map((entry) => entry.status === "running" ? { ...entry, status: "interrupted" } : entry) }
      } : state;
    default:
      return state;
  }
}
var diagnosticsProjection = {
  key: "contextManagerDiagnostics",
  stateSchema,
  init: () => ({ view: { request: null, tools: { count: 0, top: [] }, requests: [], compactions: [] }, pending: null }),
  apply: foldDiagnostics,
  wire: { viewSchema, view: (state) => state.view },
  stateVersion: 2
};

// src/inspector-types.ts
var categories = [
  { id: "summary", label: "\u538B\u7F29\u6458\u8981" },
  { id: "system", label: "\u7CFB\u7EDF\u6307\u4EE4" },
  { id: "tools", label: "\u5DE5\u5177\u5B9A\u4E49" },
  { id: "user", label: "\u7528\u6237\u6D88\u606F" },
  { id: "inject", label: "\u6CE8\u5165\u5185\u5BB9" },
  { id: "skill", label: "\u6280\u80FD\u5185\u5BB9" },
  { id: "assistant", label: "\u52A9\u624B\u56DE\u590D" },
  { id: "tool", label: "\u5DE5\u5177\u7ED3\u679C" }
];

// src/inspector-fold.ts
var MAX_EVENTS = 5e4;
var finite = (value) => typeof value === "number" && Number.isFinite(value) && value >= 0;
function sourceName(message) {
  const source = message.source;
  const name = typeof source.name === "string" ? source.name : typeof source.path === "string" ? source.path : "";
  return `${source.kind}${name ? ` \xB7 ${name}` : ""}`.slice(0, 200);
}
function textOf(message) {
  return message.content.map((block) => {
    if (block.type === "text" || block.type === "reasoning") return `${block.type === "reasoning" ? "[\u63A8\u7406\u5185\u5BB9]\n" : ""}${block.text}`;
    if (block.type === "tool-call") return `[\u5DE5\u5177\u8C03\u7528 \xB7 ${block.name}]
${block.arguments}`;
    return `[${block.type === "image" ? "\u56FE\u7247\u5F15\u7528\uFF1B\u56FE\u50CF\u5B9E\u9645\u8BA1\u4EF7\u7531\u6A21\u578B\u8DEF\u7531\u51B3\u5B9A" : block.type}]
${JSON.stringify(block, null, 2)}`;
  }).join("\n\n");
}
function indexContext(events, projections = []) {
  if (events.length > MAX_EVENTS) throw new Error(`\u5F53\u524D\u65E5\u5FD7\u8D85\u8FC7 ${MAX_EVENTS.toLocaleString()} \u6761\u8BB0\u5F55\u7684\u5206\u6790\u4E0A\u9650\uFF1B\u672A\u8FD4\u56DE\u4E0D\u5B8C\u6574\u7684\u4E0A\u4E0B\u6587\u3002`);
  const surface = foldSurface(events, projections);
  const active = new Set(surface.nodes);
  const lastSystem = [...surface.nodes].reverse().find((seq) => {
    const event = events[seq];
    return event.type === "system/message" && deriveEventMessage(event, surface.projectedMessages) !== null;
  });
  const calls = /* @__PURE__ */ new Map();
  let header;
  let headerSeq = -1;
  let diagnostics = diagnosticsProjection.init();
  const requests = [];
  let requestCount = 0;
  for (const event of events) {
    diagnostics = diagnosticsProjection.apply(diagnostics, event);
    if (event.type === "request/header") {
      header = canonicalHeader2(event.data.header);
      headerSeq = event.seq;
    }
    if (event.type !== "assistant/message") continue;
    for (const block of event.data.message.content) if (block.type === "tool-call") calls.set(block.id, block.name);
    if (event.surfaceOp !== "append") continue;
    const usage = event.data.usage;
    const input = usage && finite(usage.inputTokens) ? usage.inputTokens + (usage.cacheReadTokens ?? 0) + (usage.cacheWriteTokens ?? 0) : null;
    requests.push({
      seq: event.seq,
      time: event.time,
      turn: event.data.turn,
      step: event.data.step,
      provider: event.data.message.source.provider,
      model: event.data.message.source.model,
      input,
      output: usage && finite(usage.outputTokens) ? usage.outputTokens : null,
      cacheRead: usage && finite(usage.cacheReadTokens) ? usage.cacheReadTokens : null
    });
    requestCount++;
    if (requests.length > 200) requests.shift();
  }
  const indexed = [];
  for (const event of events) {
    if (!isSurfaceEvent(event)) continue;
    const current = active.has(event.seq);
    const message = deriveEventMessage(event, current ? surface.projectedMessages : void 0);
    if (message === null) continue;
    const source = message.source;
    const toolName = message.role === "tool" ? calls.get(message.toolCallId) : void 0;
    const category = isCompactCheckpointSource(message.source) ? "summary" : message.role === "system" && event.seq === lastSystem ? "system" : message.role === "assistant" ? "assistant" : source.kind === "skill-invocation" || source.kind === "skill-catalog" || message.role === "tool" && toolName === "skill" ? "skill" : message.role === "tool" ? "tool" : source.kind === "user" ? "user" : "inject";
    const firstText = message.content.find((block) => block.type === "text");
    const title = category === "summary" ? `\u538B\u7F29\u6458\u8981 \xB7 \u8BB0\u5F55 ${event.seq}` : message.role === "tool" ? `${toolName ?? "\u672A\u8BB0\u5F55\u5DE5\u5177\u540D\u79F0"} \xB7 \u5DE5\u5177\u7ED3\u679C` : message.role === "system" ? event.seq === lastSystem ? "\u5F53\u524D\u7CFB\u7EDF\u6307\u4EE4" : "\u5148\u524D\u7CFB\u7EDF\u7247\u6BB5" : firstText?.type === "text" && firstText.text.trim() ? firstText.text.trim().replace(/\s+/gu, " ").slice(0, 110) : `${categories.find((item) => item.id === category).label} \xB7 \u8BB0\u5F55 ${event.seq}`;
    const sourceSeqs = /* @__PURE__ */ new Set();
    if (isCompactCheckpointSource(message.source)) {
      for (const seq of event.sourceEventSeqs ?? []) {
        if (seq < 0 || seq >= event.seq) continue;
        const origin = events[seq];
        if (!origin) continue;
        if (isSurfaceEvent(origin)) sourceSeqs.add(seq);
        if (origin.type === "compaction/summary" && origin.data.compactionId === message.source.compactionId) {
          for (const sourceSeq of origin.data.shadowedSeqs) {
            if (sourceSeq >= 0 && sourceSeq < origin.seq && events[sourceSeq] && isSurfaceEvent(events[sourceSeq])) sourceSeqs.add(sourceSeq);
          }
        }
      }
    }
    indexed.push({
      row: {
        id: `event:${event.seq}`,
        seq: event.seq,
        title: title.slice(0, 160),
        source: `${sourceName(message)}${!current ? " \xB7 \u5DF2\u66FF\u6362\uFF0C\u67E5\u770B\u8BB0\u5F55\u539F\u6587" : ""}`.slice(0, 200),
        category,
        tokens: estimateMessage2(message),
        current,
        images: message.content.filter((block) => block.type === "image").length
      },
      body: () => textOf(message),
      ...category === "summary" ? { sourceSeqs: [...sourceSeqs] } : {}
    });
  }
  let toolItemTokens = 0;
  for (const [index, tool] of (header?.tools ?? []).entries()) {
    const tokens = Math.floor(JSON.stringify(tool).length / 4);
    toolItemTokens += tokens;
    indexed.push({ row: {
      id: `tool:${headerSeq}:${index}`,
      seq: headerSeq,
      title: tool.name.slice(0, 160),
      source: "\u8BF7\u6C42\u5DE5\u5177\u5B9A\u4E49 \xB7 \u6CE8\u518C\u63D2\u4EF6\u6765\u6E90\u672A\u8BB0\u5F55",
      category: "tools",
      tokens,
      current: true,
      images: 0
    }, body: () => JSON.stringify(tool, null, 2) });
  }
  const overhead = estimateToolsTokens(header) - toolItemTokens;
  if (overhead > 0) indexed.push({
    row: {
      id: `tool-frame:${headerSeq}`,
      seq: headerSeq,
      title: "\u5DE5\u5177\u5B9A\u4E49\u7ED3\u6784\u4E0E\u53D6\u6574",
      source: "DSH \u7EDF\u4E00\u4F30\u7B97\u5668",
      category: "tools",
      tokens: overhead,
      current: true,
      images: 0
    },
    body: () => "\u5DE5\u5177\u5B9A\u4E49\u5217\u8868\u7684\u62EC\u53F7\u3001\u5206\u9694\u7B26\u3001\u7ED3\u6784\u5F00\u9500\u53CA\u7EDF\u4E00\u53D6\u6574\u3002\u6B64\u9879\u4F7F\u5DE5\u5177\u5B9A\u4E49\u5408\u8BA1\u4E0E\u5BBF\u4E3B estimateToolsTokens \u4FDD\u6301\u4E00\u81F4\u3002"
  });
  const parts = categories.map(({ id }) => {
    const rows = indexed.filter((item) => item.row.current && item.row.category === id);
    return { category: id, tokens: rows.reduce((total, item) => total + item.row.tokens, 0), count: rows.length };
  });
  return { indexed, parts, header, diagnostics: diagnostics.view, requests, requestCount };
}
export {
  MAX_EVENTS,
  indexContext
};
