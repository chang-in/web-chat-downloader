import type { NormalizedChat, NormalizedMessage } from './types'

export const chatgptAdapter = {
  service: 'chatgpt' as const,
  detect(raw: any): boolean {
    return !!raw && !!raw.mapping && typeof raw.conversation_id === 'string'
  },
  normalize(raw: any): NormalizedChat {
    // current_node에서 parent를 따라 루트까지 수집 후 역순(시간순)
    const chain: any[] = []
    let cur = raw.current_node
    while (cur && raw.mapping[cur]) {
      chain.push(raw.mapping[cur])
      cur = raw.mapping[cur].parent
    }
    chain.reverse()

    const messages: NormalizedMessage[] = []
    for (const node of chain) {
      const m = node.message
      if (!m || !m.author) continue
      const role = m.author.role === 'user' ? 'user' : m.author.role === 'assistant' ? 'assistant' : null
      if (!role) continue
      // text + multimodal_text(이미지 포함) 허용. 이미지는 파트 중 객체라 문자열만 골라 텍스트로.
      if (!m.content || (m.content.content_type !== 'text' && m.content.content_type !== 'multimodal_text')) continue
      const parts = (m.content.parts || []).filter((x: any) => typeof x === 'string')
      const text = parts.join('\n').trim()
      if (!text) continue
      messages.push({
        role,
        text,
        ts: typeof m.create_time === 'number' ? m.create_time * 1000 : undefined,
      })
    }

    return {
      service: 'chatgpt',
      externalId: raw.conversation_id,
      title: raw.title ?? '',
      messages,
    }
  },
}
