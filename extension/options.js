// options.js — options.html(완성된 마크업)에 저장된 설정 값을 채우고,
// 값이 바뀌는 즉시 wcdSaveSettings로 저장한다.
//
// 저장 버튼을 두지 않는다 — 설정 화면에서 "저장 눌러야 하나?"를 매번 신경 쓰게
// 만드는 건 불필요한 마찰이라, change 시점에 바로 저장하고 대신 짧은 "저장됨"
// 토스트로 안심시킨다.

const els = {
  langRadios: document.querySelectorAll('input[name="language"]'),
  agentRadios: document.querySelectorAll('input[name="defaultAgent"]'),
  autoEnabled: document.getElementById('auto-enabled'),
  autoInterval: document.getElementById('auto-interval'),
  intervalRow: document.getElementById('interval-row'),
  scopeRadios: document.querySelectorAll('input[name="syncScope"]'),
  recentN: document.getElementById('recent-n'),
  embedImages: document.getElementById('embed-images'),
  pathClaude: document.getElementById('path-claude'),
  pathChatgpt: document.getElementById('path-chatgpt'),
  pathGemini: document.getElementById('path-gemini'),
  toast: document.getElementById('save-toast'),
}

let toastTimer = null
function flashSaved() {
  // 연속으로 값을 바꿀 때 class를 재적용해야 트랜지션이 매번 처음부터 다시 뛴다.
  els.toast.classList.remove('show')
  void els.toast.offsetWidth // 강제 리플로우 — remove/add가 같은 프레임에 묶이는 걸 막는다
  els.toast.classList.add('show')
  clearTimeout(toastTimer)
  toastTimer = setTimeout(() => els.toast.classList.remove('show'), 1400)
}

function applyAutoSyncUI(enabled) {
  els.autoInterval.disabled = !enabled
  els.intervalRow.classList.toggle('is-disabled', !enabled)
}

function applyScopeUI(recentOnly) {
  els.recentN.disabled = !recentOnly
}

async function save(patch) {
  await wcdSaveSettings(patch)
  flashSaved()
}

async function init() {
  const s = await wcdLoadSettings()

  for (const r of els.langRadios) r.checked = r.value === (s.language || 'auto')
  for (const r of els.agentRadios) r.checked = r.value === s.defaultAgent

  els.autoEnabled.checked = s.autoSync.enabled
  els.autoInterval.value = String(s.autoSync.intervalMin)
  applyAutoSyncUI(s.autoSync.enabled)

  const scopeValue = s.syncScope.recentOnly ? 'recent' : 'all'
  for (const r of els.scopeRadios) r.checked = r.value === scopeValue
  els.recentN.value = s.syncScope.recentN
  applyScopeUI(s.syncScope.recentOnly)

  els.embedImages.checked = s.embedImages

  els.pathClaude.value = s.storagePath.claude || ''
  els.pathChatgpt.value = s.storagePath.chatgpt || ''
  els.pathGemini.value = s.storagePath.gemini || ''

  wire()
}

function wire() {
  for (const r of els.langRadios) {
    r.addEventListener('change', async () => {
      if (!r.checked) return
      await save({ language: r.value })
      // 언어는 바꾼 즉시 눈에 보여야 납득이 된다. i18n.js 가 노출한 재적용을 부른다.
      if (typeof wcdI18nRun === 'function') await wcdI18nRun()
    })
  }

  for (const r of els.agentRadios) {
    r.addEventListener('change', () => {
      if (r.checked) save({ defaultAgent: r.value })
    })
  }

  els.autoEnabled.addEventListener('change', async () => {
    const enabled = els.autoEnabled.checked
    applyAutoSyncUI(enabled) // 저장 왕복을 기다리지 않고 먼저 화면부터 맞춘다
    const s = await wcdLoadSettings()
    save({ autoSync: { ...s.autoSync, enabled } })
  })

  els.autoInterval.addEventListener('change', async () => {
    const s = await wcdLoadSettings()
    save({ autoSync: { ...s.autoSync, intervalMin: Number(els.autoInterval.value) } })
  })

  for (const r of els.scopeRadios) {
    r.addEventListener('change', async () => {
      if (!r.checked) return
      const recentOnly = r.value === 'recent'
      applyScopeUI(recentOnly)
      const s = await wcdLoadSettings()
      save({ syncScope: { ...s.syncScope, recentOnly } })
    })
  }

  // input이 아닌 change에서만 저장한다 — 매 키 입력마다 저장하면 "5"를 지우고 "50"을
  // 입력하는 중간에 잘못된 값이 저장됐다 덮어써지는 게 반복돼 토스트가 계속 깜빡인다.
  els.recentN.addEventListener('change', async () => {
    const n = Math.max(1, Math.floor(Number(els.recentN.value)) || 1)
    els.recentN.value = n
    const s = await wcdLoadSettings()
    save({ syncScope: { ...s.syncScope, recentN: n } })
  })

  els.embedImages.addEventListener('change', () => {
    save({ embedImages: els.embedImages.checked })
  })

  const pathInputs = [
    [els.pathClaude, 'claude'],
    [els.pathChatgpt, 'chatgpt'],
    [els.pathGemini, 'gemini'],
  ]
  for (const [input, key] of pathInputs) {
    input.addEventListener('change', async () => {
      const v = input.value.trim()
      const s = await wcdLoadSettings()
      save({ storagePath: { ...s.storagePath, [key]: v || null } }) // 빈 값은 "기본 폴더"를 뜻하는 null로 되돌린다
    })
  }
}

init()
