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
//
// 3) 자동 동기화(auto-sync) — chrome.alarms로 주기적으로 깨어나서 위 2)의 대량 동기화
//    루프를 사용자 조작 없이 스스로 돌린다. 콘텐츠 스크립트는 로그인 세션이 있는 "그
//    서비스 사이트 탭" 안에서만 실행할 수 있어서, 그런 탭이 열려 있지 않으면 이번 주기는
//    그냥 건너뛴다(사용자 대신 새 탭을 여는 건 침해적이라 하지 않는다). 자세한 설명은
//    아래 "자동 동기화" 섹션 주석 참고.
const HOST_NAME = 'com.web_chat_downloader.host'
// settings.js(WCD_SETTINGS_KEY, WCD_DEFAULTS, wcdLoadSettings)와 colors.js(WCD_SERVICE_COLORS)를
// 서비스 워커 전역에 끌어온다. manifest.json의 background가 "type": "module"이 아닌 classic
// 서비스 워커라 importScripts를 쓸 수 있다 — 별도 번들러 없이 전역을 공유하는 가장 단순한 방법.
importScripts('settings.js', 'colors.js', 'sync-filter.js')
const BADGE_ACCENT = '#C4633F' // service를 모를 때(run.service가 null 등)의 폴백 색 —
// 우연히 WCD_SERVICE_COLORS.claude와 같은 값이지만, 이건 서비스별 팔레트가 생기기 전부터
// 있던 브랜드 accent라 개념이 다르다(팔레트가 바뀌어도 폴백은 안 바뀌어야 하므로 따로 둔다).
const BADGE_FAIL = '#D14343' // 실패/에러 표시 — 절대 서비스별로 바뀌면 안 된다(색 자체가 "문제 발생" 신호)
const SYNC_DELAY_MS = 350 // 항목 사이 요청 간격(서비스 API에 대한 예의) — 기존 popup.js 값 그대로 이전
const SVC_FRIENDLY = { chatgpt: 'ChatGPT', gemini: 'Gemini', claude: 'Claude' } // rate-limit 안내 문구용
const DONE_BADGE_MS = 3000
const FAIL_BADGE_MS = 5000
const HOST_TIMEOUT_MS = 15000 // 응답도 disconnect도 안 오는(포트가 먹통이 된) 경우의 안전망 —
// 없으면 popup 쪽 sendMessage가 영영 pending 상태로 남는다.

const AUTOSYNC_ALARM = 'wcd-autosync' // chrome.alarms에 등록하는 알람 이름
const AUTOSYNC_STATUS_KEY = 'wcdAutoSyncStatus' // chrome.storage.local에 상태를 남겨서 서비스
// 워커가 재기동돼도(=메모리 상태가 날아가도) 마지막 자동 동기화 결과를 잃지 않게 한다.
const AUTOSYNC_URL_PATTERNS = [ // 콘텐츠 스크립트가 돌 수 있는 지원 사이트 — host_permissions와 동일
  'https://claude.ai/*',
  'https://chatgpt.com/*',
  'https://chat.openai.com/*',
  'https://gemini.google.com/*',
]
const AUTOSYNC_SERVICE_ORDER = ['claude', 'chatgpt', 'gemini'] // 한 주기에 서비스를 도는 고정 순서(재현 가능하게)

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

// 진행률/완료 뱃지는 지금 동기화 중인 서비스의 액센트 색으로 그린다 — service가 null이거나
// (버전이 안 맞는 등의 이유로) 팔레트에 없는 값이면 기존 브랜드 accent로 폴백한다.
function badgeAccentFor(service) {
  return (service && WCD_SERVICE_COLORS[service]) || BADGE_ACCENT
}

function setBadge(text, color) {
  chrome.action.setBadgeBackgroundColor({ color })
  chrome.action.setBadgeText({ text })
}

function clearBadge() {
  chrome.action.setBadgeText({ text: '' })
}

