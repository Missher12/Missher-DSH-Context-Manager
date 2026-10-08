/**
 * Durable, independently readable original-text archive for reduced tool
 * results.
 *
 * Three append-only JSONL manifests over content-addressed blob files:
 * - `content.jsonl` — immutable facts about one stored original (bytes, rule
 *   version, sizes). Written once per content id.
 * - `owners.jsonl` — one row per `(session, call, content)` grant. The same
 *   original shared by a second session or a fork gets its own row, so access
 *   and lifetime stay per session rather than inheriting the first owner.
 * - `outcomes.jsonl` — last-wins per grant: what the Host's authoritative final
 *   result did with the handed-out reference (`published`/`reverted`). Keeping
 *   it separate keeps the two fact manifests immutable, and replaying it after a
 *   restart is what makes a confirmed reduction durable instead of re-invented.
 *
 * Blobs are plain UTF-8 files named by their SHA-256, so an operator or any
 * other tool can read and export them after this plugin is uninstalled. The
 * manifests are metadata that can be rebuilt into an index at any time.
 *
 * Durability contract: the blob is fully written, flushed and renamed into
 * place *before* the content row that makes it addressable is appended, and
 * the owner row is flushed and its directory synced before the caller may
 * publish a short result. A crash can therefore leave an unreferenced blob
 * (harmless, reported by `scanOrphans`) but never a visible reference to an
 * unfinished original. Any failure is reported to the caller, which keeps the
 * Host's original treatment instead of publishing a reference it cannot honour.
 *
 * Platform limits are exactly the ones already established for the recovery
 * journal: file flushes are mandatory and never skipped, and on Windows only
 * the POSIX directory flush is skipped. That is a declared difference in
 * durability, not a claim of equal crash protection.
 * @module
 */

import fs from 'node:fs'
import { createHash } from 'node:crypto'
import { basename, dirname, isAbsolute, join, resolve } from 'node:path'

/** Independently readable archive layout version. Unknown versions are refused. */
export const ARCHIVE_FORMAT = 1
export const ARCHIVE_DIRECTORY = '.context-manager-archive'
export const CONTENT_ROW_VERSION = 1
export const OWNER_ROW_VERSION = 1
export const OUTCOME_ROW_VERSION = 1
/**
 * Default quota for the stored original blobs: the physical total of their
 * recorded bytes, including rows an interrupted or orphaned write left behind.
 * Exceeding it disables new reduction and never deletes. It is not a
 * whole-directory or whole-archive quota: the root manifest is excluded from
 * this total and each of the three JSONL manifests is bounded separately by its
 * own MAX_MANIFEST_BYTES and row cap.
 */
export const DEFAULT_MAX_TOTAL_BYTES = 512 * 1024 * 1024
const MAX_MANIFEST_BYTES = 64 * 1024 * 1024
const MAX_OWNER_ROWS = 100000
const MAX_CONTENT_ROWS = 100000
const MAX_OUTCOME_ROWS = 200000
const MAX_ROW_BYTES = 16 * 1024
/**
 * Physical blob files a reopen may reconcile before it refuses to guess.
 * Exceeding it is not an error: reads stay available and new references are
 * refused, because the remaining free space cannot be confirmed.
 */
const MAX_RECONCILE_FILES = 4096
const SHA = /^[a-f0-9]{64}$/u
const BLOB_NAME = /^[a-f0-9]{64}\.txt$/u
const NO_FOLLOW = fs.constants.O_NOFOLLOW ?? 0

/** One archived original: immutable content facts. */
export interface ArchiveContent {
  readonly contentId: string
  readonly bytes: number
  readonly originalChars: number
  readonly createdAt: number
}

/** One session's grant over one archived original. */
export interface ArchiveOwner {
  readonly contentId: string
  readonly sessionId: string
  readonly callId?: string
  readonly tool: string
  readonly rule: string
  readonly ruleVersion: number
  readonly shortenedChars: number
  /** False when the text was already truncated by something upstream. */
  readonly complete: boolean
  readonly at: number
}

export interface ArchiveSaveInput {
  readonly text: string
  readonly source: string
  readonly rule: string
  readonly ruleVersion: number
  readonly shortenedChars: number
  readonly sessionId: string
  readonly callId?: string
  /**
   * True only when the caller verified that the stored text is the complete
   * text the Host produced for this call (for example the producing tool
   * reported no truncation). An unverifiable case leaves this absent: the grant
   * is then recorded as not verified complete, never as complete.
   */
  readonly complete?: boolean
}

/** Durable archive volume. Volume is not saving: see {@link ArchiveSummary}. */
export interface ArchiveVolume {
  readonly originals: number
  readonly originalChars: number
  readonly archivedBytes: number
}

/** Durable outcome of one published reference; the only source of real savings. */
export interface ArchivePublished {
  /** References whose final Host result still carried the reduced text. */
  readonly references: number
  /** Characters of stored originals those references replaced. */
  readonly originalChars: number
  /** Characters the confirmed short texts carried. */
  readonly shortenedChars: number
  /** originalChars minus shortenedChars; a visible-text delta, never a bill. */
  readonly visibleCharsRemoved: number
}

/**
 * Bounded, session-scoped reduction view for the inspector. Two fact sets are
 * deliberately kept apart:
 * - {@link volume}: how much original text is stored. It grows even for a
 *   reduction that was never published or was later reverted, so it must never
 *   be presented as a saving.
 * - {@link published}: derived from durable per-reference outcome rows that the
 *   Host's authoritative final result confirmed, so it survives a restart and
 *   is the only figure that may be described as realised.
 * {@link pending} references are stored but not yet confirmed, and
 * {@link reverted} references were finally dropped by the Host.
 */
