// src/tool-results.ts
import { estimateContent } from "@deepseek-ai/dsh-token-meter/estimate";

// src/archive.ts
import fs from "fs";
import { createHash } from "crypto";
var DEFAULT_MAX_TOTAL_BYTES = 512 * 1024 * 1024;
var MAX_MANIFEST_BYTES = 64 * 1024 * 1024;
var MAX_ROW_BYTES = 16 * 1024;
var NO_FOLLOW = fs.constants.O_NOFOLLOW ?? 0;
function hashText(text) {
  return createHash("sha256").update(Buffer.from(text, "utf8")).digest("hex");
}

// src/reducer.ts
var RULE_ID = "collapse-identical-lines";
var RULE_VERSION = 1;
var MIN_RUN = 3;
var MIN_LINE_CHARS = 4;
var PROTECTED_LINE = /(?:exit\s*code|exit\s*status|exitcode|\[stopped|\[timed out|\[killed|\[stderr\]|returned\s+(?:exit\s+)?\d|\bsignals?\b|segmentation fault|core dumped|\bpass(?:ed|ing|es)?\b|\bfail(?:ed|ing|ure|ures)?\b|\bskipped\b|\bskips?\b|\bpending\b|\btodo\b|\bok\b|not ok\b|\btests?:?\s*\d|\d+\s+of\s+\d+|\bsuites?\b|\bassert(?:s|ed|ion|ions)?\b|\bexpected\b|\bactual\b|\berrors?\b|\berrno\b|\bexceptions?\b|\bpanics?\b|\bfatal\b|\bwarnings?\b|\bdenied\b|\brejected\b|\brefused\b|unable to|\bcannot\b|could not|can't |no such file|not found|\btracebacks?\b|stack trace|^\s*\d+\s*[│|:]|^\s*(?:diff --git|@@|\+\+\+|---))/iu;
var PROTECTED_CJK = /(?:错误|失败|异常|警告|无法|拒绝|超时|跳过|通过)/u;
var REFERENCE_PREFIX = "[[dsh-context-archive";
function countOccurrences(text, marker) {
  let total = 0, index = 0;
  for (; ; ) {
    const found = text.indexOf(marker, index);
    if (found < 0) return total;
    total++;
    index = found + marker.length;
  }
}
function reduceText(text, limits) {
  if (text.length < 400) return { reduced: void 0, reason: "below_min_input" };
  if (text.length > limits.maxInputChars) return { reduced: void 0, reason: "above_max_input" };
  if (countOccurrences(text, REFERENCE_PREFIX) > 0) return { reduced: void 0, reason: "contains_reference_marker" };
  for (let index = 0; index < text.length; index++) {
    const code = text.charCodeAt(index);
    if (code === 9 || code === 10 || code === 13) continue;
    if (code < 32 || code === 127) return { reduced: void 0, reason: "contains_control_characters" };
  }
  const lines = text.split("\n");
  for (const line of lines) if (PROTECTED_LINE.test(line) || PROTECTED_CJK.test(line)) return { reduced: void 0, reason: "protected_marker_present" };
  const output = [];
  let collapsedRuns = 0, collapsedLines = 0;
  for (let index = 0; index < lines.length; ) {
    const line = lines[index];
    let end = index + 1;
    while (end < lines.length && lines[end] === line) end++;
    const repeats = end - index;
    if (line.length >= MIN_LINE_CHARS && repeats >= MIN_RUN) {
      output.push(line);
      output.push(`\u27EA repeated ${repeats - 1} more times \u27EB`);
      collapsedRuns++;
      collapsedLines += repeats - 1;
    } else {
      for (let cursor = index; cursor < end; cursor++) output.push(lines[cursor]);
    }
    index = end;
  }
  if (collapsedRuns === 0) return { reduced: void 0, reason: "no_collapsible_run" };
  const reduced = output.join("\n");
  if (text.length - reduced.length < limits.minSavingsChars) return { reduced: void 0, reason: "missing_savings" };
  return { reduced, collapsedRuns, collapsedLines };
}

// src/tool-results.ts
var FOREIGN_MARKERS = [
  REFERENCE_PREFIX,
  "dsh-spill",
  "Read the full result from",
  // The Host's own upstream-truncation notice: such text is not a complete
  // original and must never be archived as one.
  "output truncated; full output",
  "some output was dropped from memory"
];
var RECOGNIZED_TOOLS = /* @__PURE__ */ new Set(["bash"]);
var PROTECTED_TOOLS = /* @__PURE__ */ new Set(["read", "edit", "write", "str_replace_editor", "read_image", "apply_patch", "glob", "grep"]);
function plainText(content) {
  if (content.length !== 1) return void 0;
  const block = content[0];
  return block?.type === "text" ? block.text : void 0;
}
function valueEvidence(name, value) {
  if (!RECOGNIZED_TOOLS.has(name)) return { state: "refused", reason: "the producing tool is not one this rule has evidence for" };
  if (value === null || typeof value !== "object") return { state: "refused", reason: "the tool value has no inspectable shape" };
  const record = value;
  if (record.kind !== "foreground") return { state: "refused", reason: `unrecognised shell result kind ${JSON.stringify(record.kind)}` };
  if (typeof record.exitCode !== "number") return { state: "refused", reason: "the shell result carries no exit code" };
  if (record.exitCode !== 0) return { state: "refused", reason: `exit code ${record.exitCode} is not success` };
  if (record.timedOut === true) return { state: "refused", reason: "the command timed out" };
  if (record.signal !== null && record.signal !== void 0) return { state: "refused", reason: `the command was killed by ${String(record.signal)}` };
  for (const stream of ["stdout", "stderr"]) {
    const output = record[stream];
    if (output === null || typeof output !== "object") return { state: "refused", reason: `the ${stream} shape is unrecognised` };
    const held = output;
    if (typeof held.text !== "string" || typeof held.truncated !== "boolean") {
      return { state: "refused", reason: `the ${stream} completeness is not declared` };
    }
    if (held.truncated) return { state: "refused", reason: `${stream} was truncated upstream` };
    if (stream === "stderr" && held.text.length > 0) return { state: "refused", reason: "the command wrote to stderr" };
  }
  return { state: "complete" };
}
function registerToolResultReduction(ctx, policy, archive) {
  const stats = { considered: 0, unverified: 0, wouldReduce: 0, published: 0, reverted: 0, pending: 0, skipped: 0, failed: 0 };
  const pending = /* @__PURE__ */ new WeakSet();
  const entries = /* @__PURE__ */ new WeakMap();
  const records = /* @__PURE__ */ new WeakMap();
  const sessions = /* @__PURE__ */ new Map();
  let reported = false;
  const ownsContentTransform = (exec) => {
    const tools = ctx.get("tools");
    if (typeof tools?.get !== "function") return true;
    let definition;
    try {
      definition = tools.get(exec.name, exec.agent);
    } catch {
      return true;
    }
    if (definition === void 0) return true;
    return typeof definition.projectContent === "function" || typeof definition.finalizeContent === "function";
  };
  ctx.inject(["tools"], (scope) => {
    let registered = true;
    scope.effect(() => () => {
      registered = false;
    });
    const live = () => registered;
    scope.events.on("tools/post-execute", async (exec, result, next) => {
      const decision = await next();
      if (!live()) {
        stats.lastSkip = "unloaded";
        return decision;
      }
      try {
        return reduceDecision(exec, result, decision, live);
      } catch (error) {
        stats.failed++;
        stats.lastSkip = "internal_error";
        stats.lastReason = error instanceof Error ? error.message : String(error);
        ctx.logger.warn("context-manager: tool result reduction skipped: %s", stats.lastReason);
        return decision;
      }
    });
    scope.events.on("tools/result", (exec, result) => {
      reported = true;
      try {
        confirm(exec, result);
      } catch (error) {
        stats.failed++;
        stats.lastReason = error instanceof Error ? error.message : String(error);
        ctx.logger.warn("context-manager: could not record the final tool result outcome: %s", stats.lastReason);
      }
      return void 0;
    });
  });
  function confirm(exec, result) {
    if (!pending.has(exec)) return;
    pending.delete(exec);
    stats.pending = Math.max(0, stats.pending - 1);
    const record = records.get(exec);
    const final = plainText(result.content);
    const published = record !== void 0 && final === entries.get(exec);
    if (published) {
      record.archive.notePublished(record.contentId, record.sessionId, record.callId);
      stats.published++;
      bump(record.sessionId, "published");
      return;
    }
    stats.reverted++;
    if (record !== void 0) {
      record.archive.noteReverted(record.contentId, record.sessionId, record.callId, "the final Host result did not carry the reduced text");
      bump(record.sessionId, "reverted");
    }
  }
  function bump(sessionId, field) {
    const held = sessions.get(sessionId) ?? { published: 0, reverted: 0 };
    held[field]++;
    sessions.set(sessionId, held);
  }
  function skip(reason, detail) {
    stats.skipped++;
    stats.lastSkip = reason;
    if (detail !== void 0) stats.lastReason = detail;
  }
  function reduceDecision(exec, result, decision, live) {
    const settings = policy();
    if (settings.toolResultsMode === "off") return decision;
    if (result.isError) {
      skip("error_result");
      return decision;
    }
    if (decision.kind !== "accept") {
      skip("blocked_decision");
      return decision;
    }
    const accepted = decision;
    if (accepted.value !== void 0) {
      skip("replaced_value");
      return decision;
    }
    if (exec.signal.aborted) {
      skip("cancelled");
      return decision;
    }
    stats.considered++;
    if (PROTECTED_TOOLS.has(exec.name)) {
      skip("protected_tool");
      return decision;
    }
    if (!RECOGNIZED_TOOLS.has(exec.name)) {
      skip("unrecognized_tool");
      return decision;
    }
    if (ownsContentTransform(exec)) {
      skip("finalizer_tool");
      return decision;
    }
    const evidence = valueEvidence(exec.name, accepted.value ?? result.value);
    if (evidence.state !== "complete") {
      stats.unverified++;
      skip("unverified_result", evidence.reason);
      return decision;
    }
    const content = accepted.content ?? result.content;
    const text = plainText(content);
    if (text === void 0) {
      skip("non_text");
      return decision;
    }
    if (FOREIGN_MARKERS.some((marker) => text.includes(marker))) {
      skip("foreign_marker");
      return decision;
    }
    if (text.length > settings.toolResultsMaxChars) {
      skip("above_max_input");
      return decision;
    }
    const outcome = reduceText(text, { maxInputChars: settings.toolResultsMaxChars, minSavingsChars: settings.toolResultsMinSavings });
    if (outcome.reduced === void 0) {
      skip(outcome.reason);
      return decision;
    }
    stats.wouldReduce++;
    if (settings.toolResultsMode === "observe") return decision;
    const sessionId = exec.agent?.session.header.id;
    if (sessionId === void 0) {
      skip("no_session");
      return decision;
    }
    if (!live()) {
      skip("unloaded");
      return decision;
    }
    const store = archive();
    if (store === void 0) {
      skip("archive_unavailable");
      return decision;
    }
    const before = estimateContent([{ type: "text", text }]);
    let content$;
    let shortened = "";
    try {
      const contentId = hashText(text);
      const render = (reducedChars) => `${outcome.reduced}

${REFERENCE_PREFIX} id=${contentId} session=${JSON.stringify(sessionId)} call=${JSON.stringify(exec.callId)} rule=${RULE_ID} v${RULE_VERSION} reduced=${reducedChars}]]`;
      shortened = render(0);
      for (let pass = 0; pass < 4; pass++) {
        const next = render(shortened.length);
        if (next === shortened) break;
        shortened = next;
      }
      content$ = store.save({
        text,
        source: `tool:${exec.name}`,
        rule: RULE_ID,
        ruleVersion: RULE_VERSION,
        shortenedChars: shortened.length,
        sessionId,
        callId: exec.callId,
        complete: true
      });
      if (content$.contentId !== contentId) throw new Error("archive returned a different content id than the original digest");
    } catch (error) {
      stats.failed++;
      stats.lastSkip = "archive_unavailable";
      stats.lastReason = error instanceof Error ? error.message : String(error);
      ctx.logger.warn("context-manager: keeping the Host result; original text was not archived: %s", stats.lastReason);
      return decision;
    }
    const after = estimateContent([{ type: "text", text: shortened }]);
    if (after >= before) {
      skip("no_savings");
      return decision;
    }
    if (!live()) {
      skip("unloaded");
      return decision;
    }
    const decided = {
      kind: "accept",
      content: [{ type: "text", text: shortened }],
      ...accepted.additionalContexts === void 0 ? {} : { additionalContexts: accepted.additionalContexts }
    };
    pending.add(exec);
    entries.set(exec, shortened);
    records.set(exec, {
      contentId: content$.contentId,
      content: shortened,
      archive: store,
      originalChars: text.length,
      shortenedChars: shortened.length,
      sessionId,
      ...exec.callId === void 0 ? {} : { callId: exec.callId }
    });
    stats.pending++;
    return decided;
  }
  return { stats: () => ({ ...stats }), reported: () => reported, sessions: () => new Map(sessions) };
}
export {
  registerToolResultReduction
};
