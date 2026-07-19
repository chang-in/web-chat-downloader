import http from 'http'
import { detectAdapter } from './adapters/registry'
import { writeSession } from './core/session-writer'
import { resolveSessionId, upsertIndex } from './core/index-store'

export function handleCapture(raw: unknown, cwd: string): { sessionId: string } | { error: string } {
  const adapter = detectAdapter(raw)
  if (!adapter) return { error: 'unrecognized chat payload (지원: claude/chatgpt/gemini)' }
  let chat
  try { chat = adapter.normalize(raw as any) }
  catch (e) { return { error: `normalize failed: ${(e as Error).message}` } }

  const existing = resolveSessionId(cwd, chat.externalId)
  const res = writeSession(chat, { cwd, sessionId: existing ?? undefined })
  if ('error' in res) return res
  upsertIndex(cwd, chat.externalId, { sessionId: res.sessionId, service: chat.service, title: chat.title, capturedAt: Date.now() })
  return res
}

export function startServer(opts: { port: number; cwd: string }): http.Server {
  const server = http.createServer((req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*')      // 북마클릿 POST 허용
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type')
    if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return }
    if (req.method !== 'POST') { res.writeHead(405); res.end(); return }
    let body = ''
    req.on('data', c => { body += c; if (body.length > 50 * 1024 * 1024) req.destroy() }) // 50MB 상한
    req.on('end', () => {
      let raw: unknown
      try { raw = JSON.parse(body) } catch { res.writeHead(400); res.end(JSON.stringify({ error: 'invalid JSON' })); return }
      const out = handleCapture(raw, opts.cwd)
      const status = 'error' in out ? 422 : 200
      res.writeHead(status, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify(out))
      if ('sessionId' in out) console.log(`✔ 저장: ${out.sessionId}  → cd ${opts.cwd} && claude --resume ${out.sessionId}`)
      else console.error(`✘ ${out.error}`)
    })
  })
  return server.listen(opts.port, '127.0.0.1')
}
