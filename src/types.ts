/**
 * 本插件用到的 DSH 服务与数据结构的本地契约（单文件，只做类型声明）。
 *
 * 插件刻意不在运行时或构建期导入任何 `@deepseek-ai/dsh-*` 包：它是 bundle
 * 插件，必须在不同 alpha 版本之间继续可用，因此只声明自己用到的服务切片，
 * 真实对象由 Cordis 传入。这些结构已对照 0.2.x 源码核对；构建产物里不会留下
 * 对 `@deepseek-ai/dsh-*` 的 import。
 *
 * 文件内按主题分节：会话日志 → Agent → 压缩与计量 → 工具 → 运行时服务 →
 * Cordis 上下文增补。增补必须与这些声明一起进入编译单元，`ctx.tools`、
 * `ctx.agents` 等成员才会在插件代码里可见。
 *
 * @module session-guardian/types
 */

// ---------------------------------------------------------------------------
// 会话日志与消息
// ---------------------------------------------------------------------------

/** 持久的会话标识（本插件按不透明字符串处理）。 */
export type SessionId = string

/** 一个面向模型的内容块。 */
export interface ContentBlock {
  readonly type: string
  readonly text?: string
  readonly [key: string]: unknown
}

/** 每条 user 消息携带的生产者来源（kind 是开放字符串）。 */
export interface MessageSource {
  readonly kind: string
  readonly form?: string
  readonly [key: string]: unknown
}

/** 本插件唯一产出的消息形状：user 角色文本消息。 */
export interface UserMessage {
  readonly id: string
  readonly role: 'user'
  readonly content: ContentBlock[]
  readonly source: MessageSource
}

/** 一条只追加的会话事件（只声明本插件读取的字段）。 */
export interface SessionEvent {
  readonly type: string
  readonly seq: number
  readonly time: number
  readonly data: unknown
}

/** 一次表层替换：把当前表层里 `startSeq`–`endSeq`（含端点，按位置解释）换成新节点。 */
export interface SurfaceReplacement {
  readonly op: 'replace'
  readonly startSeq: number
  readonly endSeq: number
}

/** `session.append()` 的表层意图与来源引用。 */
export interface AppendOptions {
  /**
   * 表层意图：surface 事件必须显式声明；`'append'` 是追加，对象是替换。
   * 仅日志事件禁止携带它。
   */
  readonly surfaceOp?: 'append' | SurfaceReplacement
  /** 本事件引用的更早事件序号（派生来源 / 被替换节点）。 */
  readonly sourceEventSeqs?: readonly number[]
}

/**
 * 回合收口的原因。
 *
 * DSH 的 `turn/end` 事件用它说明这一回合是怎么结束的：
 * - `completed`：模型正常跑完；
 * - `max-tokens`：某一步撞到输出上限（在一个回合内是粘性的）；
 * - `blocked`：`agent/pre-step` 的监听方拒绝了这个步骤，模型根本没被调用；
 * - `aborted`：被取消；
 * - `error`：模型调用失败；
 * - `interrupted`：崩溃留下的孤儿回合被事后补收口，运行时不会主动写它。
 */
export type TurnEndReason =
  | 'completed'
  | 'max-tokens'
  | 'blocked'
  | 'aborted'
  | 'error'
  | 'interrupted'

/** `turn/end` 事件的载荷（只声明本插件消费的字段）。 */
export interface TurnEndData {
  readonly turn?: number
  readonly reason?: { readonly kind?: TurnEndReason | string }
  readonly error?: unknown
}

/** 持久的会话元数据（只声明本插件读取的字段）。 */
export interface SessionHeader {
  readonly id: SessionId
  readonly cwd?: string
}

/** 最近一次已记录请求头的切片（只声明本插件读的字段）。 */
export interface RequestHeader {
  /** 该请求的路由配置。 */
  readonly config?: { readonly provider?: string; readonly model?: string }
  /**
   * 请求头写入原因：`initial` / `resume` / `change` / `series`。
   *
   * `resume` 表示「循环实例的首个请求」，也就是回到一个已有历史的会话后
   * 发出的第一步——本插件用它之外的信号（事件时间）判断空闲，不依赖它，
   * 因为 pre-step 时即将写下的请求头还不存在。
   */
  readonly reason?: string
}

/** 当前消息表层：按模型可见顺序排列的事件序号。 */
export interface SessionSurface {
  readonly nodes: readonly number[]
}

