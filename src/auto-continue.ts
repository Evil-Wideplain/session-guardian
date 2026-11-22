/**
 * 自动续跑行 `session-guardian-auto-continue` 入口。
 *
 * 这一行与主行（`session-guardian`）同属一个插件包，但在 `cordis.patch.yml`
 * 里是独立的 Loader 行，因此在插件页上是独立组件、有独立启停开关：关掉它只
 * 少「看护期间对会话做什么」这一件事，看护登记、状态查询与账本照常。
 *
 * 看护服务由主行 provide（见 `application/guardian-service.ts` 的服务契约）。
 * 主行没激活时本行等依赖，机制自然不会发生；这是依赖关系，不是故障。
 *
 * **核心机制尚未确定**：这一行现在只持有心跳调度器与机制接缝
 * （{@link onHeartbeat}）。机制定下来之后，只需要替换那一个函数——本行的装配、
 * 调度节奏与主行的看护表、账本都不用动。
 *
 * @module session-guardian/auto-continue
 */

import type { Context } from '@deepseek-ai/cordis'
import { HeartbeatScheduler } from './application/heartbeat.ts'
import { SESSION_GUARDIAN_SERVICE } from './application/guardian-service.ts'
import type {
  HeartbeatOutcome,
  SessionGuardianRuntimeService,
} from './application/guardian-service.ts'
import type { WatchRecord } from './domain/watch.ts'
import type { Agent } from './types.ts'

/** 这一行的插件名；Loader 行 id 由 `cordis.patch.yml` 的 `session-guardian-auto-continue` 指定。 */
export const name = 'session-guardian-auto-continue'

/** 需要主行提供的看护服务。 */
export const inject = ['tools', SESSION_GUARDIAN_SERVICE]

/**
 * 核心机制接缝：对一条被看护的会话，这一轮该做什么。
 *
 * 机制待定，这里返回「什么都没做」。接缝的形状已经定下来了：拿到看护记录、
 * 目标 Agent（不在线时是 undefined）和本轮时刻，返回这一轮是否动了手。
 *
 * @param _record - 被看护的会话记录。
 * @param _agent - 目标 Agent；会话不在线时 undefined。
 * @param _now - 本轮时刻（Unix 毫秒）。
 * @returns 本轮是否对这条看护动了手。
 */
async function onHeartbeat(
  _record: WatchRecord,
  _agent: Agent | undefined,
  _now: number,
): Promise<HeartbeatOutcome> {
  return { acted: false }
}

/**
 * 启动心跳调度器，按节奏把看护表交给核心机制。
 * @param ctx - 已注入 `sessionGuardian` 的行上下文。
 */
export function apply(ctx: Context): void {
  // 服务契约放在应用层，没在 `types.ts` 里增补 `ctx.sessionGuardian`——否则
  // 类型声明就要反向依赖应用层。这里显式标注，仍然拿到完整类型。
  const runtime = ctx.get(SESSION_GUARDIAN_SERVICE) as SessionGuardianRuntimeService | undefined
  // inject 保证服务可用；这里显式判空，让依赖装配错误在日志里可辨认，
  // 而不是运行时以 `undefined.guardian` 的形式炸掉。
  if (runtime === undefined) {
    throw new Error(
      'sessionGuardian 服务不可用：自动续跑行必须与 session-guardian 行一起启用',
    )
  }
  const scheduler = new HeartbeatScheduler(
    runtime.heartbeatIntervalMs,
    async () => ({ acted: await runtime.guardian.heartbeat(Date.now(), onHeartbeat) }),
    (message) => { ctx.logger?.warn?.(`[session-guardian] ${message}`) },
    // timer 是可选服务：基础 bundle 有 `timer` 行，没有时调度器会退回进程内定时器。
    ctx.get('timer'),
  )
  // effect 拥有调度器的生命周期：插件停用时定时器一定被清掉。
  ctx.effect(() => {
    scheduler.start()
    return () => { scheduler.stop() }
  }, 'session-guardian: heartbeat')
}
