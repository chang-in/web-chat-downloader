import type { NormalizedChat, NormalizedMessage } from './types'

export const claudeAdapter = {
  service: 'claude' as const,
  detect(raw: any): boolean {
    return !!raw && Array.isArray(raw.chat_messages) && typeof raw.uuid === 'string'
  },
  normalize(raw: any): NormalizedChat {
    const messages: NormalizedMessage[] = raw.chat_messages.map((m: any) => ({
      role: m.sender === 'human' ? 'user' : 'assistant',
      text: (m.text ?? '').trim(),
      ts: m.created_at ? Date.parse(m.created_at) : undefined,
      // 첨부는 후속(파일 스키마 확정 시) — 현재 text 위주
    }))
    return { service: 'claude', externalId: raw.uuid, title: raw.name ?? '', messages }
  },
}
