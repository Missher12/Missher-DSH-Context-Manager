// src/archive.ts
import fs from "fs";
import { createHash } from "crypto";
import { basename, dirname, isAbsolute, join, resolve } from "path";
var ARCHIVE_FORMAT = 1;
var ARCHIVE_DIRECTORY = ".context-manager-archive";
var CONTENT_ROW_VERSION = 1;
var OWNER_ROW_VERSION = 1;
var OUTCOME_ROW_VERSION = 1;
var DEFAULT_MAX_TOTAL_BYTES = 512 * 1024 * 1024;
var MAX_MANIFEST_BYTES = 64 * 1024 * 1024;
var MAX_OWNER_ROWS = 1e5;
var MAX_CONTENT_ROWS = 1e5;
var MAX_OUTCOME_ROWS = 2e5;
var MAX_ROW_BYTES = 16 * 1024;
var MAX_RECONCILE_FILES = 4096;
var SHA = /^[a-f0-9]{64}$/u;
var NO_FOLLOW = fs.constants.O_NOFOLLOW ?? 0;
var ArchiveUnavailableError = class extends Error {
};
function fail(message) {
  throw new ArchiveUnavailableError(`Context archive: ${message}`);
}
function object(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function hashText(text) {
  return createHash("sha256").update(Buffer.from(text, "utf8")).digest("hex");
}
function syncDirectory(root) {
  if (process.platform === "win32") return;
  const fd = fs.openSync(root, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY);
  try {
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}
function installDirectory(path) {
  try {
    fs.mkdirSync(path, { mode: 448 });
  } catch (error) {
    if (error.code !== "EEXIST") throw error;
  }
  const stat = fs.lstatSync(path);
  if (!stat.isDirectory() || stat.isSymbolicLink()) fail("archive path is not a real directory");
}
function blobPath(root, contentId) {
  if (!SHA.test(contentId)) fail("invalid content id");
  return join(root, contentId.slice(0, 2), contentId.slice(2, 4), `${contentId}.txt`);
}
function scanManifest(path, maxRows) {
  let fd;
  try {
    fd = fs.openSync(path, fs.constants.O_RDONLY | NO_FOLLOW);
  } catch (error) {
    if (error.code === "ENOENT") return { rows: [], tornBytes: 0 };
    throw error;
  }
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile()) fail("manifest is not a regular file");
    if (stat.size > MAX_MANIFEST_BYTES) fail(`manifest exceeds its ${MAX_MANIFEST_BYTES}-byte limit`);
    if (stat.size === 0) return { rows: [], tornBytes: 0 };
    const raw = fs.readFileSync(fd, "utf8");
    const rows = [];
    let tornBytes = 0, offset = 0;
    while (offset < raw.length) {
      const next = raw.indexOf("\n", offset);
      if (next < 0) {
        tornBytes = Buffer.byteLength(raw.slice(offset));
        break;
      }
      const line = raw.slice(offset, next);
      offset = next + 1;
      if (line.length === 0) continue;
      if (Buffer.byteLength(line) > MAX_ROW_BYTES) fail("manifest row exceeds its size limit");
      let value;
      try {
        value = JSON.parse(line);
      } catch {
        fail("manifest row is not valid JSON");
      }
      rows.push(value);
      if (rows.length > maxRows) fail("manifest exceeds its row limit");
    }
    return { rows, tornBytes };
  } finally {
    fs.closeSync(fd);
  }
}
var Manifest = class {
  constructor(path, version, onUncertain = () => {
  }) {
    this.path = path;
    this.version = version;
    this.onUncertain = onUncertain;
  }
  tornBytes = 0;
  /** Set once this manifest's durable state could not be confirmed again. */
  unusable;
  /**
   * Read the manifest with a hard row limit and remember any torn tail, so the
   * next append repairs it instead of writing past it.
   * @param maxRows - row ceiling for this manifest.
   * @returns the parsed rows, in file order.
   */
  open(maxRows) {
    const { rows, tornBytes } = scanManifest(this.path, maxRows);
    this.tornBytes = tornBytes;
    return rows;
  }
  get torn() {
    return this.tornBytes;
  }
  /** Why this manifest refuses further appends, once its state is unknown. */
  get failure() {
    return this.unusable;
  }
  append(row) {
    if (this.unusable !== void 0) fail(`manifest is not usable again: ${this.unusable}`);
    const line = `${JSON.stringify({ v: this.version, ...row })}
`;
    if (Buffer.byteLength(line) > MAX_ROW_BYTES) fail("manifest row exceeds its size limit");
    const fd = fs.openSync(this.path, fs.constants.O_CREAT | fs.constants.O_WRONLY | NO_FOLLOW, 384);
    try {
      const size = fs.fstatSync(fd).size;
      const at = this.tornBytes > 0 && size >= this.tornBytes ? size - this.tornBytes : size;
      if (at !== size) fs.ftruncateSync(fd, at);
      if (at > MAX_MANIFEST_BYTES) fail("manifest exceeds its size limit");
      const bytes = Buffer.from(line, "utf8");
      let written = 0;
      while (written < bytes.length) {
        const count = fs.writeSync(fd, bytes, written, bytes.length - written, at + written);
        if (!Number.isSafeInteger(count) || count <= 0) fail(`manifest write made no progress after ${written} of ${bytes.length} bytes`);
        written += count;
      }
      fs.fsyncSync(fd);
      this.tornBytes = 0;
    } catch (error) {
      const rescanned = this.rescanTorn();
      if (rescanned === void 0) this.unusable = "the manifest could not be re-read after a failed commit";
      else this.tornBytes = rescanned;
      this.onUncertain(rescanned === void 0 ? "manifest state could not be confirmed after a failed commit" : "a manifest commit failed; its outcome is unknown");
      if (error instanceof ArchiveUnavailableError) throw error;
      throw new ArchiveUnavailableError(`Context archive: cannot commit a manifest row: ${String(error)}`);
    } finally {
      fs.closeSync(fd);
    }
    try {
      syncDirectory(dirname(this.path));
    } catch (error) {
      this.unusable = "the directory entry could not be flushed after a manifest row";
      this.onUncertain(this.unusable);
      throw error instanceof ArchiveUnavailableError ? error : new ArchiveUnavailableError(`Context archive: cannot flush the manifest directory: ${String(error)}`);
    }
  }
  /**
   * Re-read the manifest after a failed append to learn where the durable end
   * really is.
   * @returns the torn byte count, or undefined when the manifest could not be
   * re-read at all — an unconfirmed state that must refuse further appends
   * instead of guessing a position.
   */
  rescanTorn() {
    try {
      return scanManifest(this.path, MAX_MANIFEST_BYTES).tornBytes;
    } catch {
      return void 0;
    }
  }
};
function parseContent(value) {
  if (!object(value) || value.v !== CONTENT_ROW_VERSION) fail("unsupported content row version");
  const { contentId, bytes, originalChars, createdAt } = value;
  if (typeof contentId !== "string" || !SHA.test(contentId)) fail("invalid content id");
  for (const [field, number] of [["bytes", bytes], ["originalChars", originalChars], ["createdAt", createdAt]]) {
    if (!Number.isSafeInteger(number) || number < 0) fail(`invalid ${field}`);
  }
  return { contentId, bytes, originalChars, createdAt };
}
function parseOwner(value) {
  if (!object(value) || value.v !== OWNER_ROW_VERSION) fail("unsupported owner row version");
  const { contentId, sessionId, callId, tool, rule, ruleVersion, shortenedChars, complete, at } = value;
  if (typeof contentId !== "string" || !SHA.test(contentId)) fail("invalid content id");
  if (typeof sessionId !== "string" || sessionId.length === 0 || sessionId.length > 200) fail("invalid session identity");
  if (callId !== void 0 && (typeof callId !== "string" || callId.length > 200)) fail("invalid call identity");
  if (typeof tool !== "string" || tool.length === 0 || tool.length > 120) fail("invalid tool identity");
  if (typeof rule !== "string" || rule.length === 0 || rule.length > 80) fail("invalid rule identity");
  if (typeof complete !== "boolean") fail("invalid completeness claim");
  for (const [field, number] of [["ruleVersion", ruleVersion], ["shortenedChars", shortenedChars], ["at", at]]) {
    if (!Number.isSafeInteger(number) || number < 0) fail(`invalid ${field}`);
  }
  return {
    contentId,
    sessionId,
    tool,
    rule,
    ruleVersion,
    shortenedChars,
    complete,
    at,
    ...callId === void 0 ? {} : { callId }
  };
}
function parseOutcome(value) {
  if (!object(value) || value.v !== OUTCOME_ROW_VERSION) fail("unsupported outcome row version");
  const { contentId, sessionId, callId, outcome, reason } = value;
  if (typeof contentId !== "string" || !SHA.test(contentId)) fail("invalid content id");
  if (typeof sessionId !== "string" || sessionId.length === 0 || sessionId.length > 200) fail("invalid session identity");
  if (callId !== void 0 && (typeof callId !== "string" || callId.length > 200)) fail("invalid call identity");
  if (outcome !== "published" && outcome !== "reverted") fail("invalid outcome");
  if (reason !== void 0 && (typeof reason !== "string" || reason.length > 120)) fail("invalid outcome reason");
  return {
    key: grantKey(contentId, sessionId, callId),
    outcome,
    ...reason === void 0 ? {} : { reason }
  };
}
function grantKey(contentId, sessionId, callId) {
  return `${contentId}\0${sessionId}\0${callId ?? ""}`;
}
var TextArchive = class _TextArchive {
  constructor(root, maxTotalBytes) {
    this.root = root;
    this.maxTotalBytes = maxTotalBytes;
    const uncertain = (reason) => this.poison(reason);
    this.content = new Manifest(join(root, "content.jsonl"), CONTENT_ROW_VERSION, uncertain);
    this.owner = new Manifest(join(root, "owners.jsonl"), OWNER_ROW_VERSION, uncertain);
    this.outcome = new Manifest(join(root, "outcomes.jsonl"), OUTCOME_ROW_VERSION, uncertain);
  }
  contents = /* @__PURE__ */ new Map();
  owners = [];
  bySession = /* @__PURE__ */ new Map();
  /** One grant per `(content, session, call)` identity, so a replay stays one reference. */
  identities = /* @__PURE__ */ new Map();
  outcomes = /* @__PURE__ */ new Map();
  reasons = /* @__PURE__ */ new Map();
  totalBytes = 0;
  closed = false;
  /**
   * Sticky reason this instance must not publish new references. Any uncertain
   * commit sets it: a partially applied write must never be followed by another
   * reference from the same handle. Reads stay available; only a close plus a
   * validated reopen clears it.
   */
  poisoned;
  /** Duplicate owner rows collapsed at open; they never become extra references. */
  duplicateOwnerRows = 0;
  /** Owner rows whose facts disagreed with the first row for the same identity. */
  conflictingOwnerRows = 0;
  /** How many physical blob files the last bounded reconcile inspected. */
  reconciledFiles = 0;
  content;
  owner;
  outcome;
  /**
   * Open an existing archive, or create one when `create` is set.
   * @param root - absolute archive directory chosen by the Host profile.
   * @param options - `create` allows directory creation; `maxTotalBytes` is the quota.
   */
  static open(root, options = {}) {
    if (!isAbsolute(root)) fail("root must be absolute");
    const target = resolve(root);
    const parent = fs.realpathSync(dirname(target));
    const directory = join(parent, basename(target));
    if (!fs.existsSync(directory)) {
      if (options.create !== true) fail("archive does not exist yet");
      installDirectory(directory);
      syncDirectory(parent);
    }
    const stat = fs.lstatSync(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink()) fail("root must be a real directory");
    const archive = new _TextArchive(directory, options.maxTotalBytes ?? DEFAULT_MAX_TOTAL_BYTES);
    const contentRows = archive.content.open(MAX_CONTENT_ROWS);
    const ownerRows = archive.owner.open(MAX_OWNER_ROWS);
    const outcomeRows = archive.outcome.open(MAX_OUTCOME_ROWS);
    for (const row of contentRows) {
      const entry = parseContent(row);
      if (!archive.contents.has(entry.contentId)) {
        archive.contents.set(entry.contentId, entry);
        archive.totalBytes += entry.bytes;
      }
    }
    const identities = /* @__PURE__ */ new Map();
    for (const row of ownerRows) {
      const owner = parseOwner(row);
      const key = grantKey(owner.contentId, owner.sessionId, owner.callId);
      const previous = identities.get(key);
      if (previous === void 0) {
        identities.set(key, owner);
        archive.remember(owner);
        continue;
      }
      archive.duplicateOwnerRows++;
      if (previous.rule !== owner.rule || previous.ruleVersion !== owner.ruleVersion || previous.shortenedChars !== owner.shortenedChars || previous.tool !== owner.tool || previous.complete !== owner.complete) archive.conflictingOwnerRows++;
    }
    for (const row of outcomeRows) {
      const { key, outcome, reason } = parseOutcome(row);
      archive.outcomes.set(key, outcome);
      if (reason === void 0) archive.reasons.delete(key);
      else archive.reasons.set(key, reason);
    }
    archive.tornManifestBytes = archive.content.torn + archive.owner.torn + archive.outcome.torn;
    for (const manifest of [archive.content, archive.owner, archive.outcome]) {
      if (manifest.failure !== void 0) archive.poison(manifest.failure);
    }
    archive.reconcileUsage();
    return archive;
  }
  tornManifestBytes = 0;
  /** Whether this instance may publish new references. */
  get writable() {
    return !this.closed && this.poisoned === void 0;
  }
  /** Why new references are refused, or undefined when they are accepted. */
  get refusal() {
    return this.poisoned;
  }
  /** Duplicate owner rows collapsed at open. */
  get duplicateOwners() {
    return this.duplicateOwnerRows;
  }
  /** Owner rows that disagreed with the first row for the same identity. */
  get ownerConflicts() {
    return this.conflictingOwnerRows;
  }
  /** Physical original bytes this instance accounted for. */
  get physicalBytes() {
    return this.totalBytes;
  }
  /** Physical blob files inspected by the last bounded reconcile. */
  get reconciledBlobFiles() {
    return this.reconciledFiles;
  }
  poison(reason) {
    this.poisoned ??= reason;
  }
  assertUsable() {
    if (this.closed) fail("archive is closed");
    const stat = fs.lstatSync(this.root);
    if (!stat.isDirectory() || stat.isSymbolicLink()) fail("archive directory changed");
  }
  /** Reads stay available on a poisoned instance; new references do not. */
  assertWritable() {
    this.assertUsable();
    if (this.poisoned !== void 0) fail(`archive instance refused further references: ${this.poisoned}`);
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
  reconcileUsage() {
    let files = 0, bytes = 0, confirmed = true;
    const fail2 = (reason) => {
      confirmed = false;
      this.poison(reason);
    };
    const visit = (directory, depth) => {
      if (!confirmed) return;
      let items;
      try {
        items = fs.readdirSync(directory, { withFileTypes: true });
      } catch {
        fail2("archive volume could not be inspected");
        return;
      }
      for (const item of items) {
        if (!confirmed) return;
        const target = join(directory, item.name);
        if (item.isDirectory()) {
          if (depth === 0 && !/^[a-f0-9]{2}$/u.test(item.name)) continue;
          if (depth >= 2) {
            fail2("archive volume has an unexpected layout");
            return;
          }
          visit(target, depth + 1);
          continue;
        }
        if (depth === 0) continue;
        if (files >= MAX_RECONCILE_FILES) {
          fail2("archive volume exceeds the bounded reconcile limit");
          return;
        }
        try {
          const stat = fs.lstatSync(target);
          if (stat.isSymbolicLink() || !stat.isFile()) {
            fail2("archive volume contains a non-regular file");
            return;
          }
          files++;
          bytes += stat.size;
        } catch {
          fail2("an archived original could not be measured");
          return;
        }
      }
    };
    visit(this.root, 0);
    this.reconciledFiles = files;
    if (!confirmed) return;
    this.totalBytes = Math.max(this.totalBytes, bytes);
  }
  remember(entry) {
    this.owners.push(entry);
    const list = this.bySession.get(entry.sessionId) ?? [];
    if (list.length === 0) this.bySession.set(entry.sessionId, list);
    list.push(this.owners.length - 1);
    this.identities.set(grantKey(entry.contentId, entry.sessionId, entry.callId), entry);
  }
  /** Torn manifest bytes observed at open; reported, never guessed. */
  get tornBytes() {
    return this.tornManifestBytes;
  }
  /** Archived originals currently addressable. */
  get size() {
    return this.contents.size;
  }
  /** Session grants recorded so far. */
  get grants() {
    return this.owners.length;
  }
  /** Absolute directory an operator can read, back up or export without this plugin. */
  get directory() {
    return this.root;
  }
  /**
   * Durably store one original and register this session's grant over it.
   * Idempotent by content for the blob and by `(session, call)` for the grant.
   * @param input - original bytes plus the identity to record.
   * @returns the immutable content facts.
   * @throws ArchiveUnavailableError when durability cannot be established.
   */
  save(input) {
    this.assertWritable();
    if (input.sessionId.length === 0 || input.sessionId.length > 200) fail("invalid session identity");
    const bytes = Buffer.from(input.text, "utf8");
    const contentId = createHash("sha256").update(bytes).digest("hex");
    let entry = this.contents.get(contentId);
    if (entry === void 0 && this.totalBytes + bytes.byteLength > this.maxTotalBytes) {
      fail(`archive quota of ${this.maxTotalBytes} bytes would be exceeded; new reduction is disabled and the Host result is kept`);
    }
    try {
      return this.commit(entry, contentId, bytes, input);
    } catch (error) {
      this.poison(error instanceof Error ? error.message : String(error));
      throw error;
    }
  }
  /** The durable half of {@link save}: blob, content row, grant row. */
  commit(entry, contentId, bytes, input) {
    if (entry === void 0) {
      const path = blobPath(this.root, contentId);
      const shard = dirname(path);
      const parent = dirname(shard);
      installDirectory(parent);
      syncDirectory(this.root);
      installDirectory(shard);
      syncDirectory(parent);
      this.writeBlob(shard, path, bytes);
      this.verifyBlob(path, contentId);
      this.totalBytes += bytes.byteLength;
      const stored = { contentId, bytes: bytes.byteLength, originalChars: input.text.length, createdAt: Date.now() };
      this.content.append({ ...stored });
      this.contents.set(contentId, stored);
      entry = stored;
    } else {
      const path = blobPath(this.root, contentId);
      this.ensureBlob(path, contentId, bytes);
    }
    const identity = grantKey(contentId, input.sessionId, input.callId);
    const existing = this.identities.get(identity);
    if (existing !== void 0) {
      const conflict = existing.rule !== input.rule || existing.ruleVersion !== input.ruleVersion || existing.shortenedChars !== input.shortenedChars || existing.tool !== input.source.slice(0, 120) || existing.complete !== (input.complete === true);
      if (conflict) {
        this.conflictingOwnerRows++;
        fail("the recorded grant for this identity disagrees with the new facts; the conflicting reference is refused");
      }
      return entry;
    }
    const owner = {
      contentId,
      sessionId: input.sessionId,
      tool: input.source.slice(0, 120),
      rule: input.rule,
      ruleVersion: input.ruleVersion,
      shortenedChars: input.shortenedChars,
      complete: input.complete === true,
      at: Date.now(),
      ...input.callId === void 0 ? {} : { callId: input.callId }
    };
    this.owner.append({ ...owner });
    this.remember(owner);
    return entry;
  }
  /** Write one blob atomically at its content address; never leaves a partial file. */
  writeBlob(shard, path, bytes) {
    if (fs.existsSync(path)) return;
    const temporary = join(shard, `.${basename(path, ".txt")}.${process.pid}.tmp`);
    let renamed = false;
    try {
      const fd = fs.openSync(temporary, fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY | NO_FOLLOW, 384);
      try {
        fs.writeFileSync(fd, bytes);
        fs.fsyncSync(fd);
      } finally {
        fs.closeSync(fd);
      }
      fs.renameSync(temporary, path);
      renamed = true;
      syncDirectory(shard);
    } catch (error) {
      if (!renamed) {
        try {
          fs.unlinkSync(temporary);
        } catch {
        }
      }
      throw new ArchiveUnavailableError(`Context archive: cannot store original text: ${String(error)}`);
    }
  }
  /**
   * Guarantee that the blob at one content address exists and hashes to that
   * address. A missing or mismatched file is replaced from the caller's exact
   * bytes; a replacement that still fails verification is a hard failure, so a
   * reference is never granted over unreadable content.
   */
  ensureBlob(path, contentId, bytes) {
    let healthy = false;
    try {
      this.verifyBlob(path, contentId);
      healthy = true;
    } catch {
      healthy = false;
    }
    if (healthy) return;
    try {
      fs.unlinkSync(path);
    } catch (error) {
      if (error.code !== "ENOENT") {
        throw new ArchiveUnavailableError(`Context archive: cannot replace unreadable original text: ${String(error)}`);
      }
    }
    const shard = dirname(path);
    installDirectory(dirname(shard));
    syncDirectory(this.root);
    installDirectory(shard);
    syncDirectory(dirname(shard));
    this.writeBlob(shard, path, bytes);
    this.verifyBlob(path, contentId);
    syncDirectory(shard);
  }
  /** Content facts for one content id, or undefined when never stored. */
  entry(contentId) {
    return this.contents.get(contentId);
  }
  /** Every grant for this session over one content id, oldest first. */
  grantsFor(contentId, sessionId) {
    return this.owners.filter((item) => item.contentId === contentId && item.sessionId === sessionId);
  }
  /** Whether this archive holds an original at all, for scope decisions. */
  knows(contentId) {
    return this.contents.has(contentId);
  }
  /**
   * Durably record that the Host's authoritative final result still carried the
   * reduced text for one grant. This is the only fact that may be presented as a
   * realised saving.
   * @param contentId - digest of the stored original.
   * @param sessionId - the session whose grant is confirmed.
   * @param callId - the call the grant belongs to, when the Host reported one.
   */
  notePublished(contentId, sessionId, callId) {
    this.note(contentId, sessionId, callId, "published");
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
  noteReverted(contentId, sessionId, callId, reason) {
    this.note(contentId, sessionId, callId, "reverted", reason);
  }
  note(contentId, sessionId, callId, outcome, reason) {
    if (this.closed || this.poisoned !== void 0) return;
    const key = grantKey(contentId, sessionId, callId);
    if (this.outcomes.get(key) === outcome) return;
    if (!this.contents.has(contentId)) return;
    const bounded = reason === void 0 ? void 0 : reason.slice(0, 120);
    this.outcome.append({
      contentId,
      sessionId,
      outcome,
      ...callId === void 0 ? {} : { callId },
      ...bounded === void 0 ? {} : { reason: bounded }
    });
    this.outcomes.set(key, outcome);
    if (bounded === void 0) this.reasons.delete(key);
    else this.reasons.set(key, bounded);
  }
  /** Durable outcome of one grant, or undefined while it is still pending. */
  outcomeOf(contentId, sessionId, callId) {
    return this.outcomes.get(grantKey(contentId, sessionId, callId));
  }
  /** Reasons recorded for reductions whose short text the Host finally dropped. */
  revertedReason(contentId, sessionId, callId) {
    return this.reasons.get(grantKey(contentId, sessionId, callId));
  }
  /** Grants for one session in insertion order, newest `limit` kept. */
  sessionGrants(sessionId, limit) {
    const indexes = this.bySession.get(sessionId) ?? [];
    const result = [];
    for (let index = indexes.length - 1; index >= 0 && result.length < limit; index--) {
      const owner = this.owners[indexes[index]];
      if (owner) result.push(owner);
    }
    return result.reverse();
  }
  /** Grantee session ids that currently reference one content id. */
  referencingSessions(contentId) {
    return [...new Set(this.owners.filter((item) => item.contentId === contentId).map((item) => item.sessionId))];
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
  summary(sessionId, limit = 32) {
    const relevant = sessionId === void 0 ? this.owners : this.owners.filter((item) => item.sessionId === sessionId);
    const seen = /* @__PURE__ */ new Set();
    const volume = relevant.reduce((total, owner) => {
      const content = this.contents.get(owner.contentId);
      const first = !seen.has(owner.contentId);
      if (first) seen.add(owner.contentId);
      return {
        originals: total.originals + (first ? 1 : 0),
        originalChars: total.originalChars + (first ? content?.originalChars ?? 0 : 0),
        archivedBytes: total.archivedBytes + (first ? content?.bytes ?? 0 : 0)
      };
    }, { originals: 0, originalChars: 0, archivedBytes: 0 });
    let pending = 0, reverted = 0;
    const published = { references: 0, originalChars: 0, shortenedChars: 0, visibleCharsRemoved: 0 };
    for (const owner of relevant) {
      const outcome = this.outcomes.get(grantKey(owner.contentId, owner.sessionId, owner.callId));
      if (outcome === void 0) {
        pending++;
        continue;
      }
      if (outcome === "reverted") {
        reverted++;
        continue;
      }
      const content = this.contents.get(owner.contentId);
      const originalChars = content?.originalChars ?? 0;
      published.references++;
      published.originalChars += originalChars;
      published.shortenedChars += owner.shortenedChars;
      published.visibleCharsRemoved += Math.max(0, originalChars - owner.shortenedChars);
    }
    return {
      volume,
      published,
      pending,
      reverted,
      recent: relevant.slice(-limit).reverse(),
      notes: [
        "volume \u662F\u5DF2\u5B58\u539F\u6587\u4F53\u79EF\uFF0C\u542B\u672A\u53D1\u5E03\u4E0E\u5DF2\u64A4\u56DE\u7684\u5F15\u7528\uFF0C\u4E0D\u80FD\u5F53\u4F5C\u5DF2\u751F\u6548\u7CBE\u7B80",
        "published \u53EA\u7EDF\u8BA1\u6700\u7EC8 Host \u7ED3\u679C\u786E\u8BA4\u4FDD\u7559\u4E86\u77ED\u6587\u7684\u5F15\u7528\uFF0C\u91CD\u542F\u540E\u4ECD\u7531\u8010\u4E45\u6210\u679C\u884C\u91CD\u5EFA",
        "visibleCharsRemoved \u662F\u53EF\u89C1\u6587\u672C\u5B57\u7B26\u5DEE\uFF0C\u4E0D\u662F\u8D26\u5355\u91D1\u989D\u6216 Token \u8BA1\u8D39\u8282\u7701"
      ]
    };
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
  searchSession(sessionId, query, options) {
    const candidates = this.sessionGrants(sessionId, Math.max(1, options.maxEntries));
    const ceiling = this.sessionGrants(sessionId, options.maxEntries + 1).length > candidates.length;
    return this.searchOwners(candidates, query, options, ceiling);
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
  searchOwners(owners, query, options, ceilingReached = false) {
    this.assertUsable();
    const hits = [];
    const visited = /* @__PURE__ */ new Set();
    const candidates = owners.slice(0, Math.max(1, options.maxEntries));
    let scannedEntries = 0, scanned = 0, truncated = ceilingReached, skipped = 0, unavailable = 0;
    for (const owner of candidates) {
      if (hits.length >= options.limit) {
        truncated = true;
        break;
      }
      if (scannedEntries >= options.maxEntries || scanned >= options.maxChars) {
        truncated = true;
        break;
      }
      if (visited.has(owner.contentId)) continue;
      visited.add(owner.contentId);
      const content = this.contents.get(owner.contentId);
      if (content === void 0) {
        unavailable++;
        truncated = true;
        continue;
      }
      const budget = Math.min(options.maxChars - scanned, content.originalChars);
      if (budget <= 0) {
        skipped++;
        truncated = true;
        continue;
      }
      let text;
      try {
        text = this.read(owner.contentId, { maxChars: budget });
      } catch {
        if (content.originalChars > budget) skipped++;
        else unavailable++;
        truncated = true;
        continue;
      }
      scannedEntries++;
      scanned += text.length;
      const found = text.indexOf(query);
      if (found >= 0) {
        const start = Math.max(0, found - 80);
        hits.push({ owner, offset: found, snippet: text.slice(start, start + query.length + 200) });
      }
    }
    return { hits, scannedEntries, scannedChars: scanned, truncated, skipped, unavailable };
  }
  /**
   * Read one archived original by content id.
   * @param contentId - digest that also names the blob file.
   * @param options - `maxChars` refuses to load a larger file (bounded read).
   * @returns the exact original text.
   * @throws ArchiveUnavailableError when the entry is unknown, oversized or corrupt.
   */
  read(contentId, options = {}) {
    this.assertUsable();
    const entry = this.contents.get(contentId);
    if (entry === void 0) fail(`no archived original for content id ${contentId.slice(0, 16)}`);
    if (options.maxChars !== void 0 && entry.originalChars > options.maxChars) {
      fail(`archived original is larger than the ${options.maxChars}-character read budget`);
    }
    const path = blobPath(this.root, contentId);
    const stat = fs.lstatSync(path);
    if (!stat.isFile() || stat.isSymbolicLink()) fail("archived original is not a regular file");
    if (stat.size !== entry.bytes) fail("archived original size does not match its manifest row");
    const fd = fs.openSync(path, fs.constants.O_RDONLY | NO_FOLLOW);
    try {
      const held = fs.fstatSync(fd);
      if (!held.isFile() || held.dev !== stat.dev || held.ino !== stat.ino) fail("archived original changed while opening");
      const bytes = fs.readFileSync(fd);
      const digest = createHash("sha256").update(bytes).digest("hex");
      if (digest !== contentId) fail("archived original is corrupt: content hash mismatch");
      return bytes.toString("utf8");
    } finally {
      fs.closeSync(fd);
    }
  }
  /**
   * Blob files present on disk but absent from the content manifest. These are
   * the only entries a space recovery may ever consider, and never while any
   * session grant references them. Reported, never deleted automatically.
   */
  scanOrphans() {
    this.assertUsable();
    const orphans = [];
    for (const first of fs.readdirSync(this.root)) {
      const level1 = join(this.root, first);
      if (!/^[a-f0-9]{2}$/u.test(first) || !fs.lstatSync(level1).isDirectory()) continue;
      for (const second of fs.readdirSync(level1)) {
        const level2 = join(level1, second);
        if (!/^[a-f0-9]{2}$/u.test(second) || !fs.lstatSync(level2).isDirectory()) continue;
        for (const file of fs.readdirSync(level2)) {
          const match = /^([a-f0-9]{64})\.txt$/u.exec(file);
          if (!match) continue;
          if (this.contents.has(match[1])) continue;
          orphans.push(match[1]);
        }
      }
    }
    return orphans;
  }
  verifyBlob(path, contentId) {
    const stat = fs.lstatSync(path);
    if (!stat.isFile() || stat.isSymbolicLink()) fail("archived original is not a regular file");
    const fd = fs.openSync(path, fs.constants.O_RDONLY | NO_FOLLOW);
    try {
      const held = fs.fstatSync(fd);
      if (!held.isFile() || held.dev !== stat.dev || held.ino !== stat.ino) fail("archived original changed while opening");
      const digest = createHash("sha256").update(fs.readFileSync(fd)).digest("hex");
      if (digest !== contentId) fail("archived original does not match its content id");
    } finally {
      fs.closeSync(fd);
    }
  }
  /** Stop accepting writes. Stored originals and the manifests are never removed. */
  close() {
    this.closed = true;
  }
};
export {
  ARCHIVE_DIRECTORY,
  ARCHIVE_FORMAT,
  ArchiveUnavailableError,
  CONTENT_ROW_VERSION,
  DEFAULT_MAX_TOTAL_BYTES,
  OUTCOME_ROW_VERSION,
  OWNER_ROW_VERSION,
  TextArchive,
  hashText
};
