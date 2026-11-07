import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { attributeSession, type SummaryReference } from './efficiency.ts'
import { estimateSessionCost } from './session-cost.ts'

export interface TeamRosterMember {
  id: string
  name: string
  role: 'lead' | 'teammate'
  phase: 'provisioning' | 'active' | 'failed'
}

export interface TeamRoster {
  rootId: string
  members: readonly TeamRosterMember[]
}

export interface SummaryLedgerCoverageInput {
  since: number
  attempts: number
  unknownAttempts: number
  recent: readonly { id: string; compactionId: string; startedAt: number }[]
}

/** The aggregate ledger is complete only when every attempt still maps to an observed compression. */
export function resolveSummaryCoverage(
  compactions: readonly { id: string; startedAt: number }[],
  stats: SummaryLedgerCoverageInput | undefined,
): 'complete' | 'partial' | 'unknown' {
  if (!stats) return compactions.length === 0 ? 'complete' : 'unknown'
  if (stats.unknownAttempts > 0 || stats.attempts !== stats.recent.length) return 'partial'
  const starts = new Map(compactions.map(item => [item.id, item.startedAt]))
  if (compactions.some(item => item.startedAt < stats.since)) return 'partial'
  if (stats.recent.some(item => {
    const startedAt = starts.get(item.compactionId)
    return startedAt === undefined || startedAt < stats.since || item.startedAt < stats.since
  })) return 'partial'
  if (compactions.some(item => !stats.recent.some(attempt => attempt.compactionId === item.id))) return 'partial'
  return 'complete'
}

export interface VerifiedTeam {
  teamId: string
  leadId: string
  members: readonly TeamRosterMember[]
}

/** A projection containing only the lead is the normal non-team state. */
export function resolveVerifiedTeam(targetId: string, ancestorIds: readonly string[], rosters: readonly TeamRoster[]): VerifiedTeam | null {
  const ancestors = new Set(ancestorIds)
  for (const roster of rosters) {
    if (!roster.rootId || !roster.members.some(member => member.role === 'lead' && member.id === roster.rootId)) continue
    const unique = new Map<string, TeamRosterMember>()
    for (const member of roster.members) {
      if (!member.id || (member.role !== 'lead' && member.role !== 'teammate') || unique.has(member.id)) continue
      unique.set(member.id, member)
    }
    const lead = unique.get(roster.rootId)
    const teammates = [...unique.values()].filter(member => member.role === 'teammate' && member.id !== roster.rootId)
    if (!lead || teammates.length === 0) continue
    const targetIsLead = targetId === roster.rootId
    const targetIsMember = ancestors.has(roster.rootId) && teammates.some(member => member.id === targetId)
    if (!targetIsLead && !targetIsMember) continue
    return { teamId: roster.rootId, leadId: roster.rootId, members: [lead, ...teammates] }
  }
  return null
}

/** Attribute only events appended by this session. Inherited routes and calls are deliberately omitted. */
export function attributeOwnedSession(events: readonly SessionEvent[], inheritedEventCount: number, summary?: SummaryReference) {
  if (!Number.isSafeInteger(inheritedEventCount) || inheritedEventCount < 0 || inheritedEventCount > events.length) {
    throw new RangeError('Invalid inherited event boundary')
  }
  const owned = events.slice(inheritedEventCount)
  const attribution = attributeSession(owned, { ...(summary === undefined ? {} : { summary }), fingerprint: false })
  return { attribution, cost: estimateSessionCost(attribution) }
}

export interface TeamUsageAggregateRow {
  status: 'ready' | 'analysis-limit' | 'unavailable'
  totalTokens: number | null
  tokensPartial: boolean
  referenceCost: number | null
  costPartial: boolean
}

/** Sums reported subtotals while keeping missing members and unpriced usage visible. */
export function aggregateTeamUsage(rows: readonly TeamUsageAggregateRow[]) {
  const known = rows.filter(row => row.status === 'ready')
  const unknownMembers = rows.filter(row => row.status !== 'ready' || row.totalTokens === null).length
  const knownTokens = known.reduce((sum, row) => sum + (row.totalTokens ?? 0), 0)
  const costRows = known.filter(row => row.referenceCost !== null)
  const referenceCost = costRows.length === 0 ? null : costRows.reduce((sum, row) => sum + row.referenceCost!, 0)
  const tokensPartial = unknownMembers > 0 || known.some(row => row.tokensPartial)
  return {
    knownTokens,
    unknownMembers,
    tokensPartial,
    shareBasis: tokensPartial ? 'known-subtotal' as const : 'complete' as const,
    referenceCost,
    costPartial: unknownMembers > 0 || rows.some(row => row.costPartial || row.referenceCost === null),
  }
}
