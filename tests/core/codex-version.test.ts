import { describe, it, expect } from 'vitest'
import { parseCodexVersion } from '../../src/core/codex-version'

describe('parseCodexVersion', () => {
  // 실측: `codex --version` → "codex-cli 0.144.1" — claude와 달리 버전 앞에 바이너리명이 붙어서
  // 첫 토큰이 아니라 마지막 토큰을 취해야 한다.
  it('"codex-cli 0.144.1" → "0.144.1"', () => {
    expect(parseCodexVersion('codex-cli 0.144.1\n')).toBe('0.144.1')
  })
  it('빈/이상 입력 → 0.0.0', () => {
    expect(parseCodexVersion('')).toBe('0.0.0')
  })
})
