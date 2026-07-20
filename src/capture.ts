import { detectAdapter } from './adapters/registry.js'
import { writeSession } from './core/session-writer.js'
import { resolveSessionId, upsertIndex } from './core/index-store.js'

// 캡처 파이프라인: 감지 → 정규화 → (재캡처면) 기존 세션 재사용 → 세션 파일 기록 → 인덱스 갱신.
// 전송 경로(과거 HTTPS 서버, 지금은 Native Messaging 호스트)는 이 함수를 호출만 한다 — 이 함수 자체는
// 전송 방식을 모른다.
export function handleCapture(raw: unknown, cwd: string): { sessionId: string } | { error: string } {
  const adapter = detectAdapter(raw)
  if (!adapter) return { error: 'unrecognized chat payload (지원: claude/chatgpt/gemini)' }
  let chat
  try { chat = adapter.normalize(raw as any) }
  catch (e) { return { error: `normalize failed: ${(e as Error).message}` } }

  const existing = resolveSessionId(cwd, chat.externalId)
  const res = writeSession(chat, { cwd, sessionId: existing ?? undefined })
  if ('error' in res) return res
  upsertIndex(cwd, chat.externalId, { sessionId: res.sessionId, service: chat.service, title: chat.title, capturedAt: Date.now() })
  return res
}
