#!/usr/bin/env node
import { homedir } from 'os'
import { join } from 'path'
import { mkdirSync } from 'fs'
import { startServer } from './server'

export function parseArgs(argv: string[]): { cmd: string; port: number; cwd: string } {
  const cmd = argv[0] ?? 'serve'
  let port = 8787
  let cwd = join(homedir(), 'Desktop', 'Archive', 'web-chats')
  for (let i = 1; i < argv.length; i++) {
    if (argv[i] === '--port') port = Number(argv[++i])
    else if (argv[i] === '--into') cwd = argv[++i]
  }
  return { cmd, port, cwd }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const { cmd, port, cwd } = parseArgs(process.argv.slice(2))
  if (cmd !== 'serve') { console.error('usage: web-chat-downloader serve [--port N] [--into PATH]'); process.exit(1) }
  mkdirSync(cwd, { recursive: true })
  startServer({ port, cwd })
  console.log(`web-chat-downloader 수신 대기: http://127.0.0.1:${port}  → 저장: ${cwd}`)
}
