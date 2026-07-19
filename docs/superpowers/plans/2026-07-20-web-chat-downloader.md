# web-chat-downloader Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** claude.ai·ChatGPT·Gemini 웹 대화를 실제 Claude Code 세션 포맷(`.jsonl`)으로 변환해 `claude --resume`으로 이어가게 하는 CLI.

**Architecture:** 캡처(브라우저 북마클릿 → `localhost` POST)와 변환(Node CLI: 정규화 → CC 세션 합성 → 파일 쓰기)을 2단 분리. 변환 코어는 3서비스 공통, 캡처·정규화만 서비스별.

**Tech Stack:** TypeScript, Node.js(≥20), vitest(테스트). 런타임 의존성 최소화 — 세션 쓰기/서버/해시/UUID는 Node 표준(`fs`·`http`·`crypto`·`child_process`)만 사용.

## Global Constraints

모든 태스크의 요구사항에 아래가 암묵적으로 포함된다.

- **포맷 기준**: 산출 `.jsonl`은 실제 CC 세션과 동일해야 한다. 필수 필드셋은 설계 §6 실측 스펙을 그대로 따른다. 추측 필드 금지.
- **확정 상수(실측)**: `gitBranch:'HEAD'`, `entrypoint:'cli'`, `userType:'external'`, `isSidechain:false`, `stop_reason:'end_turn'`, `stop_sequence:null`, `message.type:'message'`(assistant).
- **usage**: 핵심 4필드만 `0` — `{input_tokens:0, output_tokens:0, cache_creation_input_tokens:0, cache_read_input_tokens:0}`.
- **slug 규칙**: `cwd.replace(/[^A-Za-z0-9]/g, '-')`.
- **저장 위치(cwd)**: `~/Desktop/Archive/web-chats`. 세션 파일: `~/.claude/projects/<slug>/<sessionId>.jsonl`.
- **내용 범위**: 텍스트 + 이미지(base64 임베드)만. tool_use/tool_result/thinking은 버린다. 비이미지 파일은 `attachments/` 저장 + 텍스트 마커.
- **에러 처리**: 실제 실패 경계(외부 입력 파싱, 파일 IO, subprocess, base64 디코딩)에만 구체적 처리. 각 실패는 명확한 메시지 + 안전한 거부/폴백. 순수 함수엔 방어 코드 금지.
- **완성 정의**: Task 5의 resume 실증 게이트 통과.
- **커밋**: 각 태스크 끝에 커밋. 메시지 형식 `<type>: <설명>`, 본문 한국어, AI attribution 금지.

## File Structure

```
web-chat-downloader/
  package.json                    # 프로젝트 메타 + 스크립트
  tsconfig.json                   # TS 설정
  vitest.config.ts                # 테스트 설정
  src/
    adapters/
      types.ts                    # NormalizedChat/Message/Attachment 타입 + Adapter 인터페이스
      claude.ts                   # claude.ai 감지·정규화
      chatgpt.ts                  # ChatGPT 감지·정규화
      gemini.ts                   # Gemini 감지·정규화
      registry.ts                 # 어댑터 목록 + detect 라우팅
    core/
      slug.ts                     # cwd → slug
      claude-version.ts           # `claude --version` 캐시
      blobstore.ts                # 첨부 content-addressed 저장
      index-store.ts              # externalId → sessionId 중복 방지
      session-writer.ts           # NormalizedChat + cwd → .jsonl
    server.ts                     # localhost 수신 → detect → writer
    cli.ts                        # 진입점: serve
  tests/
    ...(각 소스별 테스트)
  bookmarklets/
    claude.js / chatgpt.js / gemini.js
```

각 파일은 단일 책임. 서비스 지식은 `adapters/`에, CC 세션 지식은 `core/session-writer.ts`에 갇힌다.

---

### Task 1: 프로젝트 셋업

**Files:**
- Create: `package.json`, `tsconfig.json`, `vitest.config.ts`, `src/.gitkeep`

**Interfaces:**
- Produces: `npm test`(vitest) / `npm run build`(tsc) 스크립트, `tsx` 실행 환경.

- [ ] **Step 1: package.json 작성**

```json
{
  "name": "web-chat-downloader",
  "version": "0.1.0",
  "type": "module",
  "bin": { "web-chat-downloader": "dist/cli.js" },
  "scripts": {
    "build": "tsc",
    "test": "vitest run",
    "dev": "tsx src/cli.ts"
  },
  "devDependencies": {
    "typescript": "^5.5.0",
    "vitest": "^2.0.0",
    "tsx": "^4.16.0",
    "@types/node": "^20.14.0"
  }
}
```

- [ ] **Step 2: tsconfig.json 작성**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "outDir": "dist",
    "rootDir": "src",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "declaration": false
  },
  "include": ["src"]
}
```

- [ ] **Step 3: vitest.config.ts 작성**

```ts
import { defineConfig } from 'vitest/config'
export default defineConfig({ test: { environment: 'node', include: ['tests/**/*.test.ts'] } })
```

- [ ] **Step 4: 설치 및 확인**

Run: `npm install && npx tsc --noEmit`
Expected: 에러 없이 완료.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "chore: 프로젝트 셋업(TS·vitest·tsx)"
```

---

### Task 2: slug 인코딩

**Files:**
- Create: `src/core/slug.ts`
- Test: `tests/core/slug.test.ts`

**Interfaces:**
- Produces: `slug(cwd: string): string`

- [ ] **Step 1: 실패 테스트 작성** — `tests/core/slug.test.ts`

```ts
import { describe, it, expect } from 'vitest'
import { slug } from '../../src/core/slug'

describe('slug', () => {
  it('영숫자 아닌 문자를 각각 -로 치환', () => {
    expect(slug('/Users/x/a.b/c')).toBe('-Users-x-a-b-c')
  })
  it('공백·한글도 문자당 -', () => {
    expect(slug('/Users/x/AI 봇')).toBe('-Users-x-AI---') // 공백1 + 한글2 = ---
  })
  it('저장 폴더 경로', () => {
    expect(slug('/Users/macbook/Desktop/Archive/web-chats'))
      .toBe('-Users-macbook-Desktop-Archive-web-chats')
  })
})
```

- [ ] **Step 2: 실패 확인**

Run: `npx vitest run tests/core/slug.test.ts`
Expected: FAIL — `slug` not found.

- [ ] **Step 3: 구현** — `src/core/slug.ts`

```ts
export function slug(cwd: string): string {
  return cwd.replace(/[^A-Za-z0-9]/g, '-')
}
```

