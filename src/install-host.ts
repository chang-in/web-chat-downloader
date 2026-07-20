import { chmodSync, mkdirSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

export type NativeHostManifest = {
  name: string
  description: string
  path: string
  type: 'stdio'
  allowed_origins: string[]
}

// Chrome Native Messaging 매니페스트 스펙: https://developer.chrome.com/docs/apps/nativeMessaging
export function buildManifest(extensionId: string, launcherPath: string): NativeHostManifest {
  return {
    name: 'com.web_chat_downloader.host',
    description: 'web-chat-downloader native messaging host',
    path: launcherPath,
    type: 'stdio',
    allowed_origins: [`chrome-extension://${extensionId}/`],
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
  extensionId: string,
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
  const manifest = buildManifest(extensionId, launcherPath)
  const manifestPath = join(manifestDir, `${manifest.name}.json`)
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2))

  return { manifestPath, launcherPath }
}
