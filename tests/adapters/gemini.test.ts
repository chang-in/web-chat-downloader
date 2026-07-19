import { describe, it, expect } from 'vitest'
import { readFileSync } from 'fs'
import { join } from 'path'
import { geminiAdapter } from '../../src/adapters/gemini'

const rawText = readFileSync(join(__dirname, '../fixtures/gemini-raw.txt'), 'utf-8')

describe('geminiAdapter', () => {
  it('gemini 소스 페이로드를 감지', () => {
    expect(geminiAdapter.detect({ source: 'gemini', externalId: 'g1', title: 't', rawText })).toBe(true)
  })

  it('다른 형태나 rawText 없는 값은 감지하지 않음', () => {
    expect(geminiAdapter.detect({ chat_messages: [], uuid: 'x' })).toBe(false)
    expect(geminiAdapter.detect({ mapping: {}, conversation_id: 'x' })).toBe(false)
    expect(geminiAdapter.detect(null)).toBe(false)
    expect(geminiAdapter.detect({ source: 'gemini', rawText: 123 })).toBe(false)
  })

  it('batchexecute 응답을 시간순 user/assistant 메시지로 정규화', () => {
    const c = geminiAdapter.normalize({ source: 'gemini', externalId: 'g1', title: '제목', rawText })
    expect(c.service).toBe('gemini')
    expect(c.externalId).toBe('g1')
    expect(c.title).toBe('제목')
    expect(c.messages.map(m => [m.role, m.text])).toEqual([
      ['user', '질문'],
      ['assistant', '답변'],
    ])
  })

  it('timestamp(초)를 ts(밀리초)로 변환', () => {
    const c = geminiAdapter.normalize({ source: 'gemini', externalId: 'g1', title: '제목', rawText })
    expect(c.messages[0].ts).toBe(1700000000 * 1000)
    expect(c.messages[1].ts).toBe(1700000000 * 1000)
  })

  it('턴이 시간 역순(DESC)이어도 정규화 결과는 시간순', () => {
    const turnEarly = [null, null, [['먼저']], [[[null, ['먼저답']]]], [1700000000]]
    const turnLate = [null, null, [['나중']], [[[null, ['나중답']]]], [1700000010]]
    const inner = [[turnLate, turnEarly]] // DESC: 나중이 먼저 나옴
    const envelope = [['wrb.fr', 'hNvQHb', JSON.stringify(inner), null, null, 'generic']]
    const line = JSON.stringify(envelope)
    const multiRawText = `)]}'\n\n${Buffer.byteLength(line, 'utf8')}\n${line}\n`
    const c = geminiAdapter.normalize({ source: 'gemini', externalId: 'g2', title: 't', rawText: multiRawText })
    expect(c.messages.map(m => [m.role, m.text])).toEqual([
      ['user', '먼저'],
      ['assistant', '먼저답'],
      ['user', '나중'],
      ['assistant', '나중답'],
    ])
  })

  it('타입 가드: 문자열이 아닌 값은 오염 대신 누락 처리', () => {
    const badTurn = [null, null, [[42]], [[[null, [null]]]], ['not-a-number']]
    const inner = [[badTurn]]
    const envelope = [['wrb.fr', 'hNvQHb', JSON.stringify(inner), null, null, 'generic']]
    const line = JSON.stringify(envelope)
    const badRawText = `)]}'\n\n${Buffer.byteLength(line, 'utf8')}\n${line}\n`
    const c = geminiAdapter.normalize({ source: 'gemini', externalId: 'g3', title: 't', rawText: badRawText })
    expect(c.messages).toEqual([])
  })

  it('파싱 실패(잘못된 형식) 시 메시지 없이 빈 배열 반환', () => {
    const c = geminiAdapter.normalize({ source: 'gemini', externalId: 'g4', title: 't', rawText: 'garbage' })
    expect(c.messages).toEqual([])
  })
})
