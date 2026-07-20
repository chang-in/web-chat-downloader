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
  items: [], // [{ externalId, title }]
  indexMap: {}, // externalId -> { sessionId, service, title, capturedAt }
  selected: new Set(),
}

// background가 들고 있는 대량 동기화 상태의 팝업 쪽 사본. sync-state 응답과 sync-update
// push가 둘 다 같은 모양이라 applyRunState() 하나로 같이 처리한다.
let runState = { running: false, service: null, total: 0, done: 0, failed: 0, cancelled: false, lastError: null }

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
  const res = await Promise.race([
    chrome.tabs.sendMessage(state.tabId, msg),
    new Promise((_, rej) => setTimeout(() => rej(new Error(`페이지 응답 시간 초과(25초): ${msg.cmd}`)), 25000)),
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
  // "동기화 취소"로 라벨과 동작이 바뀐다.
  if (running) {
    btnSelected.disabled = false
    btnSelected.textContent = '동기화 취소'
  } else {
    btnSelected.disabled = !capturable || state.selected.size === 0
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
    setMsg('')
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
    setMsg(runState.failed > 0 ? `${ok}개 저장, ${runState.failed}개 실패` : `${ok}개 저장`, runState.failed > 0)
  }
}

async function onAll() {
  if (!canCapture() || state.items.length === 0 || runState.running) return
  const ids = state.items.map((i) => i.externalId)
  applyRunState(await syncStart(ids))
}

// #btn-selected 하나가 두 역할을 겸한다: 평소엔 "선택 가져오기", 대량 동기화가 실행
// 중이면 "동기화 취소"(updateActionButtons가 라벨을 바꾼다).
async function onSelected() {
  if (runState.running) {
    applyRunState(await syncCancel())
    return
  }
  if (!canCapture() || state.selected.size === 0) return
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

  // 4. 대화 목록
  if (state.service) {
    try {
      state.items = await sendToTab({ cmd: 'list' })
    } catch (e) {
      console.error('[wcd] 목록 조회 실패', e)
      state.items = []
      failures.push(`목록을 불러오지 못했어요: ${e.message || e}`)
    }
  }

  // 5. 진행 중인 대량 동기화가 있으면(팝업을 닫았다 다시 열었거나 다른 탭에서 시작한
  // 경우) 그 진행률을 바로 복원한다. 실패하면 기본값(idle)인 채로 둔다.
  try {
    applyRunState(await syncState())
  } catch (e) {
    console.error('[wcd] 동기화 상태 조회 실패', e)
    failures.push(`동기화 상태를 확인하지 못했어요: ${e.message || e}`)
  }

  // applyRunState()가 성공 경로에서 setMsg('')로 지울 수 있으므로, 실패 메시지는 그 이후에
  // 한 번에 덮어써야 확실히 보인다. 실패가 없으면 기존 메시지(빈 문자열 또는 동기화 결과
  // 요약)를 그대로 둔다.
  if (failures.length > 0) setMsg(failures.join(' · '), true)

  renderList()
  updateActionButtons()
}

init()