/** 一份在线会话日志。 */
export interface Session {
  readonly id: SessionId
  readonly header: SessionHeader
  readonly inheritedEventCount: number
  /** 当前日志长度；下一个事件的序号。 */
  readonly seq: number
  /** 当前消息表层；替换已经折叠进去。 */
  readonly surface: SessionSurface
  /** 本会话自己的事件（不含 fork 继承的前缀）。 */
  ownEvents(): readonly SessionEvent[]
  /**
   * 按序号读取一个已提交事件。
   *
   * DSH 0.2.x 把这个方法标为「既有逻辑可暂不迁移，禁止新增生产调用」，
   * 关闭在 `snapshotEvents` / `eventAt` / `ownEvents` 三者上；包外插件没有
   * 别的按序号读取入口，因此本插件只在**表层节点与尾部扫描**这两处使用它。
   * @param seq - 事件序号。
   * @returns 事件；该序号还没有事件时 undefined。
   */
  eventAt(seq: number): SessionEvent | undefined
  /**
   * 追加一个类型化事件。
   * @param type - 事件类型。
   * @param data - 事件载荷。
   * @param options - 表层意图与来源引用。
   * @returns 已提交的事件。
   */
  append(type: string, data: unknown, options?: AppendOptions): SessionEvent
  /** 最近一次已记录的请求头；会话还没有请求时 undefined。 */
  requestHeader(): RequestHeader | undefined
}

// ---------------------------------------------------------------------------
// Agent
// ---------------------------------------------------------------------------

/** 一个在线 Agent 的模型路由选项。 */
export interface AgentOptions {
  readonly provider?: string
  readonly model?: string
  readonly reasoningEffort?: string
  readonly maxTokens?: number
  readonly [key: string]: unknown
}

/** Agent 的生命周期状态：`running` 表示有回合在跑，`idle` 表示驱动已卸载。 */
export type AgentStatus = 'idle' | 'running'

/**
 * 驱动一个会话的在线 Agent。
 *
 * 本插件关心两个动作：`followup` 排一个后续回合并唤醒驱动；`runMaintenance`
 * 在 Agent 真正空闲的阶段占住它，避免与一个正在跑的回合抢。
 */
export interface Agent {
  readonly id: SessionId
  readonly session: Session
  /** 当前生命周期状态。 */
  readonly status: AgentStatus
  /** 本实例用于请求的模型路由；恢复的 Agent 只有显式传入时才有。 */
  readonly options?: AgentOptions
  /** 排入一个后续 turn（空闲 Agent 会被唤醒）。 */
  followup(message: UserMessage): void
  /** 把消息排到最近的 step 边界（空闲 Agent 会被唤醒）。 */
  steer(message: UserMessage): void
  /** 排入模型可见的上下文，不唤醒驱动。 */
  inject(message: UserMessage): void
  /** 解析到整台 Agent 静默（没有驱动也没有维护任务在跑）。 */
  whenIdle(): Promise<void>
  /**
   * 在 Agent 真正空闲的阶段跑一段非回合任务。
   *
   * 任务同步开始抢占这个阶段；期间到来的唤醒输入留在 inbox 里，任务收口后才
   * 被取走，而对外的 `status` 仍是 `idle`。
   * @param task - 任务体；收到取消信号。
   * @returns 任务的完成值。
   * @throws 回合驱动或另一个维护任务已经占用这个 Agent 时同步抛出。
   */
  runMaintenance<T>(task: (signal: AbortSignal) => Promise<T>): Promise<T>
}

/**
 * `agent/pre-step` waterfall 的决定。
 *
 * `enter` 带本步要提交的用户消息（监听方可以替换）；`reject` 拒绝本步，
 * 模型不会被调用。
 */
export type PreStepDecision =
  | { readonly kind: 'enter'; readonly messages: readonly UserMessage[] }
  | { readonly kind: 'reject'; readonly reason: string }

/** `ctx.agents.resume` 返回的、由调用方拥有的在线 Agent 句柄。 */
export interface AgentHandle {
  readonly agent: Agent
  /** 停掉 Agent 并从注册表摘除；只有句柄持有者能做这件事。 */
  dispose(): void | Promise<void>
}

// ---------------------------------------------------------------------------
// 压缩与计量
// ---------------------------------------------------------------------------

/** 自动压缩的触发原因。 */
export type CompactionTrigger = 'pressure' | 'context-overflow'

