// claude.ai 대화 캡처 북마클릿
// 사용법: bookmarklets/README.md 참고 (북마크 URL에 한 줄로 압축해 붙여넣기)
//
// 검증 상태: PROVEN — Task 5 실증 게이트에서 이 흐름으로 저장된 세션이
// 실제 `claude --resume`으로 이어짐을 확인함 (핸드빌트 세션 기준. 브라우저
// 클릭 → POST 왕복 자체를 실제 claude.ai 페이지에서 라이브로 돌려본 적은
// 없으니, 처음 쓸 때는 서버 콘솔에 `✔ 저장`이 뜨는지 확인할 것).
//
// - 대화 페이지(/chat/<uuid>)에서만 동작
// - lastActiveOrg 쿠키로 조직 ID를 읽어 claude.ai 내부 API를 호출
// - 응답 JSON을 그대로 로컬 서버(http://127.0.0.1:8787)로 POST

javascript:(async () => {
  try {
    const m = location.pathname.match(/chat\/([0-9a-f-]{36})/);
    if (!m) return alert('claude.ai 대화 페이지에서 실행하세요');
    const orgId = (document.cookie.match(/lastActiveOrg=([^;]+)/) || [])[1];
    const url = `/api/organizations/${orgId}/chat_conversations/${m[1]}?tree=True&rendering_mode=raw`;
    const raw = await (await fetch(url, { headers: { accept: 'application/json' } })).json();
    const r = await fetch('http://127.0.0.1:8787', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify(raw) });
    const out = await r.json();
    alert(out.sessionId ? `저장됨: ${out.sessionId}` : `실패: ${out.error}`);
  } catch (e) { alert('오류: ' + e.message); }
})();
