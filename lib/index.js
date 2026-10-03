// src/index.ts
import { Service } from "@deepseek-ai/cordis";
import z4 from "@deepseek-ai/schemastery";

// src/policy.ts
var defaults = {
  enabled: true,
  triggerPercent: 80,
  targetPercent: 55,
  earlyPercent: 1,
  safetyPercent: 2,
  summaryMaxTokens: 8192,
  maxPasses: 2,
  timeoutMs: 9e4,
  idleEnabled: true,
  idleMinutes: 15,
  idleMinPercent: 65,
  summaryInstructions: ""
};
function validatePolicy(p) {
  if (typeof p.enabled !== "boolean") throw new Error("\u81EA\u52A8\u538B\u7F29\u5F00\u5173\u5FC5\u987B\u662F\u5E03\u5C14\u503C");
  if (typeof p.idleEnabled !== "boolean") throw new Error("\u95F2\u7F6E\u81EA\u52A8\u538B\u7F29\u5F00\u5173\u5FC5\u987B\u662F\u5E03\u5C14\u503C");
  if (typeof p.summaryInstructions !== "string" || p.summaryInstructions.length > 2e3) throw new Error("\u6458\u8981\u4FDD\u7559\u91CD\u70B9\u4E0D\u80FD\u8D85\u8FC7 2000 \u5B57\u7B26");
  const ranges = {
    triggerPercent: [50, 95],
    targetPercent: [10, 75],
    earlyPercent: [0, 5],
    safetyPercent: [1, 10],
    summaryMaxTokens: [256, 32768],
    maxPasses: [1, 2],
    timeoutMs: [1e3, 3e5],
    idleMinutes: [1, 1440],
    idleMinPercent: [10, 95]
  };
  for (const [key, [min, max]] of Object.entries(ranges)) {
    const value = p[key];
    if (!Number.isFinite(value) || value < min || value > max) throw new Error(`${key} \u5FC5\u987B\u5728 ${min}\u2013${max} \u4E4B\u95F4`);
  }
  if (p.targetPercent > p.triggerPercent - p.earlyPercent - 10) throw new Error("\u538B\u7F29\u76EE\u6807\u987B\u6BD4\u5B9E\u9645\u68C0\u67E5\u9608\u503C\u81F3\u5C11\u4F4E 10 \u4E2A\u767E\u5206\u70B9");
  for (const key of ["summaryMaxTokens", "maxPasses", "timeoutMs", "idleMinutes"]) {
    if (!Number.isInteger(p[key])) throw new Error(`${key} \u5FC5\u987B\u662F\u6574\u6570`);
  }
}

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

