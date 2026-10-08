/** Three isolated persistence faults against a frozen archive.ts; no Host/model/business writes. */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import sync from 'node:fs';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

if (!process.argv[2]) throw Error('Pass the source/stage root; source is copied before compilation.');
const sourceRoot = resolve(process.argv[2]);
const here = dirname(fileURLToPath(import.meta.url));
await fs.mkdir(join(here, 'runs'), { recursive: true });
const run = await fs.mkdtemp(join(here, 'runs', 'archive-faults-'));
const sourcePath = join(sourceRoot, 'src/archive.ts');
const original = await fs.readFile(sourcePath);
const sha = value => createHash('sha256').update(value).digest('hex');
const frozen = join(run, 'archive.ts');
await fs.writeFile(frozen, original, { flag: 'wx' });
const dependencyRoot = process.env.CONTEXT_CI_DEPS ? resolve(process.env.CONTEXT_CI_DEPS) : sourceRoot;
const require = createRequire(join(dependencyRoot, 'package.json'));
const { build } = await import(pathToFileURL(require.resolve('esbuild')).href);
const compiled = await build({ entryPoints: [frozen], bundle: true, write: false,
  platform: 'node', format: 'esm', target: 'es2022', tsconfigRaw: { compilerOptions: { target: 'ES2022' } } });
const { TextArchive, hashText } = await import(`data:text/javascript;base64,${Buffer.from(compiled.outputFiles[0].text).toString('base64')}`);
const results = [];
function eio(message) { return Object.assign(new Error(message), { code: 'EIO' }); }
const input = (text, callId = 'call-one') => ({ text, source: 'tool:bash', rule: 'audit-exact-repetition', ruleVersion: 1,
  shortenedChars: 5, complete: true, sessionId: 'synthetic-audit-session', callId });
async function fresh(name, maxTotalBytes) {
  const root = join(run, name);
  return { root, archive: TextArchive.open(root, { create: true, ...(maxTotalBytes === undefined ? {} : { maxTotalBytes }) }) };
}

/** Patches only FDs opened for this exact manifest inside this test process. */
function faultAt(target, hooks, fn) {
  const real = { openSync: sync.openSync, closeSync: sync.closeSync, fsyncSync: sync.fsyncSync, writeSync: sync.writeSync };
  const held = new Set();
  sync.openSync = function(path, ...args) {
    const fd = real.openSync.call(sync, path, ...args);
    if (typeof path === 'string' && resolve(path) === resolve(target)) held.add(fd);
    return fd;
  };
  sync.closeSync = function(fd) { held.delete(fd); return real.closeSync.call(sync, fd); };
  sync.fsyncSync = function(fd) {
    return held.has(fd) && hooks.fsync ? hooks.fsync(fd, real) : real.fsyncSync.call(sync, fd);
  };
  sync.writeSync = function(fd, ...args) {
    return held.has(fd) && hooks.write ? hooks.write(fd, args, real) : real.writeSync.call(sync, fd, ...args);
  };
  try { return fn(); }
  finally { Object.assign(sync, real); }
}
async function check(name, body) {
  let observed;
  try { await body(value => { observed = value; }); results.push({ name, status: 'pass', observed }); }
  catch (error) { results.push({ name, status: 'fail', error: String(error), observed }); }
}
function rows(path) { return sync.readFileSync(path, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line)); }
function blobStats(root) {
  const files = [];
  function visit(path) {
    for (const item of sync.readdirSync(path, { withFileTypes: true })) {
      const target = join(path, item.name);
      if (item.isDirectory()) visit(target);
      else if (/^[a-f0-9]{64}\.txt$/u.test(item.name)) files.push({ path: target, bytes: sync.statSync(target).size });
    }
  }
  visit(root);
  return { count: files.length, bytes: files.reduce((sum, item) => sum + item.bytes, 0) };
}

await check('complete owner row then reported fsync failure cannot duplicate identity on retry/reopen', async see => {
  const { root, archive } = await fresh('owner-ambiguous-flush');
  const text = 'exact-original-'.repeat(10), value = input(text);
  let injected = 0, firstError;
  try {
    faultAt(join(root, 'owners.jsonl'), { fsync(fd, real) {
      real.fsyncSync(fd); // complete row really exists; the caller receives an ambiguous I/O failure
      injected++;
      throw eio('audit: owner flush reported failure after complete row');
    } }, () => archive.save(value));
  } catch (error) { firstError = String(error); }
  assert.equal(injected, 1);
  assert.ok(firstError);
  const rowsAfterFailure = rows(join(root, 'owners.jsonl')).length;
  assert.equal(rowsAfterFailure, 1);
  let sameInstanceRetryAccepted = false, retryError;
  try { archive.save(value); sameInstanceRetryAccepted = true; } catch (error) { retryError = String(error); }
  const rowsAfterRetry = rows(join(root, 'owners.jsonl')).length;
  const sameInstanceGrants = archive.grants;
  archive.close();
  const reopened = TextArchive.open(root);
  let afterRestart;
  try {
    const ref = reopened.save(value); // retry is allowed after a validated reopen
    reopened.notePublished(ref.contentId, value.sessionId, value.callId);
    afterRestart = { grants: reopened.grants, matchingIdentity: reopened.grantsFor(hashText(text), value.sessionId).length,
      published: reopened.summary(value.sessionId).published };
  } finally { reopened.close(); }
  see({ injected, firstError, sameInstanceRetryAccepted, retryError, rowsAfterFailure, rowsAfterRetry, sameInstanceGrants, afterRestart });
  assert.equal(afterRestart.matchingIdentity, 1, 'one (session, call, content) identity must replay only once');
  assert.equal(afterRestart.published.references, 1, 'one confirmed reference must not become two after restart');
});