- [ ] **Step 4: 통과 확인**

Run: `npx vitest run tests/core/slug.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add src/core/slug.ts tests/core/slug.test.ts
git commit -m "feat: slug 인코딩(cwd→디렉토리명)"
```

---

### Task 3: claude 버전 읽기

**Files:**
- Create: `src/core/claude-version.ts`
- Test: `tests/core/claude-version.test.ts`

**Interfaces:**
- Produces: `readClaudeVersion(): string` — `claude --version`의 첫 토큰, 실패 시 `'0.0.0'`, 모듈 캐시.

- [ ] **Step 1: 실패 테스트 작성** — `tests/core/claude-version.test.ts`

```ts
import { describe, it, expect } from 'vitest'
import { parseVersion } from '../../src/core/claude-version'

describe('parseVersion', () => {
  it('"2.1.207 (Claude Code)" → "2.1.207"', () => {
    expect(parseVersion('2.1.207 (Claude Code)\n')).toBe('2.1.207')
  })
  it('빈/이상 입력 → 0.0.0', () => {
    expect(parseVersion('')).toBe('0.0.0')
  })
})
```

- [ ] **Step 2: 실패 확인**

Run: `npx vitest run tests/core/claude-version.test.ts`
Expected: FAIL.

- [ ] **Step 3: 구현** — `src/core/claude-version.ts`

```ts
import { execFileSync } from 'child_process'

export function parseVersion(raw: string): string {
  return raw.trim().split(/\s+/)[0] || '0.0.0'
}

let cached: string | null = null
export function readClaudeVersion(): string {
  if (cached) return cached
  try {
    cached = parseVersion(execFileSync('claude', ['--version'], { encoding: 'utf-8', timeout: 5000 }))
  } catch {
    cached = '0.0.0'
  }
  return cached
}
```

- [ ] **Step 4: 통과 확인**

Run: `npx vitest run tests/core/claude-version.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/core/claude-version.ts tests/core/claude-version.test.ts
git commit -m "feat: claude --version 파싱·캐시(실패시 0.0.0)"
```

---

### Task 4: 공통형 타입 + session-writer (텍스트)

**Files:**
- Create: `src/adapters/types.ts`, `src/core/session-writer.ts`
- Test: `tests/core/session-writer.test.ts`

**Interfaces:**
- Produces:
  - `type NormalizedAttachment = { filename: string; mediaType: string; data: string }`
  - `type NormalizedMessage = { role: 'user'|'assistant'; text: string; ts?: number; attachments?: NormalizedAttachment[] }`
  - `type NormalizedChat = { service: 'claude'|'chatgpt'|'gemini'; externalId: string; title: string; messages: NormalizedMessage[] }`
  - `writeSession(chat: NormalizedChat, opts: { cwd: string; sessionId?: string; dirOverride?: string }): { sessionId: string } | { error: string }`
- Consumes: `slug`(Task 2), `readClaudeVersion`(Task 3).

- [ ] **Step 1: 타입 정의** — `src/adapters/types.ts`

```ts
export type NormalizedAttachment = { filename: string; mediaType: string; data: string /* base64 */ }
export type NormalizedMessage = {
  role: 'user' | 'assistant'
  text: string
  ts?: number // epoch ms
  attachments?: NormalizedAttachment[]
}
export type NormalizedChat = {
  service: 'claude' | 'chatgpt' | 'gemini'
  externalId: string
  title: string
  messages: NormalizedMessage[]
}
```

- [ ] **Step 2: 실패 테스트 작성** — `tests/core/session-writer.test.ts`

```ts
import { describe, it, expect } from 'vitest'
import { mkdtempSync, readFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { writeSession } from '../../src/core/session-writer'
import type { NormalizedChat } from '../../src/adapters/types'

const chat: NormalizedChat = {
  service: 'claude', externalId: 'ext-1', title: 't',
  messages: [
    { role: 'user', text: '2+2?', ts: 1000 },
    { role: 'assistant', text: '4', ts: 2000 },
  ],
}

describe('writeSession', () => {
  it('필수 필드셋을 갖춘 user/assistant 2줄 생성', () => {
    const dir = mkdtempSync(join(tmpdir(), 'wcd-'))
    const r = writeSession(chat, { cwd: '/tmp/wt', dirOverride: dir })
    expect('sessionId' in r).toBe(true)
    const sid = (r as any).sessionId
    const lines = readFileSync(join(dir, `${sid}.jsonl`), 'utf-8').trim().split('\n').map(l => JSON.parse(l))
    expect(lines).toHaveLength(2)
    const [u, a] = lines
    // 필수 필드(실측 §6)
    for (const f of ['parentUuid','isSidechain','type','message','uuid','timestamp','userType','entrypoint','cwd','sessionId','version','gitBranch']) {
      expect(u).toHaveProperty(f); expect(a).toHaveProperty(f)
    }
    expect(u.type).toBe('user'); expect(a.type).toBe('assistant')
    expect(u.parentUuid).toBeNull()          // 첫 줄 체인 시작
    expect(a.parentUuid).toBe(u.uuid)        // 선형 체인
    expect(u.gitBranch).toBe('HEAD')
    expect(u.userType).toBe('external'); expect(u.entrypoint).toBe('cli')
    expect(u.sessionId).toBe(sid); expect(a.sessionId).toBe(sid)
    // assistant.message 스펙
    for (const f of ['model','id','type','role','content','stop_reason','stop_sequence','usage']) {
      expect(a.message).toHaveProperty(f)
    }
    expect(a.message.content).toEqual([{ type: 'text', text: '4' }])
    expect(a.message.usage.input_tokens).toBe(0)
    expect(u.message).toEqual({ role: 'user', content: '2+2?' })
  })

  it('빈 대화는 error 반환', () => {
    const r = writeSession({ ...chat, messages: [] }, { cwd: '/tmp/wt', dirOverride: mkdtempSync(join(tmpdir(),'wcd-')) })
    expect('error' in r).toBe(true)
  })
})
```

- [ ] **Step 3: 실패 확인**

Run: `npx vitest run tests/core/session-writer.test.ts`
Expected: FAIL — `writeSession` not found.

- [ ] **Step 4: 구현** — `src/core/session-writer.ts`