// src/idle-store.ts
import { z as z2 } from "zod";
import { defineDomain, domainTable } from "@deepseek-ai/dsh-storage-domain";
var tokenCount = z2.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
var identifier = z2.string().min(1).max(256);
var eligibilitySchema = z2.object({
  sessionId: identifier,
  turnEndSeq: tokenCount,
  completedAt: tokenCount,
  fingerprint: identifier
}).strict();
var terminalStatus = z2.enum(["completed", "skipped", "cancelled", "failed", "interrupted"]);
var outcomeSchema = z2.object({
  status: terminalStatus,
  compactionId: identifier.optional(),
  beforeTokens: tokenCount.optional(),
  afterTokens: tokenCount.optional(),
  reasonCode: z2.string().min(1).max(160).optional()
}).strict();
var recordSchema = eligibilitySchema.extend({
  status: z2.enum(["eligible", "started", ...terminalStatus.options]),
  updatedAt: tokenCount,
  attemptId: identifier.optional(),
  compactionId: identifier.optional(),
  beforeTokens: tokenCount.optional(),
  afterTokens: tokenCount.optional(),
  reasonCode: z2.string().min(1).max(160).optional()
}).refine((record2) => record2.status !== "started" || record2.attemptId !== void 0, {
  message: "a started idle attempt requires an attemptId"
}).refine((record2) => record2.status !== "eligible" || record2.attemptId === void 0, {
  message: "an eligible idle turn cannot already have an attemptId"
});
var idleDomainSpec = defineDomain({
  name: "context_manager_idle",
  version: 1,
  tables: { sessions: domainTable(recordSchema) }
});
function sameEligibility(left, right) {
  return left.sessionId === right.sessionId && left.turnEndSeq === right.turnEndSeq && left.completedAt === right.completedAt && left.fingerprint === right.fingerprint;
}
function eligibilityOf(value) {
  return eligibilitySchema.parse({
    sessionId: value.sessionId,
    turnEndSeq: value.turnEndSeq,
    completedAt: value.completedAt,
    fingerprint: value.fingerprint
  });
}
var IdleStore = class _IdleStore {
  constructor(domain) {
    this.domain = domain;
    this.table = domain.table("sessions");
  }
  table;
  chain = Promise.resolve();
  closing = false;
  disposal;
  /** Open once on the Manager; preset engines share the returned instance. */
  static async open(facility) {
    return new _IdleStore(await facility.open(idleDomainSpec));
  }
  /** Read only the latest persisted record, without exposing mutable domain state. */
  get(sessionId) {
    const record2 = this.table.get(sessionId);
    if (!record2) return void 0;
    if (record2.sessionId !== sessionId) throw new Error("idle record session key mismatch");
    return Object.freeze({ ...record2 });
  }
  /** Snapshot only this ledger's registered metadata, without loading sessions. */
  all() {
    return Object.freeze(Array.from(this.table.entries(), ([key, record2]) => {
      if (record2.sessionId !== key) throw new Error("idle record session key mismatch");
      return Object.freeze({ ...record2 });
    }));
  }
  /**
   * Record a newly observed normal completion. A duplicate never restores
   * eligibility after an attempt; stale completion events cannot replace newer
   * ones. A later completion may reset its sequence after a history clear.
   */
  async reserve(eligibility) {
    const input = eligibilitySchema.parse(eligibility);
    return this.enqueue(async () => {
      const current = this.get(input.sessionId);
      if (current) {
        if (sameEligibility(current, input)) return current;
        if (current.fingerprint === input.fingerprint) return null;
        if (input.completedAt < current.completedAt || input.completedAt === current.completedAt && input.turnEndSeq <= current.turnEndSeq) return null;
      }
      return this.put({ ...input, status: "eligible", updatedAt: Date.now() });
    });
  }
  /** Only the winner may start compaction, and only after awaiting this write. */
  async claim(eligibility, attemptId, beforeTokens) {
    const expected = eligibilityOf(eligibility);
    const id = identifier.parse(attemptId);
    const before = beforeTokens === void 0 ? void 0 : tokenCount.parse(beforeTokens);
    return this.enqueue(async () => {
      const current = this.get(expected.sessionId);
      if (!current || current.status !== "eligible" || !sameEligibility(current, expected)) return null;
      return this.put({
        ...current,
        status: "started",
        attemptId: id,
        updatedAt: Date.now(),
        ...before === void 0 ? {} : { beforeTokens: before }
      });
    });
  }
  /** Persist the host transaction ID before its summary stream may begin. */
  async bindCompaction(eligibility, attemptId, compactionId) {
    const expected = eligibilityOf(eligibility);
    const id = identifier.parse(attemptId);
    const compaction = identifier.parse(compactionId);
    return this.enqueue(async () => {
      const current = this.get(expected.sessionId);
      if (!current || current.status !== "started" || current.attemptId !== id || !sameEligibility(current, expected)) return null;
      if (current.compactionId === compaction) return current;
      return this.put({ ...current, compactionId: compaction, updatedAt: Date.now() });
    });
  }
  /**
   * Finish exactly one qualification/attempt. Unclaimed eligibility can be
   * skipped or invalidated without an attemptId, but cannot claim completion.
   * A late cancellation or completion cannot overwrite a newer normal turn.
   */
  async settle(eligibility, attemptId, outcome) {
    const expected = eligibilityOf(eligibility);
    const id = attemptId === void 0 ? void 0 : identifier.parse(attemptId);
    const result = outcomeSchema.parse(outcome);
    return this.enqueue(async () => {
      const current = this.get(expected.sessionId);
      if (!current || !sameEligibility(current, expected) || current.attemptId !== id) return null;
      if (current.status !== "eligible" && current.status !== "started") return null;
      if (current.status === "eligible" && (id !== void 0 || result.status === "completed")) return null;
      return this.put({ ...current, ...result, updatedAt: Date.now() });
    });
  }
  /** Wait for writes already accepted; each write reports its own failure. */
  drain() {
    return this.chain;
  }
  /** Reject new writes, drain accepted writes, then release the domain once. */
  close() {
    if (!this.disposal) {
      this.closing = true;
      this.disposal = this.chain.then(() => this.domain.close());
    }
    return this.disposal;
  }
  enqueue(job) {
    if (this.closing) return Promise.reject(new Error("idle store is closing"));
    const pending = this.chain.then(job);
    this.chain = pending.then(() => {
    }, () => {
    });
    return pending;
  }
  async put(value) {
    const record2 = Object.freeze(recordSchema.parse(value));
    await this.table.put(record2.sessionId, record2);
    return Object.freeze({ ...record2 });
  }
};

