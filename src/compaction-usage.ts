import type { InspectedCompaction, EfficiencyRequestRow } from './inspector-types.ts'

export interface PostCheckpointRange {
  startSeq: number
  endSeq: number
  boundaryKnown: boolean
  truncated: boolean
  rows: EfficiencyRequestRow[]
}

/** Sequence-bounded request rows after one applied checkpoint and before the next recorded compaction. */
export function postCheckpointRequestRange(
  entries: readonly InspectedCompaction[],
  currentId: string,
  cutSeq: number,
  requests: readonly EfficiencyRequestRow[],
): PostCheckpointRange | null {
  const index = entries.findIndex(entry => entry.id === currentId)
  const current = entries[index]
  if (!current || current.checkpointSeq === undefined) return null
  const startSeq = current.checkpointSeq + 1
  const next = entries.slice(index + 1).find(entry => entry.kind === 'compact' || entry.kind === 'prune')
  const boundaryKnown = !next || next.startSeq !== undefined
  const endSeq = next?.startSeq ?? cutSeq + 1
  const rows = boundaryKnown ? requests.filter(row => row.seq >= startSeq && row.seq < endSeq) : []
  const earliestRequest = requests[0]?.seq
  return { startSeq, endSeq: Math.max(startSeq, endSeq), boundaryKnown,
    truncated: requests.length >= 200 && earliestRequest !== undefined && earliestRequest > startSeq,
    rows }
}

/** Settled model requests inside the recorded compression transaction only. */
export function compactionRequestRange(
  entries: readonly InspectedCompaction[],
  currentId: string,
  requests: readonly EfficiencyRequestRow[],
): PostCheckpointRange | null {
  const current = entries.find(entry => entry.id === currentId)
  if (!current || current.kind !== 'compact' || current.startSeq === undefined) return null
  const endSeq = current.checkpointSeq ?? current.endSeq
  if (endSeq === undefined || endSeq < current.startSeq) return null
  const startSeq = current.startSeq + 1
  const rows = requests.filter(row => row.seq >= startSeq && row.seq <= endSeq)
  const earliestRequest = requests[0]?.seq
  return { startSeq, endSeq, boundaryKnown: true,
    truncated: requests.length >= 200 && earliestRequest !== undefined && earliestRequest > startSeq,
    rows }
}
