// popup.js — popup.html(이미 완성된 마크업)을 그대로 대상으로 동작을 붙인다.
// 새 DOM 구조를 만들지 않는다 — #app의 data-service/data-host가 CSS 색상을 결정하므로
// 여기서는 그 속성과 텍스트/리스트만 채운다.
//
// 대량 동기화 루프는 여기 없다 — background.js(서비스 워커)가 돌린다(MV3에서 팝업 JS는
// 팝업이 닫히는 순간 죽어서, 45초+짜리 작업을 팝업에 둘 수 없다). 팝업은 시작
// (sync-start)·취소(sync-cancel)·조회(sync-state)만 하고, 진행 상황은 push(sync-update)로
// 구독한다. 그래서 팝업을 닫았다 다시 열어도, 심지어 다른 계기로 시작된 동기화라도
// sync-state 조회 한 번으로 항상 최신 진행률을 그릴 수 있다.

const SVC_LABEL = { claude: 'claude.ai', chatgpt: 'chatgpt.com', gemini: 'gemini.google.com' }
const SVC_FRIENDLY = { claude: 'Claude', chatgpt: 'ChatGPT', gemini: 'Gemini' } // rate-limit 안내 문구용(도메인이 아니라 자연스러운 서비스명)
const LIST_CACHE_VERSION = 1 // 캐시 구조가 바뀌면 올린다 — 옛 캐시는 읽는 즉시 버려진다
const LIST_CACHE_TTL_MS = 10 * 60 * 1000 // 캐시가 이 시간 안이면 목록 네트워크 조회를 아예 건너뛴다

// content.js가 돌려주는 rate-limit reason("rate-limited" 또는 "rate-limited:60")을 사용자
// 문구로 바꾼다. background.js(대량 동기화 중단)도 같은 원인이면 같은 문구를 보여줘야
// "이건 또 다른 문제인가?" 싶은 혼란이 없다.
function rateLimitMessage(reason, service) {
  const m = /^rate-limited:(\d+)$/.exec(reason || '')
  const wait = m ? `${m[1]}초 뒤` : '1~2분 뒤'
  const label = SVC_FRIENDLY[service] || '서비스'
  return `${label}가 요청이 많다고 해서 멈췄어요 — ${wait} 다시 열어주세요`
}

const app = document.getElementById('app')
const svcName = document.getElementById('svc-name')
const hostState = document.getElementById('host-state')
const btnCurrent = document.getElementById('btn-current')
const btnAll = document.getElementById('btn-all')
const btnToggleAll = document.getElementById('btn-toggle-all')
const btnSelected = document.getElementById('btn-selected')
const countEl = document.getElementById('count')
const listEl = document.getElementById('list')
const progressEl = document.getElementById('progress')
const fillEl = document.getElementById('fill')
const numEl = document.getElementById('num')
const msgEl = document.getElementById('msg')

const state = {
  tabId: null,
  service: null,
  hostOk: false,
  items: [], // [{ externalId, title, updatedAt }] — updatedAt은 주는 서비스만(claude·chatgpt)
  indexMap: {}, // externalId -> { sessionId, service, title, capturedAt }
  selected: new Set(),
}

// background가 들고 있는 대량 동기화 상태의 팝업 쪽 사본. sync-state 응답과 sync-update
// push가 둘 다 같은 모양이라 applyRunState() 하나로 같이 처리한다.
let runState = { running: false, service: null, total: 0, done: 0, failed: 0, cancelled: false, lastError: null }

// 직전 "전체 동기화"에서 이미 최신이라 건너뛴 개수. 완료 메시지에 덧붙인다.
// (applyRunState가 실행 시작 시 메시지를 지우므로 시작 전에 띄우면 사라진다)
let skippedCount = 0

function callHost(msg) {
  return chrome.runtime.sendMessage({ to: 'host', msg })
}

function syncStart(ids) {
  return chrome.runtime.sendMessage({ cmd: 'sync-start', service: state.service, ids, tabId: state.tabId })
}

function syncCancel() {
  return chrome.runtime.sendMessage({ cmd: 'sync-cancel' })
}

