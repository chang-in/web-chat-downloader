// background.js — MV3 서비스 워커. 두 가지 역할을 겸한다.
//
// 1) ping·index·단건 capture 중계 — popup/content가 { to: 'host', msg } 형태로 보내면
//    호스트 응답을 그대로 sendResponse한다(예전부터 있던 계약, 그대로 유지).
// 2) 대량 동기화(bulk sync) 루프를 여기서 직접 돈다. MV3에서 팝업 JS는 팝업이 닫히는
//    순간 죽는다 — 128개 대화를 350ms 간격으로 순회하는 45초+짜리 작업을 팝업에 두면
//    팝업을 닫거나 다른 곳을 클릭하는 순간 작업이 끊긴다. 그래서 루프 자체를 서비스
//    워커로 옮기고, 팝업은 시작(sync-start)·취소(sync-cancel)·조회(sync-state)만 한다.
//
// 대량 동기화 메시지 계약:
//   { cmd: 'sync-start', ids, service, tabId } → 실행 중이 아니면 새로 시작, 실행 중이면
//                                                 그 실행의 현재 상태를 그대로 반환(가드)
//   { cmd: 'sync-cancel' }                     → 실행 중인 동기화에 취소 플래그를 세운다
//   { cmd: 'sync-state' }                      → 현재 상태 조회(팝업을 다시 열었을 때
//                                                 진행률을 즉시 복원하기 위함)
// 진행 중에는 { cmd: 'sync-update', state }를 chrome.runtime.sendMessage로 계속 밀어준다.
// 팝업이 닫혀 있으면 리시버가 없어서 lastError가 나는데, 정상 상황이라 무시한다.
const HOST_NAME = 'com.web_chat_downloader.host'
const BADGE_ACCENT = '#C4633F' // 브랜드 accent — 진행률 표시
const BADGE_FAIL = '#D14343' // 실패/에러 표시
const SYNC_DELAY_MS = 350 // 항목 사이 요청 간격(서비스 API에 대한 예의) — 기존 popup.js 값 그대로 이전
const SVC_FRIENDLY = { chatgpt: 'ChatGPT', gemini: 'Gemini', claude: 'Claude' } // rate-limit 안내 문구용
const DONE_BADGE_MS = 3000
const FAIL_BADGE_MS = 5000
const HOST_TIMEOUT_MS = 15000 // 응답도 disconnect도 안 오는(포트가 먹통이 된) 경우의 안전망 —
// 없으면 popup 쪽 sendMessage가 영영 pending 상태로 남는다.

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms))
}

// ───────────────────── ping / index / 단건 capture 중계 ─────────────────────
//
// 포트는 요청마다 새로 연다(lazy reconnect-per-request) — 이 세 가지는 팝업 세션당 몇 번
// 수준의 빈도라 매번 connectNative하는 비용이 무시할 만하고, 응답이 오면 바로 끊어서
// 재연결 타이밍을 신경 쓸 필요가 없다. (대량 동기화는 이 방식을 쓰지 않는다 — 아래
// runSyncLoop 쪽 주석 참고: 그쪽은 포트를 실행 내내 열어 둔다.)
function callHost(msg) {
  return new Promise((resolve) => {
    let port
    try {
      port = chrome.runtime.connectNative(HOST_NAME)
    } catch (e) {
      resolve({ ok: false, error: 'host-unavailable' })
      return
    }

    let settled = false
    let timer
    const finish = (res) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve(res)
      try { port.disconnect() } catch (e) { /* 이미 끊겼으면 무시 */ }
    }
    timer = setTimeout(() => finish({ ok: false, error: 'host-timeout' }), HOST_TIMEOUT_MS)

    port.onMessage.addListener((res) => finish(res))
    // 호스트 매니페스트 미설치, 실행 파일 없음 등으로 애초에 연결이 안 되면 메시지 없이
    // 바로 disconnect만 온다 — 이 경우를 host-unavailable로 취급한다.
    port.onDisconnect.addListener(() => {
      if (chrome.runtime.lastError) {
        console.warn('[wcd] native host disconnect:', chrome.runtime.lastError.message)
      }
      finish({ ok: false, error: 'host-unavailable' })
    })

    try {
      port.postMessage(msg)
    } catch (e) {
      finish({ ok: false, error: 'host-unavailable' })
    }
  })
}

// ───────────────────── 뱃지 ─────────────────────

function setBadge(text, color) {
  chrome.action.setBadgeBackgroundColor({ color })
  chrome.action.setBadgeText({ text })
}

function clearBadge() {
  chrome.action.setBadgeText({ text: '' })
}

// ───────────────────── 대량 동기화 상태 ─────────────────────

function idleRun() {
  return { running: false, service: null, total: 0, done: 0, failed: 0, cancelled: false, lastError: null }
}

let run = idleRun()
let runTabId = null // 이 실행을 시작한 탭 — content script 호출은 항상 이 탭으로만 간다
let runGen = 0 // 실행 세대 번호. 아래 runSyncLoop 마지막 뱃지 정리 부분 주석 참고

