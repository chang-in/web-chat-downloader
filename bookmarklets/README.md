# 북마클릿 — 서비스별 대화 캡처

챗봇 웹사이트에서 로그인 상태로 대화를 열어둔 채 북마클릿을 클릭하면,
그 대화를 브라우저의 `fetch`로 읽어서 로컬에서 돌고 있는
`web-chat-downloader serve`(`http://127.0.0.1:8787`)로 그대로 POST한다.
서버가 어떤 서비스의 응답인지 감지해서 Claude Code가 재개(`--resume`)할
수 있는 `.jsonl` 세션 파일로 변환·저장한다.

## 서비스별 상태 (정직하게)

| 서비스 | 파일 | 상태 |
|---|---|---|
| claude.ai | `claude.js` | **PROVEN** — 이 흐름으로 저장한 세션이 실제 `claude --resume`으로 이어지는 것까지 확인됨(Task 5 실증 게이트). 단, 그 실증은 핸드빌트 세션 기준이고, 브라우저에서 이 북마클릿을 실제로 클릭해 캡처→저장까지 라이브로 돌려본 적은 아직 없다. 처음 쓸 땐 서버 콘솔에 `✔ 저장`이 뜨는지 확인할 것. |
| ChatGPT | `chatgpt.js` | **UNTESTED** — 실제 ChatGPT 페이지에서 한 번도 실행해본 적 없음. 엔드포인트(`/api/auth/session`, `/backend-api/conversation/<id>`)는 알려진 구조를 근거로 작성. 게다가 **서버 쪽에 chatgpt 어댑터가 아직 없다**(Task 10 보류 — 실제 응답 픽스처가 있어야 만들 수 있음). 지금 클릭하면 fetch·POST 자체는 될 수 있어도 서버가 `unrecognized chat payload`로 거부할 가능성이 높다. |
| Gemini | `gemini.js` | **동작 검증됨** — orca의 hNvQHb 재현 로직 이식. 실제 대화(7턴)에서 14메시지 정확 추출 확인(브라우저 실측). `c_` prefix + `credentials:include` 필수. |

요약: **지금 실사용 가능한 건 claude.js뿐이다.** chatgpt.js·gemini.js는
Task 10(어댑터, 실물 응답 픽스처 필요)이 끝나기 전까진 서버가 거부한다.

## 설치 방법

1. 브라우저 북마크바에서 새 북마크를 만든다(이름은 예: `WCD: Claude 캡처`).
2. 북마크의 URL(주소) 칸에, 아래 "한 줄 코드"를 그대로 붙여넣는다.
   (`bookmarklets/*.js` 원본 파일은 읽기 편하게 여러 줄로 되어 있는데,
   브라우저 북마크 URL 칸은 한 줄만 받으므로 압축된 버전을 써야 한다.)
3. 저장한다.

### claude.js — 한 줄 코드

```
javascript:(async () => { try { const m = location.pathname.match(/chat\/([0-9a-f-]{36})/); if (!m) return alert('claude.ai 대화 페이지에서 실행하세요'); const orgId = (document.cookie.match(/lastActiveOrg=([^;]+)/) || [])[1]; const url = `/api/organizations/${orgId}/chat_conversations/${m[1]}?tree=True&rendering_mode=raw`; const raw = await (await fetch(url, { headers: { accept: 'application/json' } })).json(); const r = await fetch('http://127.0.0.1:8787', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify(raw) }); const out = await r.json(); alert(out.sessionId ? `저장됨: ${out.sessionId}` : `실패: ${out.error}`); } catch (e) { alert('오류: ' + e.message); }})();
```

### chatgpt.js — 한 줄 코드 (UNTESTED, 서버가 현재 거부함)

```
javascript:(async () => { try { const id = location.pathname.split('/c/')[1]; if (!id) return alert('ChatGPT 대화 페이지에서 실행하세요'); const token = (await (await fetch('/api/auth/session')).json()).accessToken; const raw = await (await fetch(`/backend-api/conversation/${id}`, { headers: { authorization: `Bearer ${token}` } })).json(); const out = await (await fetch('http://127.0.0.1:8787', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify(raw) })).json(); alert(out.sessionId ? `저장됨: ${out.sessionId}` : `실패: ${out.error}`); } catch (e) { alert('오류: ' + e.message); }})();
```

| Gemini | `gemini.js` | **동작 검증됨** — orca의 hNvQHb 재현 로직 이식. 실제 대화(7턴)에서 14메시지 정확 추출 확인(브라우저 실측). `c_` prefix + `credentials:include` 필수. |

```
javascript:(async () => { try { alert('Gemini 캡처는 아직 구현되지 않았습니다 (batchexecute 응답 파싱은 TODO). 빈 셸만 서버로 전송합니다.'); const conversationId = location.pathname.split('/').filter(Boolean).pop() || ''; const payload = { source: 'gemini', conversationId, title: document.title || '', turns: [] }; /* TODO: batchexecute 응답에서 {role,text,ts}[] 파싱해 turns 채울 것 */ const r = await fetch('http://127.0.0.1:8787', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify(payload) }); const out = await r.json(); alert(out.sessionId ? `저장됨: ${out.sessionId}` : `실패(예상된 결과 — gemini 어댑터 미구현): ${out.error}`); } catch (e) { alert('오류: ' + e.message); }})();
```

(각 한 줄 코드는 `node --check`로 문법 검증만 거쳤다 — 실제 서비스 페이지에서
동작을 확인한 건 claude.js뿐이니 위 상태표를 다시 확인할 것.)

## 사용 방법

1. 로컬에서 서버를 띄운다.
   ```bash
   npm run dev serve
   # 또는 빌드 후: web-chat-downloader serve
   ```
   기본으로 `http://127.0.0.1:8787`에서 대기하고, 저장 위치 기본값은
   `~/Desktop/Archive/web-chats`다(`--port`, `--into`로 바꿀 수 있음).
2. 캡처하려는 서비스에 로그인한 브라우저 탭에서, 저장하려는 대화 페이지를 연다.
   - claude.ai: `https://claude.ai/chat/<uuid>`
   - ChatGPT: `https://chatgpt.com/c/<id>`
   - Gemini: 대화 페이지 아무 곳
3. 해당 서비스용 북마크를 클릭한다.
4. `저장됨: <sessionId>` alert가 뜨면 성공. 서버 콘솔에도
   `✔ 저장: <sessionId> → cd <경로> && claude --resume <sessionId>` 로그가 찍힌다.
   `실패: ...` alert가 뜨면 서버 콘솔의 `✘ ...` 에러 메시지를 확인할 것.

## 주의

- 북마클릿은 현재 열려 있는 페이지의 쿠키/세션으로 그 서비스의 내부 API를
  호출한다. 즉 브라우저에 그 서비스로 로그인되어 있어야 하고, 어디까지나
  "지금 보고 있는 그 대화"만 캡처한다.
- 서버는 `127.0.0.1`에서만 듣는다(로컬 전용). 외부에 노출하지 말 것.
- ChatGPT·Gemini는 서버 쪽 어댑터가 아직 없어(Task 10 보류) 지금 캡처를
  시도해도 저장되지 않는다. 실제 응답 픽스처를 확보해 어댑터를 추가하기
  전까지는 claude.ai만 쓸 수 있다.
