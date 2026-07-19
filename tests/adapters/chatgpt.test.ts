import { describe, it, expect } from 'vitest'
import { readFileSync } from 'fs'
import { join } from 'path'
import { chatgptAdapter } from '../../src/adapters/chatgpt'

const raw = JSON.parse(readFileSync(join(__dirname, '../fixtures/chatgpt-raw.json'), 'utf-8'))

describe('chatgptAdapter', () => {
  it('ChatGPT 응답을 감지', () => {
    expect(chatgptAdapter.detect(raw)).toBe(true)
  })

  it('claude/gemini 원본이나 빈 값은 감지하지 않음', () => {
    expect(chatgptAdapter.detect({ chat_messages: [], uuid: 'x' })).toBe(false)
    expect(chatgptAdapter.detect({ source: 'gemini', rawText: 'x' })).toBe(false)
    expect(chatgptAdapter.detect(null)).toBe(false)
  })

  it('current_node→parent 체인을 시간순으로 정규화', () => {
    const c = chatgptAdapter.normalize(raw)
    expect(c.service).toBe('chatgpt')
    expect(c.externalId).toBe('conv-gpt-1')
    expect(c.title).toBe('제목')
    expect(c.messages.map(m => [m.role, m.text])).toEqual([
      ['user', '안녕'],
      ['assistant', '반가워'],
      ['assistant', '더 도와줄까'],
    ])
  })

  it('create_time(초)을 ts(밀리초)로 변환', () => {
    const c = chatgptAdapter.normalize(raw)
    expect(c.messages[0].ts).toBe(1700000000 * 1000)
    expect(c.messages[1].ts).toBe(1700000001 * 1000)
  })

  it('빈 텍스트 메시지는 건너뜀', () => {
    const rawWithEmpty = {
      conversation_id: 'conv-gpt-2',
      title: 't',
      current_node: 'n1',
      mapping: {
        n0: { message: { author: { role: 'user' }, content: { content_type: 'text', parts: [''] }, create_time: 1 }, parent: null, children: ['n1'] },
        n1: { message: { author: { role: 'assistant' }, content: { content_type: 'text', parts: ['답'] }, create_time: 2 }, parent: 'n0', children: [] },
      },
    }
    const c = chatgptAdapter.normalize(rawWithEmpty)
    expect(c.messages.map(m => m.text)).toEqual(['답'])
  })

  it('multimodal_text content_type도 허용, 문자열 파트만 합침', () => {
    const rawMulti = {
      conversation_id: 'conv-gpt-3',
      title: 't',
      current_node: 'n0',
      mapping: {
        n0: {
          message: {
            author: { role: 'user' },
            content: { content_type: 'multimodal_text', parts: ['텍스트1', { content_type: 'image_asset_pointer' }, '텍스트2'] },
            create_time: 1,
          },
          parent: null,
          children: [],
        },
      },
    }
    const c = chatgptAdapter.normalize(rawMulti)
    expect(c.messages[0].text).toBe('텍스트1\n텍스트2')
  })
})
