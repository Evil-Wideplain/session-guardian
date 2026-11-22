import { describe, expect, it } from 'vitest'
import { TrimService } from '../src/application/trim-service.ts'
import type { Agent, CompactionResult, Session, SessionEvent, TokenMeasurement } from '../src/types.ts'

/**
 * 造一个只含表层事件的会话：系统提示词 + 三条用户消息。
 * @param lastTime - 最后一条表层事件的时刻。
 * @returns 假会话。
 */
function buildSession(lastTime: number): Session {
  const events: SessionEvent[] = []
  let seq = 0
  const push = (type: string, data: unknown, time: number): void => {
    events.push({ type, seq: seq++, time, data })
  }
  push('system/message', { message: { role: 'system', content: [{ type: 'text', text: 'sys' }] } }, 0)
  push('user/message', { id: 'u-1', role: 'user', content: [{ type: 'text', text: 'one' }], source: { kind: 'user' } }, lastTime - 3_000)
  push('user/message', { id: 'u-2', role: 'user', content: [{ type: 'text', text: 'two' }], source: { kind: 'user' } }, lastTime - 2_000)
  push('user/message', { id: 'u-3', role: 'user', content: [{ type: 'text', text: 'three' }], source: { kind: 'user' } }, lastTime)
  return {
    id: 's-1',
    header: { id: 's-1' },
    inheritedEventCount: 0,
    seq: events.length,
    surface: { nodes: events.map(event => event.seq) },
    ownEvents: () => events,
    eventAt: target => events[target],
    append: () => { throw new Error('not used') },
    requestHeader: () => ({ config: { provider: 'p', model: 'm' } }),
  }
}

/** 与上面假会话配套的计量：每条消息 10_000 token。 */
const meter = {
  measure: (session: Session): TokenMeasurement => {
    const nodes = session.surface.nodes.map(seq => ({ seq, heuristicTokens: 10_000 }))
    return { totalTokens: 40_000, surfaceTokens: 40_000, nodes }
  },
  estimateMessage: (): number => 10,
}

/** follower：把裁剪调用记下来。 */
function buildCompaction(behaviour: 'ok' | 'boom'): {
  calls: Array<{ start: number; end: number }>
  service: { compactRegion: (start: number, end: number, agent: Agent, signal?: AbortSignal) => Promise<CompactionResult> }
} {
  const calls: Array<{ start: number; end: number }> = []
  return {
    calls,
    service: {
      async compactRegion(start, end) {
        calls.push({ start, end })
        if (behaviour === 'boom') throw new Error('backend busy')
        return {
          compactionId: 'c-1',
          startSeq: 4,
          summarySeq: 5,
          endSeq: 7,
          summary: [{ type: 'text', text: 'checkpoint' }],
          shadowedRange: { start, end },
          shadowedSeqs: [1, 2],
          shadowedTokenCount: 20_000,
        }
      },
    },
  }
}

/**
 * 把最小切片断言成 Agent：裁剪只读 `agent.session`。
 * @param session - 假会话。
 * @returns 假 Agent。
 */
function agentOf(session: Session): Agent {
  return { id: session.id, session } as unknown as Agent
}

describe('TrimService', () => {
  it('未空闲时不测量也不裁', async () => {
    const session = buildSession(1_000)
    const compaction = buildCompaction('ok')
    let measured = 0
    const countingMeter = {
      measure: (target: Session): TokenMeasurement => { measured += 1; return meter.measure(target) },
      estimateMessage: meter.estimateMessage,
    }
    const service = new TrimService({
      meter: () => countingMeter,
      compaction: () => compaction.service,
      retrieval: () => true,
      policy: { idleMs: 1_800_000, retainRounds: 2, minShadowTokens: 6_000, requireRetrieval: true },
      now: () => 2_000,
      warn: () => {},
    })
    const outcome = await service.trimIfNeeded(agentOf(session), new AbortController().signal)
    expect(outcome).toEqual({ trimmed: false, reason: 'not-due' })
    expect(measured).toBe(0)
    expect(compaction.calls).toHaveLength(0)
  })

  it('空闲时保留最近 N 轮，把更早的交给压缩后端', async () => {
    const session = buildSession(1_000)
    const compaction = buildCompaction('ok')
    const service = new TrimService({
      meter: () => meter,
      compaction: () => compaction.service,
      retrieval: () => true,
      policy: { idleMs: 60_000, retainRounds: 2, minShadowTokens: 6_000, requireRetrieval: true },
      now: () => 10_000_000,
      warn: () => {},
    })
    const outcome = await service.trimIfNeeded(agentOf(session), new AbortController().signal)
    expect(outcome).toEqual({ trimmed: true, reason: 'compacted', shadowedTokens: 20_000 })
    // 系统提示词被跳过；保留后两轮，区间是第 1 轮。
    expect(compaction.calls).toEqual([{ start: 1, end: 1 }])
  })

  it('retainRounds=0 时整层交给压缩后端', async () => {
    const session = buildSession(1_000)
    const compaction = buildCompaction('ok')
    const service = new TrimService({
      meter: () => meter,
      compaction: () => compaction.service,
      retrieval: () => true,
      policy: { idleMs: 60_000, retainRounds: 0, minShadowTokens: 6_000, requireRetrieval: true },
      now: () => 10_000_000,
      warn: () => {},
    })
    const outcome = await service.trimIfNeeded(agentOf(session), new AbortController().signal)
    expect(outcome.trimmed).toBe(true)
    // 系统提示词之后的全部内容都被遮蔽。
    expect(compaction.calls).toEqual([{ start: 1, end: 3 }])
  })

  it('检索工具不在场时跳过裁剪', async () => {
    const session = buildSession(1_000)
    const compaction = buildCompaction('ok')
    const service = new TrimService({
      meter: () => meter,
      compaction: () => compaction.service,
      retrieval: () => false,
      policy: { idleMs: 60_000, retainRounds: 0, minShadowTokens: 6_000, requireRetrieval: true },
      now: () => 10_000_000,
      warn: () => {},
    })
    const outcome = await service.trimIfNeeded(agentOf(session), new AbortController().signal)
    expect(outcome).toEqual({ trimmed: false, reason: 'no-retrieval' })
    expect(compaction.calls).toHaveLength(0)
  })

  it('后端失败时只记日志，不向上抛', async () => {
    const session = buildSession(1_000)
    const compaction = buildCompaction('boom')
    const warnings: string[] = []
    const service = new TrimService({
      meter: () => meter,
      compaction: () => compaction.service,
      retrieval: () => true,
      policy: { idleMs: 60_000, retainRounds: 2, minShadowTokens: 6_000, requireRetrieval: true },
      now: () => 10_000_000,
      warn: message => warnings.push(message),
    })
    const outcome = await service.trimIfNeeded(agentOf(session), new AbortController().signal)
    expect(outcome).toEqual({ trimmed: false, reason: 'failed' })
    expect(warnings[0]).toContain('backend busy')
  })
})
