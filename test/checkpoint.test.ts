import { describe, expect, it } from 'vitest'
import { buildCheckpointNotice } from '../src/domain/checkpoint.ts'

/** 一处普通的被遮蔽区间。 */
const INPUT = {
  sessionId: 's-1',
  start: 12,
  end: 87,
  shadowedTokens: 18_400,
}

describe('buildCheckpointNotice', () => {
  it('给出当前会话的检索方式与移除量', () => {
    const text = buildCheckpointNotice(INPUT, { retrieval: true })
    expect(text).toContain('about 18400 tokens')
    expect(text).toContain('session_event_search')
    expect(text).toContain('surfaces: ["shadowed"]')
    expect(text).toContain('session_event_read(<seq>)')
  })

  it('只有固定说明，不生成历史目录', () => {
    const text = buildCheckpointNotice(INPUT, { retrieval: true })
    expect(text).not.toContain('Trimmed history index')
    expect(text.split('\n').every(line => !line.startsWith('- ['))).toBe(true)
    // 大小基本恒定：带检索指引时约 840 字符。
    expect(text.length).toBeLessThan(900)
  })

  it('检索工具不在场时不点名工具', () => {
    const text = buildCheckpointNotice(INPUT, { retrieval: false })
    expect(text).not.toContain('session_event_search')
    expect(text).toContain('No history-search tool is mounted')
  })

  it('默认不假设检索能力', () => {
    const text = buildCheckpointNotice(INPUT)
    expect(text).not.toContain('session_event_search')
  })
})
