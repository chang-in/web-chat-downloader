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
    expect(c.messages.map(m => [m.role, m.text])).toEqual([
      ['user', '안녕'],
      ['assistant', '반가워'],
      ['assistant', '실제 답변'],
      ['assistant', '이건 실제 텍스트야'],
    ])
  })

  it('content 배열만 있는 메시지는 누락되지 않고, thinking은 text에서 제외됨', () => {
    const c = claudeAdapter.normalize(raw)
    const msg = c.messages[2]
    expect(msg.text).toBe('실제 답변')
    expect(msg.text).not.toContain('사용자 의도를 분석하는 중')
  })

  it('플레이스홀더 펜스 블록은 제거되고 실제 텍스트는 보존됨', () => {
    const c = claudeAdapter.normalize(raw)
    const msg = c.messages[3]
    expect(msg.text).toBe('이건 실제 텍스트야')
    expect(msg.text).not.toContain('This block is not supported')
  })

  it('플레이스홀더만 있는 메시지(첨부 없음)는 건너뜀', () => {
    const rawPlaceholderOnly = {
      uuid: 'conv-2',
      name: 't',
      chat_messages: [
        {
          sender: 'assistant',
          text: '```\nThis block is not supported on your current device yet.\n```',
          created_at: '2026-07-01T00:00:00Z',
        },
      ],
    }
    const c = claudeAdapter.normalize(rawPlaceholderOnly)
    expect(c.messages).toEqual([])
  })

  it('created_at(ISO 문자열)을 ts(밀리초)로 변환', () => {
    const c = claudeAdapter.normalize(raw)
    expect(c.messages[0].ts).toBe(Date.parse('2026-07-01T00:00:00Z'))
  })
})
