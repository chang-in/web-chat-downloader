# web-chat-downloader — Chrome 확장 프로그램

claude.ai · ChatGPT · Gemini 대화 페이지에서 로그인된 세션으로 대화를 읽어서
Native Messaging으로 로컬 CLI(호스트)에 넘기는 얇은 확장 프로그램이다. 파일을
쓰는 로직·서비스별 파싱은 전부 `../src`(코어)에 있고, 이 확장은 그걸 브라우저
쪽에서 호출만 한다.

빌드 스텝이 없는 순수 JS다 — `extension/` 폴더를 그대로 "압축해제된 확장
프로그램"으로 로드하면 된다.

## 설치

1. **호스트(CLI)를 빌드한다** — 저장소 루트에서:
   ```bash
   npm install
   npm run build
   ```
2. **확장 프로그램을 로드한다**:
   - Chrome에서 `chrome://extensions` 접속
   - 우측 상단 "개발자 모드" 켜기
   - "압축해제된 확장 프로그램 로드" 클릭 → 이 저장소의 `extension/` 폴더 선택
   - 로드된 카드에 표시되는 32자 확장 프로그램 ID를 복사해 둔다
3. **Native Messaging 호스트를 설치한다** — 저장소 루트에서, 2번에서 복사한 ID로:
   ```bash
   node dist/cli.js install-host <extensionId>
   ```
   매니페스트(`~/Library/Application Support/Google/Chrome/NativeMessagingHosts/com.web_chat_downloader.host.json`)와
   런처(`~/.web-chat-downloader/host.sh`)가 이 확장 프로그램 ID만 허용하도록 설치된다.
4. claude.ai · chatgpt.com · gemini.google.com의 대화 페이지를 열고 툴바의
   확장 아이콘을 클릭한다.

**상시 띄워둘 서버가 없다.** Chrome이 필요할 때(호스트에 메시지를 보낼 때)만
`host.sh`를 stdio 자식 프로세스로 실행하고 응답 후 끝나면 정리한다. 확장 프로그램
설치와 별개로 터미널에서 뭔가 실행해 둘 필요가 없다.

## 사용법

- 팝업 상단에 현재 페이지가 어느 서비스로 인식됐는지, 호스트(Native Messaging)
  연결 상태가 뜬다.
- **이 대화 가져오기**: 지금 열려 있는 대화 하나만 저장.
- **전체 동기화**: 목록에 뜬 대화를 전부 순서대로 저장(이미 저장된 것도 재캡처해서
  최신 내용으로 갱신 — 같은 세션 파일에 덮어쓴다).
- 체크박스로 몇 개 골라서 **선택 가져오기**로 그것만 저장할 수도 있다.
- 이미 저장된 대화는 목록에 ✓ 표시가 붙고, 그 아래 `claude --resume <sessionId>`
  명령이 나온다 — 클릭하면 클립보드로 복사된다.

## 확장 프로그램 ID가 바뀌면

`chrome://extensions`에서 확장 프로그램을 지웠다 다시 로드하면 ID가 바뀐다.
그 경우 3번(`install-host <새 ID>`)만 다시 실행하면 된다(매니페스트를 덮어씀).

## 구조

```
extension/
  manifest.json   # MV3. host_permissions=4개 서비스 도메인, permissions=nativeMessaging·activeTab·scripting·tabs·clipboardWrite
  background.js   # 서비스 워커 — Native Messaging 포트 소유, {to:'host', msg} 요청을 중계
  content.js      # 대화 페이지에 주입 — 서비스 감지·목록 조회·대화 payload 조회(전부 로그인 세션의 fetch)
  popup.html/css  # UI(디자인 완료본)
  popup.js        # 위 세 파일을 엮어서 팝업 동작을 구현
  icons/          # 툴바 아이콘
```
