import { detectAdapter } from './adapters/registry.js'
import { writeSession } from './core/session-writer.js'
import { writeCodexSession } from './core/codex-session-writer.js'
import { resolveSessionId, upsertIndex } from './core/index-store.js'
import { buildResumeHint, type Agent } from './core/resume-hint.js'

// 캡처 파이프라인: 감지 → 정규화 → (재캡처면) 기존 세션 재사용 → 세션 파일 기록 → 인덱스 갱신.
// 전송 경로(과거 HTTPS 서버, 지금은 Native Messaging 호스트)는 이 함수를 호출만 한다 — 이 함수 자체는
// 전송 방식을 모른다.
// agent 기본값 'claude': 기존 호출부(agent 인자를 안 넘기는 곳)는 지금까지와 똑같이 동작해야 한다.
export function handleCapture(
  raw: unknown,
  cwd: string,
  agent: Agent = 'claude',
): { sessionId: string; resumeHint: string } | { error: string } {
  const adapter = detectAdapter(raw)
  if (!adapter) return { error: 'unrecognized chat payload (지원: claude/chatgpt/gemini)' }
  let chat
  try { chat = adapter.normalize(raw as any) }
  catch (e) { return { error: `normalize failed: ${(e as Error).message}` } }

  // sessionId 조회는 agent와 무관 — externalId 하나에 uuid 하나를 고정해서 claude/codex
  // 양쪽 파일이 같은 uuid를 공유해도 서로 다른 디렉터리 트리라 충돌하지 않는다(index-store.ts 참고).
  const existing = resolveSessionId(cwd, chat.externalId)
  const write = agent === 'codex' ? writeCodexSession : writeSession
  const res = write(chat, { cwd, sessionId: existing ?? undefined })
  if ('error' in res) return res
  upsertIndex(cwd, chat.externalId, {
    sessionId: res.sessionId, service: chat.service, title: chat.title, capturedAt: Date.now(), agent,
  })
  return { sessionId: res.sessionId, resumeHint: buildResumeHint(agent, res.sessionId) }
}
