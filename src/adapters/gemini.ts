import type { NormalizedChat, NormalizedMessage } from './types.js'
import { parseBatchEnvelope } from '../core/batch-envelope.js'

// getPath는 중첩 배열에서 인덱스 경로를 안전하게 따라간다(중간이 null이면 undefined).
function getPath(node: any, path: number[]): any {
  let cur = node
  for (const k of path) {
    if (cur == null) return undefined
    cur = cur[k]
  }
  return cur
}

export const geminiAdapter = {
  service: 'gemini' as const,
  detect(raw: any): boolean {
    return !!raw && raw.source === 'gemini' && typeof raw.rawText === 'string'
  },
  // hNvQHb 응답에서 사용자/모델 턴을 시간순으로 추출한다.
  // 확정 구조(orca 실측): inner[0]=턴 배열(시간 역순). 턴별:
  //   사용자=turn[2][0][0], 모델=turn[3][0][0][1][0], 타임스탬프=turn[4][0](epoch 초).
  // 각 값은 문자열/숫자일 때만 채택(타입 가드)하여 레이아웃 변경 시 오염 대신 누락으로 실패한다.
  normalize(raw: any): NormalizedChat {
    // 한 응답에는 최근 50교환까지만 담기므로 content.js가 이어받기 토큰으로 여러 페이지를
    // 받아 rawTexts에 순서대로(최신 → 오래된) 넣어준다. 각 페이지의 inner[0]이 이미 시간
    // 역순이니, 페이지 순서대로 이어붙이면 전체가 하나의 시간 역순 배열이 된다.
    // rawTexts가 없는 구버전 payload는 rawText 한 장으로 취급한다.
    const texts: string[] = (Array.isArray(raw.rawTexts) ? raw.rawTexts : [raw.rawText]).filter(
      (t: unknown): t is string => typeof t === 'string',
    )

    const turns: any[] = []
    for (const text of texts) {
      const inner = parseBatchEnvelope(text, 'hNvQHb')
      if (inner && Array.isArray(inner) && Array.isArray(inner[0])) turns.push(...inner[0])
    }

    const messages: NormalizedMessage[] = []
    if (turns.length) {
      // 시간 역순 → 역순회로 시간순 정렬
      for (let i = turns.length - 1; i >= 0; i--) {
        const t = turns[i]
        const tsRaw = getPath(t, [4, 0])
        const ts = typeof tsRaw === 'number' ? tsRaw * 1000 : undefined

        const userText = getPath(t, [2, 0, 0])
        if (typeof userText === 'string' && userText.trim()) {
          messages.push({ role: 'user', text: userText.trim(), ts })
        }

        const modelText = getPath(t, [3, 0, 0, 1, 0])
        if (typeof modelText === 'string' && modelText.trim()) {
          messages.push({ role: 'assistant', text: modelText.trim(), ts })
        }
      }
    }

    return {
      service: 'gemini',
      externalId: raw.externalId,
      title: raw.title ?? '',
      messages,
    }
  },
}
