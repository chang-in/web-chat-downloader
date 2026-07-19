import { describe, it, expect } from 'vitest'
import { slug } from '../../src/core/slug'

describe('slug', () => {
  it('영숫자 아닌 문자를 각각 -로 치환', () => {
    expect(slug('/Users/x/a.b/c')).toBe('-Users-x-a-b-c')
  })
  it('공백·한글도 문자당 -', () => {
    expect(slug('/Users/x/AI 봇봇')).toBe('-Users-x-AI---') // 공백1 + 한글2 = ---
  })
  it('저장 폴더 경로', () => {
    expect(slug('/Users/macbook/Desktop/Archive/web-chats'))
      .toBe('-Users-macbook-Desktop-Archive-web-chats')
  })
})