```ts
import { randomUUID } from 'crypto'
import { mkdirSync, writeFileSync } from 'fs'
import { homedir } from 'os'
import { join } from 'path'
import { slug } from './slug'
import { readClaudeVersion } from './claude-version'
import type { NormalizedChat, NormalizedMessage } from '../adapters/types'

const msgId = () => `msg_${randomUUID().replace(/-/g, '')}`
const reqId = () => `req_${randomUUID().replace(/-/g, '')}`

function isoTs(ms?: number): string {
  const d = ms != null ? new Date(ms) : new Date()
  if (isNaN(d.getTime())) return new Date().toISOString() // 잘못된 ts 방어(RangeError 대신 현재시각)
  return d.toISOString()
}

// Task 7에서 attachments 처리로 확장. Task 4에선 text만.
function userContent(m: NormalizedMessage): string {
  return m.text
}
function assistantContent(m: NormalizedMessage): { type: 'text'; text: string }[] {
  return [{ type: 'text', text: m.text }]
}

export function writeSession(
  chat: NormalizedChat,
  opts: { cwd: string; sessionId?: string; dirOverride?: string },
): { sessionId: string } | { error: string } {
  const turns = chat.messages.filter(m => m.text.trim().length > 0 || (m.attachments?.length ?? 0) > 0)
  if (turns.length === 0) return { error: 'empty conversation' }

  const sessionId = opts.sessionId ?? randomUUID()
  const cwdSlug = slug(opts.cwd)
  const base = {
    cwd: opts.cwd, sessionId, version: readClaudeVersion(), gitBranch: 'HEAD',
    userType: 'external' as const, entrypoint: 'cli' as const, isSidechain: false, slug: cwdSlug,
  }

  const lines: string[] = []
  let parentUuid: string | null = null
  try {
    for (const m of turns) {
      const uuid = randomUUID()
      const timestamp = isoTs(m.ts)
      if (m.role === 'user') {
        lines.push(JSON.stringify({
          parentUuid, uuid, type: 'user', timestamp,
          message: { role: 'user', content: userContent(m) },
          promptId: randomUUID(), ...base,
        }))
      } else {
        lines.push(JSON.stringify({
          parentUuid, uuid, type: 'assistant', timestamp,
          message: {
            model: 'claude-opus-4-8', id: msgId(), type: 'message', role: 'assistant',
            content: assistantContent(m), stop_reason: 'end_turn', stop_sequence: null,
            usage: { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
          },
          requestId: reqId(), ...base,
        }))
      }
      parentUuid = uuid
    }
    const dir = opts.dirOverride ?? join(homedir(), '.claude', 'projects', cwdSlug)
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, `${sessionId}.jsonl`), lines.join('\n') + '\n')
  } catch (e) {
    return { error: `write failed: ${(e as Error).message}` }
  }
  return { sessionId }
}
```

- [ ] **Step 5: 통과 확인 + Commit**

Run: `npx vitest run tests/core/session-writer.test.ts`
Expected: PASS (2 tests).

```bash
git add src/adapters/types.ts src/core/session-writer.ts tests/core/session-writer.test.ts
git commit -m "feat: session-writer(CC 실측 필드셋, 텍스트)"
```

---

### Task 5: resume 실증 게이트 ★

이 태스크는 코드가 아니라 **실제 CC로 검증**하는 관문이다. 실패하면 이후 태스크로 진행 금지 — 여기서 필드셋을 실물과 맞춘다.

**Files:**
- Create: `scripts/verify-resume.md`(수동 검증 절차 기록), `tests/fixtures/reference-session.jsonl`(실제 CC 세션 캡처본)

**Interfaces:**
- Consumes: `writeSession`(Task 4).

- [ ] **Step 1: 실제 레퍼런스 세션 확보**

```bash
mkdir -p ~/Desktop/Archive/web-chats
cd ~/Desktop/Archive/web-chats
# 실제 CC를 이 폴더에서 한 번 돌려 대화 후 종료 → 세션 생성
claude -p "테스트 대화입니다. 짧게 답해주세요." || true
ls ~/.claude/projects/-Users-macbook-Desktop-Archive-web-chats/
```
Expected: `<uuid>.jsonl` 하나 생성. 이 파일이 **정답지**.

- [ ] **Step 2: 레퍼런스 필드 대조**

레퍼런스 세션의 user/assistant 줄 필드와 `writeSession` 산출물의 필드를 대조한다. 특히 확인:
- `gitBranch` 실제 값(이 폴더에서 CC가 넣는 값)이 `'HEAD'`인지 → 다르면 Global Constraints·session-writer 수정.
- `slug` 필드, `promptId`, `requestId`, `usage` 하위필드 존재/형태.
- 첫 줄 타입(우리는 user부터 시작 — 레퍼런스가 앞에 다른 레코드를 요구하는지).

- [ ] **Step 3: 우리 세션으로 실제 resume**

```bash
cd ~/Desktop/Archive/web-chats
# writeSession으로 만든 2턴 세션을 projects 폴더에 배치 후:
claude --resume <생성된-sessionId> -p "방금 답이 뭐였죠?"
```
Expected: 이전 대화(4)를 **인식하고 이어받아** 답한다. 인식 못 하면 Step 2로 돌아가 필드 교정.

- [ ] **Step 4: 검증 결과 기록** — `scripts/verify-resume.md`

레퍼런스 대비 차이, 교정한 필드, 최종 GREEN 여부를 기록. 레퍼런스 세션을 `tests/fixtures/reference-session.jsonl`로 저장(민감정보 제거).

- [ ] **Step 5: Commit**

```bash
git add scripts/verify-resume.md tests/fixtures/reference-session.jsonl src/core/session-writer.ts
git commit -m "test: resume 실증 게이트 통과(레퍼런스 대조·실제 이어받기)"
```

---

### Task 6: blobstore (첨부 저장)

**Files:**
- Create: `src/core/blobstore.ts`
- Test: `tests/core/blobstore.test.ts`

**Interfaces:**
- Produces: `storeBlob(baseDir: string, base64: string, ext: string): { hash: string; relPath: string }` — 내용 SHA-256으로 `attachments/<hash>.<ext>` 저장, 상대경로 반환. 동일 내용 재저장은 no-op.

- [ ] **Step 1: 실패 테스트** — `tests/core/blobstore.test.ts`

