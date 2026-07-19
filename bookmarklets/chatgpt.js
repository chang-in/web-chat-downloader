// ChatGPT 대화 캡처 북마클릿
// 사용법: bookmarklets/README.md 참고 (북마크 URL에 한 줄로 압축해 붙여넣기)
//
// 검증 상태: UNTESTED — 실제 ChatGPT 대화 페이지에서 한 번도 실행해보지
// 않았음. `/api/auth/session` · `/backend-api/conversation/<id>` 엔드포인트와
// 응답 형태는 공개적으로 알려진 구조를 근거로 작성한 것이며, 서버 쪽에도
// 아직 chatgpt 어댑터가 없어(Task 10 보류 — 실물 응답 픽스처 필요) 지금
// 이 북마클릿을 눌러도 fetch까지는 되더라도 서버가
// `unrecognized chat payload`로 거부할 것으로 예상됨. 사용 전 README의
// "서비스별 상태" 절을 반드시 읽을 것.
//
// - 대화 페이지(/c/<id>)에서만 동작
// - /api/auth/session에서 accessToken을 읽어 backend-api를 호출
// - 응답 JSON을 그대로 로컬 서버(https://127.0.0.1:8787)로 POST

javascript:(async () => {
  try {
    const id = location.pathname.split('/c/')[1];
    if (!id) return alert('ChatGPT 대화 페이지에서 실행하세요');
    const token = (await (await fetch('/api/auth/session')).json()).accessToken;
    const raw = await (await fetch(`/backend-api/conversation/${id}`, { headers: { authorization: `Bearer ${token}` } })).json();
    const out = await (await fetch('https://127.0.0.1:8787', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify(raw) })).json();
    alert(out.sessionId ? `저장됨: ${out.sessionId}` : `실패: ${out.error}`);
  } catch (e) { alert('오류: ' + e.message); }
})();
