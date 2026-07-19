import { createHash } from 'crypto'
import { mkdirSync, writeFileSync, existsSync } from 'fs'
import { join } from 'path'

export function storeBlob(baseDir: string, base64: string, ext: string): { hash: string; relPath: string } {
  const buf = Buffer.from(base64, 'base64')
  // base64 왕복 검증(잘못된 입력 거부)
  if (buf.length === 0 || buf.toString('base64').replace(/=+$/,'') !== base64.replace(/=+$/,'')) {
    throw new Error('invalid base64 attachment')
  }
  const hash = createHash('sha256').update(buf).digest('hex').slice(0, 16)
  const relPath = `attachments/${hash}.${ext}`
  const abs = join(baseDir, relPath)
  if (!existsSync(abs)) {
    mkdirSync(join(baseDir, 'attachments'), { recursive: true })
    writeFileSync(abs, buf)
  }
  return { hash, relPath }
}