export interface ArchiveSummary {
  readonly volume: ArchiveVolume
  readonly published: ArchivePublished
  readonly pending: number
  readonly reverted: number
  readonly recent: readonly ArchiveOwner[]
  /** Declared limits of the published figures. */
  readonly notes: readonly string[]
}

export class ArchiveUnavailableError extends Error {}

function fail(message: string): never { throw new ArchiveUnavailableError(`Context archive: ${message}`) }
function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/** SHA-256 of the exact UTF-8 bytes; the only identity the archive trusts. */
export function hashText(text: string): string {
  return createHash('sha256').update(Buffer.from(text, 'utf8')).digest('hex')
}

function syncDirectory(root: string): void {
  // Windows directory handles cannot be flushed like POSIX ones (EPERM); the
  // regular-file flush before rename remains mandatory and is never skipped.
  if (process.platform === 'win32') return
  const fd = fs.openSync(root, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY)
  try { fs.fsyncSync(fd) } finally { fs.closeSync(fd) }
}

/** Create one private directory, accepting only a pre-existing real directory. */
function installDirectory(path: string): void {
  try { fs.mkdirSync(path, { mode: 0o700 }) } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
  }
  const stat = fs.lstatSync(path)
  if (!stat.isDirectory() || stat.isSymbolicLink()) fail('archive path is not a real directory')
}

function blobPath(root: string, contentId: string): string {
  if (!SHA.test(contentId)) fail('invalid content id')
  return join(root, contentId.slice(0, 2), contentId.slice(2, 4), `${contentId}.txt`)
}

/**
 * Read one append-only JSONL manifest with a bounded read: the size is checked
 * before any bytes are loaded. A torn final row (a process killed mid-append)
 * is reported instead of guessed, and the next append overwrites it.
 */
function scanManifest(path: string, maxRows: number): { rows: unknown[]; tornBytes: number } {
  let fd: number
  try { fd = fs.openSync(path, fs.constants.O_RDONLY | NO_FOLLOW) } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { rows: [], tornBytes: 0 }
    throw error
  }
  try {
    const stat = fs.fstatSync(fd)
    if (!stat.isFile()) fail('manifest is not a regular file')
    if (stat.size > MAX_MANIFEST_BYTES) fail(`manifest exceeds its ${MAX_MANIFEST_BYTES}-byte limit`)
    if (stat.size === 0) return { rows: [], tornBytes: 0 }
    const raw = fs.readFileSync(fd, 'utf8')
    const rows: unknown[] = []
    let tornBytes = 0, offset = 0
    while (offset < raw.length) {
      const next = raw.indexOf('\n', offset)
      if (next < 0) { tornBytes = Buffer.byteLength(raw.slice(offset)); break }
      const line = raw.slice(offset, next)
      offset = next + 1
      if (line.length === 0) continue
      if (Buffer.byteLength(line) > MAX_ROW_BYTES) fail('manifest row exceeds its size limit')
      let value: unknown
      try { value = JSON.parse(line) } catch { fail('manifest row is not valid JSON') }
      rows.push(value)
      if (rows.length > maxRows) fail('manifest exceeds its row limit')
    }
    return { rows, tornBytes }
  } finally { fs.closeSync(fd) }
}

/** Append one row at the true end of a manifest and flush it. */
class Manifest {
  private tornBytes = 0
  /** Set once this manifest's durable state could not be confirmed again. */
  private unusable?: string
  constructor(private readonly path: string, private readonly version: number,
    /** Reports an uncertain commit so the owning archive can stop publishing. */
    private readonly onUncertain: (reason: string) => void = () => {}) {}

  /**
   * Read the manifest with a hard row limit and remember any torn tail, so the
   * next append repairs it instead of writing past it.
   * @param maxRows - row ceiling for this manifest.
   * @returns the parsed rows, in file order.
   */
  open(maxRows: number): unknown[] {
    const { rows, tornBytes } = scanManifest(this.path, maxRows)
    this.tornBytes = tornBytes
    return rows
  }

  get torn(): number { return this.tornBytes }
  /** Why this manifest refuses further appends, once its state is unknown. */
  get failure(): string | undefined { return this.unusable }

