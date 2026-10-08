/**
 * Deterministic, information-preserving reduction for successful plain-text
 * tool results. One rule: collapse a run of three or more *byte-identical*
 * consecutive lines, keeping the first line and stating the exact number of
 * further occurrences.
 *
 * Design limits, all deliberate:
 * - Comparison is exact (`===` on the stored text), never a trimmed or
 *   whitespace-normalized comparison: different indentation is different
 *   content for source code, YAML, logs with column alignment and diffs.
 * - No model call, no keyword rewriting, no summarization, no reordering, no
 *   renumbering. Line order and every surviving byte are unchanged.
 * - Any line that can carry an exit status, a test/step count, a warning, a
 *   failure word or a Chinese equivalent is never collapsed, and if such a line
 *   appears anywhere in the input the whole result is passed through. An
 *   ambiguous case is always a pass-through.
 * - The transform is a pure function of the input bytes, so re-deriving the
 *   short text for the same original is byte-identical. That keeps a replayed
 *   call from changing the request prefix.
 * @module
 */

/** Stable rule identity; recorded in every reference and reduction record. */
export const RULE_ID = 'collapse-identical-lines'
/** Bumped whenever the transform or a gate changes meaning. */
export const RULE_VERSION = 1
/** A run must be at least this long before it is collapsed. */
export const MIN_RUN = 3
/** Shortest line worth collapsing; guards against separator noise. */
const MIN_LINE_CHARS = 4

export type SkipReason =
  | 'not_recognized_tool'
  | 'below_min_input'
  | 'above_max_input'
  | 'contains_reference_marker'
  | 'contains_control_characters'
  | 'no_collapsible_run'
  | 'protected_marker_present'
  | 'missing_savings'

export type ReductionOutcome =
  | { readonly reduced: string; readonly collapsedRuns: number; readonly collapsedLines: number }
  | { readonly reduced: undefined; readonly reason: SkipReason }

/**
 * Lines that carry an exit status, a test/step summary, a warning, a failure
 * word, or a source/anchor shape. Matched case-insensitively against every
 * input line: one hit anywhere passes the whole result through, because a rare
 * failure notice must never become indistinguishable from benign repetition.
 * Boundaries are strict so ordinary words ("look", "token") do not match.
 */
const PROTECTED_LINE = /(?:exit\s*code|exit\s*status|exitcode|\[stopped|\[timed out|\[killed|\[stderr\]|returned\s+(?:exit\s+)?\d|\bsignals?\b|segmentation fault|core dumped|\bpass(?:ed|ing|es)?\b|\bfail(?:ed|ing|ure|ures)?\b|\bskipped\b|\bskips?\b|\bpending\b|\btodo\b|\bok\b|not ok\b|\btests?:?\s*\d|\d+\s+of\s+\d+|\bsuites?\b|\bassert(?:s|ed|ion|ions)?\b|\bexpected\b|\bactual\b|\berrors?\b|\berrno\b|\bexceptions?\b|\bpanics?\b|\bfatal\b|\bwarnings?\b|\bdenied\b|\brejected\b|\brefused\b|unable to|\bcannot\b|could not|can't |no such file|not found|\btracebacks?\b|stack trace|^\s*\d+\s*[│|:]|^\s*(?:diff --git|@@|\+\+\+|---))/iu
/** Chinese markers matched separately: a `\b` boundary is undefined for CJK. */
const PROTECTED_CJK = /(?:错误|失败|异常|警告|无法|拒绝|超时|跳过|通过)/u

/** Written into the short result so the reduced text is self-describing. */
export const REFERENCE_PREFIX = '[[dsh-context-archive'

function countOccurrences(text: string, marker: string): number {
  let total = 0, index = 0
  for (;;) {
    const found = text.indexOf(marker, index)
    if (found < 0) return total
    total++
    index = found + marker.length
  }
}

/**
 * Reduce one successful plain-text tool result.
 *
 * @param text - the exact original text the model would otherwise receive.
 * @param limits - bounded input window and minimum byte savings.
 * @returns the reduced text, or undefined with the deterministic skip reason.
 */
export function reduceText(text: string, limits: { readonly maxInputChars: number; readonly minSavingsChars: number }): ReductionOutcome {
  if (text.length < 400) return { reduced: undefined, reason: 'below_min_input' }
  if (text.length > limits.maxInputChars) return { reduced: undefined, reason: 'above_max_input' }
  if (countOccurrences(text, REFERENCE_PREFIX) > 0) return { reduced: undefined, reason: 'contains_reference_marker' }
  for (let index = 0; index < text.length; index++) {
    const code = text.charCodeAt(index)
    if (code === 9 || code === 10 || code === 13) continue
    if (code < 32 || code === 127) return { reduced: undefined, reason: 'contains_control_characters' }
  }
  const lines = text.split('\n')
  // Any protected marker anywhere in the input passes the whole result through.
  for (const line of lines) if (PROTECTED_LINE.test(line) || PROTECTED_CJK.test(line)) return { reduced: undefined, reason: 'protected_marker_present' }
  const output: string[] = []
  let collapsedRuns = 0, collapsedLines = 0
  for (let index = 0; index < lines.length;) {
    const line = lines[index] as string
    let end = index + 1
    // Exact bytes only: no trimming, no normalization.
    while (end < lines.length && lines[end] === line) end++
    const repeats = end - index
    if (line.length >= MIN_LINE_CHARS && repeats >= MIN_RUN) {
      output.push(line)
      // The first line is retained, so the marker states the remaining count.
      output.push(`\u27ea repeated ${repeats - 1} more times \u27eb`)
      collapsedRuns++
      collapsedLines += repeats - 1
    } else {
      for (let cursor = index; cursor < end; cursor++) output.push(lines[cursor] as string)
    }
    index = end
  }
  if (collapsedRuns === 0) return { reduced: undefined, reason: 'no_collapsible_run' }
  const reduced = output.join('\n')
  if (text.length - reduced.length < limits.minSavingsChars) return { reduced: undefined, reason: 'missing_savings' }
  return { reduced, collapsedRuns, collapsedLines }
}
