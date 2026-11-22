import { describe, expect, it } from 'vitest'
import type { SurfaceNodeView } from '../src/domain/trim.ts'
import { isIdle, selectShadowRange } from '../src/domain/trim.ts'

/**
 * 造一个表层节点。
 * @param seq - 事件序号。
 * @param overrides - 覆盖字段。
 * @returns 节点视图。
 */
function node(seq: number, overrides: Partial<SurfaceNodeView> = {}): SurfaceNodeView {
  return {
    seq,
    tokens: 5_000,
    type: 'assistant/message',
    time: 0,
    toolCallDelta: 0,
    roundAnchor: false,
    ...overrides,
  }
}

/**
 * 造一轮：用户消息 + 助手回复。
 * @param seq - 用户消息的事件序号。
 * @returns 两个节点。
 */
function round(seq: number): [SurfaceNodeView, SurfaceNodeView] {
  return [
    node(seq, { type: 'user/message', roundAnchor: true }),
    node(seq + 1),
  ]
}

describe('selectShadowRange', () => {
  it('保留最近 N 轮，并跳过开头的系统提示词', () => {
    const nodes = [
      node(0, { type: 'system/message', tokens: 1_000 }),
      ...round(1), ...round(3), ...round(5), ...round(7),
    ]
    const selection = selectShadowRange(nodes, 2, 1_000)
    expect(selection).not.toBeNull()
    expect(selection?.start).toBe(1)
    // 保留第 3、4 轮（锚点 5、7），遮蔽前两轮。
    expect(selection?.end).toBe(4)
    expect(selection?.retainedFrom).toBe(5)
    expect(selection?.shadowedTokens).toBe(20_000)
    expect(selection?.retainedTokens).toBe(20_000)
    expect(selection?.retainedRounds).toBe(2)
  })

  it('检查点消息不算一轮', () => {
    const nodes = [
      node(0, { type: 'system/message', tokens: 100 }),
      // 之前裁剪留下的检查点：user 角色，但不是用户说的话。
      node(1, { type: 'user/message', roundAnchor: false }),
      ...round(2), ...round(4), ...round(6),
    ]
    const selection = selectShadowRange(nodes, 2, 1_000)
    expect(selection).not.toBeNull()
    // 锚点是 2、4、6；保留后两轮，检查点跟着前一区段一起被遮蔽。
    expect(selection?.end).toBe(3)
    expect(selection?.retainedFrom).toBe(4)
    expect(selection?.retainedRounds).toBe(2)
  })

  it('锚点处工具调用未闭合时向左多留一轮', () => {
    const nodes = [
      node(0, { type: 'system/message', tokens: 100 }),
      ...round(1),
      node(3, { type: 'user/message', roundAnchor: true }),
      node(4, { toolCallDelta: 1 }),
      // 用户消息插在了工具调用与结果之间：切在这里会劈开配对。
      node(5, { type: 'user/message', roundAnchor: true }),
      node(6, { type: 'tool/result', toolCallDelta: -1 }),
      ...round(7), ...round(9),
    ]
    const selection = selectShadowRange(nodes, 3, 1_000)
    expect(selection).not.toBeNull()
    // 原切点 5 处余额为 +1，向左退到锚点 3；实际保留 4 轮。
    expect(selection?.retainedFrom).toBe(3)
    expect(selection?.retainedRounds).toBe(4)
    expect(selection?.end).toBe(2)
  })

  it('轮次不够时不裁', () => {
    const nodes = [
      node(0, { type: 'system/message', tokens: 100 }),
      ...round(1), ...round(3),
    ]
    expect(selectShadowRange(nodes, 3, 1)).toBeNull()
  })

  it('retainRounds=0 时整层遮蔽，只留系统提示词', () => {
    const nodes = [
      node(0, { type: 'system/message', tokens: 100 }),
      ...round(1), ...round(3),
    ]
    const selection = selectShadowRange(nodes, 0, 1)
    expect(selection).not.toBeNull()
    expect(selection?.start).toBe(1)
    expect(selection?.end).toBe(4)
    expect(selection?.retainedFrom).toBe(5)
    expect(selection?.retainedRounds).toBe(0)
    expect(selection?.retainedTokens).toBe(0)
    expect(selection?.shadowedTokens).toBe(20_000)
  })

  it('retainRounds=0 但尾部有未闭合的工具调用时不裁', () => {
    const nodes = [
      node(0, { type: 'system/message', tokens: 100 }),
      ...round(1),
      node(3, { type: 'assistant/message', toolCallDelta: 1 }),
    ]
    expect(selectShadowRange(nodes, 0, 1)).toBeNull()
  })

  it('遮蔽量不足时返回 null', () => {
    const nodes = [
      node(0, { type: 'system/message', tokens: 100 }),
      ...round(1), ...round(3),
    ]
    expect(selectShadowRange(nodes, 1, 100_000)).toBeNull()
  })

  it('全都是系统提示词时不裁', () => {
    const nodes = [node(0, { type: 'system/message', tokens: 1_000 })]
    expect(selectShadowRange(nodes, 1, 1)).toBeNull()
  })
})

describe('isIdle', () => {
  it('未达到空闲阈值时不触发', () => {
    expect(isIdle(1_000, 1_000 + 60_000, 1_800_000)).toBe(false)
  })

  it('达到空闲阈值时触发', () => {
    expect(isIdle(0, 2_000_000, 1_800_000)).toBe(true)
  })

  it('阈值 <= 0 时不按空闲触发', () => {
    expect(isIdle(0, 2_000_000, 0)).toBe(false)
  })
})
