/**
 * 上下文裁剪行 `session-guardian-trim` 入口。
 *
 * 这一行只做两件事，都在「回到一个旧会话」这个场景里：
 * 1. 在 `agent/pre-step` 观察会话是否空闲够久；
 * 2. 够久就保留最近 N 轮，把更早的一段历史交给 `ctx.compaction.compactRegion()`
 *    换成一条检查点消息（后端可以是随附的摘要后端，也可以是本包的检索后端）。
 *
 * 「被裁掉的历史仍可检索」那段固定提示有两个载体：检查点正文（本包后端，
 * 见 `domain/checkpoint.ts`）与一段常驻的系统提示词（覆盖随附的摘要后端）。
 * 系统提示词那段的文本是动态的——每次组装时确认 `session_event_search` 真的
 * 挂载，不在场就整段消失，而不是让模型去调一个不存在的工具。
 *
 * 为什么放在 `agent/pre-step`：压缩本身就在这里发生（随附后端也挂在这个
 * waterfall 上），替换写进表层后立刻随后的请求就能看到检查点；如果放到回合
 * 结束后，就要等下一次用户输入才生效。
 *
 * @module session-guardian/trim
 */

import type { Context } from '@deepseek-ai/cordis'
import { TrimService } from './application/trim-service.ts'
import { TrimConfig as trimConfigSchema, resolveTrimConfig } from './config.ts'
import type { TrimConfig } from './config.ts'
import { registerRetrievalGuide } from './interfaces/prompt-guide.ts'

/** Loader 读取的配置 schema；Loader 约定这个导出名必须是 `Config`。 */
export const Config = trimConfigSchema

/**
 * 裁剪行的配置形状。
 *
 * 与 schema 同名（类型与值分属两个命名空间），消费方 `import type { Config }`
 * 拿到的就是解析后的配置形状，和主行入口一致。
 */
export type Config = TrimConfig

/** 裁剪行的配置形状（保留具名别名，便于内部与测试引用）。 */
export type { TrimConfig }

/** Loader 行名；行 id 由 `cordis.patch.yml` 的 `session-guardian-trim` 指定。 */
export const name = 'session-guardian-trim'

/** 提示词注册表与工具表是常驻指引的前提；计量与压缩后端仍是按需取。 */
export const inject = ['systemPrompt', 'tools']

/**
 * 注册裁剪监听与常驻检索指引。
 *
 * 计量与压缩后端不声明注入：缺任何一个是降级，不是启动失败。
 *
 * @param ctx - 插件上下文。
 * @param config - 已应用 schema 默认值的部署策略。
 */
export function apply(ctx: Context, config: TrimConfig): void {
  const resolved = resolveTrimConfig(config)
  if (!resolved.enabled()) return

  registerRetrievalGuide(ctx)

  const service = new TrimService({
    // 三个依赖都按「用的时候再取」处理：缺任何一个是降级，不是启动失败。
    meter: () => ctx.get('tokenMeter'),
    compaction: () => ctx.get('compaction'),
    retrieval: () => ctx.tools.get?.('session_event_search') !== undefined,
    policy: {
      idleMs: resolved.idleMs,
      retainRounds: resolved.retainRounds,
      minShadowTokens: resolved.minShadowTokens,
      requireRetrieval: resolved.requireRetrieval,
    },
    now: () => Date.now(),
    warn: (message) => { ctx.logger?.warn?.(`[session-guardian/trim] ${message}`) },
  })

  ctx.on('agent/pre-step', async ({ agent, signal }, next) => {
    if (!signal.aborted) {
      try {
        await service.trimIfNeeded(agent, signal)
      } catch (error: unknown) {
        // trimIfNeeded 自己吞掉预期失败；这里兜住装配或测量层的意外，
        // 裁剪永远不该让一个本来能跑的回合失败。
        const message = error instanceof Error ? error.message : String(error)
        ctx.logger?.warn?.(`[session-guardian/trim] trim failed: ${message}`)
      }
    }
    return next()
  })
}