  append(row: Record<string, unknown>): void {
    if (this.unusable !== undefined) fail(`manifest is not usable again: ${this.unusable}`)
    const line = `${JSON.stringify({ v: this.version, ...row })}\n`
    if (Buffer.byteLength(line) > MAX_ROW_BYTES) fail('manifest row exceeds its size limit')
    const fd = fs.openSync(this.path, fs.constants.O_CREAT | fs.constants.O_WRONLY | NO_FOLLOW, 0o600)
    try {
      const size = fs.fstatSync(fd).size
      // Explicit position: never rely on the file offset of a fresh handle, and
      // never append after a torn tail. An O_APPEND handle would append past
      // the tear, so the tear is truncated first and the row written at the
      // resulting end.
      const at = this.tornBytes > 0 && size >= this.tornBytes ? size - this.tornBytes : size
      if (at !== size) fs.ftruncateSync(fd, at)
      if (at > MAX_MANIFEST_BYTES) fail('manifest exceeds its size limit')
      // A short write is not a commit. The loop keeps asking for the remainder
      // and refuses to call a row durable while any byte is still unwritten: a
      // write that reports no progress at all is a hard failure, because
      // fsync would otherwise bless a truncated line.
      const bytes = Buffer.from(line, 'utf8')
      let written = 0
      while (written < bytes.length) {
        const count = fs.writeSync(fd, bytes, written, bytes.length - written, at + written)
        if (!Number.isSafeInteger(count) || count <= 0) fail(`manifest write made no progress after ${written} of ${bytes.length} bytes`)
        written += count
      }
      fs.fsyncSync(fd)
      this.tornBytes = 0
    } catch (error) {
      // The commit attempt started and its outcome is unknown: this manifest
      // must not be written again until a fresh, validated open. A failed
      // re-read is sticky, because a byte-length sentinel is not a state.
      const rescanned = this.rescanTorn()
      if (rescanned === undefined) this.unusable = 'the manifest could not be re-read after a failed commit'
      else this.tornBytes = rescanned
      this.onUncertain(rescanned === undefined
        ? 'manifest state could not be confirmed after a failed commit'
        : 'a manifest commit failed; its outcome is unknown')
      if (error instanceof ArchiveUnavailableError) throw error
      throw new ArchiveUnavailableError(`Context archive: cannot commit a manifest row: ${String(error)}`)
    } finally { fs.closeSync(fd) }
    // The row is only durable once the directory entry that names it is flushed
    // too; a failure here is the same uncertain commit as a failed fsync.
    try { syncDirectory(dirname(this.path)) } catch (error) {
      this.unusable = 'the directory entry could not be flushed after a manifest row'
      this.onUncertain(this.unusable)
      throw error instanceof ArchiveUnavailableError ? error : new ArchiveUnavailableError(`Context archive: cannot flush the manifest directory: ${String(error)}`)
    }
  }

  /**
   * Re-read the manifest after a failed append to learn where the durable end
   * really is.
   * @returns the torn byte count, or undefined when the manifest could not be
   * re-read at all — an unconfirmed state that must refuse further appends
   * instead of guessing a position.
   */
  private rescanTorn(): number | undefined {
    try {
      return scanManifest(this.path, MAX_MANIFEST_BYTES).tornBytes
    } catch {
      return undefined
    }
  }
}

function parseContent(value: unknown): ArchiveContent {
  if (!object(value) || value.v !== CONTENT_ROW_VERSION) fail('unsupported content row version')
  const { contentId, bytes, originalChars, createdAt } = value
  if (typeof contentId !== 'string' || !SHA.test(contentId)) fail('invalid content id')
  for (const [field, number] of [['bytes', bytes], ['originalChars', originalChars], ['createdAt', createdAt]] as const) {
    if (!Number.isSafeInteger(number) || (number as number) < 0) fail(`invalid ${field}`)
  }
  return { contentId, bytes: bytes as number, originalChars: originalChars as number, createdAt: createdAt as number }
}

function parseOwner(value: unknown): ArchiveOwner {
  if (!object(value) || value.v !== OWNER_ROW_VERSION) fail('unsupported owner row version')
  const { contentId, sessionId, callId, tool, rule, ruleVersion, shortenedChars, complete, at } = value
  if (typeof contentId !== 'string' || !SHA.test(contentId)) fail('invalid content id')
  if (typeof sessionId !== 'string' || sessionId.length === 0 || sessionId.length > 200) fail('invalid session identity')
  if (callId !== undefined && (typeof callId !== 'string' || callId.length > 200)) fail('invalid call identity')
  if (typeof tool !== 'string' || tool.length === 0 || tool.length > 120) fail('invalid tool identity')
  if (typeof rule !== 'string' || rule.length === 0 || rule.length > 80) fail('invalid rule identity')
  if (typeof complete !== 'boolean') fail('invalid completeness claim')
  for (const [field, number] of [['ruleVersion', ruleVersion], ['shortenedChars', shortenedChars], ['at', at]] as const) {
    if (!Number.isSafeInteger(number) || (number as number) < 0) fail(`invalid ${field}`)
  }
  return { contentId, sessionId, tool, rule, ruleVersion: ruleVersion as number,
    shortenedChars: shortenedChars as number, complete, at: at as number,
    ...(callId === undefined ? {} : { callId: callId as string }) }
}

/**
 * Append-only, last-wins outcome row for one `(session, call, content)` grant.
 * A separate file keeps the two fact manifests immutable: the grant row says a
 * reference was handed out, an outcome row says what the Host finally did with
 * it. Restarting replays both, so a confirmed saving is never re-invented and a
 * dropped reduction is never re-reported as effective.
 */
export type ArchiveOutcome = 'published' | 'reverted'

function parseOutcome(value: unknown): { key: string; outcome: ArchiveOutcome; reason?: string } {
  if (!object(value) || value.v !== OUTCOME_ROW_VERSION) fail('unsupported outcome row version')
  const { contentId, sessionId, callId, outcome, reason } = value
  if (typeof contentId !== 'string' || !SHA.test(contentId)) fail('invalid content id')
  if (typeof sessionId !== 'string' || sessionId.length === 0 || sessionId.length > 200) fail('invalid session identity')
  if (callId !== undefined && (typeof callId !== 'string' || callId.length > 200)) fail('invalid call identity')
  if (outcome !== 'published' && outcome !== 'reverted') fail('invalid outcome')
  if (reason !== undefined && (typeof reason !== 'string' || reason.length > 120)) fail('invalid outcome reason')
  return { key: grantKey(contentId, sessionId, callId as string | undefined), outcome,
    ...(reason === undefined ? {} : { reason: reason as string }) }
}

/** Identity of one grant; a call-less grant is its own row, never a wildcard. */
function grantKey(contentId: string, sessionId: string, callId?: string): string {
  return `${contentId}\u0000${sessionId}\u0000${callId ?? ''}`
}

