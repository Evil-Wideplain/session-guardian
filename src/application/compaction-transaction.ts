/**
 * 一次检索式压缩的**同步事务**：校验区间 → 生成检查点 → 写四个事件。
 *
 * 单独抽出来有两个原因：
 * 1. 事务是整个后端里唯一会改会话日志的部分，值得被单独测试（引擎本身要
 *    依赖 Cordis 的 Service 装配，测起来重）；
 * 2. 事务里**没有 await**：没有模型调用，就没有「摘要期间表层变了」的窗口，
 *    不需要 seam 里那套稳定性复核，也不会长时间占着锁。
 *
 * 事务的写入顺序与 `dsh-compaction` 的约定一致：
 * `compaction/start` → `compaction/summary` → 带 `surfaceOp: replace` 的
 * `user/message` → `compaction/end`。失败时尽力补一次带 `error` 的
 * `compaction/end`；补不上就留下未配对的 start——那是 seam 有意设计的 busy 证据。
 *
 * @module session-guardian/application/compaction-transaction
 */

import { randomUUID } from 'node:crypto'
import type { CheckpointInput } from '../domain/checkpoint.ts'
import { readSurfaceView } from './surface-view.ts'
import type {
  CompactionResult,
  ContentBlock,
  Session,
  TokenMeasurement,
  TokenMeterService,
  UserMessage,
} from '../types.ts'

/** 检查点消息携带的来源标记；与 `dsh-compaction` 的 checkpoint source 同形。 */
export const CHECKPOINT_KIND = 'compact-checkpoint'

/** 写入 `compaction/summary` 时记录的摘要路由标识（本后端不调用模型）。 */
export const DIGEST_PROVIDER = 'session-guardian'
export const DIGEST_MODEL = 'retrieval-digest'

/** 事务依赖。 */
export interface CompactionTransactionDependencies {
  /** 计量服务：验证缩减、给检查点估价都读它。 */
  readonly meter: TokenMeterService
  /**
   * 本次事务使用的表层压力快照。
   *
   * 由调用方测好再传进来：引擎在一次压缩里已经测过一遍，事务再测一次是重复的
   * O(surface) 回放；而事务本身是同步的，前后没有 await，快照不会过期。
   */
  readonly measurement: TokenMeasurement
  /** 检查点正文构造器。 */
  readonly buildCheckpoint: (input: CheckpointInput) => readonly ContentBlock[]
}

/** 被替换的表层区间（含端点，按表层位置解释）。 */
export interface CompactionSpan {
  readonly start: number
  readonly end: number
}

/** 事务的可选项。 */
export interface CompactionTransactionOptions {
  /** 发起命令（`/compact`）的标识。 */
  readonly sourceCommandId?: string
}

/**
 * 执行一次同步压缩事务。
 * @param dependencies - 计量与正文构造。
 * @param session - 目标会话。
 * @param span - 被替换的表层区间。
 * @param options - 可选项。
 * @returns 成功写入的结果。
 * @throws 区间不合法、有活动锁、没有打开的回合、检查点没有变小，或写入失败时。
 */
