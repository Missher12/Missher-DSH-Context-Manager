/** Durable metadata awaiting a Host domain write; never a queue of model work. */
import fs from 'node:fs'
import { createHash, randomUUID } from 'node:crypto'
import { hostname } from 'node:os'
import { basename, dirname, isAbsolute, join, resolve } from 'node:path'

const DOMAINS = new Set(['context_manager_idle', 'context_manager_summaries'])
const MAX_BYTES = 8 * 1024 * 1024
const MAX_ROW_BYTES = 256 * 1024
const MAX_ENTRIES = 1024
const MAX_CHAIN = 1024
const SHA = /^[a-f0-9]{64}$/u
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/u
// Windows does not expose O_NOFOLLOW. Keep lstat/open/fstat identity checks
// there; do not imply that it provides the POSIX atomic no-follow guarantee.
const NO_FOLLOW = fs.constants.O_NOFOLLOW ?? 0
type Json = null | boolean | number | string | Json[] | { [key: string]: Json }
type Entry = { domain: string; key: string; generation: string; before: string[]; next: Json }
type Owner = { schema: 1; pid: number; host: string; token: string }
export interface RecoveryTable {
  get(key: string): unknown
  put(key: string, value: unknown): Promise<void>
}

function fail(message: string): never { throw new Error(`Context recovery journal: ${message}`) }
function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}
function keys(value: Record<string, unknown>, allowed: readonly string[]): void {
  if (Object.keys(value).some(key => !allowed.includes(key))) fail('unknown metadata field')
}
function exactKeys(value: Record<string, unknown>, expected: readonly string[]): void {
  keys(value, expected)
  if (expected.some(key => !Object.hasOwn(value, key))) fail('missing metadata field')
}
function domainKey(domain: string, key: string): string {
  if (!DOMAINS.has(domain) || typeof key !== 'string' || !key.length || key.length > 256) fail('invalid domain or record key')
  return JSON.stringify([domain, key])
}

/** Stable JSON rejects values JSON.stringify would silently discard or change. */
function canonical(value: unknown, depth = 0): string {
  if (depth > 12) fail('metadata nesting exceeds limit')
  if (value === null || typeof value === 'boolean') return JSON.stringify(value)
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value)) fail('metadata number must be a safe integer')
    return JSON.stringify(value)
  }
  if (typeof value === 'string') {
    if (value.length > 1024) fail('metadata string exceeds limit')
    return JSON.stringify(value)
  }
  if (Array.isArray(value)) {
    if (value.length > 1024 || Object.keys(value).length !== value.length) fail('invalid metadata array')
    return '[' + value.map(item => canonical(item, depth + 1)).join(',') + ']'
  }
  if (!object(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) fail('metadata must be plain JSON')
  if (Reflect.ownKeys(value).length !== Object.keys(value).length) fail('non-JSON metadata properties')
  return '{' + Object.keys(value).sort().map(key => JSON.stringify(key) + ':' + canonical(value[key], depth + 1)).join(',') + '}'
}
function hash(value: unknown): string {
  return createHash('sha256').update(value === undefined ? 'missing' : 'json:' + canonical(value)).digest('hex')
}

/** Field whitelist prevents accidentally persisting conversation/model bodies. Schema validation remains with the store. */
function metadata(domain: string, key: string, value: unknown): Json {
  if (!object(value) || value.sessionId !== key) fail('metadata session does not match key')
  if (domain === 'context_manager_idle') {
    keys(value, ['sessionId', 'turnEndSeq', 'completedAt', 'fingerprint', 'status', 'updatedAt', 'attemptId',
      'compactionId', 'beforeTokens', 'afterTokens', 'reasonCode'])
  } else {
    keys(value, ['sessionId', 'since', 'archived', 'recent'])
    if (!object(value.archived) || !Array.isArray(value.recent) || value.recent.length > 128) fail('invalid summary metadata')
    exactKeys(value.archived, ['input', 'output', 'cacheRead', 'cacheWrite', 'attempts', 'unknownAttempts'])
    for (const item of value.recent) {
      if (!object(item)) fail('invalid attempt metadata')
      keys(item, ['id', 'compactionId', 'trigger', 'startedAt', 'endedAt', 'status', 'input', 'output', 'cacheRead', 'cacheWrite'])
    }
  }
  const text = canonical(value)
  if (Buffer.byteLength(text) > MAX_ROW_BYTES) fail('metadata record exceeds limit')
  return JSON.parse(text) as Json
}