```ts
import { describe, it, expect } from 'vitest'
import { mkdtempSync, existsSync, readdirSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { storeBlob } from '../../src/core/blobstore'

describe('storeBlob', () => {
  it('base64를 attachments/<hash>.<ext>로 저장', () => {
    const dir = mkdtempSync(join(tmpdir(), 'wcd-'))
    const b64 = Buffer.from('hello').toString('base64')
    const r = storeBlob(dir, b64, 'png')
    expect(r.relPath).toBe(`attachments/${r.hash}.png`)
    expect(existsSync(join(dir, r.relPath))).toBe(true)
  })
  it('동일 내용은 중복 저장 안 함(같은 hash)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'wcd-'))
    const b64 = Buffer.from('dup').toString('base64')
    const a = storeBlob(dir, b64, 'png'); const b = storeBlob(dir, b64, 'png')
    expect(a.hash).toBe(b.hash)
    expect(readdirSync(join(dir, 'attachments'))).toHaveLength(1)
  })
  it('잘못된 base64는 throw', () => {
    const dir = mkdtempSync(join(tmpdir(), 'wcd-'))
    expect(() => storeBlob(dir, '!!!not-base64!!!', 'png')).toThrow()
  })
})
```

- [ ] **Step 2: 실패 확인**

Run: `npx vitest run tests/core/blobstore.test.ts`
Expected: FAIL.

- [ ] **Step 3: 구현** — `src/core/blobstore.ts`

```ts
import { createHash } from 'crypto'
import { mkdirSync, writeFileSync, existsSync } from 'fs'
import { join } from 'path'

export function storeBlob(baseDir: string, base64: string, ext: string): { hash: string; relPath: string } {
  const buf = Buffer.from(base64, 'base64')
  // base64 왕복 검증(잘못된 입력 거부)
  if (buf.length === 0 || buf.toString('base64').replace(/=+$/,'') !== base64.replace(/=+$/,'')) {
    throw new Error('invalid base64 attachment')
  }
  const hash = createHash('sha256').update(buf).digest('hex').slice(0, 16)
  const relPath = `attachments/${hash}.${ext}`
  const abs = join(baseDir, relPath)
  if (!existsSync(abs)) {
    mkdirSync(join(baseDir, 'attachments'), { recursive: true })
    writeFileSync(abs, buf)
  }
  return { hash, relPath }
}
```

- [ ] **Step 4: 통과 확인 + Commit**

Run: `npx vitest run tests/core/blobstore.test.ts`
Expected: PASS (3 tests).

```bash
git add src/core/blobstore.ts tests/core/blobstore.test.ts
git commit -m "feat: blobstore(content-addressed 첨부 저장)"
```

---

### Task 7: session-writer에 이미지 임베드 + 파일 마커

**Files:**
- Modify: `src/core/session-writer.ts`
- Test: `tests/core/session-writer-attachments.test.ts`

**Interfaces:**
- Consumes: `storeBlob`(Task 6).
- 이미지(mediaType `image/*`): user content를 블록 배열로 만들고 `{type:'image', source:{type:'base64', media_type, data}}` 추가.
- 비이미지: `storeBlob`로 저장 후 텍스트에 `[첨부: <filename> → <relPath>]` 마커 추가.

- [ ] **Step 1: 실패 테스트** — `tests/core/session-writer-attachments.test.ts`

```ts
import { describe, it, expect } from 'vitest'
import { mkdtempSync, readFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { writeSession } from '../../src/core/session-writer'
import type { NormalizedChat } from '../../src/adapters/types'

const img = Buffer.from('PNGDATA').toString('base64')
const pdf = Buffer.from('PDFDATA').toString('base64')

describe('writeSession attachments', () => {
  it('이미지는 user content에 image 블록으로 임베드', () => {
    const dir = mkdtempSync(join(tmpdir(), 'wcd-'))
    const chat: NormalizedChat = { service:'claude', externalId:'e', title:'t', messages:[
      { role:'user', text:'이 사진 봐', ts:1, attachments:[{ filename:'a.png', mediaType:'image/png', data: img }] },
      { role:'assistant', text:'봤어', ts:2 },
    ]}
    const r = writeSession(chat, { cwd:'/tmp/wt', dirOverride: dir }) as any
    const u = readFileSync(join(dir, `${r.sessionId}.jsonl`),'utf-8').trim().split('\n').map(l=>JSON.parse(l))[0]
    expect(Array.isArray(u.message.content)).toBe(true)
    const imgBlock = u.message.content.find((b:any)=>b.type==='image')
    expect(imgBlock.source).toMatchObject({ type:'base64', media_type:'image/png' })
    expect(imgBlock.source.data).toBe(img)
  })
  it('비이미지 파일은 저장 + 텍스트 마커', () => {
    const dir = mkdtempSync(join(tmpdir(), 'wcd-'))
    const chat: NormalizedChat = { service:'claude', externalId:'e', title:'t', messages:[
      { role:'user', text:'문서 첨부', ts:1, attachments:[{ filename:'doc.pdf', mediaType:'application/pdf', data: pdf }] },
      { role:'assistant', text:'ok', ts:2 },
    ]}
    const r = writeSession(chat, { cwd:'/tmp/wt', dirOverride: dir }) as any
    const u = readFileSync(join(dir, `${r.sessionId}.jsonl`),'utf-8').trim().split('\n').map(l=>JSON.parse(l))[0]
    const content = typeof u.message.content === 'string' ? u.message.content : u.message.content.map((b:any)=>b.text||'').join('')
    expect(content).toContain('[첨부: doc.pdf')
    expect(content).toContain('attachments/')
  })
})
```

- [ ] **Step 2: 실패 확인**

Run: `npx vitest run tests/core/session-writer-attachments.test.ts`
Expected: FAIL — 아직 text만 처리.

- [ ] **Step 3: 구현** — `src/core/session-writer.ts`의 content 조립 교체

`writeSession` 시그니처에 `blobDir`(첨부 저장 위치, 기본 `dirname(세션파일의 cwd 폴더)`는 부적절하므로 저장 폴더 = cwd로 전달)을 추가하고, content 헬퍼를 아래로 교체:

```ts
import { storeBlob } from './blobstore'

type ImageBlock = { type: 'image'; source: { type: 'base64'; media_type: string; data: string } }
type TextBlock = { type: 'text'; text: string }

// blobBaseDir: 첨부 원본을 저장할 폴더(= 저장 cwd). 반환: user content(문자열 또는 블록배열)
function buildUserContent(m: NormalizedMessage, blobBaseDir: string): string | (TextBlock | ImageBlock)[] {
  const images = (m.attachments ?? []).filter(a => a.mediaType.startsWith('image/'))
  const files  = (m.attachments ?? []).filter(a => !a.mediaType.startsWith('image/'))
  let text = m.text
  for (const f of files) {
    const ext = (f.filename.split('.').pop() || 'bin')
    const { relPath } = storeBlob(blobBaseDir, f.data, ext)
    text += `\n[첨부: ${f.filename} → ${relPath}]`
  }
  if (images.length === 0) return text
  const blocks: (TextBlock | ImageBlock)[] = []
  if (text.trim()) blocks.push({ type: 'text', text })
  for (const im of images) {
    // 이미지도 원본 보관(§9): blobstore에 저장(중복 제거), 세션엔 base64 임베드
    const ext = (im.filename.split('.').pop() || 'img')
    storeBlob(blobBaseDir, im.data, ext)
    blocks.push({ type: 'image', source: { type: 'base64', media_type: im.mediaType, data: im.data } })
  }
  return blocks
}
```

`writeSession`에서 user 줄 조립을 `content: buildUserContent(m, opts.cwd)`로 바꾸고, `opts`에 이미 있는 `cwd`를 blob 저장 폴더로 사용. (assistant 첨부는 범위 밖 — 웹 대화의 첨부는 user 쪽.)

- [ ] **Step 4: 통과 확인(회귀 포함)**

Run: `npx vitest run tests/core/`
Expected: Task 4·6·7 테스트 전부 PASS.

- [ ] **Step 5: Commit**

```bash
git add src/core/session-writer.ts tests/core/session-writer-attachments.test.ts
git commit -m "feat: 이미지 base64 임베드 + 비이미지 파일 마커·보관"
```

---

### Task 8: index-store (중복 방지)

**Files:**
- Create: `src/core/index-store.ts`
- Test: `tests/core/index-store.test.ts`

**Interfaces:**
- Produces:
  - `loadIndex(cwd: string): Record<string, { sessionId: string; service: string; title: string; capturedAt: number }>`
  - `resolveSessionId(cwd: string, externalId: string): string | null` — 있으면 기존 sessionId(갱신), 없으면 null(신규).
  - `upsertIndex(cwd: string, externalId: string, entry: {...}): void`
  - 인덱스 파일: `<cwd>/.wcd-index.json`. 손상 시 빈 인덱스로 폴백(경고).

- [ ] **Step 1: 실패 테스트** — `tests/core/index-store.test.ts`

```ts
import { describe, it, expect } from 'vitest'
import { mkdtempSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { resolveSessionId, upsertIndex, loadIndex } from '../../src/core/index-store'

describe('index-store', () => {
  it('신규 externalId는 null', () => {
    const dir = mkdtempSync(join(tmpdir(),'wcd-'))
    expect(resolveSessionId(dir, 'x')).toBeNull()
  })
  it('upsert 후 같은 externalId는 기존 sessionId 반환', () => {
    const dir = mkdtempSync(join(tmpdir(),'wcd-'))
    upsertIndex(dir, 'x', { sessionId:'sid-1', service:'claude', title:'t', capturedAt: 1 })
    expect(resolveSessionId(dir, 'x')).toBe('sid-1')
  })
  it('손상된 인덱스는 빈 인덱스로 폴백', () => {
    const dir = mkdtempSync(join(tmpdir(),'wcd-'))
    writeFileSync(join(dir, '.wcd-index.json'), '{ broken json')
    expect(loadIndex(dir)).toEqual({})
  })
})
```

- [ ] **Step 2: 실패 확인**

Run: `npx vitest run tests/core/index-store.test.ts`
Expected: FAIL.

- [ ] **Step 3: 구현** — `src/core/index-store.ts`

```ts
import { readFileSync, writeFileSync, existsSync } from 'fs'
import { join } from 'path'

type Entry = { sessionId: string; service: string; title: string; capturedAt: number }
type Index = Record<string, Entry>
const file = (cwd: string) => join(cwd, '.wcd-index.json')

export function loadIndex(cwd: string): Index {
  const f = file(cwd)
  if (!existsSync(f)) return {}
  try { return JSON.parse(readFileSync(f, 'utf-8')) as Index }
  catch { console.warn(`[wcd] 인덱스 손상, 빈 인덱스로 진행: ${f}`); return {} }
}
export function resolveSessionId(cwd: string, externalId: string): string | null {
  return loadIndex(cwd)[externalId]?.sessionId ?? null
}
export function upsertIndex(cwd: string, externalId: string, entry: Entry): void {
  const idx = loadIndex(cwd)
  idx[externalId] = entry
  writeFileSync(file(cwd), JSON.stringify(idx, null, 2))
}
```

- [ ] **Step 4: 통과 확인 + Commit**

Run: `npx vitest run tests/core/index-store.test.ts`
Expected: PASS (3 tests).

```bash
git add src/core/index-store.ts tests/core/index-store.test.ts
git commit -m "feat: externalId 중복 방지 인덱스(손상시 폴백)"
```

---

### Task 9: 어댑터 인터페이스 + claude.ai 어댑터

**Files:**
- Create: `src/adapters/registry.ts`, `src/adapters/claude.ts`
- Test: `tests/adapters/claude.test.ts`, `tests/fixtures/claude-raw.json`

**Interfaces:**
- Produces:
  - `type Adapter = { service: 'claude'|'chatgpt'|'gemini'; detect(raw: unknown): boolean; normalize(raw: any): NormalizedChat }`
  - `detectAdapter(raw: unknown): Adapter | null` (registry)
- claude.ai 원본(`chat_conversations/<uuid>` 응답)의 `chat_messages[]`를 정규화. `sender` `human`→user / `assistant`→assistant. text 블록만.

- [ ] **Step 1: 픽스처 확보** — `tests/fixtures/claude-raw.json`

실제 claude.ai 대화 API 응답을 북마클릿/DevTools로 1건 캡처해 저장(민감정보 제거). 최소 형태:
```json
{ "uuid":"conv-1", "name":"제목",
  "chat_messages":[
    { "sender":"human", "text":"안녕", "created_at":"2026-07-01T00:00:00Z", "attachments":[], "files":[] },
    { "sender":"assistant", "text":"반가워", "created_at":"2026-07-01T00:00:01Z" }
  ]}
```

- [ ] **Step 2: 실패 테스트** — `tests/adapters/claude.test.ts`

```ts
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'fs'
import { join } from 'path'
import { claudeAdapter } from '../../src/adapters/claude'

const raw = JSON.parse(readFileSync(join(__dirname, '../fixtures/claude-raw.json'), 'utf-8'))

describe('claudeAdapter', () => {
  it('claude 응답을 감지', () => {
    expect(claudeAdapter.detect(raw)).toBe(true)
  })
  it('chat_messages를 NormalizedChat으로', () => {
    const c = claudeAdapter.normalize(raw)
    expect(c.service).toBe('claude')
    expect(c.externalId).toBe('conv-1')
    expect(c.messages.map(m => [m.role, m.text])).toEqual([['user','안녕'],['assistant','반가워']])
  })
})
```

