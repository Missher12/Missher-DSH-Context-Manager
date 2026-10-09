var __create = Object.create;
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __knownSymbol = (name, symbol) => (symbol = Symbol[name]) ? symbol : Symbol.for("Symbol." + name);
var __typeError = (msg) => {
  throw TypeError(msg);
};
var __defNormalProp = (obj, key, value) => key in obj ? __defProp(obj, key, { enumerable: true, configurable: true, writable: true, value }) : obj[key] = value;
var __name = (target, value) => __defProp(target, "name", { value, configurable: true });
var __decoratorStart = (base) => [, , , __create(base?.[__knownSymbol("metadata")] ?? null)];
var __decoratorStrings = ["class", "method", "getter", "setter", "accessor", "field", "value", "get", "set"];
var __expectFn = (fn) => fn !== void 0 && typeof fn !== "function" ? __typeError("Function expected") : fn;
var __decoratorContext = (kind, name, done, metadata, fns) => ({ kind: __decoratorStrings[kind], name, metadata, addInitializer: (fn) => done._ ? __typeError("Already initialized") : fns.push(__expectFn(fn || null)) });
var __decoratorMetadata = (array, target) => __defNormalProp(target, __knownSymbol("metadata"), array[3]);
var __runInitializers = (array, flags, self, value) => {
  for (var i = 0, fns = array[flags >> 1], n = fns && fns.length; i < n; i++) flags & 1 ? fns[i].call(self) : value = fns[i].call(self, value);
  return value;
};
var __decorateElement = (array, flags, name, decorators, target, extra) => {
  var fn, it, done, ctx, access, k = flags & 7, s = !!(flags & 8), p = !!(flags & 16);
  var j = k > 3 ? array.length + 1 : k ? s ? 1 : 2 : 0, key = __decoratorStrings[k + 5];
  var initializers = k > 3 && (array[j - 1] = []), extraInitializers = array[j] || (array[j] = []);
  var desc = k && (!p && !s && (target = target.prototype), k < 5 && (k > 3 || !p) && __getOwnPropDesc(k < 4 ? target : { get [name]() {
    return __privateGet(this, extra);
  }, set [name](x) {
    return __privateSet(this, extra, x);
  } }, name));
  k ? p && k < 4 && __name(extra, (k > 2 ? "set " : k > 1 ? "get " : "") + name) : __name(target, name);
  for (var i = decorators.length - 1; i >= 0; i--) {
    ctx = __decoratorContext(k, name, done = {}, array[3], extraInitializers);
    if (k) {
      ctx.static = s, ctx.private = p, access = ctx.access = { has: p ? (x) => __privateIn(target, x) : (x) => name in x };
      if (k ^ 3) access.get = p ? (x) => (k ^ 1 ? __privateGet : __privateMethod)(x, target, k ^ 4 ? extra : desc.get) : (x) => x[name];
      if (k > 2) access.set = p ? (x, y) => __privateSet(x, target, y, k ^ 4 ? extra : desc.set) : (x, y) => x[name] = y;
    }
    it = (0, decorators[i])(k ? k < 4 ? p ? extra : desc[key] : k > 4 ? void 0 : { get: desc.get, set: desc.set } : target, ctx), done._ = 1;
    if (k ^ 4 || it === void 0) __expectFn(it) && (k > 4 ? initializers.unshift(it) : k ? p ? extra = it : desc[key] = it : target = it);
    else if (typeof it !== "object" || it === null) __typeError("Object expected");
    else __expectFn(fn = it.get) && (desc.get = fn), __expectFn(fn = it.set) && (desc.set = fn), __expectFn(fn = it.init) && initializers.unshift(fn);
  }
  return k || __decoratorMetadata(array, target), desc && __defProp(target, name, desc), p ? k ^ 4 ? extra : desc : target;
};
var __publicField = (obj, key, value) => __defNormalProp(obj, typeof key !== "symbol" ? key + "" : key, value);
var __accessCheck = (obj, member, msg) => member.has(obj) || __typeError("Cannot " + msg);
var __privateIn = (member, obj) => Object(obj) !== obj ? __typeError('Cannot use the "in" operator on this value') : member.has(obj);
var __privateGet = (obj, member, getter) => (__accessCheck(obj, member, "read from private field"), getter ? getter.call(obj) : member.get(obj));
var __privateSet = (obj, member, value, setter) => (__accessCheck(obj, member, "write to private field"), setter ? setter.call(obj, value) : member.set(obj, value), value);
var __privateMethod = (obj, member, method) => (__accessCheck(obj, member, "access private method"), method);

// src/inspector.ts
import { SessionId, SessionLogOffset as SessionLogOffset2 } from "@deepseek-ai/dsh-session";
import { isCompactCheckpointSource as isCompactCheckpointSource2 } from "@deepseek-ai/dsh-compaction/checkpoint";
import { Remote, TypertRemoteService } from "@deepseek-ai/dsh-typert-protocol";

