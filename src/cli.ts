#!/usr/bin/env node
import { runNativeHost } from './native-host.js'
import { defaultExtensionDir, installHost, scanChromeProfilesForExtension } from './install-host.js'

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
    let extensionIds: string[]
    if (extensionId) {
      extensionIds = [extensionId]
    } else {
      const found = scanChromeProfilesForExtension(defaultExtensionDir())
      if (found.length === 0) {
        console.error('확장 ID를 자동으로 찾지 못했습니다. 다음을 확인해보세요:')
        console.error('  - chrome://extensions 에서 이 저장소의 extension/ 폴더를 "압축해제된 확장 프로그램"으로 로드했는지')
        console.error('  - 로드한 폴더가 정확히 이 저장소의 extension/ 인지')
        console.error('  - Chrome이 실행 중이라면 방금 로드한 내용이 아직 Preferences 파일에 반영되지 않았을 수 있습니다 —')
        console.error('    Chrome을 껐다가 다시 켠 뒤 다시 시도하거나, 확장 ID를 인자로 직접 넘겨주세요:')
        console.error('    web-chat-downloader install-host <extensionId>')
        process.exit(1)
      }
      extensionIds = found.map((f) => f.id)
      if (found.length === 1) {
        console.log(`확장 ID 자동 감지: ${found[0].id} (프로필: ${found[0].profiles.join(', ')})`)
      } else {
        console.log('여러 개의 확장 ID를 감지했습니다(모두 등록합니다):')
        for (const f of found) console.log(`  - ${f.id} (프로필: ${f.profiles.join(', ')})`)
      }
    }
    const { manifestPath, launcherPath } = installHost(extensionIds)
    console.log(`네이티브 호스트 설치 완료`)
    console.log(`  매니페스트: ${manifestPath}`)
    console.log(`  런처: ${launcherPath}`)
    console.log(`먼저 'npm run build'로 dist/cli.js를 빌드해뒀는지 확인하세요(런처가 그걸 실행합니다).`)
  } else {
    console.error('usage: web-chat-downloader <host|install-host [extensionId]>')
    process.exit(1)
  }
}
