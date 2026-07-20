import { chmodSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export type NativeHostManifest = {
  name: string
  description: string
  path: string
  type: 'stdio'
  allowed_origins: string[]
}

// Chrome Native Messaging 매니페스트 스펙: https://developer.chrome.com/docs/apps/nativeMessaging
// extensionIds는 단일 문자열(기존 동작)이나 배열(자동 탐지로 여러 개 나온 경우) 둘 다 받는다.
export function buildManifest(extensionIds: string | string[], launcherPath: string): NativeHostManifest {
  const ids = Array.isArray(extensionIds) ? extensionIds : [extensionIds]
  return {
    name: 'com.web_chat_downloader.host',
    description: 'web-chat-downloader native messaging host',
    path: launcherPath,
    type: 'stdio',
    allowed_origins: ids.map((id) => `chrome-extension://${id}/`),
  }
}

const DEFAULT_MANIFEST_DIR = join(homedir(), 'Library', 'Application Support', 'Google', 'Chrome', 'NativeMessagingHosts')
const DEFAULT_LAUNCHER_DIR = join(homedir(), '.web-chat-downloader')

// dist/install-host.js든 src/install-host.ts(tsx로 직접 실행)든, 이 파일의 부모 디렉터리 바로
// 위가 저장소 루트다(dist/도 src/도 리포 루트 바로 아래에 있으므로).
function defaultRepoRoot(): string {
  return join(dirname(fileURLToPath(import.meta.url)), '..')
}

// 테스트에서 실제 ~/Library, ~/.web-chat-downloader를 건드리지 않도록 디렉터리를 주입 가능하게 뒀다.
export function installHost(
  extensionIds: string | string[],
  opts: { manifestDir?: string; launcherDir?: string; repoRoot?: string } = {},
): { manifestPath: string; launcherPath: string } {
  const manifestDir = opts.manifestDir ?? DEFAULT_MANIFEST_DIR
  const launcherDir = opts.launcherDir ?? DEFAULT_LAUNCHER_DIR
  const repoRoot = opts.repoRoot ?? defaultRepoRoot()

  mkdirSync(launcherDir, { recursive: true })
  const launcherPath = join(launcherDir, 'host.sh')
  const cliPath = join(repoRoot, 'dist', 'cli.js')
  writeFileSync(launcherPath, `#!/bin/sh\nexec "${process.execPath}" "${cliPath}" host\n`)
  chmodSync(launcherPath, 0o755)

  mkdirSync(manifestDir, { recursive: true })
  const manifest = buildManifest(extensionIds, launcherPath)
  const manifestPath = join(manifestDir, `${manifest.name}.json`)
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2))

  return { manifestPath, launcherPath }
}

export function defaultExtensionDir(): string {
  return join(defaultRepoRoot(), 'extension')
}

// ── 확장 ID 자동 탐지 ──────────────────────────────────────────────
//
// Chrome은 "압축해제된 확장 프로그램 로드"로 올린 확장을 프로필별 Preferences
// 또는 Secure Preferences (JSON)의 extensions.settings[id].path에 그 확장 폴더의
// 절대경로로 기록해둔다. 그 값이 우리 저장소의 extension/ 폴더와 같은 경로를
// 가리키면 그 id가 우리 확장이라고 판단한다.

// 순수 함수: 이미 파싱된 Preferences JSON 하나에서 extensionDir와 일치하는 id를 찾는다.
// Chrome을 건드리지 않고, 파일 I/O도 하지 않는다 — 단위 테스트가 이 함수를 직접 검증한다.
export function findExtensionIds(prefsJson: unknown, extensionDir: string): string[] {
  const target = resolve(extensionDir)
  const ids = new Set<string>()

  if (!prefsJson || typeof prefsJson !== 'object') return []
  const settings = (prefsJson as { extensions?: { settings?: unknown } }).extensions?.settings
  if (!settings || typeof settings !== 'object') return []

  for (const [id, entry] of Object.entries(settings as Record<string, unknown>)) {
    if (!entry || typeof entry !== 'object') continue
    const path = (entry as Record<string, unknown>).path
    if (typeof path !== 'string' || path.length === 0) continue
    // 상대경로는 무엇을 기준으로 풀어야 할지 알 수 없으니 추측하지 않고 무시한다.
    if (!isAbsolute(path)) continue
    if (resolve(path) === target) ids.add(id)
  }

  return [...ids]
}

export type ExtensionScanResult = { id: string; profiles: string[] }

const DEFAULT_CHROME_USER_DATA_DIR = join(homedir(), 'Library', 'Application Support', 'Google', 'Chrome')

// Default + Profile N 디렉터리를 후보로 모아 Preferences와 Secure Preferences를
// 모두 읽는다. 프로필 디렉터리나 파일이 없거나, 파일이 깨져 있거나
// (JSON 파싱 실패), 잠겨 있어 읽기가 실패해도(EACCES 등) 그 파일만 건너뛰고
// 명령 전체는 죽지 않는다.
export function scanChromeProfilesForExtension(
  extensionDir: string,
  opts: { userDataDir?: string } = {},
): ExtensionScanResult[] {
  const userDataDir = opts.userDataDir ?? DEFAULT_CHROME_USER_DATA_DIR
  const byId = new Map<string, Set<string>>()

  for (const profile of listProfileDirs(userDataDir)) {
    const profileDir = join(userDataDir, profile)
    const prefsFiles = ['Preferences', 'Secure Preferences']

    for (const prefsFile of prefsFiles) {
      let prefsJson: unknown
      try {
        prefsJson = JSON.parse(readFileSync(join(profileDir, prefsFile), 'utf-8'))
      } catch {
        continue
      }
      for (const id of findExtensionIds(prefsJson, extensionDir)) {
        if (!byId.has(id)) byId.set(id, new Set())
        byId.get(id)!.add(profile)
      }
    }
  }

  return [...byId.entries()].map(([id, profiles]) => ({ id, profiles: [...profiles] }))
}

function listProfileDirs(userDataDir: string): string[] {
  const profiles = ['Default']
  let entries: string[]
  try {
    entries = readdirSync(userDataDir)
  } catch {
    return profiles
  }
  for (const entry of entries) {
    if (!/^Profile \d+$/.test(entry)) continue
    try {
      if (statSync(join(userDataDir, entry)).isDirectory()) profiles.push(entry)
    } catch {
      // 목록을 읽은 직후 사라지는 등의 레이스 컨디션 — 그냥 건너뛴다.
    }
  }
  return profiles
}
