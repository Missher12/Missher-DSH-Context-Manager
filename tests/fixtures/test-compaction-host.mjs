import {
  BASIC_COMPACTION_MODULE,
  CONTEXT_ENGINE_MODULE,
  CONTEXT_MANAGER_ORIGIN,
} from '../../lib/compatibility.js'

/** A small v1 capability for service/engine unit tests; never used for Host acceptance. */
export function installTestCompactionHost(ctx) {
  let selected
  const explicit = new WeakMap()
  const retained = new Set()
  const makeBinding = (provider, registration) => ({
    agentPreset: 'fixture', owner: 'fixture', generation: 1,
    ownerAlive: true, available: true, selectable: true,
    compactionSource: registration ? 'registration' : 'declaration',
    compactionProvider: provider,
    ...(registration ? { registrationOrigin: registration.origin, registrationRevision: registration.revision } : {}),
  })
  const capability = {
    version: 1,
    get selected() { return selected },
    async register(owner, definition) {
      const handle = {
        ...definition,
        presets: [...definition.presets],
        requires: [...(definition.requires ?? [])],
        ownerFiber: owner.fiber,
        async revoke() { if (selected === handle) selected = undefined },
      }
      selected = handle
      owner.effect(() => async () => { await handle.revoke() }, 'test-compaction-host.registration')
      return handle
    },
    bindingFor(agentContext) {
      const binding = explicit.get(agentContext) ?? makeBinding(
        selected?.module ?? BASIC_COMPACTION_MODULE,
        selected,
      )
      retained.add(binding)
      return binding
    },
    retained() { return [...retained] },
  }
  let registry = ctx.get('agentPresets')
  if (registry === undefined) {
    registry = { compactionHost: capability }
    ctx.provide('agentPresets', registry)
  } else {
    Object.defineProperty(registry, 'compactionHost', { configurable: true, value: capability })
  }

  return {
    capability,
    bind(agentContext, mode = 'enhanced') {
      const provider = mode === 'native' ? BASIC_COMPACTION_MODULE : CONTEXT_ENGINE_MODULE
      const binding = makeBinding(provider, mode === 'enhanced' ? selected : undefined)
      explicit.set(agentContext, binding)
      retained.add(binding)
      return binding
    },
  }
}
