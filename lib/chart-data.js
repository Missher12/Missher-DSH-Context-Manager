// src/policy.ts
var defaults = {
  modelLimits: [],
  capacityMode: "percent",
  recentPercent: 10,
  summaryPercent: 4,
  repairPercent: 1,
  enabled: true,
  historyMode: "automatic",
  recentTokens: 2e4,
  triggerPercent: 80,
  targetPercent: 55,
  earlyPercent: 1,
  safetyPercent: 2,
  summaryMaxTokens: 8192,
  maxPasses: 2,
  timeoutMs: 9e4,
  summaryTimeoutMode: "adaptive",
  summaryTotalMs: 6e5,
  summaryFirstOutputMs: 12e4,
  summaryStallMs: 18e4,
  idleEnabled: true,
  idleMinutes: 15,
  idleMinPercent: 65,
  summaryInstructions: "",
  checkpointFormat: "json",
  formatRepairEnabled: true,
  formatRepairMaxTokens: 2048,
  absoluteEnabled: false,
  absoluteTriggerTokens: 2e5,
  absoluteTargetTokens: 1e5,
  toolResultsMode: "observe",
  toolResultsMaxChars: 2e5,
  toolResultsMinSavings: 400,
  archiveReadBudget: 6e3,
  archiveSearchLimit: 3,
  prefixDiagnosticsEnabled: true
};
function normalizePolicy(saved) {
  return { ...defaults, ...saved, modelLimits: saved.modelLimits ?? [], capacityMode: saved.capacityMode ?? "legacy", summaryTimeoutMode: saved.summaryTimeoutMode ?? "fixed" };
}
function validatePolicy(p) {
  if (p.capacityMode !== void 0 && p.capacityMode !== "legacy" && p.capacityMode !== "percent") throw new Error("\u5BB9\u91CF\u7B56\u7565\u5FC5\u987B\u4E3A legacy \u6216 percent");
  if (typeof p.enabled !== "boolean") throw new Error("\u81EA\u52A8\u538B\u7F29\u5F00\u5173\u5FC5\u987B\u662F\u5E03\u5C14\u503C");
  if (p.historyMode !== "automatic" && p.historyMode !== "custom") throw new Error("\u5386\u53F2\u4FDD\u7559\u7B56\u7565\u5FC5\u987B\u4E3A automatic \u6216 custom");
  if (typeof p.idleEnabled !== "boolean") throw new Error("\u95F2\u7F6E\u81EA\u52A8\u538B\u7F29\u5F00\u5173\u5FC5\u987B\u662F\u5E03\u5C14\u503C");
  if (typeof p.formatRepairEnabled !== "boolean") throw new Error("\u672C\u5730\u7ED3\u6784\u4FEE\u590D\u5F00\u5173\u5FC5\u987B\u662F\u5E03\u5C14\u503C");
  if (typeof p.absoluteEnabled !== "boolean") throw new Error("\u7EDD\u5BF9\u5DE5\u4F5C\u5386\u53F2\u8F6F\u9884\u7B97\u5F00\u5173\u5FC5\u987B\u662F\u5E03\u5C14\u503C");
  if (typeof p.prefixDiagnosticsEnabled !== "boolean") throw new Error("\u8BF7\u6C42\u524D\u7F00\u6307\u7EB9\u8BCA\u65AD\u5F00\u5173\u5FC5\u987B\u662F\u5E03\u5C14\u503C");
  if (p.toolResultsMode !== "off" && p.toolResultsMode !== "observe" && p.toolResultsMode !== "reduce") throw new Error("\u5DE5\u5177\u7ED3\u679C\u7CBE\u7B80\u6A21\u5F0F\u5FC5\u987B\u4E3A off\u3001observe \u6216 reduce");
  if (p.summaryTimeoutMode !== "fixed" && p.summaryTimeoutMode !== "adaptive") throw new Error("\u538B\u7F29\u8D85\u65F6\u6A21\u5F0F\u5FC5\u987B\u4E3A fixed \u6216 adaptive");
  if (p.checkpointFormat !== "json" && p.checkpointFormat !== "sections") throw new Error("\u6458\u8981 checkpoint \u534F\u8BAE\u5FC5\u987B\u4E3A json \u6216 sections");
  if (typeof p.summaryInstructions !== "string" || p.summaryInstructions.length > 2e3) throw new Error("\u6458\u8981\u4FDD\u7559\u91CD\u70B9\u4E0D\u80FD\u8D85\u8FC7 2000 \u5B57\u7B26");
  const ranges = {
    recentPercent: [0.1, 50],
    summaryPercent: [0.1, 10],
    repairPercent: [0.1, 10],
    recentTokens: [1e3, 128e3],
    triggerPercent: [50, 95],
    targetPercent: [10, 75],
    earlyPercent: [0, 5],
    safetyPercent: [1, 10],
    summaryMaxTokens: [256, 32768],
    maxPasses: [1, 2],
    timeoutMs: [1e3, 18e5],
    summaryTotalMs: [1e4, 36e5],
    summaryFirstOutputMs: [5e3, 9e5],
    summaryStallMs: [5e3, 18e5],
    idleMinutes: [1, 1440],
    idleMinPercent: [10, 95],
    formatRepairMaxTokens: [256, 8192],
    absoluteTriggerTokens: [1e4, 1e9],
    absoluteTargetTokens: [1e3, 1e9],
    toolResultsMaxChars: [2e3, 4e6],
    toolResultsMinSavings: [100, 1e6],
    archiveReadBudget: [500, 6e3],
    archiveSearchLimit: [1, 8]
  };
  for (const [key, [min, max]] of Object.entries(ranges)) {
    const value = p[key];
    if (value === void 0 && ["recentPercent", "summaryPercent", "repairPercent"].includes(key) && p.capacityMode !== "percent") continue;
    if (!Number.isFinite(value) || value < min || value > max) throw new Error(`${key} \u5FC5\u987B\u5728 ${min}\u2013${max} \u4E4B\u95F4`);
  }
  if (p.historyMode === "custom" && p.targetPercent > p.triggerPercent - p.earlyPercent - 10) throw new Error("\u81EA\u5B9A\u4E49\u5360\u7528\u4E0A\u9650\u987B\u6BD4\u5B9E\u9645\u68C0\u67E5\u9608\u503C\u81F3\u5C11\u4F4E 10 \u4E2A\u767E\u5206\u70B9");
  if (p.capacityMode !== "percent" && p.historyMode === "custom" && p.absoluteEnabled && p.absoluteTargetTokens > Math.floor(p.absoluteTriggerTokens * 0.8)) throw new Error("\u7EDD\u5BF9\u5360\u7528\u4E0A\u9650\u987B\u6BD4\u7EDD\u5BF9\u8F6F\u89E6\u53D1\u81F3\u5C11\u4F4E 20%");
  for (const key of ["recentTokens", "summaryMaxTokens", "maxPasses", "timeoutMs", "summaryTotalMs", "summaryFirstOutputMs", "summaryStallMs", "idleMinutes", "formatRepairMaxTokens", "absoluteTriggerTokens", "absoluteTargetTokens", "toolResultsMaxChars", "toolResultsMinSavings", "archiveReadBudget", "archiveSearchLimit"]) {
    if (!Number.isInteger(p[key])) throw new Error(`${key} \u5FC5\u987B\u662F\u6574\u6570`);
  }
  if (!Array.isArray(p.modelLimits)) throw new Error("\u6A21\u578B\u4E0A\u4E0B\u6587\u4E0A\u9650\u5FC5\u987B\u662F\u5217\u8868");
  const routes = /* @__PURE__ */ new Set();
  for (const item of p.modelLimits) {
    if (!item || typeof item.provider !== "string" || !item.provider.trim() || typeof item.model !== "string" || !item.model.trim()) throw new Error("\u6A21\u578B\u8DEF\u7531\u5FC5\u987B\u540C\u65F6\u5305\u542B provider \u548C model");
    if (!Number.isSafeInteger(item.tokens) || item.tokens < 1e4 || item.tokens > 1e9) throw new Error("\u6A21\u578B\u4E0A\u4E0B\u6587\u4E0A\u9650\u5FC5\u987B\u662F 10000\u20131000000000 \u4E4B\u95F4\u7684\u6574\u6570 Token");
    const route = JSON.stringify([item.provider, item.model]);
    if (routes.has(route)) throw new Error("\u6A21\u578B\u8DEF\u7531\u4E0D\u80FD\u91CD\u590D");
    routes.add(route);
  }
}
function budget(policy, window, outputReserve, route) {
  policy = normalizePolicy(policy);
  validatePolicy(policy);
  if (!Number.isSafeInteger(window) || window <= 0) throw new Error("\u5F53\u524D\u6A21\u578B\u672A\u63D0\u4F9B\u6709\u6548\u4E0A\u4E0B\u6587\u7A97\u53E3");
  if (!Number.isFinite(outputReserve) || outputReserve < 0) throw new Error("\u5F53\u524D\u6A21\u578B\u8F93\u51FA\u9884\u7559\u65E0\u6548");
  const savedLimit = route && policy.modelLimits.find((item) => item.provider === route.provider && item.model === route.model)?.tokens;
  const workingWindow = Math.min(window, savedLimit ?? window);
  const safety = Math.ceil(workingWindow * policy.safetyPercent / 100);
  const hard = Math.max(0, workingWindow - Math.ceil(outputReserve) - safety);
  const trigger = Math.min(Math.floor(workingWindow * policy.triggerPercent / 100), hard);
  const percentAdmission = Math.max(0, trigger - Math.ceil(workingWindow * policy.earlyPercent / 100));
  const requestedPercentTarget = Math.floor(workingWindow * policy.targetPercent / 100);
  const percentTarget = Math.min(requestedPercentTarget, Math.floor(percentAdmission * 0.8));
  const absoluteTrigger = policy.capacityMode !== "percent" && policy.absoluteEnabled ? policy.absoluteTriggerTokens : null;
  const absoluteTarget = policy.capacityMode !== "percent" && policy.historyMode === "custom" && policy.absoluteEnabled ? policy.absoluteTargetTokens : null;
  const admission = Math.min(percentAdmission, hard, absoluteTrigger ?? Number.POSITIVE_INFINITY);
  const target = policy.historyMode === "automatic" ? admission : Math.min(percentTarget, absoluteTarget ?? Number.POSITIVE_INFINITY);
  const admissionSource = absoluteTrigger !== null && admission === absoluteTrigger ? "absolute" : trigger === hard || admission === hard ? "hard" : "percent";
  const targetSource = policy.historyMode === "automatic" ? "working-set" : absoluteTarget !== null && target === absoluteTarget ? "absolute" : percentTarget < requestedPercentTarget ? "admission" : "percent";
  return {
    historyMode: policy.historyMode,
    recentTokens: capacityTokens(policy, workingWindow).recent,
    window,
    workingWindow,
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
function capacityTokens(policy, window) {
  policy = normalizePolicy(policy);
  if (!Number.isSafeInteger(window) || window <= 0) throw new Error("\u5F53\u524D\u6A21\u578B\u672A\u63D0\u4F9B\u6709\u6548\u4E0A\u4E0B\u6587\u7A97\u53E3");
  if (policy.capacityMode !== "percent") return { recent: policy.recentTokens, summary: policy.summaryMaxTokens, repair: policy.formatRepairMaxTokens };
  return {
    recent: Math.min(128e3, Math.floor(window * policy.recentPercent / 100)),
    summary: Math.min(32768, Math.floor(window * policy.summaryPercent / 100)),
    repair: Math.min(8192, Math.floor(window * policy.repairPercent / 100))
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
  return policy && reading?.window != null && reading.outputReserve !== null ? budget(policy, reading.window, reading.outputReserve, data.model ?? void 0) : null;
}
function contextWindow(data) {
  const current = data.historical ? void 0 : data.admission;
  const window = current ? current.window : data.pressure?.window ?? data.pressureHistory.at(-1)?.window ?? null;
  return window !== null && Number.isSafeInteger(window) && window > 0 ? window : null;
}
function composition(data, policy) {
  const slices = contextGroups.map((group) => ({ id: group.id, value: data.parts.filter((part) => group.categories.some((category) => category === part.category)).reduce((sum, part) => sum + part.tokens, 0), share: 0 }));
  const content = slices.reduce((sum, item) => sum + item.value, 0);
  const cut = data.pressureHistory.at(-1);
  const current = data.historical ? void 0 : data.admission;
  const window = contextWindow(data);
  const measured = current?.tokens ?? data.pressure?.projected ?? cut?.tokens ?? null;
  const used = Math.max(content, measured ?? 0);
  const other = used - content;
  if (other > 0) slices.push({ id: "other", value: other, share: 0 });
  const configuredModelLimit = !data.historical && policy && data.model ? policy.modelLimits?.find((item) => item.provider === data.model.provider && item.model === data.model.model)?.tokens : void 0;
  const currentWindow = current?.window != null && Number.isSafeInteger(current.window) && current.window > 0 ? current.window : null;
  const modelLimit = configuredModelLimit === void 0 || currentWindow === null ? null : Math.min(currentWindow, configuredModelLimit);
  const waitingModelWindow = configuredModelLimit !== void 0 && modelLimit === null;
  const workingWindow = window === null ? null : modelLimit === null ? window : Math.min(window, modelLimit);
  const sidecarGate = data.compression?.mode === "native" && data.cooperation?.requestPressure === "context";
  const gate = (data.compression?.mode === "enhanced" || sidecarGate) && policy?.enabled ? admissionBudget(data, policy) : null;
  const capBudget = gate === null && modelLimit !== null ? admissionBudget(data, policy) : null;
  const availableBoundary = gate?.admission ?? capBudget?.hard ?? (modelLimit === null ? workingWindow : null);
  const limit = gate?.admission ?? capBudget?.hard ?? null;
  const free = workingWindow === null || availableBoundary === null ? null : Math.max(0, availableBoundary - used);
  const reserveBoundary = gate?.admission ?? capBudget?.hard;
  const reserve = reserveBoundary === void 0 || reserveBoundary === null || workingWindow === null ? null : Math.max(0, workingWindow - Math.max(used, reserveBoundary));
  const reserveUnknown = modelLimit !== null && current?.outputReserve === null;
  const unknownSpace = reserveUnknown && workingWindow !== null ? Math.max(0, workingWindow - used) : null;
  const modelCapped = modelLimit === null || window === null || workingWindow === null ? null : Math.max(0, window - Math.max(used, workingWindow));
  if (free !== null) slices.push({ id: "free", value: free, share: 0 });
  if (reserve !== null) slices.push({ id: "reserve", value: reserve, share: 0 });
  if (unknownSpace !== null && unknownSpace > 0) slices.push({ id: "unknown-space", value: unknownSpace, share: 0 });
  if (modelCapped !== null && modelCapped > 0) slices.push({ id: "model-capped", value: modelCapped, share: 0 });
  const total = slices.reduce((sum, item) => sum + item.value, 0);
  const shares = slices.map((item) => window === null ? 0 : item.value / window * 100);
  return {
    content,
    used,
    measured,
    free,
    reserve,
    reserveUnknown,
    limit,
    total,
    window,
    workingWindow,
    configuredModelLimit: configuredModelLimit ?? null,
    modelLimit,
    waitingModelWindow,
    overflow: window !== null && used > window,
    slices: slices.map((item, index) => ({ ...item, share: shares[index] }))
  };
}
function usageCompleteness(efficiency) {
  if (efficiency === void 0) return null;
  const fields = [
    efficiency.mirrored.uncachedInput,
    efficiency.mirrored.cacheRead,
    efficiency.mirrored.cacheWrite,
    efficiency.mirrored.output
  ];
  const reported = fields.reduce((total, field) => total + field.reported, 0);
  const missing = fields.reduce((total, field) => total + field.missing, 0);
  if (efficiency.mirrored.settledAttempts === 0 && missing === 0) return "complete";
  if (reported === 0 && (missing > 0 || efficiency.mirrored.withoutUsage > 0)) return "unknown";
  if (missing > 0 || !efficiency.mirrored.complete) return "partial";
  return "complete";
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
  contextWindow,
  percentages,
  usageCompleteness,
  usageSlices
};
