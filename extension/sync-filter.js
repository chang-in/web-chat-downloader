// sync-filter.js — "이 대화를 다시 받아야 하는가" 판단의 단일 출처.
// popup(전체 동기화 버튼)과 background(자동 동기화)가 같은 기준으로 판단해야 한다.
// 두 곳에 따로 적으면 한쪽만 고쳤을 때 조용히 어긋난다.

// item: { externalId, title, updatedAt } — updatedAt은 주는 서비스만(claude·chatgpt) 실린다.
// saved: 인덱스 항목 { sessionId, service, title, capturedAt } 또는 undefined.
//
// 판단 기준은 "이미 받았나"가 아니라 "웹이 내가 받아둔 것보다 최신인가"다. 전자로 하면
// 웹에서 이어서 대화한 내용이 영영 갱신되지 않는다.
// 수정 시각을 모르는 서비스는 항상 받는다 — 모를 때 안 받으면 조용히 데이터를 잃지만,
// 받으면 느려질 뿐이다.
function wcdNeedsCapture(item, saved) {
  if (!saved) return true
  if (!item || !item.updatedAt) return true
  const t = Date.parse(item.updatedAt)
  return !Number.isFinite(t) || t > saved.capturedAt
}
