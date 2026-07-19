import { describe, it, expect } from 'vitest'
import { mkdtempSync, readFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { handleCapture } from '../src/server'

const raw = { uuid:'conv-9', name:'t', chat_messages:[
  { sender:'human', text:'하이', created_at:'2026-07-01T00:00:00Z' },
  { sender:'assistant', text:'헬로', created_at:'2026-07-01T00:00:01Z' },
]}

describe('handleCapture', () => {
  it('감지·정규화·세션 생성, 인덱스 기록', () => {
    const dir = mkdtempSync(join(tmpdir(),'wcd-'))
    const r = handleCapture(raw, dir) as any
    expect(r.sessionId).toBeTruthy()
    expect(readFileSync(join(dir, '.wcd-index.json'),'utf-8')).toContain('conv-9')
  })
  it('같은 externalId 재캡처는 같은 sessionId(갱신)', () => {
    const dir = mkdtempSync(join(tmpdir(),'wcd-'))
    const a = handleCapture(raw, dir) as any
    const b = handleCapture(raw, dir) as any
    expect(b.sessionId).toBe(a.sessionId)
  })
  it('감지 실패는 error', () => {
    const dir = mkdtempSync(join(tmpdir(),'wcd-'))
    expect((handleCapture({ foo: 1 }, dir) as any).error).toBeTruthy()
  })
})