function syncState() {
  return chrome.runtime.sendMessage({ cmd: 'sync-state' })
}

async function sendToTab(msg) {
  // 콘텐츠 스크립트가 응답하지 않으면(fetch가 매달리는 등) await가 영원히 pending이 되어
  // try/catch로도 못 잡는다 — 타임아웃으로 반드시 실패하게 만든다.
  //
  // list는 페이지네이션 내부에서 마지막 페이지가 실패할 경우 최대 20초 + 재시도 대기
  // 2초 + 재시도 20초(약 42초)에, rate limit 방지용으로 넣은 페이지 사이 간격(최대 9번 ×
  // 0.5초 = 4.5초)까지 더해 약 46.5초까지 걸릴 수 있다 — 여기 외곽 타임아웃은 그보다
  // 넉넉히 커야 한다. 그래야 항상 content.js 안쪽 타임아웃이 먼저 터져서 partial 응답으로
  // 빠져나올 여유가 생긴다.
  const res = await Promise.race([
    chrome.tabs.sendMessage(state.tabId, msg),
    new Promise((_, rej) => setTimeout(() => rej(new Error(`페이지 응답 시간 초과(65초): ${msg.cmd}`)), 65000)),
  ])
  if (res && typeof res === 'object' && '__error' in res) throw new Error(res.__error)
  return res
}

function setMsg(text, isErr) {
  msgEl.textContent = text
  msgEl.classList.toggle('err', !!isErr)
}

function canCapture() {
  return !!state.service && state.hostOk
}

function updateActionButtons() {
  const capturable = canCapture()
  const running = runState.running
  btnCurrent.disabled = !capturable || running // 단건 캡처도 대량 동기화 중엔 막는다
  btnAll.disabled = !capturable || state.items.length === 0 || running
  btnToggleAll.disabled = !capturable || state.items.length === 0

  // #btn-selected는 새 버튼을 만들지 않고 이 슬롯을 그대로 재사용한다 — 실행 중엔
  // "동기화 취소"로 라벨과 동작이 바뀐다. 단, 취소는 '이 팝업의 서비스'가 돌고 있을
  // 때만이다 — 서비스를 안 가리면 ChatGPT 팝업에서 누른 취소가 돌고 있던 Gemini
  // 동기화를 죽인다.
  if (running && runState.service === state.service) {
    btnSelected.disabled = false
    btnSelected.textContent = '동기화 취소'
  } else {
    btnSelected.disabled = !capturable || state.selected.size === 0 || running
    btnSelected.textContent = '선택 가져오기'
  }
}

// ───────────────────── 목록 렌더 ─────────────────────

// 목록을 불러오는 동안 스켈레톤을 보여준다 — 빈 화면은 "고장"으로 읽히기 때문이다.
function renderLoading() {
  countEl.textContent = '…'
  listEl.innerHTML = ''
  for (let i = 0; i < 3; i++) {
    const li = document.createElement('li')
    li.className = 'skel'
    const meta = document.createElement('div')
    meta.className = 'meta'
    const b1 = document.createElement('div')
    b1.className = 'bar'
    b1.style.width = ['78%', '62%', '85%'][i]
    const b2 = document.createElement('div')
    b2.className = 'bar cmd-bar'
    meta.appendChild(b1)
    meta.appendChild(b2)
    li.appendChild(meta)
    listEl.appendChild(li)
  }
}

