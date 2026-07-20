import { describe, it, expect } from 'vitest'
import { mkdtempSync, readFileSync, statSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { buildManifest, installHost } from '../src/install-host'

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
