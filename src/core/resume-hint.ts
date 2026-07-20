// 캡처한 세션을 터미널에서 이어가는 방법 안내 문자열 — 에이전트별로 CLI가 다르다.
// claude: `claude --resume <id>` (실측 완료, 실제 재개까지 검증됨).
// codex : `codex resume <id>` (`codex resume --help` 실측) — SESSION_ID를 위치인자로 직접 주면
//         피커(picker)를 거치지 않으므로 `--include-non-interactive` 같은 피커 전용 플래그는 불필요.
export type Agent = 'claude' | 'codex'

export function buildResumeHint(agent: Agent, sessionId: string): string {
  return agent === 'codex' ? `codex resume ${sessionId}` : `claude --resume ${sessionId}`
}
