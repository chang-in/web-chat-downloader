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