// src/chart-data.ts
var contextGroups = [
  { id: "summary", categories: ["summary"] },
  { id: "tool", categories: ["tool"] },
  { id: "message", categories: ["user", "assistant"] },
  { id: "instruction", categories: ["system", "tools", "inject", "skill"] }
];

// src/pressure-history.ts
import { isSurfaceEvent, SessionLogOffset } from "@deepseek-ai/dsh-session";
function pressureHistory(registry, observation, cut, signal) {
  const ends = [];
  for (const event of observation.events) {
    if (event.seq > cut) break;
    if (isSurfaceEvent(event) && typeof event.surfaceOp === "object") ends.push({ seq: event.seq, kind: "replace" });
    else if (event.type === "assistant/message" && event.surfaceOp === "append") ends.push({ seq: event.seq, kind: "reply" });
  }
  if (cut >= 0 && ends.at(-1)?.seq !== cut) ends.push({ seq: cut, kind: "current" });
  let checkpoint = {};
  let start = 0;
  return ends.slice(-40).map(({ seq: seq2, kind }) => {
    signal.throwIfAborted();
    const result = registry.restore(checkpoint, observation.events.slice(start, seq2 + 1), SessionLogOffset(start), observation.header, observation.inheritedEventCount);
    checkpoint = result.checkpoint;
    start = seq2 + 1;
    const pressure = result.snapshot.values.contextPressure;
    const valid = (value) => typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
    return { seq: seq2, time: observation.events[seq2].time, kind, tokens: valid(pressure?.projectedTokens), window: valid(pressure?.contextWindow) };
  });
}

