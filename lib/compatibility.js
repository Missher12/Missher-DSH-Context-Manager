// src/compatibility.ts
import { BasicCompactionEngine } from "@deepseek-ai/dsh-compaction-basic";
var COMPACTION_HOST_VERSION = 1;
var CONTEXT_MANAGER_ORIGIN = "@missher/dsh-context-manager";
var CONTEXT_ENGINE_MODULE = "@missher/dsh-context-manager/engine";
var BASIC_COMPACTION_MODULE = "@deepseek-ai/dsh-compaction-basic";
var CONTEXT_MANAGER_PRESETS = Object.freeze(["standard", "ptc", "cordis"]);
var CONTEXT_BASIC_IDLE_SIDECAR = Symbol.for("@missher/dsh-context-manager/basic-idle-sidecar/v1");
var COMPACTION_HOST_V1_INTERFACES = Object.freeze([
  "agentPresets.compactionHost.version = 1",
  "agentPresets.compactionHost.register(owner, registration)",
  "agentPresets.compactionHost.bindingFor(agentContext)",
  "agentPresets.compactionHost.retained()"
]);
var hostRuntimeReadout;
function readHostRuntimeVersion() {
  return hostRuntimeReadout ??= (async () => {
    try {
      const appBoot = await import("@deepseek-ai/dsh-app-boot");
      const version = appBoot.getDshRuntimeVersion?.();
      if (typeof version === "string" && version.trim()) {
        return { state: "available", version: version.trim(), source: "@deepseek-ai/dsh-app-boot" };
      }
    } catch {
    }
    return { state: "unavailable", source: "unavailable" };
  })();
}
function resolveContextCompactionPath(probe, integration, sidecar, sidecarReason) {
  if (probe.state === "supported") {
    if (integration.state === "registered") return { path: "host-registration", state: "ready", reasonCode: "host-provider-ready" };
    if (integration.state === "pending") return { path: "host-registration", state: "pending", reasonCode: "host-provider-pending" };
    if (integration.state === "failed") return { path: "host-registration", state: "failed", reasonCode: "host-provider-failed" };
    if (integration.state === "inactive") return { path: "host-registration", state: "inactive", reasonCode: "host-provider-inactive" };
    return { path: "host-registration", state: "unknown", reasonCode: "host-provider-unknown" };
  }
  if (sidecar === "active") return { path: "request-gate-sidecar", state: "ready", reasonCode: "sidecar-ready" };
  if (sidecar === "pending") return { path: "request-gate-sidecar", state: "pending", reasonCode: "sidecar-pending" };
  if (sidecar === "blocked") return {
    path: "request-gate-sidecar",
    state: "blocked",
    reasonCode: "sidecar-blocked",
    ...sidecarReason ? { reason: sidecarReason } : {}
  };
  if (sidecar === "failed") return {
    path: "request-gate-sidecar",
    state: "failed",
    reasonCode: "sidecar-failed",
    ...sidecarReason ? { reason: sidecarReason } : {}
  };
  if (probe.state === "unsupported") return { path: "host-provider-unchanged", state: "inactive", reasonCode: "sidecar-inactive" };
  return { path: "unknown", state: "unknown", reasonCode: "host-capability-unknown" };
}
function readContextEngineStartupState(engine) {
  try {
    const read = engine?.startupReadiness;
    if (typeof read !== "function") return { state: "blocked", reason: "\u9694\u79BB\u5F15\u64CE\u672A\u516C\u5F00\u542F\u52A8\u6838\u9A8C\u72B6\u6001" };
    const proof = read.call(engine);
    if (proof && typeof proof === "object" && proof.ready === true) return { state: "ready" };
    const reason = proof && typeof proof === "object" && typeof proof.reason === "string" ? proof.reason.trim() : "";
    return { state: "blocked", reason: reason || "\u9694\u79BB\u5F15\u64CE\u542F\u52A8\u6838\u9A8C\u672A\u901A\u8FC7" };
  } catch (error) {
    return { state: "blocked", reason: `\u8BFB\u53D6\u9694\u79BB\u5F15\u64CE\u542F\u52A8\u6838\u9A8C\u5931\u8D25\uFF1A${error instanceof Error ? error.message : String(error)}` };
  }
}
function hostCapabilityReadout(probe, integration = { state: "inactive", reason: "Context Manager service is not active" }) {
  return {
    state: probe.state,
    reason: probe.state === "supported" ? "Host compaction API v1 is available" : probe.reason,
    reasonCode: probe.reasonCode,
    missingInterfaces: [...probe.missingInterfaces],
    ...probe.state === "unsupported" && probe.version !== void 0 ? { version: probe.version } : {},
    integration: { ...integration }
  };
}
function resolveCompactionHost(ctx) {
  let registry;
  try {
    registry = ctx.get("agentPresets");
  } catch {
    return { state: "unknown", reason: "Agent preset registry could not be read", reasonCode: "registry-unreadable", missingInterfaces: [] };
  }
  if (registry === void 0 || registry === null) {
    return { state: "unknown", reason: "Agent preset registry is not available yet", reasonCode: "registry-unavailable", missingInterfaces: [] };
  }
  let value;
  try {
    value = registry.compactionHost;
  } catch {
    return {
      state: "unsupported",
      reason: "Host compaction capability could not be read",
      reasonCode: "compaction-host-unreadable",
      missingInterfaces: ["agentPresets.compactionHost"]
    };
  }
  if (value === void 0 || value === null || typeof value !== "object") {
    return {
      state: "unsupported",
      reason: "Host cannot register or select an enhanced Context compaction provider; per-session Basic and sidecar status is reported separately",
      reasonCode: "compaction-host-missing",
      missingInterfaces: COMPACTION_HOST_V1_INTERFACES
    };
  }
  const candidate = value;
  let version;
  try {
    version = candidate.version;
  } catch {
    return {
      state: "unsupported",
      reason: "Host compaction API members could not be read",
      reasonCode: "compaction-host-unreadable",
      missingInterfaces: ["agentPresets.compactionHost.version"]
    };
  }
  if (version !== COMPACTION_HOST_VERSION) {
    return {
      state: "unsupported",
      version,
      reason: `Host compaction API v${String(version ?? "unknown")} is unsupported; expected v${COMPACTION_HOST_VERSION}`,
      reasonCode: "version-mismatch",
      missingInterfaces: ["agentPresets.compactionHost.version = 1"]
    };
  }
  let register;
  let bindingFor;
  let retained;
  try {
    register = candidate.register;
    bindingFor = candidate.bindingFor;
    retained = candidate.retained;
  } catch {
    return {
      state: "unsupported",
      version,
      reason: "Host compaction API methods could not be read",
      reasonCode: "compaction-host-unreadable",
      missingInterfaces: ["agentPresets.compactionHost methods"]
    };
  }
  const missingInterfaces = [
    ...typeof register !== "function" ? ["agentPresets.compactionHost.register(owner, registration)"] : [],
    ...typeof bindingFor !== "function" ? ["agentPresets.compactionHost.bindingFor(agentContext)"] : [],
    ...typeof retained !== "function" ? ["agentPresets.compactionHost.retained()"] : []
  ];
  if (missingInterfaces.length > 0) {
    return {
      state: "unsupported",
      version,
      reason: "Host compaction API v1 is incomplete; per-session Basic and sidecar status is reported separately",
      reasonCode: "methods-missing",
      missingInterfaces
    };
  }
  return { state: "supported", capability: candidate, reasonCode: "supported", missingInterfaces: [] };
}
function activeCompactionService(ctx, agentContext, agent) {
  if (agent !== void 0) {
    let registry;
    try {
      registry = ctx.get("agentPresets");
    } catch {
      registry = void 0;
    }
    try {
      const service = registry?.serviceFor?.(agent, "compaction");
      if (service !== void 0) return service;
    } catch {
    }
  }
  try {
    return agentContext?.get("compaction");
  } catch {
    return void 0;
  }
}
function isExactBasicService(service) {
  if (!(service instanceof BasicCompactionEngine)) return false;
  try {
    return Object.getPrototypeOf(service) === BasicCompactionEngine.prototype;
  } catch {
    return false;
  }
}
function isNativeBasicCompaction(ctx, agentContext, agent) {
  const service = activeCompactionService(ctx, agentContext, agent);
  return isExactBasicService(service);
}
function readAgentCompaction(ctx, agentContext, agent) {
  const probe = resolveCompactionHost(ctx);
  if (!agentContext) {
    return { mode: "unknown", hostCapability: probe.state, reason: "No active Agent binding is available for this session" };
  }
  if (probe.state !== "supported") {
    const service = activeCompactionService(ctx, agentContext, agent);
    if (isExactBasicService(service)) {
      return {
        mode: "native",
        hostCapability: probe.state,
        provider: BASIC_COMPACTION_MODULE,
        reason: "Official Basic is active; Context sidecar capabilities are reported separately"
      };
    }
    if (service !== void 0) {
      return {
        mode: "other",
        hostCapability: probe.state,
        reason: "A compaction provider is active, but its Host binding is not exposed"
      };
    }
    return { mode: "unknown", hostCapability: probe.state, reason: probe.reason };
  }
  let binding;
  try {
    binding = probe.capability.bindingFor(agentContext);
  } catch {
    return { mode: "unknown", hostCapability: "supported", reason: "Host could not read this Agent binding" };
  }
  if (!binding) return { mode: "unknown", hostCapability: "supported", reason: "Host returned no binding for this Agent" };
  const detail = {
    hostCapability: "supported",
    agentPreset: binding.agentPreset,
    generation: binding.generation,
    ...binding.compactionProvider === void 0 ? {} : { provider: binding.compactionProvider },
    source: binding.compactionSource,
    selectable: binding.selectable
  };
  if (!binding.available) {
    return { ...detail, mode: "unavailable", reason: "This Agent binding is retained but its provider or owner is unavailable" };
  }
  if (binding.compactionProvider === void 0) {
    return { ...detail, mode: "unconfigured", reason: "This preset has no compaction provider in its actual binding" };
  }
  if (binding.compactionProvider === CONTEXT_ENGINE_MODULE && (binding.compactionSource === "declaration" || binding.registrationOrigin === CONTEXT_MANAGER_ORIGIN)) {
    return { ...detail, mode: "enhanced", reason: "Context enhancement is active for this Agent" };
  }
  if (binding.compactionProvider === BASIC_COMPACTION_MODULE) {
    return { ...detail, mode: "native", reason: "The Host compaction provider is active for this Agent" };
  }
  return { ...detail, mode: "other", reason: "A different compaction provider is active for this Agent" };
}
function isEnhancedBinding(readout) {
  return readout.mode === "enhanced";
}
export {
  BASIC_COMPACTION_MODULE,
  COMPACTION_HOST_VERSION,
  CONTEXT_BASIC_IDLE_SIDECAR,
  CONTEXT_ENGINE_MODULE,
  CONTEXT_MANAGER_ORIGIN,
  CONTEXT_MANAGER_PRESETS,
  hostCapabilityReadout,
  isEnhancedBinding,
  isNativeBasicCompaction,
  readAgentCompaction,
  readContextEngineStartupState,
  readHostRuntimeVersion,
  resolveCompactionHost,
  resolveContextCompactionPath
};
