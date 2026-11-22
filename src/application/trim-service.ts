/**
 * 裁剪用例编排：读压力 → 判断该不该裁 → 交给压缩后端执行。
 *
 * 本服务不实现压缩事务，只消费 `ctx.compaction` 的公开契约（`compactRegion`）。
 * 因此它可以和任意后端搭配：随附的 `dsh-compaction-basic`（摘要检查点），
 * 或本包的 `session-guardian/compaction`（检索检查点）。
 *
 * 两级判定是刻意的：先用「尾部表层事件时间」挡掉绝大多数步（O(1) 到 O(几个
 * 事件)），只有真的可能裁的那一步才做 O(surface) 的测量与区间选择。
 *
 * 区间按「保留最近 N 轮」选，不看 token 预算；`minShadowTokens` 只是「不值得
 * 裁」的下限。保留窗口里的工具结果是否保留，是压缩后端的正文/清理策略
 * （见 `domain/checkpoint.ts` 与 `application/tool-exchange-strip.ts`）。
 *
 * @module session-guardian/application/trim-service
 */

import type { TrimPolicy } from '../domain/trim.ts'
import { isIdle, selectShadowRange } from '../domain/trim.ts'
import {
  lastSurfaceEventTime,
  readSurfaceView,
} from './surface-view.ts'
import type { Agent, CompactionService, TokenMeterService } from '../types.ts'

/** 本服务依赖的外部切片；全部惰性读取，缺失时安静降级。 */
export interface TrimDependencies {
  /** 计量服务；未挂载时返回 undefined。 */
  readonly meter: () => TokenMeterService | undefined
  /** 压缩后端；未挂载时返回 undefined。 */
  readonly compaction: () => CompactionService | undefined
  /** 检索工具是否真的挂载；与 `requireRetrieval` 一起决定要不要裁。 */
  readonly retrieval: () => boolean
  /** 裁剪策略。 */
  readonly policy: TrimPolicy
  /** 当前时刻；便于测试注入。 */
  readonly now: () => number
  /** 诊断日志。 */
  readonly warn: (message: string) => void
}

/** 一次裁剪尝试的结果。 */
export interface TrimOutcome {
  /** 是否真的裁了。 */
  readonly trimmed: boolean
  /** 为什么裁 / 为什么不裁（稳定小写标识，供日志与测试断言）。 */
  readonly reason: 'compacted' | 'not-due' | 'unavailable' | 'empty' | 'cancelled' | 'failed' | 'no-retrieval'
  /** 被移出上下文的估算 token 数（仅成功时有）。 */
  readonly shadowedTokens?: number
}

/** 回到旧会话时把上下文裁小的用例。 */
export class TrimService {
  /**
   * @param dependencies - 外部切片与策略。
   */
  constructor(private readonly dependencies: TrimDependencies) {}

  /**
   * 如果这一轮满足裁剪条件，就裁一次。
   *
   * 失败不向上抛：裁剪是优化，不是请求的前置条件；压缩后端忙、区间不安全、
   * 缩减校验不通过都只应该记一条日志，然后让这一轮照常跑。
   *
   * @param agent - 即将进入请求组装阶段的 Agent。
   * @param signal - 本步的取消信号。
   * @returns 裁剪结果。
   */
  async trimIfNeeded(agent: Agent, signal: AbortSignal): Promise<TrimOutcome> {
    const meter = this.dependencies.meter()
    const compaction = this.dependencies.compaction()
    if (meter === undefined || compaction === undefined) {
      return { trimmed: false, reason: 'unavailable' }
    }
    // 没有检索工具时裁剪等于把历史藏起来却取不回；默认直接跳过。
    if (this.dependencies.policy.requireRetrieval && !this.dependencies.retrieval()) {
      return { trimmed: false, reason: 'no-retrieval' }
    }

    // 先用一次「尾部表层事件」扫描挡掉绝大多数步：量压力是 O(surface) 的，
    // 不该在每一次工具续跑前都跑一遍。
    const now = this.dependencies.now()
    const lastEventTime = lastSurfaceEventTime(agent.session)
    if (lastEventTime === undefined) return { trimmed: false, reason: 'empty' }
    if (!isIdle(lastEventTime, now, this.dependencies.policy.idleMs)) {
      return { trimmed: false, reason: 'not-due' }
    }

    const measurement = meter.measure(agent.session)
    if (measurement.nodes.length === 0) return { trimmed: false, reason: 'empty' }

    const view = readSurfaceView(agent.session, measurement)
    const selection = selectShadowRange(
      view,
      this.dependencies.policy.retainRounds,
      this.dependencies.policy.minShadowTokens,
    )
    if (selection === null) return { trimmed: false, reason: 'not-due' }

    try {
      const result = await compaction.compactRegion(
        selection.start,
        selection.end,
        agent,
        signal,
      )
      return { trimmed: true, reason: 'compacted', shadowedTokens: result.shadowedTokenCount }
    } catch (error: unknown) {
      if (signal.aborted) return { trimmed: false, reason: 'cancelled' }
      const message = error instanceof Error ? error.message : String(error)
      this.dependencies.warn(`context trim skipped: ${message}`)
      return { trimmed: false, reason: 'failed' }
    }
  }
}