function renderList() {
  listEl.innerHTML = ''
  countEl.textContent = String(state.items.length)

  if (state.items.length === 0) {
    const li = document.createElement('li')
    li.className = 'empty'
    li.id = 'empty'
    li.textContent = state.service ? '대화가 없어요.' : '대화 목록을 불러오려면 위 버튼을 누르세요.'
    listEl.appendChild(li)
    return
  }

  for (const item of state.items) {
    const entry = state.indexMap[item.externalId]
    const li = document.createElement('li')
    li.className = 'item' + (entry ? ' saved' : '')

    const checkbox = document.createElement('input')
    checkbox.type = 'checkbox'
    checkbox.dataset.id = item.externalId
    checkbox.checked = state.selected.has(item.externalId)
    checkbox.addEventListener('change', () => {
      if (checkbox.checked) state.selected.add(item.externalId)
      else state.selected.delete(item.externalId)
      updateActionButtons()
    })

    const meta = document.createElement('div')
    meta.className = 'meta'

    const title = document.createElement('div')
    title.className = 'title'
    title.textContent = item.title || '(제목 없음)'
    meta.appendChild(title)

    if (entry) {
      const cmd = document.createElement('button')
      cmd.className = 'cmd'
      cmd.textContent = `cd ~/Desktop/Archive/web-chats && claude --resume ${entry.sessionId}`
      cmd.addEventListener('click', () => {
        navigator.clipboard.writeText(cmd.textContent).then(() => {
          cmd.classList.add('copied')
          setTimeout(() => cmd.classList.remove('copied'), 1200)
        })
      })
      meta.appendChild(cmd)
    }

    li.appendChild(checkbox)
    li.appendChild(meta)
    listEl.appendChild(li)
  }
}

// ───────────────────── 목록 캐시 ─────────────────────
//
// 팝업을 열 때마다 페이지네이션 전체를 다시 훑으면(196개 계정 기준 8+ 요청) 서비스가
// 계정을 rate limit 걸 수 있다(실제로 겪은 사고). 서비스별로 chrome.storage.local에
// { items, fetchedAt, partial }을 저장해두고, 신선하면(10분 이내) 네트워크를 아예 안 부르고
// 캐시를 그대로 쓴다.

function listCacheKey(service) {
  return `list:${service}`
}

async function readListCache(service) {
  const key = listCacheKey(service)
  const data = await chrome.storage.local.get(key)
  const entry = data[key]
  // 옛 버전 확장이 남긴 형태가 다르거나 손상된 값이면 캐시 없음과 동일하게 취급한다.
  if (!entry || !Array.isArray(entry.items) || typeof entry.fetchedAt !== 'number') return null
  // 사이트별로 완전히 독립된 캐시 — 키뿐 아니라 값 안에도 소속 서비스를 적어두고 대조한다.
  // 키가 어떤 이유로 섞이거나 스키마가 바뀐 캐시는 조용히 버린다(다른 사이트 목록이 보이는 사고 방지).
  if (entry.service !== service || entry.v !== LIST_CACHE_VERSION) {
    await chrome.storage.local.remove(key)
    return null
  }
  return entry
}

function writeListCache(service, items, partial) {
  return chrome.storage.local.set({
    [listCacheKey(service)]: { v: LIST_CACHE_VERSION, service, items, fetchedAt: Date.now(), partial: !!partial },
  })
}

function clearListCache(service) {
  return chrome.storage.local.remove(listCacheKey(service))
}

function cacheAgeLabel(fetchedAt) {
  const min = Math.floor((Date.now() - fetchedAt) / 60000)
  if (min < 1) return '방금 전'
  if (min < 60) return `${min}분 전`
  return `${Math.floor(min / 60)}시간 전`
}

// content.js가 돌려주는 list 응답을 정규화한다(구버전이 주입돼 배열을 그대로 줄 수도 있다).
async function fetchServiceList() {
  const res = await sendToTab({ cmd: 'list' })
  return Array.isArray(res) ? { items: res, partial: false } : res || { items: [], partial: false }
}

function partialFailureMessage(listResult, items) {
  if (listResult.reason && /^rate-limited/.test(listResult.reason)) {
    // rate limit은 "일부만 불러왔어요"와 같은 급이 아니다 — 계정이 이미 서비스에서 제한을
    // 먹은 상태이므로, 무시하고 넘어가면 안 되는 별도 문구로 보여준다.
    return rateLimitMessage(listResult.reason, state.service)
  }
  return items.length > 0
    ? `일부만 불러왔어요 (${items.length}개) — 다시 열면 더 가져와요`
    : '목록을 가져오지 못했어요 — 잠시 후 다시 열어보세요'
}

