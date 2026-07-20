import { describe, it, expect } from 'vitest'
import { mkdtempSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { encodeMessage, decodeMessages, handleMessage, resolveCwd } from '../src/native-host'

const claudeRaw = { uuid: 'conv-native-1', name: 't', chat_messages: [
  { sender: 'human', text: '하이', created_at: '2026-07-01T00:00:00Z' },
  { sender: 'assistant', text: '헬로', created_at: '2026-07-01T00:00:01Z' },
] }

describe('Native Messaging 프레이밍', () => {
  it('인코드한 메시지를 그대로 디코드한다(왕복)', () => {
    const msg = { type: 'ping' }
    const buf = encodeMessage(msg)
    const { messages, rest } = decodeMessages(buf)
    expect(messages).toEqual([msg])
    expect(rest.length).toBe(0)
  })

  it('길이 프리픽스는 4바이트 little-endian uint32다', () => {
    const msg = { a: 1 }
    const buf = encodeMessage(msg)
    const json = Buffer.from(JSON.stringify(msg), 'utf-8')
    expect(buf.readUInt32LE(0)).toBe(json.length)
    expect(buf.length).toBe(4 + json.length)
  })

  it('멀티바이트(한글) payload는 문자 길이가 아닌 바이트 길이로 프레이밍된다', () => {
    const msg = { type: 'capture', payload: { title: '안녕하세요 테스트 대화입니다' } }
    const buf = encodeMessage(msg)
    const json = Buffer.from(JSON.stringify(msg), 'utf-8')
    // 한글은 UTF-8에서 문자당 3바이트라 문자 길이와 바이트 길이가 다르다 — 여기서 어긋나면
    // 문자 길이를 프리픽스에 썼다는 뜻(버그).
    expect(buf.readUInt32LE(0)).toBe(json.length)
    expect(buf.readUInt32LE(0)).not.toBe(JSON.stringify(msg).length)
    const { messages, rest } = decodeMessages(buf)
    expect(messages).toEqual([msg])
    expect(rest.length).toBe(0)
  })

  it('두 청크로 쪼개져 도착한 메시지도 누적하면 디코드된다', () => {
    const msg = { type: 'capture', payload: { title: '한글 페이로드 테스트', body: 'x'.repeat(50) } }
    const full = encodeMessage(msg)
    const splitAt = 6 // 헤더(4바이트)를 넘어 payload 중간에서 자름 — 첫 청크는 불완전해야 한다
    const chunk1 = full.subarray(0, splitAt)
    const chunk2 = full.subarray(splitAt)

    const first = decodeMessages(chunk1)
    expect(first.messages).toEqual([])
    expect(first.rest.equals(chunk1)).toBe(true) // 완전한 메시지가 없으면 통째로 rest에 남아야 한다

    const second = decodeMessages(Buffer.concat([first.rest, chunk2]))
    expect(second.messages).toEqual([msg])
    expect(second.rest.length).toBe(0)
  })

  it('한 버퍼에 메시지 여러 개가 이어붙어 있으면 순서대로 모두 디코드된다', () => {
    const a = { type: 'ping' }
    const b = { type: 'capture', payload: { x: 1 } }
    const buf = Buffer.concat([encodeMessage(a), encodeMessage(b)])
    const { messages, rest } = decodeMessages(buf)
    expect(messages).toEqual([a, b])
    expect(rest.length).toBe(0)
  })

  it('완전한 메시지 뒤에 다음 메시지의 일부만 붙어 있으면, 완전한 것만 반환하고 나머지는 rest에 남긴다', () => {
    const a = { type: 'ping' }
    const b = { type: 'capture', payload: { title: '나머지는 다음 청크' } }
    const bufB = encodeMessage(b)
    const partialB = bufB.subarray(0, 5)
    const buf = Buffer.concat([encodeMessage(a), partialB])

    const { messages, rest } = decodeMessages(buf)
    expect(messages).toEqual([a])
    expect(rest.equals(partialB)).toBe(true)
  })
})

describe('handleMessage', () => {
  it('ping → { ok: true, version }', () => {
    const res = handleMessage({ type: 'ping' }, mkdtempSync(join(tmpdir(), 'wcd-host-'))) as any
    expect(res.ok).toBe(true)
    expect(typeof res.version).toBe('string')
  })

  it('capture(정상 페이로드) → { ok: true, sessionId }', () => {
    const dir = mkdtempSync(join(tmpdir(), 'wcd-host-'))
    const res = handleMessage({ type: 'capture', payload: claudeRaw }, dir) as any
    expect(res.ok).toBe(true)
    expect(res.sessionId).toBeTruthy()
  })

  it('capture(인식 불가 페이로드) → { ok: false, error }', () => {
    const dir = mkdtempSync(join(tmpdir(), 'wcd-host-'))
    const res = handleMessage({ type: 'capture', payload: { foo: 1 } }, dir) as any
    expect(res.ok).toBe(false)
    expect(res.error).toBeTruthy()
  })

  it('알 수 없는 type → { ok: false, error }', () => {
    const dir = mkdtempSync(join(tmpdir(), 'wcd-host-'))
    const res = handleMessage({ type: 'unknown-type' }, dir) as any
    expect(res.ok).toBe(false)
  })

  it('index → { ok: true, index }: capture로 쌓인 엔트리가 externalId로 조회된다(확장의 "이미 저장됨" 표시용)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'wcd-host-'))
    const captured = handleMessage({ type: 'capture', payload: claudeRaw }, dir) as any
    const res = handleMessage({ type: 'index' }, dir) as any
    expect(res.ok).toBe(true)
    expect(res.index['conv-native-1']).toMatchObject({ sessionId: captured.sessionId, service: 'claude', title: 't' })
    expect(typeof res.index['conv-native-1'].capturedAt).toBe('number')
  })

  it('index: 캡처 이력이 없는 cwd는 빈 인덱스({})를 반환한다', () => {
    const dir = mkdtempSync(join(tmpdir(), 'wcd-host-'))
    const res = handleMessage({ type: 'index' }, dir) as any
    expect(res.ok).toBe(true)
    expect(res.index).toEqual({})
  })
})

describe('resolveCwd', () => {
  it('WCD_CWD 환경변수가 있으면 그걸 쓴다', () => {
    const prev = process.env.WCD_CWD
    process.env.WCD_CWD = '/tmp/wcd-custom-cwd'
    try { expect(resolveCwd()).toBe('/tmp/wcd-custom-cwd') }
    finally { if (prev === undefined) delete process.env.WCD_CWD; else process.env.WCD_CWD = prev }
  })

  it('WCD_CWD가 없으면 ~/Desktop/Archive/web-chats 기본값', () => {
    const prev = process.env.WCD_CWD
    delete process.env.WCD_CWD
    try { expect(resolveCwd().endsWith('/Desktop/Archive/web-chats')).toBe(true) }
    finally { if (prev !== undefined) process.env.WCD_CWD = prev }
  })
})