/** 一次成功压缩对外的结果；字段与 `dsh-compaction` 的 `CompactionResult` 同形。 */
export interface CompactionResult {
  /** 本次事务的标识；检查点消息的 source 带上它。 */
  readonly compactionId: string
  /** 手动压缩的发起命令；自动压缩没有。 */
  readonly sourceCommandId?: string
  /** `compaction/start` 事件的序号。 */
  readonly startSeq: number
  /** `compaction/summary` 事件的序号。 */
  readonly summarySeq: number
  /** `compaction/end` 事件的序号。 */
  readonly endSeq: number
  /** 写进检查点消息的摘要内容块。 */
  readonly summary: readonly ContentBlock[]
  /** 被遮蔽的表层区间（含端点，按表层位置解释）。 */
  readonly shadowedRange: { readonly start: number; readonly end: number }
  /** 被遮蔽节点的真实事件序号。 */
  readonly shadowedSeqs: readonly number[]
  /** 被遮蔽内容的估算 token 数。 */
  readonly shadowedTokenCount: number
}

/**
 * 压缩后端契约（对应 `dsh-compaction` 的 `CompactionEngine`）。
 *
 * 一个上下文里只能挂一个实现，作为 `ctx.compaction` 提供；随附后端是
 * `@deepseek-ai/dsh-compaction-basic`，切换成本包的 `session-guardian/compaction`
 * 行时必须先停用随附后端那一行。
 */
export interface CompactionService {
  /**
   * 按自动策略考虑一次压缩。
   * @param agent - 目标 Agent（提供会话与路由选项）。
   * @param trigger - 压力触发或提供方确认的上下文溢出。
   * @param signal - 取消信号。
   * @returns 压缩结果；没有可安全裁剪的区间时为 `null`。
   */
  compactIfNeeded(
    agent: Agent,
    trigger: CompactionTrigger,
    signal: AbortSignal,
  ): Promise<CompactionResult | null>

  /**
   * 在空闲 Agent 上显式压缩一次。
   * @param agent - 空闲的 Agent。
   * @param signal - 本次压缩的取消信号。
   * @param sourceCommandId - 发起命令（`/compact`）的标识。
   * @returns 压缩结果；没有有用区间时为 `null`。
   */
  compactNow(
    agent: Agent,
    signal: AbortSignal,
    sourceCommandId?: string,
  ): Promise<CompactionResult | null>

  /**
   * 强制把一段表层区间替换成一条检查点消息。
   * @param start - 区间首节点（含），按表层位置解释。
   * @param end - 区间末节点（含），按表层位置解释。
   * @param agent - 目标 Agent。
   * @param signal - 取消信号。
   * @returns 成功写入的结果。
   */
  compactRegion(
    start: number,
    end: number,
    agent: Agent,
    signal?: AbortSignal,
  ): Promise<CompactionResult>
}

/** 一个已定价的表层节点（`tokenMeter.measure()` 的 `nodes` 元素）。 */
export interface MeterSurfaceNode {
  /** 该表层节点在日志里的事件序号。 */
  readonly seq: number
  /** 该节点消息的固定启发式价格。 */
  readonly heuristicTokens: number
}

/** 一次请求压力测量。 */
export interface TokenMeasurement {
  /** 请求与响应的总压力。 */
  readonly totalTokens: number
  /** 仅表层的路由定价总量。 */
  readonly surfaceTokens: number
  /** 当前表层节点，按模型可见顺序排列。 */
  readonly nodes: readonly MeterSurfaceNode[]
}

/** token 计量服务（`ctx.tokenMeter`）的切片。 */
export interface TokenMeterService {
  /** 回放日志得到压力快照。 */
  measure(session: Session): TokenMeasurement
  /** 用固定启发式规则给一条消息估价。 */
  estimateMessage(message: UserMessage): number
}

/** 一段系统提示词（对应 `ctx.systemPrompt.section()` 的注册入参）。 */
export interface PromptSection {
  /** 唯一名字；重复注册会抛错。 */
  readonly name: string
  /** 升序拼接；同序按名字的码元顺序。 */
  readonly order: number
  /** 静态文本，或每次组装时求值（返回空字符串表示本次不出现）。 */
  readonly text: string | ((context: unknown) => string)
  /** 是否做 `{{variable}}` 插值；默认 true。 */
  readonly interpolate?: boolean
}

/** 系统提示词注册表（`ctx.systemPrompt`）的切片。 */
export interface SystemPromptService {
  /** 注册一段固定文本；返回释放函数。 */
  section(section: PromptSection): () => void
  /** 取中心分配的段位序号。 */
  getSectionOrder(name: string): number
}

