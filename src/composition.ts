/**
 * 组合根：把领域模型、应用服务、基础设施适配器装配成一个可用的运行时。
 *
 * 这是唯一知道「接口 → Cordis 实现」映射的地方；`interfaces/` 与 `application/`
 * 都不直接 new 基础设施类，测试可以用假的上下文或假适配器替换。
 *
 * 会话目录的适配只有两行委托，没有必要为一个纯转发类单独开文件，这里直接以
 * 对象字面量实现 {@link SessionDirectory}。
 *
 * @module session-guardian/composition
 */

import type { Context } from '@deepseek-ai/cordis'
import type { ResolvedConfig } from './config.ts'
import { GuardianService } from './application/guardian-service.ts'
import type { SessionDirectory, WatchRepository } from './application/ports.ts'
import { defaultStateDir, JsonlWatchRepository } from './infrastructure/watch-ledger.ts'

/** 装配好的运行时。 */
export interface GuardianRuntime {
  /** 看护应用服务（工具入口）。 */
  readonly guardian: GuardianService
  /** 账本目录（诊断/测试用）。 */
  readonly stateDir: string
}

/**
 * 按有效配置装配插件运行时。
 * @param ctx - Cordis 插件上下文。
 * @param config - 已补齐默认值的配置。
 * @returns 应用服务及其运行时信息。
 */
export function createGuardianRuntime(ctx: Context, config: ResolvedConfig): GuardianRuntime {
  const stateDir = config.stateDir ?? defaultStateDir()
  const log = (message: string): void => { ctx.logger?.warn?.(`[session-guardian] ${message}`) }

  const repository: WatchRepository = new JsonlWatchRepository(stateDir)
  // 只看在线的 Agent：持久化但没加载的会话不在目录里，它们由 ctx.sessions /
  // ctx.agents.resume 负责，不属于看护的职责范围。
  const directory: SessionDirectory = {
    list: () => ctx.agents.list(),
    get: id => ctx.agents.get(id),
  }
  const guardian = new GuardianService({ config, repository, directory, log })
  return { guardian, stateDir }
}
