import { readFileSync, writeFileSync, existsSync } from 'fs'
import { join } from 'path'
import type { Agent } from './resume-hint.js'

// agent는 optional — 코덱스 지원 이전에 쓰인 기존 인덱스 파일엔 이 필드가 없다(하위호환).
// 참고용 메타(마지막으로 어느 에이전트로 캡처했는지)일 뿐, sessionId 조회엔 관여하지 않는다 —
// externalId 하나 = sessionId(uuid) 하나로 고정해두면, 그 uuid를 claude/codex 양쪽 라이터가
// 각자의 디렉터리 트리(~/.claude/projects/… vs ~/.codex/sessions/…)에 그대로 재사용해도
// 충돌이 없다. 에이전트별로 sessionId를 분기했더니 재캡처 순서에 따라 서로의 항목을 덮어써
// 잃어버리는 문제가 있었다(예: claude→codex→claude로 캡처하면 마지막에 codex 항목만 남음).
type Entry = { sessionId: string; service: string; title: string; capturedAt: number; agent?: Agent }
type Index = Record<string, Entry>
const file = (cwd: string) => join(cwd, '.wcd-index.json')

export function loadIndex(cwd: string): Index {
  const f = file(cwd)
  if (!existsSync(f)) return {}
  try { return JSON.parse(readFileSync(f, 'utf-8')) as Index }
  catch { console.warn(`[wcd] 인덱스 손상, 빈 인덱스로 진행: ${f}`); return {} }
}
export function resolveSessionId(cwd: string, externalId: string): string | null {
  return loadIndex(cwd)[externalId]?.sessionId ?? null
}
export function upsertIndex(cwd: string, externalId: string, entry: Entry): void {
  const idx = loadIndex(cwd)
  idx[externalId] = entry
  writeFileSync(file(cwd), JSON.stringify(idx, null, 2))
}