function readRegular(path: string, limit: number): string {
  const stat = fs.lstatSync(path)
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > limit) fail('invalid or oversized journal file')
  const fd = fs.openSync(path, fs.constants.O_RDONLY | NO_FOLLOW)
  try {
    const held = fs.fstatSync(fd)
    if (!held.isFile() || held.dev !== stat.dev || held.ino !== stat.ino || held.size > limit) fail('journal file changed while opening')
    const text = fs.readFileSync(fd, 'utf8')
    if (Buffer.byteLength(text) > limit) fail('journal file exceeds limit')
    return text
  } finally { fs.closeSync(fd) }
}
function syncDirectory(root: string): void {
  // Node's Windows directory handles cannot be flushed like POSIX directory
  // handles (EPERM). File flushes remain mandatory; no fsync error is ignored.
  if (process.platform === 'win32') return
  const fd = fs.openSync(root, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY)
  try { fs.fsyncSync(fd) } finally { fs.closeSync(fd) }
}
function syncReplacement(root: string): void {
  if (process.platform !== 'win32') { syncDirectory(root); return }
  // Flush the published regular file through a writable handle after rename.
  // This is a file-content barrier, not a claim of POSIX directory durability
  // or sudden-power-loss protection. A failure poisons the transaction below.
  const path = join(root, 'pending.json'), stat = fs.lstatSync(path)
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_BYTES) fail('invalid published journal file')
  const fd = fs.openSync(path, fs.constants.O_RDWR | NO_FOLLOW)
  try {
    const held = fs.fstatSync(fd)
    if (!held.isFile() || held.dev !== stat.dev || held.ino !== stat.ino || held.size > MAX_BYTES) fail('published journal file changed while opening')
    fs.fsyncSync(fd)
  } finally { fs.closeSync(fd) }
}
function ownerFrom(text: string): Owner {
  let data: unknown
  try { data = JSON.parse(text) } catch { fail('unreadable lock; ownership cannot be established') }
  if (!object(data)) fail('invalid lock')
  exactKeys(data, ['schema', 'pid', 'host', 'token'])
  if (data.schema !== 1 || !Number.isSafeInteger(data.pid) || (data.pid as number) <= 0
    || typeof data.host !== 'string' || typeof data.token !== 'string' || !UUID.test(data.token)) fail('invalid lock owner')
  return data as Owner
}
function writeExclusive(path: string, value: unknown): void {
  const fd = fs.openSync(path, fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY | NO_FOLLOW, 0o600)
  const identity = fs.fstatSync(fd)
  try { fs.writeFileSync(fd, JSON.stringify(value) + '\n'); fs.fsyncSync(fd) }
  catch (error) {
    // This invocation created the file exclusively. Remove only that inode;
    // a failed lock write must not strand a live-PID lock with no owner.
    const current = fs.lstatSync(path, { throwIfNoEntry: false })
    if (current?.dev === identity.dev && current.ino === identity.ino) fs.unlinkSync(path)
    throw error
  } finally { fs.closeSync(fd) }
}
function dead(owner: Owner): boolean {
  if (owner.host !== hostname()) fail('lock belongs to another host; ownership cannot be established')
  try { process.kill(owner.pid, 0); return false } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ESRCH') return true
    fail('lock process state cannot be established')
  }
}
function acquire(root: string, owner: Owner): void {
  const path = join(root, 'lock.json')
  try { writeExclusive(path, owner); syncDirectory(root); return } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
  }
  const original = readRegular(path, 4096), previous = ownerFrom(original)
  if (!dead(previous)) fail('journal is locked by a live process')
  // Only one reclaimer can act on a specific old generation. A loser must
  // never unlink a successor lock using a stale PID check. An interrupted
  // reclaim with the old lock still present is ambiguous and stays refused.
  const claim = join(root, `reclaim-${previous.token}.json`)
  try { writeExclusive(claim, owner) } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') fail('stale lock recovery is already claimed; ownership cannot be established')
    throw error
  }
  syncDirectory(root)
  try {
    if (readRegular(path, 4096) !== original) fail('lock changed during recovery')
    fs.unlinkSync(path)
    writeExclusive(path, owner)
    syncDirectory(root)
  } finally {
    // Removing a claim is safe only after that old lock no longer occupies
    // the slot. Otherwise retain the evidence and refuse speculative repair.
    let replaced = false
    try { replaced = ownerFrom(readRegular(path, 4096)).token !== previous.token } catch { /* Retain ambiguous claim. */ }
    if (replaced) { fs.unlinkSync(claim); syncDirectory(root) }
  }
}

