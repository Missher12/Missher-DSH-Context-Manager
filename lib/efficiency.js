// src/efficiency.ts
import { createHash } from "crypto";
import { canonicalHeader } from "@deepseek-ai/dsh-session";
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
      const header = canonicalHeader(event.data.header);
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
export {
  attributeSession
};