// ---------------------------------------------------------------------------
// 工具
// ---------------------------------------------------------------------------

/** 工具执行时看到的上下文。 */
export interface ToolExecution {
  readonly callId: string
  readonly name: string
  readonly arguments: unknown
  readonly agent?: Agent
  readonly signal: AbortSignal
}

/** `ctx.tools.register` 接受的结构形状。 */
export interface ToolDefinition {
  readonly name: string
  readonly description: string
  readonly parameters: Record<string, unknown>
  readonly output: {
    readonly schema: Record<string, unknown>
    render(args: unknown, value: unknown): ContentBlock[]
  }
  execute(args: unknown, exec: ToolExecution): Promise<unknown>
}

/** 工具注册表切片。 */
export interface ToolsService {
  register(definition: ToolDefinition): () => void
  /**
   * 按名字取一个已注册的工具；不存在时 undefined。
   *
   * 可选：用来判断「检索工具是否真的挂载了」。只检查 `ctx.sessionQuery` 服务
   * 是不够的——服务在场不代表面向模型的工具已注册。
   */
  get?(name: string): unknown
}

// ---------------------------------------------------------------------------
// 运行时服务
// ---------------------------------------------------------------------------

/** Agent 注册表切片。 */
export interface AgentsService {
  list(): Agent[]
  get(id: SessionId): Agent | undefined
  /** 恢复一个持久化但未加载的会话；返回的句柄拥有它的生命周期。 */
  resume(options: {
    readonly resumeSessionId: SessionId
    readonly agentOptions?: Record<string, unknown>
    readonly setup?: (agentCtx: unknown) => void | Promise<void>
    readonly signal?: AbortSignal
  }): Promise<AgentHandle>
}

/** 会话存储切片。 */
export interface SessionsService {
  get(id: SessionId): Session | undefined
  /**
   * 触发一次持久化落盘。
   *
   * 这是唯一的落盘入口：会话存储拥有载体，调用方必须走这里。
   * @param session - 要落盘的会话。
   * @returns 至少一个落盘监听者参与过时为 true。
   */
  flush(session: Session): Promise<boolean>
}

// ---------------------------------------------------------------------------
// Cordis 上下文与事件增补
// ---------------------------------------------------------------------------

declare module '@deepseek-ai/cordis' {
  interface Context {
    tools: ToolsService
    agents: AgentsService
    sessions: SessionsService
    /** 系统提示词注册表（基础 bundle 必有）。 */
    systemPrompt: SystemPromptService
    /**
     * 压缩后端（可选）。随附后端 `@deepseek-ai/dsh-compaction-basic` 与
     * 本包的 `session-guardian/compaction` 行都提供它；两者互斥。
     */
    compaction?: CompactionService
    /** token 计量服务（可选；基础 bundle 的 `token-meter` 行提供）。 */
    tokenMeter?: TokenMeterService
    /** 会话检索服务（可选；`dsh-experimental-session-search` 组合包提供）。 */
    sessionQuery?: unknown
  }

  interface Events {
    'agent/created'(payload: { readonly agent: Agent }): void
    'agent/disposed'(payload: { readonly agent: Agent }): void
    /** 生命周期状态迁移；`idle` 表示驱动已卸载、Agent 处于真正的空闲阶段。 */
    'agent/status'(payload: { readonly agent: Agent; readonly status: AgentStatus }): void
    /** 回合即将收口：在边界提交之前触发，监听方可以再 steer 一次把回合撑开。 */
    'agent/turn-stopping'(payload: { readonly agent: Agent; readonly turn: number }): void
    /**
     * 请求组装前的串行 waterfall，在待提交的用户消息进入历史之前触发。
     *
     * 监听方可以替换 `messages`（`kind: 'enter'`）或拒绝本步（`kind: 'reject'`）。
     * 压缩在这里完成时，替换已经写进表层，因此立刻随后的请求就能看到检查点。
     */
    'agent/pre-step'(
      payload: {
        readonly agent: Agent
        readonly messages: readonly UserMessage[]
        readonly turn: number
        readonly step: number
        readonly signal: AbortSignal
        readonly modelSelection: unknown
      },
      next: () => Promise<PreStepDecision>,
    ): Promise<PreStepDecision>
    'agent/error'(payload: {
      readonly agent: Agent
      readonly turn: number
      readonly step: number
      readonly error: unknown
    }): void
    /** 会话日志事件；`turn/end` 的 `reason` 说明这一回合是怎么收口的。 */
    'session/event'(session: Session, event: SessionEvent): void
  }
}
