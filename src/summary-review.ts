import type { CheckpointValue } from './checkpoint.ts'

export type CheckpointField = keyof CheckpointValue
const FIELDS = ['goal', 'constraints', 'completed', 'pending', 'evidence', 'next', 'uncertainties'] as const satisfies readonly CheckpointField[]
const MAX_ANCHORS = 40
const normalize = (value: string) => value.replace(/\s+/gu, ' ').trim()
const values = (checkpoint: CheckpointValue, field: CheckpointField): string[] => {
  const value = checkpoint[field]
  return typeof value === 'string' ? [value] : value
}

export interface CheckpointChange { text: string; field: CheckpointField }
export interface CheckpointMove { text: string; from: CheckpointField; to: CheckpointField }

/** Exact-text comparison only; a changed sentence is never called a semantic loss. */
export function compareCheckpointValues(previous: CheckpointValue, current: CheckpointValue) {
  const oldRows = FIELDS.flatMap(field => values(previous, field).map(text => ({ text, field, key: normalize(text) })))
  const newRows = FIELDS.flatMap(field => values(current, field).map(text => ({ text, field, key: normalize(text) })))
  const oldLeft = new Set(oldRows.map((_, index) => index))
  const newLeft = new Set(newRows.map((_, index) => index))
  const retained: CheckpointChange[] = []
  const moved: CheckpointMove[] = []
  for (let oldIndex = 0; oldIndex < oldRows.length; oldIndex++) {
    const old = oldRows[oldIndex]!
    const newIndex = newRows.findIndex((row, index) => newLeft.has(index) && row.field === old.field && row.key === old.key)
    if (newIndex < 0) continue
    oldLeft.delete(oldIndex); newLeft.delete(newIndex)
    retained.push({ text: newRows[newIndex]!.text, field: old.field })
  }
  for (const oldIndex of [...oldLeft]) {
    const old = oldRows[oldIndex]!
    const newIndex = newRows.findIndex((row, index) => newLeft.has(index) && row.field !== old.field && row.key === old.key)
    if (newIndex < 0) continue
    const next = newRows[newIndex]!
    oldLeft.delete(oldIndex); newLeft.delete(newIndex)
    moved.push({ text: next.text, from: old.field, to: next.field })
  }
  return {
    retained,
    moved,
    added: [...newLeft].map(index => ({ text: newRows[index]!.text, field: newRows[index]!.field })),
    missing: [...oldLeft].map(index => ({ text: oldRows[index]!.text, field: oldRows[index]!.field })),
  }
}

/** Choose only the nearest earlier applied compression, ordered by immutable checkpoint seq. */
export function previousAppliedCheckpoint<T extends { id: string; kind: string; applied: boolean; checkpointSeq?: number }>(entries: readonly T[], currentSeq: number): T | null {
  return [...entries].filter(entry => entry.kind === 'compact' && entry.applied
    && typeof entry.checkpointSeq === 'number' && entry.checkpointSeq < currentSeq)
    .sort((a, b) => a.checkpointSeq! - b.checkpointSeq!).at(-1) ?? null
}

export interface RetentionSource { id: string; text: string }
export interface RetentionEvidenceItem { text: string; sourceIds: string[]; status: 'found' | 'review' }

