import { describe, it, expect } from 'vitest'
import { mkdtempSync, writeFileSync } from 'fs'
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
})
