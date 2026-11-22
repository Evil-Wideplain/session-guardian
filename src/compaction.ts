/**
 * 检索式压缩后端行 `session-guardian-compaction` 入口。
 *
 * 这一行**提供** `ctx.compaction`，顶替随附的 `@deepseek-ai/dsh-compaction-basic`。
 * 因为一个上下文只能有一个压缩后端，`cordis.patch.yml` 把它默认标成
 * `disabled: true`：要用它，先停用基础 bundle 里的随附后端那一行，再启用本行。
 *
 * 它不继承 Cordis 的 `Service`，而是普通插件：`apply` 构造引擎后调用
 * `ctx.provide('compaction', engine)`。这样运行时不 import 任何
 * `@deepseek-ai/dsh-*`（也不 import cordis），插件链接进 profile 时不会因为
 * 多一份 cordis 副本而注册不到宿主。
 *
 * 它与裁剪行是正交的：裁剪行决定「什么时候裁、裁到哪里」，本行只决定
 * 「检查点长什么样」。两行都不启用随附后端时，`/compact` 与溢出恢复由本行
 * 接管；只启用裁剪行时，压缩仍走随附后端的模型摘要。
 *
 * @module session-guardian/compaction
 */

import type { Context } from '@deepseek-ai/cordis'
import {
  Config as engineConfigSchema,
  RetrievalCompactionEngine,
} from './application/compaction-engine.ts'
import type { RetrievalCompactionConfig } from './application/compaction-engine.ts'

/** Loader 读取的配置 schema。 */
export const Config = engineConfigSchema

/** Loader 行名；行 id 由 `cordis.patch.yml` 的 `session-guardian-compaction` 指定。 */
export const name = 'session-guardian-compaction'

/** 区间选择与缩减校验都需要计量服务。 */
export const inject = ['tokenMeter']

export { RetrievalCompactionEngine }
export type { RetrievalCompactionConfig }

/**
 * 构造检索式压缩后端并登记为 `ctx.compaction`。
 * @param ctx - 插件上下文。
 * @param config - 部署配置。
 */
export function apply(ctx: Context, config: RetrievalCompactionConfig = {}): void {
  ctx.provide('compaction', new RetrievalCompactionEngine(ctx, config))
}
