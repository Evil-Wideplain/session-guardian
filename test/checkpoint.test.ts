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

  it('配置模板可覆盖正文并展开区间占位符', () => {
    const text = buildCheckpointNotice(INPUT, {
      retrieval: true,
      template: '会话 {sessionId}：{start}-{end}，移出 {shadowedTokens} token。\n{retrievalGuide}',
    })
    expect(text).toContain('会话 s-1：12-87，移出 18400 token。')
    expect(text).toContain('session_event_search')
    expect(text).not.toContain('[context-trim]')
  })

  it('模板不写 retrievalGuide 时不自动插入检索说明', () => {
    const text = buildCheckpointNotice(INPUT, {
      retrieval: true,
      template: '已裁 {shadowedTokens} token',
    })
    expect(text).toBe('已裁 18400 token')
  })

  it('retrievalGuide 按检索能力展开', () => {
    const withTool = buildCheckpointNotice(INPUT, { retrieval: true, template: '{retrievalGuide}' })
    const withoutTool = buildCheckpointNotice(INPUT, { retrieval: false, template: '{retrievalGuide}' })
    expect(withTool).toContain('session_event_search')
    expect(withoutTool).toContain('No history-search tool is mounted')
  })

  it('空白模板回落到默认正文', () => {
    const text = buildCheckpointNotice(INPUT, { template: '   \n' })
    expect(text).toBe(buildCheckpointNotice(INPUT))
    expect(text).toContain('[context-trim]')
  })
})