// src/summary-ledger.ts
import { randomUUID } from "crypto";
import { z as z3 } from "zod";
import { defineDomain as defineDomain2, domainTable as domainTable2 } from "@deepseek-ai/dsh-storage-domain";
var count2 = z3.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
var totals = z3.object({ input: count2, output: count2, cacheRead: count2, cacheWrite: count2, attempts: count2, unknownAttempts: count2 }).strict();
var attempt = z3.object({
  id: z3.string(),
  compactionId: z3.string(),
  trigger: z3.enum(["idle", "pressure", "overflow", "manual"]),
  startedAt: count2,
  endedAt: count2.optional(),
  status: z3.enum(["started", "generated", "failed", "cancelled"]),
  input: count2.nullable(),
  output: count2.nullable(),
  cacheRead: count2,
  cacheWrite: count2
}).strict();
var record = z3.object({ sessionId: z3.string(), since: count2, archived: totals, recent: z3.array(attempt).max(128) }).strict();
var spec = defineDomain2({ name: "context_manager_summaries", version: 1, tables: { sessions: domainTable2(record) } });
var zero = () => ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, attempts: 0, unknownAttempts: 0 });
var finite = (n) => typeof n === "number" && Number.isSafeInteger(n) && n >= 0;
function add(total, row) {
  return {
    input: total.input + (row.input ?? 0),
    output: total.output + (row.output ?? 0),
    cacheRead: total.cacheRead + row.cacheRead,
    cacheWrite: total.cacheWrite + row.cacheWrite,
    attempts: total.attempts + 1,
    unknownAttempts: total.unknownAttempts + (row.input === null || row.output === null ? 1 : 0)
  };
}
var SummaryLedger = class _SummaryLedger {
  constructor(domain) {
    this.domain = domain;
    this.table = domain.table("sessions");
  }
  chain = Promise.resolve();
  closed = false;
  table;
  static async open(facility) {
    return new _SummaryLedger(await facility.open(spec));
  }
  enqueue(work) {
    if (this.closed) return Promise.reject(new Error("Summary ledger closed"));
    const operation = this.chain.then(work);
    this.chain = operation.catch(() => {
    });
    return operation;
  }
  async start(sessionId, compactionId, trigger) {
    return this.enqueue(async () => {
      const old = this.table.get(sessionId);
      const next = old ? { ...old, recent: [...old.recent], archived: { ...old.archived } } : { sessionId, since: Date.now(), recent: [], archived: zero() };
      if (next.recent.length === 128) {
        const archived = next.recent.findIndex((item) => item.status !== "started");
        if (archived < 0) throw new Error("Too many unsettled summary attempts");
        next.archived = add(next.archived, next.recent.splice(archived, 1)[0]);
      }
      const id = randomUUID();
      next.recent.push({ id, compactionId, trigger, startedAt: Date.now(), status: "started", input: null, output: null, cacheRead: 0, cacheWrite: 0 });
      await this.table.put(sessionId, next);
      return id;
    });
  }
  async finish(sessionId, id, status, usage) {
    return this.enqueue(async () => {
      const old = this.table.get(sessionId);
      const index = old?.recent.findIndex((item) => item.id === id) ?? -1;
      if (!old || index < 0) return;
      if (old.recent[index].status !== "started") return;
      const cacheRead = finite(usage?.cacheReadTokens) ? usage.cacheReadTokens : 0;
      const cacheWrite = finite(usage?.cacheWriteTokens) ? usage.cacheWriteTokens : 0;
      const row = {
        ...old.recent[index],
        status,
        endedAt: Date.now(),
        cacheRead,
        cacheWrite,
        input: finite(usage?.inputTokens) ? usage.inputTokens + cacheRead + cacheWrite : null,
        output: finite(usage?.outputTokens) ? usage.outputTokens : null
      };
      const recent = [...old.recent];
      recent[index] = row;
      await this.table.put(sessionId, { ...old, recent });
    });
  }
  stats(sessionId) {
    const row = this.table.get(sessionId);
    if (!row) return;
    return { ...row.recent.reduce(add, { ...row.archived }), since: row.since, recent: row.recent.slice(-32).map((item) => ({ ...item })) };
  }
  async close() {
    this.closed = true;
    await this.chain;
    await this.domain.close();
  }
};