/**
 * Append-only original-text archive. Opening never guesses a profile path: the
 * caller supplies the absolute Host-chosen root, and a read-only view never
 * creates storage as a side effect of being observed.
 */
export class TextArchive {
  private readonly contents = new Map<string, ArchiveContent>()
  private readonly owners: ArchiveOwner[] = []
  private readonly bySession = new Map<string, number[]>()
  /** One grant per `(content, session, call)` identity, so a replay stays one reference. */
  private readonly identities = new Map<string, ArchiveOwner>()
  private readonly outcomes = new Map<string, ArchiveOutcome>()
  private readonly reasons = new Map<string, string>()
  private totalBytes = 0
  private closed = false
  /**
   * Sticky reason this instance must not publish new references. Any uncertain
   * commit sets it: a partially applied write must never be followed by another
   * reference from the same handle. Reads stay available; only a close plus a
   * validated reopen clears it.
   */
  private poisoned?: string
  /** Duplicate owner rows collapsed at open; they never become extra references. */
  private duplicateOwnerRows = 0
  /** Owner rows whose facts disagreed with the first row for the same identity. */
  private conflictingOwnerRows = 0
  /** How many physical blob files the last bounded reconcile inspected. */
  private reconciledFiles = 0
  private readonly content: Manifest
  private readonly owner: Manifest
  private readonly outcome: Manifest

  private constructor(private readonly root: string, readonly maxTotalBytes: number) {
    const uncertain = (reason: string): void => this.poison(reason)
    this.content = new Manifest(join(root, 'content.jsonl'), CONTENT_ROW_VERSION, uncertain)
    this.owner = new Manifest(join(root, 'owners.jsonl'), OWNER_ROW_VERSION, uncertain)
    this.outcome = new Manifest(join(root, 'outcomes.jsonl'), OUTCOME_ROW_VERSION, uncertain)
  }

  /**
   * Open an existing archive, or create one when `create` is set.
   * @param root - absolute archive directory chosen by the Host profile.
   * @param options - `create` allows directory creation; `maxTotalBytes` is the quota.
   */
  static open(root: string, options: { readonly create?: boolean; readonly maxTotalBytes?: number } = {}): TextArchive {
    if (!isAbsolute(root)) fail('root must be absolute')
    const target = resolve(root)
    const parent = fs.realpathSync(dirname(target))
    const directory = join(parent, basename(target))
    if (!fs.existsSync(directory)) {
      if (options.create !== true) fail('archive does not exist yet')
      installDirectory(directory)
      syncDirectory(parent)
    }
    const stat = fs.lstatSync(directory)
    if (!stat.isDirectory() || stat.isSymbolicLink()) fail('root must be a real directory')
    const archive = new TextArchive(directory, options.maxTotalBytes ?? DEFAULT_MAX_TOTAL_BYTES)
    const contentRows = archive.content.open(MAX_CONTENT_ROWS)
    const ownerRows = archive.owner.open(MAX_OWNER_ROWS)
    const outcomeRows = archive.outcome.open(MAX_OUTCOME_ROWS)
    for (const row of contentRows) {
      const entry = parseContent(row)
      if (!archive.contents.has(entry.contentId)) {
        archive.contents.set(entry.contentId, entry)
        archive.totalBytes += entry.bytes
      }
    }
    // One identity is one grant: a manifest retry that left a second row for the
    // same `(content, session, call)` must not become a second reference after a
    // restart. The first row wins; a row that disagrees with it is counted and
    // reported, never averaged or silently preferred.
    const identities = new Map<string, ArchiveOwner>()
    for (const row of ownerRows) {
      const owner = parseOwner(row)
      const key = grantKey(owner.contentId, owner.sessionId, owner.callId)
      const previous = identities.get(key)
      if (previous === undefined) { identities.set(key, owner); archive.remember(owner); continue }
      archive.duplicateOwnerRows++
      if (previous.rule !== owner.rule || previous.ruleVersion !== owner.ruleVersion
        || previous.shortenedChars !== owner.shortenedChars || previous.tool !== owner.tool
        || previous.complete !== owner.complete) archive.conflictingOwnerRows++
    }
    for (const row of outcomeRows) {
      const { key, outcome, reason } = parseOutcome(row)
      // Last row wins: a reverted reference that was later republished (a
      // different call reusing the same bytes) keeps the newest truth.
      archive.outcomes.set(key, outcome)
      if (reason === undefined) archive.reasons.delete(key)
      else archive.reasons.set(key, reason)
    }
    archive.tornManifestBytes = archive.content.torn + archive.owner.torn + archive.outcome.torn
    // A manifest that could not be validated must not accept new references.
    for (const manifest of [archive.content, archive.owner, archive.outcome]) {
      if (manifest.failure !== undefined) archive.poison(manifest.failure)
    }
    // Physical space, not the count of successfully indexed rows, is the quota:
    // a blob left behind by a failed content append still occupies the volume.
    archive.reconcileUsage()
    return archive
  }

  private tornManifestBytes = 0

  /** Whether this instance may publish new references. */
  get writable(): boolean { return !this.closed && this.poisoned === undefined }
  /** Why new references are refused, or undefined when they are accepted. */
  get refusal(): string | undefined { return this.poisoned }
  /** Duplicate owner rows collapsed at open. */
  get duplicateOwners(): number { return this.duplicateOwnerRows }
  /** Owner rows that disagreed with the first row for the same identity. */
  get ownerConflicts(): number { return this.conflictingOwnerRows }
  /** Physical original bytes this instance accounted for. */
  get physicalBytes(): number { return this.totalBytes }
  /** Physical blob files inspected by the last bounded reconcile. */
  get reconciledBlobFiles(): number { return this.reconciledFiles }