- [ ] **Step 3: 실패 확인**

Run: `npx vitest run tests/adapters/claude.test.ts`
Expected: FAIL.

- [ ] **Step 4: 구현** — `src/adapters/claude.ts` + `src/adapters/registry.ts`

```ts
// src/adapters/claude.ts
import type { NormalizedChat, NormalizedMessage } from './types'

export const claudeAdapter = {
  service: 'claude' as const,
  detect(raw: any): boolean {
    return !!raw && Array.isArray(raw.chat_messages) && typeof raw.uuid === 'string'
  },
  normalize(raw: any): NormalizedChat {
    const messages: NormalizedMessage[] = raw.chat_messages.map((m: any) => ({
      role: m.sender === 'human' ? 'user' : 'assistant',
      text: (m.text ?? '').trim(),
      ts: m.created_at ? Date.parse(m.created_at) : undefined,
      // 첨부는 후속(파일 스키마 확정 시) — 현재 text 위주
    }))
    return { service: 'claude', externalId: raw.uuid, title: raw.name ?? '', messages }
  },
}
```

```ts
// src/adapters/registry.ts
import type { NormalizedChat } from './types'
import { claudeAdapter } from './claude'

export type Adapter = {
  service: 'claude' | 'chatgpt' | 'gemini'
  detect(raw: unknown): boolean
  normalize(raw: any): NormalizedChat
}
const adapters: Adapter[] = [claudeAdapter]  // Task 10에서 chatgpt·gemini 추가
export function detectAdapter(raw: unknown): Adapter | null {
  return adapters.find(a => a.detect(raw)) ?? null
}
export function registerAdapters(list: Adapter[]) { adapters.push(...list) }
```

- [ ] **Step 5: 통과 확인 + Commit**

Run: `npx vitest run tests/adapters/claude.test.ts`
Expected: PASS (2 tests).

```bash
git add src/adapters/claude.ts src/adapters/registry.ts tests/adapters/claude.test.ts tests/fixtures/claude-raw.json
git commit -m "feat: claude.ai 어댑터 + 어댑터 레지스트리"
```

---

### Task 10: ChatGPT · Gemini 어댑터

**Files:**
- Create: `src/adapters/chatgpt.ts`, `src/adapters/gemini.ts`
- Modify: `src/adapters/registry.ts`
- Test: `tests/adapters/chatgpt.test.ts`, `tests/adapters/gemini.test.ts`, 픽스처 2개

**Interfaces:**
- Consumes: `Adapter`(Task 9).
- Produces: `chatgptAdapter`, `geminiAdapter` (동일 `Adapter` 형태), registry에 등록.

> **주의(정직):** ChatGPT(mapping 노드 트리)·Gemini(batchexecute `hNvQHb`) 응답 구조는 실제 캡처본이 있어야 정확히 파싱할 수 있다. 아래는 확보한 픽스처에 맞춰 구현하며, 구조 확인 전엔 이 태스크를 시작하지 않는다.

- [ ] **Step 1: 픽스처 확보** — 각 서비스 대화 응답 1건씩 `tests/fixtures/chatgpt-raw.json`, `gemini-raw.json`으로 저장(민감정보 제거).

- [ ] **Step 2: ChatGPT 실패 테스트** — `tests/adapters/chatgpt.test.ts`

```ts
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'fs'
import { join } from 'path'
import { chatgptAdapter } from '../../src/adapters/chatgpt'

const raw = JSON.parse(readFileSync(join(__dirname, '../fixtures/chatgpt-raw.json'), 'utf-8'))
describe('chatgptAdapter', () => {
  it('감지', () => { expect(chatgptAdapter.detect(raw)).toBe(true) })
  it('mapping 트리를 시간순 메시지로', () => {
    const c = chatgptAdapter.normalize(raw)
    expect(c.service).toBe('chatgpt')
    expect(c.messages.length).toBeGreaterThan(0)
    expect(c.messages[0].role).toBe('user')
  })
})
```

- [ ] **Step 3: ChatGPT 구현** — `src/adapters/chatgpt.ts`

```ts
import type { NormalizedChat, NormalizedMessage } from './types'

export const chatgptAdapter = {
  service: 'chatgpt' as const,
  detect(raw: any): boolean {
    return !!raw && raw.mapping && typeof raw.mapping === 'object' && 'title' in raw
  },
  normalize(raw: any): NormalizedChat {
    // mapping: { nodeId: { message, parent, children } } — parent 체인으로 순서 복원
    const nodes = raw.mapping as Record<string, any>
    const ordered: any[] = []
    // root부터 children 따라 DFS(선형 대화 가정)
    let cur = Object.values(nodes).find((n: any) => !n.parent) as any
    const guard = new Set<string>()
    while (cur) {
      if (cur.message) ordered.push(cur.message)
      const next = (cur.children ?? [])[0]
      if (!next || guard.has(next)) break
      guard.add(next); cur = nodes[next]
    }
    const messages: NormalizedMessage[] = ordered
      .filter(m => m?.author?.role === 'user' || m?.author?.role === 'assistant')
      .map(m => ({
        role: m.author.role === 'user' ? 'user' : 'assistant',
        text: (m.content?.parts ?? []).filter((p: any) => typeof p === 'string').join('\n').trim(),
        ts: m.create_time ? Math.round(m.create_time * 1000) : undefined,
      }))
      .filter(m => m.text.length > 0)
    return { service: 'chatgpt', externalId: raw.conversation_id ?? raw.id ?? String(raw.title), title: raw.title ?? '', messages }
  },
}
```

- [ ] **Step 4: Gemini 실패 테스트** — `tests/adapters/gemini.test.ts`

```ts
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'fs'
import { join } from 'path'
import { geminiAdapter } from '../../src/adapters/gemini'

const raw = JSON.parse(readFileSync(join(__dirname, '../fixtures/gemini-raw.json'), 'utf-8'))
describe('geminiAdapter', () => {
  it('감지', () => { expect(geminiAdapter.detect(raw)).toBe(true) })
  it('메시지 추출', () => {
    const c = geminiAdapter.normalize(raw)
    expect(c.service).toBe('gemini')
    expect(c.messages.length).toBeGreaterThan(0)
  })
})
```

