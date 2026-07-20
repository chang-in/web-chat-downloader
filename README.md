# web-chat-downloader

claude.ai · ChatGPT · Gemini의 웹 대화를 로컬 Claude Code 세션 파일(`.jsonl`)로
변환해서 `claude --resume`으로 터미널에서 이어갈 수 있게 해준다.

## 구조 — Chrome 확장 + Native Messaging 호스트

브라우저 확장 프로그램은 로그인된 세션으로 대화 데이터를 읽을 수 있지만
파일을 쓸 순 없다. 파일을 쓰는 건 로컬 프로세스 몫이다. 다만 그 프로세스를
**상시 띄워둘 필요는 없다** — Chrome Native Messaging을 쓰면 Chrome이 필요할 때만
이 CLI를 stdio 프로세스로 실행해서, 캡처한 페이로드를 stdin/stdout으로 주고받고
끝나면 종료한다.

```
[대화 페이지] --확장 아이콘 클릭--> 로그인 세션으로 대화 API fetch
   --Native Messaging(stdio)--> web-chat-downloader host (Chrome이 필요시 실행)
   --서비스 감지--> normalize() --> CC 세션 합성 --> writeSession()
   --> ~/.claude/projects/<slug>/<uuid>.jsonl
```

상시 서버, 자체서명 인증서, mixed-content/CORS 문제가 전부 사라진다.

**이 저장소는 CLI(host) 쪽까지만 다룬다.** Chrome 확장 프로그램 자체는 별도
작업으로 이어진다.

## 컴포넌트

```
src/
  adapters/        # 서비스별 원본 → 공통형(NormalizedChat) 변환. 서비스 지식은 여기만 안다.
  core/
    session-writer.ts  # 공통형 → Claude Code 실물 .jsonl
    index-store.ts     # externalId → sessionId 중복 방지(재캡처 = 갱신)
    blobstore.ts       # 첨부 원본 저장(내용 해시로 중복 제거)
  capture.ts        # handleCapture: 감지 → 정규화 → 세션 기록 → 인덱스 갱신(검증된 파이프라인)
  native-host.ts     # Chrome Native Messaging 프레이밍 + 메시지 루프(stdin/stdout)
  install-host.ts    # 매니페스트·런처 스크립트 설치
  cli.ts              # 진입점: host / install-host <extensionId>
```

## 설치

```bash
npm install
npm run build
node dist/cli.js install-host <extensionId>
```

- `<extensionId>`는 확장 프로그램을 `chrome://extensions`에 "압축해제된 확장 프로그램을
  로드"로 올렸을 때 그 페이지에 표시되는 32자 ID다.
- 설치 명령은 두 파일을 쓴다.
  - 런처: `~/.web-chat-downloader/host.sh` (실행 권한 755, 빌드된 `dist/cli.js host`를
    절대 경로로 실행)
  - 매니페스트: `~/Library/Application Support/Google/Chrome/NativeMessagingHosts/com.web_chat_downloader.host.json`
    (`allowed_origins`에 위 extensionId를 등록)
- **먼저 `npm run build`를 실행해 `dist/cli.js`를 만들어둬야 한다** — 런처는 그 파일을 그대로 가리킨다.
- 확장 프로그램을 다시 설치해서 ID가 바뀌면 `install-host`를 그 새 ID로 다시 실행하면 된다(덮어씀).

## 사용 흐름

1. 위 설치를 마친다.
2. `chrome://extensions`에서 확장 프로그램을 로드한다(별도 작업 산출물).
3. 캡처하려는 서비스의 대화 페이지에서 확장 아이콘을 클릭한다.
4. Chrome이 필요 시 `host.sh`를 실행해 대화를 Native Messaging으로 전달하고,
   이 CLI가 감지 → 정규화 → 세션 파일 기록까지 처리한다.
5. 저장 위치(`~/Desktop/Archive/web-chats`, 없으면 자동 생성)에서:
   ```bash
   claude --resume <sessionId>
   ```

저장 위치는 환경변수 `WCD_CWD`로 바꿀 수 있다.

## 서비스 지원 현황

어댑터(`src/adapters/*`)는 claude.ai · ChatGPT · Gemini 세 서비스 모두 감지·정규화
로직과 단위 테스트를 갖추고 있다. 다만 이 로직을 실제로 호출하는 확장 프로그램이
아직 없어서, 브라우저에서 캡처 → 저장까지 라이브로 검증된 서비스는 별도로
확인이 필요하다(확장 프로그램 작업에서 갱신).

## 개발

```bash
npm test          # vitest
npx tsc --noEmit  # 타입 체크
```

`host` 명령은 Chrome이 stdio로 직접 실행하는 걸 전제로 하므로, 손으로 확인하려면
Native Messaging 프레이밍(4바이트 little-endian uint32 길이 + UTF-8 JSON)에 맞춰
직접 바이트를 stdin에 넣어야 한다. `src/native-host.ts`의 `encodeMessage`/`decodeMessages`가
그 프레이밍을 구현·테스트한다(`tests/native-host.test.ts`).
