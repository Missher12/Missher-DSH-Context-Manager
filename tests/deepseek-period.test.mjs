import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { transformSync } from 'esbuild'
const code = transformSync(readFileSync(new URL('../src/deepseek-period.ts', import.meta.url), 'utf8'), { loader: 'ts', format: 'esm' }).code
const { periodAt, nextPeriodChange, isOfficialDeepSeek, beijingTime } = await import(`data:text/javascript;base64,${Buffer.from(code).toString('base64')}`)
const at = value => Date.parse(value + '+08:00')

test('official periods use Beijing time with exclusive end boundaries and no local timezone dependency', () => {
  for (const [clock, expected] of [['08:59:59', 'offpeak'], ['09:00:00', 'peak'], ['11:59:59', 'peak'], ['12:00:00', 'offpeak'], ['13:59:59', 'offpeak'], ['14:00:00', 'peak'], ['17:59:59', 'peak'], ['18:00:00', 'offpeak']]) {
    assert.equal(periodAt(at(`2026-09-28T${clock}`)), expected, clock)
  }
  assert.equal(periodAt(Date.parse('2026-09-28T01:00:00Z')), 'peak')
  assert.equal(periodAt(Date.parse('2026-09-27T18:00:00-07:00')), 'peak')
  assert.equal(beijingTime(Date.parse('2026-09-28T01:00:00Z')), '9月28日 09:00')
  assert.equal(periodAt(Number.NaN), 'unknown')
  assert.equal(periodAt(at('2027-01-04T09:00:00')), 'unknown', 'unverified calendar must not guess')
})

test('weekends and national holidays stay off-peak; next change skips holidays and handles year boundary', () => {
  assert.equal(periodAt(at('2026-09-27T10:00:00')), 'offpeak')
  assert.equal(periodAt(at('2026-09-25T10:00:00')), 'offpeak', 'Mid-Autumn festival')
  assert.equal(periodAt(at('2026-10-01T10:00:00')), 'offpeak', 'National Day')
  assert.equal(periodAt(at('2026-10-07T15:00:00')), 'offpeak', 'public holiday calendar includes holiday break')
  assert.equal(periodAt(at('2026-10-10T10:00:00')), 'offpeak', 'weekend make-up work is still weekend')
  assert.equal(nextPeriodChange(at('2026-09-28T09:00:00')), at('2026-09-28T12:00:00'))
  assert.equal(nextPeriodChange(at('2026-09-28T12:00:00')), at('2026-09-28T14:00:00'))
  assert.equal(nextPeriodChange(at('2026-09-27T10:00:00')), at('2026-09-28T09:00:00'))
  assert.equal(nextPeriodChange(at('2026-09-30T18:00:00')), at('2026-10-08T09:00:00'))
  assert.equal(nextPeriodChange(at('2026-12-31T18:00:00')), null)
})

test('only known model names on host-owned DeepSeek official routes qualify', () => {
  assert.ok(isOfficialDeepSeek({ provider: 'deepseek-official', model: 'deepseek-flash' }))
  assert.ok(isOfficialDeepSeek({ provider: 'deepseek-account', model: 'deepseek-v4-pro' }))
  assert.ok(isOfficialDeepSeek({ provider: 'deepseek-official', model: 'deepseek-v4-flash' }))
  assert.equal(isOfficialDeepSeek({ provider: 'openrouter', model: 'deepseek-v4-pro' }), false)
  assert.equal(isOfficialDeepSeek({ provider: 'deepseek-official', model: 'future-unknown-model' }), false)
  assert.equal(isOfficialDeepSeek(null), false)
})
