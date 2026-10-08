// src/policy.ts
function validatePolicy(p) {
  if (typeof p.enabled !== "boolean") throw new Error("\u81EA\u52A8\u538B\u7F29\u5F00\u5173\u5FC5\u987B\u662F\u5E03\u5C14\u503C");
  if (p.historyMode !== "automatic" && p.historyMode !== "custom") throw new Error("\u5386\u53F2\u4FDD\u7559\u7B56\u7565\u5FC5\u987B\u4E3A automatic \u6216 custom");
  if (typeof p.idleEnabled !== "boolean") throw new Error("\u95F2\u7F6E\u81EA\u52A8\u538B\u7F29\u5F00\u5173\u5FC5\u987B\u662F\u5E03\u5C14\u503C");
  if (typeof p.formatRepairEnabled !== "boolean") throw new Error("\u6458\u8981\u683C\u5F0F\u4FEE\u590D\u5F00\u5173\u5FC5\u987B\u662F\u5E03\u5C14\u503C");
  if (typeof p.absoluteEnabled !== "boolean") throw new Error("\u7EDD\u5BF9\u5DE5\u4F5C\u5386\u53F2\u8F6F\u9884\u7B97\u5F00\u5173\u5FC5\u987B\u662F\u5E03\u5C14\u503C");
  if (typeof p.summaryInstructions !== "string" || p.summaryInstructions.length > 2e3) throw new Error("\u6458\u8981\u4FDD\u7559\u91CD\u70B9\u4E0D\u80FD\u8D85\u8FC7 2000 \u5B57\u7B26");
  const ranges = {
    recentTokens: [1e3, 128e3],
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
  if (p.historyMode === "custom" && p.targetPercent > p.triggerPercent - p.earlyPercent - 10) throw new Error("\u81EA\u5B9A\u4E49\u5360\u7528\u4E0A\u9650\u987B\u6BD4\u5B9E\u9645\u68C0\u67E5\u9608\u503C\u81F3\u5C11\u4F4E 10 \u4E2A\u767E\u5206\u70B9");
  if (p.historyMode === "custom" && p.absoluteEnabled && p.absoluteTargetTokens > Math.floor(p.absoluteTriggerTokens * 0.8)) throw new Error("\u7EDD\u5BF9\u5360\u7528\u4E0A\u9650\u987B\u6BD4\u7EDD\u5BF9\u8F6F\u89E6\u53D1\u81F3\u5C11\u4F4E 20%");
  for (const key of ["recentTokens", "summaryMaxTokens", "maxPasses", "timeoutMs", "idleMinutes", "formatRepairMaxTokens", "absoluteTriggerTokens", "absoluteTargetTokens"]) {
    if (!Number.isInteger(p[key])) throw new Error(`${key} \u5FC5\u987B\u662F\u6574\u6570`);
  }
}
function budget(policy, window, outputReserve) {
  validatePolicy(policy);
  if (!Number.isSafeInteger(window) || window <= 0) throw new Error("\u5F53\u524D\u6A21\u578B\u672A\u63D0\u4F9B\u6709\u6548\u4E0A\u4E0B\u6587\u7A97\u53E3");
  if (!Number.isFinite(outputReserve) || outputReserve < 0) throw new Error("\u5F53\u524D\u6A21\u578B\u8F93\u51FA\u9884\u7559\u65E0\u6548");
  const safety = Math.ceil(window * policy.safetyPercent / 100);
  const hard = Math.max(0, window - Math.ceil(outputReserve) - safety);
  const trigger = Math.min(Math.floor(window * policy.triggerPercent / 100), hard);
  const percentAdmission = Math.max(0, trigger - Math.ceil(window * policy.earlyPercent / 100));
  const requestedPercentTarget = Math.floor(window * policy.targetPercent / 100);
  const percentTarget = Math.min(requestedPercentTarget, Math.floor(percentAdmission * 0.8));
  const absoluteTrigger = policy.absoluteEnabled ? policy.absoluteTriggerTokens : null;
  const absoluteTarget = policy.historyMode === "custom" && policy.absoluteEnabled ? policy.absoluteTargetTokens : null;
  const admission = Math.min(percentAdmission, hard, absoluteTrigger ?? Number.POSITIVE_INFINITY);
  const target = policy.historyMode === "automatic" ? admission : Math.min(percentTarget, absoluteTarget ?? Number.POSITIVE_INFINITY);
  const admissionSource = absoluteTrigger !== null && admission === absoluteTrigger ? "absolute" : trigger === hard || admission === hard ? "hard" : "percent";
  const targetSource = policy.historyMode === "automatic" ? "working-set" : absoluteTarget !== null && target === absoluteTarget ? "absolute" : percentTarget < requestedPercentTarget ? "admission" : "percent";
  return {
    historyMode: policy.historyMode,
    recentTokens: policy.recentTokens,
    window,
    outputReserve,
    safety,
    hard,
    trigger,
    admission,
    target,
    admissionSource,
    targetSource,
    absoluteTrigger,
    absoluteTarget
  };
}

// src/chart-data.ts
var contextGroups = [
  { id: "summary", categories: ["summary"] },
  { id: "tool", categories: ["tool"] },
  { id: "message", categories: ["user", "assistant"] },
  { id: "instruction", categories: ["system", "tools", "inject", "skill"] }
];
function percentages(values) {
  const total = values.reduce((sum, value) => sum + value, 0);
  if (total <= 0) return values.map(() => 0);
  const raw = values.map((value) => value / total * 1e3);
  const units = raw.map(Math.floor);
  const order = raw.map((value, index) => ({ index, fraction: value - units[index] })).sort((a, b) => b.fraction - a.fraction || a.index - b.index);
  const remaining = 1e3 - units.reduce((sum, value) => sum + value, 0);
  for (let i = 0; i < remaining; i++) units[order[i].index]++;
  return units.map((value) => value / 10);
}
function admissionBudget(data, policy) {
  const reading = data.historical ? void 0 : data.admission;
  return policy && reading?.window != null && reading.outputReserve !== null ? budget(policy, reading.window, reading.outputReserve) : null;
}
function composition(data, policy) {
  const slices = contextGroups.map((group) => ({ id: group.id, value: data.parts.filter((part) => group.categories.some((category) => category === part.category)).reduce((sum, part) => sum + part.tokens, 0), share: 0 }));
  const content = slices.reduce((sum, item) => sum + item.value, 0);
  const cut = data.pressureHistory.at(-1);
  const current = data.historical ? void 0 : data.admission;
  const capacity = current ? current.window : data.pressure?.window ?? cut?.window ?? null;
  const window = capacity !== null && capacity > 0 ? capacity : null;
  const measured = current?.tokens ?? data.pressure?.projected ?? cut?.tokens ?? null;
  const used = Math.max(content, measured ?? 0);
  const other = used - content;
  if (other > 0) slices.push({ id: "other", value: other, share: 0 });
  const gate = policy?.enabled ? admissionBudget(data, policy) : null;
  const limit = gate?.admission ?? null;
  const free = window === null ? null : Math.max(0, (limit ?? window) - used);
  const reserve = gate === null ? null : Math.max(0, gate.window - Math.max(used, gate.admission));
  if (free !== null) slices.push({ id: "free", value: free, share: 0 });
  if (reserve !== null) slices.push({ id: "reserve", value: reserve, share: 0 });
  const total = slices.reduce((sum, item) => sum + item.value, 0);
  const shares = percentages(slices.map((item) => item.value));
  return { content, used, measured, free, reserve, limit, total, window, overflow: window !== null && used > window, slices: slices.map((item, index) => ({ ...item, share: shares[index] })) };
}
function usageSlices(usage) {
  if (usage === null) return null;
  const values = [usage.uncached, usage.cacheRead, usage.cacheWrite, usage.output];
  if (values.some((value) => !Number.isFinite(value) || value < 0)) return null;
  const total = values.reduce((sum, value) => sum + value, 0);
  return { total, values, shares: percentages(values), hit: usage.input > 0 ? usage.cacheRead / usage.input * 100 : null };
}
export {
  admissionBudget,
  composition,
  contextGroups,
  percentages,
  usageSlices
};