// ───────────────────── 대량 동기화 상태 ─────────────────────

function idleRun() {
  // rateLimited: 이번 실행이 429로 중단됐는지 — 팝업은 안 쓰고(그쪽은 lastError 문구만
  // 보여주면 충분) 아래 자동 동기화가 "이 주기는 429였다"를 판별하는 데 쓴다. 기존
  // 필드는 그대로라 popup.js 쪽 계약은 안 바뀐다(추가 필드는 무시될 뿐이라 하위 호환).
  return { running: false, service: null, total: 0, done: 0, failed: 0, cancelled: false, lastError: null, rateLimited: false }
}

let run = idleRun()
let runTabId = null // 이 실행을 시작한 탭 — content script 호출은 항상 이 탭으로만 간다
let runGen = 0 // 실행 세대 번호. 아래 runSyncLoop 마지막 뱃지 정리 부분 주석 참고

function publicState() {
  return { ...run }
}

// sync-start(popup)와 자동 동기화 둘 다 "새 실행을 세팅한다"는 같은 일을 하므로 한 곳으로
// 모았다 — run/runGen/runTabId를 새 실행 기준으로 갈아끼우고 이번 실행의 세대 번호를 준다.
function beginRun(ids, service, tabId) {
  runGen++
  const myGen = runGen
  run = { running: true, service: service || null, total: ids.length, done: 0, failed: 0, cancelled: false, lastError: null, rateLimited: false }
  runTabId = tabId
  return myGen
}

function pushUpdate() {
  chrome.runtime.sendMessage({ cmd: 'sync-update', state: publicState() }, () => {
    void chrome.runtime.lastError // 팝업이 닫혀 있으면 리시버가 없다는 에러가 나는데 정상이라 무시
  })
}

// 대화 본문 요청은 그 탭의 콘텐츠 스크립트를 거친다. 그런데 Chrome은 뒤로 밀린 탭을 강하게
// 조절해서, 다른 탭으로 이동한 순간 응답이 영영 안 오는 경우가 있다(실측: 도움말을 새 탭으로
// 열자 동기화가 그 자리에 얼어붙었다). 타임아웃이 없으면 이 await가 풀리지 않아 루프가
// 에러도 없이 멈춘다 — 재시도도 실패 집계도 안 되고 뱃지만 마지막 퍼센트에 남는다.
const PAYLOAD_TIMEOUT_MS = 60000
// 목록 조회 감시. content.js가 페이지마다 20초 타임아웃에 재시도 한 번을 쓰고, 페이지 사이
// 간격까지 있으니 대화가 많은 계정에서는 전체가 꽤 길어질 수 있다 — 넉넉히 준다.
const LIST_TIMEOUT_MS = 180000

function withTimeout(promise, ms, message) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      const err = new Error(message)
      err.timedOut = true
      reject(err)
    }, ms)
    promise.then(
      (v) => { clearTimeout(timer); resolve(v) },
      (e) => { clearTimeout(timer); reject(e) },
    )
  })
}

async function fetchPayload(id) {
  const res = await withTimeout(
    chrome.tabs.sendMessage(runTabId, { cmd: 'payload', id }),
    PAYLOAD_TIMEOUT_MS,
    '탭이 응답하지 않아요',
  )
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
  setBadge('0', badgeAccentFor(run.service))

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
      setBadge('✓', badgeAccentFor(run.service))
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
        run.rateLimited = true // 자동 동기화가 이 값을 보고 다음 주기를 건너뛸지 판단한다
        break
      }
      // 타임아웃도 항목 하나의 실패로 넘기지 않는다 — 탭이 조절되거나 얼어붙은 상태라면
      // 남은 항목도 전부 같은 시간만큼 기다리다 실패한다. 즉시 멈추고 이유를 알린다.
      if (e && e.timedOut) {
        run.lastError = '탭이 응답하지 않아 중단했어요 — 그 탭을 앞에 둔 채로 다시 시도해주세요'
        break
      }
      // 그 외 항목 하나의 실패는 치명적이지 않다 — 원래 popup.js의 syncItems()와 동일하게
      // 계속 진행하고 마지막에 성공/실패 개수로 요약한다.
      run.failed++
    }

    run.done++
    pushUpdate()
    if (!run.cancelled) setBadge(String(Math.round((run.done / run.total) * 100)), badgeAccentFor(run.service))
    if (!run.cancelled && i < ids.length - 1) await sleep(SYNC_DELAY_MS)
  }

  run.running = false
  pushUpdate()
  await settleBadge()
}

