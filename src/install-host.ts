import { execFileSync } from 'node:child_process'
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

// Chrome이 Native Messaging 매니페스트를 찾는 위치는 OS마다 다르다.
// - macOS/Linux: 정해진 디렉터리에 <호스트이름>.json을 두면 된다.
// - Windows: 디렉터리 규칙이 없다. 파일은 아무 데나 두고 레지스트리가 그 경로를 가리킨다.
//   (HKCU\Software\Google\Chrome\NativeMessagingHosts\<호스트이름>의 기본값)
// https://developer.chrome.com/docs/apps/nativeMessaging#native-messaging-host-location
export function defaultManifestDir(platform: NodeJS.Platform = process.platform, home: string = homedir()): string {
  switch (platform) {
    case 'darwin':
      return join(home, 'Library', 'Application Support', 'Google', 'Chrome', 'NativeMessagingHosts')
    case 'win32':
      return join(home, '.web-chat-downloader')
    default:
      return join(home, '.config', 'google-chrome', 'NativeMessagingHosts')
  }
}

const DEFAULT_LAUNCHER_DIR = join(homedir(), '.web-chat-downloader')

// Chrome은 stdio 호스트를 실행 파일로 직접 실행한다. POSIX는 셰뱅이 붙은 sh 스크립트를,
// Windows는 .bat을 인식한다(확장자 없는 파일은 실행되지 않는다).
export function launcherFileName(platform: NodeJS.Platform = process.platform): string {
  return platform === 'win32' ? 'host.bat' : 'host.sh'
}

export function launcherScript(platform: NodeJS.Platform, nodePath: string, cliPath: string): string {
  if (platform === 'win32') {
    // %*로 Chrome이 넘기는 인자(호출 확장 origin 등)를 그대로 전달한다.
    return `@echo off\r\n"${nodePath}" "${cliPath}" host %*\r\n`
  }
  return `#!/bin/sh\nexec "${nodePath}" "${cliPath}" host\n`
}

// Windows에서만 필요한 단계. 매니페스트 파일을 놔두는 것만으로는 Chrome이 찾지 못한다.
export function registerWindowsRegistry(hostName: string, manifestPath: string): void {
  execFileSync(
    'reg',
    ['add', `HKCU\\Software\\Google\\Chrome\\NativeMessagingHosts\\${hostName}`, '/ve', '/t', 'REG_SZ', '/d', manifestPath, '/f'],
    { stdio: 'ignore' },
  )
}

// dist/install-host.js든 src/install-host.ts(tsx로 직접 실행)든, 이 파일의 부모 디렉터리 바로
// 위가 저장소 루트다(dist/도 src/도 리포 루트 바로 아래에 있으므로).
function defaultRepoRoot(): string {
  return join(dirname(fileURLToPath(import.meta.url)), '..')
}

// 테스트에서 실제 ~/Library, ~/.web-chat-downloader를 건드리지 않도록 디렉터리를 주입 가능하게 뒀다.
export function installHost(
  extensionIds: string | string[],
  opts: {
    manifestDir?: string
    launcherDir?: string
    repoRoot?: string
    platform?: NodeJS.Platform
    // Windows 레지스트리 등록 여부. 기본은 실제 플랫폼을 따르되, 테스트에서 끌 수 있게 열어뒀다.
    registerRegistry?: boolean
  } = {},
): { manifestPath: string; launcherPath: string } {
  const platform = opts.platform ?? process.platform
  const manifestDir = opts.manifestDir ?? defaultManifestDir(platform)
  const launcherDir = opts.launcherDir ?? DEFAULT_LAUNCHER_DIR
  const repoRoot = opts.repoRoot ?? defaultRepoRoot()

  mkdirSync(launcherDir, { recursive: true })
  const launcherPath = join(launcherDir, launcherFileName(platform))
  const cliPath = join(repoRoot, 'dist', 'cli.js')
  writeFileSync(launcherPath, launcherScript(platform, process.execPath, cliPath))
  // Windows는 실행 권한 개념이 달라 chmod가 의미 없다(그리고 일부 파일시스템에서 실패한다).
  if (platform !== 'win32') chmodSync(launcherPath, 0o755)

  mkdirSync(manifestDir, { recursive: true })
  const manifest = buildManifest(extensionIds, launcherPath)
  const manifestPath = join(manifestDir, `${manifest.name}.json`)
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2))

  if (opts.registerRegistry ?? platform === 'win32') registerWindowsRegistry(manifest.name, manifestPath)

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

// Chrome 프로필(Preferences)이 있는 곳. 매니페스트 위치와는 별개로 OS마다 다르다.
export function defaultChromeUserDataDir(platform: NodeJS.Platform = process.platform, home: string = homedir()): string {
  switch (platform) {
    case 'darwin':
      return join(home, 'Library', 'Application Support', 'Google', 'Chrome')
    case 'win32':
      return join(process.env.LOCALAPPDATA || join(home, 'AppData', 'Local'), 'Google', 'Chrome', 'User Data')
    default:
      return join(home, '.config', 'google-chrome')
  }
}

// Default + Profile N 디렉터리를 후보로 모아 Preferences와 Secure Preferences를
// 모두 읽는다. 프로필 디렉터리나 파일이 없거나, 파일이 깨져 있거나
// (JSON 파싱 실패), 잠겨 있어 읽기가 실패해도(EACCES 등) 그 파일만 건너뛰고
// 명령 전체는 죽지 않는다.
export function scanChromeProfilesForExtension(
  extensionDir: string,
  opts: { userDataDir?: string } = {},
): ExtensionScanResult[] {
  const userDataDir = opts.userDataDir ?? defaultChromeUserDataDir()
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
