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
    // 필수 필드(실측 §6)
    for (const f of ['parentUuid','isSidechain','type','message','uuid','timestamp','userType','entrypoint','cwd','sessionId','version','gitBranch']) {
      expect(u).toHaveProperty(f); expect(a).toHaveProperty(f)
    }
    expect(u.type).toBe('user'); expect(a.type).toBe('assistant')
    expect(u.parentUuid).toBeNull()          // 첫 줄 체인 시작
    expect(a.parentUuid).toBe(u.uuid)        // 선형 체인
    expect(u.gitBranch).toBe('HEAD')
    expect(u.userType).toBe('external'); expect(u.entrypoint).toBe('cli')
    expect(u.sessionId).toBe(sid); expect(a.sessionId).toBe(sid)
    // assistant.message 스펙
    for (const f of ['model','id','type','role','content','stop_reason','stop_sequence','usage']) {
      expect(a.message).toHaveProperty(f)
    }
    expect(a.message.content).toEqual([{ type: 'text', text: '4' }])
    expect(a.message.usage.input_tokens).toBe(0)
    expect(u.message).toEqual({ role: 'user', content: '2+2?' })
  })

  it('빈 대화는 error 반환', () => {
    const r = writeSession({ ...chat, messages: [] }, { cwd: '/tmp/wt', dirOverride: mkdtempSync(join(tmpdir(),'wcd-')) })
    expect('error' in r).toBe(true)
  })
})
