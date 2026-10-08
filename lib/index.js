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
  summaryInstructions: "",
  formatRepairEnabled: true,
  formatRepairMaxTokens: 2048,
  absoluteEnabled: false,
  absoluteTriggerTokens: 2e5,
  absoluteTargetTokens: 1e5
};
function validatePolicy(p) {
  if (typeof p.enabled !== "boolean") throw new Error("\u81EA\u52A8\u538B\u7F29\u5F00\u5173\u5FC5\u987B\u662F\u5E03\u5C14\u503C");
  if (typeof p.idleEnabled !== "boolean") throw new Error("\u95F2\u7F6E\u81EA\u52A8\u538B\u7F29\u5F00\u5173\u5FC5\u987B\u662F\u5E03\u5C14\u503C");
  if (typeof p.formatRepairEnabled !== "boolean") throw new Error("\u6458\u8981\u683C\u5F0F\u4FEE\u590D\u5F00\u5173\u5FC5\u987B\u662F\u5E03\u5C14\u503C");
  if (typeof p.absoluteEnabled !== "boolean") throw new Error("\u7EDD\u5BF9\u5DE5\u4F5C\u5386\u53F2\u8F6F\u9884\u7B97\u5F00\u5173\u5FC5\u987B\u662F\u5E03\u5C14\u503C");
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
    idleMinPercent: [10, 95],
    formatRepairMaxTokens: [256, 8192],
    absoluteTriggerTokens: [1e4, 1e9],
    absoluteTargetTokens: [1e3, 1e9]
  };
  for (const [key, [min, max]] of Object.entries(ranges)) {
    const value = p[key];
    if (!Number.isFinite(value) || value < min || value > max) throw new Error(`${key} \u5FC5\u987B\u5728 ${min}\u2013${max} \u4E4B\u95F4`);
  }
  if (p.targetPercent > p.triggerPercent - p.earlyPercent - 10) throw new Error("\u538B\u7F29\u76EE\u6807\u987B\u6BD4\u5B9E\u9645\u68C0\u67E5\u9608\u503C\u81F3\u5C11\u4F4E 10 \u4E2A\u767E\u5206\u70B9");
  if (p.absoluteEnabled && p.absoluteTargetTokens > Math.floor(p.absoluteTriggerTokens * 0.8)) throw new Error("\u7EDD\u5BF9\u8F6F\u76EE\u6807\u987B\u6BD4\u7EDD\u5BF9\u8F6F\u89E6\u53D1\u81F3\u5C11\u4F4E 20%");
  for (const key of ["summaryMaxTokens", "maxPasses", "timeoutMs", "idleMinutes", "formatRepairMaxTokens", "absoluteTriggerTokens", "absoluteTargetTokens"]) {
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
  constructor(domain, journal) {
    this.domain = domain;
    this.journal = journal;
    this.table = domain.table("sessions");
    for (const [key, record2] of this.table.entries()) this.rows.set(key, record2);
  }
  table;
  chain = Promise.resolve();
  closing = false;
  disposal;
  rows = /* @__PURE__ */ new Map();
  /** Open once on the Manager; preset engines share the returned instance. */
  static async open(facility, journal) {
    const domain = await facility.open(idleDomainSpec);
    try {
      await journal?.replay(idleDomainSpec.name, domain.table("sessions"), (key, value) => {
        const row = recordSchema.parse(value);
        if (row.sessionId !== key) throw new Error("Idle journal session key mismatch");
        return row;
      });
      return new _IdleStore(domain, journal);
    } catch (error) {
      await domain.close();
      throw error;
    }
  }
  /** Read only the latest persisted record, without exposing mutable domain state. */
  get(sessionId) {
    const record2 = this.rows.get(sessionId);
    if (!record2) return void 0;
    if (record2.sessionId !== sessionId) throw new Error("idle record session key mismatch");
    return Object.freeze({ ...record2 });
  }
  /** Snapshot only this ledger's registered metadata, without loading sessions. */
  all() {
    return Object.freeze(Array.from(this.rows, ([key, record2]) => {
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
    const { attemptId, compactionId, beforeTokens, afterTokens, reasonCode, ...required } = recordSchema.parse(value);
    const record2 = Object.freeze({
      ...required,
      ...attemptId === void 0 ? {} : { attemptId },
      ...compactionId === void 0 ? {} : { compactionId },
      ...beforeTokens === void 0 ? {} : { beforeTokens },
      ...afterTokens === void 0 ? {} : { afterTokens },
      ...reasonCode === void 0 ? {} : { reasonCode }
    });
    const acknowledge = this.journal?.record(idleDomainSpec.name, record2.sessionId, this.rows.get(record2.sessionId), record2);
    if (this.journal) this.rows.set(record2.sessionId, record2);
    await this.table.put(record2.sessionId, record2);
    this.rows.set(record2.sessionId, record2);
    acknowledge?.();
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
  cacheRead: count2.nullable(),
  cacheWrite: count2.nullable()
}).strict();
var record = z3.object({ sessionId: z3.string(), since: count2, archived: totals, recent: z3.array(attempt).max(128) }).strict();
var spec = defineDomain2({ name: "context_manager_summaries", version: 1, tables: { sessions: domainTable2(record) } });
var zero = () => ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, attempts: 0, unknownAttempts: 0 });
var finite = (n) => typeof n === "number" && Number.isSafeInteger(n) && n >= 0;
function mergeUsage(row, usage) {
  const cacheRead = row.cacheRead ?? (finite(usage?.cacheReadTokens) ? usage.cacheReadTokens : null);
  const cacheWrite = row.cacheWrite ?? (finite(usage?.cacheWriteTokens) ? usage.cacheWriteTokens : null);
  const incomingInput = finite(usage?.inputTokens) ? usage.inputTokens + (cacheRead ?? 0) + (cacheWrite ?? 0) : null;
  const incomingOutput = finite(usage?.outputTokens) ? usage.outputTokens : null;
  let input = row.input ?? incomingInput;
  if (row.input !== null && input !== null) {
    if (row.cacheRead === null && cacheRead !== null) input += cacheRead;
    if (row.cacheWrite === null && cacheWrite !== null) input += cacheWrite;
  }
  return { input, output: row.output ?? incomingOutput, cacheRead, cacheWrite };
}
function add(total, row) {
  return {
    input: total.input + (row.input ?? 0),
    output: total.output + (row.output ?? 0),
    cacheRead: total.cacheRead + (row.cacheRead ?? 0),
    cacheWrite: total.cacheWrite + (row.cacheWrite ?? 0),
    attempts: total.attempts + 1,
    unknownAttempts: total.unknownAttempts + (row.input === null || row.output === null ? 1 : 0)
  };
}
var SummaryLedger = class _SummaryLedger {
  constructor(domain, journal) {
    this.domain = domain;
    this.journal = journal;
    this.table = domain.table("sessions");
    for (const [key, row] of this.table.entries()) {
      this.rows.set(key, row);
      for (const item of row.recent) this.usageClosed.add(item.id);
    }
  }
  chain = Promise.resolve();
  closed = false;
  table;
  /**
   * Read overlay updated synchronously at merge time. The domain table only
   * reflects a value after its backend write completes, so without the
   * overlay a delivered late usage could stay invisible to {@link stats}
   * until the persistence lag passes. Durable writes stay ordered by
   * {@link chain}; per-field merges commute, so call-time application is safe.
   */
  overlay = /* @__PURE__ */ new Map();
  /** Stable metadata remains readable after an old Host closes its domain. */
  rows = /* @__PURE__ */ new Map();
  usageOwners = /* @__PURE__ */ new Map();
  usageClosed = /* @__PURE__ */ new Set();
  /** Pin this attempt while its logical call or bounded physical drain owns it. */
  retainUsage(id) {
    this.usageClosed.delete(id);
    this.usageOwners.set(id, (this.usageOwners.get(id) ?? 0) + 1);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const remaining = (this.usageOwners.get(id) ?? 1) - 1;
      if (remaining) this.usageOwners.set(id, remaining);
      else {
        this.usageOwners.delete(id);
        this.usageClosed.add(id);
      }
    };
  }
  static async open(facility, journal) {
    const domain = await facility.open(spec);
    try {
      await journal?.replay(spec.name, domain.table("sessions"), (key, value) => {
        const row = record.parse(value);
        if (row.sessionId !== key) throw new Error("Summary journal session key mismatch");
        return row;
      });
      return new _SummaryLedger(domain, journal);
    } catch (error) {
      await domain.close();
      throw error;
    }
  }
  enqueue(work) {
    if (this.closed) return Promise.reject(new Error("Summary ledger closed"));
    const operation = this.chain.then(work);
    this.chain = operation.catch(() => {
    });
    return operation;
  }
  read(sessionId) {
    if (this.overlay.has(sessionId)) return this.overlay.get(sessionId);
    try {
      const row = this.table.get(sessionId);
      if (row) this.rows.set(sessionId, row);
      else this.rows.delete(sessionId);
      return row;
    } catch (error) {
      if (!(error instanceof Error) || !("code" in error) || error.code !== "closed") throw error;
    }
    return this.rows.get(sessionId);
  }
  /** Apply one merged row to the read overlay, then enqueue its durable write. */
  commit(sessionId, row) {
    if (this.closed) return Promise.reject(new Error("Summary ledger closed"));
    const acknowledge = this.journal?.record(spec.name, sessionId, this.read(sessionId), row);
    this.rows.set(sessionId, row);
    this.overlay.set(sessionId, row);
    return this.enqueue(async () => {
      await this.table.put(sessionId, row);
      acknowledge?.();
      if (this.overlay.get(sessionId) === row) this.overlay.delete(sessionId);
    });
  }
  async start(sessionId, compactionId, trigger) {
    const old = this.read(sessionId);
    const next = old ? { ...old, recent: [...old.recent], archived: { ...old.archived } } : { sessionId, since: Date.now(), recent: [], archived: zero() };
    if (next.recent.length === 128) {
      const archived = next.recent.findIndex((item) => !this.usageOwners.has(item.id) && (this.usageClosed.has(item.id) || item.status !== "started" && item.input !== null && item.output !== null && item.cacheRead !== null && item.cacheWrite !== null));
      if (archived < 0) throw new Error("Too many unsettled summary attempts");
      const removed = next.recent.splice(archived, 1)[0];
      next.archived = add(next.archived, removed);
      this.usageClosed.delete(removed.id);
    }
    const id = randomUUID();
    next.recent.push({ id, compactionId, trigger, startedAt: Date.now(), status: "started", input: null, output: null, cacheRead: null, cacheWrite: null });
    await this.commit(sessionId, next);
    return id;
  }
  async finish(sessionId, id, status, usage) {
    const old = this.read(sessionId);
    const index = old?.recent.findIndex((item2) => item2.id === id) ?? -1;
    if (!old || index < 0) return;
    const item = old.recent[index];
    const merged = mergeUsage(item, usage);
    if (item.status !== "started" && merged.input === item.input && merged.output === item.output && merged.cacheRead === item.cacheRead && merged.cacheWrite === item.cacheWrite) {
      if (this.overlay.has(sessionId)) await this.commit(sessionId, old);
      return;
    }
    const recent = [...old.recent];
    recent[index] = { ...item, ...merged, ...item.status === "started" ? { status, endedAt: Date.now() } : {} };
    await this.commit(sessionId, { ...old, recent });
  }
  /**
   * Idempotently record usage that arrived after a cancelled attempt was
   * settled. Each field is filled at most once from the first notification
   * that provides it; later notifications only fill still-unknown fields, the
   * attempt status stays untouched, and genuinely absent usage stays unknown.
   * @param sessionId - owning session of the settled attempt.
   * @param id - exact attempt id from {@link start}.
   * @param usage - late provider usage totals snapshot; partial usage records only the known fields.
   */
  async recordUsage(sessionId, id, usage) {
    const old = this.read(sessionId);
    const index = old?.recent.findIndex((item) => item.id === id) ?? -1;
    if (!old || index < 0) return;
    const row = old.recent[index];
    const merged = mergeUsage(row, usage);
    if (merged.input === row.input && merged.output === row.output && merged.cacheRead === row.cacheRead && merged.cacheWrite === row.cacheWrite) {
      if (this.overlay.has(sessionId)) await this.commit(sessionId, old);
      return;
    }
    const recent = [...old.recent];
    recent[index] = { ...row, ...merged };
    await this.commit(sessionId, { ...old, recent });
  }
  stats(sessionId) {
    const row = this.read(sessionId);
    if (!row) return;
    return { ...row.recent.reduce(add, { ...row.archived }), since: row.since, recent: row.recent.slice(-32).map((item) => ({ ...item })) };
  }
  async close() {
    this.closed = true;
    await this.chain;
    try {
      for (const [sessionId, row] of this.overlay) {
        await this.table.put(sessionId, row);
        this.journal?.record(spec.name, sessionId, row, row)();
        this.overlay.delete(sessionId);
      }
    } finally {
      await this.domain.close();
    }
  }
};

