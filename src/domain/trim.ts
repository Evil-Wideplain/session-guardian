/**
 * 上下文裁剪的领域规则（纯函数，不碰 Cordis、不读写会话）。
 *
 * 裁剪回答两个问题，这里都只依赖「已经读出来的表层视图」：
 * 1. **什么时候裁**——会话空闲够久（提供方前缀缓存大概率已经冷了）；
 * 2. **裁到哪里**——保留最近 N 轮，从更早的地方整段换掉。
 *
 * 「轮次」按用户消息锚定：一条 `user/message`（来源是真实用户，不是检查点、
 * 也不是运行时注入的上下文）到吓一条用户消息之前，算一轮；工具调用与结果都
 * 属于它们所在的那一轮。按轮次而不是按 token 选区间有两个好处：
 *
 * - 边界可解释：模型看到的是完整的「用户说了什么—助手答了什么」；
 * - 边界天然安全：轮与轮之间不会切开工具调用配对，`selectShadowRange` 里的
 *   余额校验只作为兜底（`steer` 理论上能在 step 之间插入用户消息）。
 *
 * 真正写日志的是压缩后端，因此策略可以单测，后端可以替换（随附后端或本包的
 * `session-guardian/compaction`）。
 *
 * @module session-guardian/domain/trim
 */

/** 一个表层节点在裁剪决策里需要的全部信息。 */
export interface SurfaceNodeView {
  /** 该节点在日志里的事件序号。 */
  readonly seq: number
  /** 该节点消息的估算 token 数。 */
  readonly tokens: number
  /** 事件类型（`user/message`、`assistant/message`、`tool/result`…）。 */
  readonly type: string
  /** 事件写入时间（Unix 毫秒）。 */
  readonly time: number
  /**
   * 该节点对「未闭合工具调用」的净增量：
   * assistant 消息里每个 `tool-call` 块 +1，每个 `tool/result` −1，其余 0。
   */
  readonly toolCallDelta: number
  /**
   * 该节点是否为一轮的起点：来源是真实用户的 `user/message`。
   *
   * 检查点消息（来源 `compact-checkpoint`）与运行时上下文（来源
   * `runtime-context`）同样是 user 角色，但它们不是用户说的话，不能当作轮次
   * 锚点，否则第二次裁剪会把检查点算成新的一轮。
   */
  readonly roundAnchor: boolean
}

/** 一个策略值：普通值，或每次决策时重新读取的取器（热更新字段）。 */
export type TrimPolicyValue<T> = T | (() => T)

/**
 * 读取策略值。
 * @param value - 普通值或取器。
 * @returns 当前值。
 */
export function readPolicy<T>(value: TrimPolicyValue<T>): T {
  return typeof value === 'function' ? (value as () => T)() : value
}

/** 裁剪策略（部署参数）。 */
export interface TrimPolicy {
  /** 空闲多久之后才认为缓存已经冷了。 */
  readonly idleMs: TrimPolicyValue<number>
  /** 保留最近多少轮（以用户消息为锚）；0 表示不保留。 */
  readonly retainRounds: TrimPolicyValue<number>
  /** 少于这么多 token 的裁剪不值得做（检查点与固定提示本身也有成本）。 */
  readonly minShadowTokens: TrimPolicyValue<number>
  /** 检索工具不在场时是否跳过裁剪。 */
  readonly requireRetrieval: TrimPolicyValue<boolean>
}

/** 一次可执行的裁剪：被遮蔽的区间与保留的尾部。 */
export interface ShadowSelection {
  /** 区间首节点的真实事件序号（含）。 */
  readonly start: number
  /** 区间末节点的真实事件序号（含）。 */
  readonly end: number
  /** 保留窗口首节点在表层视图里的下标。 */
  readonly retainedFrom: number
  /** 被遮蔽内容的估算 token 数。 */
  readonly shadowedTokens: number
  /** 保留尾部的估算 token 数。 */
  readonly retainedTokens: number
  /** 保留的完整轮次数。 */
  readonly retainedRounds: number
}

/**
 * 会话是否已经空闲够久。
 * @param lastEventTime - 最后一个表层事件的写入时间。
 * @param now - 当前时刻。
 * @param idleMs - 空闲阈值；`<= 0` 表示不按空闲触发。
 * @returns 是否满足空闲条件。
 */
export function isIdle(lastEventTime: number, now: number, idleMs: number): boolean {
  return idleMs > 0 && now - lastEventTime >= idleMs
}

