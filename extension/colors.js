// colors.js — 서비스별 액센트 색상의 단일 출처(JS 쪽).
// background.js가 뱃지 색을 고를 때 여기 팔레트를 쓴다.
//
// popup.css는 번들러 없이 raw CSS 파일을 그대로 로드하므로 이 값을 JS에서 CSS 변수로
// 주입하지 않는다(그러려면 popup.js가 관여해야 하는데, 이 파일은 다른 작업자가 같은 시점에
// 손대고 있어 건드릴 수 없다) — 그래서 popup.css의 [data-service="..."] 규칙에 같은 값을
// 별도로 유지한다. 이 팔레트를 고치면 반드시 popup.css의 아래 블록도 같이 고칠 것:
//   [data-service="claude"]{ --accent:...; }
//   [data-service="chatgpt"]{ --accent:...; }
//   [data-service="gemini"]{ --accent:...; }

const WCD_SERVICE_COLORS = {
  claude: '#C4633F',
  chatgpt: '#0E8C6D',
  gemini: '#3B6FD4',
}
