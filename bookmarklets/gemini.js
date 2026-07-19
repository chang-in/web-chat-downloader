// Gemini 대화 캡처 북마클릿 — PLACEHOLDER (미완성)
//
// 검증 상태: NOT IMPLEMENTED. Gemini 웹은 대화 데이터를 일반적인 REST
// JSON API가 아니라 Google의 batchexecute(RPC 배치) 프로토콜로 주고받는다.
// 이 프로토콜은 요청/응답이 파라미터화된 문자열 배열로 인코딩되어 있어
// 실제 로그인 세션에서 캡처한 원본 응답(픽스처) 없이는 어떤 rpcid를
// 부르고 응답을 어떻게 파싱해야 하는지 확정할 수 없다. Task 10(어댑터)이
// 보류 상태인 이유도 동일함 — 사용자가 실제 대화 페이지에서 네트워크
// 탭 픽스처를 캡처해줘야 진행 가능.
//
// 이 파일은 그 전까지 자리만 잡아두는 셸(shell)이다:
// - 클릭하면 "아직 구현 안 됨"을 알리는 alert만 뜬다
// - turns: []인 빈 대화 셸을 서버로 POST해서 배관(fetch → POST → 응답
//   alert)이 도는 것만 확인할 수 있게 해뒀다
// - 서버에는 아직 gemini 어댑터가 없으므로(Task 10 보류) 이 POST는
//   `unrecognized chat payload` 에러로 거부되는 게 정상이다 — "저장됨"이
//   뜨지 않는다고 이 북마클릿이 고장난 게 아니다
//
// TODO(픽스처 확보 후): batchexecute 응답에서 실제 role/text/ts를
// 추출하는 파싱 로직을 여기 채워 넣을 것. 지금은 절대 그런 척 만들지
// 않았음 — turns는 항상 빈 배열이다.

javascript:(async () => {
  try {
    alert('Gemini 캡처는 아직 구현되지 않았습니다 (batchexecute 응답 파싱은 TODO). 빈 셸만 서버로 전송합니다.');
    const conversationId = location.pathname.split('/').filter(Boolean).pop() || '';
    const payload = { source: 'gemini', conversationId, title: document.title || '', turns: [] }; /* TODO: batchexecute 응답에서 {role,text,ts}[] 파싱해 turns 채울 것 */
    const r = await fetch('http://127.0.0.1:8787', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify(payload) });
    const out = await r.json();
    alert(out.sessionId ? `저장됨: ${out.sessionId}` : `실패(예상된 결과 — gemini 어댑터 미구현): ${out.error}`);
  } catch (e) { alert('오류: ' + e.message); }
})();
