import { describe, it, expect } from 'vitest'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ensureCert } from '../../src/core/self-signed-cert'

function hasOpenssl(): boolean {
  try { execFileSync('openssl', ['version'], { stdio: 'pipe' }); return true }
  catch { return false }
}

const openssl = hasOpenssl()

describe('ensureCert', () => {
  it.skipIf(!openssl)('키·인증서 파일을 생성하고 PEM 내용을 반환', () => {
    const dir = mkdtempSync(join(tmpdir(), 'wcd-cert-'))
    const { key, cert } = ensureCert(dir)
    expect(existsSync(join(dir, 'key.pem'))).toBe(true)
    expect(existsSync(join(dir, 'cert.pem'))).toBe(true)
    expect(key).toContain('BEGIN')
    expect(cert).toContain('BEGIN CERTIFICATE')
  })
  it.skipIf(!openssl)('이미 있으면 재생성하지 않고 재사용', () => {
    const dir = mkdtempSync(join(tmpdir(), 'wcd-cert-'))
    const a = ensureCert(dir)
    const b = ensureCert(dir)
    expect(b.key).toBe(a.key)
    expect(b.cert).toBe(a.cert)
  })
})