/**
 * 保留最近 N 轮，把更早的表层内容整段遮蔽。
 *
 * 规则：
 * - 开头的系统提示词节点永不遮蔽（它固定是表层第 0 号节点）；
 * - 以「非检查点、非运行时上下文」的用户消息为轮次锚点，保留最近
 *   `retainRounds` 轮；`0` 表示一轮都不保留，只留系统提示词与检查点；
 * - 锚点处如果工具调用余额不为 0，就继续向左退一轮，保证不切开配对；
 * - 被遮蔽的 token 少于 `minShadowTokens` 时返回 `null`（不值得裁）。
 *
 * @param nodes - 按模型可见顺序排列的表层视图。
 * @param retainRounds - 保留的轮次数；0 表示不保留，负数按 0 处理。
 * @param minShadowTokens - 触发裁剪的最小遮蔽量。
 * @returns 可执行的区间；不值得裁时 `null`。
 */
export function selectShadowRange(
  nodes: readonly SurfaceNodeView[],
  retainRounds: number,
  minShadowTokens: number,
): ShadowSelection | null {
  const first = firstShadowableIndex(nodes)
  if (first < 0) return null

  const anchors = roundAnchors(nodes)
  const keep = Math.max(0, Math.trunc(retainRounds))
  const balances = prefixBalances(nodes)

  let retainedFrom: number | undefined
  let retainedRounds = 0
  if (keep === 0) {
    // 不保留任何一轮：整层都遮蔽，但尾部必须没有未闭合的工具调用。
    retainedFrom = nodes.length
    retainedRounds = 0
  } else {
    if (anchors.length <= keep) return null
    let anchorIndex = anchors.length - keep
    retainedFrom = anchors[anchorIndex]
    // 切点向左移动＝少裁一点、多留一轮；这是保证工具调用配对完整的保守方向。
    while (anchorIndex > 0 && (retainedFrom === undefined || balances[retainedFrom] !== 0)) {
      anchorIndex -= 1
      retainedFrom = anchors[anchorIndex]
    }
    if (retainedFrom === undefined) return null
    retainedRounds = anchors.length - anchorIndex
  }
  if (balances[retainedFrom] !== 0) return null
  if (retainedFrom <= first) return null

  const firstNode = nodes[first]
  const lastShadowed = nodes[retainedFrom - 1]
  if (firstNode === undefined || lastShadowed === undefined) return null

  let shadowedTokens = 0
  for (let index = first; index < retainedFrom; index += 1) {
    shadowedTokens += nodes[index]?.tokens ?? 0
  }
  if (shadowedTokens < minShadowTokens) return null

  let retainedTokens = 0
  for (let index = retainedFrom; index < nodes.length; index += 1) {
    retainedTokens += nodes[index]?.tokens ?? 0
  }

  return {
    start: firstNode.seq,
    end: lastShadowed.seq,
    retainedFrom,
    shadowedTokens,
    retainedTokens,
    retainedRounds,
  }
}

/**
 * 第一个可以遮蔽的下标：跳过开头的系统提示词节点。
 * @param nodes - 表层视图。
 * @returns 下标；整层都是系统提示词时 −1。
 */
function firstShadowableIndex(nodes: readonly SurfaceNodeView[]): number {
  for (let index = 0; index < nodes.length; index += 1) {
    if (nodes[index]?.type !== 'system/message') return index
  }
  return -1
}

/**
 * 所有轮次起点的下标。
 * @param nodes - 表层视图。
 * @returns 升序下标数组。
 */
function roundAnchors(nodes: readonly SurfaceNodeView[]): number[] {
  const anchors: number[] = []
  for (let index = 0; index < nodes.length; index += 1) {
    if (nodes[index]?.roundAnchor === true) anchors.push(index)
  }
  return anchors
}

/**
 * 每个位置之前的工具调用余额：`balances[i]` 是 `nodes[0..i-1]` 的净增量之和。
 * 余额为 0 的位置就是安全切点。
 * @param nodes - 表层视图。
 * @returns 长度为 `nodes.length + 1` 的前缀余额。
 */
function prefixBalances(nodes: readonly SurfaceNodeView[]): number[] {
  const balances: number[] = [0]
  let balance = 0
  for (const node of nodes) {
    balance += node.toolCallDelta
    balances.push(balance)
  }
  return balances
}