- [ ] **Step 5: Gemini 구현 + registry 등록**

`src/adapters/gemini.ts` — 확보한 픽스처(batchexecute 파싱 결과를 북마클릿이 이미 `{turns:[{role,text,ts}]}`로 정규화해 보낸다고 가정)에 맞춰 구현:

```ts
import type { NormalizedChat, NormalizedMessage } from './types'

export const geminiAdapter = {
  service: 'gemini' as const,
  detect(raw: any): boolean {
    return !!raw && raw.source === 'gemini' && Array.isArray(raw.turns)
  },
  normalize(raw: any): NormalizedChat {
    const messages: NormalizedMessage[] = raw.turns
      .map((t: any) => ({ role: t.role === 'user' ? 'user' : 'assistant', text: String(t.text ?? '').trim(), ts: t.ts }))
      .filter((m: NormalizedMessage) => m.text.length > 0)
    return { service: 'gemini', externalId: raw.conversationId ?? String(raw.id), title: raw.title ?? '', messages }
  },
}
```

`src/adapters/registry.ts` 수정:
```ts
import { chatgptAdapter } from './chatgpt'
import { geminiAdapter } from './gemini'
// const adapters: Adapter[] = [claudeAdapter, chatgptAdapter, geminiAdapter]
```

- [ ] **Step 6: 통과 확인 + Commit**

Run: `npx vitest run tests/adapters/`
Expected: 3 어댑터 테스트 PASS.

```bash
git add src/adapters/chatgpt.ts src/adapters/gemini.ts src/adapters/registry.ts tests/adapters/ tests/fixtures/chatgpt-raw.json tests/fixtures/gemini-raw.json
git commit -m "feat: ChatGPT·Gemini 어댑터 + registry 등록"
```

---

### Task 11: server (localhost 수신 → 변환)

**Files:**
- Create: `src/server.ts`
- Test: `tests/server.test.ts`

**Interfaces:**
- Consumes: `detectAdapter`(Task 9/10), `writeSession`(Task 4/7), `resolveSessionId`·`upsertIndex`(Task 8).
- Produces: `handleCapture(raw: unknown, cwd: string): { sessionId: string } | { error: string }` (순수 핸들러, 테스트 용이), `startServer(opts:{port:number; cwd:string}): http.Server`.

- [ ] **Step 1: 실패 테스트** — `tests/server.test.ts`

```ts
import { describe, it, expect } from 'vitest'
import { mkdtempSync, readFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { handleCapture } from '../src/server'

const raw = { uuid:'conv-9', name:'t', chat_messages:[
  { sender:'human', text:'하이', created_at:'2026-07-01T00:00:00Z' },
  { sender:'assistant', text:'헬로', created_at:'2026-07-01T00:00:01Z' },
]}

describe('handleCapture', () => {
  it('감지·정규화·세션 생성, 인덱스 기록', () => {
    const dir = mkdtempSync(join(tmpdir(),'wcd-'))
    const r = handleCapture(raw, dir) as any
    expect(r.sessionId).toBeTruthy()
    expect(readFileSync(join(dir, '.wcd-index.json'),'utf-8')).toContain('conv-9')
  })
  it('같은 externalId 재캡처는 같은 sessionId(갱신)', () => {
    const dir = mkdtempSync(join(tmpdir(),'wcd-'))
    const a = handleCapture(raw, dir) as any
    const b = handleCapture(raw, dir) as any
    expect(b.sessionId).toBe(a.sessionId)
  })
  it('감지 실패는 error', () => {
    const dir = mkdtempSync(join(tmpdir(),'wcd-'))
    expect((handleCapture({ foo: 1 }, dir) as any).error).toBeTruthy()
  })
})
```

- [ ] **Step 2: 실패 확인**

Run: `npx vitest run tests/server.test.ts`
Expected: FAIL.

- [ ] **Step 3: 구현** — `src/server.ts`

```ts
import http from 'http'
import { detectAdapter } from './adapters/registry'
import { writeSession } from './core/session-writer'
import { resolveSessionId, upsertIndex } from './core/index-store'

export function handleCapture(raw: unknown, cwd: string): { sessionId: string } | { error: string } {
  const adapter = detectAdapter(raw)
  if (!adapter) return { error: 'unrecognized chat payload (지원: claude/chatgpt/gemini)' }
  let chat
  try { chat = adapter.normalize(raw as any) }
  catch (e) { return { error: `normalize failed: ${(e as Error).message}` } }

  const existing = resolveSessionId(cwd, chat.externalId)
  const res = writeSession(chat, { cwd, sessionId: existing ?? undefined })
  if ('error' in res) return res
  upsertIndex(cwd, chat.externalId, { sessionId: res.sessionId, service: chat.service, title: chat.title, capturedAt: Date.now() })
  return res
}

export function startServer(opts: { port: number; cwd: string }): http.Server {
  const server = http.createServer((req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*')      // 북마클릿 POST 허용
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type')
    if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return }
    if (req.method !== 'POST') { res.writeHead(405); res.end(); return }
    let body = ''
    req.on('data', c => { body += c; if (body.length > 50 * 1024 * 1024) req.destroy() }) // 50MB 상한
    req.on('end', () => {
      let raw: unknown
      try { raw = JSON.parse(body) } catch { res.writeHead(400); res.end(JSON.stringify({ error: 'invalid JSON' })); return }
      const out = handleCapture(raw, opts.cwd)
      const status = 'error' in out ? 422 : 200
      res.writeHead(status, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify(out))
      if ('sessionId' in out) console.log(`✔ 저장: ${out.sessionId}  → cd ${opts.cwd} && claude --resume ${out.sessionId}`)
      else console.error(`✘ ${out.error}`)
    })
  })
  return server.listen(opts.port, '127.0.0.1')
}
```

- [ ] **Step 4: 통과 확인 + Commit**

Run: `npx vitest run tests/server.test.ts`
Expected: PASS (3 tests).

```bash
git add src/server.ts tests/server.test.ts
git commit -m "feat: localhost 수신 핸들러·서버(감지·변환·중복갱신)"
```

---

### Task 12: CLI 진입점

**Files:**
- Create: `src/cli.ts`
- Test: `tests/cli.test.ts`

**Interfaces:**
- Consumes: `startServer`(Task 11).
- Produces: `web-chat-downloader serve [--port 8787] [--into <path>]` — 기본 cwd `~/Desktop/Archive/web-chats`, 없으면 생성.

