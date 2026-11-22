import { describe, expect, it } from 'vitest'
import { stripToolExchanges } from '../src/application/tool-exchange-strip.ts'
import type { ContentBlock, Session, SessionEvent } from '../src/types.ts'

/** 一次 append 的记录。 */
interface AppendCall {
  readonly type: string
  readonly data: unknown
  readonly options: unknown
}

/**
 * 造一个假会话；表层顺序就是事件顺序。
 * @param events - 初始事件。
 * @returns 假会话与 append 记录。
 */
function buildSession(events: SessionEvent[]): { session: Session; appended: AppendCall[] } {
  const appended: AppendCall[] = []
  const session: Session = {
    id: 's-1',
    header: { id: 's-1' },
    inheritedEventCount: 0,
    get seq() { return events.length },
    get surface() { return { nodes: events.map(event => event.seq) } },
    ownEvents: () => events,
    eventAt: target => events[target],
    append: (type, data, options) => {
      appended.push({ type, data, options })
      const event: SessionEvent = { type, seq: events.length, time: 0, data }
      events.push(event)
      return event
    },
    requestHeader: () => undefined,
  }
  return { session, appended }
}

/**
 * 造一条带工具调用的 assistant 消息。
 * @param seq - 事件序号。
 * @param content - 内容块。
 * @returns 事件。
 */
function assistant(seq: number, content: ContentBlock[]): SessionEvent {
  return {
    type: 'assistant/message',
    seq,
    time: 0,
    data: {
      turn: 1,
      step: 1,
      message: {
        id: `a-${seq}`,
        role: 'assistant',
        source: { kind: 'model', provider: 'p', model: 'm' },
        content,
      },
    },
  }
}

/**
 * 造一条工具结果。
 * @param seq - 事件序号。
 * @returns 事件。
 */
function toolResult(seq: number): SessionEvent {
  return {
    type: 'tool/result',
    seq,
    time: 0,
    data: {
      message: {
        id: `t-${seq}`,
        role: 'tool',
        source: { kind: 'tool', callId: `call-${seq}` },
        content: [{ type: 'text', text: 'output' }],
      },
    },
  }
}

/**
 * 造一条用户消息。
 * @param seq - 事件序号。
 * @param text - 正文。
 * @returns 事件。
 */
function user(seq: number, text = 'hello'): SessionEvent {
  return {
    type: 'user/message',
    seq,
    time: 0,
    data: { id: `u-${seq}`, role: 'user', content: [{ type: 'text', text }], source: { kind: 'user' } },
  }
}

/** 一个 tool-call 内容块。 */
const CALL: ContentBlock = { type: 'tool-call', id: 'call-1', name: 'read', arguments: '{}' }

describe('stripToolExchanges', () => {
  it('把调用消息和它的结果整段换成空 system 节点', () => {
    const { session, appended } = buildSession([
      user(0),
      assistant(1, [CALL]),
      toolResult(2),
      user(3),
    ])
    const outcome = stripToolExchanges(session, 0)
    expect(outcome.stripped).toBe(1)
    expect(appended).toHaveLength(1)
    expect(appended[0]?.type).toBe('system/message')
    const data = appended[0]?.data as { message: { content: ContentBlock[] } }
    expect(data.message.content).toEqual([])
    expect(appended[0]?.options).toMatchObject({
      surfaceOp: { op: 'replace', startSeq: 1, endSeq: 2 },
      sourceEventSeqs: [1, 2],
    })
  })

  it('没有工具调用的 assistant 消息不动', () => {
    const { session, appended } = buildSession([
      user(0),
      assistant(1, [{ type: 'text', text: '普通回复' }]),
      user(2),
    ])
    expect(stripToolExchanges(session, 0).stripped).toBe(0)
    expect(appended).toHaveLength(0)
  })

  it('连续两段交换都处理', () => {
    const { session, appended } = buildSession([
      user(0),
      assistant(1, [CALL]),
      toolResult(2),
      assistant(3, [CALL]),
      toolResult(4),
    ])
    expect(stripToolExchanges(session, 0).stripped).toBe(2)
    expect(appended.map(call => call.options)).toEqual([
      { surfaceOp: { op: 'replace', startSeq: 1, endSeq: 2 }, sourceEventSeqs: [1, 2] },
      { surfaceOp: { op: 'replace', startSeq: 3, endSeq: 4 }, sourceEventSeqs: [3, 4] },
    ])
  })

  it('调用后面没有结果时只移除调用消息', () => {
    const { session, appended } = buildSession([user(0), assistant(1, [CALL])])
    expect(stripToolExchanges(session, 0).stripped).toBe(1)
    expect(appended[0]?.options).toMatchObject({
      surfaceOp: { op: 'replace', startSeq: 1, endSeq: 1 },
      sourceEventSeqs: [1],
    })
  })

  it('检查点之前的节点不动', () => {
    const { session, appended } = buildSession([
      assistant(0, [CALL]),
      toolResult(1),
      user(2),
    ])
    expect(stripToolExchanges(session, 2).stripped).toBe(0)
    expect(appended).toHaveLength(0)
  })

  it('缺少回合坐标时跳过并记警告', () => {
    const broken: SessionEvent = {
      type: 'assistant/message',
      seq: 1,
      time: 0,
      data: { message: { role: 'assistant', content: [CALL] } },
    }
    const { session, appended } = buildSession([user(0), broken])
    const warnings: string[] = []
    expect(stripToolExchanges(session, 0, message => warnings.push(message)).stripped).toBe(0)
    expect(appended).toHaveLength(0)
    expect(warnings[0]).toContain('turn/step')
  })
})
