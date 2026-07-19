# web-chat-downloader 설계

작성일: 2026-07-20
상태: 설계 확정 대기(사용자 검토 전)

## 1. 목적

claude.ai · ChatGPT · Gemini의 웹 대화를 로컬 Claude Code 세션 파일(`.jsonl`)로 변환해서,
`claude --resume`으로 터미널에서 그 대화를 이어갈 수 있게 한다.

**기준(Non-negotiable):** orca의 변환 골격은 *참고*일 뿐이고, 산출물은 **실제 Claude Code가 만드는
세션 포맷과 근본적으로 동일**해야 한다. 필드는 추측으로 채우지 않고 실측(실제 세션 60개 교차 대조)에서
도출하며, 최종 판정은 실제 `claude --resume` 실행으로 검증한다.

## 2. 성공 기준

1. 변환한 세션이 `claude --resume <id>`에서 **CC 자체 세션과 구별 없이** 이전 대화를 인식·이어받는다.
2. **resume 실증 게이트(정의상 "완성"의 조건):** 저장 폴더(`web-chats`)에서 실제 CC를 한 번 돌려
   레퍼런스 세션을 뜨고, 우리 출력과 구조적으로 대조 → 필드셋 일치 + 실제 resume 이어받기 성공.
   이 게이트를 통과하지 못하면 완성이 아니다.
3. 필드는 실측 근거를 가진다(§6). 대응물 없는 런타임 값은 생략하거나 정직한 기본값(0/HEAD)으로 둔다.

## 3. 아키텍처 — 캡처와 변환의 2단 분리

웹 대화는 **로그인된 브라우저 세션의 API 응답**에만 있고, 세션 파일은 **로컬에서만** 쓸 수 있다.
그래서 둘을 `localhost` HTTP로 잇는다.

```
[대화 페이지] --북마클릿 클릭--> 로그인 세션으로 대화 API·첨부 fetch
   --POST localhost:PORT--> [web-chat-downloader serve]
   --서비스 감지--> normalize() --> CC 세션 합성 --> writeSession()
   --> ~/.claude/projects/<slug>/<uuid>.jsonl  (+ attachments/)
   --> 콘솔에 "cd ~/Desktop/Archive/web-chats && claude --resume <id>" 안내
```

- **인증**은 캡처 단계가 브라우저 세션으로 해결한다(CLI엔 쿠키가 없으므로 CLI 단독 캡처는 불가).
- 사용자 동작은 **"대화 페이지에서 북마크 클릭"** 한 번. 나머지는 자동.

## 4. 컴포넌트 구조

경계는 "무엇을 아는가"로 긋는다. `adapters`는 서비스 지식을, `core/session-writer`는 CC 세션 지식을
각각 가둔다. 둘은 서로를 모른다.

```
web-chat-downloader/               (~/Desktop/Projects/web-chat-downloader)
  src/
    adapters/
      types.ts        # NormalizedChat 등 공통형
      claude.ts       # detect(raw) + normalize(raw) → NormalizedChat
      chatgpt.ts      #   (mapping 트리 역추적)
      gemini.ts       #   (batchexecute 파싱)
    core/
      session-writer.ts  # NormalizedChat + cwd → CC 실물 골격 .jsonl
      slug.ts            # cwd → slug
      blobstore.ts       # 첨부 base64 → content-addressed 저장
      claude-version.ts  # `claude --version` 캐시, 실패 시 '0.0.0'
      index-store.ts     # externalId → sessionId 중복 방지 인덱스
    server.ts          # localhost 수신 → 서비스 감지 → 어댑터 라우팅 → writer
    cli.ts             # 진입점: `web-chat-downloader serve`
  bookmarklets/
    claude.js / chatgpt.js / gemini.js
  docs/superpowers/specs/2026-07-20-web-chat-downloader-design.md
```

**유닛별 한 줄 정의**
- adapter: 서비스 원본 → 공통형(서비스 지식 격리)
- session-writer: 공통형 → CC 실물 `.jsonl`(§6 스펙 재현)
- blobstore: 첨부 저장(내용 해시 = 중복 제거)
- index-store: externalId 매핑으로 재캡처를 갱신으로
- server/cli: HTTP 배선과 사용자 진입점
- bookmarklet: 브라우저 캡처(서비스별 API만 다름)

## 5. 데이터 모델 — 공통형

모든 어댑터의 출력 = writer의 입력.