- [ ] **Step 1: 실패 테스트(인자 파싱)** — `tests/cli.test.ts`

```ts
import { describe, it, expect } from 'vitest'
import { parseArgs } from '../src/cli'

describe('parseArgs', () => {
  it('기본값', () => {
    const o = parseArgs(['serve'])
    expect(o.cmd).toBe('serve'); expect(o.port).toBe(8787)
    expect(o.cwd.endsWith('/Desktop/Archive/web-chats')).toBe(true)
  })
  it('--port/--into 오버라이드', () => {
    const o = parseArgs(['serve','--port','9000','--into','/tmp/x'])
    expect(o.port).toBe(9000); expect(o.cwd).toBe('/tmp/x')
  })
})
```

- [ ] **Step 2: 실패 확인**

Run: `npx vitest run tests/cli.test.ts`
Expected: FAIL.

- [ ] **Step 3: 구현** — `src/cli.ts`

```ts
#!/usr/bin/env node
import { homedir } from 'os'
import { join } from 'path'
import { mkdirSync } from 'fs'
import { startServer } from './server'

export function parseArgs(argv: string[]): { cmd: string; port: number; cwd: string } {
  const cmd = argv[0] ?? 'serve'
  let port = 8787
  let cwd = join(homedir(), 'Desktop', 'Archive', 'web-chats')
  for (let i = 1; i < argv.length; i++) {
    if (argv[i] === '--port') port = Number(argv[++i])
    else if (argv[i] === '--into') cwd = argv[++i]
  }
  return { cmd, port, cwd }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const { cmd, port, cwd } = parseArgs(process.argv.slice(2))
  if (cmd !== 'serve') { console.error('usage: web-chat-downloader serve [--port N] [--into PATH]'); process.exit(1) }
  mkdirSync(cwd, { recursive: true })
  startServer({ port, cwd })
  console.log(`web-chat-downloader 수신 대기: http://127.0.0.1:${port}  → 저장: ${cwd}`)
}
```

- [ ] **Step 4: 통과 확인 + Commit**

Run: `npx vitest run tests/cli.test.ts && npm run build`
Expected: PASS + 빌드 성공.

```bash
git add src/cli.ts tests/cli.test.ts
git commit -m "feat: CLI serve 진입점(--port·--into)"
```

---

### Task 13: 북마클릿 (서비스별 캡처)

**Files:**
- Create: `bookmarklets/claude.js`, `bookmarklets/chatgpt.js`, `bookmarklets/gemini.js`, `bookmarklets/README.md`

**Interfaces:**
- Consumes: 서버 엔드포인트 `POST http://127.0.0.1:8787`.
- 각 북마클릿: 현재 대화 API를 로그인 세션으로 fetch → (필요 시 최소 정규화) → 서버로 POST.

- [ ] **Step 1: claude.js 작성** — `bookmarklets/claude.js`

```js
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
```

- [ ] **Step 2: chatgpt.js / gemini.js 작성**

각 서비스의 대화 로드 API를 로그인 세션으로 fetch해 서버로 POST. Gemini는 batchexecute 응답을 `{source:'gemini', conversationId, title, turns:[{role,text,ts}]}` 형태로 페이지에서 최소 정규화 후 전송(어댑터 detect와 일치). 실제 엔드포인트·파싱은 Task 10 픽스처 확보 시점에 확정.

```js
// bookmarklets/chatgpt.js
javascript:(async () => {
  try {
    const id = location.pathname.split('/c/')[1];
    if (!id) return alert('ChatGPT 대화 페이지에서 실행하세요');
    const token = (await (await fetch('/api/auth/session')).json()).accessToken;
    const raw = await (await fetch(`/backend-api/conversation/${id}`, { headers: { authorization: `Bearer ${token}` } })).json();
    const out = await (await fetch('http://127.0.0.1:8787', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify(raw) })).json();
    alert(out.sessionId ? `저장됨: ${out.sessionId}` : `실패: ${out.error}`);
  } catch (e) { alert('오류: ' + e.message); }
})();
```

- [ ] **Step 3: README 작성(설치법)** — `bookmarklets/README.md`

북마크바에 새 북마크 만들고 URL에 각 `.js` 내용(한 줄로 압축) 붙여넣기. 사용: 대화 페이지에서 해당 북마크 클릭 → `serve` 실행 중이면 자동 저장. 서버 실행: `npm run dev serve` 또는 `web-chat-downloader serve`.

- [ ] **Step 4: 수동 확인**

한 서비스 대화에서 북마클릿 클릭 → 서버 콘솔에 `✔ 저장` + `~/.claude/projects/<slug>/`에 파일 생성 → `claude --resume`으로 이어짐(Task 5 게이트 재확인).

- [ ] **Step 5: Commit**

```bash
git add bookmarklets/
git commit -m "feat: 서비스별 캡처 북마클릿 + 설치 문서"
```

---

## Self-Review

**1. Spec coverage:**
- §3 아키텍처 → Task 11·12·13. §4 컴포넌트 → 전 태스크가 파일 구조대로. §5 공통형 → Task 4. §6 CC 필드셋 → Task 4(텍스트)·7(이미지)·5(실증). §7 slug → Task 2. §8 저장·중복 → Task 8·11. §9 첨부 → Task 6·7. §10 에러 → 각 태스크 에러 케이스(빈 대화/잘못된 JSON/base64/version/인덱스 손상). §11 테스팅 → 각 태스크 TDD + Task 5 실증. §2 성공기준(실증 게이트) → Task 5. 누락 없음.
- **알려진 실물 의존**: Task 9·10·13의 실제 서비스 API 구조는 픽스처 캡처 후 확정(placeholder 아님 — 인터페이스·정규화 골격은 고정, 필드 매핑만 실물로 맞춤).

**2. Placeholder scan:** "적절한 에러 처리" 같은 모호 표현 없음. 각 에러 처리는 구체 코드/테스트로 명시. 실물 의존 지점은 §명시.

**3. Type consistency:** `NormalizedChat/Message/Attachment`(Task 4) → 전 어댑터·writer·server 동일 사용. `writeSession`·`handleCapture`·`detectAdapter`·`storeBlob`·`resolveSessionId`/`upsertIndex` 시그니처 태스크 간 일치. `slug`·`readClaudeVersion` 반환형 일치.

---

## Execution Handoff

계획을 실행할 준비가 됐다. Task 5(resume 실증 게이트)는 반드시 실제 CC로 검증하고 통과해야 이후로 진행한다.