function handleSyncStart(req, sendResponse) {
  if (run.running) {
    // 이미 실행 중 — 새로 시작하지 않는다. 이때 현재 상태만 돌려주면 팝업이 '남의 서비스'
    // 진행률을 그려서 마치 시작된 것처럼 보인다. busyWith를 실어 보내 팝업이 구분하게 한다.
    sendResponse({ ...publicState(), busyWith: run.service })
    return
  }
  const ids = Array.isArray(req.ids) ? req.ids.filter((id) => typeof id === 'string' && id) : []
  if (ids.length === 0 || typeof req.tabId !== 'number') {
    sendResponse({ ...idleRun(), lastError: 'invalid-request' })
    return
  }
  const myGen = beginRun(ids, req.service, req.tabId)
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

// ───────────────────── 자동 동기화(알람 기반) ─────────────────────
//
// chrome.alarms는 서비스 워커가 유휴 종료돼 있어도 브라우저가 대신 깨워주는 유일한 신뢰할
// 만한 타이머다(setInterval은 워커가 죽으면 같이 사라진다) — 그래서 "주기적으로 자동
// 동기화"는 반드시 alarms로 구현한다.
//
// 알람이 울렸다고 바로 대량 동기화를 돌릴 수 있는 게 아니다: 콘텐츠 스크립트는 로그인
// 세션이 있는 "그 서비스 사이트가 열려 있는 탭" 안에서만 실행 가능하다(background에서
// claude.ai 등을 직접 fetch할 수 없는 이유는 위쪽 runSyncLoop 주석 참고). 그런 탭이 하나도
// 없으면 이번 주기는 그냥 건너뛴다 — 사용자 몰래 새 탭을 여는 건 아래에서 하지 않는다.
//
// 루프 자체는 새로 만들지 않는다. beginRun() + runSyncLoop()로 위의 대량 동기화 상태
// 머신을 그대로 돌려서, 팝업을 열어 보는 진행률/뱃지가 수동 동기화와 완전히 같게 만든다.

let autoSyncRunning = false // 알람 콜백 이중 발화 방어(이론상 한 번만 오지만, 워커 재기동
// 타이밍이 겹치는 등의 엣지 케이스에 대비한 안전망)

function idleAutoSyncStatus() {
  return {
    lastRunAt: null, // 알람이 울려 처리를 "시도"한 시각(ms epoch) — 건너뛴 경우도 포함
    lastOutcome: null, // 'ok' | 'partial' | 'rate-limited' | 'skipped-no-tab' | 'skipped-already-running' | 'skipped-backoff' | 'error'
    lastDetail: null, // 사람이 읽을 짧은 요약(서비스별 결과 등) — 미래 UI가 그대로 보여줄 수 있는 문구
    backoffSkipsRemaining: 0, // 429를 만나면 1이 되고, 그다음 주기를 건너뛰며 0으로 돌아온다
  }
}

// chrome.storage.local에서 로드한 값으로 시작하고(아래 startup IIFE 참고), 이후엔 이
// 메모리 값을 단일 출처로 쓰면서 매번 storage에도 반영한다 — 워커가 재기동돼도 마지막
// 결과를 잃지 않기 위해서다.
let autoSyncStatus = idleAutoSyncStatus()

async function recordAutoSyncStatus(patch) {
  autoSyncStatus = { ...autoSyncStatus, lastRunAt: Date.now(), ...patch }
  try {
    await chrome.storage.local.set({ [AUTOSYNC_STATUS_KEY]: autoSyncStatus })
  } catch (e) {
    console.error('[wcd] 자동 동기화 상태 저장 실패', e)
  }
}

function hostToService(hostname) {
  if (hostname === 'claude.ai') return 'claude'
  if (hostname === 'chatgpt.com' || hostname === 'chat.openai.com') return 'chatgpt'
  if (hostname === 'gemini.google.com') return 'gemini'
  return null
}

// 지원 사이트가 열린 탭 중 서비스별로 하나씩만 고른다. 활성 탭(사용자가 지금 보고 있는
// 탭)은 되도록 건드리지 않으려고 비활성 탭을 우선한다 — 여러 창에 걸쳐 활성 탭이 여러 개
// 있을 수 있어서 "비활성"이 하나도 없을 때만 활성 탭을 쓴다.
async function pickAutoSyncTabs() {
  const tabs = await chrome.tabs.query({ url: AUTOSYNC_URL_PATTERNS })
  const bySvc = {}
  for (const tab of tabs) {
    if (!tab.url || typeof tab.id !== 'number') continue
    let hostname
    try { hostname = new URL(tab.url).hostname } catch (e) { continue }
    const svc = hostToService(hostname)
    if (!svc) continue
    const cur = bySvc[svc]
    if (!cur || (cur.active && !tab.active)) bySvc[svc] = tab
  }
  return bySvc
}

// 해당 탭에서 목록을 가져와 동기화 대상 id 배열로 정리한다. content.js의 list 명령은
// popup.js가 쓰는 것과 완전히 같은 계약이다({ items, partial, reason } 또는 구버전 호환용
// 배열) — rate-limit이면 reason이 "rate-limited"(또는 "rate-limited:60") 형태로 온다.
async function fetchAutoSyncIds(tabId, service, scope) {
  await chrome.scripting.executeScript({ target: { tabId }, files: ['content.js'] })
  // 팝업과 달리 자동 동기화에는 바깥 감시자가 없다 — 여기서 안 걸어두면 탭이 응답을 멈췄을 때
  // 주기 하나가 통째로 매달린 채 다음 알람까지 아무 일도 못 한다.
  const res = await withTimeout(
    chrome.tabs.sendMessage(tabId, { cmd: 'list' }),
    LIST_TIMEOUT_MS,
    '탭이 목록 요청에 응답하지 않아요',
  )
  const listResult = Array.isArray(res) ? { items: res, partial: false } : res || { items: [], partial: false }
  if (listResult.reason && /^rate-limited/.test(listResult.reason)) {
    const err = new Error(rateLimitMessage(listResult.reason, service))
    err.rateLimited = true
    throw err
  }
  let items = listResult.items || []
  // syncScope.recentOnly: 목록은 항상 최신순이라 앞에서 N개만 자르면 된다.
  if (scope && scope.recentOnly) items = items.slice(0, Math.max(0, Number(scope.recentN) || 0))

  // 이미 최신인 건 빼고 넘긴다 — 팝업의 전체 동기화와 같은 기준(sync-filter.js)을 쓴다.
  // 자동 동기화는 30분~3시간마다 스스로 도는데, 매번 전량을 다시 받으면 그 자체가
  // rate limit을 부르는 데다 새 대화가 뒤쪽에 있으면 영영 못 받는다.
  // 인덱스 조회에 실패하면(호스트 미실행 등) 거르지 않고 전부 넘긴다 — 판단 근거가
  // 없을 때 걸러내면 조용히 빠뜨리게 된다.
  const idxRes = await callHost({ type: 'index' })
  const index = idxRes && idxRes.ok && idxRes.index ? idxRes.index : null
  const targets = index ? items.filter((it) => wcdNeedsCapture(it, index[it && it.externalId])) : items
  return targets.map((it) => it && it.externalId).filter(Boolean)
}

async function runAutoSyncInner() {
  const settings = await wcdLoadSettings()
  if (!settings.autoSync || !settings.autoSync.enabled) return // 알람이 아직 안 지워진 채로
  // 막 꺼진 경우의 방어 — 다음 storage.onChanged가 알람 자체는 곧 정리한다.

  // 직전 주기가 429로 중단됐으면 이번 한 번은 조용히 건너뛴다 — 시각 기준(setTimeout류)
  // 대신 "건너뛸 횟수" 카운터를 쓰는 이유: 알람 주기가 30/60/180분으로 제각각이라
  // 타임스탬프 비교는 알람이 정확히 그 시각에 안 울리면(브라우저가 약간 늦게 깨우는 경우가
  // 흔하다) 건너뛰어야 할 주기를 못 건너뛰는 경계 조건이 생긴다. 카운터는 그 문제가 없다.
  if (autoSyncStatus.backoffSkipsRemaining > 0) {
    await recordAutoSyncStatus({
      lastOutcome: 'skipped-backoff',
      lastDetail: '직전 자동 동기화가 요청 제한(429)에 걸려서 이번 주기는 건너뛰었어요',
      backoffSkipsRemaining: autoSyncStatus.backoffSkipsRemaining - 1,
    })
    return
  }

  if (run.running) {
    // 수동(popup) 동기화든 이전 자동 동기화든, 이미 도는 실행이 있으면 절대 겹쳐 돌리지
    // 않는다 — 대량 동기화 상태 머신은 실행 하나만 추적하게 설계돼 있다.
    await recordAutoSyncStatus({ lastOutcome: 'skipped-already-running', lastDetail: '이미 다른 동기화가 진행 중이에요' })
    return
  }

  const bySvc = await pickAutoSyncTabs()
  const services = AUTOSYNC_SERVICE_ORDER.filter((s) => bySvc[s])
  if (services.length === 0) {
    await recordAutoSyncStatus({ lastOutcome: 'skipped-no-tab', lastDetail: '지원하는 사이트 탭이 열려 있지 않아요' })
    return
  }

  const summary = []
  let hitRateLimit = false

  for (const svc of services) {
    const tab = bySvc[svc]
    let ids
    try {
      ids = await fetchAutoSyncIds(tab.id, svc, settings.syncScope)
    } catch (e) {
      if (e && e.rateLimited) {
        hitRateLimit = true
        summary.push(`${SVC_FRIENDLY[svc] || svc}: 요청 제한으로 목록 조회 중단`)
        break
      }
      summary.push(`${SVC_FRIENDLY[svc] || svc}: 목록을 가져오지 못함`)
      continue
    }
    if (ids.length === 0) {
      summary.push(`${SVC_FRIENDLY[svc] || svc}: 새로 가져올 대화 없음`)
      continue
    }

    const myGen = beginRun(ids, svc, tab.id)
    pushUpdate() // 이 순간 팝업이 열려 있었다면 자동 동기화 진행률도 수동과 똑같이 보인다
    await runSyncLoop(ids, myGen) // 같은 상태 머신 — 페이싱·뱃지·sync-state가 전부 동일하게 동작한다

    if (run.rateLimited) {
      hitRateLimit = true
      summary.push(`${SVC_FRIENDLY[svc] || svc}: 요청 제한으로 중단(${run.done}/${run.total})`)
      break
    }
    summary.push(`${SVC_FRIENDLY[svc] || svc}: ${run.done - run.failed}개 저장${run.failed ? `, ${run.failed}개 실패` : ''}`)
  }

  if (hitRateLimit) {
    await recordAutoSyncStatus({ lastOutcome: 'rate-limited', lastDetail: summary.join(' / '), backoffSkipsRemaining: 1 })
    return
  }
  const hadFailure = summary.some((s) => /가져오지 못함|개 실패/.test(s))
  await recordAutoSyncStatus({ lastOutcome: hadFailure ? 'partial' : 'ok', lastDetail: summary.join(' / ') })
}

// 바깥쪽 얇은 래퍼 — runSyncLoop과 같은 이유로(위쪽 주석 참고) 안쪽에서 예상 못 한 예외가
// 새면 autoSyncRunning이 영영 true로 멈춰 이후 모든 주기가 조용히 막히니, 여기서 반드시
// 되돌린다.
async function runAutoSync() {
  if (autoSyncRunning) return
  autoSyncRunning = true
  try {
    await runAutoSyncInner()
  } catch (e) {
    console.error('[wcd] 자동 동기화 중 알 수 없는 오류', e)
    await recordAutoSyncStatus({ lastOutcome: 'error', lastDetail: (e && e.message) || '알 수 없는 오류가 발생했어요' })
  } finally {
    autoSyncRunning = false
  }
}

// 현재 설정에 맞춰 알람을 다시 세팅한다. chrome.alarms.create는 같은 이름으로 다시 부르면
// 그냥 덮어써서(clear 없이도) 주기가 바뀐 경우를 그대로 반영한다. periodInMinutes만 주면
// 최초 발화도 그 시간 뒤로 잡힌다 — 설정을 켜자마자 바로 도는 게 아니라 한 주기 기다렸다가
// 처음 시도한다(막 켠 직후엔 탭 준비가 안 됐을 수도 있고, 어차피 껐다 켜자마자 도는 동작은
// 사용자가 기대하는 그림이 아니다).
async function syncAlarmFromSettings() {
  const settings = await wcdLoadSettings()
  if (settings.autoSync && settings.autoSync.enabled) {
    chrome.alarms.create(AUTOSYNC_ALARM, { periodInMinutes: settings.autoSync.intervalMin })
  } else {
    chrome.alarms.clear(AUTOSYNC_ALARM)
  }
}

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === AUTOSYNC_ALARM) runAutoSync()
})

