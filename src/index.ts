/**
 * 主行 `session-guardian` 入口（`package.json` 的 `main`）。
 *
 * 组合包拆成四个装载行（组件），本文件是主行：装配运行时，提供
 * `sessionGuardian` 服务，注册 `watch_session` / `unwatch_session` /
 * `list_watched_sessions` 三个工具，并在启动时从账本恢复看护记录。
 * `auto-continue.ts` 是自动续跑行：注入本行的服务，持有心跳调度器与核心机制。
 * 两行独立启停，关掉自动续跑行只少「看护期间对会话做什么」这一件事，
 * 看护登记与账本照常。
 *
 * 入口文件直接承载实现，不再经 `entries/` 中转：一个装载行一个入口，少一层
 * 纯转出文件，Loader 行 `name` 与文件名一一对应。
 *
 * 代码按 DDD 分层组织：
 * - `domain/`：看护记录、授权规则、裁剪与检查点等纯业务规则；
 * - `application/`：用例编排（watch/unwatch/list/heartbeat）与端口接口；
 * - `infrastructure/`：JSONL 账本、会话表层读取；
 * - `interfaces/`：模型工具与系统提示词段落。
 *
 * @module session-guardian
 */

import type { Context } from '@deepseek-ai/cordis'
import { Config, resolveConfig } from './config.ts'
import { createGuardianRuntime } from './composition.ts'
import { SESSION_GUARDIAN_SERVICE } from './application/guardian-service.ts'
import { createListTool } from './interfaces/tools/list.ts'
import { createUnwatchTool } from './interfaces/tools/unwatch.ts'
import { createWatchTool } from './interfaces/tools/watch.ts'

export { Config }

/** Loader 行名；行 id 由 `cordis.patch.yml` 的 `session-guardian` 指定。 */
export const name = 'session-guardian'

export const inject = ['tools', 'agents', 'sessions']

/**
 * 注册看护工具，并从账本恢复上一次运行的看护记录。
 * @param ctx - 插件上下文。
 * @param config - 已应用 schema 默认值的部署策略。
 */
export function apply(ctx: Context, config: Config): void {
  const resolved = resolveConfig(config)
  const runtime = createGuardianRuntime(ctx, resolved)
  // 两行同属一个包但闭包不共享；自动续跑行只能经 Cordis 服务拿到看护服务。
  ctx.provide(SESSION_GUARDIAN_SERVICE, {
    guardian: runtime.guardian,
    heartbeatIntervalMs: resolved.heartbeatIntervalMs,
  })

  ctx.tools.register(createWatchTool(runtime.guardian))
  ctx.tools.register(createUnwatchTool(runtime.guardian))
  ctx.tools.register(createListTool(runtime.guardian))

  // 从账本恢复上一次运行的看护记录；失败不影响插件启动。
  void runtime.guardian.recover()
}
