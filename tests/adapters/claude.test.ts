import { describe, it, expect } from 'vitest'
import { readFileSync } from 'fs'
import { join } from 'path'
import { claudeAdapter } from '../../src/adapters/claude'

const raw = JSON.parse(readFileSync(join(__dirname, '../fixtures/claude-raw.json'), 'utf-8'))

describe('claudeAdapter', () => {
  it('claude 응답을 감지', () => {
    expect(claudeAdapter.detect(raw)).toBe(true)
  })
  it('chat_messages를 NormalizedChat으로', () => {
    const c = claudeAdapter.normalize(raw)
    expect(c.service).toBe('claude')
    expect(c.externalId).toBe('conv-1')
    expect(c.messages.map(m => [m.role, m.text])).toEqual([['user','안녕'],['assistant','반가워']])
  })
})
