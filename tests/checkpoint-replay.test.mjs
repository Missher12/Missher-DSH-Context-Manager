/**
 * Pure protocol replay for the versioned section checkpoint: the same facts
 * survive repeated format/parse cycles while corrections and failed
 * acceptance items accumulate. This proves protocol stability, not model
 * semantic fidelity; a real-model replay is a separate, explicitly labelled
 * acceptance and is not performed here.
 */
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
const { formatCheckpoint, parseCheckpoint, parseCheckpointSections } = await import(`data:text/javascript;base64,${Buffer.from(`${compiled.outputFiles[0].text}\n//# sourceURL=checkpoint-replay-test.js`).toString('base64')}`)
const source = { sessionId: 'replay-session', compactionId: 'replay-1' }

const sections = value => `## 当前目标\n${value.goal}\n\n## 约束与纠正\n${value.constraints.map(line => `- ${line}`).join('\n') || '无'}\n\n## 已完成\n${value.completed.map(line => `- ${line}`).join('\n') || '无'}\n\n## 待完成\n${value.pending.map(line => `- ${line}`).join('\n') || '无'}\n\n## 证据与引用\n${value.evidence.map(line => `- ${line}`).join('\n') || '无'}\n\n## 下一步\n${value.next}\n\n## 尚未核实\n${value.uncertainties.map(line => `- ${line}`).join('\n') || '无'}`

test('section replay: three compactions preserve corrections, failures, evidence and the sole writer', () => {
  let value = parseCheckpointSections(sections({
    goal: '完成 Context 自动压缩升级',
    constraints: ['唯一写入者：本 DSH 执行会话'],
    completed: ['官方压缩研究已复核'],
    pending: ['宿主组合候选', '紧凑面板口径'],
    evidence: ['verification/automatic-compaction-20261013/PLAN.md'],
    next: '实现确定性修复与续跑余量',
    uncertainties: [],
  }))
  const expected = { constraints: new Set(value.constraints), completed: new Set(value.completed), evidence: new Set(value.evidence) }

  // Round 1: a user correction and a failed acceptance item arrive.
  value = parseCheckpoint(formatCheckpoint(sections({
    ...value,
    constraints: [...value.constraints, '用户最新纠正：不改保存策略'],
    evidence: [...value.evidence, '失败验收：旧 rc.2 SDK 已不可解析'],
  }), source))

  // Round 2: work completes; one obsolete claim moves to uncertainties.
  value = parseCheckpoint(formatCheckpoint(sections({
    ...value,
    completed: [...value.completed, '确定性修复零额外模型调用'],
    pending: value.pending.filter(item => item !== '宿主组合候选'),
    uncertainties: ['宿主组合候选仍待桌面负责人接收'],
  }), source))

  // Round 3: another compaction with the accumulated checkpoint as input.
  const round3 = parseCheckpoint(formatCheckpoint(sections({ ...value, constraints: [...value.constraints, '仍然只有本会话可写源码'] }), source))
  for (const item of expected.constraints) assert.ok(round3.constraints.includes(item), `lost constraint: ${item}`)
  for (const item of expected.completed) assert.ok(round3.completed.includes(item), `lost completed: ${item}`)
  for (const item of expected.evidence) assert.ok(round3.evidence.includes(item), `lost evidence: ${item}`)
  assert.ok(round3.constraints.includes('用户最新纠正：不改保存策略'))
  assert.ok(round3.evidence.some(item => item.includes('失败验收')))
  assert.ok(round3.uncertainties.includes('宿主组合候选仍待桌面负责人接收'))
  assert.ok(!round3.pending.includes('宿主组合候选'), 'completed or moved work is not silently duplicated')
  assert.ok(round3.next.length > 0, 'the next action survives')
})

test('section replay: a damaged round is rejected instead of losing facts', () => {
  const value = parseCheckpointSections(sections({
    goal: '继续任务', constraints: ['唯一写入者'], completed: [], pending: ['下一步'], evidence: ['引用'], next: '继续', uncertainties: [],
  }))
  const formatted = formatCheckpoint(sections(value), source)
  const truncated = formatted.split('## 待完成')[0]
  assert.throws(() => parseCheckpoint(truncated), /缺少段落/)
  assert.throws(() => parseCheckpoint(formatted.replace('- >唯一写入者', '唯一写入者')), /v3 列表段落/)
})
