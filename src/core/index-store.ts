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
