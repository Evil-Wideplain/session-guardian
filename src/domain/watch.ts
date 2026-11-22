/**
 * 看护记录（领域值对象）与会话 id 的展示形式。
 *
 * 一条记录描述「一个会话正在被插件看着」。它是纯数据：状态迁移在
 * `application/guardian-service.ts` 里做，这里不碰 I/O，也不描述「看护要做什么」
 * ——那是待定的核心机制，不该固化在记录模型里。
 *
 * 记录里的计数器是**动作计数**：插件对这条看护做过的任何一次动作（自动续跑、
 * 写检查点、发告警……）都记一次。这样限流与配额可以按「动作」而不是按
 * 「某一种动作」来算，核心机制换了也不用改账本格式。
 *
 * @module session-guardian/domain/watch
 */

import type { SessionId } from '../types.ts'

/** 看护状态。 */
export type WatchState =
  /** 在看护中：调度器会继续检查这个会话。 */
  | 'watching'
  /** 已暂停：保留记录但不再检查。 */
  | 'paused'
  /** 已结束：不再检查。 */
  | 'stopped'

/** 一条看护记录。 */
export interface WatchRecord {
  /** 被看护的会话。 */
  readonly sessionId: SessionId
  /** 登记看护的时刻（Unix 毫秒）。 */
  readonly createdAt: number
  /** 最近一次更新的时刻（Unix 毫秒）。 */
  readonly updatedAt: number
  /** 当前状态。 */
  readonly state: WatchState
  /** 备注：这次看护是为了什么（模型登记时写的）。 */
  readonly note: string | undefined
  /** 已经心跳过多少次。 */
  readonly heartbeatCount: number
  /** 插件对这条看护做过多少次动作。 */
  readonly actionCount: number
  /** 最近一次心跳时刻（Unix 毫秒）。 */
  readonly lastHeartbeatAt: number | undefined
  /** 最近一次动作时刻（Unix 毫秒）。 */
  readonly lastActionAt: number | undefined
}

/** 短会话 id 的显示长度（去掉 `session-` 前缀后的字符数）。 */
const SHORT_ID_LENGTH = 8

/**
 * 取会话 id 的短形式用于紧凑显示。
 * @param sessionId - 完整会话标识（`session-<uuid>` 或裸 uuid）。
 * @returns 去掉前缀后的前 8 个字符；过短的 id 原样返回。
 */
export function shortSessionId(sessionId: string): string {
  const bare = sessionId.startsWith('session-') ? sessionId.slice('session-'.length) : sessionId
  return bare.length > SHORT_ID_LENGTH ? bare.slice(0, SHORT_ID_LENGTH) : bare
}
