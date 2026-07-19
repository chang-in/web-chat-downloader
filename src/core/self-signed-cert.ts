import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomBytes } from 'node:crypto'

// 브라우저(https://claude.ai 등)에서 https://127.0.0.1:PORT 로 mixed-content 없이
// POST하려면 로컬 서버가 TLS를 들어야 한다. 자체서명 인증서를 한 번 만들어
// 재사용한다 — 매번 새로 만들면 브라우저가 신뢰를 매번 다시 물어봐야 한다.
export function ensureCert(dir: string): { key: string; cert: string } {
  mkdirSync(dir, { recursive: true })
  const keyPath = join(dir, 'key.pem')
  const certPath = join(dir, 'cert.pem')

  if (existsSync(keyPath) && existsSync(certPath)) {
    return { key: readFileSync(keyPath, 'utf-8'), cert: readFileSync(certPath, 'utf-8') }
  }

  const baseArgs = [
    'req', '-x509', '-newkey', 'rsa:2048', '-nodes',
    '-keyout', keyPath, '-out', certPath,
    '-days', '3650', // ~10년
    '-subj', '/CN=127.0.0.1',
  ]
  // 최신 브라우저는 CN만으론 인증서를 신뢰하지 않고 SAN(subjectAltName)을
  // 요구한다. 127.0.0.1로 접속하니 IP:127.0.0.1과 DNS:localhost 둘 다 넣는다.
  const san = 'subjectAltName=IP:127.0.0.1,DNS:localhost'

  try {
    execFileSync('openssl', [...baseArgs, '-addext', san], { stdio: 'pipe' })
  } catch {
    // macOS 기본 LibreSSL(/usr/bin/openssl)은 버전에 따라 한 방 -addext를
    // 지원하지 않는다. 임시 openssl config에 [v3_req]/subjectAltName을 써서
    // -extensions v3_req 로 우회한다.
    const configPath = join(tmpdir(), `wcd-openssl-${randomBytes(6).toString('hex')}.cnf`)
    const config = [
      '[req]',
      'distinguished_name = req_distinguished_name',
      'x509_extensions = v3_req',
      'prompt = no',
      '',
      '[req_distinguished_name]',
      'CN = 127.0.0.1',
      '',
      '[v3_req]',
      san,
      '',
    ].join('\n')
    writeFileSync(configPath, config)
    try {
      execFileSync('openssl', [...baseArgs, '-config', configPath, '-extensions', 'v3_req'], { stdio: 'pipe' })
    } finally {
      rmSync(configPath, { force: true })
    }
  }

  return { key: readFileSync(keyPath, 'utf-8'), cert: readFileSync(certPath, 'utf-8') }
}
