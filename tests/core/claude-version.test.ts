import { describe, it, expect } from 'vitest'
import { parseVersion } from '../../src/core/claude-version'

describe('parseVersion', () => {
  it('"2.1.207 (Claude Code)" → "2.1.207"', () => {
    expect(parseVersion('2.1.207 (Claude Code)\n')).toBe('2.1.207')
  })
  it('빈/이상 입력 → 0.0.0', () => {
    expect(parseVersion('')).toBe('0.0.0')
  })
})
