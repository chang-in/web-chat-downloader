// settings.js — 확장 전역 설정의 단일 출처.
// options 페이지가 쓰고(background/popup은 읽기만), 스키마를 여기 한 곳에만 둬서
// 화면과 동작이 서로 다른 기본값을 갖는 일이 없게 한다.

const WCD_SETTINGS_KEY = 'settings'

const WCD_DEFAULTS = {
  defaultAgent: 'claude', // 'claude' | 'codex' — resume 명령과 세션 포맷을 결정
  autoSync: { enabled: false, intervalMin: 60 }, // 30 | 60 | 180
  syncScope: { recentOnly: false, recentN: 50 }, // 최근 N개만 동기화할지
  embedImages: true, // 이미지를 세션에 base64로 넣을지(끄면 세션이 가벼워짐)
  storagePath: { claude: null, chatgpt: null, gemini: null }, // null이면 기본 폴더 사용
  language: 'auto', // 'auto' | 'ko' | 'en' — auto면 브라우저 언어를 따른다
}

async function wcdLoadSettings() {
  const got = await chrome.storage.local.get(WCD_SETTINGS_KEY)
  const saved = got[WCD_SETTINGS_KEY] || {}
  // 중첩 객체는 얕은 병합만으로 기본값이 날아가므로 키별로 합친다.
  return {
    ...WCD_DEFAULTS,
    ...saved,
    autoSync: { ...WCD_DEFAULTS.autoSync, ...(saved.autoSync || {}) },
    syncScope: { ...WCD_DEFAULTS.syncScope, ...(saved.syncScope || {}) },
    storagePath: { ...WCD_DEFAULTS.storagePath, ...(saved.storagePath || {}) },
  }
}

async function wcdSaveSettings(patch) {
  const next = { ...(await wcdLoadSettings()), ...patch }
  await chrome.storage.local.set({ [WCD_SETTINGS_KEY]: next })
  return next
}