type Anchor = { text: string; kind: 'path' | 'version' | 'date' | 'percent' | 'clause'; atoms: Anchor[] }
function anchorsIn(text: string): Anchor[] {
  const candidates: Anchor[] = []
  const add = (value: string, kind: Anchor['kind']) => {
    const normalized = normalize(value)
    if (normalized.length >= 3 && !candidates.some(candidate => candidate.text === normalized && candidate.kind === kind)) {
      candidates.push({ text: normalized, kind, atoms: [] })
    }
  }
  // Quoted/backtick paths preserve common local paths containing CJK or spaces.
  for (const match of text.matchAll(/["'`](\/(?:[^"'`<>\r\n]{1,240}))["'`]/gu)) add(match[1]!, 'path')
  for (const match of text.matchAll(/(?:[A-Za-z]:)?\/[\p{L}\p{N}._~%:@+-]+(?:\/[\p{L}\p{N}._~%:@+-]+)+/gu)) add(match[0], 'path')
  for (const match of text.matchAll(/(?:\bv\d+(?:\.\d+){1,3}|\b\d{4}-\d{2}-\d{2}|(?<![0-9.])[-+−]?\d+(?:\.\d+)?%)/gu)) {
    const kind = match[0]!.endsWith('%') ? 'percent' : match[0]!.startsWith('v') ? 'version' : 'date'
    add(match[0]!, kind)
  }
  const clauses = text.split(/(?<=[。！？.!?；;\n])/u).map(value => value.trim()).filter(Boolean)
  for (const clause of clauses) {
    if (/(?:必须|不得|不允许|不能|不要|保留|仅限|只能|待完成|未完成|待办|TODO|MUST(?: NOT)?|DO NOT|KEEP|PENDING|已完成|已验证|已验收|结论|结果为)/iu.test(clause)) {
      const value = clause.slice(0, 240).replace(/[。！？.!?；;\s]+$/u, '')
      const item = { text: normalize(value), kind: 'clause' as const, atoms: [] as Anchor[] }
      for (const atom of anchorsInWithoutClauses(value)) item.atoms.push(atom)
      if (!candidates.some(candidate => candidate.text === item.text && candidate.kind === item.kind)) candidates.push(item)
    }
  }
  return candidates
}

function anchorsInWithoutClauses(text: string): Anchor[] {
  const candidates: Anchor[] = []
  for (const match of text.matchAll(/["'`](\/(?:[^"'`<>\r\n]{1,240}))["'`]/gu)) candidates.push({ text: normalize(match[1]!), kind: 'path', atoms: [] })
  for (const match of text.matchAll(/(?:[A-Za-z]:)?\/[\p{L}\p{N}._~%:@+-]+(?:\/[\p{L}\p{N}._~%:@+-]+)+/gu)) candidates.push({ text: normalize(match[0]!), kind: 'path', atoms: [] })
  for (const match of text.matchAll(/(?:\bv\d+(?:\.\d+){1,3}|\b\d{4}-\d{2}-\d{2}|(?<![0-9.])[-+−]?\d+(?:\.\d+)?%)/gu)) {
    const kind = match[0]!.endsWith('%') ? 'percent' : match[0]!.startsWith('v') ? 'version' : 'date'
    candidates.push({ text: match[0]!, kind, atoms: [] })
  }
  return candidates
}

function exactAtom(text: string, anchor: Anchor): boolean {
  let index = text.indexOf(anchor.text)
  const pathCharacter = /[\p{L}\p{N}._~%:@+\-/]/u
  // Chinese prose may touch numeric anchors directly; only adjacent ASCII
  // identifier characters can extend the number/version token.
  const wordCharacter = /[A-Za-z0-9.]/u
  const signCharacter = /[+\-−]/u
  while (index >= 0) {
    const before = index > 0 ? text[index - 1]! : ''
    const afterIndex = index + anchor.text.length
    const after = afterIndex < text.length ? text[afterIndex]! : ''
    const boundary = anchor.kind === 'path' ? pathCharacter : wordCharacter
    const signedPercent = anchor.kind === 'percent' && !!before && signCharacter.test(before)
    if (!signedPercent && (!before || !boundary.test(before)) && (!after || !boundary.test(after))) return true
    index = text.indexOf(anchor.text, index + 1)
  }
  return false
}

function foundIn(text: string, anchor: Anchor): boolean {
  if (anchor.kind === 'path' || anchor.kind === 'version' || anchor.kind === 'date' || anchor.kind === 'percent') return exactAtom(text, anchor)
  return text.includes(anchor.text) && anchor.atoms.every(atom => exactAtom(text, atom))
}

/** Conservative literal evidence only. A miss is a prompt to review, never a failed summary. */
export function reviewRetentionEvidence(summary: CheckpointValue, sources: readonly RetentionSource[], sourcesComplete = true) {
  const summaryText = FIELDS.flatMap(field => values(summary, field)).map(normalize).join('\n')
  const byAnchor = new Map<string, { anchor: Anchor; ids: Set<string> }>()
  for (const source of sources) for (const anchor of anchorsIn(source.text)) {
    const key = `${anchor.kind}:${anchor.text}`
    const held = byAnchor.get(key) ?? { anchor, ids: new Set<string>() }
    held.ids.add(source.id); byAnchor.set(key, held)
  }
  const all = [...byAnchor.entries()]
  const scanComplete = sources.length > 0 && sourcesComplete && all.length <= MAX_ANCHORS
  const items: RetentionEvidenceItem[] = all.slice(0, MAX_ANCHORS).map(([, { anchor, ids }]) => ({ text: anchor.text,
    sourceIds: [...ids], status: foundIn(summaryText, anchor) ? 'found' : 'review' }))
  return { scanComplete, scope: 'recognized-literal-anchors-only' as const, items }
}
