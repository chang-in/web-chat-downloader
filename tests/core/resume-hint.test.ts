import { describe, it, expect } from 'vitest'
import { buildResumeHint } from '../../src/core/resume-hint'

describe('buildResumeHint', () => {
  it('claude → "claude --resume <id>"(실측: 실제 재개까지 검증된 명령)', () => {
    expect(buildResumeHint('claude', 'sid-1')).toBe('claude --resume sid-1')
  })
  it('codex → "codex resume <id>"(실측: `codex resume --help`의 위치인자 SESSION_ID)', () => {
    expect(buildResumeHint('codex', 'sid-1')).toBe('codex resume sid-1')
  })
})
