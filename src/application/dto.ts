/**
 * 应用层 DTO：工具与 UI 之间传递的只读投影。
 *
 * DTO 全部是 snake_case 的扁平结构：模型工具的输出 schema 直接由它们推导，
 * 客户端卡片也直接渲染它们，不再做二次映射。
 *
 * @module session-guardian/application/dto
 */

import type { WatchState } from '../domain/watch.ts'
import type { SessionId } from '../types.ts'

/** 一条看护记录的行投影。 */
export interface WatchRow {
  /** 被看护的会话 id。 */
  readonly sessionId: SessionId
  /** 会话 id 的短形式。 */
  readonly shortId: string
  /** 看护状态。 */
  readonly state: WatchState
  /** 会话当前是否在线。 */
  readonly online: boolean
  /** Agent 当前状态；离线时为 `offline`。 */
  readonly agentStatus: 'idle' | 'running' | 'offline'
  /** 备注。 */
  readonly note: string | undefined
  /** 登记看护的时刻（Unix 毫秒）。 */
  readonly createdAt: number
}

/** `watch_session` 的结果。 */
export interface WatchResult {
  /** 已登记的会话 id。 */
  readonly sessionId: SessionId
  /** 是否是本次新建的看护（false 表示覆盖了已有记录）。 */
  readonly created: boolean
  /** 看护状态。 */
  readonly state: WatchState
}

/** `unwatch_session` 的结果。 */
export interface UnwatchResult {
  /** 已停止看护的会话 id。 */
  readonly sessionId: SessionId
  /** 本次之前是否真的在看护。 */
  readonly removed: boolean
}

/** `list_watched_sessions` 的结果。 */
export interface ListResult {
  /** 看护行。 */
  readonly rows: readonly WatchRow[]
  /** 因不在调用方可见范围而被省略的行数。 */
  readonly omitted: number
}