// src/inspector-fold.ts
import { canonicalHeader as canonicalHeader2, deriveEventMessage, foldSurface, isSurfaceEvent as isSurfaceEvent2 } from "@deepseek-ai/dsh-session";
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
  const lastSystem = [...surface.nodes].reverse().find((seq2) => {
    const event = events[seq2];
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
    if (!isSurfaceEvent2(event)) continue;
    const current = active.has(event.seq);
    const message = deriveEventMessage(event, current ? surface.projectedMessages : void 0);
    if (message === null) continue;
    const source = message.source;
    const toolName = message.role === "tool" ? calls.get(message.toolCallId) : void 0;
    const category2 = isCompactCheckpointSource(message.source) ? "summary" : message.role === "system" && event.seq === lastSystem ? "system" : message.role === "assistant" ? "assistant" : source.kind === "skill-invocation" || source.kind === "skill-catalog" || message.role === "tool" && toolName === "skill" ? "skill" : message.role === "tool" ? "tool" : source.kind === "user" ? "user" : "inject";
    const firstText = message.content.find((block) => block.type === "text");
    const title = category2 === "summary" ? `\u538B\u7F29\u6458\u8981 \xB7 \u8BB0\u5F55 ${event.seq}` : message.role === "tool" ? `${toolName ?? "\u672A\u8BB0\u5F55\u5DE5\u5177\u540D\u79F0"} \xB7 \u5DE5\u5177\u7ED3\u679C` : message.role === "system" ? event.seq === lastSystem ? "\u5F53\u524D\u7CFB\u7EDF\u6307\u4EE4" : "\u5148\u524D\u7CFB\u7EDF\u7247\u6BB5" : firstText?.type === "text" && firstText.text.trim() ? firstText.text.trim().replace(/\s+/gu, " ").slice(0, 110) : `${categories.find((item) => item.id === category2).label} \xB7 \u8BB0\u5F55 ${event.seq}`;
    const sourceSeqs = /* @__PURE__ */ new Set();
    if (isCompactCheckpointSource(message.source)) {
      for (const seq2 of event.sourceEventSeqs ?? []) {
        if (seq2 < 0 || seq2 >= event.seq) continue;
        const origin = events[seq2];
        if (!origin) continue;
        if (isSurfaceEvent2(origin)) sourceSeqs.add(seq2);
        if (origin.type === "compaction/summary" && origin.data.compactionId === message.source.compactionId) {
          for (const sourceSeq of origin.data.shadowedSeqs) {
            if (sourceSeq >= 0 && sourceSeq < origin.seq && events[sourceSeq] && isSurfaceEvent2(events[sourceSeq])) sourceSeqs.add(sourceSeq);
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
        category: category2,
        tokens: estimateMessage2(message),
        current,
        images: message.content.filter((block) => block.type === "image").length
      },
      body: () => textOf(message),
      ...category2 === "summary" ? { sourceSeqs: [...sourceSeqs] } : {}
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

// src/efficiency.ts
import { createHash } from "crypto";
import { canonicalHeader as canonicalHeader3 } from "@deepseek-ai/dsh-session";
import { lastAssistantStreamChunk } from "@deepseek-ai/dsh-llm/assistant-stream";
var FIELD_ORDER = ["uncachedInput", "cacheRead", "cacheWrite", "output"];
function emptyField() {
  return { sum: 0, reported: 0, missing: 0 };
}
function token(value) {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
}
function sampleOf(usage) {
  return {
    uncachedInput: token(usage?.inputTokens),
    cacheRead: token(usage?.cacheReadTokens),
    cacheWrite: token(usage?.cacheWriteTokens),
    output: token(usage?.outputTokens)
  };
}
function isEmptySample(sample) {
  return FIELD_ORDER.every((field) => sample[field] === null);
}
function sameSample(left, right) {
  return FIELD_ORDER.every((field) => left[field] === right[field]);
}
function usageOf(event) {
  const explicit = event.type === "assistant/message" ? event.data.usage : void 0;
  if (explicit !== void 0) return sampleOf(explicit);
  const last = lastAssistantStreamChunk(event.data.stream, "usage")?.usage;
  if (last === void 0) return void 0;
  return sampleOf(last);
}
function systemPromptText(event) {
  if (event.type !== "system/message") return void 0;
  return event.data.message.content.map((block) => block.type === "text" ? block.text : "").join("\n");
}
function digest(value) {
  return createHash("sha256").update(value).digest("hex").slice(0, 16);
}
function totalsOf(slots, retries) {
  const fields = { uncachedInput: emptyField(), cacheRead: emptyField(), cacheWrite: emptyField(), output: emptyField() };
  let withoutUsage = 0;
  for (const slot of slots) {
    if (isEmptySample(slot.sample)) {
      withoutUsage++;
      continue;
    }
    for (const field of FIELD_ORDER) {
      const value = slot.sample[field];
      const held = fields[field];
      fields[field] = value === null ? { ...held, missing: held.missing + 1 } : { sum: held.sum + value, reported: held.reported + 1, missing: held.missing };
    }
  }
  const settled = slots.length;
  let inclusiveSum = 0, inclusiveReported = 0, inclusiveMissing = 0;
  for (const slot of slots) {
    const parts = [slot.sample.uncachedInput, slot.sample.cacheRead, slot.sample.cacheWrite];
    if (parts.every((value) => value !== null)) {
      inclusiveSum += parts.reduce((total, value) => total + (value ?? 0), 0);
      inclusiveReported++;
    } else if (isEmptySample(slot.sample)) continue;
    else inclusiveMissing++;
  }
  const complete = withoutUsage === 0 && FIELD_ORDER.every((field) => fields[field].missing === 0);
  return {
    settledAttempts: settled,
    retries,
    withoutUsage,
    uncachedInput: fields.uncachedInput,
    cacheRead: fields.cacheRead,
    cacheWrite: fields.cacheWrite,
    output: fields.output,
    cacheInclusiveInput: { sum: inclusiveSum, reported: inclusiveReported, missing: inclusiveMissing },
    complete
  };
}
function attributeSession(events, options = {}) {
  const fingerprintEnabled = options.fingerprint !== false;
  const slots = [];
  const open = /* @__PURE__ */ new Map();
  const compactionTurns = /* @__PURE__ */ new Map();
  const openTurns = /* @__PURE__ */ new Map();
  const retryIndex = /* @__PURE__ */ new Map();
  const changes = [];
  let fingerprint;
  let lastSystem;
  let route;
  let retries = 0;
  let maintenanceSuspects = 0;
  for (const event of events) {
    if (event.type === "compaction/start") {
      compactionTurns.set(event.data.compactionId, event.data.turn);
      if (event.data.turn !== null) openTurns.set(event.data.turn, (openTurns.get(event.data.turn) ?? 0) + 1);
      continue;
    }
    if (event.type === "compaction/end") {
      const turn2 = compactionTurns.get(event.data.compactionId);
      compactionTurns.delete(event.data.compactionId);
      if (turn2 !== null && turn2 !== void 0) {
        const held2 = (openTurns.get(turn2) ?? 0) - 1;
        if (held2 > 0) openTurns.set(turn2, held2);
        else openTurns.delete(turn2);
      }
      continue;
    }
    if (event.type === "llm/retry-started") {
      retries++;
      const key2 = `${event.data.turn}:${event.data.step}`;
      retryIndex.set(key2, (retryIndex.get(key2) ?? 0) + 1);
      const previous = open.get(key2);
      if (previous !== void 0) open.delete(key2);
      continue;
    }
    if (event.type === "system/message" && event.surfaceOp === "append") {
      const text = systemPromptText(event);
      if (text !== void 0 && text.length > 0) lastSystem = text;
      continue;
    }
    if (event.type === "request/header") {
      const header = canonicalHeader3(event.data.header);
      const tools = header.tools ?? [];
      const config = header.config;
      route = { provider: config.provider, model: config.model };
      if (!fingerprintEnabled) {
        fingerprint = void 0;
        continue;
      }
      const described = {
        prefix: digest(JSON.stringify([
          config.provider,
          config.model,
          config.reasoningEffort ?? null,
          config.maxTokens ?? null,
          config.temperature ?? null,
          lastSystem ?? ""
        ])),
        toolSchema: digest(JSON.stringify(tools.map((tool) => [tool.name, tool.description, tool.parameters]))),
        toolOrder: digest(tools.map((tool) => tool.name).join("\0")),
        tools: tools.length,
        systemChars: lastSystem?.length ?? 0
      };
      const changed = [];
      if (fingerprint !== void 0) {
        if (fingerprint.prefix !== described.prefix) changed.push("prefix");
        if (fingerprint.toolSchema !== described.toolSchema) changed.push("toolSchema");
        if (fingerprint.toolOrder !== described.toolOrder) changed.push("toolOrder");
      }
      if (changed.length > 0) changes.push({
        seq: event.seq,
        time: event.time,
        changed,
        note: "\u8BF7\u6C42\u524D\u7F00\u7EC4\u6210\u90E8\u5206\u53D1\u751F\u53D8\u5316\uFF1B\u8FD9\u4E0E\u7F13\u5B58\u884C\u4E3A\u76F8\u5173\uFF0C\u4F46\u4E0D\u662F\u7F13\u5B58\u672A\u547D\u4E2D\u7684\u539F\u56E0\u8BC1\u660E"
      });
      fingerprint = described;
      continue;
    }
    if (event.type !== "assistant/message" && event.type !== "assistant/attempt") continue;
    const { turn, step } = event.data;
    const key = `${turn}:${step}`;
    const sample = usageOf(event);
    const settledBy = event.type === "assistant/message" ? "message" : "attempt";
    const source = event.type === "assistant/message" ? event.data.message.source : void 0;
    const named = source?.provider !== void 0 && source.model !== void 0;
    const provider = named ? source.provider : route?.provider ?? "unknown";
    const model = named ? source.model : route?.model ?? "unknown";
    const routeKnown = named || route !== void 0;
    const suspect = openTurns.has(turn);
    const held = open.get(key);
    if (held === void 0) {
      const created = {
        turn,
        step,
        seq: event.seq,
        time: event.time,
        retry: retryIndex.get(key) ?? 0,
        settledBy,
        provider,
        model,
        routeKnown,
        suspect,
        sample: sample ?? emptySample()
      };
      open.set(key, created);
      slots.push(created);
      continue;
    }
    held.settledBy = settledBy;
    if (named) {
      held.provider = provider;
      held.model = model;
    }
    held.routeKnown = held.routeKnown || routeKnown;
    held.suspect = held.suspect || suspect;
    held.seq = event.seq;
    held.time = event.time;
    if (sample !== void 0 && !sameSample(sample, held.sample)) held.sample = sample;
  }
  const mirrored = totalsOf(slots, retries);
  const rows = slots.slice(-200).map((slot) => ({
    seq: slot.seq,
    time: slot.time,
    turn: slot.turn,
    step: slot.step,
    settledBy: slot.settledBy,
    retry: slot.retry,
    routeKnown: slot.routeKnown,
    provider: slot.provider,
    model: slot.model,
    uncachedInput: slot.sample.uncachedInput,
    cacheRead: slot.sample.cacheRead,
    cacheWrite: slot.sample.cacheWrite,
    output: slot.sample.output,
    maintenanceSuspect: slot.suspect
  }));
  maintenanceSuspects = slots.filter((slot) => slot.suspect).length;
  const host = options.host;
  const differences = host === void 0 ? [] : [
    ["uncachedInputTokens", host.uncachedInputTokens, mirrored.uncachedInput.sum],
    ["cacheReadTokens", host.cacheReadTokens, mirrored.cacheRead.sum],
    ["cacheWriteTokens", host.cacheWriteTokens, mirrored.cacheWrite.sum],
    ["outputTokens", host.outputTokens, mirrored.output.sum]
  ].flatMap(([field, hostValue, mirroredValue]) => hostValue === mirroredValue ? [] : [{ field, host: hostValue, mirrored: mirroredValue, delta: hostValue - mirroredValue }]);
  const measured = slots.filter((slot) => slot.sample.uncachedInput !== null && slot.sample.cacheRead !== null && slot.sample.cacheWrite !== null);
  const measuredInput = measured.reduce((total, slot) => total + (slot.sample.uncachedInput ?? 0) + (slot.sample.cacheRead ?? 0) + (slot.sample.cacheWrite ?? 0), 0);
  const measuredRead = measured.reduce((total, slot) => total + (slot.sample.cacheRead ?? 0), 0);
  const summary = options.summary;
  return {
    accounting: host === void 0 ? "event-log" : "host-projection",
    ...host === void 0 ? {} : { host },
    mirrored,
    differences,
    ...summary === void 0 ? {} : { summaryAndRepair: {
      ...summary,
      purposeSplit: false,
      note: "\u73B0\u6709\u6458\u8981\u603B\u8D26\u7684\u7D2F\u8BA1\u503C\uFF0C\u542B\u5931\u8D25\u4E0E\u53D6\u6D88\u5C1D\u8BD5\uFF1B\u8D26\u672C\u6CA1\u6709\u6301\u4E45\u7528\u9014\u5B57\u6BB5\uFF0C\u6458\u8981\u4E0E\u4FEE\u590D\u5408\u8BA1\u663E\u793A\u3001\u5386\u53F2\u7528\u9014\u672A\u7EC6\u5206\uFF0C\u4E5F\u4E0D\u4E0E\u5408\u5E76\u540E\u7684 compaction/summary \u91CD\u590D\u76F8\u52A0"
    } },
    maintenanceSuspects,
    cacheHitRatio: measuredInput > 0 ? measuredRead / measuredInput : null,
    requests: rows,
    fingerprint: fingerprint ?? null,
    changes: changes.slice(-16)
  };
}
function emptySample() {
  return { uncachedInput: null, cacheRead: null, cacheWrite: null, output: null };
}

// src/inspector-wire.ts
import { z as z2 } from "zod";
var count2 = () => z2.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
var seq = () => z2.number().int().min(-1).max(Number.MAX_SAFE_INTEGER);
var category = () => z2.enum(["summary", "system", "tools", "user", "inject", "skill", "assistant", "tool"]);
var sessionId = () => z2.string().min(1).max(500);
function recoveryGrantSchema() {
  return z2.object({ sessionId: sessionId(), requestHash: z2.string().regex(/^[a-f0-9]{64}$/) }).strict();
}
function idleQuerySchema() {
  return z2.object({ sessionId: sessionId() }).strict();
}
function inspectQuerySchema() {
  return z2.object({ sessionId: sessionId(), atSeq: seq().nullable(), offset: count2(), category: z2.union([category(), z2.literal("all")]), group: z2.enum(["summary", "tool", "message", "instruction"]).optional(), search: z2.string().max(200), sort: z2.enum(["size", "position"]), archived: z2.boolean() }).strict();
}
function contentQuerySchema() {
  return z2.object({ sessionId: sessionId(), cutSeq: seq(), id: z2.string().min(1).max(100), offset: count2(), sourceOffset: count2().optional() }).strict();
}

// src/inspector.ts
function contextGrowth(registry, observation, cut, signal) {
  let compact = -1;
  let tool = -1;
  let route;
  let comparable = false;
  for (const event of observation.events) {
    if (event.seq > cut) break;
    signal.throwIfAborted();
    if (event.type === "request/header") {
      const next = JSON.stringify([event.data.header.config.provider, event.data.header.config.model]);
      if (next !== route) comparable = false;
      route = next;
    }
    if (event.type === "user/message" && typeof event.surfaceOp === "object" && isCompactCheckpointSource2(event.data.source)) {
      compact = event.seq;
      const claim = observation.events[event.seq - 1];
      comparable = route !== void 0 && claim?.type === "compaction/summary" && claim.data.compactionId === event.data.source.compactionId && claim.data.shadowedRange.start === event.surfaceOp.startSeq && claim.data.shadowedRange.end === event.surfaceOp.endSeq;
    }
    if (event.type === "tool/result" && event.surfaceOp === "append") tool = event.seq;
  }
  const cuts = [.../* @__PURE__ */ new Set([...compact >= 0 && comparable ? [compact, cut] : [], ...tool > 0 ? [tool - 1, tool] : []])].sort((a, b) => a - b);
  const measured = /* @__PURE__ */ new Map();
  let checkpoint = {};
  let start = 0;
  for (const seq2 of cuts) {
    signal.throwIfAborted();
    const restored = registry.restore(checkpoint, observation.events.slice(start, seq2 + 1), SessionLogOffset2(start), observation.header, observation.inheritedEventCount);
    checkpoint = restored.checkpoint;
    start = seq2 + 1;
    const tokens = restored.snapshot.values.contextPressure?.projectedTokens;
    if (typeof tokens === "number" && Number.isSafeInteger(tokens) && tokens >= 0) measured.set(seq2, tokens);
  }
  const delta = (fromSeq, toSeq) => {
    const beforeTokens = measured.get(fromSeq);
    const afterTokens = measured.get(toSeq);
    return beforeTokens === void 0 || afterTokens === void 0 ? null : { fromSeq, toSeq, beforeTokens, afterTokens, deltaTokens: afterTokens - beforeTokens };
  };
  return { sinceCompaction: comparable ? delta(compact, cut) : null, lastToolResult: delta(tool - 1, tool) };
}
var _content_dec, _inspect_dec, _idleStatus_dec, _a, _init;
var ContextInspector = class extends (_a = TypertRemoteService, _idleStatus_dec = [Remote("idleStatus")], _inspect_dec = [Remote("inspect")], _content_dec = [Remote("content")], _a) {
  constructor(ctx) {
    super(ctx, "contextInspector");
    __runInitializers(_init, 5, this);
    __publicField(this, "lifetime", new AbortController());
    ctx.plugin(ContextRecovery);
    ctx.effect(() => () => this.lifetime.abort());
  }
  async idleStatus(input, signal) {
    signal.throwIfAborted();
    const query = idleQuerySchema().parse(input);
    return this.ctx.contextManager.idleStatus(query.sessionId);
  }
  admission(sessionId2, cut) {
    const meter = this.ctx.get("tokenMeter");
    if (!meter) return;
    const session = this.ctx.sessions.get(SessionId(sessionId2));
    if (!session) return;
    try {
      const measurement = meter.measure(session);
      if (measurement.logRevision !== cut + 1 || !Number.isSafeInteger(measurement.totalTokens) || measurement.totalTokens < 0) return;
      const config = session.requestHeader()?.config;
      const context = session.requestContext();
      const sameRoute = config !== void 0 && context !== void 0 && context.provider === config.provider && context.model === config.model;
      const window = sameRoute ? context.contextWindow : void 0;
      const outputReserve = config?.maxTokens;
      return {
        tokens: measurement.totalTokens,
        logRevision: measurement.logRevision,
        baseline: measurement.baseline.kind,
        window: typeof window === "number" && Number.isSafeInteger(window) && window > 0 ? window : null,
        outputReserve: typeof outputReserve === "number" && Number.isSafeInteger(outputReserve) && outputReserve >= 0 ? outputReserve : null
      };
    } catch {
      return void 0;
    }
  }
  async read(sessionId2, atSeq, signal, mode, use) {
    const cancel = AbortSignal.any([signal, this.lifetime.signal, AbortSignal.timeout(12e3)]);
    const observation = await this.ctx.sessionQuery.observeSession(SessionId(sessionId2), { signal: cancel, projectionMode: mode });
    try {
      cancel.throwIfAborted();
      const cut = atSeq ?? observation.cursor;
      if (cut > observation.cursor) throw new Error("\u8BB0\u5F55\u7248\u672C\u5DF2\u5931\u6548\uFF0C\u8BF7\u5237\u65B0\u5F53\u524D\u4F1A\u8BDD\u3002");
      if (cut + 1 > MAX_EVENTS) throw new Error(`\u5F53\u524D\u65E5\u5FD7\u8D85\u8FC7 ${MAX_EVENTS.toLocaleString()} \u6761\u8BB0\u5F55\u7684\u5206\u6790\u4E0A\u9650\u3002`);
      const index = indexContext(observation.events.slice(0, cut + 1), this.ctx.sessions.messageProjections);
      cancel.throwIfAborted();
      return use(observation, cut, index);
    } finally {
      observation[Symbol.dispose]();
    }
  }
  async inspect(input, signal) {
    const query = inspectQuerySchema().parse(input);
    return this.read(query.sessionId, query.atSeq, signal, query.atSeq === null ? "all" : "none", (observation, cut, index) => {
      const values = observation.projections?.values;
      const pressure = values?.contextPressure;
      const official = values?.contextBreakdown;
      const usage = values?.tokenUsage;
      const goalState = values?.goal;
      const admission = query.atSeq === null ? this.admission(query.sessionId, cut) : void 0;
      const summary = query.atSeq === null ? this.ctx.contextManager.summaryLedger?.stats(query.sessionId) : void 0;
      const attribution = attributeSession(observation.events.slice(0, cut + 1), {
        ...query.atSeq !== null || usage === void 0 ? {} : { host: {
          source: "host-token-usage",
          uncachedInputTokens: usage.uncachedInputTokens,
          cacheReadTokens: usage.cacheReadTokens,
          cacheWriteTokens: usage.cacheWriteTokens,
          outputTokens: usage.outputTokens
        } },
        ...summary === void 0 ? {} : { summary: {
          source: "summary-ledger",
          input: summary.input,
          output: summary.output,
          cacheRead: summary.cacheRead,
          cacheWrite: summary.cacheWrite,
          attempts: summary.attempts,
          unknownAttempts: summary.unknownAttempts
        } },
        fingerprint: this.ctx.contextManager.snapshot?.().prefixDiagnosticsEnabled ?? true
      });
      const reductions = query.atSeq === null ? this.ctx.contextManager.reductionReadout?.(query.sessionId) : void 0;
      const efficiency = {
        accounting: attribution.accounting,
        host: attribution.host === void 0 ? null : {
          uncachedInputTokens: attribution.host.uncachedInputTokens,
          cacheReadTokens: attribution.host.cacheReadTokens,
          cacheWriteTokens: attribution.host.cacheWriteTokens,
          outputTokens: attribution.host.outputTokens
        },
        mirrored: {
          settledAttempts: attribution.mirrored.settledAttempts,
          retries: attribution.mirrored.retries,
          withoutUsage: attribution.mirrored.withoutUsage,
          uncachedInput: { ...attribution.mirrored.uncachedInput },
          cacheRead: { ...attribution.mirrored.cacheRead },
          cacheWrite: { ...attribution.mirrored.cacheWrite },
          output: { ...attribution.mirrored.output },
          cacheInclusiveInput: { ...attribution.mirrored.cacheInclusiveInput },
          complete: attribution.mirrored.complete
        },
        differences: attribution.differences.map((item) => ({ field: item.field, host: item.host, mirrored: item.mirrored, delta: item.delta })),
        summaryAndRepair: attribution.summaryAndRepair === void 0 ? null : {
          source: attribution.summaryAndRepair.source,
          input: attribution.summaryAndRepair.input,
          output: attribution.summaryAndRepair.output,
          cacheRead: attribution.summaryAndRepair.cacheRead ?? null,
          cacheWrite: attribution.summaryAndRepair.cacheWrite ?? null,
          attempts: attribution.summaryAndRepair.attempts,
          unknownAttempts: attribution.summaryAndRepair.unknownAttempts,
          purposeSplit: attribution.summaryAndRepair.purposeSplit,
          note: attribution.summaryAndRepair.note
        },
        maintenanceSuspects: attribution.maintenanceSuspects,
        cacheHitRatio: attribution.cacheHitRatio,
        requests: attribution.requests.map((item) => ({
          seq: item.seq,
          time: item.time,
          turn: item.turn,
          step: item.step,
          settledBy: item.settledBy,
          routeKnown: item.routeKnown,
          retry: item.retry,
          provider: item.provider,
          model: item.model,
          uncachedInput: item.uncachedInput,
          cacheRead: item.cacheRead,
          cacheWrite: item.cacheWrite,
          output: item.output,
          maintenanceSuspect: item.maintenanceSuspect
        })),
        fingerprint: attribution.fingerprint === null ? null : { ...attribution.fingerprint },
        changes: attribution.changes.map((item) => ({ seq: item.seq, time: item.time, changed: [...item.changed], note: item.note }))
      };
      signal.throwIfAborted();
      const triggers = new Map((summary?.recent ?? []).map((attempt) => [attempt.compactionId, attempt.trigger]));
      const compactions = index.diagnostics.compactions.map((entry) => {
        const trigger = entry.kind === "compact" ? triggers.get(entry.id) : void 0;
        return trigger === void 0 ? entry : { ...entry, trigger };
      });
      const needle = query.search.trim().toLocaleLowerCase();
      const matched = index.indexed.map((item) => item.row).filter((row) => (query.archived || row.current) && (query.category === "all" || row.category === query.category) && (query.group === void 0 || contextGroups.find((group) => group.id === query.group)?.categories.some((category2) => category2 === row.category)) && (!needle || `${row.title} ${row.source}`.toLocaleLowerCase().includes(needle)));
      matched.sort(query.sort === "size" ? (a, b) => b.tokens - a.tokens || b.seq - a.seq || a.id.localeCompare(b.id) : (a, b) => a.seq - b.seq || a.id.localeCompare(b.id));
      const config = index.header?.config;
      return {
        sessionId: query.sessionId,
        cursor: observation.cursor,
        cutSeq: cut,
        sampledAt: Date.now(),
        historical: query.atSeq !== null,
        pressure: query.atSeq === null && typeof pressure?.projectedTokens === "number" && typeof pressure.pressureTokens === "number" ? { projected: pressure.projectedTokens, input: pressure.pressureTokens, window: pressure.contextWindow ?? null } : null,
        ...admission ? { admission } : {},
        official: query.atSeq === null && official ? { system: official.systemTokens, tools: official.toolsTokens, messages: official.messageTokens } : null,
        usage: query.atSeq === null && usage ? { input: usage.uncachedInputTokens + usage.cacheReadTokens + usage.cacheWriteTokens, output: usage.outputTokens, cacheRead: usage.cacheReadTokens, uncached: usage.uncachedInputTokens, cacheWrite: usage.cacheWriteTokens } : null,
        ...summary ? { summaryUsage: { input: summary.input, output: summary.output, attempts: summary.attempts, unknownAttempts: summary.unknownAttempts, since: summary.since } } : {},
        efficiency,
        ...reductions === void 0 ? {} : { reduction: reductions },
        ...query.atSeq === null ? { contextGrowth: contextGrowth(this.ctx.sessionProjections, observation, cut, signal) } : {},
        model: config ? { provider: config.provider, model: config.model, effort: config.reasoningEffort === void 0 ? null : String(config.reasoningEffort), maxTokens: typeof config.maxTokens === "number" && Number.isFinite(config.maxTokens) && config.maxTokens >= 0 ? config.maxTokens : null } : null,
        ...query.atSeq === null && goalState ? { goal: {
          phase: goalState.goal.phase,
          blockedReason: goalState.goal.blockedReason === void 0 ? null : { code: goalState.goal.blockedReason.code, message: goalState.goal.blockedReason.message },
          roundsStarted: goalState.roundsStarted,
          maxGoalRounds: goalState.goal.maxGoalRounds
        } } : {},
        pressureHistory: pressureHistory(this.ctx.sessionProjections, observation, cut, signal),
        parts: index.parts,
        rows: matched.slice(query.offset, query.offset + 50),
        total: matched.length,
        offset: query.offset,
        pageSize: 50,
        activeCount: index.indexed.filter((item) => item.row.current).length,
        archivedCount: index.indexed.filter((item) => !item.row.current).length,
        requests: index.requests,
        requestCount: index.requestCount,
        compactions
      };
    });
  }
  async content(input, signal) {
    const query = contentQuerySchema().parse(input);
    return this.read(query.sessionId, query.cutSeq, signal, "none", (_observation, cut, index) => {
      const item = index.indexed.find((item2) => item2.row.id === query.id);
      if (!item) throw new Error("\u8BE5\u6761\u76EE\u4E0D\u5C5E\u4E8E\u8FD9\u4E2A\u4F1A\u8BDD\u622A\u9762\uFF0C\u8BF7\u91CD\u65B0\u9009\u62E9\u3002");
      const sourceOffset = query.sourceOffset ?? 0;
      if (query.sourceOffset !== void 0 && item.row.category !== "summary") throw new Error("\u53EA\u6709\u538B\u7F29\u6458\u8981\u53EF\u4EE5\u8BFB\u53D6\u6765\u6E90\u7D22\u5F15\u3002");
      const bySeq = new Map(index.indexed.filter((entry) => entry.row.id.startsWith("event:")).map((entry) => [entry.row.seq, entry.row]));
      const sources = item.sourceSeqs?.flatMap((seq2) => {
        const row = bySeq.get(seq2);
        return row ? [row] : [];
      });
      if (sources && sourceOffset > sources.length) throw new Error("\u6765\u6E90\u4F4D\u7F6E\u5DF2\u5931\u6548\uFF0C\u8BF7\u91CD\u65B0\u9009\u62E9\u6458\u8981\u3002");
      const text = item.body();
      if (query.offset > text.length) throw new Error("\u5185\u5BB9\u4F4D\u7F6E\u5DF2\u5931\u6548\uFF0C\u8BF7\u91CD\u65B0\u9009\u62E9\u6761\u76EE\u3002");
      let end = Math.min(query.offset + 16e3, text.length);
      if (end < text.length && /[\uD800-\uDBFF]/u.test(text[end - 1])) end--;
      return {
        sessionId: query.sessionId,
        cutSeq: cut,
        id: query.id,
        text: text.slice(query.offset, end),
        offset: query.offset,
        totalChars: text.length,
        nextOffset: end < text.length ? end : null,
        ...sources ? { sources: { rows: sources.slice(sourceOffset, sourceOffset + 4), offset: sourceOffset, total: sources.length, nextOffset: sourceOffset + 4 < sources.length ? sourceOffset + 4 : null } } : {}
      };
    });
  }
};
_init = __decoratorStart(_a);
__decorateElement(_init, 1, "idleStatus", _idleStatus_dec, ContextInspector);
__decorateElement(_init, 1, "inspect", _inspect_dec, ContextInspector);
__decorateElement(_init, 1, "content", _content_dec, ContextInspector);
__decoratorMetadata(_init, ContextInspector);
__publicField(ContextInspector, "inject", ["sessionQuery", "sessions", "contextManager", "sessionProjections"]);
var inspector_default = ContextInspector;
var _authorizeOnce_dec, _a2, _init2;
var ContextRecovery = class extends (_a2 = TypertRemoteService, _authorizeOnce_dec = [Remote("authorizeOnce")], _a2) {
  constructor(ctx) {
    super(ctx, "contextRecovery");
    __runInitializers(_init2, 5, this);
  }
  async authorizeOnce(input, signal) {
    signal.throwIfAborted();
    const query = recoveryGrantSchema().parse(input);
    await this.ctx.contextManager.authorizeRecovery(query.sessionId, query.requestHash, signal);
    return { granted: true };
  }
};
_init2 = __decoratorStart(_a2);
__decorateElement(_init2, 1, "authorizeOnce", _authorizeOnce_dec, ContextRecovery);
__decoratorMetadata(_init2, ContextRecovery);
__publicField(ContextRecovery, "inject", ["contextManager"]);
export {
  ContextInspector,
  ContextRecovery,
  contextGrowth,
  inspector_default as default,
  pressureHistory
};
