/** Read-only chart values. Category estimates retain their original token counts. */
import type { Category, Inspection } from './inspector-types.ts'
import { budget, type Policy } from './policy.ts'

export const contextGroups = [
  { id: 'summary', categories: ['summary'] },
  { id: 'tool', categories: ['tool'] },
  { id: 'message', categories: ['user', 'assistant'] },
  { id: 'instruction', categories: ['system', 'tools', 'inject', 'skill'] },
] as const satisfies readonly { id: string; categories: readonly Category[] }[]
export type ContextGroup = typeof contextGroups[number]['id']
export interface ChartSlice { id: ContextGroup | 'other' | 'free' | 'reserve'; value: number; share: number }

/** Tenths of a percent sum to 100 while bar widths use unrounded values. */
export function percentages(values: readonly number[]): number[] {
  const total = values.reduce((sum, value) => sum + value, 0)
  if (total <= 0) return values.map(() => 0)
  const raw = values.map(value => value / total * 1000)
  const units = raw.map(Math.floor)
  const order = raw.map((value, index) => ({ index, fraction: value - units[index]! })).sort((a, b) => b.fraction - a.fraction || a.index - b.index)
  const remaining = 1000 - units.reduce((sum, value) => sum + value, 0)
  for (let i = 0; i < remaining; i++) units[order[i]!.index]!++
  return units.map(value => value / 10)
}

/** Fill the recorded window without distributing an unclassified usage delta
 * over the text categories. When estimates exceed the host reading, use the
 * larger estimate for remaining capacity and retain both readings for the UI.
 * The current admission check separates usable space from compaction reserve;
 * historical cuts never inherit today's policy. Occupancy may consume reserve.
 */
export function composition(data: Pick<Inspection, 'parts' | 'pressure' | 'pressureHistory' | 'model' | 'historical'>, policy?: Policy) {
  const slices: ChartSlice[] = contextGroups.map(group => ({ id: group.id, value: data.parts.filter(part => group.categories.some(category => category === part.category)).reduce((sum, part) => sum + part.tokens, 0), share: 0 }))
  const content = slices.reduce((sum, item) => sum + item.value, 0)
  const cut = data.pressureHistory.at(-1)
  const capacity = data.pressure?.window ?? cut?.window ?? null
  const window = capacity !== null && capacity > 0 ? capacity : null
  const measured = data.pressure?.projected ?? cut?.tokens ?? null
  const used = Math.max(content, measured ?? 0)
  const other = used - content
  if (other > 0) slices.push({ id: 'other', value: other, share: 0 })
  const gate = policy?.enabled && !data.historical && window !== null && data.model?.maxTokens != null ? budget(policy, window, data.model.maxTokens) : null
  const limit = gate?.admission ?? null
  const free = window === null ? null : Math.max(0, (limit ?? window) - used)
  const reserve = gate === null ? null : Math.max(0, gate.window - Math.max(used, gate.admission))
  if (free !== null) slices.push({ id: 'free', value: free, share: 0 })
  if (reserve !== null) slices.push({ id: 'reserve', value: reserve, share: 0 })
  const total = slices.reduce((sum, item) => sum + item.value, 0)
  const shares = percentages(slices.map(item => item.value))
  return { content, used, measured, free, reserve, limit, total, window, overflow: window !== null && used > window, slices: slices.map((item, index) => ({ ...item, share: shares[index]! })) }
}

/** Disjoint usage buckets: the cached input is already part of total input. */
export function usageSlices(usage: Inspection['usage']) {
  if (usage === null) return null
  const values = [usage.uncached, usage.cacheRead, usage.cacheWrite, usage.output]
  if (values.some(value => !Number.isFinite(value) || value < 0)) return null
  const total = values.reduce((sum, value) => sum + value, 0)
  return { total, values, shares: percentages(values), hit: usage.input > 0 ? usage.cacheRead / usage.input * 100 : null }
}