// autoSync/syncScope 설정이 바뀔 때마다(옵션 페이지가 wcdSaveSettings로 저장) 알람을 즉시
// 다시 맞춘다 — 예: 껐다/켰다, 주기 변경. 이 리스너를 최상위(top-level)에 등록해 둬야
// 서비스 워커가 유휴 종료돼 있어도 storage 변경 이벤트로 다시 깨어난다.
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes[WCD_SETTINGS_KEY]) syncAlarmFromSettings()
})

// 서비스 워커가 새로 뜰 때마다(설치·브라우저 시작·알람/메시지로 깨어남 등, MV3 서비스
// 워커는 매번 이 파일 전체를 다시 평가한다) 저장된 자동 동기화 상태를 메모리로 복원하고
// 알람을 현재 설정과 맞춘다 — "서비스 워커 기동 시 (재)생성/정리" 요구사항이 여기서 채워진다.
;(async () => {
  try {
    const got = await chrome.storage.local.get(AUTOSYNC_STATUS_KEY)
    if (got[AUTOSYNC_STATUS_KEY]) autoSyncStatus = { ...idleAutoSyncStatus(), ...got[AUTOSYNC_STATUS_KEY] }
  } catch (e) {
    console.error('[wcd] 자동 동기화 상태 복원 실패', e)
  }
  await syncAlarmFromSettings()
})()

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
  if (req.cmd === 'autosync-state') {
    // sync-state와 같은 조회 계약 — 미래 UI가 "마지막 자동 동기화: N분 전 / 건너뜀(탭 없음)"
    // 같은 문구를 그릴 수 있게 상태를 그대로 돌려준다. 기존 popup.js는 이 cmd를 보내지
    // 않으니 기존 동작에는 영향이 없다.
    sendResponse({ ...autoSyncStatus })
    return true
  }
  return false
})
