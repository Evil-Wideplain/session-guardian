/**
 * 检索式压缩后端：`ctx.compaction` 的一个实现，用「固定说明 + 检索指针」代替模型摘要。
 *
 * ## 为什么不是摘要
 *
 * 随附后端 `dsh-compaction-basic` 的摘要是一次**回放整个前缀的模型调用**，它的
 * 设计前提是复用提供方的热前缀。上下文裁剪恰恰发生在缓存已经冷的时候——那时
 * 这次摘要调用本身就是一次全价重放，和直接继续对话一样贵。本后端不调用模型：
 * 它写一条确定性的检查点消息，告诉模型「这段历史被移出了上下文，但还在日志里，
 * 用 session_event_search 取回」。
 *
 * ## 契约
 *
 * 三个操作与 `dsh-compaction` seam 完全一致（`compactIfNeeded` /
 * `compactNow` / `compactRegion`）；成功时同样写
 * `compaction/start` → `compaction/summary` → 一条带 `surfaceOp: replace` 的
 * `user/message` → `compaction/end`。检查点消息的 source 是
 * `{ kind: 'compact-checkpoint', compactionId }`，与随附后端可互换。
 * 事务本身在 `application/compaction-transaction.ts`，可脱离 Cordis 单测。
 *
 * ## 工具记录
 *
 * `keepToolRecords: false` 时，压缩成功后把保留窗口里每段「带 tool-call 的
 * assistant 消息 + 其结果」整段替换成空 content 的 `system/message`（派生历史
 * 为 null，不进入请求，也没有占位文本）。见
 * `application/tool-exchange-strip.ts`。
 *
 * ## 扩展点
 *
 * - {@link RetrievalCompactionEngine.buildCheckpoint}：正文怎么写（默认固定说明）；
 * - {@link RetrievalCompactionEngine.selectRange}：裁到哪里（默认保留最近 N 轮）。
 *
 * ## 与随附后端的关系
 *
 * 一个上下文只能有一个 `ctx.compaction`。启用本行之前必须停用
 * `@deepseek-ai/dsh-compaction-basic`（基础 bundle 默认挂载它），否则两个
 * 提供方会冲突。
 *
 * @module session-guardian/application/compaction-engine
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { CHECKPOINT_KIND, runCompactionTransaction } from './compaction-transaction.ts'
import type { CheckpointInput } from '../domain/checkpoint.ts'
import { buildCheckpointNotice } from '../domain/checkpoint.ts'
import { selectShadowRange } from '../domain/trim.ts'
import type { ShadowSelection } from '../domain/trim.ts'
import { readSurfaceView } from './surface-view.ts'
import { stripToolExchanges } from './tool-exchange-strip.ts'
import type {
  Agent,
  CompactionResult,
  CompactionService,
  CompactionTrigger,
  ContentBlock,
  Session,
  SessionEvent,
  TokenMeasurement,
  TokenMeterService,
} from '../types.ts'

/** 本后端的配置。 */
export interface RetrievalCompactionConfig {
  /** 保留最近多少轮（以用户消息为锚）。 */
  readonly retainRounds?: number
  /** 少于这么多 token 的裁剪不值得做。 */
  readonly minShadowTokens?: number
  /** 压力自动压缩的阈值（token）；`0` 表示禁用压力触发，只保留显式与溢出压缩。 */
  readonly pressureTokens?: number
  /** 是否保留保留窗口里的工具调用记录；`false` 时整段移出模型可见历史。 */
  readonly keepToolRecords?: boolean
}

/** {@link RetrievalCompactionConfig} 的运行时 schema。 */
export const Config = z.object({
  retainRounds: z.number().step(1).min(0).default(3)
    .description('保留最近多少轮（以用户消息为锚）；0 表示不保留。'),
  minShadowTokens: z.number().step(1).min(0).default(2_000)
    .description('触发裁剪的最小遮蔽量（token）。'),
  pressureTokens: z.number().step(1).min(0).default(0)
    .description('压力自动压缩阈值（token）；0 表示禁用，只保留显式与溢出压缩。'),
  keepToolRecords: z.boolean().default(true)
    .description('是否保留保留窗口里的工具调用记录；false 时整段移出模型可见历史。'),
}) as unknown as z<RetrievalCompactionConfig>

