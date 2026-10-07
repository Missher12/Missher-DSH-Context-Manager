import { test } from 'node:test'
import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'

const compiled = await build({
  entryPoints: [fileURLToPath(new URL('../src/checkpoint.ts', import.meta.url))],
  bundle: true, write: false, platform: 'node', format: 'esm', target: 'es2022',
  tsconfigRaw: { compilerOptions: { target: 'ES2022' } },
  plugins: [{ name: 'installed-public-api', setup(builder) {
    builder.onResolve({ filter: /^[^./]/ }, args => ({ path: import.meta.resolve(args.path), external: true }))
  } }],
})
const { formatCheckpoint, classifyCheckpoint, expectedRepair, repairDeviations, CheckpointFormatError } = await import(`data:text/javascript;base64,${Buffer.from(`${compiled.outputFiles[0].text}\n//# sourceURL=checkpoint-test.js`).toString('base64')}`)

const source = { sessionId: 'session-fixture', compactionId: 'compaction-fixture' }
const checkpoint = () => ({
  goal: '完成上下文恢复回归',
  constraints: ['不写日常 profile', '保留用户的最新纠正'],
  completed: ['真实恢复回归已经通过'],
  pending: ['执行隔离候选整组测试'],
  evidence: ['/tmp/candidate/verification.json', 'node --test tests/idle-recovery.test.mjs'],
  next: '检查整组结果并记录仍未验证的层级',
  uncertainties: ['原生界面尚未验证'],
})

test('checkpoint: valid Chinese seven-field JSON becomes readable Markdown with exact source references', () => {
  const value = checkpoint()
  const formatted = formatCheckpoint(JSON.stringify(value), source)
  assert.deepEqual([...formatted.matchAll(/^## (.+)$/gm)].map(match => match[1]), ['当前目标', '约束与纠正', '已完成', '待完成', '证据与引用', '下一步', '尚未核实'])
  for (const item of Object.values(value).flat()) assert.ok(formatted.includes(item), `checkpoint must preserve ${item}`)
  assert.ok(formatted.includes('- 不写日常 profile'))
  assert.ok(formatted.includes('原文保留在会话日志；需要细节时使用已有会话查询工具按引用找回。'))
  assert.ok(formatted.endsWith('Session: session-fixture\nCompaction: compaction-fixture'))
})

test('checkpoint: empty lists remain explicit and fenced JSON does not enter the formatted surface', () => {
  const value = { goal: '核验完成', constraints: [], completed: [], pending: [], evidence: [], next: '无后续动作', uncertainties: [] }
  const plain = formatCheckpoint(JSON.stringify(value), source)
  const fenced = formatCheckpoint(`\n\`\`\`json\n${JSON.stringify(value)}\n\`\`\`\n`, source)
  assert.equal(fenced, plain)
  assert.equal((plain.match(/无已记录事项。/g) ?? []).length, 5)
  assert.equal(plain.includes('```'), false)
})

test('checkpoint: every required field is enforced before any Markdown is returned', () => {
  for (const key of Object.keys(checkpoint())) {
    const value = checkpoint()
    delete value[key]
    assert.throws(() => formatCheckpoint(JSON.stringify(value), source), /原始记录保留/, `missing ${key} must be rejected`)
  }
  for (const patch of [{ goal: '' }, { next: '   ' }, { constraints: '必须是数组' }, { completed: [null] }, { pending: [''] }, { evidence: {} }, { uncertainties: true }, { extra: 'unexpected' }]) {
    assert.throws(() => formatCheckpoint(JSON.stringify({ ...checkpoint(), ...patch }), source), /原始记录保留/)
  }
})

test('checkpoint: invalid JSON, scalar bodies and surrounding explanations fail closed', () => {
  for (const raw of ['not JSON', '{"goal":', 'null', '[]', '"ordinary summary"', `说明：${JSON.stringify(checkpoint())}`, `${JSON.stringify(checkpoint())}\n任务已经完成。`]) {
    assert.throws(() => formatCheckpoint(raw, source), /原始记录保留/)
  }
})

test('checkpoint: whitelisted lossless wrappers normalize to the identical checkpoint', () => {
  const value = checkpoint()
  const json = JSON.stringify(value)
  const plain = formatCheckpoint(json, source)
  const wrappers = [
    `\uFEFF${json}`, // leading BOM
    `\r\n${json}\r\n`, // CRLF line endings
    `\`\`\`json\r\n${json}\r\n\`\`\`\r\n`, // CRLF single json fence
    `\n  \`\`\`JSON  \n${json}\n\`\`\`  \n`, // uppercase tag and fence padding
    `\`\`\`\n${json}\n\`\`\``, // untagged single fence
    `  \n${json}\n\n`, // surrounding whitespace
  ]
  for (const raw of wrappers) assert.equal(formatCheckpoint(raw, source), plain, `wrapper must preserve every field: ${JSON.stringify(raw.slice(0, 24))}`)
})

test('checkpoint: ambiguous or damaged wrappers are rejected without scanning for a JSON object', () => {
  const json = JSON.stringify(checkpoint())
  const reject = [
    `before\n\`\`\`json\n${json}\n\`\`\`\nafter`, // prose around the fence
    `${json}\n${json}`, // two contradictory JSON objects
    `\`\`\`json\n${json}`, // unterminated fence
    `\`\`\`json\n${json.slice(0, json.length - 12)}`, // truncated JSON inside a fence
    `\`\`\`text\n${json}\n\`\`\``, // non-json language tag is not whitelisted
    `\`\`\`json\nnot json\n\`\`\``, // fence with invalid body
    '{"goal":', // truncated JSON
    `${json}{"extra":1}`, // trailing second object
  ]
  for (const raw of reject) assert.throws(() => formatCheckpoint(raw, source), /原始记录保留/, `must reject: ${JSON.stringify(raw.slice(0, 24))}`)
})

test('checkpoint: only a single-string array field qualifies for the deterministic repair', () => {
  const broken = { ...checkpoint(), constraints: '必须是数组' }
  const classified = classifyCheckpoint(JSON.stringify(broken))
  assert.equal(classified.repairable, true)
  assert.match(classified.reason, /缺少数组包装/)
  const expected = expectedRepair(JSON.stringify(broken))
  assert.deepEqual(expected, { ...checkpoint(), constraints: ['必须是数组'] })
  const repaired = { ...checkpoint(), constraints: ['必须是数组'] }
  assert.deepEqual(repairDeviations(JSON.stringify(broken), repaired), [])
  // A repair that adds, splits or rephrases anything deviates from the deterministic wrap.
  assert.deepEqual(repairDeviations(JSON.stringify(broken), { ...repaired, constraints: ['必须是数组', '额外事实'] }), ['constraints'])
  assert.deepEqual(repairDeviations(JSON.stringify(broken), { ...repaired, goal: '被改写' }), ['goal'])
  const notRepairable = [
    ['truncated JSON', '{"goal":'],
    ['prose', 'ordinary summary'],
    ['missing field', JSON.stringify((() => { const value = checkpoint(); delete value.pending; return value })())],
    ['unknown field', JSON.stringify({ ...checkpoint(), extra: 'unexpected' })],
    ['empty goal', JSON.stringify({ ...checkpoint(), goal: '   ' })],
    ['goal with wrong type', JSON.stringify({ ...checkpoint(), goal: 42 })],
    ['nested object in array field', JSON.stringify({ ...checkpoint(), constraints: { nested: 'object' } })],
    ['mixed array items', JSON.stringify({ ...checkpoint(), completed: [1, 2] })],
    ['duplicate top key', JSON.stringify(checkpoint()).replace(/"goal":/, '"goal": "first", "goal":')],
    ['escaped duplicate top key', JSON.stringify(checkpoint()).replace(/"goal":/, '"goal": "first", "\\u0067oal":')],
    ['over-length item', JSON.stringify({ ...checkpoint(), evidence: ['e'.repeat(64001)] })],
    ['too many items', JSON.stringify({ ...checkpoint(), evidence: Array.from({ length: 101 }, (_, index) => `item-${index}`) })],
    ['empty string array field', JSON.stringify({ ...checkpoint(), constraints: '   ' })],
    ['scalar body', 'null'],
  ]
  for (const [label, raw] of notRepairable) {
    assert.equal(classifyCheckpoint(raw).repairable, false, `${label} must be rejected without repair`)
    assert.throws(() => formatCheckpoint(raw, source), /原始记录保留/, `${label} must fail closed`)
  }
})

test('checkpoint: parse failures carry their repair classification for the engine gate', () => {
  const broken = JSON.stringify({ ...checkpoint(), constraints: '必须是数组' })
  try { formatCheckpoint(broken, source); assert.fail('type-broken value must fail the strict schema') }
  catch (error) {
    assert.ok(error instanceof CheckpointFormatError)
    assert.equal(error.classification.repairable, true)
  }
})
