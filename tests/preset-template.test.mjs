import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { Context } from '@deepseek-ai/cordis'
import { SystemPrompt, renderPrompt, renderContextSections } from '@deepseek-ai/dsh-system-prompt'
import { errorChain } from '@deepseek-ai/dsh-llm'
import { load, DEFAULT_SCHEMA, Type } from 'js-yaml'
import { DEPRECATED_CWD_CLAUSE } from '../scripts/generate-overlay.mjs'

const schema = DEFAULT_SCHEMA.extend([new Type('tag:yaml.org,2002:js', { kind: 'scalar', construct: text => ({ __jsExpr: text }) })])
const overlay = load(readFileSync(new URL('../cordis.patch.yml', import.meta.url), 'utf8'), { schema })
const legacyOverlay = readFileSync(new URL('./fixtures/context-local.5-cordis.patch.yml', import.meta.url), 'utf8')
const PRESETS = ['standard', 'ptc', 'cordis']
const persona = preset => overlay.find(row => row.id === `preset-${preset}`).config.plugins.find(entry => entry.id === 'persona')

/** The two prompt variables the alpha.2 agent loop owns, plus the literal working-directory context. */
const registerLoopFacts = ctx => {
  ctx.systemPrompt.variable('provider', () => 'deepseek-official')
  ctx.systemPrompt.variable('model', () => 'deepseek-flash')
  ctx.systemPrompt.context({
    name: 'working-directory:current',
    order: ctx.systemPrompt.getContextOrder('WORKING_DIRECTORY'),
    required: true,
    interpolate: false,
    // Deliberately contains a prompt-variable shape to prove runtime context stays literal.
    text: 'Current working directory: "/tmp/{{model}}"',
  })
}

test('alpha.2 assembly renders every overlay persona with only provider/model registered', async () => {
  for (const preset of PRESETS) {
    const { prefix, suffix } = persona(preset).config
    assert.ok(prefix.includes('{{model}}'))
    assert.equal(suffix, undefined)
    const ctx = new Context()
    try {
      await ctx.plugin(SystemPrompt, { includeHarnessIdentity: false, personaPrefix: prefix, personaSuffix: suffix ?? '' })
      registerLoopFacts(ctx)
      const assembly = await ctx.systemPrompt.assemble()
      assert.deepEqual(Object.keys(assembly.variables), ['provider', 'model'], `${preset}: registered prompt variables`)
      const rendered = renderPrompt(assembly)
      assert.equal(rendered, 'You are a coding agent powered by the deepseek-flash model.', preset)
      assert.ok(!rendered.includes('{{'), preset)
      const cwd = renderContextSections(assembly).find(entry => entry.name === 'working-directory:current')
      assert.ok(cwd, `${preset}: working-directory:current runtime context disappears`)
      assert.equal(cwd.text, 'Current working directory: "/tmp/{{model}}"', `${preset}: runtime context stays literal`)
    } finally {
      await ctx.fiber.dispose()
    }
  }
})

test('the old local.5 persona suffix fails real alpha.2 assembly as UNKNOWN before any model call', async () => {
  assert.equal((legacyOverlay.match(/\{\{cwd\}\}/g) ?? []).length, 3, 'legacy package carried three cwd suffixes')
  const ctx = new Context()
  try {
    await ctx.plugin(SystemPrompt, {
      includeHarnessIdentity: false,
      personaPrefix: 'You are a coding agent powered by the {{model}} model.',
      personaSuffix: DEPRECATED_CWD_CLAUSE,
    })
    registerLoopFacts(ctx)
    const assembly = await ctx.systemPrompt.assemble()
    let thrown
    assert.throws(() => renderPrompt(assembly), error => { thrown = error; return true })
    const expected = 'unknown prompt variable "{{cwd}}" in section "deployment:persona-suffix"; registered variables: provider, model'
    assert.equal(thrown.message, expected)
    // Same mapping the agent loop applies to a non-LlmError turn failure (agent.ts).
    assert.deepEqual({ message: errorChain(thrown), code: 'UNKNOWN' }, { message: expected, code: 'UNKNOWN' })
  } finally {
    await ctx.fiber.dispose()
  }
})