```ts
type NormalizedChat = {
  service: 'claude' | 'chatgpt' | 'gemini'
  externalId: string            // 중복 방지 키(대화의 서비스 고유 ID)
  title: string
  messages: {
    role: 'user' | 'assistant'  // user는 user, 그 외 전부 assistant(orca 규칙)
    text: string                // text 블록만; tool/thinking은 버림
    ts?: number                 // epoch ms
    attachments?: {
      filename: string
      mediaType: string         // e.g. 'image/png', 'application/pdf'
      data: string              // base64
    }[]
  }[]
}
```

## 6. Claude Code 세션 포맷 스펙 (실측 기반) ★

실제 세션 60개(user 10,203줄 / assistant 16,664줄) 교차 대조로 도출. `[필수]`는 100% 출현.

### 6.1 user 레코드

```jsonc
{
  "parentUuid":   <직전 레코드 uuid | null(첫 줄)>,   // [필수]
  "isSidechain":  false,                              // [필수]
  "type":         "user",                             // [필수]
  "message":      { "role": "user", "content": <문자열 또는 블록배열> }, // [필수]
  "uuid":         <이 레코드 uuid>,                    // [필수]
  "timestamp":    <ISO8601>,                          // [필수]
  "userType":     "external",                         // [필수] 실측 확정
  "entrypoint":   "cli",                              // [필수] 실측 확정
  "cwd":          <저장 폴더 절대경로>,                // [필수]
  "sessionId":    <파일명 stem과 동일>,               // [필수]
  "version":      <`claude --version` 실측>,          // [필수]
  "gitBranch":    "HEAD",                             // [필수] git 아닌 폴더도 'HEAD'(실측)
  "promptId":     <생성>,                             // 99% — 재현
  "slug":         <slug(cwd)>                         // 85% — 재현(레코드 내 slug 필드)
}
```

- 이미지가 있으면 `message.content`는 블록 배열:
  `[{ "type":"text", "text":... }, { "type":"image", "source":{ "type":"base64", "media_type":..., "data":... } }]`
- 이미지가 없으면 `content`는 평문 문자열도 허용(실측상 둘 다 존재).
- tool 관련 필드(`toolUseResult`, `sourceToolAssistantUUID` 등 82%)는 웹 대화에 tool이 없으므로
  해당 없음 → 생략(야매 아님, 구조적으로 부재가 정상).

### 6.2 assistant 레코드

```jsonc
{
  "parentUuid":  <직전 uuid>,                         // [필수]
  "isSidechain": false,                               // [필수]
  "type":        "assistant",                         // [필수]
  "message": {
    "model":         "claude-opus-4-8",               // [필수] (캡처 당시 알 수 없으면 상수)
    "id":            "msg_<생성>",                     // [필수]
    "type":          "message",                       // [필수]
    "role":          "assistant",                     // [필수]
    "content":       [{ "type":"text", "text":... }], // [필수] 배열
    "stop_reason":   "end_turn",                      // [필수]
    "stop_sequence": null,                            // [필수]
    "usage": { "input_tokens":0, "output_tokens":0,   // [필수] — 0값(정직: 우리가 생성 안 함)
               "cache_creation_input_tokens":0, "cache_read_input_tokens":0 }
  },
  "uuid":       <uuid>,                               // [필수]
  "timestamp":  <ISO8601>,                            // [필수]
  "userType":   "external",                           // [필수]
  "entrypoint": "cli",                                // [필수]
  "cwd":        <저장 폴더 절대경로>,                  // [필수]
  "sessionId":  <파일명 stem>,                        // [필수]
  "version":    <실측>,                               // [필수]
  "gitBranch":  "HEAD",                               // [필수]
  "requestId":  "req_<생성>",                          // 99% — 재현
  "slug":       <slug(cwd)>                           // 83% — 재현
}
```

- **생략하는 가변 필드(CC 범위 안)**: `stop_details`(55%), `diagnostics`(53%),
  `attribution*`(6%), `container`/`context_management`(0%). 이들은 항상 있지 않으므로 미포함이 정상.
- `usage`의 나머지 하위필드(`service_tier`, `speed`, `inference_geo` 등)는 런타임 계측값 →
  대응물 없음 → 핵심 4개만 0으로.

### 6.3 체인·첫 줄

- 레코드는 `parentUuid`로 선형 체인: 첫 줄 `null` → 이후 직전 `uuid`.
- **첫 줄은 summary가 아니다(실측).** 실제 첫 줄은 `queue-operation`/`file-history-snapshot` 등
  런타임 산물이며 세션마다 다르다. 이것들은 재현 불필요 → **우리는 user 줄부터 시작**(orca도 동일, resume 성립).