// 새로 받아온 목록 결과를 화면/캐시에 반영할지 결정한다. partial(특히 rate-limit) 결과가
// 기존에 갖고 있던 더 큰 캐시보다 적으면 버린다 — rate limit으로 일부만 받은 걸 완전한
// 것처럼 캐시에 덮어써서 더 온전했던 이전 캐시를 잃으면 안 된다(cacheEntry가 null이면,
// 즉 비교할 이전 캐시가 없으면 — 수동 새로고침처럼 캐시를 이미 지운 경우 포함 — 항상
// 받아들인다).
async function applyListResult(listResult, cacheEntry) {
  const items = (listResult && listResult.items) || []
  const partial = !!(listResult && listResult.partial)
  const failureMsg = partial ? partialFailureMessage(listResult, items) : null

  if (partial && cacheEntry && cacheEntry.items.length > items.length) {
    return { accepted: false, failureMsg }
  }

  state.items = items
  renderList()
  updateActionButtons()
  await writeListCache(state.service, items, partial)
  return { accepted: true, failureMsg }
}

// 캐시가 있어서 이미 화면에 떠 있는 상태에서, 오래된 캐시를 조용히 새로 불러온다. init()을
// 막지 않는다 — 화면은 캐시 그대로 유지되고(깜빡임 없음) 도착하면 교체된다.
function refreshListInBackground(cacheEntry) {
  fetchServiceList()
    .then((listResult) => applyListResult(listResult, cacheEntry))
    .then((result) => {
      if (result.failureMsg) setMsg(result.failureMsg, true)
      else if (result.accepted) setMsg('') // 성공했으니 "저장된 목록 (N분 전)" 안내를 지운다
    })
    .catch((e) => {
      console.error('[wcd] 백그라운드 목록 재조회 실패', e)
      // 캐시가 이미 화면에 떠 있으니 조용히 넘어간다 — 급하게 알려야 할 에러는 아니다.
    })
}

// 목록 헤더 라벨(.lbl) 클릭/Enter/Space로 트리거되는 수동 새로고침 — 10분 기다리지 않고
// 캐시를 지운 뒤 곧바로 다시 불러온다. 사용자가 직접 누른 명시적 동작이라 스켈레톤을
// 보여줘도 된다(자동 백그라운드 재조회와 달리 화면 유지가 필수는 아니다).
let listRefreshing = false
async function onManualRefresh() {
  if (!state.service || listRefreshing) return
  listRefreshing = true
  try {
    await clearListCache(state.service)
    renderLoading()
    const listResult = await fetchServiceList()
    const result = await applyListResult(listResult, null)
    setMsg(result.failureMsg || '', !!result.failureMsg)
  } catch (e) {
    console.error('[wcd] 수동 새로고침 실패', e)
    state.items = []
    renderList()
    updateActionButtons()
    setMsg(`목록을 불러오지 못했어요: ${e.message || e}`, true)
  } finally {
    listRefreshing = false
  }
}

// ───────────────────── 진행률 ─────────────────────

function showProgress(total) {
  progressEl.hidden = false
  fillEl.style.width = '0%'
  numEl.textContent = `0/${total}`
}

function setProgress(done, total) {
  fillEl.style.width = total ? `${Math.round((done / total) * 100)}%` : '0%'
  numEl.textContent = `${done}/${total}`
}

function hideProgress() {
  progressEl.hidden = true
}

// ───────────────────── 캡처(단건) ─────────────────────

async function captureOne(id) {
  const payload = await sendToTab({ cmd: 'payload', id })
  const res = await callHost({ type: 'capture', payload })
  if (!res || !res.ok) throw new Error((res && res.error) || '캡처 실패')
  return res
}

async function refreshIndex() {
  const res = await callHost({ type: 'index' })
  state.indexMap = res && res.ok ? res.index : {}
}

async function onCurrent() {
  if (!canCapture() || runState.running) return // 대량 동기화 중엔 단건 캡처도 막는다
  setMsg('')
  showProgress(1)
  try {
    await captureOne(undefined)
    setProgress(1, 1)
    await refreshIndex()
    renderList()
    updateActionButtons()
    setMsg('저장했어요.')
  } catch (e) {
    setMsg(e.message || '실패했어요.', true)
  } finally {
    hideProgress()
  }
}

// ───────────────────── 대량 동기화(루프는 background가 돈다) ─────────────────────

