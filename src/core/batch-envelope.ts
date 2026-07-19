// parseBatchEnvelope는 Google batchexecute 응답에서 지정 rpcid의 inner JSON을 뽑는다.
// 응답: )]}'\n\n<바이트길이>\n[["wrb.fr",<rpcid>,"<이스케이프 JSON>",...]] (청크 반복).
// 청크 길이가 UTF-8 바이트 기준이라 멀티바이트에서 슬라이스가 어긋나므로,
// 길이에 의존하지 않고 "wrb.fr",<rpcid>, 다음의 문자열 리터럴을 따옴표 매칭으로 추출한다.
// orca(chat-import/lib/normalize.js)의 parseBatchEnvelope를 verbatim 이식.
export function parseBatchEnvelope(rawText: string, rpcid: string): any {
  if (!rawText) return null
  const key = '"' + rpcid + '",'
  let p = rawText.indexOf('"wrb.fr","' + rpcid + '",')
  if (p < 0) p = rawText.indexOf(key)
  if (p < 0) return null
  p += (p === rawText.indexOf(key) ? key.length : ('"wrb.fr",' + key).length)
  while (p < rawText.length && rawText[p] !== '"') p++
  if (p >= rawText.length) return null
  let q = p + 1
  let out = ''
  while (q < rawText.length) {
    const ch = rawText[q]
    if (ch === '\\') { out += rawText[q] + rawText[q + 1]; q += 2; continue }
    if (ch === '"') break
    out += ch; q++
  }
  try { return JSON.parse(JSON.parse('"' + out + '"')) } catch (e) { return null }
}
