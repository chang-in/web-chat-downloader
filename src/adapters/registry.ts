import type { NormalizedChat } from './types.js'
import { claudeAdapter } from './claude.js'
import { chatgptAdapter } from './chatgpt.js'
import { geminiAdapter } from './gemini.js'

export type Adapter = {
  service: 'claude' | 'chatgpt' | 'gemini'
  detect(raw: unknown): boolean
  normalize(raw: any): NormalizedChat
}

const adapters: Adapter[] = [claudeAdapter, chatgptAdapter, geminiAdapter]

export function detectAdapter(raw: unknown): Adapter | null {
  return adapters.find(a => a.detect(raw)) ?? null
}

export function registerAdapters(list: Adapter[]) {
  adapters.push(...list)
}
