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
export {
  MIN_RUN,
  REFERENCE_PREFIX,
  RULE_ID,
  RULE_VERSION,
  reduceText
};
