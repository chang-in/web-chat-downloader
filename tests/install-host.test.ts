import { describe, it, expect } from 'vitest'
import { mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { buildManifest, findExtensionIds, installHost, scanChromeProfilesForExtension } from '../src/install-host'

describe('buildManifest', () => {
  it('name·type·allowed_origins 형식이 Chrome Native Messaging 스펙대로다', () => {
    const m = buildManifest('abcdefghijklmnop', '/Users/x/.web-chat-downloader/host.sh')
    expect(m.name).toBe('com.web_chat_downloader.host')
    expect(m.type).toBe('stdio')
    expect(m.path).toBe('/Users/x/.web-chat-downloader/host.sh')
    expect(m.allowed_origins).toEqual(['chrome-extension://abcdefghijklmnop/'])
    expect(typeof m.description).toBe('string')
    expect(m.description.length).toBeGreaterThan(0)
  })
})

describe('installHost', () => {
  it('매니페스트 JSON과 실행 가능한 런처 스크립트를 지정된 위치에 쓴다', () => {
    const manifestDir = mkdtempSync(join(tmpdir(), 'wcd-manifest-'))
    const launcherDir = mkdtempSync(join(tmpdir(), 'wcd-launcher-'))
    const repoRoot = mkdtempSync(join(tmpdir(), 'wcd-repo-'))

    const { manifestPath, launcherPath } = installHost('myextensionid1234', { manifestDir, launcherDir, repoRoot })

    const manifest = JSON.parse(readFileSync(manifestPath, 'utf-8'))
    expect(manifest.name).toBe('com.web_chat_downloader.host')
    expect(manifest.type).toBe('stdio')
    expect(manifest.allowed_origins).toEqual(['chrome-extension://myextensionid1234/'])
    expect(manifest.path).toBe(launcherPath)

    const launcherScript = readFileSync(launcherPath, 'utf-8')
    expect(launcherScript).toContain('#!/bin/sh')
    expect(launcherScript).toContain(process.execPath)
    expect(launcherScript).toContain(join(repoRoot, 'dist', 'cli.js'))
    expect(launcherScript).toContain('host')

    const mode = statSync(launcherPath).mode & 0o777
    expect(mode).toBe(0o755)
  })
})

describe('buildManifest — 여러 ID', () => {
  it('배열로 넘기면 allowed_origins에 전부 등록된다', () => {
    const m = buildManifest(['idone000000000000', 'idtwo000000000000'], '/x/host.sh')
    expect(m.allowed_origins).toEqual(['chrome-extension://idone000000000000/', 'chrome-extension://idtwo000000000000/'])
  })
})

describe('findExtensionIds', () => {
  const extensionDir = '/Users/x/repo/extension'

  it('exact match: path가 extensionDir와 정확히 같으면 그 id를 반환한다', () => {
    const prefs = { extensions: { settings: { abcid: { path: extensionDir } } } }
    expect(findExtensionIds(prefs, extensionDir)).toEqual(['abcid'])
  })

  it('trailing slash가 있어도(양쪽 어느 쪽이든) 매치한다', () => {
    const prefsTrailingOnStored = { extensions: { settings: { abcid: { path: extensionDir + '/' } } } }
    expect(findExtensionIds(prefsTrailingOnStored, extensionDir)).toEqual(['abcid'])

    const prefs = { extensions: { settings: { abcid: { path: extensionDir } } } }
    expect(findExtensionIds(prefs, extensionDir + '/')).toEqual(['abcid'])
  })

  it('다른 경로면 매치하지 않는다', () => {
    const prefs = { extensions: { settings: { abcid: { path: '/Users/x/repo/other-folder' } } } }
    expect(findExtensionIds(prefs, extensionDir)).toEqual([])
  })

  it('path가 없는 엔트리는 건너뛴다(크래시 없이)', () => {
    const prefs = { extensions: { settings: { noPathId: {}, abcid: { path: extensionDir } } } }
    expect(findExtensionIds(prefs, extensionDir)).toEqual(['abcid'])
  })

  it('상대경로 path는 추측하지 않고 무시한다', () => {
    const prefs = { extensions: { settings: { relId: { path: 'extension' } } } }
    expect(findExtensionIds(prefs, extensionDir)).toEqual([])
  })

  it('망가진 extensions 트리에도 크래시 없이 빈 배열을 반환한다', () => {
    expect(findExtensionIds({}, extensionDir)).toEqual([])
    expect(findExtensionIds({ extensions: {} }, extensionDir)).toEqual([])
    expect(findExtensionIds({ extensions: null }, extensionDir)).toEqual([])
    expect(findExtensionIds({ extensions: { settings: 'not-an-object' } }, extensionDir)).toEqual([])
    expect(findExtensionIds({ extensions: { settings: null } }, extensionDir)).toEqual([])
    expect(findExtensionIds({ extensions: { settings: { abcid: null } } }, extensionDir)).toEqual([])
    expect(findExtensionIds({ extensions: { settings: { abcid: 'not-an-object' } } }, extensionDir)).toEqual([])
    expect(findExtensionIds(null, extensionDir)).toEqual([])
    expect(findExtensionIds('not-an-object', extensionDir)).toEqual([])
  })

  it('같은 id가 두 번 나와도(이론상) 중복 없이 반환한다', () => {
    // JS 객체 키는 유일하므로 같은 파일 안에서 직접 중복시킬 순 없지만,
    // 반환값이 Set 기반이라 여러 프로필에서 같은 id를 모아도 중복 없이 합쳐진다는 걸
    // scanChromeProfilesForExtension 쪽 테스트에서 별도로 확인한다.
    const prefs = {
      extensions: { settings: { abcid: { path: extensionDir }, xyzid: { path: extensionDir } } },
    }
    expect(findExtensionIds(prefs, extensionDir).sort()).toEqual(['abcid', 'xyzid'])
  })
})

describe('scanChromeProfilesForExtension', () => {
  function makeUserDataDir(profiles: Record<string, unknown>): string {
    const userDataDir = mkdtempSync(join(tmpdir(), 'wcd-chrome-userdata-'))
    for (const [profile, prefsJson] of Object.entries(profiles)) {
      const profileDir = join(userDataDir, profile)
      mkdirSync(profileDir, { recursive: true })
      if (prefsJson === undefined) continue // Preferences 파일 자체가 없는 프로필을 흉내
      const content = typeof prefsJson === 'string' ? prefsJson : JSON.stringify(prefsJson)
      writeFileSync(join(profileDir, 'Preferences'), content)
    }
    return userDataDir
  }

  it('Default 프로필에서 매치하면 그 id와 프로필명을 반환한다', () => {
    const extensionDir = '/Users/x/repo/extension'
    const userDataDir = makeUserDataDir({
      Default: { extensions: { settings: { abcid: { path: extensionDir } } } },
    })
    const result = scanChromeProfilesForExtension(extensionDir, { userDataDir })
    expect(result).toEqual([{ id: 'abcid', profiles: ['Default'] }])
  })

  it('여러 Profile N 디렉터리를 스캔하고, 같은 id가 여러 프로필에 있으면 dedupe해서 profiles 배열로 합친다', () => {
    const extensionDir = '/Users/x/repo/extension'
    const userDataDir = makeUserDataDir({
      Default: { extensions: { settings: { abcid: { path: extensionDir } } } },
      'Profile 1': { extensions: { settings: { abcid: { path: extensionDir } } } },
    })
    const result = scanChromeProfilesForExtension(extensionDir, { userDataDir })
    expect(result).toHaveLength(1)
    expect(result[0].id).toBe('abcid')
    expect(result[0].profiles.sort()).toEqual(['Default', 'Profile 1'])
  })

  it('존재하지 않거나 손상된(JSON 파싱 실패) Preferences는 건너뛰고 나머지 프로필은 계속 처리한다', () => {
    const extensionDir = '/Users/x/repo/extension'
    const userDataDir = makeUserDataDir({
      Default: undefined, // Preferences 파일이 아예 없는 경우
      'Profile 1': '{ this is not valid json',
      'Profile 2': { extensions: { settings: { goodid: { path: extensionDir } } } },
    })
    const result = scanChromeProfilesForExtension(extensionDir, { userDataDir })
    expect(result).toEqual([{ id: 'goodid', profiles: ['Profile 2'] }])
  })

  it('아무 데서도 매치하지 않으면 빈 배열을 반환한다', () => {
    const extensionDir = '/Users/x/repo/extension'
    const userDataDir = makeUserDataDir({
      Default: { extensions: { settings: { otherid: { path: '/somewhere/else' } } } },
    })
    expect(scanChromeProfilesForExtension(extensionDir, { userDataDir })).toEqual([])
  })
})