/**
 * 用检索检查点顶替摘要的压缩后端。
 *
 * 由入口的 `apply` 构造并通过 `ctx.provide('compaction', …)` 挂载；与随附后端
 * 互斥。刻意不继承 Cordis 的 `Service`：插件不带运行时 `@deepseek-ai` import，
 * 服务注册走宿主自己的 `ctx.provide`，跨 cordis 副本也不会丢注册。
 */
export class RetrievalCompactionEngine implements CompactionService {
  /** 插件上下文；`tokenMeter` / `tools` / `logger` 都从这里取。 */
  protected readonly ctx: Context

  /** 保留的轮次数。 */
  protected readonly retainRounds: number
  /** 触发裁剪的最小遮蔽量。 */
  protected readonly minShadowTokens: number
  /** 压力触发阈值；`0` 表示禁用。 */
  protected readonly pressureTokens: number
  /** 是否保留保留窗口里的工具调用记录。 */
  protected readonly keepToolRecords: boolean

  /**
   * 建立后端并登记为 `ctx.compaction`。
   * @param ctx - 插件上下文。
   * @param config - 部署配置。
   */
  constructor(ctx: Context, config: RetrievalCompactionConfig = {}) {
    this.ctx = ctx
    this.retainRounds = config.retainRounds ?? 3
    this.minShadowTokens = config.minShadowTokens ?? 2_000
    this.pressureTokens = config.pressureTokens ?? 0
    this.keepToolRecords = config.keepToolRecords ?? true
  }

  /** 计量服务；`static inject` 保证它在场，这里把可选声明收窄成非空。 */
  private get meter(): TokenMeterService {
    const meter = this.ctx.tokenMeter
    if (meter === undefined) throw new Error('retrieval compaction requires ctx.tokenMeter')
    return meter
  }

  /**
   * 按压力或溢出触发一次压缩。
   *
   * 压力触发默认关闭（`pressureTokens: 0`）：本后端的定位是「回到旧会话时
   * 裁一次」，常规压力压缩应当交给随附后端。溢出恢复始终可用，因为它保住的是
   * 请求本身。
   *
   * @param agent - 目标 Agent。
   * @param trigger - 触发原因。
   * @param signal - 取消信号。
   * @returns 压缩结果；没有可裁剪区间时为 `null`。
   */
  async compactIfNeeded(
    agent: Agent,
    trigger: CompactionTrigger,
    signal: AbortSignal,
  ): Promise<CompactionResult | null> {
    signal.throwIfAborted()
    const session = agent.session
    if (session.requestHeader() === undefined) return null
    if (trigger === 'pressure' && this.pressureTokens <= 0) return null
    const measurement = this.meter.measure(session)
    if (trigger === 'pressure' && measurement.totalTokens < this.pressureTokens) return null
    const retain = trigger === 'context-overflow' ? 1 : this.retainRounds
    const minimum = trigger === 'context-overflow' ? 1 : this.minShadowTokens
    const selection = this.selectRange(session, measurement, retain, minimum)
    if (selection === null) return null
    return this.commit(measurement, selection.start, selection.end, agent)
  }

  /**
   * 在一个空闲 Agent 上显式压缩一次（`/compact`）。
   * @param agent - 空闲 Agent。
   * @param signal - 取消信号。
   * @returns 压缩结果；没有可裁剪区间时为 `null`。
   */
  async compactNow(agent: Agent, signal: AbortSignal): Promise<CompactionResult | null> {
    signal.throwIfAborted()
    return agent.runMaintenance(async (agentSignal) => {
      const operationSignal = AbortSignal.any([agentSignal, signal])
      operationSignal.throwIfAborted()
      const measurement = this.meter.measure(agent.session)
      const selection = this.selectRange(agent.session, measurement, 1, this.minShadowTokens)
      if (selection === null) return null
      return this.commit(measurement, selection.start, selection.end, agent)
    })
  }

  /**
   * 把一段表层区间替换成一条检索检查点。
   * @param start - 区间首节点（含），按表层位置解释。
   * @param end - 区间末节点（含），按表层位置解释。
   * @param agent - 目标 Agent。
   * @param signal - 取消信号。
   * @returns 成功写入的结果。
   */
  async compactRegion(
    start: number,
    end: number,
    agent: Agent,
    signal?: AbortSignal,
  ): Promise<CompactionResult> {
    signal?.throwIfAborted()
    return this.commit(this.meter.measure(agent.session), start, end, agent)
  }