  private poison(reason: string): void { this.poisoned ??= reason }

  private assertUsable(): void {
    if (this.closed) fail('archive is closed')
    const stat = fs.lstatSync(this.root)
    if (!stat.isDirectory() || stat.isSymbolicLink()) fail('archive directory changed')
  }

  /** Reads stay available on a poisoned instance; new references do not. */
  private assertWritable(): void {
    this.assertUsable()
    if (this.poisoned !== undefined) fail(`archive instance refused further references: ${this.poisoned}`)
  }

  /**
   * Count the physically retained originals inside a bounded walk.
   *
   * The content manifest records intended facts; only the files on disk record
   * real space. A blob orphaned by a failed content append, or a stray partial
   * file, still occupies the volume, so it must consume the quota until an
   * operator reclaims it — nothing here ever deletes an original. When the walk
   * cannot confirm the total (too many files, an unreadable entry, a changed
   * root), new references are refused instead of guessing.
   */
  private reconcileUsage(): void {
    let files = 0, bytes = 0, confirmed = true
    const fail2 = (reason: string): void => { confirmed = false; this.poison(reason) }
    const visit = (directory: string, depth: number): void => {
      if (!confirmed) return
      let items: fs.Dirent[]
      try { items = fs.readdirSync(directory, { withFileTypes: true }) } catch { fail2('archive volume could not be inspected'); return }
      for (const item of items) {
        if (!confirmed) return
        const target = join(directory, item.name)
        if (item.isDirectory()) {
          if (depth === 0 && !/^[a-f0-9]{2}$/u.test(item.name)) continue
          if (depth >= 2) { fail2('archive volume has an unexpected layout'); return }
          visit(target, depth + 1)
          continue
        }
        // Root-level manifests are bookkeeping, not archived originals.
        if (depth === 0) continue
        if (files >= MAX_RECONCILE_FILES) { fail2('archive volume exceeds the bounded reconcile limit'); return }
        try {
          const stat = fs.lstatSync(target)
          if (stat.isSymbolicLink() || !stat.isFile()) { fail2('archive volume contains a non-regular file'); return }
          files++
          bytes += stat.size
        } catch { fail2('an archived original could not be measured'); return }
      }
    }
    visit(this.root, 0)
    this.reconciledFiles = files
    if (!confirmed) return
    // Never lower the accounted figure below what the manifests already imply,
    // and never below the physical reality: a missing blob is not free space.
    this.totalBytes = Math.max(this.totalBytes, bytes)
  }

  private remember(entry: ArchiveOwner): void {
    this.owners.push(entry)
    const list = this.bySession.get(entry.sessionId) ?? []
    if (list.length === 0) this.bySession.set(entry.sessionId, list)
    list.push(this.owners.length - 1)
    this.identities.set(grantKey(entry.contentId, entry.sessionId, entry.callId), entry)
  }

  /** Torn manifest bytes observed at open; reported, never guessed. */
  get tornBytes(): number { return this.tornManifestBytes }
  /** Archived originals currently addressable. */
  get size(): number { return this.contents.size }
  /** Session grants recorded so far. */
  get grants(): number { return this.owners.length }
  /** Absolute directory an operator can read, back up or export without this plugin. */
  get directory(): string { return this.root }

  /**
   * Durably store one original and register this session's grant over it.
   * Idempotent by content for the blob and by `(session, call)` for the grant.
   * @param input - original bytes plus the identity to record.
   * @returns the immutable content facts.
   * @throws ArchiveUnavailableError when durability cannot be established.
   */
  save(input: ArchiveSaveInput): ArchiveContent {
    this.assertWritable()
    if (input.sessionId.length === 0 || input.sessionId.length > 200) fail('invalid session identity')
    const bytes = Buffer.from(input.text, 'utf8')
    const contentId = createHash('sha256').update(bytes).digest('hex')
    let entry = this.contents.get(contentId)
    // The quota is a deterministic refusal taken before any durable side effect,
    // so it never has to poison the instance.
    if (entry === undefined && this.totalBytes + bytes.byteLength > this.maxTotalBytes) {
      fail(`archive quota of ${this.maxTotalBytes} bytes would be exceeded; new reduction is disabled and the Host result is kept`)
    }
    try {
      return this.commit(entry, contentId, bytes, input)
    } catch (error) {
      // An uncertain commit: nothing may be published from this handle again
      // until a validated reopen, because the durable state is unknown.
      this.poison(error instanceof Error ? error.message : String(error))
      throw error
    }
  }

