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
export {
  diagnosticsProjection,
  foldDiagnostics
};
