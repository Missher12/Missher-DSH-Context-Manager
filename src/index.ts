import { Context, Service } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { Volatile } from '@deepseek-ai/cosmokit'
import type {} from '@deepseek-ai/dsh-settings'
import { defaults, validatePolicy, type Policy } from './policy.ts'
import { diagnosticsProjection } from './diagnostics.ts'

declare module '@deepseek-ai/cordis' { interface Context { contextManager: ContextManager } }
export interface Config { policy: Volatile<Policy> }

/** A single live policy shared by isolated preset engines. */
export default class ContextManager extends Service {
  static Config = z.object({
    policy: z.object({
      enabled: z.boolean().default(defaults.enabled),
      triggerPercent: z.number().min(50).max(95).default(defaults.triggerPercent),
      targetPercent: z.number().min(10).max(75).default(defaults.targetPercent),
      earlyPercent: z.number().min(0).max(5).default(defaults.earlyPercent),
      safetyPercent: z.number().min(1).max(10).default(defaults.safetyPercent),
      summaryMaxTokens: z.number().min(256).max(32768).step(1).default(defaults.summaryMaxTokens),
      maxPasses: z.number().min(1).max(2).step(1).default(defaults.maxPasses),
      timeoutMs: z.number().min(1000).max(300000).step(1).default(defaults.timeoutMs),
    }).default(defaults).volatile(),
  })

  constructor(ctx: Context, public config: Config) {
    super(ctx, 'contextManager')
    this.snapshot()
    ctx.inject(['sessionProjections'], child => {
      child.sessionProjections.register(diagnosticsProjection)
    })
    ctx.inject(['settings'], child => {
      child.effect(() => child.settings.configure({ auto: false }, ctx.fiber))
    })
  }

  /** Freeze one admission's policy; edits take effect on the next request. */
  snapshot(): Readonly<Policy> {
    const result = { ...this.config.policy.get() }
    validatePolicy(result)
    return Object.freeze(result)
  }
}
