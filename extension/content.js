// content.js — 대화 페이지 안에서 실행된다(로그인 세션을 그대로 쓸 수 있는 유일한 곳).
//
// 정적 content_scripts 대신 popup이 열릴 때마다 chrome.scripting.executeScript로 주입한다
// (manifest.json 참고 — activeTab+scripting 조합). 그래서 팝업을 같은 탭에서 여러 번 열면
// 이 스크립트가 여러 번 주입될 수 있는데, window 플래그로 두 번째 이후 주입은 즉시 종료해서
// onMessage 리스너가 중복 등록되는 것(=요청 하나에 fetch가 여러 번 나가는 것)을 막는다.
if (!window.__wcdContentInjected) {
  window.__wcdContentInjected = true

  // 서비스 API가 응답을 안 주면 요청이 매달려 팝업까지 멈춘다 — 모든 fetch에 상한을 둔다.
  async function fetchT(url, opts, ms) {
    const ctrl = new AbortController()
    const timer = setTimeout(() => ctrl.abort(), ms || 15000)
    try {
      return await fetch(url, Object.assign({}, opts, { signal: ctrl.signal }))
    } catch (e) {
      if (e && e.name === 'AbortError') throw new Error(`요청 시간 초과: ${url}`)
      throw e
    } finally {
      clearTimeout(timer)
    }
  }

  function sleep(ms) {
    return new Promise((r) => setTimeout(r, ms))
  }

  // 페이지네이션 fetch 전용 타임아웃 — popup.js의 sendToTab 외곽 타임아웃(전체 list 호출 감시)보다
  // 반드시 먼저 터져야, 재시도 한 번을 쓰고도 그 안에서 partial 응답으로 빠져나올 수 있다.
  const LIST_PAGE_TIMEOUT = 20000
  // 429가 아닌 실패(타임아웃/5xx/네트워크)만 이 대기 후 한 번 재시도한다 — 600ms는 서비스가
  // 아직 힘든 상태에서 바로 다시 두드리는 셈이라 2000ms로 늘렸다. 429는 아예 재시도하지
  // 않고(아래 rateLimitReason 참고) 즉시 중단한다.
  const LIST_RETRY_WAIT = 2000

  // 429(또는 rate-limit 문구가 담긴 403)를 감지한다 — 계정이 이미 rate limit에 걸린
  // 상태에서 재시도는 상황을 악화시킬 뿐이라, 이건 "다시 시도"가 아니라 "멈추라"는
  // 신호로 취급한다. Retry-After가 숫자(초)면 반환값에 붙여서 호출부가 안내 문구에 쓸 수
  // 있게 한다.
  async function rateLimitReason(res) {
    let hit = res.status === 429
    if (!hit && res.status === 403) {
      let text = ''
      try { text = await res.text() } catch (e) { /* 무시하고 일반 실패로 처리 */ }
      hit = /rate.?limit|too many requests/i.test(text)
    }
    if (!hit) return null
    const ra = res.headers.get('retry-after')
    return ra && /^\d+$/.test(ra) ? `rate-limited:${ra}` : 'rate-limited'
  }

  function detectService() {
    const h = location.hostname
    if (h === 'claude.ai') {
      const m = location.pathname.match(/^\/chat\/([^/?#]+)/)
      return { service: 'claude', id: m ? m[1] : null }
    }
    if (h === 'chatgpt.com' || h === 'chat.openai.com') {
      const m = location.pathname.match(/^\/c\/([^/?#]+)/)
      return { service: 'chatgpt', id: m ? m[1] : null }
    }
    if (h === 'gemini.google.com') {
      const m = location.pathname.match(/^\/app\/([^/?#]+)/)
      return { service: 'gemini', id: m ? m[1] : null }
    }
    return { service: null, id: null }
  }

  // ───────────────────── claude.ai ─────────────────────

  function getCookie(name) {
    const m = document.cookie.match(new RegExp('(?:^|; )' + name + '=([^;]*)'))
    return m ? decodeURIComponent(m[1]) : null
  }

  function claudeOrgId() {
    const org = getCookie('lastActiveOrg')
    if (!org) throw new Error('lastActiveOrg 쿠키를 찾을 수 없어요(로그인 상태를 확인하세요)')
    return org
  }

  async function claudeList() {
    // claude는 단건 요청이라 페이지가 없다 — 실패하면 그냥 던진다(에러 메시지가 이미 명확하다).
    // partial은 항상 false로, 다른 서비스와 반환 모양만 맞춘다.
    const org = claudeOrgId()
    const res = await fetch(`/api/organizations/${org}/chat_conversations`, { credentials: 'include' })
    if (!res.ok) throw new Error(`claude 목록 조회 실패: ${res.status}`)
    const data = await res.json()
    const items = (Array.isArray(data) ? data : []).map((c) => ({ externalId: c.uuid, title: c.name || '' }))
    return { items, partial: false }
  }

  async function claudePayload(id) {
    const org = claudeOrgId()
    const convId = id || detectService().id
    if (!convId) throw new Error('현재 열린 대화를 찾을 수 없어요')
    const res = await fetch(
      `/api/organizations/${org}/chat_conversations/${convId}?tree=True&rendering_mode=raw`,
      { credentials: 'include' },
    )
    const rl = await rateLimitReason(res)
    if (rl) { const err = new Error(rl); err.rateLimited = true; throw err }
    if (!res.ok) throw new Error(`claude 대화 조회 실패: ${res.status}`)
    return res.json() // 서버(core/adapters/claude.ts)가 원본 그대로 감지·정규화한다
  }

  // ───────────────────── ChatGPT ─────────────────────

  async function chatgptToken() {
    const res = await fetchT('/api/auth/session', { credentials: 'include' })
    if (!res.ok) throw new Error(`chatgpt 세션 조회 실패: ${res.status}`)
    const data = await res.json()
    if (!data || !data.accessToken) throw new Error('accessToken을 찾을 수 없어요(로그인 상태를 확인하세요)')
    return data.accessToken
  }

  async function chatgptList() {
    const token = await chatgptToken()
    const items = []
    const seen = new Set() // externalId 기준 dedupe — 페이지네이션 도중 대화가 앞뒤로 밀리면 겹칠 수 있다
    const PAGE_SIZE = 28
    // SAFETY_PAGES는 사용량 상한이 아니라 무한 루프 방지용이다. 정상 종료는 서버가 짧은
    // 페이지를 돌려주는 것뿐이고, 여기까지 왔다면 그건 비정상이므로 조용히 끝내지 않고
    // partial로 보고한다 — "데이터가 끝나서 멈춤"과 "내 한계에 걸려서 멈춤"은 다른 사건이다.
    const SAFETY_PAGES = 500 // 28 × 500 = 14,000개
    const PAGE_DELAY = 500 // 페이지 사이 간격 — 요청을 몰아치지 않게 해서 계정 rate limit을 피한다
    let reachedEnd = false
    for (let page = 0; page < SAFETY_PAGES; page++) {
      const offset = page * PAGE_SIZE
      const url = `/backend-api/conversations?offset=${offset}&limit=${PAGE_SIZE}&order=updated`

      // 대화 200개+ 계정에서 뒤쪽 페이지가 타임아웃/5xx로 실패하는 걸 실측했다 — 한 번만
      // 재시도하고, 그래도 안 되면 지금까지 모은 페이지는 버리지 않고 partial로 돌려준다.
      // 단, 429는 재시도 대상이 아니다 — 즉시 멈추고 지금까지 모은 걸 partial로 돌려준다.
      let data = null
      let ok = false
      for (let attempt = 0; attempt < 2; attempt++) {
        try {
          const res = await fetchT(
            url,
            { credentials: 'include', headers: { Authorization: `Bearer ${token}` } },
            LIST_PAGE_TIMEOUT,
          )
          const rl = await rateLimitReason(res)
          if (rl) return { items, partial: true, reason: rl }
          if (!res.ok) throw new Error(`chatgpt 목록 조회 실패: ${res.status}`)
          data = await res.json()
          ok = true
          break
        } catch (e) {
          if (attempt === 0) await sleep(LIST_RETRY_WAIT)
        }
      }
      if (!ok) return { items, partial: true, reason: `페이지 ${page + 1} 조회 실패` }

      const pageItems = (data && data.items) || []
      for (const it of pageItems) {
        if (seen.has(it.id)) continue
        seen.add(it.id)
        items.push({ externalId: it.id, title: it.title || '' })
      }
      if (pageItems.length < PAGE_SIZE) { reachedEnd = true; break }
      await sleep(PAGE_DELAY)
    }
    if (!reachedEnd) {
      return { items, partial: true, reason: `안전 상한(${SAFETY_PAGES}페이지) 도달 — 대화가 더 남아 있을 수 있어요` }
    }
    return { items, partial: false }
  }

  async function chatgptPayload(id) {
    const token = await chatgptToken()
    const convId = id || detectService().id
    if (!convId) throw new Error('현재 열린 대화를 찾을 수 없어요')
    const res = await fetch(`/backend-api/conversation/${convId}`, {
      credentials: 'include',
      headers: { Authorization: `Bearer ${token}` },
    })
    const rl = await rateLimitReason(res)
    if (rl) { const err = new Error(rl); err.rateLimited = true; throw err }
    if (!res.ok) throw new Error(`chatgpt 대화 조회 실패: ${res.status}`)
    return res.json() // 서버(core/adapters/chatgpt.ts)가 원본 그대로 감지·정규화한다
  }

  // ───────────────────── Gemini ─────────────────────
  //
  // 대화 id는 list·payload·인덱스(중복 체크)에서 전부 같은 형태로 다뤄야 "이미 저장됨" 표시가
  // 어긋나지 않는다. hNvQHb 호출에는 반드시 'c_' 접두사가 붙어야 응답이 제대로 오는 걸 실측
  // 확인했다고 해서(스펙 참고) — list가 돌려주는 id에도 미리 같은 접두사를 붙여 두면
  // list/payload/인덱스가 항상 동일한 문자열을 externalId로 쓰게 된다.
  function normalizeCid(id) {
    const s = String(id)
    return s.startsWith('c_') ? s : `c_${s}`
  }

  function geminiTokens() {
    const html = document.documentElement.outerHTML
    const at = html.match(/"SNlM0e":"([^"]+)"/)
    const bl = html.match(/"cfb2h":"([^"]+)"/)
    const fsid = html.match(/"FdrFJe":"([^"]+)"/)
    if (!at || !bl || !fsid) throw new Error('Gemini 페이지 토큰을 찾을 수 없어요(새로고침 후 다시 시도하세요)')
    return { at: at[1], bl: bl[1], fsid: fsid[1] }
  }

  // ms를 주면(목록 페이지네이션 등) fetchT로 타임아웃을 걸고, 안 주면(payload 등 기존 호출부)
  // 원래대로 무제한 fetch — 이 함수 하나로 쓰는 다른 호출부의 동작을 바꾸지 않기 위해서다.
  async function geminiRpc(rpcid, inner, ms) {
    const { at, bl, fsid } = geminiTokens()
    const reqid = Math.floor(100000 + Math.random() * 900000)
    const url =
      `/_/BardChatUi/data/batchexecute?rpcids=${rpcid}&source-path=%2Fapp` +
      `&bl=${encodeURIComponent(bl)}&f.sid=${encodeURIComponent(fsid)}&hl=ko&_reqid=${reqid}&rt=c`
    const body = new URLSearchParams()
    body.set('f.req', JSON.stringify([[[rpcid, inner, null, 'generic']]]))
    body.set('at', at)
    const opts = {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8' },
      body,
    }
    const res = ms ? await fetchT(url, opts, ms) : await fetch(url, opts)
    const rl = await rateLimitReason(res)
    if (rl) { const err = new Error(rl); err.rateLimited = true; throw err }
    if (!res.ok) throw new Error(`gemini rpc(${rpcid}) 실패: ${res.status}`)
    return res.text()
  }

  // batchexecute 응답에서 지정 rpcid의 inner JSON을 뽑는다. 스펙에서 실측 검증한 그대로:
  // )]}' 접두 이후 "[[로 시작하는 첫 줄을 JSON.parse → [rpcid, inner-json-string, ...] 항목을
  // 찾아 그 inner를 다시 JSON.parse.
  function parseGeminiEnvelope(text, rpcid) {
    for (const line of text.split('\n')) {
      if (!line.startsWith('[[')) continue
      let arr
      try { arr = JSON.parse(line) } catch (e) { continue }
      for (const entry of arr) {
        if (Array.isArray(entry) && entry[1] === rpcid) {
          try { return JSON.parse(entry[2]) } catch (e) { return null }
        }
      }
    }
    return null
  }

  // list에서 받은 제목을 캐싱해 둔다 — payload(id 지정 동기화) 시점엔 hNvQHb 응답에 대화
  // 제목이 없어서, 방금 목록에서 본 제목을 여기서 가져와 채운다(스펙의 "page/list title").
  const geminiTitleCache = new Map()

  async function geminiList() {
    const rows = []
    const seen = new Set() // externalId 기준 dedupe — 페이지네이션 도중 대화가 앞뒤로 밀리면 겹칠 수 있다
    let nextToken = null
    // chatgptList와 같은 성격의 안전장치다(사용량 상한이 아님). 정상 종료는 nextToken이
    // 없어지는 것뿐이고, 여기 걸리면 partial로 보고한다.
    const SAFETY_PAGES = 500
    let reachedEnd = false
    for (let page = 0; page < SAFETY_PAGES; page++) {
      const inner = page === 0 ? '[]' : JSON.stringify([null, nextToken])

      // chatgpt와 같은 노출: 뒤쪽 페이지가 실패하면 한 번 재시도하고, 그래도 안 되면
      // 지금까지 모은 페이지는 버리지 않고 partial로 돌려준다. 429는 재시도하지 않고
      // 즉시 멈춘다(geminiRpc가 rateLimited 플래그를 붙여 던진다).
      let text = null
      let ok = false
      for (let attempt = 0; attempt < 2; attempt++) {
        try {
          text = await geminiRpc('MaZiqc', inner, LIST_PAGE_TIMEOUT)
          ok = true
          break
        } catch (e) {
          if (e && e.rateLimited) return { items: rows, partial: true, reason: e.message }
          if (attempt === 0) await sleep(LIST_RETRY_WAIT)
        }
      }
      if (!ok) return { items: rows, partial: true, reason: `페이지 ${page + 1} 조회 실패` }

      const parsed = parseGeminiEnvelope(text, 'MaZiqc')
      const pageRows = parsed && Array.isArray(parsed[2]) ? parsed[2] : []
      for (const r of pageRows) {
        const id = normalizeCid(r[0])
        const title = r[1] || ''
        geminiTitleCache.set(id, title)
        if (seen.has(id)) continue
        seen.add(id)
        rows.push({ externalId: id, title })
      }
      const prevToken = nextToken
      nextToken = parsed && typeof parsed[1] === 'string' && parsed[1] ? parsed[1] : null
      if (!nextToken) { reachedEnd = true; break }
      // 토큰이 그대로면 같은 페이지를 무한히 다시 받게 된다 — 서버 이상으로 보고 멈춘다.
      if (nextToken === prevToken) {
        return { items: rows, partial: true, reason: '페이지 토큰이 더 진행되지 않아요' }
      }
      await sleep(400) // 페이지 사이 간격 — 계정 rate limit을 피한다
    }
    if (!reachedEnd) {
      return { items: rows, partial: true, reason: `안전 상한(${SAFETY_PAGES}페이지) 도달 — 대화가 더 남아 있을 수 있어요` }
    }
    return { items: rows, partial: false }
  }

  function geminiPageTitle() {
    return (document.title || '').replace(/\s*[-–]\s*Gemini\s*$/, '').trim() || 'Untitled'
  }

  async function geminiPayload(id) {
    const rawId = id || detectService().id
    if (!rawId) throw new Error('현재 열린 대화를 찾을 수 없어요')
    const cid = normalizeCid(rawId)

    // hNvQHb 응답 한 번에는 최근 50교환까지만 담긴다. 응답의 [1]에 이어받기 토큰이 있으면
    // 그걸로 더 오래된 턴을 계속 받아온다(실측: inner=[cid, null, token], 토큰이 사라지면 끝).
    // 이걸 안 하면 50교환이 넘는 대화는 앞부분이 조용히 잘린 채로 저장된다.
    const SAFETY_PAGES = 200 // 50교환 × 200 = 10,000교환
    const rawTexts = []
    let token = null
    for (let page = 0; page < SAFETY_PAGES; page++) {
      const inner = page === 0 ? JSON.stringify([cid]) : JSON.stringify([cid, null, token])
      rawTexts.push(await geminiRpc('hNvQHb', inner))
      const parsed = parseGeminiEnvelope(rawTexts[rawTexts.length - 1], 'hNvQHb')
      const prev = token
      token = parsed && typeof parsed[1] === 'string' && parsed[1] ? parsed[1] : null
      if (!token || token === prev) break // 토큰이 없거나 그대로면 더 받을 게 없다
      await sleep(400)
    }

    const title = geminiTitleCache.get(cid) || geminiPageTitle()
    // rawText는 detect()·구버전 호환용으로 첫 페이지를 그대로 둔다.
    return { source: 'gemini', externalId: cid, title, rawText: rawTexts[0], rawTexts } // core/adapters/gemini.ts가 감지·파싱
  }

  // ───────────────────── 디스패치 ─────────────────────

  async function handleCommand(req) {
    const { service } = detectService()
    if (req.cmd === 'detect') return detectService()
    if (req.cmd === 'list') {
      if (service === 'claude') return claudeList()
      if (service === 'chatgpt') return chatgptList()
      if (service === 'gemini') return geminiList()
      return { items: [], partial: false }
    }
    if (req.cmd === 'payload') {
      if (service === 'claude') return claudePayload(req.id)
      if (service === 'chatgpt') return chatgptPayload(req.id)
      if (service === 'gemini') return geminiPayload(req.id)
      return null
    }
    return null
  }

  chrome.runtime.onMessage.addListener((req, _sender, sendResponse) => {
    if (!req || !req.cmd) return false
    handleCommand(req)
      .then(sendResponse)
      // __rateLimited: background.js가 대량 동기화 중 이 에러를 받으면 남은 항목을 계속
      // 시도하지 않고 전체 실행을 중단해야 하므로, 에러 메시지뿐 아니라 이 플래그도 함께
      // 전달한다(에러가 메시지 채널을 넘어가며 평범한 객체로 직렬화돼 원래 속성을 잃는다).
      .catch((e) => sendResponse({ __error: e && e.message ? e.message : String(e), __rateLimited: !!(e && e.rateLimited) }))
    return true // 비동기 응답이므로 채널을 열어둔다
  })
}
