import { describe, it, expect } from 'vitest'
import { mkdtempSync, existsSync, readdirSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { storeBlob } from '../../src/core/blobstore'

describe('storeBlob', () => {
  it('base64를 attachments/<hash>.<ext>로 저장', () => {
    const dir = mkdtempSync(join(tmpdir(), 'wcd-'))
    const b64 = Buffer.from('hello').toString('base64')
    const r = storeBlob(dir, b64, 'png')
    expect(r.relPath).toBe(`attachments/${r.hash}.png`)
    expect(existsSync(join(dir, r.relPath))).toBe(true)
  })
  it('동일 내용은 중복 저장 안 함(같은 hash)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'wcd-'))
    const b64 = Buffer.from('dup').toString('base64')
    const a = storeBlob(dir, b64, 'png'); const b = storeBlob(dir, b64, 'png')
    expect(a.hash).toBe(b.hash)
    expect(readdirSync(join(dir, 'attachments'))).toHaveLength(1)
  })
  it('잘못된 base64는 throw', () => {
    const dir = mkdtempSync(join(tmpdir(), 'wcd-'))
    expect(() => storeBlob(dir, '!!!not-base64!!!', 'png')).toThrow()
  })
})
