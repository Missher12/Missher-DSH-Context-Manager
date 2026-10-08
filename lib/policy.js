// src/policy.ts
var defaults = {
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
  idleEnabled: true,
  idleMinutes: 15,
  idleMinPercent: 65,
  summaryInstructions: "",
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
function validatePolicy(p) {
  if (typeof p.enabled !== "boolean") throw new Error("\u81EA\u52A8\u538B\u7F29\u5F00\u5173\u5FC5\u987B\u662F\u5E03\u5C14\u503C");
  if (p.historyMode !== "automatic" && p.historyMode !== "custom") throw new Error("\u5386\u53F2\u4FDD\u7559\u7B56\u7565\u5FC5\u987B\u4E3A automatic \u6216 custom");
  if (typeof p.idleEnabled !== "boolean") throw new Error("\u95F2\u7F6E\u81EA\u52A8\u538B\u7F29\u5F00\u5173\u5FC5\u987B\u662F\u5E03\u5C14\u503C");
  if (typeof p.formatRepairEnabled !== "boolean") throw new Error("\u6458\u8981\u683C\u5F0F\u4FEE\u590D\u5F00\u5173\u5FC5\u987B\u662F\u5E03\u5C14\u503C");
  if (typeof p.absoluteEnabled !== "boolean") throw new Error("\u7EDD\u5BF9\u5DE5\u4F5C\u5386\u53F2\u8F6F\u9884\u7B97\u5F00\u5173\u5FC5\u987B\u662F\u5E03\u5C14\u503C");
  if (typeof p.prefixDiagnosticsEnabled !== "boolean") throw new Error("\u8BF7\u6C42\u524D\u7F00\u6307\u7EB9\u8BCA\u65AD\u5F00\u5173\u5FC5\u987B\u662F\u5E03\u5C14\u503C");
  if (p.toolResultsMode !== "off" && p.toolResultsMode !== "observe" && p.toolResultsMode !== "reduce") throw new Error("\u5DE5\u5177\u7ED3\u679C\u7CBE\u7B80\u6A21\u5F0F\u5FC5\u987B\u4E3A off\u3001observe \u6216 reduce");
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
    absoluteTargetTokens: [1e3, 1e9],
    toolResultsMaxChars: [2e3, 4e6],
    toolResultsMinSavings: [100, 1e6],
    archiveReadBudget: [500, 6e3],
    archiveSearchLimit: [1, 8]
  };
  for (const [key, [min, max]] of Object.entries(ranges)) {
    const value = p[key];
    if (!Number.isFinite(value) || value < min || value > max) throw new Error(`${key} \u5FC5\u987B\u5728 ${min}\u2013${max} \u4E4B\u95F4`);
  }
  if (p.historyMode === "custom" && p.targetPercent > p.triggerPercent - p.earlyPercent - 10) throw new Error("\u81EA\u5B9A\u4E49\u5360\u7528\u4E0A\u9650\u987B\u6BD4\u5B9E\u9645\u68C0\u67E5\u9608\u503C\u81F3\u5C11\u4F4E 10 \u4E2A\u767E\u5206\u70B9");
  if (p.historyMode === "custom" && p.absoluteEnabled && p.absoluteTargetTokens > Math.floor(p.absoluteTriggerTokens * 0.8)) throw new Error("\u7EDD\u5BF9\u5360\u7528\u4E0A\u9650\u987B\u6BD4\u7EDD\u5BF9\u8F6F\u89E6\u53D1\u81F3\u5C11\u4F4E 20%");
  for (const key of ["recentTokens", "summaryMaxTokens", "maxPasses", "timeoutMs", "idleMinutes", "formatRepairMaxTokens", "absoluteTriggerTokens", "absoluteTargetTokens", "toolResultsMaxChars", "toolResultsMinSavings", "archiveReadBudget", "archiveSearchLimit"]) {
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
function idleFloorTokens(policy, window, outputReserve) {
  const limits = budget(policy, window, outputReserve);
  const minimumPercent = policy.historyMode === "automatic" ? policy.idleMinPercent : Math.max(policy.idleMinPercent, policy.targetPercent + 10);
  const percentFloor = window * minimumPercent / 100;
  return Math.min(percentFloor, limits.admission);
}
export {
  budget,
  defaults,
  idleFloorTokens,
  validatePolicy
};
