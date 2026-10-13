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
function groupNodes(nodes) {
  const groups = [];
  for (let start = 0; start < nodes.length; ) {
    if (!nodes[start].balancedBefore) {
      groups.push({ start, end: start, tokens: nodes[start].tokens, fixed: true });
      start++;
      continue;
    }
    let end = start, tokens = 0, fixed = false;
    for (; end < nodes.length; end++) {
      tokens += nodes[end].tokens;
      fixed ||= nodes[end].protected;
      if (nodes[end].balancedAfter) break;
    }
    if (end === nodes.length) {
      end--;
      fixed = true;
    }
    groups.push({ start, end, tokens, fixed });
    start = end + 1;
  }
  return groups;
}
function planWithTail(nodes, groups, limits, upper, recentTokens, resumeHeadroom) {
  const tail = /* @__PURE__ */ new Set();
  let retainedTokens = 0;
  for (let i = groups.length - 1; i >= 0; i--) {
    const group = groups[i];
    if (group.fixed) continue;
    if (retainedTokens + group.tokens > recentTokens) break;
    tail.add(i);
    retainedTokens += group.tokens;
  }
  let best;
  for (let start = 0; start < groups.length; ) {
    const first = groups[start];
    if (first.fixed || tail.has(start)) {
      start++;
      continue;
    }
    let tokens = 0, cursor = start;
    for (; cursor < groups.length; cursor++) {
      const group = groups[cursor];
      if (group.fixed || tail.has(cursor)) break;
      tokens += group.tokens;
    }
    const remaining = Math.max(0, limits.total - tokens);
    const room = upper - remaining - FRAMING_TOKENS;
    const cap = Math.floor(Math.min(limits.summaryTokens, room, tokens * 0.5));
    if (cap >= 256 && tokens - cap - FRAMING_TOKENS >= minimumGain(limits.total)) {
      const candidate = {
        start: nodes[first.start].seq,
        end: nodes[groups[cursor - 1].end].seq,
        tokens,
        before: limits.total,
        remaining,
        estimatedAfter: remaining + cap + FRAMING_TOKENS,
        summaryTokens: cap,
        upper,
        retainedTokens,
        resumeHeadroom,
        admission: limits.admission
      };
      if (!best || candidate.tokens > best.tokens) best = candidate;
    }
    start = Math.max(start + 1, cursor);
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
    limits.resumeHeadroom ?? 0
  ];
  if (measures.some((value) => !Number.isFinite(value) || value < 0) || nodes.some((node) => !Number.isFinite(node.tokens) || node.tokens < 0)) return void 0;
  const headroom = limits.resumeHeadroom ?? 0;
  const ceiling = Math.min(limits.admission - 1, limits.hard - 1, limits.target ?? Infinity);
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
  continuationHeadroom,
  planWorkingSet,
  validateWorkingCandidate
};
