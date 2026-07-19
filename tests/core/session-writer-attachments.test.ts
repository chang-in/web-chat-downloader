import { describe, it, expect } from 'vitest'
import { mkdtempSync, readFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { writeSession } from '../../src/core/session-writer'
import type { NormalizedChat } from '../../src/adapters/types'

const img = Buffer.from('PNGDATA').toString('base64')
const pdf = Buffer.from('PDFDATA').toString('base64')

describe('writeSession attachments', () => {
  it('이미지는 user content에 image 블록으로 임베드', () => {
    const dir = mkdtempSync(join(tmpdir(), 'wcd-'))
    const chat: NormalizedChat = { service:'claude', externalId:'e', title:'t', messages:[
      { role:'user', text:'이 사진 봐', ts:1, attachments:[{ filename:'a.png', mediaType:'image/png', data: img }] },
      { role:'assistant', text:'봤어', ts:2 },
    ]}
    const r = writeSession(chat, { cwd:'/tmp/wt', dirOverride: dir }) as any
    const u = readFileSync(join(dir, `${r.sessionId}.jsonl`),'utf-8').trim().split('\n').map(l=>JSON.parse(l))[0]
    expect(Array.isArray(u.message.content)).toBe(true)
    const imgBlock = u.message.content.find((b:any)=>b.type==='image')
    expect(imgBlock.source).toMatchObject({ type:'base64', media_type:'image/png' })
    expect(imgBlock.source.data).toBe(img)
  })
  it('비이미지 파일은 저장 + 텍스트 마커', () => {
    const dir = mkdtempSync(join(tmpdir(), 'wcd-'))
    const chat: NormalizedChat = { service:'claude', externalId:'e', title:'t', messages:[
      { role:'user', text:'문서 첨부', ts:1, attachments:[{ filename:'doc.pdf', mediaType:'application/pdf', data: pdf }] },
      { role:'assistant', text:'ok', ts:2 },
    ]}
    const r = writeSession(chat, { cwd:'/tmp/wt', dirOverride: dir }) as any
    const u = readFileSync(join(dir, `${r.sessionId}.jsonl`),'utf-8').trim().split('\n').map(l=>JSON.parse(l))[0]
    const content = typeof u.message.content === 'string' ? u.message.content : u.message.content.map((b:any)=>b.text||'').join('')
    expect(content).toContain('[첨부: doc.pdf')
    expect(content).toContain('attachments/')
  })
})