function publicState() {
  return { ...run }
}

function pushUpdate() {
  chrome.runtime.sendMessage({ cmd: 'sync-update', state: publicState() }, () => {
    void chrome.runtime.lastError // 팝업이 닫혀 있으면 리시버가 없다는 에러가 나는데 정상이라 무시
  })
}

async function fetchPayload(id) {
  const res = await chrome.tabs.sendMessage(runTabId, { cmd: 'payload', id })
  if (res && typeof res === 'object' && '__error' in res) {
    const err = new Error(res.__error)
    if (res.__rateLimited) err.rateLimited = true
    throw err
  }
  return res
}

// rate-limit reason("rate-limited" 또는 "rate-limited:60")을 popup.js와 같은 문구로 바꾼다 —
// 목록 조회가 partial로 멈췄을 때(popup.js)와 대량 동기화가 중단됐을 때(여기) 사용자가 보는
// 안내가 서로 다르게 읽히면 같은 원인인데 다른 문제처럼 보인다.
function rateLimitMessage(reason, service) {
  const m = /^rate-limited:(\d+)$/.exec(reason || '')
  const wait = m ? `${m[1]}초 뒤` : '1~2분 뒤'
  const label = SVC_FRIENDLY[service] || '서비스'
  return `${label}가 요청이 많다고 해서 멈췄어요 — ${wait} 다시 열어주세요`
}

// 대량 동기화 루프 — 예전 popup.js의 syncItems()가 하던 일을 그대로 서비스 워커로 옮긴
// 것이다. popup은 이 루프를 시작만 시키고 sync-update push로 진행 상황을 구독한다.
//
// 페이지 데이터(fetch)는 여전히 content script(페이지 컨텍스트)에서만 가능하다 — 로그인
// 세션 쿠키를 그대로 쓸 수 있는 곳이 거기뿐이라, 여기 background에서 claude.ai 등을 직접
// fetch할 수 없다. 그래서 이 루프는 "가져오기"는 탭에 위임(chrome.tabs.sendMessage)하고,
// "저장"만 네이티브 호스트로 보내는 오케스트레이터 역할을 한다.
//
// 바깥쪽 얇은 래퍼: 안쪽(runSyncLoopInner)에서 예상 못 한 예외가 새어 나오면(잡지 못한
// chrome.* API 에러 등) run.running이 true로 영영 멈춰버려서, 이후 모든 sync-start가
// "이미 실행 중"으로 가드되며 영구히 막힌다 — 확장을 리로드하기 전엔 복구가 안 된다.
// 이걸 막으려고 여기서 한 번 더 감싸 안전망으로 run 상태를 반드시 idle로 되돌린다.
async function runSyncLoop(ids, myGen) {
  try {
    await runSyncLoopInner(ids, myGen)
  } catch (e) {
    run.running = false
    run.lastError = (e && e.message) || '동기화 중 알 수 없는 오류가 발생했어요'
    pushUpdate()
    setBadge('!', BADGE_FAIL)
    await sleep(FAIL_BADGE_MS)
    if (myGen === runGen) clearBadge()
  }
}

