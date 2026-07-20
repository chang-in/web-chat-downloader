import { randomUUID } from 'crypto'
import { mkdirSync, writeFileSync } from 'fs'
import { homedir } from 'os'
import { join } from 'path'
import { slug } from './slug.js'
import { readClaudeVersion } from './claude-version.js'
import { storeBlob } from './blobstore.js'
import type { NormalizedChat, NormalizedMessage } from '../adapters/types.js'

// codex-session-writer.ts에서도 그대로 재사용(형식 재현 헬퍼라 에이전트 무관) — 그래서 export.
export const msgId = () => `msg_${randomUUID().replace(/-/g, '')}`
const reqId = () => `req_${randomUUID().replace(/-/g, '')}`

export function isoTs(ms?: number): string {
  const d = ms != null ? new Date(ms) : new Date()
  if (isNaN(d.getTime())) return new Date().toISOString() // 잘못된 ts 방어(RangeError 대신 현재시각)
  return d.toISOString()
}

type ImageBlock = { type: 'image'; source: { type: 'base64'; media_type: string; data: string } }
type TextBlock = { type: 'text'; text: string }

// blobBaseDir: 첨부 원본을 저장할 폴더(= 저장 cwd). 반환: user content(문자열 또는 블록배열)
function buildUserContent(m: NormalizedMessage, blobBaseDir: string): string | (TextBlock | ImageBlock)[] {
  const images = (m.attachments ?? []).filter(a => a.mediaType.startsWith('image/'))
  const files = (m.attachments ?? []).filter(a => !a.mediaType.startsWith('image/'))
  let text = m.text
  for (const f of files) {
    const ext = f.filename.split('.').pop() || 'bin'
    const { relPath } = storeBlob(blobBaseDir, f.data, ext)
    text += `\n[첨부: ${f.filename} → ${relPath}]`
  }
  if (images.length === 0) return text
  const blocks: (TextBlock | ImageBlock)[] = []
  if (text.trim()) blocks.push({ type: 'text', text })
  for (const im of images) {
    // 이미지도 원본 보관(§9): blobstore에 저장(중복 제거), 세션엔 base64 임베드
    const ext = im.filename.split('.').pop() || 'img'
    storeBlob(blobBaseDir, im.data, ext)
    blocks.push({ type: 'image', source: { type: 'base64', media_type: im.mediaType, data: im.data } })
  }
  return blocks
}
function assistantContent(m: NormalizedMessage): { type: 'text'; text: string }[] {
  return [{ type: 'text', text: m.text }]
}

export function writeSession(
  chat: NormalizedChat,
  opts: { cwd: string; sessionId?: string; dirOverride?: string },
): { sessionId: string } | { error: string } {
  const turns = chat.messages.filter(m => m.text.trim().length > 0 || (m.attachments?.length ?? 0) > 0)
  if (turns.length === 0) return { error: 'empty conversation' }

  const sessionId = opts.sessionId ?? randomUUID()
  const cwdSlug = slug(opts.cwd)
  const base = {
    cwd: opts.cwd, sessionId, version: readClaudeVersion(), gitBranch: 'HEAD',
    userType: 'external' as const, entrypoint: 'cli' as const, isSidechain: false, slug: cwdSlug,
  }

  const lines: string[] = []
  let parentUuid: string | null = null
  try {
    for (const m of turns) {
      const uuid = randomUUID()
      const timestamp = isoTs(m.ts)
      if (m.role === 'user') {
        lines.push(JSON.stringify({
          parentUuid, uuid, type: 'user', timestamp,
          message: { role: 'user', content: buildUserContent(m, opts.cwd) },
          promptId: randomUUID(), ...base,
        }))
      } else {
        lines.push(JSON.stringify({
          parentUuid, uuid, type: 'assistant', timestamp,
          message: {
            model: 'claude-opus-4-8', id: msgId(), type: 'message', role: 'assistant',
            content: assistantContent(m), stop_reason: 'end_turn', stop_sequence: null,
            usage: { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
          },
          requestId: reqId(), ...base,
        }))
      }
      parentUuid = uuid
    }
    const dir = opts.dirOverride ?? join(homedir(), '.claude', 'projects', cwdSlug)
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, `${sessionId}.jsonl`), lines.join('\n') + '\n')
  } catch (e) {
    return { error: `write failed: ${(e as Error).message}` }
  }
  return { sessionId }
}
