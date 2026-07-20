// popup.js — popup.html(이미 완성된 마크업)을 그대로 대상으로 동작을 붙인다.
// 새 DOM 구조를 만들지 않는다 — #app의 data-service/data-host가 CSS 색상을 결정하므로
// 여기서는 그 속성과 텍스트/리스트만 채운다.

const SVC_LABEL = { claude: 'claude.ai', chatgpt: 'chatgpt.com', gemini: 'gemini.google.com' }
const SYNC_DELAY_MS = 350

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

function callHost(msg) {
  return chrome.runtime.sendMessage({ to: 'host', msg })
}

async function sendToTab(msg) {
  const res = await chrome.tabs.sendMessage(state.tabId, msg)
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
  btnCurrent.disabled = !capturable
  btnAll.disabled = !capturable || state.items.length === 0
  btnToggleAll.disabled = !capturable || state.items.length === 0
  btnSelected.disabled = !capturable || state.selected.size === 0
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms))
}

// ───────────────────── 목록 렌더 ─────────────────────

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

// ───────────────────── 캡처 ─────────────────────

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
  if (!canCapture()) return
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

// 전체 동기화(#btn-all)·선택 가져오기(#btn-selected)가 공유하는 순차 동기화 루프.
// 항목 하나가 실패해도 계속 진행하고 마지막에 성공/실패 개수를 요약한다.
async function syncItems(items) {
  setMsg('')
  showProgress(items.length)
  let ok = 0
  let fail = 0
  for (let i = 0; i < items.length; i++) {
    try {
      await captureOne(items[i].externalId)
      ok++
    } catch (e) {
      fail++
    }
    setProgress(i + 1, items.length)
    if (i < items.length - 1) await sleep(SYNC_DELAY_MS)
  }
  await refreshIndex()
  renderList()
  updateActionButtons()
  setMsg(fail > 0 ? `${ok}개 저장, ${fail}개 실패` : `${ok}개 저장`, fail > 0)
  hideProgress()
}

async function onAll() {
  if (!canCapture() || state.items.length === 0) return
  await syncItems(state.items)
}

async function onSelected() {
  if (!canCapture() || state.selected.size === 0) return
  const items = state.items.filter((i) => state.selected.has(i.externalId))
  await syncItems(items)
}

function onToggleAll() {
  const allSelected = state.items.length > 0 && state.items.every((i) => state.selected.has(i.externalId))
  state.selected = allSelected ? new Set() : new Set(state.items.map((i) => i.externalId))
  renderList()
  updateActionButtons()
}

// ───────────────────── 초기화 ─────────────────────

async function init() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true })
  state.tabId = tab.id

  // 1. 호스트 ping
  app.dataset.host = 'checking'
  const ping = await callHost({ type: 'ping' })
  state.hostOk = !!(ping && ping.ok)
  app.dataset.host = state.hostOk ? 'ok' : 'off'
  hostState.textContent = state.hostOk ? '연결됨' : '호스트 없음'

  // 2. 콘텐츠 스크립트 주입 + 서비스 감지. 매니페스트가 지원 안 하는 origin이거나(chrome://
  // 등) 페이지가 host_permissions 밖이면 executeScript/sendMessage가 던진다 — 그건 그냥
  // "지원하지 않는 페이지"로 취급한다.
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

  // 3. 저장된 인덱스(이미 저장된 대화 ✓ 표시용)
  if (state.hostOk) await refreshIndex()

  // 4. 대화 목록
  if (state.service) {
    try {
      state.items = await sendToTab({ cmd: 'list' })
    } catch (e) {
      state.items = []
      setMsg(e.message || '목록을 불러오지 못했어요.', true)
    }
  }

  renderList()
  updateActionButtons()
}

btnCurrent.addEventListener('click', onCurrent)
btnAll.addEventListener('click', onAll)
btnSelected.addEventListener('click', onSelected)
btnToggleAll.addEventListener('click', onToggleAll)

init()
