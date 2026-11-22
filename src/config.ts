/**
 * 插件配置与运行时 schema（主行 + 裁剪行）。
 *
 * 只放**部署参数**：账本落点、启动恢复、跨目录可见性，以及「什么时候认为
 * 缓存已经冷了、保留多少近期历史、值不值得裁」。看护本身只维护登记事实，
 * 不主动对会话做动作，因此没有续跑延迟、次数上限这类机制旋钮。
 *
 * 字段刻意保持扁平：bundle patch 只提供部分值，其余由 schemastery 填默认。
 * 两个行各导出自己的 `Config`（裁剪行在 `trim.ts` 里把 {@link TrimConfig}
 * 别名成 `Config`），Loader 按各自入口取 schema。
 *
 * @module session-guardian/config
 */

import z from '@deepseek-ai/schemastery'

/**
 * 可热更新的配置引用。
 *
 * schemastery 的 `.volatile()` 字段在 Loader 里不是普通值，而是一个稳定的
 * 引用：表单保存后引用内容原地更新，插件不必重启。这里只声明结构，避免为了
 * 一个类型引入 `@deepseek-ai/cosmokit` 运行时依赖。
 */
export interface Volatile<T> {
  /** 当前快照。 */
  get(): T
}

/** 配置值：普通值（直接构造/测试）或可热更新引用（Loader 传入）。 */
export type ConfigValue<T> = T | Volatile<T>

/**
 * 读取一个配置值；引用取当前快照，普通值原样返回。
 * @param value - 配置值；缺省时用默认值。
 * @param fallback - 缺省值。
 * @returns 当前值。
 */
export function readConfig<T>(value: ConfigValue<T> | undefined, fallback: T): T {
  if (value === undefined) return fallback
  if (typeof value === 'object' && value !== null && typeof (value as Volatile<T>).get === 'function') {
    return (value as Volatile<T>).get()
  }
  return value as T
}

// ---------------------------------------------------------------------------
// 主行：看护登记
// ---------------------------------------------------------------------------

/** 看护能力的部署策略。 */
export interface Config {
  /** 看护账本目录；默认 `$DSH_HOME/session-guardian`。 */
  readonly stateDir?: string
  /** 启动时是否从账本恢复上一次运行的看护记录。 */
  readonly recoverOnStart?: boolean
  /** 是否允许看护工作目录与调用方不同的会话。 */
  readonly allowCrossWorkspace?: boolean
  /** 例外清单：精确目录，或目录前缀（`/repo`、`C:\repo`）。 */
  readonly allowlist?: string[]
}

/** {@link Config} 的运行时 schema。 */
// schemastery 无法表达 `exactOptionalPropertyTypes` 的可选字段，因此这里断言
// 解析后的形状，并在 resolveConfig 里逐字段兜底默认值。
export const Config = z.object({
  stateDir: z.string(),
  recoverOnStart: z.boolean().default(true)
    .description('启动时从账本恢复上一次运行的看护记录。'),
  allowCrossWorkspace: z.boolean().default(false)
    .description('允许看护工作目录与调用方不同的会话。'),
  allowlist: z.array(z.string()).default([])
    .description('不受工作目录限制的目录，或目录前缀。'),
}) as unknown as z<Config>

/** 所有默认值都已补齐的配置。 */
export interface ResolvedConfig {
  readonly stateDir: string | undefined
  readonly recoverOnStart: boolean
  readonly allowCrossWorkspace: boolean
  readonly allowlist: readonly string[]
  /**
   * 路径比较是否忽略大小写。
   *
   * 由 `resolveConfig` 从运行时平台探测后注入，不是用户可配置项；放在这里是为了
   * 让领域层拿到「事实」而不是自己去读 `process.platform`。
   */
  readonly pathCaseInsensitive: boolean
}

/**
 * 补齐文档里的默认值。
 * @param config - 部分部署配置。
 * @returns 生效配置。
 */
export function resolveConfig(config: Config): ResolvedConfig {
  return {
    stateDir: config.stateDir,
    recoverOnStart: config.recoverOnStart ?? true,
    allowCrossWorkspace: config.allowCrossWorkspace ?? false,
    allowlist: config.allowlist ?? [],
    pathCaseInsensitive: process.platform === 'win32',
  }
}

// ---------------------------------------------------------------------------
// 裁剪行
// ---------------------------------------------------------------------------

/** 上下文裁剪行的部署策略。 */
export interface TrimConfig {
  /** 是否启用；关掉后本行不注册任何监听（普通配置，改后重载插件行）。 */
  readonly enabled?: boolean
  /** 会话空闲多久之后认为提供方前缀缓存已经冷了。 */
  readonly idleMs?: ConfigValue<number>
  /** 保留最近多少轮（一轮 = 一条用户消息及其后续的工具调用与结果）；0 表示不保留。 */
  readonly retainRounds?: ConfigValue<number>
  /** 少于这么多 token 的裁剪不值得做（检查点与固定提示本身也有成本）。 */
  readonly minShadowTokens?: ConfigValue<number>
  /** 检索工具不在场时是否跳过裁剪；默认 `true`（没有检索就裁等于失忆）。 */
  readonly requireRetrieval?: ConfigValue<boolean>
}

/** {@link TrimConfig} 的运行时 schema。 */
export const TrimConfig = z.object({
  enabled: z.boolean().default(true)
    .description('启用回到旧会话时的自动上下文裁剪。'),
  idleMs: z.number().step(1).min(1_000).default(1_800_000).volatile()
    .description('空闲阈值（毫秒）；默认 30 分钟。'),
  retainRounds: z.number().step(1).min(0).default(3).volatile()
    .description('保留最近多少轮（以用户消息为锚）；0 表示不保留。'),
  minShadowTokens: z.number().step(1).min(1).default(2_000).volatile()
    .description('触发裁剪的最小遮蔽量（token）。'),
  requireRetrieval: z.boolean().default(true).volatile()
    .description('检索工具不在场时跳过裁剪；默认 true。'),
}) as unknown as z<TrimConfig>

/**
 * 裁剪策略的读取器。
 *
 * 热更新字段每次决策时重新读，保存表单后行为立刻变化；`enabled` 是普通字段，
 * 只在装配时决定是否注册监听。
 */
export interface ResolvedTrimConfig {
  readonly enabled: () => boolean
  readonly idleMs: () => number
  readonly retainRounds: () => number
  readonly minShadowTokens: () => number
  readonly requireRetrieval: () => boolean
}

/**
 * 把配置包装成读取器；缺省值在每次读取时兜底。
 * @param config - 部分部署配置。
 * @returns 生效配置的读取器。
 */
export function resolveTrimConfig(config: TrimConfig): ResolvedTrimConfig {
  return {
    enabled: () => config.enabled ?? true,
    idleMs: () => readConfig(config.idleMs, 1_800_000),
    retainRounds: () => readConfig(config.retainRounds, 3),
    minShadowTokens: () => readConfig(config.minShadowTokens, 2_000),
    requireRetrieval: () => readConfig(config.requireRetrieval, true),
  }
}
