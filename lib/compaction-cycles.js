// src/compaction-cycles.ts
import { createHash } from "crypto";
import { z } from "zod";
import { defineDomain, domainTable } from "@deepseek-ai/dsh-storage-domain";
var count = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
var positive = count.min(1);
var identifier = z.string().min(1).max(256);
var hash = z.string().regex(/^[a-f0-9]{64}$/);
var purpose = z.enum(["summary", "repair", "recovery"]);
var inputSchema = z.object({
  sessionId: identifier,
  requestHash: hash,
  sourceWatermark: count,
  freshTokens: count,
  minNewTokens: positive,
  purpose
}).strict();
var claimSchema = inputSchema.extend({ cycle: positive, ordinal: positive.max(4), claimedAt: count });
var CompactionCycleError = class extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
    this.name = "CompactionCycleError";
  }
};
var compactionCyclesSpec = defineDomain({
  name: "context_manager_cycles",
  version: 1,
  tables: { claims: domainTable(claimSchema) }
});
function keyOf(sessionId, requestHash) {
  return createHash("sha256").update(JSON.stringify([sessionId, requestHash])).digest("hex");
}
function invalid() {
  throw new CompactionCycleError("invalid_state", "\u538B\u7F29\u8C03\u7528\u5468\u671F\u8BB0\u5F55\u4E0D\u4E00\u81F4\uFF1B\u4FDD\u7559\u8BB0\u5F55\u5E76\u505C\u6B62\u81EA\u52A8\u6458\u8981");
}
function advance(previous, row) {
  const newCycle = previous === void 0 || row.cycle !== previous.cycle;
  if (newCycle) {
    if (row.cycle !== (previous?.cycle ?? 0) + 1 || row.ordinal !== 1 || row.purpose !== "summary") invalid();
    if (previous && (row.sourceWatermark <= previous.sourceWatermark || row.freshTokens < row.minNewTokens)) invalid();
  } else if (row.sourceWatermark !== previous.sourceWatermark || row.ordinal !== previous.calls + 1) invalid();
  const summaryCalls = (newCycle ? 0 : previous.summaryCalls) + (row.purpose === "summary" ? 1 : 0);
  if (summaryCalls > 2) invalid();
  return Object.freeze({
    sessionId: row.sessionId,
    cycle: row.cycle,
    sourceWatermark: row.sourceWatermark,
    summaryCalls,
    calls: row.ordinal,
    requestHashes: Object.freeze([...newCycle ? [] : previous.requestHashes, row.requestHash]),
    startedAt: newCycle ? row.claimedAt : previous.startedAt,
    updatedAt: row.claimedAt
  });
}
var CompactionCycles = class _CompactionCycles {
  constructor(domain) {
    this.domain = domain;
    this.table = domain.table("claims");
    const records = [...this.table.entries()].map(([key, value]) => {
      const row = claimSchema.parse(value);
      if (key !== keyOf(row.sessionId, row.requestHash)) invalid();
      return row;
    }).sort((a, b) => a.cycle - b.cycle || a.ordinal - b.ordinal);
    for (const row of records) this.sessions.set(row.sessionId, advance(this.sessions.get(row.sessionId), row));
  }
  table;
  sessions = /* @__PURE__ */ new Map();
  chain = Promise.resolve();
  closing = false;
  disposal;
  static async open(facility) {
    const domain = await facility.open(compactionCyclesSpec);
    try {
      return new _CompactionCycles(domain);
    } catch (error) {
      await domain.close();
      throw error;
    }
  }
  /** The last persisted cycle. No model request or background work is resumed. */
  peek(sessionId) {
    return this.sessions.get(identifier.parse(sessionId));
  }
  /** Legacy permits remain immutable; new operations account them exactly once. */
  records(sessionId) {
    return [...this.table.entries()].map(([, row]) => row).filter((row) => row.sessionId === sessionId).map((row) => Object.freeze({ ...row })).sort((a, b) => a.cycle - b.cycle || a.ordinal - b.ordinal);
  }
  /** Await this permit immediately before the actual model call; unknown outcomes remain consumed. */
  async claim(value) {
    const input = inputSchema.parse(value);
    return this.enqueue(async () => {
      const key = keyOf(input.sessionId, input.requestHash);
      if (this.table.get(key)) throw new CompactionCycleError("duplicate_request", "\u76F8\u540C\u6458\u8981\u8BF7\u6C42\u5DF2\u6709\u8C03\u7528\u8BB0\u5F55\uFF0C\u4E0D\u81EA\u52A8\u518D\u6B21\u6536\u8D39");
      const previous = this.sessions.get(input.sessionId);
      if (!previous && input.purpose !== "summary") throw new CompactionCycleError("no_cycle", "\u4FEE\u590D\u6216\u534F\u8BAE\u6062\u590D\u4E0D\u80FD\u5355\u72EC\u5F00\u542F\u538B\u7F29\u5468\u671F");
      if (previous && input.sourceWatermark < previous.sourceWatermark) {
        throw new CompactionCycleError("stale_source", "\u538B\u7F29\u6765\u6E90\u65E9\u4E8E\u5F53\u524D\u5468\u671F\uFF0C\u4E0D\u81EA\u52A8\u91CD\u53D1\u65E7\u8BF7\u6C42");
      }
      const newCycle = previous === void 0 || input.purpose === "summary" && input.sourceWatermark > previous.sourceWatermark && input.freshTokens >= input.minNewTokens;
      if (!newCycle && previous) {
        if (previous.calls >= 4) throw new CompactionCycleError("call_limit", "\u672C\u6279\u5386\u53F2\u5DF2\u8FBE\u5230 4 \u6B21\u6458\u8981\u3001\u4FEE\u590D\u6216\u6062\u590D\u8C03\u7528\u4E0A\u9650");
        if (input.purpose === "summary" && previous.summaryCalls >= 2) {
          throw new CompactionCycleError("summary_limit", "\u672C\u6279\u5386\u53F2\u5DF2\u8FBE\u5230 2 \u4E2A\u4E3B\u6458\u8981\u8BA1\u5212\u4E0A\u9650");
        }
      }
      const row = claimSchema.parse({
        ...input,
        cycle: newCycle ? (previous?.cycle ?? 0) + 1 : previous.cycle,
        ordinal: newCycle ? 1 : previous.calls + 1,
        sourceWatermark: newCycle ? input.sourceWatermark : previous.sourceWatermark,
        claimedAt: Date.now()
      });
      const next = advance(previous, row);
      await this.table.put(key, row);
      this.sessions.set(input.sessionId, next);
    });
  }
  /** Reject new claims immediately, then drain already accepted writes and close once. */
  close() {
    if (!this.disposal) {
      this.closing = true;
      this.disposal = this.chain.then(() => this.domain.close());
    }
    return this.disposal;
  }
  enqueue(job) {
    if (this.closing) return Promise.reject(new CompactionCycleError("closed", "\u538B\u7F29\u5468\u671F\u8BB0\u5F55\u6B63\u5728\u5173\u95ED\uFF0C\u672A\u9886\u53D6\u65B0\u8C03\u7528"));
    const pending = this.chain.then(job);
    this.chain = pending.then(() => {
    }, () => {
    });
    return pending;
  }
};
export {
  CompactionCycleError,
  CompactionCycles,
  compactionCyclesSpec
};
