import { describe, it, expect } from 'vitest'
import { mkdtempSync, readFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { writeSession } from '../../src/core/session-writer'
import type { NormalizedChat } from '../../src/adapters/types'

const chat: NormalizedChat = {
  service: 'claude', externalId: 'ext-1', title: 't',
  messages: [
    { role: 'user', text: '2+2?', ts: 1000 },
    { role: 'assistant', text: '4', ts: 2000 },
  ],
}

describe('writeSession', () => {
  it('필수 필드셋을 갖춘 user/assistant 2줄 생성', () => {
    const dir = mkdtempSync(join(tmpdir(), 'wcd-'))
    const r = writeSession(chat, { cwd: '/tmp/wt', dirOverride: dir })
    expect('sessionId' in r).toBe(true)
    const sid = (r as any).sessionId
    const lines = readFileSync(join(dir, `${sid}.jsonl`), 'utf-8').trim().split('\n').map(l => JSON.parse(l))
    expect(lines).toHaveLength(2)
    const [u, a] = lines
    // 필수 필드(실측 §6) — 공통 12필드 + 재현 필드(slug)
    for (const f of ['parentUuid','isSidechain','type','message','uuid','timestamp','userType','entrypoint','cwd','sessionId','version','gitBranch','slug']) {
      expect(u).toHaveProperty(f); expect(a).toHaveProperty(f)
    }
    // user 전용 재현 필드 / assistant 전용 재현 필드
    expect(u).toHaveProperty('promptId')
    expect(a).toHaveProperty('requestId')
    expect(u.type).toBe('user'); expect(a.type).toBe('assistant')
    expect(u.parentUuid).toBeNull()          // 첫 줄 체인 시작
    expect(a.parentUuid).toBe(u.uuid)        // 선형 체인
    expect(u.gitBranch).toBe('HEAD')
    expect(u.userType).toBe('external'); expect(u.entrypoint).toBe('cli')
    expect(u.sessionId).toBe(sid); expect(a.sessionId).toBe(sid)
    // 재현 필드 형식: id는 msg_ 접두, requestId는 req_ 접두
    expect(a.message.id).toMatch(/^msg_/)
    expect(a.requestId).toMatch(/^req_/)
    // assistant.message 스펙
    for (const f of ['model','id','type','role','content','stop_reason','stop_sequence','usage']) {
      expect(a.message).toHaveProperty(f)
    }
    expect(a.message.content).toEqual([{ type: 'text', text: '4' }])
    // usage 4필드 전부 0(정직: 우리가 추론 안 함)
    expect(a.message.usage.input_tokens).toBe(0)
    expect(a.message.usage.output_tokens).toBe(0)
    expect(a.message.usage.cache_creation_input_tokens).toBe(0)
    expect(a.message.usage.cache_read_input_tokens).toBe(0)
    expect(u.message).toEqual({ role: 'user', content: '2+2?' })
  })

  it('빈 대화는 error 반환', () => {
    const r = writeSession({ ...chat, messages: [] }, { cwd: '/tmp/wt', dirOverride: mkdtempSync(join(tmpdir(),'wcd-')) })
    expect('error' in r).toBe(true)
  })

  it('잘못된 ts(NaN)는 RangeError 없이 유효한 ISO timestamp로 폴백', () => {
    const dir = mkdtempSync(join(tmpdir(), 'wcd-'))
    const badChat: NormalizedChat = {
      service: 'claude', externalId: 'ext-2', title: 't2',
      messages: [
        { role: 'user', text: 'hi', ts: NaN },
        { role: 'assistant', text: 'yo', ts: NaN },
      ],
    }
    let r: ReturnType<typeof writeSession>
    expect(() => { r = writeSession(badChat, { cwd: '/tmp/wt', dirOverride: dir }) }).not.toThrow()
    expect('sessionId' in r!).toBe(true)
    const sid = (r! as any).sessionId
    const lines = readFileSync(join(dir, `${sid}.jsonl`), 'utf-8').trim().split('\n').map(l => JSON.parse(l))
    expect(lines).toHaveLength(2)
    for (const line of lines) {
      expect(line.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/) // ISO8601
      expect(Number.isNaN(new Date(line.timestamp).getTime())).toBe(false)
    }
  })
})
