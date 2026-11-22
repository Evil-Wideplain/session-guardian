/**
 * 心跳调度器（应用层运行时）。
 *
 * 按固定节奏触发一轮看护检查。三条约束：
 * - **不重叠**：上一轮还没跑完时跳过这一轮。心跳检查本身是同步的（读内存里的
 *   看护表），但核心机制可能触发模型请求，重叠会让节奏失控。
 * - **定时器可回收**：优先用宿主的 `ctx.timer`（基础 bundle 的 `timer` 行提供），
 *   宿主停用插件时定时器随之被收回；拿不到时才退回裸 `setInterval` 并 `unref`。
 * - **不阻塞进程退出**：退回裸定时器时 `unref`，插件停用后不留下悬挂句柄。
 *
 * @module session-guardian/application/heartbeat
 */

/**
 * 定时器切片：与 `ctx.timer.interval` 的形状一致。
 */
export interface IntervalTimer {
  /** 反复执行回调；返回注销函数。 */
  interval(callback: () => void, delay: number): () => void
}

/** 一轮心跳的执行结果。 */
export interface HeartbeatResult {
  /** 本轮动了手的会话数。 */
  readonly acted: number
}

/**
 * 固定节奏的看护检查调度器。
 */
export class HeartbeatScheduler {
  /** 心跳间隔（毫秒）。 */
  private readonly intervalMs: number
  /** 一轮心跳的执行体。 */
  private readonly tick: () => Promise<HeartbeatResult>
  /** 日志出口。 */
  private readonly log: (message: string) => void
  /** 宿主定时器；缺席时退回裸 `setInterval`。 */
  private readonly timer: IntervalTimer | undefined
  /** 定时器句柄。 */
  private handle: (() => void) | undefined
  /** 上一轮是否仍在执行。 */
  private running = false

  /**
   * @param intervalMs - 心跳间隔（毫秒）。
   * @param tick - 一轮心跳的执行体。
   * @param log - 日志出口。
   * @param timer - 宿主定时器；可选，缺席时退回裸 `setInterval`。
   */
  constructor(
    intervalMs: number,
    tick: () => Promise<HeartbeatResult>,
    log: (message: string) => void,
    timer?: IntervalTimer,
  ) {
    this.intervalMs = intervalMs
    this.tick = tick
    this.log = log
    this.timer = timer
  }

  /**
   * 启动调度器。
   *
   * 重复调用是安全的：已经在跑时直接返回。
   */
  start(): void {
    if (this.handle !== undefined) return
    if (this.timer !== undefined) {
      this.handle = this.timer.interval(() => { void this.runOnce() }, this.intervalMs)
      return
    }
    this.log('宿主没有提供 timer 服务，心跳退回进程内定时器')
    const raw = setInterval(() => { void this.runOnce() }, this.intervalMs)
    // 不阻止进程退出：插件停用后定时器不应该把宿主吊住。
    raw.unref?.()
    this.handle = () => { clearInterval(raw) }
  }

  /**
   * 停止调度器。
   */
  stop(): void {
    if (this.handle === undefined) return
    this.handle()
    this.handle = undefined
  }

  /**
   * 手动跑一轮心跳（测试与「立刻检查一次」用）。
   * @returns 本轮结果；上一轮未结束时返回 undefined。
   */
  async runOnce(): Promise<HeartbeatResult | undefined> {
    if (this.running) return undefined
    this.running = true
    try {
      return await this.tick()
    } catch (error: unknown) {
      const detail = error instanceof Error ? error.message : String(error)
      this.log(`心跳执行失败：${detail}`)
      return undefined
    } finally {
      this.running = false
    }
  }
}