// sync-start/sync-cancel/sync-state 응답과 background가 미는 sync-update push가 전부
// 같은 모양의 run state를 준다 — 여기 하나로 받아서 그린다.
function applyRunState(next) {
  if (!next) return
  const wasRunning = runState.running
  runState = next
  if (runState.running) {
    showProgress(runState.total)
    setProgress(runState.done, runState.total)
    // 다른 서비스의 동기화가 도는 동안엔 이 팝업의 버튼이 전부 잠긴다 — 이유를 안 적으면
    // 고장으로 읽힌다. 진행률 자체는 그대로 보여준다(어차피 같은 확장의 작업이라).
    if (runState.service && runState.service !== state.service) {
      setMsg(`${SVC_FRIENDLY[runState.service] || runState.service} 동기화가 진행 중이에요`)
    } else if (runState.waitingUntil) {
      // 요청 제한에 걸려 재개를 기다리는 중 — 멈춘 게 아니라는 걸 알려야 사용자가 다시
      // 누르지 않는다(다시 누르면 제한만 더 길어진다).
      const sec = Math.max(1, Math.ceil((runState.waitingUntil - Date.now()) / 1000))
      setMsg(`요청 제한에 걸려 ${sec}초 기다렸다가 이어서 받아요 (${runState.done}/${runState.total})`)
    } else if (skippedCount > 0) {
      // 진행률 총량이 목록 개수보다 작은 이유를 '지금' 알려준다 — 완료 후에 알려주면
      // 이미 "덜 받는 거 아냐?" 하고 불안해진 다음이라 늦다.
      setMsg(`${skippedCount}개는 이미 최신이라 건너뛰고, 나머지 ${runState.total}개만 받아요`)
    } else {
      setMsg('')
    }
  } else {
    hideProgress()
    if (wasRunning) finalizeSync() // 이 팝업이 지켜보는 동안 방금 끝났다(완료/취소/에러)
  }
  updateActionButtons()
}

async function finalizeSync() {
  if (state.hostOk) await refreshIndex()
  renderList()
  updateActionButtons()
  if (runState.cancelled) {
    setMsg(`동기화를 취소했어요 (${runState.done}/${runState.total})`, true)
  } else if (runState.lastError) {
    setMsg(runState.lastError, true)
  } else {
    const ok = runState.total - runState.failed
    // 건너뛴 개수를 같이 보여줘야 "목록은 300개인데 왜 100개만 받았지?"가 설명된다.
    const skipNote = skippedCount > 0 ? ` (${skippedCount}개는 이미 최신)` : ''
    setMsg(
      runState.failed > 0 ? `${ok}개 저장, ${runState.failed}개 실패${skipNote}` : `${ok}개 저장${skipNote}`,
      runState.failed > 0,
    )
  }
}

// 판단 기준 자체는 sync-filter.js에 있다 — 자동 동기화(background)와 같은 기준을 써야 한다.
function needsCapture(item) {
  return wcdNeedsCapture(item, state.indexMap[item.externalId])
}

async function onAll() {
  if (!canCapture() || state.items.length === 0 || runState.running) return
  // 전부 다시 받으면 rate limit에 걸렸을 때 재시도가 진전을 못 만든다 — 앞쪽을 다시 받다가
  // 같은 자리에서 또 멈추고, 정작 안 받은 뒤쪽엔 영영 못 닿는다.
  const targets = state.items.filter(needsCapture)
  skippedCount = state.items.length - targets.length
  if (targets.length === 0) {
    setMsg(`이미 모두 최신이에요 (${state.items.length}개)`)
    return
  }
  const res = await syncStart(targets.map((i) => i.externalId))
  // busyWith가 있으면 내 요청은 거절된 것이다 — 남의 진행률을 내 것처럼 그리면 안 된다.
  if (res && res.busyWith && res.busyWith !== state.service) {
    applyRunState(res)
    setMsg(`${SVC_FRIENDLY[res.busyWith] || res.busyWith} 동기화가 진행 중이에요 — 끝난 뒤 다시 눌러주세요`, true)
    return
  }
  applyRunState(res)
}

