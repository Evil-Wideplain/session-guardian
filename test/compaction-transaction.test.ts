import { describe, expect, it } from 'vitest'
import { runCompactionTransaction } from '../src/application/compaction-transaction.ts'
import type { CompactionTransactionDependencies } from '../src/application/compaction-transaction.ts'
import type { Session, SessionEvent, TokenMeasurement, TokenMeterService } from '../src/types.ts'

/**
 * 一个只实现事务需要的那部分行为的假会话。
 *
 * 表层维护与 `session.append` 的契约一致：`'append'` 追加，
 * `{ op: 'replace', startSeq, endSeq }` 把当前表层里的那段位置换成一个新节点。
 */
class FakeSession implements Session {
  readonly id = 's-1'
  readonly header = { id: 's-1' }
  readonly inheritedEventCount = 0
  private readonly events: SessionEvent[] = []
  private readonly nodes: number[] = []

  get seq(): number {
    return this.events.length
  }

  get surface(): { readonly nodes: readonly number[] } {
    return { nodes: this.nodes }
  }

  ownEvents(): readonly SessionEvent[] {
    return this.events
  }

  eventAt(seq: number): SessionEvent | undefined {
    return this.events[seq]
  }

  append(
    type: string,
    data: unknown,
    options?: {
      surfaceOp?: 'append' | { op: 'replace'; startSeq: number; endSeq: number }
      sourceEventSeqs?: readonly number[]
    },
  ): SessionEvent {
    const event: SessionEvent = { type, seq: this.events.length, time: 1_000, data }
    this.events.push(event)
    const op = options?.surfaceOp
    if (op === 'append') {
      this.nodes.push(event.seq)
    } else if (op !== undefined && typeof op === 'object') {
      const startIndex = this.nodes.indexOf(op.startSeq)
      const endIndex = this.nodes.indexOf(op.endSeq)
      if (startIndex < 0 || endIndex < startIndex) throw new Error('bad replace range')
      this.nodes.splice(startIndex, endIndex - startIndex + 1, event.seq)
    }
    return event
  }

  requestHeader(): { readonly config: { readonly provider: string; readonly model: string } } {
    return { config: { provider: 'p', model: 'm' } }
  }
}

/**
 * 从事件载荷里读一个固定的估算价格。
 * @param data - 事件载荷。
 * @returns token 数。
 */
function tokensOf(data: unknown): number {
  const value = data as { readonly tokens?: unknown } | undefined
  return typeof value?.tokens === 'number' ? value.tokens : 0
}

/** 与假会话配套的计量服务：价格来自载荷里的 `tokens` 字段。 */
const meter: TokenMeterService = {
  measure(session: Session): TokenMeasurement {
    const nodes = session.surface.nodes.map(seq => ({
      seq,
      heuristicTokens: tokensOf(session.eventAt(seq)?.data),
    }))
    const total = nodes.reduce((sum, node) => sum + node.heuristicTokens, 0)
    return { totalTokens: total, surfaceTokens: total, nodes }
  },
  estimateMessage(message): number {
    return Math.ceil(JSON.stringify(message.content).length / 4) + 4
  },
}

/**
 * 造一组事务依赖：压力快照在调用前测好，与生产路径一致。
 * @param session - 目标会话。
 * @param buildCheckpoint - 检查点正文构造器。
 * @returns 事务依赖。
 */
function transactionDeps(
  session: Session,
  buildCheckpoint: CompactionTransactionDependencies['buildCheckpoint'],
): CompactionTransactionDependencies {
  return { meter, measurement: meter.measure(session), buildCheckpoint }
}

/**
 * 造一个已经打开回合、带系统提示词和四条用户消息的会话。
 * @returns 假会话。
 */