// src/index.ts
var ContextManager = class extends Service {
  constructor(ctx, config) {
    super(ctx, "contextManager");
    this.config = config;
    this.snapshot();
    ctx.inject(["sessionProjections"], (child) => {
      child.sessionProjections.register(diagnosticsProjection);
    });
    ctx.inject(["settings"], (child) => {
      child.effect(() => child.settings.configure({ auto: false }, ctx.fiber));
    });
  }
  static inject = ["storageDomain"];
  idleStore;
  summaryLedger;
  idleActive = false;
  idleReaders = /* @__PURE__ */ new Map();
  static Config = z4.object({
    policy: z4.object({
      enabled: z4.boolean().default(defaults.enabled),
      triggerPercent: z4.number().min(50).max(95).default(defaults.triggerPercent),
      targetPercent: z4.number().min(10).max(75).default(defaults.targetPercent),
      earlyPercent: z4.number().min(0).max(5).default(defaults.earlyPercent),
      safetyPercent: z4.number().min(1).max(10).default(defaults.safetyPercent),
      summaryMaxTokens: z4.number().min(256).max(32768).step(1).default(defaults.summaryMaxTokens),
      maxPasses: z4.number().min(1).max(2).step(1).default(defaults.maxPasses),
      timeoutMs: z4.number().min(1e3).max(3e5).step(1).default(defaults.timeoutMs),
      idleEnabled: z4.boolean().default(defaults.idleEnabled),
      idleMinutes: z4.number().min(1).max(1440).step(1).default(defaults.idleMinutes),
      idleMinPercent: z4.number().min(10).max(95).default(defaults.idleMinPercent),
      summaryInstructions: z4.string().max(2e3).default(defaults.summaryInstructions)
    }).default(defaults).volatile()
  });
  async [Service.init]() {
    this.idleStore = await IdleStore.open(this.ctx.storageDomain);
    this.ctx.effect(() => () => this.idleStore.close());
    this.summaryLedger = await SummaryLedger.open(this.ctx.storageDomain);
    this.ctx.effect(() => () => this.summaryLedger.close());
  }
  /** One background summary across isolated engines; main request admission is independent. */
  acquireIdle() {
    if (this.idleActive) return;
    this.idleActive = true;
    let released = false;
    return () => {
      if (!released) {
        released = true;
        this.idleActive = false;
      }
    };
  }
  async cancelIdlePlans(reasonCode) {
    for (const record2 of this.idleStore.all()) {
      if (record2.status === "eligible" || record2.status === "started") await this.idleStore.settle(record2, record2.attemptId, { status: "cancelled", reasonCode });
    }
  }
  savedIdleStatus(record2) {
    const messages = {
      disabled: "\u95F2\u7F6E\u81EA\u52A8\u538B\u7F29\u5DF2\u5173\u95ED",
      interrupted: "\u4E0A\u6B21\u6574\u7406\u88AB\u4E2D\u65AD\uFF0C\u8D39\u7528\u72B6\u6001\u672A\u77E5\uFF1B\u672C\u8F6E\u4E0D\u81EA\u52A8\u91CD\u8BD5",
      history_changed: "\u4F1A\u8BDD\u5185\u5BB9\u5DF2\u53D8\u5316\uFF0C\u65E7\u95F2\u7F6E\u8BA1\u5212\u5DF2\u53D6\u6D88",
      completed: "\u95F2\u7F6E\u538B\u7F29\u5DF2\u5B8C\u6210",
      recovered_commit: "\u5DF2\u6062\u590D\u4E0A\u6B21\u6210\u529F\u538B\u7F29\u8BB0\u5F55",
      below_threshold: "\u672A\u8FBE\u5230\u95F2\u7F6E\u6574\u7406\u95E8\u69DB\uFF0C\u672C\u8F6E\u65E0\u9700\u538B\u7F29",
      background: "\u540E\u53F0\u4EFB\u52A1\u5C1A\u672A\u7ED3\u675F\uFF0C\u672C\u8F6E\u672A\u6574\u7406",
      model_changed: "\u6A21\u578B\u9009\u62E9\u5DF2\u53D8\u5316\uFF0C\u7B49\u5F85\u4E0B\u6B21\u4EFB\u52A1\u5B8C\u6210\u540E\u91CD\u65B0\u8BA1\u65F6",
      host_capability_missing: "\u5BBF\u4E3B\u5C1A\u672A\u652F\u6301\u5B89\u5168\u95F2\u7F6E\u9009\u533A\uFF0C\u8BF7\u66F4\u65B0\u914D\u5957\u5BBF\u4E3B",
      pruned: "\u65E7\u5DE5\u5177\u7ED3\u679C\u5DF2\u6574\u7406\uFF0C\u65E0\u9700\u751F\u6210\u6458\u8981",
      no_range: "\u6CA1\u6709\u53EF\u5B89\u5168\u7F29\u51CF\u7684\u5386\u53F2\u5185\u5BB9",
      other_compaction: "\u5176\u4ED6\u538B\u7F29\u5DF2\u5904\u7406\uFF0C\u672C\u8F6E\u4E0D\u91CD\u590D\u6574\u7406",
      new_input: "\u65B0\u6D88\u606F\u5DF2\u5230\u8FBE\uFF0C\u65E7\u8BA1\u5212\u5DF2\u53D6\u6D88",
      running: "\u65B0\u4EFB\u52A1\u6B63\u5728\u6267\u884C",
      stopped: "\u4F1A\u8BDD\u5DF2\u505C\u6B62\uFF0C\u672C\u8F6E\u4E0D\u518D\u6574\u7406",
      failed: "\u4E0A\u6B21\u95F2\u7F6E\u6574\u7406\u5931\u8D25\uFF0C\u672C\u8F6E\u4E0D\u518D\u91CD\u8BD5",
      state_changed: "\u4F1A\u8BDD\u72B6\u6001\u5DF2\u53D8\u5316\uFF0C\u65E7\u8BA1\u5212\u5DF2\u53D6\u6D88",
      commit_incomplete: "\u5185\u5BB9\u5DF2\u66FF\u6362\uFF0C\u538B\u7F29\u6536\u5C3E\u672A\u5B8C\u6210\uFF1B\u672C\u8F6E\u4E0D\u81EA\u52A8\u91CD\u8BD5"
    };
    const status = record2.status === "eligible" ? "waiting" : record2.status === "started" || record2.status === "interrupted" ? "failed" : record2.status;
    return {
      status,
      dueAt: null,
      reasonCode: record2.reasonCode ?? record2.status,
      updatedAt: record2.updatedAt,
      message: record2.status === "eligible" ? "\u4F1A\u8BDD\u672A\u52A0\u8F7D\uFF0C\u6062\u590D\u540E\u7EE7\u7EED\u6838\u9A8C\u95F2\u7F6E\u8BA1\u5212" : messages[record2.reasonCode ?? record2.status] ?? "\u672C\u8F6E\u6574\u7406\u5DF2\u7ED3\u675F\uFF0C\u7B49\u5F85\u4E0B\u6B21\u4EFB\u52A1\u6B63\u5E38\u5B8C\u6210",
      ...record2.beforeTokens === void 0 ? {} : { beforeTokens: record2.beforeTokens },
      ...record2.afterTokens === void 0 ? {} : { afterTokens: record2.afterTokens }
    };
  }
  /** Freeze one admission's policy; edits take effect on the next request. */
  snapshot() {
    const result = { ...this.config.policy.get() };
    validatePolicy(result);
    return Object.freeze(result);
  }
  /**
   * Register a live Agent's status reader; the owner releases it on disposal.
   * @param sessionId - owning session, without loading it.
   * @param read - current idle maintenance status.
   * @returns an identity-guarded release function.
   */
  registerIdle(sessionId, read) {
    this.idleReaders.set(sessionId, read);
    return () => {
      if (this.idleReaders.get(sessionId) === read) this.idleReaders.delete(sessionId);
    };
  }
  /**
   * Read live or persisted status without loading a Session or scheduling work.
   * @param sessionId - session whose state is requested.
   * @returns the live status, or an inactive default.
   */
  idleStatus(sessionId) {
    const policy = this.snapshot();
    if (!policy.enabled || !policy.idleEnabled) return { status: "off", dueAt: null, message: "\u95F2\u7F6E\u81EA\u52A8\u538B\u7F29\u5DF2\u5173\u95ED" };
    const live = this.idleReaders.get(sessionId)?.();
    if (live) return live;
    const saved = this.idleStore.get(sessionId);
    return saved ? this.savedIdleStatus(saved) : { status: "waiting", dueAt: null, reasonCode: "no_plan", message: "\u5C1A\u65E0\u53EF\u6062\u590D\u8BA1\u5212\uFF1B\u4E0B\u6B21\u4EFB\u52A1\u6B63\u5E38\u5B8C\u6210\u540E\u5F00\u59CB\u8BA1\u65F6" };
  }
};
export {
  ContextManager as default
};
