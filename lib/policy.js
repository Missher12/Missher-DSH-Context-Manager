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
  summaryInstructions: ""
};
function validatePolicy(p) {
  if (typeof p.enabled !== "boolean") throw new Error("\u81EA\u52A8\u538B\u7F29\u5F00\u5173\u5FC5\u987B\u662F\u5E03\u5C14\u503C");
  if (typeof p.idleEnabled !== "boolean") throw new Error("\u95F2\u7F6E\u81EA\u52A8\u538B\u7F29\u5F00\u5173\u5FC5\u987B\u662F\u5E03\u5C14\u503C");
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
    idleMinPercent: [10, 95]
  };
  for (const [key, [min, max]] of Object.entries(ranges)) {
    const value = p[key];
    if (!Number.isFinite(value) || value < min || value > max) throw new Error(`${key} \u5FC5\u987B\u5728 ${min}\u2013${max} \u4E4B\u95F4`);
  }
  if (p.targetPercent > p.triggerPercent - p.earlyPercent - 10) throw new Error("\u538B\u7F29\u76EE\u6807\u987B\u6BD4\u5B9E\u9645\u68C0\u67E5\u9608\u503C\u81F3\u5C11\u4F4E 10 \u4E2A\u767E\u5206\u70B9");
  for (const key of ["summaryMaxTokens", "maxPasses", "timeoutMs", "idleMinutes"]) {
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
  const admission = Math.max(0, trigger - Math.ceil(window * policy.earlyPercent / 100));
  const target = Math.min(Math.floor(window * policy.targetPercent / 100), Math.floor(admission * 0.8));
  return { window, outputReserve, safety, hard, trigger, admission, target };
}
export {
  budget,
  defaults,
  validatePolicy
};