export function runCompactionTransaction(
  dependencies: CompactionTransactionDependencies,
  session: Session,
  span: CompactionSpan,
  options: CompactionTransactionOptions = {},
): CompactionResult {
  const measurement = dependencies.measurement
  const view = readSurfaceView(session, measurement)
  const startIndex = view.findIndex(node => node.seq === span.start)
  const endIndex = view.findIndex(node => node.seq === span.end)
  if (startIndex < 0 || endIndex < 0 || endIndex < startIndex) {
    throw new Error(`compaction: range ${span.start}-${span.end} is not a valid surface span`)
  }
  assertRangeEdgesBalanced(view, startIndex, endIndex)
  assertHeadNotShadowed(session, view, startIndex)
  inspectCompactionLock(session)
  const turn = inspectOpenTurn(session)
  if (turn === undefined) {
    throw new Error('compaction: no open turn — automatic compaction must run inside a turn')
  }

  const shadowedSeqs = view.slice(startIndex, endIndex + 1).map(node => node.seq)
  const shadowedTokens = view
    .slice(startIndex, endIndex + 1)
    .reduce((sum, node) => sum + node.tokens, 0)
  const content = dependencies.buildCheckpoint({
    sessionId: session.id,
    start: span.start,
    end: span.end,
    shadowedTokens,
  })
  const compactionId = randomUUID()
  const message: UserMessage = {
    id: randomUUID(),
    role: 'user',
    content: [...content],
    source: { kind: CHECKPOINT_KIND, compactionId },
  }

  // 后缀校验：检查点必须真的比被遮蔽内容小，否则替换不减少上下文压力。
  const checkpointTokens = dependencies.meter.estimateMessage(message)
  if (checkpointTokens >= shadowedTokens) {
    throw new Error(
      `retrieval checkpoint is not smaller than the shadowed content (${checkpointTokens} >= ${shadowedTokens})`,
    )
  }

  const lifecycle = {
    compactionId,
    ...options.sourceCommandId === undefined ? {} : { sourceCommandId: options.sourceCommandId },
    turn,
  }
  const startEvent = session.append('compaction/start', lifecycle)
  let closed = false
  try {
    const summaryEvent = session.append('compaction/summary', {
      ...lifecycle,
      summary: [...content],
      shadowedRange: { start: span.start, end: span.end },
      shadowedSeqs: [...shadowedSeqs],
      shadowedTokenCount: shadowedTokens,
      provider: DIGEST_PROVIDER,
      model: DIGEST_MODEL,
    })
    session.append('user/message', message, {
      surfaceOp: { op: 'replace', startSeq: span.start, endSeq: span.end },
      sourceEventSeqs: [startEvent.seq, summaryEvent.seq, ...shadowedSeqs],
    })
    const endEvent = session.append('compaction/end', lifecycle)
    closed = true
    return {
      compactionId,
      ...options.sourceCommandId === undefined ? {} : { sourceCommandId: options.sourceCommandId },
      startSeq: startEvent.seq,
      summarySeq: summaryEvent.seq,
      endSeq: endEvent.seq,
      summary: content,
      shadowedRange: { start: span.start, end: span.end },
      shadowedSeqs,
      shadowedTokenCount: shadowedTokens,
    }
  } catch (error: unknown) {
    if (!closed) {
      try {
        session.append('compaction/end', { ...lifecycle, error: describeError(error) })
      } catch {
        // 关闭也失败时保留最初的错误，别把它盖掉。
      }
    }
    throw error
  }
}

/**
 * 校验区间两端都落在工具调用配对的边界上。
 * @param view - 表层视图。
 * @param startIndex - 区间首节点下标。
 * @param endIndex - 区间末节点下标。
 */
function assertRangeEdgesBalanced(
  view: readonly { readonly toolCallDelta: number }[],
  startIndex: number,
  endIndex: number,
): void {
  let balance = 0
  for (let index = 0; index < startIndex; index += 1) {
    balance += view[index]?.toolCallDelta ?? 0
  }
  if (balance !== 0) throw new Error('compaction: the range start splits an open tool call')
  for (let index = startIndex; index <= endIndex; index += 1) {
    balance += view[index]?.toolCallDelta ?? 0
  }
  if (balance !== 0) throw new Error('compaction: the range end splits an open tool call')
}

/**
 * 拒绝把表层第 0 号系统提示词节点裁进区间。
 * @param session - 目标会话。
 * @param view - 表层视图。
 * @param startIndex - 区间首节点下标。
 */
function assertHeadNotShadowed(
  session: Session,
  view: readonly { readonly seq: number }[],
  startIndex: number,
): void {
  const head = session.surface.nodes[0]
  const first = view[startIndex]?.seq
  if (head !== undefined && first !== undefined && head === first) {
    throw new Error('compaction: the system prompt head cannot be shadowed')
  }
}

/**
 * 找出当前打开的回合编号。
 * @param session - 目标会话。
 * @returns 回合编号；没有打开的回合时 `undefined`。
 */
function inspectOpenTurn(session: Session): number | undefined {
  for (let seq = session.seq - 1; seq >= 0; seq -= 1) {
    const event = session.eventAt(seq)
    if (event === undefined) continue
    if (event.type === 'turn/start') {
      const data = event.data as { readonly turn?: unknown }
      return typeof data.turn === 'number' ? data.turn : undefined
    }
    if (event.type === 'turn/end') return undefined
  }
  return undefined
}

/**
 * 若存在未配对的 `compaction/start`，拒绝本次事务。
 *
 * 从尾部往前扫：先遇到 `compaction/end` 或 `session/end-seed` 说明没有活动锁；
 * 先遇到 `compaction/start` 说明上一个事务没有收口。
 * @param session - 目标会话。
 */
function inspectCompactionLock(session: Session): void {
  for (let seq = session.seq - 1; seq >= 0; seq -= 1) {
    const event = session.eventAt(seq)
    if (event === undefined) continue
    if (event.type === 'compaction/start') {
      throw new Error('compaction: another compaction is already active on this session')
    }
    if (event.type === 'compaction/end' || event.type === 'session/end-seed') return
  }
}

/**
 * 把失败压成可持久化的 JSON 形状。
 * @param error - 任意失败。
 * @returns `{ name, message }`。
 */
function describeError(error: unknown): { readonly name: string; readonly message: string } {
  if (error instanceof Error) return { name: error.name, message: error.message }
  return { name: 'Error', message: String(error) }
}