// #btn-selected 하나가 두 역할을 겸한다: 평소엔 "선택 가져오기", 대량 동기화가 실행
// 중이면 "동기화 취소"(updateActionButtons가 라벨을 바꾼다).
async function onSelected() {
  if (runState.running) {
    // 내 서비스의 실행일 때만 취소한다(버튼 라벨과 같은 조건) — 남의 동기화는 건드리지 않는다.
    if (runState.service === state.service) applyRunState(await syncCancel())
    return
  }
  if (!canCapture() || state.selected.size === 0) return
  // 사용자가 직접 고른 것이므로 최신 여부와 무관하게 그대로 받는다(강제 갱신 수단이기도 하다).
  skippedCount = 0
  const ids = state.items.filter((i) => state.selected.has(i.externalId)).map((i) => i.externalId)
  applyRunState(await syncStart(ids))
}

function onToggleAll() {
  const allSelected = state.items.length > 0 && state.items.every((i) => state.selected.has(i.externalId))
  state.selected = allSelected ? new Set() : new Set(state.items.map((i) => i.externalId))
  renderList()
  updateActionButtons()
}

// background가 진행 중 계속 밀어주는 상태를 구독한다(팝업이 열려 있는 동안만 받는다).
chrome.runtime.onMessage.addListener((req) => {
  if (req && req.cmd === 'sync-update') applyRunState(req.state)
})

btnCurrent.addEventListener('click', onCurrent)
btnAll.addEventListener('click', onAll)
btnSelected.addEventListener('click', onSelected)
btnToggleAll.addEventListener('click', onToggleAll)

// 목록 헤더의 "대화 N" 라벨을 수동 새로고침 버튼처럼 쓴다 — popup.html/css는 건드리지
// 않기로 해서 새 버튼 대신 기존 요소에 role/tabindex/핸들러만 얹는다.
document.getElementById('btn-refresh').addEventListener('click', onManualRefresh)

// ───────────────────── 초기화 ─────────────────────