async function runSyncLoopInner(ids, myGen) {
  pushUpdate()
  setBadge('0', BADGE_ACCENT)

  // Native Messaging 포트를 실행 내내 열어 둔다(연결된 포트가 있는 동안은 서비스 워커가
  // 유휴 종료되지 않는다) — 이게 45초+짜리 루프 동안 워커를 살려 두는 keep-alive다.
  // 완료 뱃지(✓/!)를 잠깐 보여주는 동안에도 setTimeout이 실제로 발화하려면 워커가 계속
  // 떠 있어야 하므로, 뱃지를 다 지운 뒤(완전히 유휴가 된 뒤)에야 disconnect한다.
  let port
  const settleBadge = async () => {
    if (run.cancelled) {
      // 취소는 handleSyncCancel에서 이미 즉시 지웠다 — 여기서는 그냥 넘어간다.
    } else if (run.lastError || run.failed > 0) {
      setBadge('!', BADGE_FAIL)
      await sleep(FAIL_BADGE_MS)
      // myGen === runGen 가드: 이 뱃지를 지우려는 사이에 사용자가 새 동기화를 이미
      // 시작했을 수 있다(이전 실행 완료 후 running=false가 된 순간부터 이 sleep이 끝날
      // 때까지의 짧은 틈). 그 경우 새 실행이 자기 진행률 뱃지를 이미 그리고 있을 테니,
      // 여기서 clearBadge하면 그걸 지워버리게 된다 — 세대가 바뀌었으면 지우지 않는다.
      if (myGen === runGen) clearBadge()
    } else {
      setBadge('✓', BADGE_ACCENT)
      await sleep(DONE_BADGE_MS)
      if (myGen === runGen) clearBadge()
    }
    if (port) { try { port.disconnect() } catch (e) { /* 이미 끊겼으면 무시 */ } }
  }

  try {
    port = chrome.runtime.connectNative(HOST_NAME)
  } catch (e) {
    run.running = false
    run.lastError = '네이티브 호스트에 연결할 수 없어요'
    pushUpdate()
    await settleBadge()
    return
  }

  let pendingResolve = null
  let portDown = false
  port.onMessage.addListener((res) => {
    if (pendingResolve) { const r = pendingResolve; pendingResolve = null; r(res) }
  })
  port.onDisconnect.addListener(() => {
    portDown = true
    if (pendingResolve) { const r = pendingResolve; pendingResolve = null; r({ ok: false, error: 'host-unavailable' }) }
  })
  function captureOverPort(payload) {
    if (portDown) return Promise.resolve({ ok: false, error: 'host-unavailable' })
    return new Promise((resolve) => {
      pendingResolve = resolve
      try {
        port.postMessage({ type: 'capture', payload })
      } catch (e) {
        pendingResolve = null
        resolve({ ok: false, error: 'host-unavailable' })
      }
    })
  }

  // 콘텐츠 스크립트가 그 탭에 떠 있는지 실행 시작 시점에 한 번 보장한다(팝업이 열릴 때도
  // 주입하지만, 이 사이 탭이 새로고침됐을 수 있다). content.js는 window 플래그로 중복
  // 주입을 막으므로 이미 있어도 안전하다. 탭이 이미 없거나 지원 밖 페이지면 여기서
  // 던지는데, 시작도 못 해본 것이므로 탭이 닫힌 것과 같은 취급(치명적 중단)을 한다.
  try {
    await chrome.scripting.executeScript({ target: { tabId: runTabId }, files: ['content.js'] })
  } catch (e) {
    run.running = false
    run.lastError = '동기화 중 탭이 닫혀서 중단했어요'
    pushUpdate()
    await settleBadge()
    return
  }

  for (let i = 0; i < ids.length; i++) {
    if (run.cancelled) break

    try {
      await chrome.tabs.get(runTabId) // 탭이 닫혔으면 여기서 던진다 → 아래서 치명적 중단 처리
    } catch (e) {
      run.lastError = '동기화 중 탭이 닫혀서 중단했어요'
      break
    }

    try {
      const payload = await fetchPayload(ids[i])
      const res = await captureOverPort(payload)
      if (!res || !res.ok) throw new Error((res && res.error) || '캡처 실패')
    } catch (e) {
      // 429는 항목 하나의 실패로 취급하지 않는다 — 계정이 이미 rate limit에 걸렸다는
      // 뜻이라, 남은 항목을 계속 두드리면 상황만 악화된다. 즉시 전체 실행을 중단한다.
      if (e && e.rateLimited) {
        run.lastError = rateLimitMessage(e.message, run.service)
        break
      }
      // 그 외 항목 하나의 실패는 치명적이지 않다 — 원래 popup.js의 syncItems()와 동일하게
      // 계속 진행하고 마지막에 성공/실패 개수로 요약한다.
      run.failed++
    }

    run.done++
    pushUpdate()
    if (!run.cancelled) setBadge(String(Math.round((run.done / run.total) * 100)), BADGE_ACCENT)
    if (!run.cancelled && i < ids.length - 1) await sleep(SYNC_DELAY_MS)
  }

  run.running = false
  pushUpdate()
  await settleBadge()
}

function handleSyncStart(req, sendResponse) {
  if (run.running) {
    sendResponse(publicState()) // 이미 실행 중 — 새로 시작하지 않고 현재 상태를 돌려준다
    return
  }
  const ids = Array.isArray(req.ids) ? req.ids.filter((id) => typeof id === 'string' && id) : []
  if (ids.length === 0 || typeof req.tabId !== 'number') {
    sendResponse({ ...idleRun(), lastError: 'invalid-request' })
    return
  }
  runGen++
  const myGen = runGen
  run = { running: true, service: req.service || null, total: ids.length, done: 0, failed: 0, cancelled: false, lastError: null }
  runTabId = req.tabId
  sendResponse(publicState())
  runSyncLoop(ids, myGen) // 응답은 이미 보냈다 — 나머지는 백그라운드에서 계속 진행
}

function handleSyncCancel(sendResponse) {
  if (run.running) {
    run.cancelled = true
    clearBadge() // 사용자가 방금 눌렀으니 뱃지는 바로 지운다(루프는 진행 중이던 항목만 마저 끝내고 곧 멈춘다)
  }
  sendResponse(publicState())
}

chrome.runtime.onMessage.addListener((req, _sender, sendResponse) => {
  if (!req) return false
  if (req.to === 'host') {
    callHost(req.msg).then(sendResponse)
    return true // 비동기 응답이므로 채널을 열어둔다
  }
  if (req.cmd === 'sync-start') {
    handleSyncStart(req, sendResponse)
    return true
  }
  if (req.cmd === 'sync-cancel') {
    handleSyncCancel(sendResponse)
    return true
  }
  if (req.cmd === 'sync-state') {
    sendResponse(publicState())
    return true
  }
  return false
})
