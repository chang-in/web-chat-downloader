import { describe, it, expect } from 'vitest'
import { mkdtempSync, readFileSync, readdirSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { writeCodexSession } from '../../src/core/codex-session-writer'
import type { NormalizedChat } from '../../src/adapters/types'

const chat: NormalizedChat = {
  service: 'claude', externalId: 'ext-1', title: 't',
  messages: [
    { role: 'user', text: '2+2?', ts: 1000 },
    { role: 'assistant', text: '4', ts: 2000 },
  ],
}

describe('writeCodexSession', () => {
  it('session_meta 1줄 + user/assistant response_item 2줄 생성', () => {
    const dir = mkdtempSync(join(tmpdir(), 'wcd-codex-'))
    const r = writeCodexSession(chat, { cwd: '/tmp/wt', dirOverride: dir })
    expect('sessionId' in r).toBe(true)
    const sid = (r as any).sessionId

    const files = readdirSync(dir)
    expect(files).toHaveLength(1)
    // 실측: rollout-<로컬시각>-<uuid>.jsonl, uuid는 세션 파일명·session_meta.payload.id와 일치
    expect(files[0]).toMatch(/^rollout-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-.+\.jsonl$/)
    expect(files[0]).toContain(sid)

    const lines = readFileSync(join(dir, files[0]), 'utf-8').trim().split('\n').map(l => JSON.parse(l))
    expect(lines).toHaveLength(3)
    const [meta, u, a] = lines

    // session_meta: 실측 4개 샘플 100% 공통 필드만 채운다
    expect(meta.type).toBe('session_meta')
    for (const f of ['id', 'timestamp', 'cwd', 'originator', 'cli_version', 'source', 'thread_source', 'model_provider']) {
      expect(meta.payload).toHaveProperty(f)
    }
    expect(meta.payload.id).toBe(sid)
    expect(meta.payload.cwd).toBe('/tmp/wt')
    // 대화형 세션처럼 보이도록(피커에도 뜨게) cli/codex_cli를 쓴다 — 실측: SessionSource enum에 "cli" 존재
    expect(meta.payload.source).toBe('cli')
    expect(meta.payload.originator).toBe('codex_cli')

    // response_item: 스키마상 필수인 type/role/content만 검증(id/phase는 optional이지만 assistant는 채움)
    expect(u.type).toBe('response_item')
    expect(u.payload.type).toBe('message')
    expect(u.payload.role).toBe('user')
    expect(u.payload.content).toEqual([{ type: 'input_text', text: '2+2?' }])

    expect(a.type).toBe('response_item')
    expect(a.payload.type).toBe('message')
    expect(a.payload.role).toBe('assistant')
    expect(a.payload.content).toEqual([{ type: 'output_text', text: '4' }])
    expect(a.payload.id).toMatch(/^msg_/)
    expect(a.payload.phase).toBe('final_answer')
  })

  it('빈 대화는 error 반환', () => {
    const r = writeCodexSession({ ...chat, messages: [] }, { cwd: '/tmp/wt', dirOverride: mkdtempSync(join(tmpdir(), 'wcd-codex-')) })
    expect('error' in r).toBe(true)
  })

  it('잘못된 ts(NaN)는 RangeError 없이 유효한 ISO timestamp로 폴백', () => {
    const dir = mkdtempSync(join(tmpdir(), 'wcd-codex-'))
    const badChat: NormalizedChat = {
      service: 'claude', externalId: 'ext-2', title: 't2',
      messages: [
        { role: 'user', text: 'hi', ts: NaN },
        { role: 'assistant', text: 'yo', ts: NaN },
      ],
    }
    let r: ReturnType<typeof writeCodexSession>
    expect(() => { r = writeCodexSession(badChat, { cwd: '/tmp/wt', dirOverride: dir }) }).not.toThrow()
    expect('sessionId' in r!).toBe(true)
    const files = readdirSync(dir)
    const lines = readFileSync(join(dir, files[0]), 'utf-8').trim().split('\n').map(l => JSON.parse(l))
    for (const line of lines) {
      expect(line.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/)
      expect(Number.isNaN(new Date(line.timestamp).getTime())).toBe(false)
    }
    // 파일명(로컬시각)도 유효해야 한다 — NaN 폴백이 파일명 생성까지 안 깨는지
    expect(files[0]).toMatch(/^rollout-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-.+\.jsonl$/)
  })

  it('같은 sessionId를 넘기면 그 id로 파일명을 만든다(재캡처 시 덮어쓰기용)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'wcd-codex-'))
    const fixedId = '019f0000-aaaa-7000-8000-000000000099'
    const r = writeCodexSession(chat, { cwd: '/tmp/wt', dirOverride: dir, sessionId: fixedId }) as any
    expect(r.sessionId).toBe(fixedId)
    expect(readdirSync(dir)[0]).toContain(fixedId)
  })

  it('이미지 첨부는 input_image(data URI)로, 파일 첨부는 본문에 경로 각주로 남는다', () => {
    const dir = mkdtempSync(join(tmpdir(), 'wcd-codex-'))
    const png1x1 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII='
    const withAttachments: NormalizedChat = {
      service: 'claude', externalId: 'ext-3', title: 't3',
      messages: [
        { role: 'user', text: '이 이미지 봐줘', ts: 1000, attachments: [{ filename: 'a.png', mediaType: 'image/png', data: png1x1 }] },
        { role: 'assistant', text: '확인했어요', ts: 2000 },
      ],
    }
    const r = writeCodexSession(withAttachments, { cwd: dir, dirOverride: dir }) as any
    const files = readdirSync(dir).filter(f => f.endsWith('.jsonl'))
    const lines = readFileSync(join(dir, files[0]), 'utf-8').trim().split('\n').map(l => JSON.parse(l))
    const u = lines[1]
    expect(u.payload.content).toEqual([
      { type: 'input_text', text: '이 이미지 봐줘' },
      { type: 'input_image', image_url: `data:image/png;base64,${png1x1}` },
    ])
    expect(r.sessionId).toBeTruthy()
  })
})
