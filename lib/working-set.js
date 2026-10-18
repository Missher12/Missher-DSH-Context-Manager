// src/working-set.ts
function continuationHeadroom(input) {
  const { window, admission } = input;
  if (!Number.isFinite(window) || !Number.isFinite(admission) || window <= 0 || admission <= 0) {
    return { tokens: 0, required: 0, limit: 0, projectedGrowth: 0, projectionCapped: false, inputMargin: 0, sufficient: false };
  }
  const growth = Math.max(0, Number.isFinite(input.recentGrowth) ? input.recentGrowth : 0);
  const incoming = Math.max(0, Math.min(Number.isFinite(input.incomingTokens) ? input.incomingTokens : 0, window));
  const projectedGrowth = growth;
  const projectionCapped = false;
  const typical = growth > 0 ? growth : Math.max(1024, Math.floor(window * 5e-3));
  const inputMargin = Math.min(Math.ceil(incoming * 0.05), Math.floor(window * 0.02));
  const need = Math.ceil((typical + inputMargin) * 1.25);
  const floor = Math.min(2048, Math.floor(admission * 0.05));
  const limit = Math.max(0, Math.floor(admission) - 1);
  const required = Math.max(floor, need);
  return { tokens: required, required, limit, projectedGrowth, projectionCapped, inputMargin, sufficient: required <= limit };
}
var FRAMING_TOKENS = 128;
var minimumGain = (before) => Math.min(1024, Math.max(128, before * 5e-3));
function checkpointOutputBudget(totalCheckpointTokens, segments, framing = FRAMING_TOKENS) {
  if (![totalCheckpointTokens, segments, framing].every(Number.isFinite) || totalCheckpointTokens < 0 || !Number.isInteger(segments) || segments < 1 || framing < 0) return 0;
  return Math.max(0, Math.floor(totalCheckpointTokens / segments) - framing);
}
function groupNodes(nodes) {
  const groups = [];
  for (let start = 0; start < nodes.length; ) {
    if (!nodes[start].balancedBefore) {
      groups.push({ start, end: start, tokens: nodes[start].tokens, fixed: true, checkpointTokens: nodes[start].checkpoint ? nodes[start].tokens : 0 });
      start++;
      continue;
    }
    let end = start, tokens = 0, checkpointTokens = 0, fixed = false;
    for (; end < nodes.length; end++) {
      tokens += nodes[end].tokens;
      if (nodes[end].checkpoint) checkpointTokens += nodes[end].tokens;
      fixed ||= nodes[end].protected;
      if (nodes[end].balancedAfter) break;
    }
    if (end === nodes.length) {
      end--;
      fixed = true;
    }
    groups.push({ start, end, tokens, fixed, checkpointTokens });
    start = end + 1;
  }
  return groups;
}
function spansAfterTail(groups, recentTokens) {
  const tail = /* @__PURE__ */ new Set();
  let retainedTokens = 0;
  for (let index = groups.length - 1; index >= 0; index--) {
    const group = groups[index];
    if (group.fixed) continue;
    if (retainedTokens + group.tokens > recentTokens) break;
    tail.add(index);
    retainedTokens += group.tokens;
  }
  const spans = [];
  for (let start = 0; start < groups.length; ) {
    const first = groups[start];
    if (first.fixed || tail.has(start)) {
      start++;
      continue;
    }
    let tokens = 0, checkpointTokens = 0, cursor = start;
    for (; cursor < groups.length; cursor++) {
      const group = groups[cursor];
      if (group.fixed || tail.has(cursor)) break;
      tokens += group.tokens;
      checkpointTokens += group.checkpointTokens;
    }
    spans.push({ firstGroup: start, lastGroup: cursor - 1, tokens, checkpointTokens });
    start = Math.max(start + 1, cursor);
  }
  return { tail, retainedTokens, spans };
}
function selectableWorkingSpans(nodes, recentTokens) {
  if (!Number.isFinite(recentTokens) || recentTokens < 0) return [];
  const groups = groupNodes(nodes);
  const { spans } = spansAfterTail(groups, recentTokens);
  return spans.map((span) => ({
    start: nodes[groups[span.firstGroup].start].seq,
    end: nodes[groups[span.lastGroup].end].seq,
    tokens: span.tokens,
    checkpointTokens: span.checkpointTokens
  }));
}
function planWithTail(nodes, groups, limits, upper, recentTokens, resumeHeadroom) {
  const { tail, retainedTokens, spans } = spansAfterTail(groups, recentTokens);
  let best;
  for (const span of spans) {
    const { firstGroup, lastGroup, tokens } = span;
    let fixed = 0, recent = 0, selected = 0, unselected = 0;
    let fixedCheckpoints = 0, recentCheckpoints = 0, selectedCheckpoints = 0;
    for (let index = 0; index < groups.length; index++) {
      const group = groups[index];
      if (group.fixed) {
        fixed += group.tokens;
        fixedCheckpoints += group.checkpointTokens;
      } else if (index >= firstGroup && index <= lastGroup) {
        selected += group.tokens;
        selectedCheckpoints += group.checkpointTokens;
      } else if (tail.has(index)) {
        recent += group.tokens;
        recentCheckpoints += group.checkpointTokens;
      } else unselected += group.tokens;
    }
    const uncertaintyDelta = limits.total - nodes.reduce((sum, node) => sum + node.tokens, 0);
    const remaining = fixed + recent + unselected + uncertaintyDelta;
    if (!Number.isFinite(remaining) || remaining < 0) continue;
    const selectedSurfaceCheckpoints = nodes.reduce((sum, node) => sum + (node.checkpoint ? node.tokens : 0), 0);
    const activeCheckpoints = limits.activeCheckpointTokens ?? selectedSurfaceCheckpoints;
    if (!Number.isFinite(activeCheckpoints) || activeCheckpoints < selectedSurfaceCheckpoints) {
      continue;
    }
    const retainedCheckpoints = activeCheckpoints - selectedCheckpoints;
    const reservedCheckpoints = limits.reservedCheckpointTokens ?? 0;
    const checkpointAvailable = limits.aggregateCheckpointTokens === void 0 ? Infinity : limits.aggregateCheckpointTokens - retainedCheckpoints - reservedCheckpoints;
    const room = upper - remaining - FRAMING_TOKENS;
    const checkpointRoom = checkpointAvailable === Infinity ? Infinity : checkpointAvailable - FRAMING_TOKENS;
    const cap = Math.floor(Math.min(limits.summaryTokens, room, tokens * 0.5, checkpointRoom));
    if (cap >= 256 && tokens - cap - FRAMING_TOKENS >= minimumGain(limits.total)) {
      const admissionCeiling = Math.min(limits.admission - 1, limits.hard - 1);
      const completionTarget = limits.completionTarget ?? (limits.aggregateCheckpointTokens === void 0 ? limits.target ?? admissionCeiling : fixed + recent - fixedCheckpoints - recentCheckpoints + limits.aggregateCheckpointTokens + resumeHeadroom + Math.max(0, uncertaintyDelta));
      if (!Number.isFinite(completionTarget) || completionTarget < 0) continue;
      const candidate = {
        start: nodes[groups[firstGroup].start].seq,
        end: nodes[groups[lastGroup].end].seq,
        tokens,
        before: limits.total,
        remaining,
        estimatedAfter: remaining + cap + FRAMING_TOKENS,
        summaryTokens: cap,
        upper,
        retainedTokens,
        resumeHeadroom,
        admission: limits.admission,
        composition: { fixed, recent, selected, unselected, uncertaintyDelta },
        checkpoints: {
          active: activeCheckpoints,
          selected: selectedCheckpoints,
          retained: retainedCheckpoints,
          ...limits.aggregateCheckpointTokens === void 0 ? {} : { budget: limits.aggregateCheckpointTokens },
          reserved: reservedCheckpoints
        },
        admissionCeiling,
        completionTarget,
        completionTargetCertain: uncertaintyDelta >= 0
      };
      if (!best || candidate.tokens > best.tokens) best = candidate;
    }
  }
  return best;
}
function planWorkingSet(nodes, limits) {
  const measures = [
    limits.total,
    limits.admission,
    limits.hard,
    limits.recentTokens,
    limits.summaryTokens,
    ...limits.target === void 0 ? [] : [limits.target],
    ...limits.completionTarget === void 0 ? [] : [limits.completionTarget],
    ...limits.aggregateCheckpointTokens === void 0 ? [] : [limits.aggregateCheckpointTokens],
    ...limits.activeCheckpointTokens === void 0 ? [] : [limits.activeCheckpointTokens],
    limits.reservedCheckpointTokens ?? 0,
    limits.resumeHeadroom ?? 0
  ];
  if (measures.some((value) => !Number.isFinite(value) || value < 0) || nodes.some((node) => !Number.isFinite(node.tokens) || node.tokens < 0)) return void 0;
  const headroom = limits.resumeHeadroom ?? 0;
  const admissionCeiling = Math.min(limits.admission - 1, limits.hard - 1);
  const completionTarget = limits.completionTarget ?? limits.target ?? admissionCeiling;
  if (!Number.isFinite(completionTarget) || completionTarget < 0) return void 0;
  const ceiling = Math.min(admissionCeiling, limits.completionTarget === void 0 && limits.aggregateCheckpointTokens === void 0 ? limits.target ?? Infinity : Infinity);
  const upper = Math.max(0, ceiling - headroom);
  const groups = groupNodes(nodes);
  const budgets = limits.overflow ? [0] : [.../* @__PURE__ */ new Set([
    limits.recentTokens,
    Math.floor(limits.recentTokens / 2),
    Math.floor(limits.recentTokens / 4),
    0
  ])];
  for (const recentTokens of budgets) {
    const plan = planWithTail(nodes, groups, limits, upper, recentTokens, headroom);
    if (plan) return plan;
  }
  return void 0;
}
function validateWorkingCandidate(plan, replacementTokens) {
  const after = plan.remaining + replacementTokens;
  if (plan.checkpoints.budget !== void 0 && plan.checkpoints.retained + replacementTokens + plan.checkpoints.reserved > plan.checkpoints.budget) {
    throw new Error(`\u5168\u6D3B\u52A8\u6458\u8981\u8D85\u8FC7\u805A\u5408\u9884\u7B97\uFF08\u9884\u8BA1 ${plan.checkpoints.retained + replacementTokens + plan.checkpoints.reserved} / ${plan.checkpoints.budget} Token\uFF09\uFF0C\u539F\u6587\u4FDD\u7559`);
  }
  if (!Number.isFinite(replacementTokens) || replacementTokens < 0 || !Number.isFinite(after) || after > plan.upper) {
    throw new Error(`\u538B\u7F29\u540E\u4ECD\u8D85\u8FC7\u6709\u6548\u4E0A\u9650\uFF08\u9884\u8BA1 ${Math.ceil(after)} / ${Math.floor(plan.upper)} Token\uFF0C\u542B\u7EED\u8DD1\u4F59\u91CF ${plan.resumeHeadroom}\uFF09\uFF0C\u539F\u6587\u4FDD\u7559`);
  }
  const freed = plan.before - after;
  if (freed < minimumGain(plan.before)) {
    throw new Error("\u538B\u7F29\u6536\u76CA\u4E0D\u8DB3\uFF0C\u505C\u6B62\u91CD\u590D\u6458\u8981\uFF1B\u4EFB\u52A1\u539F\u6587\u4FDD\u7559");
  }
  return after;
}
export {
  checkpointOutputBudget,
  continuationHeadroom,
  planWorkingSet,
  selectableWorkingSpans,
  validateWorkingCandidate
};
