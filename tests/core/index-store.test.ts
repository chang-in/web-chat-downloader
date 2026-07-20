import { describe, it, expect } from 'vitest'
import { mkdtempSync, writeFileSync, readdirSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { resolveSessionId, upsertIndex, loadIndex } from '../../src/core/index-store'

describe('index-store', () => {
  it('신규 externalId는 null', () => {
    const dir = mkdtempSync(join(tmpdir(),'wcd-'))
    expect(resolveSessionId(dir, 'x')).toBeNull()
  })
  it('upsert 후 같은 externalId는 기존 sessionId 반환', () => {
    const dir = mkdtempSync(join(tmpdir(),'wcd-'))
    upsertIndex(dir, 'x', { sessionId:'sid-1', service:'claude', title:'t', capturedAt: 1 })
    expect(resolveSessionId(dir, 'x')).toBe('sid-1')
  })
  it('손상된 인덱스는 빈 인덱스로 폴백', () => {
    const dir = mkdtempSync(join(tmpdir(),'wcd-'))
    writeFileSync(join(dir, '.wcd-index.json'), '{ broken json')
    expect(loadIndex(dir)).toEqual({})
  })
  it('agent는 참고용 메타일 뿐 조회엔 영향 없음(같은 externalId는 agent와 무관하게 같은 sessionId)', () => {
    const dir = mkdtempSync(join(tmpdir(),'wcd-'))
    upsertIndex(dir, 'x', { sessionId:'sid-1', service:'claude', title:'t', capturedAt: 1, agent: 'claude' })
    upsertIndex(dir, 'x', { sessionId:'sid-1', service:'claude', title:'t', capturedAt: 2, agent: 'codex' })
    expect(resolveSessionId(dir, 'x')).toBe('sid-1')
  })
  it('기존 externalId 갱신은 sessionId를 덮어쓴다', () => {
    const dir = mkdtempSync(join(tmpdir(),'wcd-'))
    upsertIndex(dir, 'x', { sessionId:'sid-1', service:'claude', title:'t', capturedAt: 1 })
    upsertIndex(dir, 'x', { sessionId:'sid-2', service:'claude', title:'t2', capturedAt: 2 })
    expect(resolveSessionId(dir, 'x')).toBe('sid-2')
  })
  it('쓰기 후 디렉터리에 임시 파일이 남지 않는다', () => {
    const dir = mkdtempSync(join(tmpdir(),'wcd-'))
    upsertIndex(dir, 'x', { sessionId:'sid-1', service:'claude', title:'t', capturedAt: 1 })
    const leftover = readdirSync(dir).filter(f => f.endsWith('.tmp'))
    expect(leftover).toEqual([])
  })
  it('연속 호출해도 앞선 항목이 보존된다', () => {
    const dir = mkdtempSync(join(tmpdir(),'wcd-'))
    upsertIndex(dir, 'a', { sessionId:'sid-a', service:'claude', title:'ta', capturedAt: 1 })
    upsertIndex(dir, 'b', { sessionId:'sid-b', service:'claude', title:'tb', capturedAt: 2 })
    upsertIndex(dir, 'c', { sessionId:'sid-c', service:'claude', title:'tc', capturedAt: 3 })
    expect(resolveSessionId(dir, 'a')).toBe('sid-a')
    expect(resolveSessionId(dir, 'b')).toBe('sid-b')
    expect(resolveSessionId(dir, 'c')).toBe('sid-c')
    const leftover = readdirSync(dir).filter(f => f.endsWith('.tmp'))
    expect(leftover).toEqual([])
  })
})