  /**
   * 用一份已测好的压力快照提交事务。
   *
   * 自动路径与手动路径都先测量再选区间，这里复用同一份快照：O(surface) 的
   * 回放只做一次。
   * @param measurement - 压力快照。
   * @param start - 区间首节点（含）。
   * @param end - 区间末节点（含）。
   * @param agent - 目标 Agent。
   * @returns 成功写入的结果。
   */
  private commit(
    measurement: TokenMeasurement,
    start: number,
    end: number,
    agent: Agent,
  ): CompactionResult {
    const result = runCompactionTransaction(
      {
        meter: this.meter,
        measurement,
        buildCheckpoint: input => this.buildCheckpoint(input),
      },
      agent.session,
      { start, end },
    )
    if (!this.keepToolRecords) this.stripRetainedToolExchanges(agent.session, result.compactionId)
    return result
  }

  /**
   * 把保留窗口里的工具交换整段移出模型可见历史。
   *
   * 只处理检查点**之后**的表层节点：检查点之前是已经移出上下文的历史，
   * 之后才是逐字保留的最近几轮。
   * @param session - 目标会话。
   * @param compactionId - 本次压缩事务的标识，用来定位检查点节点。
   */
  private stripRetainedToolExchanges(session: Session, compactionId: string): void {
    const checkpoint = findCheckpointSeq(session, compactionId)
    if (checkpoint === undefined) return
    const outcome = stripToolExchanges(session, checkpoint, (message) => {
      this.ctx.logger?.warn?.(`[session-guardian/compaction] ${message}`)
    })
    if (outcome.stripped > 0) {
      this.ctx.logger?.info?.(`[session-guardian/compaction] stripped ${outcome.stripped} tool exchanges from the retained window`)
    }
  }

  /**
   * 正文构造的扩展点：默认写固定说明 + 检索指针。
   * @param input - 会话与被遮蔽区间。
   * @returns 检查点内容块。
   */
  protected buildCheckpoint(input: CheckpointInput): readonly ContentBlock[] {
    return [{
      type: 'text',
      text: buildCheckpointNotice(input, {
        retrieval: this.retrievalAvailable(),
      }),
    }]
  }

  /**
   * 本部署里 `session_event_search` 是否真的挂载。
   *
   * 只检查 `ctx.sessionQuery` 服务不够：它可能在、但面向模型的工具没注册，
   * 或者搜索被配置成关闭（`openAt: never`）。检查点只在工具真的存在时才点名它。
   * @returns 检索工具是否可用。
   */
  protected retrievalAvailable(): boolean {
    try {
      return this.ctx.tools.get?.('session_event_search') !== undefined
    } catch {
      return false
    }
  }

  /**
   * 区间选择的扩展点：默认保留最近 N 轮，把更早的整段遮蔽。
   * @param session - 目标会话。
   * @param measurement - 与这次决策同一时刻的压力快照。
   * @param retainRounds - 保留的轮次数。
   * @param minShadowTokens - 最小遮蔽量。
   * @returns 可执行的区间；不值得裁时为 `null`。
   */
  protected selectRange(
    session: Session,
    measurement: TokenMeasurement,
    retainRounds: number,
    minShadowTokens: number,
  ): ShadowSelection | null {
    const view = readSurfaceView(session, measurement)
    return selectShadowRange(view, retainRounds, minShadowTokens)
  }
}

/**
 * 找到某次压缩事务写下的检查点节点。
 * @param session - 目标会话。
 * @param compactionId - 事务标识。
 * @returns 事件序号；找不到时 undefined。
 */
function findCheckpointSeq(session: Session, compactionId: string): number | undefined {
  for (const seq of session.surface.nodes) {
    const event: SessionEvent | undefined = session.eventAt(seq)
    if (event?.type !== 'user/message') continue
    const data = event.data as { readonly source?: { readonly kind?: string; readonly compactionId?: string } }
    if (data.source?.kind === CHECKPOINT_KIND && data.source.compactionId === compactionId) return seq
  }
  return undefined
}
