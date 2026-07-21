import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { handleCapture } from './capture.js'
import { loadIndex } from './core/index-store.js'
import type { Agent } from './core/resume-hint.js'

// Chrome Native Messaging 표준 프레이밍: 4바이트 little-endian uint32 길이 프리픽스 +
// 그만큼의 UTF-8 JSON. stdin/stdout 둘 다 이 형식이다.
export function encodeMessage(msg: unknown): Buffer {
  const json = Buffer.from(JSON.stringify(msg), 'utf-8')
  const header = Buffer.alloc(4)
  header.writeUInt32LE(json.length, 0)
  return Buffer.concat([header, json])
}

// 누적 버퍼에서 완성된 메시지를 모두 꺼내고, 아직 덜 온 나머지(rest)는 다음 호출을 위해 돌려준다.
// 호출자가 새 청크를 받을 때마다 `decodeMessages(Buffer.concat([prevRest, chunk]))`로 다시 부르면 된다.
export function decodeMessages(buffer: Buffer): { messages: unknown[]; rest: Buffer } {
  const messages: unknown[] = []
  let offset = 0
  while (buffer.length - offset >= 4) {
    const len = buffer.readUInt32LE(offset)
    if (buffer.length - offset - 4 < len) break // 메시지 본문이 아직 덜 도착함
    const jsonBuf = buffer.subarray(offset + 4, offset + 4 + len)
    messages.push(JSON.parse(jsonBuf.toString('utf-8')))
    offset += 4 + len
  }
  return { messages, rest: buffer.subarray(offset) }
}

function readVersion(): string {
  try {
    const pkgPath = join(dirname(fileURLToPath(import.meta.url)), '..', 'package.json')
    return (JSON.parse(readFileSync(pkgPath, 'utf-8')) as { version: string }).version
  } catch {
    return '0.0.0'
  }
}

// 저장 루트. 우선순위: 환경변수 > 기존 경로 > OS 중립 기본값.
//
// 0.1.x까지의 기본값은 ~/Desktop/Archive/web-chats였는데, Desktop 폴더명이 로케일마다
// 다르고(리눅스 한국어 환경은 ~/바탕화면) Windows는 OneDrive로 리다이렉트되기도 해서
// 새 기본값은 ~/web-chats로 옮겼다. 다만 이전 경로가 이미 있으면 그쪽을 계속 쓴다 —
// 기존 사용자의 데이터가 갑자기 다른 곳으로 갈라지지 않게 하기 위함이다.
export function resolveCwd(): string {
  if (process.env.WCD_CWD) return process.env.WCD_CWD
  const legacy = join(homedir(), 'Desktop', 'Archive', 'web-chats')
  if (existsSync(legacy)) return legacy
  return join(homedir(), 'web-chats')
}

// 확장 프로그램이 보내는 메시지 하나를 처리해서 응답 페이로드를 만든다(프레이밍과 무관한 순수 로직).
export function handleMessage(
  msg: unknown,
  cwd: string,
): {
  ok: boolean; sessionId?: string; resumeHint?: string; error?: string; version?: string
  index?: ReturnType<typeof loadIndex>
} {
  const type = (msg as { type?: unknown } | null)?.type
  if (type === 'ping') return { ok: true, version: readVersion() }
  if (type === 'index') return { ok: true, index: loadIndex(cwd) }
  if (type === 'capture') {
    const payload = (msg as { payload?: unknown }).payload
    // agent 미지정('claude' 외 값) 시 기본 claude — 확장이 아직 agent를 안 보내도 지금까지처럼 동작.
    const rawAgent = (msg as { agent?: unknown }).agent
    const agent: Agent = rawAgent === 'codex' ? 'codex' : 'claude'
    const res = handleCapture(payload, cwd, agent)
    return 'error' in res ? { ok: false, error: res.error } : { ok: true, sessionId: res.sessionId, resumeHint: res.resumeHint }
  }
  return { ok: false, error: `unknown message type: ${String(type)}` }
}

// Chrome이 실행하는 실제 루프. stdout에는 프레이밍된 응답만 쓴다 — 그 외 아무 로그도 섞이면
// 안 된다(프로토콜이 깨짐). 진단 로그는 전부 stderr로.
export function runNativeHost(cwd: string = resolveCwd()): void {
  mkdirSync(cwd, { recursive: true })
  let buffer: Buffer = Buffer.alloc(0)

  process.stdin.on('data', (chunk: Buffer) => {
    buffer = Buffer.concat([buffer, chunk])
    const { messages, rest } = decodeMessages(buffer)
    buffer = rest
    for (const msg of messages) {
      let res: ReturnType<typeof handleMessage>
      try { res = handleMessage(msg, cwd) }
      catch (e) { res = { ok: false, error: (e as Error).message } }
      process.stdout.write(encodeMessage(res))
    }
  })
  process.stdin.on('end', () => process.exit(0))
  process.stdin.resume()
}
