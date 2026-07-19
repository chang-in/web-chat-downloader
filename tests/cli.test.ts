import { describe, it, expect } from 'vitest'
import { parseArgs } from '../src/cli'

describe('parseArgs', () => {
  it('기본값', () => {
    const o = parseArgs(['serve'])
    expect(o.cmd).toBe('serve'); expect(o.port).toBe(8787)
    expect(o.cwd.endsWith('/Desktop/Archive/web-chats')).toBe(true)
  })
  it('--port/--into 오버라이드', () => {
    const o = parseArgs(['serve','--port','9000','--into','/tmp/x'])
    expect(o.port).toBe(9000); expect(o.cwd).toBe('/tmp/x')
  })
})
