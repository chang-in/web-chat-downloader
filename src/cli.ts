#!/usr/bin/env node
import { runNativeHost } from './native-host.js'
import { installHost } from './install-host.js'

export function parseArgs(argv: string[]): { cmd: string; extensionId?: string } {
  const cmd = argv[0] ?? 'host'
  const extensionId = argv[1]
  return { cmd, extensionId }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const { cmd, extensionId } = parseArgs(process.argv.slice(2))
  if (cmd === 'host') {
    // Chrome이 stdio로 이 프로세스를 직접 실행한다 — stdout에는 프레이밍된 메시지만 나가야 하므로
    // 여기서부터는 console.log를 쓰면 안 된다(native-host.ts가 이미 그렇게 되어 있음).
    runNativeHost()
  } else if (cmd === 'install-host') {
    if (!extensionId) {
      console.error('usage: web-chat-downloader install-host <extensionId>')
      process.exit(1)
    }
    const { manifestPath, launcherPath } = installHost(extensionId)
    console.log(`네이티브 호스트 설치 완료`)
    console.log(`  매니페스트: ${manifestPath}`)
    console.log(`  런처: ${launcherPath}`)
    console.log(`먼저 'npm run build'로 dist/cli.js를 빌드해뒀는지 확인하세요(런처가 그걸 실행합니다).`)
  } else {
    console.error('usage: web-chat-downloader <host|install-host <extensionId>>')
    process.exit(1)
  }
}
