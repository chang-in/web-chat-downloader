import type { NormalizedChat, NormalizedMessage } from './types'

// Claude.ai가 클라이언트 미지원 블록에 넣는 플레이스홀더(순수 노이즈)를 제거한다:
// (1) 플레이스홀더만/빈 ```펜스 블록 통째로, (2) 펜스 밖 단독 플레이스홀더 라인,
// (3) 그로 인한 연속 빈 줄 접기. 실제 코드 펜스는 유지.
const CLAUDE_PLACEHOLDER = 'This block is not supported on your current device yet.'

function stripClaudePlaceholder(s: string): string {
  if (!s) return s
  const lines = s.split('\n')
  const out: string[] = []
  const push = (ln: string) => {
    if (ln.trim() === '' && out.length && out[out.length - 1].trim() === '') return
    out.push(ln)
  }
  for (let i = 0; i < lines.length; ) {
    if (lines[i].trim() === '```') {
      let j = i + 1
      while (j < lines.length && lines[j].trim() !== '```') j++
      if (j < lines.length) {
        const inner = lines.slice(i + 1, j).join('\n').trim()
        if (inner === '' || inner === CLAUDE_PLACEHOLDER) {
          i = j + 1
          continue
        }
        for (let k = i; k <= j; k++) out.push(lines[k])
        i = j + 1
        continue
      }
    }
    if (lines[i].trim() === CLAUDE_PLACEHOLDER) {
      i++
      continue
    }
    push(lines[i])
    i++
  }
  return out.join('\n')
}

function claudeText(msg: any): string {
  const raw = msg.text && msg.text.trim()
    ? msg.text.trim()
    : (msg.content || []).filter((c: any) => c.type === 'text').map((c: any) => c.text).join('\n').trim()
  return stripClaudePlaceholder(raw).trim()
}

type ClaudeBlock = { kind: 'thinking' | 'text'; text: string }

// rendering_mode=messages의 content 배열을 [thinking|text] 블록으로 변환한다.
// thinking은 c.thinking, text는 c.text. 그 외(tool_use 등)는 생략.
function claudeBlocks(msg: any): ClaudeBlock[] {
  const blocks: ClaudeBlock[] = []
  for (const c of msg.content || []) {
    if (c.type === 'thinking' && c.thinking && c.thinking.trim()) {
      blocks.push({ kind: 'thinking', text: c.thinking.trim() })
    } else if (c.type === 'text' && typeof c.text === 'string') {
      const t = stripClaudePlaceholder(c.text).trim()
      if (t) blocks.push({ kind: 'text', text: t })
    }
  }
  return blocks
}

export const claudeAdapter = {
  service: 'claude' as const,
  detect(raw: any): boolean {
    return !!raw && Array.isArray(raw.chat_messages) && typeof raw.uuid === 'string'
  },
  normalize(raw: any): NormalizedChat {
    const messages: NormalizedMessage[] = []
    for (const m of raw.chat_messages) {
      const role = m.sender === 'human' ? 'user' : m.sender === 'assistant' ? 'assistant' : null
      if (!role) continue

      const blocks = claudeBlocks(m)
      // text 필드는 검색·미리보기용 — thinking 제외, 답변 텍스트만 합친다.
      const text = blocks.length
        ? blocks.filter(b => b.kind === 'text').map(b => b.text).join('\n\n').trim()
        : claudeText(m)

      const hasAttachments = !!(m.files?.length || m.attachments?.length)
      if (!text && !hasAttachments) continue

      const ts = m.created_at ? Date.parse(m.created_at) : NaN
      messages.push({
        role,
        text,
        ts: Number.isNaN(ts) ? undefined : ts,
      })
    }
    return { service: 'claude', externalId: raw.uuid, title: raw.name ?? '', messages }
  },
}
