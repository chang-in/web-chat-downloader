// background.js — MV3 서비스 워커.
//
// Native Messaging 포트를 소유하고, popup/content가 호스트에 보내는 요청을 중계한다.
// 계약: chrome.runtime.onMessage로 { to: 'host', msg: {...} }를 받으면 호스트 응답을
// 그대로 sendResponse한다.
//
// 포트는 "요청마다 새로 연다(lazy reconnect-per-request)" — 장수명 포트를 만들어 두는
// 대안도 있지만, 이 서비스 워커는 유휴 상태가 되면 Chrome이 언제든 종료할 수 있어서
// 포트를 계속 들고 있어도 워커 자체가 사라지면 의미가 없다. 요청 빈도도 팝업 세션당
// 몇 번(ping·index·capture N번) 수준이라 매번 connectNative하는 비용이 무시할 만하고,
// 재연결 타이밍을 신경 쓸 필요 없이 요청/응답이 1:1로 끝나 코드가 훨씬 단순해진다.
const HOST_NAME = 'com.web_chat_downloader.host'

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
    const finish = (res) => {
      if (settled) return
      settled = true
      resolve(res)
      try { port.disconnect() } catch (e) { /* 이미 끊겼으면 무시 */ }
    }

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

chrome.runtime.onMessage.addListener((req, _sender, sendResponse) => {
  if (req && req.to === 'host') {
    callHost(req.msg).then(sendResponse)
    return true // 비동기 응답이므로 채널을 열어둔다
  }
  return false
})
