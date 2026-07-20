import { execFileSync } from 'child_process'

// `codex --version` 출력은 "codex-cli 0.144.1" 형태(claude와 달리 앞에 바이너리명이 붙는다) —
// 그래서 claude-version.ts의 parseVersion(첫 토큰)을 그대로 못 쓰고 마지막 토큰을 취한다(실측).
export function parseCodexVersion(raw: string): string {
  const tokens = raw.trim().split(/\s+/)
  return tokens[tokens.length - 1] || '0.0.0'
}

let cached: string | null = null
export function readCodexVersion(): string {
  if (cached) return cached
  try {
    cached = parseCodexVersion(execFileSync('codex', ['--version'], { encoding: 'utf-8', timeout: 5000 }))
  } catch {
    cached = '0.0.0'
  }
  return cached
}
