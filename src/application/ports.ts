/**
 * 应用层端口（依赖倒置的边界）。
 *
 * 应用服务只认这些接口，真实实现（JSONL 账本、Cordis 会话目录）在
 * `infrastructure/` 里。测试可以换成假的仓储与假的目录，不需要起真进程。
 *
 * @module session-guardian/application/ports
 */

import type { Agent, SessionId } from '../types.ts'
import type { WatchRecord } from '../domain/watch.ts'

/** 看护记录仓储。 */
export interface WatchRepository {
  /** 读取全部看护记录；账本不存在时返回空数组。 */
  readAll(): Promise<readonly WatchRecord[]>
  /** 写入或覆盖一条记录。 */
  write(record: WatchRecord): Promise<void>
  /** 删除一条记录；记录不存在时静默返回。 */
  remove(sessionId: SessionId): Promise<void>
}

/** 会话目录：找到被看护的在线 Agent。 */
export interface SessionDirectory {
  /** 当前加载的所有 Agent。 */
  list(): Agent[]
  /** 按 id 取在线 Agent；不在线时返回 undefined。 */
  get(id: SessionId): Agent | undefined
}