// init의 각 단계는 독립적으로 실패할 수 있다 — 한 단계가 던져도 나머지 단계와
// renderList()는 반드시 실행돼야 한다(그래야 count가 계속 "—"로 멈춰있는 채로 원인도
// 모르고 목록도 안 뜨는 상황을 피할 수 있다). 그래서 각 await를 자기 try/catch로 감싸고,
// 실패 사유를 모아뒀다가 마지막에 한 번에 #msg로 보여준다.
async function init() {
  renderLoading()
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true })
  state.tabId = tab.id

  const failures = []

  // 1. 호스트 ping
  app.dataset.host = 'checking'
  try {
    const ping = await callHost({ type: 'ping' })
    state.hostOk = !!(ping && ping.ok)
  } catch (e) {
    console.error('[wcd] host ping 실패', e)
    state.hostOk = false
    failures.push(`호스트 연결을 확인하지 못했어요: ${e.message || e}`)
  }
  app.dataset.host = state.hostOk ? 'ok' : 'off'
  hostState.textContent = state.hostOk ? '연결됨' : '호스트 없음'

  // 2. 콘텐츠 스크립트 주입 + 서비스 감지. 매니페스트가 지원 안 하는 origin이거나(chrome://
  // 등) 페이지가 host_permissions 밖이면 executeScript/sendMessage가 던진다 — 그건 그냥
  // "지원하지 않는 페이지"로 취급한다(에러가 아니라 정상적인 상태이므로 #msg에는 안 띄운다).
  let detected = { service: null, id: null }
  try {
    await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['content.js'] })
    detected = await sendToTab({ cmd: 'detect' })
  } catch (e) {
    detected = { service: null, id: null }
  }
  state.service = detected.service
  app.dataset.service = state.service || 'none'
  svcName.textContent = state.service ? SVC_LABEL[state.service] : '지원하지 않는 페이지'

  updateActionButtons()

  // 2-1. 캐시가 있으면 여기서 바로 그린다 — 스켈레톤을 계속 보여줄 이유가 없다. 서비스가
  // 확인되자마자(호스트/인덱스/네트워크 목록 조회를 기다리지 않고) 화면을 채운다. 아래
  // 4번에서 이 cacheEntry를 다시 참조해 신선도 판단과 partial 가드에 쓴다.
  let cacheEntry = null
  if (state.service) {
    cacheEntry = await readListCache(state.service)
    if (cacheEntry) {
      state.items = cacheEntry.items
      renderList()
      updateActionButtons()
      setMsg(`저장된 목록 (${cacheAgeLabel(cacheEntry.fetchedAt)})`)
    }
  }

  // 2-2. 진행 중인 대량 동기화가 있으면 여기서 바로 복원한다. 아래 인덱스·목록 조회는
  // 네트워크를 타서 수 초 이상 걸릴 수 있는데, 그동안 진행률이 안 보이면 팝업을 닫았다
  // 열 때마다 "아무것도 진행 안 된 것처럼" 보인다. background에 물어보면 즉시 오는
  // 로컬 정보이므로 원격 조회보다 먼저 그린다.
  try {
    applyRunState(await syncState())
  } catch (e) {
    console.error('[wcd] 동기화 상태 조회 실패', e)
    failures.push(`동기화 상태를 확인하지 못했어요: ${e.message || e}`)
  }

  // 3. 저장된 인덱스(이미 저장된 대화 ✓ 표시용) — 실패해도 목록 자체는 떠야 하므로
  // indexMap만 비워두고(✓ 표시 없이) 계속 진행한다.
  if (state.hostOk) {
    try {
      await refreshIndex()
    } catch (e) {
      console.error('[wcd] 인덱스 갱신 실패', e)
      state.indexMap = {}
      failures.push(`인덱스를 불러오지 못했어요: ${e.message || e}`)
    }
  }

  // 4. 대화 목록 갱신 여부 — 캐시가 10분 이내로 신선하면 네트워크를 아예 안 부른다(계정이
  // rate limit 먹은 적 있어서 재요청을 최대한 줄이는 게 이 단계의 목적이다). 캐시가
  // 있었지만 오래됐으면 백그라운드로 다시 불러온다(화면은 2-1에서 그린 캐시 그대로 두고
  // init()도 기다리지 않는다 — 깜빡임 없음). 캐시가 아예 없었으면 지금까지처럼 여기서
  // 기다린 뒤 그린다(스켈레톤 유지).
  // 이 서비스의 동기화가 도는 중이면 목록을 새로 부르지 않는다 — 같은 API에 요청을 겹쳐
  // 쏘면 rate limit만 앞당기고, 화면은 캐시로도 충분하다(동기화가 끝나면 갱신된다).
  const syncingHere = runState.running && runState.service === state.service
  if (state.service && !syncingHere) {
    const isFresh = cacheEntry && Date.now() - cacheEntry.fetchedAt < LIST_CACHE_TTL_MS
    if (!isFresh) {
      if (cacheEntry) {
        refreshListInBackground(cacheEntry)
      } else {
        try {
          const listResult = await fetchServiceList()
          const result = await applyListResult(listResult, null)
          if (result.failureMsg) failures.push(result.failureMsg)
        } catch (e) {
          console.error('[wcd] 목록 조회 실패', e)
          state.items = []
          failures.push(`목록을 불러오지 못했어요: ${e.message || e}`)
        }
      }
    }
  }

  // (진행률 복원은 2-2에서 이미 끝났다 — 여기까지 오는 동안에도 sync-update push가
  // 계속 들어오므로 다시 조회할 필요가 없다.)

  // applyRunState()가 성공 경로에서 setMsg('')로 지울 수 있으므로, 실패 메시지는 그 이후에
  // 한 번에 덮어써야 확실히 보인다. 실패가 없으면 기존 메시지(빈 문자열 또는 동기화 결과
  // 요약)를 그대로 둔다.
  if (failures.length > 0) setMsg(failures.join(' · '), true)

  renderList()
  updateActionButtons()
}

document.getElementById('btn-options').addEventListener('click', () => {
  // 확장 옵션 페이지는 전용 API로 열어야 브라우저가 올바른 컨텍스트를 준다.
  chrome.runtime.openOptionsPage()
})

document.getElementById('btn-help').addEventListener('click', () => {
  chrome.tabs.create({ url: chrome.runtime.getURL('help.html') })
})

init()
