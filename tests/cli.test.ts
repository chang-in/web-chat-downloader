import { describe, it, expect } from 'vitest'
import { parseArgs } from '../src/cli'

describe('parseArgs', () => {
  it('기본값은 host(Chrome이 인자 없이 실행)', () => {
    const o = parseArgs([])
    expect(o.cmd).toBe('host')
    expect(o.extensionId).toBeUndefined()
  })
  it('host 명시', () => {
    const o = parseArgs(['host'])
    expect(o.cmd).toBe('host')
  })
  it('install-host <extensionId>', () => {
    const o = parseArgs(['install-host', 'abcdefghijklmnopabcdefghijklmnop'])
    expect(o.cmd).toBe('install-host')
    expect(o.extensionId).toBe('abcdefghijklmnopabcdefghijklmnop')
  })
})
