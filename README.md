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

Chrome 확장 프로그램(`extension/`)이 위 그림의 "확장 아이콘 클릭"부터
"Native Messaging"까지를 맡는다. 서비스별 fetch·페이지 감지만 확장에 있고,
감지·정규화·파일 기록 로직은 전부 `src/`(코어) 쪽이다 — 확장은 그 코어를
호출하는 얇은 껍데기다.

## 컴포넌트

```
src/
  adapters/        # 서비스별 원본 → 공통형(NormalizedChat) 변환. 서비스 지식은 여기만 안다.
  core/
    session-writer.ts  # 공통형 → Claude Code 실물 .jsonl
    index-store.ts     # externalId → sessionId 중복 방지(재캡처 = 갱신), index 조회
    blobstore.ts       # 첨부 원본 저장(내용 해시로 중복 제거)
  capture.ts        # handleCapture: 감지 → 정규화 → 세션 기록 → 인덱스 갱신(검증된 파이프라인)
  native-host.ts     # Chrome Native Messaging 프레이밍 + 메시지 루프(stdin/stdout). ping/capture/index
  install-host.ts    # 매니페스트·런처 스크립트 설치
  cli.ts              # 진입점: host / install-host <extensionId>
extension/
  manifest.json / background.js / content.js / popup.html·css·js  # Chrome 확장 프로그램 본체
```

## 설치

```bash
npm install
npm run build
node dist/cli.js install-host           # extensionId 생략 시 자동 탐지
node dist/cli.js install-host <extensionId>  # 필요하면 직접 지정
```

- `<extensionId>`는 생략할 수 있다 — Chrome의 프로필별 `Preferences`에서
  `extension/` 폴더를 가리키는 압축해제 확장을 자동으로 찾는다. 여러 Chrome
  프로필에 걸쳐 검색하고, 못 찾으면 뭘 확인해야 하는지 안내 메시지를 띄운다.
  자동 탐지가 여러 개의 ID를 찾으면(여러 프로필에 각각 로드해둔 경우 등)
  전부 `allowed_origins`에 등록한다.
- 직접 지정하려면 확장 프로그램을 `chrome://extensions`에 "압축해제된 확장
  프로그램을 로드"로 올렸을 때 그 페이지에 표시되는 32자 ID를 인자로 넘기면
  된다. 확장 프로그램 로드 방법은 [`extension/README.md`](extension/README.md)
  참고.
- 설치 명령은 두 파일을 쓴다.
  - 런처: `~/.web-chat-downloader/host.sh` (실행 권한 755, 빌드된 `dist/cli.js host`를
    절대 경로로 실행)
  - 매니페스트: `~/Library/Application Support/Google/Chrome/NativeMessagingHosts/com.web_chat_downloader.host.json`
    (`allowed_origins`에 위 extensionId를 등록)
- **먼저 `npm run build`를 실행해 `dist/cli.js`를 만들어둬야 한다** — 런처는 그 파일을 그대로 가리킨다.
- 확장 프로그램을 다시 설치해서 ID가 바뀌면 `install-host`를 인자 없이(또는 새 ID로) 다시 실행하면 된다(덮어씀).

## 사용 흐름

1. 위 설치를 마친다.
2. `chrome://extensions`에서 개발자 모드로 `extension/` 폴더를 로드한다
   (자세한 순서는 [`extension/README.md`](extension/README.md)).
3. 캡처하려는 서비스(claude.ai · chatgpt.com · gemini.google.com)의 대화
   페이지에서 확장 아이콘을 클릭한다. 팝업에서 지금 대화만 가져오거나,
   대화 목록을 전체/선택 동기화할 수 있다.
4. Chrome이 필요 시 `host.sh`를 실행해 대화를 Native Messaging으로 전달하고,
   이 CLI가 감지 → 정규화 → 세션 파일 기록까지 처리한다.
5. 저장 위치(`~/Desktop/Archive/web-chats`, 없으면 자동 생성)에서:
   ```bash
   claude --resume <sessionId>
   ```
   팝업에서 이미 저장된 대화를 클릭하면 이 명령이 클립보드로 복사된다.

저장 위치는 환경변수 `WCD_CWD`로 바꿀 수 있다.

## 서비스 지원 현황

어댑터(`src/adapters/*`)는 claude.ai · ChatGPT · Gemini 세 서비스 모두 감지·정규화
로직과 단위 테스트를 갖추고 있고, 이제 `extension/content.js`가 그 로직이 기대하는
형태의 원본(raw) payload를 세 서비스 모두에서 만들어 호스트로 넘긴다. 다만
Gemini의 batchexecute 토큰 추출·페이지네이션처럼 실제 응답 형식에 의존하는
부분은 사용자가 브라우저에서 직접 라이브로 재검증한 API 동작을 옮긴 것이고,
이번 확장 프로그램 코드 자체는 아직 라이브 브라우저에서 end-to-end로 실행해
보진 않았다 — 처음 써볼 때 서비스별로 한 번씩 확인 필요.

## 개발

```bash
npm test          # vitest
npx tsc --noEmit  # 타입 체크
```

`host` 명령은 Chrome이 stdio로 직접 실행하는 걸 전제로 하므로, 손으로 확인하려면
Native Messaging 프레이밍(4바이트 little-endian uint32 길이 + UTF-8 JSON)에 맞춰
직접 바이트를 stdin에 넣어야 한다. `src/native-host.ts`의 `encodeMessage`/`decodeMessages`가
그 프레이밍을 구현·테스트한다(`tests/native-host.test.ts`).