// src/index.ts
import { join as join2, isAbsolute as isAbsolute2 } from "path";

// src/recovery-journal.ts
import fs from "fs";
import { createHash, randomUUID as randomUUID2 } from "crypto";
import { hostname } from "os";
import { basename, dirname, isAbsolute, join, resolve } from "path";
var DOMAINS = /* @__PURE__ */ new Set(["context_manager_idle", "context_manager_summaries"]);
var MAX_BYTES = 8 * 1024 * 1024;
var MAX_ROW_BYTES = 256 * 1024;
var MAX_ENTRIES = 1024;
var MAX_CHAIN = 1024;
var SHA = /^[a-f0-9]{64}$/u;
var UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/u;
function fail(message) {
  throw new Error(`Context recovery journal: ${message}`);
}
function object(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function keys(value, allowed) {
  if (Object.keys(value).some((key) => !allowed.includes(key))) fail("unknown metadata field");
}
function exactKeys(value, expected) {
  keys(value, expected);
  if (expected.some((key) => !Object.hasOwn(value, key))) fail("missing metadata field");
}
function domainKey(domain, key) {
  if (!DOMAINS.has(domain) || typeof key !== "string" || !key.length || key.length > 256) fail("invalid domain or record key");
  return JSON.stringify([domain, key]);
}
function canonical(value, depth = 0) {
  if (depth > 12) fail("metadata nesting exceeds limit");
  if (value === null || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value)) fail("metadata number must be a safe integer");
    return JSON.stringify(value);
  }
  if (typeof value === "string") {
    if (value.length > 1024) fail("metadata string exceeds limit");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    if (value.length > 1024 || Object.keys(value).length !== value.length) fail("invalid metadata array");
    return "[" + value.map((item) => canonical(item, depth + 1)).join(",") + "]";
  }
  if (!object(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) fail("metadata must be plain JSON");
  if (Reflect.ownKeys(value).length !== Object.keys(value).length) fail("non-JSON metadata properties");
  return "{" + Object.keys(value).sort().map((key) => JSON.stringify(key) + ":" + canonical(value[key], depth + 1)).join(",") + "}";
}
function hash(value) {
  return createHash("sha256").update(value === void 0 ? "missing" : "json:" + canonical(value)).digest("hex");
}
function metadata(domain, key, value) {
  if (!object(value) || value.sessionId !== key) fail("metadata session does not match key");
  if (domain === "context_manager_idle") {
    keys(value, [
      "sessionId",
      "turnEndSeq",
      "completedAt",
      "fingerprint",
      "status",
      "updatedAt",
      "attemptId",
      "compactionId",
      "beforeTokens",
      "afterTokens",
      "reasonCode"
    ]);
  } else {
    keys(value, ["sessionId", "since", "archived", "recent"]);
    if (!object(value.archived) || !Array.isArray(value.recent) || value.recent.length > 128) fail("invalid summary metadata");
    exactKeys(value.archived, ["input", "output", "cacheRead", "cacheWrite", "attempts", "unknownAttempts"]);
    for (const item of value.recent) {
      if (!object(item)) fail("invalid attempt metadata");
      keys(item, ["id", "compactionId", "trigger", "startedAt", "endedAt", "status", "input", "output", "cacheRead", "cacheWrite"]);
    }
  }
  const text = canonical(value);
  if (Buffer.byteLength(text) > MAX_ROW_BYTES) fail("metadata record exceeds limit");
  return JSON.parse(text);
}
function readRegular(path, limit) {
  const stat = fs.lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > limit) fail("invalid or oversized journal file");
  const fd = fs.openSync(path, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    const held = fs.fstatSync(fd);
    if (!held.isFile() || held.dev !== stat.dev || held.ino !== stat.ino || held.size > limit) fail("journal file changed while opening");
    const text = fs.readFileSync(fd, "utf8");
    if (Buffer.byteLength(text) > limit) fail("journal file exceeds limit");
    return text;
  } finally {
    fs.closeSync(fd);
  }
}
function syncDirectory(root) {
  const fd = fs.openSync(root, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY);
  try {
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}
function ownerFrom(text) {
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    fail("unreadable lock; ownership cannot be established");
  }
  if (!object(data)) fail("invalid lock");
  exactKeys(data, ["schema", "pid", "host", "token"]);
  if (data.schema !== 1 || !Number.isSafeInteger(data.pid) || data.pid <= 0 || typeof data.host !== "string" || typeof data.token !== "string" || !UUID.test(data.token)) fail("invalid lock owner");
  return data;
}
function writeExclusive(path, value) {
  const fd = fs.openSync(path, fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY | fs.constants.O_NOFOLLOW, 384);
  const identity = fs.fstatSync(fd);
  try {
    fs.writeFileSync(fd, JSON.stringify(value) + "\n");
    fs.fsyncSync(fd);
  } catch (error) {
    const current = fs.lstatSync(path, { throwIfNoEntry: false });
    if (current?.dev === identity.dev && current.ino === identity.ino) fs.unlinkSync(path);
    throw error;
  } finally {
    fs.closeSync(fd);
  }
}
function dead(owner) {
  if (owner.host !== hostname()) fail("lock belongs to another host; ownership cannot be established");
  try {
    process.kill(owner.pid, 0);
    return false;
  } catch (error) {
    if (error.code === "ESRCH") return true;
    fail("lock process state cannot be established");
  }
}
function acquire(root, owner) {
  const path = join(root, "lock.json");
  try {
    writeExclusive(path, owner);
    syncDirectory(root);
    return;
  } catch (error) {
    if (error.code !== "EEXIST") throw error;
  }
  const original = readRegular(path, 4096), previous = ownerFrom(original);
  if (!dead(previous)) fail("journal is locked by a live process");
  const claim = join(root, `reclaim-${previous.token}.json`);
  try {
    writeExclusive(claim, owner);
  } catch (error) {
    if (error.code === "EEXIST") fail("stale lock recovery is already claimed; ownership cannot be established");
    throw error;
  }
  syncDirectory(root);
  try {
    if (readRegular(path, 4096) !== original) fail("lock changed during recovery");
    fs.unlinkSync(path);
    writeExclusive(path, owner);
    syncDirectory(root);
  } finally {
    let replaced = false;
    try {
      replaced = ownerFrom(readRegular(path, 4096)).token !== previous.token;
    } catch {
    }
    if (replaced) {
      fs.unlinkSync(claim);
      syncDirectory(root);
    }
  }
}
var RecoveryJournal = class _RecoveryJournal {
  constructor(root, owner) {
    this.root = root;
    this.owner = owner;
    this.directory = fs.lstatSync(root);
  }
  entries = /* @__PURE__ */ new Map();
  closed = false;
  poisoned = false;
  replaying = false;
  directory;
  /** Synchronous exclusive ownership; failed/unknown ownership never authorizes replay or model calls. */
  static open(root) {
    if (!isAbsolute(root)) fail("root must be absolute");
    const target = resolve(root);
    const parent = fs.realpathSync(dirname(target)), directory = join(parent, basename(target));
    try {
      fs.mkdirSync(directory, { mode: 448 });
      syncDirectory(parent);
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
    }
    const stat = fs.lstatSync(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink()) fail("root must be a real directory");
    fs.chmodSync(directory, 448);
    const owner = { schema: 1, pid: process.pid, host: hostname(), token: randomUUID2() };
    try {
      acquire(directory, owner);
    } catch (error) {
      try {
        if (ownerFrom(readRegular(join(directory, "lock.json"), 4096)).token === owner.token) {
          fs.unlinkSync(join(directory, "lock.json"));
          syncDirectory(directory);
        }
      } catch {
      }
      throw error;
    }
    const journal = new _RecoveryJournal(directory, owner);
    try {
      const path = join(directory, "pending.json");
      let raw;
      try {
        raw = readRegular(path, MAX_BYTES);
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
        journal.persist(/* @__PURE__ */ new Map());
        return journal;
      }
      let value;
      try {
        value = JSON.parse(raw);
      } catch {
        fail("pending state is not valid JSON");
      }
      if (!object(value)) fail("invalid pending state");
      exactKeys(value, ["schema", "entries"]);
      if (value.schema !== 1 || !Array.isArray(value.entries) || value.entries.length > MAX_ENTRIES) fail("unsupported pending schema or capacity");
      for (const item of value.entries) {
        if (!object(item)) fail("invalid pending entry");
        exactKeys(item, ["domain", "key", "generation", "before", "next"]);
        if (typeof item.domain !== "string" || typeof item.key !== "string") fail("invalid pending identity");
        const id = domainKey(item.domain, item.key);
        if (journal.entries.has(id) || typeof item.generation !== "string" || !UUID.test(item.generation) || !Array.isArray(item.before) || !item.before.length || item.before.length > MAX_CHAIN || item.before.some((h) => typeof h !== "string" || !SHA.test(h)) || new Set(item.before).size !== item.before.length) fail("invalid pending chain");
        journal.entries.set(id, {
          domain: item.domain,
          key: item.key,
          generation: item.generation,
          before: item.before,
          next: metadata(item.domain, item.key, item.next)
        });
      }
      fs.chmodSync(path, 384);
      return journal;
    } catch (error) {
      journal.close();
      throw error;
    }
  }
  assertOwner() {
    if (this.closed) fail("journal is closed");
    const directory = fs.lstatSync(this.root);
    if (!directory.isDirectory() || directory.isSymbolicLink() || directory.dev !== this.directory.dev || directory.ino !== this.directory.ino) fail("journal directory changed");
    if (ownerFrom(readRegular(join(this.root, "lock.json"), 4096)).token !== this.owner.token) fail("journal ownership changed");
  }
  writable() {
    this.assertOwner();
    if (this.poisoned) fail("durability is uncertain; close and reopen before further writes");
  }
  persist(next) {
    this.writable();
    const text = JSON.stringify({ schema: 1, entries: [...next.values()] }) + "\n";
    if (next.size > MAX_ENTRIES || Buffer.byteLength(text) > MAX_BYTES) fail("pending journal exceeds capacity");
    const temporary = join(this.root, `.pending-${this.owner.token}-${randomUUID2()}.tmp`);
    let renamed = false;
    try {
      const fd = fs.openSync(temporary, fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY | fs.constants.O_NOFOLLOW, 384);
      try {
        fs.writeFileSync(fd, text);
        fs.fsyncSync(fd);
      } finally {
        fs.closeSync(fd);
      }
      fs.renameSync(temporary, join(this.root, "pending.json"));
      renamed = true;
      syncDirectory(this.root);
      this.entries = next;
    } catch (error) {
      if (renamed) this.poisoned = true;
      throw error;
    } finally {
      if (!renamed) {
        try {
          fs.unlinkSync(temporary);
        } catch (error) {
          if (error.code !== "ENOENT") throw error;
        }
      }
    }
  }
  acknowledge(id, generation) {
    this.writable();
    if (this.entries.get(id)?.generation !== generation) return;
    const next = new Map(this.entries);
    next.delete(id);
    this.persist(next);
  }
  /** Write-ahead before the corresponding Host put; acknowledge only after that put succeeds. */
  record(domain, key, previous, next) {
    this.writable();
    if (this.replaying) fail("replay is in progress");
    const id = domainKey(domain, key), value = metadata(domain, key, next);
    if (previous !== void 0) metadata(domain, key, previous);
    const beforeHash = hash(previous), nextHash = hash(value), current = this.entries.get(id);
    if (current && nextHash === hash(current.next)) {
      if (beforeHash !== nextHash && !current.before.includes(beforeHash)) fail("record does not connect to pending history");
      return () => this.acknowledge(id, current.generation);
    }
    if (current && beforeHash !== hash(current.next)) fail("record would overwrite a newer pending state");
    const before = [.../* @__PURE__ */ new Set([...current?.before ?? [], beforeHash])];
    if (before.length > MAX_CHAIN) fail("pending history exceeds capacity");
    const generation = randomUUID2(), entries = new Map(this.entries);
    entries.set(id, { domain, key, generation, before, next: value });
    this.persist(entries);
    return () => this.acknowledge(id, generation);
  }
  /** Recover metadata only. Conflicting live rows are preserved and stop recovery. */
  async replay(domain, table, validate) {
    this.writable();
    if (!DOMAINS.has(domain) || this.replaying) fail("invalid or concurrent replay");
    this.replaying = true;
    try {
      const entries = [...this.entries.values()].filter((entry) => entry.domain === domain);
      const inspect = (entry) => {
        const validated = validate(entry.key, structuredClone(entry.next));
        if (hash(metadata(domain, entry.key, validated)) !== hash(entry.next)) fail("validation changed pending metadata");
        const current = table.get(entry.key);
        if (current !== void 0) {
          const checked = validate(entry.key, current);
          if (hash(metadata(domain, entry.key, checked)) !== hash(current)) fail("validation changed current metadata");
        }
        const actual = hash(current), latest = hash(entry.next);
        if (actual !== latest && !entry.before.includes(actual)) fail("current record conflicts with pending history");
        return { same: actual === latest, value: validated };
      };
      for (const entry of entries) inspect(entry);
      for (const entry of entries) {
        this.writable();
        const { same, value } = inspect(entry);
        if (!same) await table.put(entry.key, value);
        this.writable();
        if (hash(table.get(entry.key)) !== hash(entry.next)) fail("replayed record did not become current");
        this.acknowledge(domainKey(domain, entry.key), entry.generation);
      }
    } finally {
      this.replaying = false;
    }
  }
  /** Release only our lock. Pending metadata survives normal shutdown and restart. */
  close() {
    if (this.closed) return;
    if (this.replaying) fail("cannot close during replay");
    this.assertOwner();
    fs.unlinkSync(join(this.root, "lock.json"));
    this.closed = true;
    syncDirectory(this.root);
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
  supportsSafeShutdown = false;
  idleActive = false;
  idleReaders = /* @__PURE__ */ new Map();
  compactReaders = /* @__PURE__ */ new Map();
  drains = /* @__PURE__ */ new Set();
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
      summaryInstructions: z4.string().max(2e3).default(defaults.summaryInstructions),
      formatRepairEnabled: z4.boolean().default(defaults.formatRepairEnabled),
      formatRepairMaxTokens: z4.number().min(256).max(8192).step(1).default(defaults.formatRepairMaxTokens),
      absoluteEnabled: z4.boolean().default(defaults.absoluteEnabled),
      absoluteTriggerTokens: z4.number().min(1e4).max(1e9).step(1).default(defaults.absoluteTriggerTokens),
      absoluteTargetTokens: z4.number().min(1e3).max(1e9).step(1).default(defaults.absoluteTargetTokens)
    }).default(defaults).volatile()
  });
  async [Service.init]() {
    const profile = this.ctx.get("profileContext");
    const journal = profile && isAbsolute2(profile.dir) ? RecoveryJournal.open(join2(profile.dir, ".context-manager-recovery")) : void 0;
    try {
      this.idleStore = await IdleStore.open(this.ctx.storageDomain, journal);
      this.summaryLedger = await SummaryLedger.open(this.ctx.storageDomain, journal);
    } catch (error) {
      try {
        await this.idleStore?.close();
      } finally {
        journal?.close();
      }
      throw error;
    }
    let closing;
    const close = () => closing ??= (async () => {
      const outcomes = await Promise.allSettled([...this.drains].map((drain) => drain()));
      try {
        try {
          await this.summaryLedger.close();
        } finally {
          await this.idleStore.close();
        }
      } finally {
        journal?.close();
      }
      const errors = outcomes.filter((result) => result.status === "rejected");
      if (errors.length) throw new AggregateError(errors.map((result) => result.reason), "\u4E0A\u4E0B\u6587\u538B\u7F29\u6536\u5C3E\u672A\u5B8C\u6210");
    })();
    const releases = [];
    const facility = this.ctx.storageDomain;
    if (typeof facility.registerDrain === "function") {
      try {
        releases.push(facility.registerDrain("context_manager_summaries", close));
        releases.push(facility.registerDrain("context_manager_idle", close));
        this.supportsSafeShutdown = true;
      } catch (error) {
        this.ctx.logger.warn("\u5BBF\u4E3B\u5B58\u50A8\u6392\u7A7A\u4E0D\u53EF\u7528\uFF0C\u4F7F\u7528\u63D2\u4EF6\u6062\u590D\u65E5\u5FD7\uFF1A%s", error);
      }
    }
    this.supportsSafeShutdown ||= journal !== void 0;
    this.ctx.effect(() => async () => {
      try {
        await close();
      } finally {
        for (const release of releases) await release();
      }
    });
  }
  registerDrain(drain) {
    this.drains.add(drain);
    return () => {
      this.drains.delete(drain);
    };
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
      host_capability_missing: "\u5F53\u524D\u73AF\u5883\u65E0\u6CD5\u4FDD\u8BC1\u538B\u7F29\u7528\u91CF\u843D\u76D8\uFF0C\u8BF7\u68C0\u67E5\u63D2\u4EF6\u6570\u636E\u76EE\u5F55\uFF1B\u4EFB\u52A1\u539F\u6587\u4FDD\u7559",
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
   * Register a live in-flight compaction phase reader (request or idle path).
   * @param sessionId - owning session, without loading it.
   * @param read - current compacting phase, or undefined when not compacting.
   * @returns an identity-guarded release function.
   */
  registerCompact(sessionId, read) {
    this.compactReaders.set(sessionId, read);
    return () => {
      if (this.compactReaders.get(sessionId) === read) this.compactReaders.delete(sessionId);
    };
  }
  /**
   * Read live or persisted status without loading a Session or scheduling work.
   * An in-flight compaction phase wins over the idle reader so the page shows
   * summarizing/repairing before any durable record exists.
   * @param sessionId - session whose state is requested.
   * @returns the live status, or an inactive default.
   */
  idleStatus(sessionId) {
    const compact = this.compactReaders.get(sessionId)?.();
    if (compact) return { status: "compacting", dueAt: null, message: compact.message, compactionPhase: compact.phase };
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
