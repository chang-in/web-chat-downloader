import { randomUUID } from 'crypto'
import { mkdirSync, writeFileSync } from 'fs'
import { homedir } from 'os'
import { join } from 'path'
import { slug } from './slug'
import { readClaudeVersion } from './claude-version'
import type { NormalizedChat, NormalizedMessage } from '../adapters/types'

const msgId = () => `msg_${randomUUID().replace(/-/g, '')}`
const reqId = () => `req_${randomUUID().replace(/-/g, '')}`

function isoTs(ms?: number): string {
  const d = ms != null ? new Date(ms) : new Date()
  if (isNaN(d.getTime())) return new Date().toISOString() // 잘못된 ts 방어(RangeError 대신 현재시각)
  return d.toISOString()
}

// Task 7에서 attachments 처리로 확장. Task 4에선 text만.
function userContent(m: NormalizedMessage): string {
  return m.text
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
          message: { role: 'user', content: userContent(m) },
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