  /** The durable half of {@link save}: blob, content row, grant row. */
  private commit(entry: ArchiveContent | undefined, contentId: string, bytes: Buffer, input: ArchiveSaveInput): ArchiveContent {
    if (entry === undefined) {
      const path = blobPath(this.root, contentId)
      const shard = dirname(path)
      const parent = dirname(shard)
      // Durability order: each newly created directory entry is flushed in its
      // own parent before the deeper level is created, because flushing the
      // root later does not make an already-created child entry durable.
      installDirectory(parent)
      syncDirectory(this.root)
      installDirectory(shard)
      syncDirectory(parent)
      this.writeBlob(shard, path, bytes)
      this.verifyBlob(path, contentId)
      // The bytes are retained from this moment on. They consume the quota even
      // if the content row below fails, because nothing here deletes a stored
      // original to win space back.
      this.totalBytes += bytes.byteLength
      const stored: ArchiveContent = { contentId, bytes: bytes.byteLength, originalChars: input.text.length, createdAt: Date.now() }
      this.content.append({ ...stored })
      this.contents.set(contentId, stored)
      entry = stored
    } else {
      // A dedup hit only reuses the bytes, never the previous verification: the
      // process-internal map and the surviving manifest row both outlive the
      // file, so a deleted or corrupted blob must not be published as a readable
      // reference. The exact input is on hand, so the blob is restored and
      // re-hashed before any new grant is recorded.
      const path = blobPath(this.root, contentId)
      this.ensureBlob(path, contentId, bytes)
    }
    // One identity is one grant. A retry of the same `(content, session, call)`
    // is idempotent: it reuses the existing grant instead of appending a second
    // row that a restart would have to collapse again.
    const identity = grantKey(contentId, input.sessionId, input.callId)
    const existing = this.identities.get(identity)
    if (existing !== undefined) {
      const conflict = existing.rule !== input.rule || existing.ruleVersion !== input.ruleVersion
        || existing.shortenedChars !== input.shortenedChars || existing.tool !== input.source.slice(0, 120)
        || existing.complete !== (input.complete === true)
      if (conflict) {
        // Two different facts for one identity: neither is preferred silently.
        this.conflictingOwnerRows++
        fail('the recorded grant for this identity disagrees with the new facts; the conflicting reference is refused')
      }
      return entry
    }
    const owner: ArchiveOwner = { contentId, sessionId: input.sessionId, tool: input.source.slice(0, 120),
      rule: input.rule, ruleVersion: input.ruleVersion, shortenedChars: input.shortenedChars,
      complete: input.complete === true, at: Date.now(),
      ...(input.callId === undefined ? {} : { callId: input.callId }) }
    this.owner.append({ ...owner })
    this.remember(owner)
    return entry
  }

  /** Write one blob atomically at its content address; never leaves a partial file. */
  private writeBlob(shard: string, path: string, bytes: Buffer): void {
    if (fs.existsSync(path)) return
    const temporary = join(shard, `.${basename(path, '.txt')}.${process.pid}.tmp`)
    let renamed = false
    try {
      const fd = fs.openSync(temporary, fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY | NO_FOLLOW, 0o600)
      try { fs.writeFileSync(fd, bytes); fs.fsyncSync(fd) } finally { fs.closeSync(fd) }
      fs.renameSync(temporary, path)
      renamed = true
      syncDirectory(shard)
    } catch (error) {
      // A failed publish must not leave a partial blob that a later hash check
      // would reject, and must never be reported as stored.
      if (!renamed) { try { fs.unlinkSync(temporary) } catch { /* best effort */ } }
      throw new ArchiveUnavailableError(`Context archive: cannot store original text: ${String(error)}`)
    }
  }

