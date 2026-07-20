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

  // ── 이어받기(여러 페이지) ────────────────────────────────
  // 한 응답에는 최근 50교환까지만 담기므로 content.js가 토큰으로 더 오래된 페이지를 받아
  // rawTexts에 최신 → 오래된 순서로 넣어준다.
  const turn = (q: string, a: string, ts: number) => [null, null, [[q]], [[[null, [a]]]], [ts]]
  const page = (turns: unknown[], nextToken: string | null = null) => {
    const line = JSON.stringify([['wrb.fr', 'hNvQHb', JSON.stringify([turns, nextToken]), null, null, 'generic']])
    return `)]}'\n\n${Buffer.byteLength(line, 'utf8')}\n${line}\n`
  }

  it('rawTexts 여러 장을 이어붙여 전체를 시간순으로 복원', () => {
    const newest = page([turn('4번', '4답', 1700000030), turn('3번', '3답', 1700000020)], 'tok')
    const older = page([turn('2번', '2답', 1700000010), turn('1번', '1답', 1700000000)])
    const c = geminiAdapter.normalize({
      source: 'gemini', externalId: 'g5', title: 't',
      rawText: newest, rawTexts: [newest, older], // 최신 페이지가 앞
    })
    expect(c.messages.map(m => m.text)).toEqual([
      '1번', '1답', '2번', '2답', '3번', '3답', '4번', '4답',
    ])
  })

  it('rawTexts가 없으면 rawText 한 장으로 동작(구버전 payload 호환)', () => {
    const only = page([turn('혼자', '혼자답', 1700000000)])
    const c = geminiAdapter.normalize({ source: 'gemini', externalId: 'g6', title: 't', rawText: only })
    expect(c.messages.map(m => m.text)).toEqual(['혼자', '혼자답'])
  })

  it('중간 페이지가 깨져도 나머지 페이지는 살린다', () => {
    const good = page([turn('살아남음', '답', 1700000010)])
    const c = geminiAdapter.normalize({
      source: 'gemini', externalId: 'g7', title: 't',
      rawText: good, rawTexts: [good, 'garbage'],
    })
    expect(c.messages.map(m => m.text)).toEqual(['살아남음', '답'])
  })
})
