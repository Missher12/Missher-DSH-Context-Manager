// Pure Node CI adapter. All mutation is restricted to unique synthetic fixtures.
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const sha = value => createHash('sha256').update(value).digest('hex')

export function validateAuditReport(report) {
  assert.equal(report.summary?.pass, 3, 'All three fault cases must pass')
  assert.equal(report.summary?.fail, 0)
  assert.equal(report.results?.length, 3, 'Do not accept an empty or partial suite')
  assert.equal(new Set(report.results.map(row => row.name)).size, 3)
  for (const row of report.results) {
    assert.equal(row.status, 'pass', row.name)
    assert(Number.isSafeInteger(row.observed?.injected) && row.observed.injected > 0,
      'Target manifest fault did not execute: ' + row.name)
  }
}

function physicalInventory(root) {
  let blobBytes = 0, manifestBytes = 0, otherBytes = 0, files = 0
  const walk = directory => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const file = join(directory, entry.name)
      assert(!entry.isSymbolicLink(), 'Unexpected symlink in synthetic fixture')
      if (entry.isDirectory()) walk(file)
      else {
        assert(entry.isFile())
        const bytes = fs.statSync(file).size
        files++
        if (/^[a-f0-9]{64}\.txt$/u.test(entry.name)) blobBytes += bytes
        else if (['content.jsonl', 'owners.jsonl', 'outcomes.jsonl'].includes(entry.name)) manifestBytes += bytes
        else otherBytes += bytes
      }
    }
  }
  walk(root)
  return { files, blobBytes, manifestBytes, otherBytes, totalBytes: blobBytes + manifestBytes + otherBytes }
}

export function runArchiveCheck(sourceRoot, outputRoot) {
  fs.mkdirSync(outputRoot, { recursive: true })
  const result = {
    at: new Date().toISOString(), platform: process.platform, arch: process.arch,
    node: process.version, gitCommit: process.env.GITHUB_SHA ?? null,
    scope: 'Three manifest-fault cases on the native filesystem; no DSH SDK or Desktop acceptance',
    quotaAssertionScope: 'Retained original-text blobs, including orphaned blobs; manifest bytes are measured separately',
    hostStarts: 0, modelCalls: 0, ok: false,
  }
  try {
    const sourceFile = join(sourceRoot, 'src/archive.ts')
    const source = fs.readFileSync(sourceFile)
    const auditScript = fs.readFileSync(join(here, 'archive-faults.mjs'))
    const upstream = JSON.parse(fs.readFileSync(join(here, 'archive-faults.upstream.json')))
    result.sourceSha256 = sha(source)
    result.scriptSha256 = sha(auditScript)
    result.driverSha256 = sha(fs.readFileSync(fileURLToPath(import.meta.url)))
    result.upstreamScriptSha256 = upstream.upstreamSha256
    assert.equal(result.scriptSha256, upstream.adaptedSha256, 'Review and bind audit-script changes before running')
    const area = fs.mkdtempSync(join(tmpdir(), 'dsh archive 中文 '))
    result.fixtureRoot = area
    const snapshot = join(area, 'source'), audit = join(area, 'audit')
    fs.mkdirSync(join(snapshot, 'src'), { recursive: true })
    fs.mkdirSync(audit)
    fs.writeFileSync(join(snapshot, 'src/archive.ts'), source, { flag: 'wx' })
    fs.writeFileSync(join(snapshot, 'package.json'), '{"private":true,"type":"module"}\n', { flag: 'wx' })
    fs.writeFileSync(join(audit, 'archive-faults.mjs'), auditScript, { flag: 'wx' })
    // Inherits the isolated compiler location; the child never installs the SDK.
    const child = spawnSync(process.execPath, [join(audit, 'archive-faults.mjs'), snapshot], {
      cwd: area, env: process.env, encoding: 'utf8', timeout: 90_000, maxBuffer: 4 * 1024 * 1024,
    })
    fs.writeFileSync(join(outputRoot, 'archive-child-stdout.txt'), child.stdout ?? '')
    fs.writeFileSync(join(outputRoot, 'archive-child-stderr.txt'), child.stderr ?? '')
    result.child = { status: child.status, signal: child.signal, error: child.error?.message }
    const runs = fs.existsSync(join(audit, 'runs')) ? fs.readdirSync(join(audit, 'runs')) : []
    assert.equal(runs.length, 1, 'Missing or ambiguous audit run')
    const run = join(audit, 'runs', runs[0])
    const report = JSON.parse(fs.readFileSync(join(run, 'RESULTS.json')))
    fs.writeFileSync(join(outputRoot, 'archive-faults-result.json'), JSON.stringify(report, null, 2) + '\n')
    result.summary = report.summary
    result.faultHits = report.results.map(row => ({ name: row.name, injected: row.observed?.injected ?? 0 }))
    result.fixtures = Object.fromEntries(['owner-ambiguous-flush', 'corrupt-owner', 'unwritable-content']
      .map(name => [name, physicalInventory(join(run, name))]))
    assert.equal(report.sourceHash, result.sourceSha256)
    assert.equal(report.currentSourceHash, result.sourceSha256)
    assert.equal(sha(fs.readFileSync(sourceFile)), result.sourceSha256, 'Source changed while testing')
    assert.equal(child.error, undefined, 'Audit child failed or timed out')
    assert.equal(child.signal, null)
    assert.equal(child.status, 0)
    validateAuditReport(report)
    result.ok = true
  } catch (error) {
    result.error = { name: error.name, message: error.message }
  } finally {
    fs.writeFileSync(join(outputRoot, 'archive-platform-result.json'), JSON.stringify(result, null, 2) + '\n')
  }
  return result
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const result = runArchiveCheck(resolve(process.argv[2] ?? process.cwd()),
    resolve(process.env.CONTEXT_ARCHIVE_RESULTS ?? 'archive-platform-results'))
  console.log(JSON.stringify(result, null, 2))
  if (!result.ok) process.exitCode = 1
}