  /**
   * Guarantee that the blob at one content address exists and hashes to that
   * address. A missing or mismatched file is replaced from the caller's exact
   * bytes; a replacement that still fails verification is a hard failure, so a
   * reference is never granted over unreadable content.
   */
  private ensureBlob(path: string, contentId: string, bytes: Buffer): void {
    let healthy = false
    try { this.verifyBlob(path, contentId); healthy = true } catch { healthy = false }
    if (healthy) return
    try { fs.unlinkSync(path) } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw new ArchiveUnavailableError(`Context archive: cannot replace unreadable original text: ${String(error)}`)
      }
    }
    const shard = dirname(path)
    installDirectory(dirname(shard))
    syncDirectory(this.root)
    installDirectory(shard)
    syncDirectory(dirname(shard))
    this.writeBlob(shard, path, bytes)
    this.verifyBlob(path, contentId)
    syncDirectory(shard)
  }

  /** Content facts for one content id, or undefined when never stored. */
  entry(contentId: string): ArchiveContent | undefined { return this.contents.get(contentId) }

  /** Every grant for this session over one content id, oldest first. */
  grantsFor(contentId: string, sessionId: string): readonly ArchiveOwner[] {
    return this.owners.filter(item => item.contentId === contentId && item.sessionId === sessionId)
  }

  /** Whether this archive holds an original at all, for scope decisions. */
  knows(contentId: string): boolean { return this.contents.has(contentId) }

  /**
   * Durably record that the Host's authoritative final result still carried the
   * reduced text for one grant. This is the only fact that may be presented as a
   * realised saving.
   * @param contentId - digest of the stored original.
   * @param sessionId - the session whose grant is confirmed.
   * @param callId - the call the grant belongs to, when the Host reported one.
   */
  notePublished(contentId: string, sessionId: string, callId?: string): void {
    this.note(contentId, sessionId, callId, 'published')
  }

  /**
   * Record that the Host finally dropped the short text of a handed-out
   * reference. Durable, so a restart does not re-report an unsaved reduction as
   * effective; the original stays archived and readable either way.
   * @param contentId - digest of the stored original.
   * @param sessionId - the session whose grant is marked.
   * @param callId - the call the grant belongs to, when the Host reported one.
   * @param reason - bounded diagnostic reason.
   */
  noteReverted(contentId: string, sessionId: string, callId?: string, reason?: string): void {
    this.note(contentId, sessionId, callId, 'reverted', reason)
  }

  private note(contentId: string, sessionId: string, callId: string | undefined, outcome: ArchiveOutcome, reason?: string): void {
    // A closed or poisoned instance refuses outcome writes too: it must not
    // claim a new realised saving while its durable state is unknown. The
    // refusal is silent because this is bookkeeping, never the tool result.
    if (this.closed || this.poisoned !== undefined) return
    const key = grantKey(contentId, sessionId, callId)
    if (this.outcomes.get(key) === outcome) return
    if (!this.contents.has(contentId)) return
    const bounded = reason === undefined ? undefined : reason.slice(0, 120)
    this.outcome.append({ contentId, sessionId, outcome, ...(callId === undefined ? {} : { callId }),
      ...(bounded === undefined ? {} : { reason: bounded }) })
    this.outcomes.set(key, outcome)
    if (bounded === undefined) this.reasons.delete(key)
    else this.reasons.set(key, bounded)
  }

  /** Durable outcome of one grant, or undefined while it is still pending. */
  outcomeOf(contentId: string, sessionId: string, callId?: string): ArchiveOutcome | undefined {
    return this.outcomes.get(grantKey(contentId, sessionId, callId))
  }

  /** Reasons recorded for reductions whose short text the Host finally dropped. */
  revertedReason(contentId: string, sessionId: string, callId?: string): string | undefined {
    return this.reasons.get(grantKey(contentId, sessionId, callId))
  }

  /** Grants for one session in insertion order, newest `limit` kept. */
  sessionGrants(sessionId: string, limit: number): readonly ArchiveOwner[] {
    const indexes = this.bySession.get(sessionId) ?? []
    const result: ArchiveOwner[] = []
    for (let index = indexes.length - 1; index >= 0 && result.length < limit; index--) {
      const owner = this.owners[indexes[index] as number]
      if (owner) result.push(owner)
    }
    return result.reverse()
  }

  /** Grantee session ids that currently reference one content id. */
  referencingSessions(contentId: string): readonly string[] {
    return [...new Set(this.owners.filter(item => item.contentId === contentId).map(item => item.sessionId))]
  }

  /**
   * Bounded reduction view. Volume and realised reduction are separate facts:
   * the volume counts every stored original (including references that were
   * never published or were later reverted), while `published` is rebuilt from
   * durable confirmed outcomes, so it stays correct across restarts and never
   * re-reports a dropped or cancelled reduction as effective.
   * @param sessionId - optional session filter; omitted means the whole archive.
   * @param limit - how many recent grants to return.
   */
  summary(sessionId?: string, limit = 32): ArchiveSummary {
    const relevant = sessionId === undefined ? this.owners : this.owners.filter(item => item.sessionId === sessionId)
    const seen = new Set<string>()
    const volume = relevant.reduce<ArchiveVolume>((total, owner) => {
      const content = this.contents.get(owner.contentId)
      const first = !seen.has(owner.contentId)
      if (first) seen.add(owner.contentId)
      return {
        originals: total.originals + (first ? 1 : 0),
        originalChars: total.originalChars + (first ? content?.originalChars ?? 0 : 0),
        archivedBytes: total.archivedBytes + (first ? content?.bytes ?? 0 : 0),
      }
    }, { originals: 0, originalChars: 0, archivedBytes: 0 })
    let pending = 0, reverted = 0
    const published = { references: 0, originalChars: 0, shortenedChars: 0, visibleCharsRemoved: 0 }
    for (const owner of relevant) {
      const outcome = this.outcomes.get(grantKey(owner.contentId, owner.sessionId, owner.callId))
      if (outcome === undefined) { pending++; continue }
      if (outcome === 'reverted') { reverted++; continue }
      const content = this.contents.get(owner.contentId)
      const originalChars = content?.originalChars ?? 0
      published.references++
      published.originalChars += originalChars
      published.shortenedChars += owner.shortenedChars
      published.visibleCharsRemoved += Math.max(0, originalChars - owner.shortenedChars)
    }
    return { volume, published, pending, reverted, recent: relevant.slice(-limit).reverse(),
      notes: [
        'volume 是已存原文体积，含未发布与已撤回的引用，不能当作已生效精简',
        'published 只统计最终 Host 结果确认保留了短文的引用，重启后仍由耐久成果行重建',
        'visibleCharsRemoved 是可见文本字符差，不是账单金额或 Token 计费节省',
      ] }
  }

  /**
   * Bounded substring search over originals this session may read. The
   * per-file contribution is itself capped, so one oversized original cannot
   * exceed the scan budget on its own.
   *
   * A bounded scan is never reported as a complete one: any candidate that the
   * remaining budget could not cover, any unreadable blob and any candidate cut
   * by the entry ceiling is counted and turns `truncated` on, so an empty hit
   * list is never mistaken for "the text is not there".
   */
  searchSession(sessionId: string, query: string, options: { readonly limit: number; readonly maxEntries: number; readonly maxChars: number }): {
    hits: readonly { owner: ArchiveOwner; offset: number; snippet: string }[]
    scannedEntries: number
    scannedChars: number
    truncated: boolean
    /** Candidates the budget could not read at all. */
    skipped: number
    /** Candidates that are indexed but could not be read (missing or corrupt). */
    unavailable: number
  } {
    const candidates = this.sessionGrants(sessionId, Math.max(1, options.maxEntries))
    // The entry ceiling itself is a bound worth reporting, not a silent cut.
    const ceiling = this.sessionGrants(sessionId, options.maxEntries + 1).length > candidates.length
    return this.searchOwners(candidates, query, options, ceiling)
  }

  /**
   * The same bounded scan over an explicit, already-authorised candidate list.
   *
   * A fork child may read an original it genuinely inherited, so its candidate
   * set is its own grants plus those proven inherited ones — never "all grants
   * of the parent session". Callers that cannot build such a proof pass only
   * their own grants, which is exactly {@link searchSession}.
   * @param owners - the exact grants this caller is authorised to search.
   * @param query - case-sensitive literal query.
   * @param options - hit ceiling, entry ceiling and scan-character ceiling.
   * @param ceilingReached - whether an unlocked candidate was cut off by the entry ceiling.
   */
  searchOwners(owners: readonly ArchiveOwner[], query: string, options: { readonly limit: number; readonly maxEntries: number; readonly maxChars: number }, ceilingReached = false): {
    hits: readonly { owner: ArchiveOwner; offset: number; snippet: string }[]
    scannedEntries: number
    scannedChars: number
    truncated: boolean
    skipped: number
    unavailable: number
  } {
    this.assertUsable()
    const hits: { owner: ArchiveOwner; offset: number; snippet: string }[] = []
    const visited = new Set<string>()
    const candidates = owners.slice(0, Math.max(1, options.maxEntries))
    let scannedEntries = 0, scanned = 0, truncated = ceilingReached, skipped = 0, unavailable = 0
    for (const owner of candidates) {
      if (hits.length >= options.limit) { truncated = true; break }
      if (scannedEntries >= options.maxEntries || scanned >= options.maxChars) { truncated = true; break }
      if (visited.has(owner.contentId)) continue
      visited.add(owner.contentId)
      const content = this.contents.get(owner.contentId)
      if (content === undefined) { unavailable++; truncated = true; continue }
      const budget = Math.min(options.maxChars - scanned, content.originalChars)
      if (budget <= 0) { skipped++; truncated = true; continue }
      let text: string
      try { text = this.read(owner.contentId, { maxChars: budget }) } catch {
        // The original is larger than the remaining budget, or unreadable: both
        // are disclosed instead of being reported as "no match".
        if (content.originalChars > budget) skipped++
        else unavailable++
        truncated = true
        continue
      }
      scannedEntries++
      scanned += text.length
      const found = text.indexOf(query)
      if (found >= 0) {
        const start = Math.max(0, found - 80)
        hits.push({ owner, offset: found, snippet: text.slice(start, start + query.length + 200) })
      }
    }
    return { hits, scannedEntries, scannedChars: scanned, truncated, skipped, unavailable }
  }

  /**
   * Read one archived original by content id.
   * @param contentId - digest that also names the blob file.
   * @param options - `maxChars` refuses to load a larger file (bounded read).
   * @returns the exact original text.
   * @throws ArchiveUnavailableError when the entry is unknown, oversized or corrupt.
   */
  read(contentId: string, options: { readonly maxChars?: number } = {}): string {
    this.assertUsable()
    const entry = this.contents.get(contentId)
    if (entry === undefined) fail(`no archived original for content id ${contentId.slice(0, 16)}`)
    if (options.maxChars !== undefined && entry.originalChars > options.maxChars) {
      fail(`archived original is larger than the ${options.maxChars}-character read budget`)
    }
    const path = blobPath(this.root, contentId)
    const stat = fs.lstatSync(path)
    if (!stat.isFile() || stat.isSymbolicLink()) fail('archived original is not a regular file')
    if (stat.size !== entry.bytes) fail('archived original size does not match its manifest row')
    const fd = fs.openSync(path, fs.constants.O_RDONLY | NO_FOLLOW)
    try {
      const held = fs.fstatSync(fd)
      if (!held.isFile() || held.dev !== stat.dev || held.ino !== stat.ino) fail('archived original changed while opening')
      const bytes = fs.readFileSync(fd)
      const digest = createHash('sha256').update(bytes).digest('hex')
      if (digest !== contentId) fail('archived original is corrupt: content hash mismatch')
      return bytes.toString('utf8')
    } finally { fs.closeSync(fd) }
  }

  /**
   * Blob files present on disk but absent from the content manifest. These are
   * the only entries a space recovery may ever consider, and never while any
   * session grant references them. Reported, never deleted automatically.
   */
  scanOrphans(): readonly string[] {
    this.assertUsable()
    const orphans: string[] = []
    for (const first of fs.readdirSync(this.root)) {
      const level1 = join(this.root, first)
      if (!/^[a-f0-9]{2}$/u.test(first) || !fs.lstatSync(level1).isDirectory()) continue
      for (const second of fs.readdirSync(level1)) {
        const level2 = join(level1, second)
        if (!/^[a-f0-9]{2}$/u.test(second) || !fs.lstatSync(level2).isDirectory()) continue
        for (const file of fs.readdirSync(level2)) {
          const match = /^([a-f0-9]{64})\.txt$/u.exec(file)
          if (!match) continue
          if (this.contents.has(match[1] as string)) continue
          orphans.push(match[1] as string)
        }
      }
    }
    return orphans
  }

  private verifyBlob(path: string, contentId: string): void {
    const stat = fs.lstatSync(path)
    if (!stat.isFile() || stat.isSymbolicLink()) fail('archived original is not a regular file')
    const fd = fs.openSync(path, fs.constants.O_RDONLY | NO_FOLLOW)
    try {
      const held = fs.fstatSync(fd)
      if (!held.isFile() || held.dev !== stat.dev || held.ino !== stat.ino) fail('archived original changed while opening')
      const digest = createHash('sha256').update(fs.readFileSync(fd)).digest('hex')
      if (digest !== contentId) fail('archived original does not match its content id')
    } finally { fs.closeSync(fd) }
  }

  /** Stop accepting writes. Stored originals and the manifests are never removed. */
  close(): void { this.closed = true }
}