export class RecoveryJournal {
  private entries = new Map<string, Entry>()
  private closed = false
  private poisoned = false
  private replaying = false
  private readonly directory: fs.Stats
  private constructor(private readonly root: string, private readonly owner: Owner) { this.directory = fs.lstatSync(root) }

  /** Synchronous exclusive ownership; failed/unknown ownership never authorizes replay or model calls. */
  static open(root: string): RecoveryJournal {
    if (!isAbsolute(root)) fail('root must be absolute')
    const target = resolve(root)
    // The caller supplies an existing profile parent; do not create arbitrary
    // ancestor directories or follow a leaf symlink into somebody else's data.
    const parent = fs.realpathSync(dirname(target)), directory = join(parent, basename(target))
    try { fs.mkdirSync(directory, { mode: 0o700 }); syncDirectory(parent) } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
    }
    const stat = fs.lstatSync(directory)
    if (!stat.isDirectory() || stat.isSymbolicLink()) fail('root must be a real directory')
    fs.chmodSync(directory, 0o700)
    const owner: Owner = { schema: 1, pid: process.pid, host: hostname(), token: randomUUID() }
    try { acquire(directory, owner) } catch (error) {
      // Acquisition may have written our complete lock before a directory
      // fsync failed. Do not leave an ownerless live-PID lock in this process.
      try {
        if (ownerFrom(readRegular(join(directory, 'lock.json'), 4096)).token === owner.token) {
          fs.unlinkSync(join(directory, 'lock.json'))
          syncDirectory(directory)
        }
      } catch { /* Unknown/foreign ownership stays untouched. */ }
      throw error
    }
    const journal = new RecoveryJournal(directory, owner)
    try {
      const path = join(directory, 'pending.json')
      let raw: string
      try { raw = readRegular(path, MAX_BYTES) } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
        journal.persist(new Map())
        return journal
      }
      let value: unknown
      try { value = JSON.parse(raw) } catch { fail('pending state is not valid JSON') }
      if (!object(value)) fail('invalid pending state')
      exactKeys(value, ['schema', 'entries'])
      if (value.schema !== 1 || !Array.isArray(value.entries) || value.entries.length > MAX_ENTRIES) fail('unsupported pending schema or capacity')
      for (const item of value.entries) {
        if (!object(item)) fail('invalid pending entry')
        exactKeys(item, ['domain', 'key', 'generation', 'before', 'next'])
        if (typeof item.domain !== 'string' || typeof item.key !== 'string') fail('invalid pending identity')
        const id = domainKey(item.domain, item.key)
        if (journal.entries.has(id) || typeof item.generation !== 'string' || !UUID.test(item.generation)
          || !Array.isArray(item.before) || !item.before.length || item.before.length > MAX_CHAIN
          || item.before.some(h => typeof h !== 'string' || !SHA.test(h)) || new Set(item.before).size !== item.before.length) fail('invalid pending chain')
        journal.entries.set(id, { domain: item.domain, key: item.key, generation: item.generation,
          before: item.before as string[], next: metadata(item.domain, item.key, item.next) })
      }
      fs.chmodSync(path, 0o600)
      return journal
    } catch (error) { journal.close(); throw error }
  }

  private assertOwner(): void {
    if (this.closed) fail('journal is closed')
    const directory = fs.lstatSync(this.root)
    if (!directory.isDirectory() || directory.isSymbolicLink() || directory.dev !== this.directory.dev || directory.ino !== this.directory.ino) fail('journal directory changed')
    if (ownerFrom(readRegular(join(this.root, 'lock.json'), 4096)).token !== this.owner.token) fail('journal ownership changed')
  }
  private writable(): void {
    this.assertOwner()
    if (this.poisoned) fail('durability is uncertain; close and reopen before further writes')
  }
  private persist(next: Map<string, Entry>): void {
    this.writable()
    const text = JSON.stringify({ schema: 1, entries: [...next.values()] }) + '\n'
    if (next.size > MAX_ENTRIES || Buffer.byteLength(text) > MAX_BYTES) fail('pending journal exceeds capacity')
    const temporary = join(this.root, `.pending-${this.owner.token}-${randomUUID()}.tmp`)
    let renamed = false
    try {
      const fd = fs.openSync(temporary, fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY | NO_FOLLOW, 0o600)
      try { fs.writeFileSync(fd, text); fs.fsyncSync(fd) } finally { fs.closeSync(fd) }
      fs.renameSync(temporary, join(this.root, 'pending.json'))
      renamed = true
      syncReplacement(this.root)
      this.entries = next
    } catch (error) {
      if (renamed) this.poisoned = true
      throw error
    } finally {
      if (!renamed) { try { fs.unlinkSync(temporary) } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error } }
    }
  }
  private acknowledge(id: string, generation: string): void {
    this.writable()
    if (this.entries.get(id)?.generation !== generation) return
    const next = new Map(this.entries)
    next.delete(id)
    this.persist(next)
  }

  /** Write-ahead before the corresponding Host put; acknowledge only after that put succeeds. */
  record(domain: string, key: string, previous: unknown | undefined, next: unknown): () => void {
    this.writable()
    if (this.replaying) fail('replay is in progress')
    const id = domainKey(domain, key), value = metadata(domain, key, next)
    if (previous !== undefined) metadata(domain, key, previous)
    const beforeHash = hash(previous), nextHash = hash(value), current = this.entries.get(id)
    if (current && nextHash === hash(current.next)) {
      if (beforeHash !== nextHash && !current.before.includes(beforeHash)) fail('record does not connect to pending history')
      return () => this.acknowledge(id, current.generation)
    }
    if (current && beforeHash !== hash(current.next)) fail('record would overwrite a newer pending state')
    const before = [...new Set([...(current?.before ?? []), beforeHash])]
    if (before.length > MAX_CHAIN) fail('pending history exceeds capacity')
    const generation = randomUUID(), entries = new Map(this.entries)
    entries.set(id, { domain, key, generation, before, next: value })
    this.persist(entries)
    return () => this.acknowledge(id, generation)
  }

  /** Recover metadata only. Conflicting live rows are preserved and stop recovery. */
  async replay(domain: string, table: RecoveryTable, validate: (key: string, value: unknown) => unknown): Promise<void> {
    this.writable()
    if (!DOMAINS.has(domain) || this.replaying) fail('invalid or concurrent replay')
    this.replaying = true
    try {
      const entries = [...this.entries.values()].filter(entry => entry.domain === domain)
      const inspect = (entry: Entry) => {
        const validated = validate(entry.key, structuredClone(entry.next))
        if (hash(metadata(domain, entry.key, validated)) !== hash(entry.next)) fail('validation changed pending metadata')
        const current = table.get(entry.key)
        if (current !== undefined) {
          const checked = validate(entry.key, current)
          if (hash(metadata(domain, entry.key, checked)) !== hash(current)) fail('validation changed current metadata')
        }
        const actual = hash(current), latest = hash(entry.next)
        if (actual !== latest && !entry.before.includes(actual)) fail('current record conflicts with pending history')
        return { same: actual === latest, value: validated }
      }
      // Discover existing conflicts/invalid records before writing any row.
      for (const entry of entries) inspect(entry)
      for (const entry of entries) {
        this.writable()
        const { same, value } = inspect(entry)
        if (!same) await table.put(entry.key, value)
        this.writable()
        if (hash(table.get(entry.key)) !== hash(entry.next)) fail('replayed record did not become current')
        this.acknowledge(domainKey(domain, entry.key), entry.generation)
      }
    } finally { this.replaying = false }
  }

  /** Release only our lock. Pending metadata survives normal shutdown and restart. */
  close(): void {
    if (this.closed) return
    if (this.replaying) fail('cannot close during replay')
    this.assertOwner()
    fs.unlinkSync(join(this.root, 'lock.json'))
    this.closed = true
    syncDirectory(this.root)
  }
}
