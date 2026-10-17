// src/compatibility.ts
var COMPACTION_HOST_VERSION = 1;
var CONTEXT_MANAGER_ORIGIN = "@missher/dsh-context-manager";
var CONTEXT_ENGINE_MODULE = "@missher/dsh-context-manager/engine";
var BASIC_COMPACTION_MODULE = "@deepseek-ai/dsh-compaction-basic";
var CONTEXT_MANAGER_PRESETS = Object.freeze(["standard", "ptc", "cordis"]);
function hostCapabilityReadout(probe, integration = { state: "inactive", reason: "Context Manager service is not active" }) {
  return {
    state: probe.state,
    reason: probe.state === "supported" ? "Host compaction API v1 is available" : probe.reason,
    ...probe.state === "unsupported" && probe.version !== void 0 ? { version: probe.version } : {},
    integration: { ...integration }
  };
}
function resolveCompactionHost(ctx) {
  let registry;
  try {
    registry = ctx.get("agentPresets");
  } catch {
    registry = void 0;
  }
  if (registry === void 0 || registry === null) {
    return { state: "unknown", reason: "Agent preset registry is not available yet" };
  }
  let value;
  try {
    value = registry.compactionHost;
  } catch {
    return { state: "unsupported", reason: "Host compaction capability could not be read" };
  }
  if (value === void 0 || value === null || typeof value !== "object") {
    return { state: "unsupported", reason: "Host does not expose the compaction provider capability; saved Context policies are not active" };
  }
  const candidate = value;
  if (candidate.version !== COMPACTION_HOST_VERSION) {
    return { state: "unsupported", version: candidate.version, reason: `Host compaction API v${String(candidate.version ?? "unknown")} is unsupported; expected v${COMPACTION_HOST_VERSION}` };
  }
  if (typeof candidate.register !== "function" || typeof candidate.bindingFor !== "function" || typeof candidate.retained !== "function") {
    return { state: "unsupported", version: candidate.version, reason: "Host compaction API v1 is incomplete; saved Context policies are not active" };
  }
  return { state: "supported", capability: candidate };
}
function readAgentCompaction(ctx, agentContext) {
  const probe = resolveCompactionHost(ctx);
  if (probe.state !== "supported") {
    return { mode: "unknown", hostCapability: probe.state, reason: probe.reason };
  }
  if (!agentContext) {
    return { mode: "unknown", hostCapability: "supported", reason: "No active Agent binding is available for this session" };
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
  CONTEXT_ENGINE_MODULE,
  CONTEXT_MANAGER_ORIGIN,
  CONTEXT_MANAGER_PRESETS,
  hostCapabilityReadout,
  isEnhancedBinding,
  readAgentCompaction,
  resolveCompactionHost
};