- 파일은 각 줄 `JSON.stringify` + `\n` join, 끝에 개행 하나.

## 7. slug 인코딩

```ts
slug = cwd.replace(/[^A-Za-z0-9]/g, '-')   // 영숫자 아닌 모든 문자를 '-' 하나로
```

- 실측 검증: 28폴더 중 27개 일치(불일치 1개는 본 작업에서 의도적으로 옮긴 폴더). 규칙 정확도 사실상 100%.
- 저장 폴더 `/Users/macbook/Desktop/Archive/web-chats`
  → slug `-Users-macbook-Desktop-Archive-web-chats`
  → 파일 `~/.claude/projects/-Users-macbook-Desktop-Archive-web-chats/<uuid>.jsonl`
- **실증 게이트에서 최종 확인**: 실제 CC를 이 폴더에서 돌려 만들어지는 디렉토리명과 대조.

## 8. 저장 위치 · 중복 방지

- **cwd(저장 폴더)**: `/Users/macbook/Desktop/Archive/web-chats` (없으면 생성).
- **중복 방지 인덱스**: `~/Desktop/Archive/web-chats/.wcd-index.json`
  `{ <externalId>: { sessionId, service, title, capturedAt } }`
- 재캡처 시 externalId 조회 → 있으면 **같은 sessionId 파일 덮어쓰기(웹 최신본 반영)**, 없으면 새 세션.
- 방향 가정: **웹이 원본**. 로컬(`claude --resume`)에서 이어간 뒤 웹 재캡처 시 로컬 진행분이 덮인다(한계, §12).

## 9. 첨부 처리

- **이미지**: CC 실물대로 `message.content`에 `{type:'image', source:{type:'base64', media_type, data}}`로
  **임베드**(resume 시 Claude가 실제로 봄) + 원본을 blobstore에도 보관.
- **비이미지 파일**(PDF·코드 등): `attachments/`에 다운로드 저장 + 텍스트에 마커
  `[첨부: <filename> → attachments/<hash>.<ext>]`. (CC의 비이미지 표현은 미확인 → 마커로 처리, §13)
- **blobstore**: 내용 SHA로 파일명 → `attachments/<hash>.<ext>`. 동일 파일 중복 저장 없음.
- 캡처(북마클릿)가 로그인 세션으로 이미지·파일을 fetch해 base64로 POST에 실어 보낸다.

## 10. 에러 · 엣지 처리

- 빈 턴 스킵, 유효 턴 0개면 거부.
- `ts` 없으면 현재 시각. `claude --version` 실패 시 `version='0.0.0'`.
- 서비스 감지 실패 → 명확한 에러. `web-chats` 없으면 `mkdir -p`.
- 캡처 POST 페이로드 크기 상한/청크(대용량 이미지) 고려.

## 11. 테스팅

- **session-writer 단위테스트**: 만든 레코드가 §6 필수 필드셋을 정확히 갖는지(필드 존재·값·체인) 검증.
- **어댑터 테스트**: 서비스별 실제 응답 픽스처 → NormalizedChat 정규화 결과 대조.
- **slug 테스트**: 경로(공백·한글·기호) → 인코딩 스냅샷.
- **resume 실증 게이트(통합)**: §2-2. 우리 세션을 `claude --resume`으로 실제 이어받기 확인. 이게 최종 관문.

## 12. 범위 밖 (비목표)

- tool_use / tool_result / thinking 블록 재현(텍스트 + 이미지만 이어감).
- 로컬↔웹 양방향 병합.
- SSH/원격 cwd(로컬 `~/.claude`에 쓰므로 원격 claude가 못 봄).
- 완전 무클릭 자동 캡처(상주 확장) — v2. 변환 코어는 그대로 재사용 가능.

## 13. 리스크 · 미해결

- **CC 포맷 버전 변경**: 공식적으로 "JSONL은 내부 포맷"이라 릴리스마다 바뀔 수 있음.
  완화 = version 실측 주입 + resume 실증 게이트를 CI/수동 회귀로 상시 유지.
- **`gitBranch:'HEAD'`의 일반성**: git 아닌 Desktop 세션에서 'HEAD' 실측했으나,
  `web-chats`에서의 실제 값은 실증 게이트에서 최종 확인.
- **비이미지 파일의 CC 표현 미확인**: 현재 마커로 처리. 실제 CC가 문서를 세션에 넣는 방식을 확보하면 개선.
- **재캡처 덮어쓰기와 로컬 진행분 충돌**(§8): 웹 원본 가정으로 수용.
