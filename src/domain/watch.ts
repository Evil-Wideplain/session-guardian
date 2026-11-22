/**
 * 看护记录（领域值对象）与会话 id 的展示形式。
 *
 * 一条记录描述「一个会话正在被插件看着」。它是纯数据：状态迁移在
 * `application/guardian-service.ts` 里做，这里不碰 I/O，也不记录「看护期间做过
 * 什么」——本包只维护登记事实，动作属于别的能力。
 *
 * 记录因此只有登记相关的字段：谁、什么时候登记、当前状态、为了什么。
 *
 * @module session-guardian/domain/watch
 */

import type { SessionId } from '../types.ts'

/** 看护状态。 */
export type WatchState =
  /** 在看护中：登记有效，会出现在列表里。 */
  | 'watching'
  /** 已暂停：保留记录，表示暂时不再关注。 */
  | 'paused'
  /** 已结束：保留记录作为历史。 */
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