await check('detected corrupt manifest must block later new references from the same instance', async see => {
  const { root, archive } = await fresh('corrupt-owner');
  let injected = 0, firstError;
  try {
    faultAt(join(root, 'owners.jsonl'), { fsync(fd, real) {
      // Deliberate persistent-manifest corruption plus I/O failure; not a concurrent writer/attack model.
      // Only one byte of this synthetic target row is changed, and only its manifest FD is intercepted.
      real.writeSync(fd, Buffer.from('!'), 0, 1, 0);
      real.fsyncSync(fd);
      injected++;
      throw eio('audit: owner manifest corruption discovered after row write');
    } }, () => archive.save(input('original-before-corruption')));
  } catch (error) { firstError = String(error); }
  assert.equal(injected, 1);
  assert.ok(firstError);
  let secondReference, secondError;
  try { secondReference = archive.save(input('another-original-after-corruption', 'call-two')); }
  catch (error) { secondError = String(error); }
  archive.close();
  let reopenError;
  try { const next = TextArchive.open(root); next.close(); } catch (error) { reopenError = String(error); }
  see({ injected, firstError, returnedNewReference: secondReference !== undefined, secondError, reopenError });
  assert.equal(secondReference, undefined, 'a corrupt/unreadable manifest must poison writes until validated reopen');
});

await check('persistently unwritable content index cannot create unbounded blobs outside a small quota', async see => {
  const quota = 96;
  const { root, archive } = await fresh('unwritable-content', quota);
  const failures = [];
  let injected = 0;
  function trySave(instance, index) {
    const text = String(index).padStart(2, '0') + 'x'.repeat(62); // 64 UTF-8 bytes, unique per attempt
    try {
      faultAt(join(root, 'content.jsonl'), { write() {
        injected++;
        throw eio('audit: content manifest remains unwritable');
      } }, () => instance.save(input(text, `call-${index}`)));
    } catch (error) { failures.push(String(error)); }
  }
  for (let index = 0; index < 3; index++) trySave(archive, index);
  const beforeReopen = blobStats(root);
  archive.close();
  let reopened, reopenError;
  try { reopened = TextArchive.open(root, { maxTotalBytes: quota }); }
  catch (error) { reopenError = String(error); failures.push(reopenError); }
  let afterReopen;
  if (reopened) {
    try { trySave(reopened, 3); afterReopen = { ...blobStats(root), addressable: reopened.size }; }
    finally { reopened.close(); }
  } else afterReopen = { ...blobStats(root), addressable: null };
  see({ quota, injected, failures: failures.length, beforeReopen, afterReopen, reopenError });
  assert.equal(failures.length, 4, 'each reference must be refused; refusing unsafe reopen is accepted');
  assert.ok(afterReopen.bytes <= quota, `physical original blobs ${afterReopen.bytes} exceed declared whole-archive quota ${quota}`);
});

const report = { at: new Date().toISOString(), sourceRoot, sourcePath, sourceHash: sha(original), frozen,
  currentSourceHash: sha(await fs.readFile(sourcePath)),
  summary: { pass: results.filter(row => row.status === 'pass').length, fail: results.filter(row => row.status === 'fail').length }, results,
  limits: ['Only three synthetic target-manifest faults, one isolated Node process and unique test directories.',
    'Fault hooks intercept only exact target manifest FDs; all other writes/fsyncs call the original functions.',
    'The corruption test intentionally damages one fixture byte; no concurrent adversary or real disk corruption is claimed.',
    'No Desktop/UI tests, models, Host process, package install, daily profile, business file writes, or candidate lib build.'] };
await fs.writeFile(join(run, 'RESULTS.json'), JSON.stringify(report, null, 2) + '\n', { flag: 'wx' });
console.log(JSON.stringify({ run, ...report }, null, 2));
if (report.summary.fail > 0) process.exitCode = 1;
