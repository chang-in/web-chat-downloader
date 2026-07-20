import { randomUUID } from 'crypto'
import { mkdirSync, writeFileSync } from 'fs'
import { homedir } from 'os'
import { join } from 'path'
import { readCodexVersion } from './codex-version.js'
import { storeBlob } from './blobstore.js'
import { isoTs, msgId } from './session-writer.js'
import type { NormalizedChat, NormalizedMessage } from '../adapters/types.js'

// 실측 근거(로컬 ~/.codex/sessions의 실제 rollout-*.jsonl 4개 + `codex app-server
// generate-json-schema` 로 뽑은 ResponseItem/ContentItem/MessagePhase/SessionSource 스키마):
// - 파일 위치: ~/.codex/sessions/YYYY/MM/DD/rollout-<로컬시각 T구분 대시치환>-<uuid>.jsonl
//   (YYYY/MM/DD와 파일명의 시각은 로컬 타임존 — payload.timestamp 자체는 UTC ISO)
// - 첫 줄은 반드시 {type:'session_meta', payload:{id, cwd, originator, cli_version, source,
//   thread_source, model_provider, timestamp}} — 4개 샘플 전부 100% 공통.
// - 대화 턴은 {type:'response_item', payload:{type:'message', role, content:[...]}} 한 줄씩.
//   content는 스키마상 항상 배열(claude와 달리 문자열 단독 허용 안 됨). role='user'는
//   input_text/input_image, role='assistant'는 output_text. id/phase는 스키마상 optional이지만
//   실제 파일(cli 0.144.1)에서는 assistant 메시지에 100% 존재해서 그대로 채운다.
// - turn_context/world_state/event_msg/developer 메시지는 그 세션의 실제 로컬 환경(샌드박스
//   정책, AGENTS.md 전문, 시스템 프롬프트 등)을 그대로 담고 있어 재현 대상이 아니다(§4 사실확인
//   원칙: 확인 못 하는 값은 지어내지 않는다) — 게다가 cli_version별로 필드가 늘어난 걸 보면
//   (context_window/git/history_mode/session_id는 신버전에만 존재) 구버전 파일도 그대로 읽히는
//   전방/후방호환 설계라, 이 레코드들 자체가 resume에 필수는 아닐 가능성이 높다.
// - originator/source: 실제 로그 4개는 전부 "codex_exec"/"exec"(=headless `codex exec`,
//   `codex resume --help`의 "Include non-interactive sessions..." 문구가 가리키는 그 부류).
//   반면 `codex app-server generate-json-schema`가 뽑은 SessionSource enum엔 "cli"도 있고
//   바이너리 문자열에도 "codex_cli"가 실존한다 — 대화형 세션(=우리가 흉내내려는 대상)의 값으로
//   추정된다. `codex resume <id>`처럼 SESSION_ID를 직접 주면 피커 필터를 안 타므로 큰 영향은
//   없지만, 피커(`--last` 등)에도 자연스럽게 뜨도록 "cli"/"codex_cli"를 택했다 — 실기기에
//   진짜 대화형 세션 샘플이 없어 100% 확정은 아니고, 라이브 검증이 필요한 지점이다.

type ContentItem =
  | { type: 'input_text'; text: string }
  | { type: 'input_image'; image_url: string }
  | { type: 'output_text'; text: string }

// dirOverride: 테스트용 저장 폴더. 실제로는 opts.cwd에 첨부 원본을 보관한다(claude 라이터와 동일).
function buildUserContent(m: NormalizedMessage, blobBaseDir: string): ContentItem[] {
  const images = (m.attachments ?? []).filter(a => a.mediaType.startsWith('image/'))
  const files = (m.attachments ?? []).filter(a => !a.mediaType.startsWith('image/'))
  let text = m.text
  for (const f of files) {
    const ext = f.filename.split('.').pop() || 'bin'
    const { relPath } = storeBlob(blobBaseDir, f.data, ext)
    text += `\n[첨부: ${f.filename} → ${relPath}]`
  }
  const content: ContentItem[] = []
  if (text.trim()) content.push({ type: 'input_text', text })
  for (const im of images) {
    // codex ContentItem엔 base64 블록이 없고 image_url(문자열)만 있다 — data URI로 인라인.
    const ext = im.filename.split('.').pop() || 'img'
    storeBlob(blobBaseDir, im.data, ext) // 원본 보관(중복 제거, claude 라이터와 동일 정책)
    content.push({ type: 'input_image', image_url: `data:${im.mediaType};base64,${im.data}` })
  }
  return content
}

const pad2 = (n: number) => String(n).padStart(2, '0')
// 실측: 폴더/파일명은 로컬 타임존 기준(예: KST 세션이 ~/.codex/sessions/2026/07/20/rollout-2026-07-20T13-35-48-...
// 인데 payload.timestamp는 같은 순간의 UTC "...T04:35:48Z") — new Date().toISOString()을 쓰면 안 된다.
function localParts(d: Date): { y: string; mo: string; day: string; stamp: string } {
  const y = String(d.getFullYear())
  const mo = pad2(d.getMonth() + 1)
  const day = pad2(d.getDate())
  const stamp = `${y}-${mo}-${day}T${pad2(d.getHours())}-${pad2(d.getMinutes())}-${pad2(d.getSeconds())}`
  return { y, mo, day, stamp }
}

export function writeCodexSession(
  chat: NormalizedChat,
  opts: { cwd: string; sessionId?: string; dirOverride?: string },
): { sessionId: string } | { error: string } {
  const turns = chat.messages.filter(m => m.text.trim().length > 0 || (m.attachments?.length ?? 0) > 0)
  if (turns.length === 0) return { error: 'empty conversation' }

  const sessionId = opts.sessionId ?? randomUUID()
  const sessionTs = isoTs(turns[0].ts) // NaN/누락 방어는 isoTs가 함(session-writer.ts와 동일 정책)
  const createdAt = new Date(sessionTs)

  const lines: string[] = []
  try {
    lines.push(JSON.stringify({
      timestamp: sessionTs,
      type: 'session_meta',
      payload: {
        id: sessionId,
        timestamp: sessionTs,
        cwd: opts.cwd,
        originator: 'codex_cli',
        cli_version: readCodexVersion(),
        source: 'cli',
        thread_source: 'user',
        model_provider: 'openai',
      },
    }))

    for (const m of turns) {
      const timestamp = isoTs(m.ts)
      if (m.role === 'user') {
        lines.push(JSON.stringify({
          timestamp, type: 'response_item',
          payload: { type: 'message', role: 'user', content: buildUserContent(m, opts.cwd) },
        }))
      } else {
        lines.push(JSON.stringify({
          timestamp, type: 'response_item',
          payload: {
            type: 'message', id: msgId(), role: 'assistant',
            content: [{ type: 'output_text', text: m.text }],
            phase: 'final_answer', // 우리가 갖고 있는 건 각 턴의 완결된 답변뿐(중간 commentary 구분 불가)
          },
        }))
      }
    }

    const { y, mo, day, stamp } = localParts(createdAt)
    const dir = opts.dirOverride ?? join(homedir(), '.codex', 'sessions', y, mo, day)
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, `rollout-${stamp}-${sessionId}.jsonl`), lines.join('\n') + '\n')
  } catch (e) {
    return { error: `write failed: ${(e as Error).message}` }
  }
  return { sessionId }
}
