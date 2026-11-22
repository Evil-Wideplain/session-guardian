/**
 * 看护应用服务：用例编排。
 *
 * 本层负责「一次看护请求要变成什么」：授权、参数落账本、投影成 DTO。它**不**
 * 决定「看护期间该做什么」——本包只维护登记事实，不对会话主动动作。
 *
 * 账本写在前、状态改在后：账本是真相，内存里的 Map 只是索引。写账本失败时
 * 内存状态不会变，避免出现「内存说有、磁盘没有」的幽灵看护。
 *
 * @module session-guardian/application/guardian-service
 */

import type { ResolvedConfig } from '../config.ts'
import type { ListResult, UnwatchResult, WatchResult, WatchRow } from './dto.ts'
import type { SessionDirectory, WatchRepository } from './ports.ts'
import type { WatchAuthorization } from '../domain/authorization.ts'
import { authorizeWatch } from '../domain/authorization.ts'
import { shortSessionId } from '../domain/watch.ts'
import type { WatchRecord, WatchState } from '../domain/watch.ts'
import type { Agent, SessionId } from '../types.ts'

/** 调用方身份；由工具层从 `exec.agent` 派生。 */
export interface Caller {
  /** 调用方会话 id。 */
  readonly sessionId: SessionId
  /** 调用方会话的工作目录；没有记录时为空串。 */
  readonly cwd: string
}

/** 登记看护的请求。 */
export interface WatchRequest {
  /** 目标会话 id。 */
  readonly sessionId: SessionId
  /** 备注：这次看护是为了什么。 */
  readonly note?: string
  /** 初始状态；默认 `watching`。 */
  readonly state?: WatchState
}

/**
 * 看护服务的依赖。
 */
export interface GuardianServiceDeps {
  readonly config: ResolvedConfig
  readonly repository: WatchRepository
  readonly directory: SessionDirectory
  /** 日志出口。 */
  readonly log: (message: string) => void
}

/**
 * 看护应用服务。
 */
export class GuardianService {
  /** 生效配置。 */
  private readonly config: ResolvedConfig
  /** 账本。 */
  private readonly repository: WatchRepository
  /** 会话目录。 */
  private readonly directory: SessionDirectory
  /** 日志出口。 */
  private readonly log: (message: string) => void
  /** 内存索引：session id → 看护记录。账本才是真相，这里只是快查。 */
  private readonly records = new Map<SessionId, WatchRecord>()

  /**
   * 构造看护服务。
   * @param deps - 依赖。
   */
  constructor(deps: GuardianServiceDeps) {
    this.config = deps.config
    this.repository = deps.repository
    this.directory = deps.directory
    this.log = deps.log
  }

  /**
   * 从账本恢复看护记录。
   *
   * 恢复出来的记录保持原来的登记时刻与状态，因此重启不会把已有的看护丢掉。
   * 账本损坏时只记一条日志并放弃恢复，不让插件起不来。
   * @returns 恢复的记录条数。
   */
  async recover(): Promise<number> {
    if (!this.config.recoverOnStart) return 0
    try {
      const stored = await this.repository.readAll()
      for (const record of stored) {
        this.records.set(record.sessionId, record)
      }
      if (stored.length > 0) this.log(`已从账本恢复 ${stored.length} 条看护记录`)
      return stored.length
    } catch (error: unknown) {
      const detail = error instanceof Error ? error.message : String(error)
      this.log(`看护账本恢复失败，已跳过恢复：${detail}`)
      return 0
    }
  }

  /**
   * 登记一次看护。
   * @param caller - 调用方。
   * @param request - 看护请求。
   * @returns 看护结果。
   */
  async watch(caller: Caller, request: WatchRequest): Promise<WatchResult> {
    const target = this.directory.get(request.sessionId)
    const decision = this.authorize(caller, request.sessionId, target)
    if (!decision.allowed) throw new Error(`无法看护该会话：${decision.reason}`)

    const now = Date.now()
    const existing = this.records.get(request.sessionId)
    const record: WatchRecord = {
      sessionId: request.sessionId,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
      state: request.state ?? existing?.state ?? 'watching',
      note: request.note ?? existing?.note,
    }
    await this.repository.write(record)
    this.records.set(record.sessionId, record)
    return {
      sessionId: record.sessionId,
      created: existing === undefined,
      state: record.state,
    }
  }

  /**
   * 停止一次看护。
   * @param caller - 调用方。
   * @param sessionId - 目标会话 id。
   * @returns 停止结果。
   */
  async unwatch(caller: Caller, sessionId: SessionId): Promise<UnwatchResult> {
    const record = this.records.get(sessionId)
    if (record === undefined) return { sessionId, removed: false }
    const decision = this.authorize(caller, sessionId, this.directory.get(sessionId))
    if (!decision.allowed) throw new Error(`无法停止看护该会话：${decision.reason}`)
    await this.repository.remove(sessionId)
    this.records.delete(sessionId)
    return { sessionId, removed: true }
  }

  /**
   * 列出调用方可见的被看护会话。
   * @param caller - 调用方。
   * @returns 看护行列表与被省略的条数。
   */
  list(caller: Caller): ListResult {
    const rows: WatchRow[] = []
    let omitted = 0
    for (const record of this.records.values()) {
      const target = this.directory.get(record.sessionId)
      const decision = this.authorize(caller, record.sessionId, target)
      if (!decision.allowed) {
        omitted += 1
        continue
      }
      rows.push(this.rowOf(record, target))
    }
    rows.sort((a, b) => a.createdAt - b.createdAt)
    return { rows, omitted }
  }

  /**
   * 判定调用方能否对这个会话动手。
   *
   * 三个用例（watch / unwatch / list）共用同一套授权输入形状；集中在这里，
   * 避免三处各拼一份对象、将来漏改。
   * @param caller - 调用方。
   * @param sessionId - 目标会话 id。
   * @param target - 目标 Agent；不在线时 undefined。
   * @returns 授权结果。
   */
  private authorize(
    caller: Caller,
    sessionId: SessionId,
    target: Agent | undefined,
  ): WatchAuthorization {
    return authorizeWatch({
      callerId: caller.sessionId,
      callerCwd: caller.cwd,
      targetId: sessionId,
      targetCwd: target?.session.header.cwd ?? '',
    }, this.config)
  }

  /**
   * 把一条看护记录投影成一行。
   * @param record - 看护记录。
   * @param target - 目标 Agent；离线时 undefined。
   * @returns 行投影。
   */
  private rowOf(record: WatchRecord, target: Agent | undefined): WatchRow {
    const shortId = shortSessionId(record.sessionId)
    return {
      sessionId: record.sessionId,
      shortId,
      state: record.state,
      online: target !== undefined,
      agentStatus: target === undefined ? 'offline' : target.status,
      note: record.note,
      createdAt: record.createdAt,
    }
  }
}