function buildSession(): FakeSession {
  const session = new FakeSession()
  session.append('turn/start', { turn: 7 })
  session.append('system/message', {
    turn: 7,
    step: 1,
    message: { role: 'system', content: [{ type: 'text', text: 'sys' }] },
  }, { surfaceOp: 'append' })
  for (let index = 0; index < 4; index += 1) {
    session.append('user/message', {
      id: `u-${index}`,
      role: 'user',
      content: [{ type: 'text', text: `message ${index}` }],
      source: { kind: 'user' },
      tokens: 5_000,
    }, { surfaceOp: 'append' })
  }
  return session
}

describe('runCompactionTransaction', () => {
  it('写四个事件，把被遮蔽区间替换成一条检查点消息', () => {
    const session = buildSession()
    const result = runCompactionTransaction(
      transactionDeps(session, input => [
        { type: 'text', text: `trimmed ${input.start}-${input.end}` },
      ]),
      session,
      { start: 2, end: 4 },
    )

    expect(result.shadowedSeqs).toEqual([2, 3, 4])
    expect(result.shadowedTokenCount).toBe(15_000)
    expect(session.ownEvents().map(event => event.type)).toEqual([
      'turn/start',
      'system/message',
      'user/message',
      'user/message',
      'user/message',
      'user/message',
      'compaction/start',
      'compaction/summary',
      'user/message',
      'compaction/end',
    ])
    // 表层：系统提示词、检查点、保留下来的最后一条用户消息。
    expect(session.surface.nodes).toEqual([1, 8, 5])

    const checkpoint = session.eventAt(8)?.data as {
      readonly role: string
      readonly source: { readonly kind: string }
    }
    expect(checkpoint.role).toBe('user')
    expect(checkpoint.source.kind).toBe('compact-checkpoint')
  })

  it('summary 事件带足计量与回溯字段', () => {
    const session = buildSession()
    runCompactionTransaction(
      transactionDeps(session, () => [{ type: 'text', text: 'index' }]),
      session,
      { start: 2, end: 4 },
    )
    const summary = session.eventAt(7)?.data as {
      readonly shadowedRange: { readonly start: number; readonly end: number }
      readonly shadowedSeqs: readonly number[]
      readonly shadowedTokenCount: number
      readonly provider: string
      readonly model: string
    }
    expect(summary.shadowedRange).toEqual({ start: 2, end: 4 })
    expect(summary.shadowedSeqs).toEqual([2, 3, 4])
    expect(summary.shadowedTokenCount).toBe(15_000)
    expect(summary.provider).toBe('session-guardian')
    expect(summary.model).toBe('retrieval-digest')
  })

  it('检查点没有变小时拒绝提交', () => {
    const session = buildSession()
    expect(() => runCompactionTransaction(
      transactionDeps(session, () => [{ type: 'text', text: 'x'.repeat(80_000) }]),
      session,
      { start: 2, end: 4 },
    )).toThrow(/not smaller/)
    // 没有写过任何压缩事件。
    expect(session.ownEvents().map(event => event.type)).not.toContain('compaction/start')
  })

  it('活动锁存在时拒绝新事务', () => {
    const session = buildSession()
    session.append('compaction/start', { compactionId: 'c-1', turn: 7 })
    expect(() => runCompactionTransaction(
      transactionDeps(session, () => [{ type: 'text', text: 'index' }]),
      session,
      { start: 2, end: 4 },
    )).toThrow(/already active/)
  })

  it('没有打开的回合时拒绝', () => {
    const session = buildSession()
    session.append('turn/end', { turn: 7, reason: { kind: 'completed' } })
    expect(() => runCompactionTransaction(
      transactionDeps(session, () => [{ type: 'text', text: 'index' }]),
      session,
      { start: 2, end: 4 },
    )).toThrow(/no open turn/)
  })

  it('系统提示词头节点不能被遮蔽', () => {
    const session = buildSession()
    expect(() => runCompactionTransaction(
      transactionDeps(session, () => [{ type: 'text', text: 'index' }]),
      session,
      { start: 1, end: 4 },
    )).toThrow(/system prompt head/)
  })
})
