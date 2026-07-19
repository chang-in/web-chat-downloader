import { describe, it, expect } from 'vitest'
import { readFileSync } from 'fs'
import { join } from 'path'
import { parseBatchEnvelope } from '../../src/core/batch-envelope'

describe('parseBatchEnvelope', () => {
  it('실제 모양의 gemini 픽스처에서 inner JSON을 복원', () => {
    const rawText = readFileSync(join(__dirname, '../fixtures/gemini-raw.txt'), 'utf-8')
    const inner = parseBatchEnvelope(rawText, 'hNvQHb')
    expect(inner).toEqual([[[null, null, [['질문']], [[[null, ['답변']]]], [1700000000]]]])
  })

  it('한글이 포함된 임의 페이로드를 바이트 길이와 무관하게 왕복', () => {
    const payload = { greeting: '안녕하세요, "테스트"입니다 \\ 백슬래시', n: 42 }
    const envelope = [['wrb.fr', 'someRpc', JSON.stringify(payload), null, null, 'generic']]
    const line = JSON.stringify(envelope)
    const rawText = `)]}'\n\n${Buffer.byteLength(line, 'utf8')}\n${line}\n`
    expect(parseBatchEnvelope(rawText, 'someRpc')).toEqual(payload)
  })

  it('존재하지 않는 rpcid는 null', () => {
    const rawText = readFileSync(join(__dirname, '../fixtures/gemini-raw.txt'), 'utf-8')
    expect(parseBatchEnvelope(rawText, 'noSuchRpc')).toBeNull()
  })

  it('빈 입력은 null', () => {
    expect(parseBatchEnvelope('', 'hNvQHb')).toBeNull()
  })
})
