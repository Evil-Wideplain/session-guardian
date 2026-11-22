/**
 * 把持久会话日志读成裁剪决策需要的最小视图（应用层读模型）。
 *
 * 这里只做**读取与形状转换**：表层节点从 `session.surface` 拿顺序、从
 * `tokenMeter.measure()` 拿定价、从 `session.eventAt()` 拿事件类型与内容。
 * 决策规则在 `domain/trim.ts`，本文件不判断「该不该裁」。
 *
 * 放在应用层而不是基础设施层：它只读内存里的 `Session` 契约，没有文件、网络
 * 或进程副作用；基础设施层只剩落盘账本。
 *
 * 会话事件载荷在 DSH 里是合并扩展的联合类型，包外插件只能按结构窄化；
 * 所有读取都走 `record()` 守卫，遇到未知形状就当成空内容，不抛错。
 *
 * @module session-guardian/application/surface-view
 */

import type { SurfaceNodeView } from '../domain/trim.ts'
import type { ContentBlock, Session, SessionEvent, TokenMeasurement } from '../types.ts'

/** 能进入消息表层的事件类型。 */
const SURFACE_EVENT_TYPES: ReadonlySet<string> = new Set([
  'system/message',
  'developer/message',
  'user/message',
  'assistant/message',
  'tool/result',
])

/**
 * 读出一张与 `tokenMeter` 定价对齐的表层视图。
 * @param session - 目标会话。
 * @param measurement - 同一次回放得到的压力测量。
 * @returns 按模型可见顺序排列的节点视图。
 */
export function readSurfaceView(
  session: Session,
  measurement: TokenMeasurement,
): SurfaceNodeView[] {
  const nodes: SurfaceNodeView[] = []
  for (const node of measurement.nodes) {
    const event = session.eventAt(node.seq)
    if (event === undefined) continue
    nodes.push({
      seq: node.seq,
      tokens: node.heuristicTokens,
      type: event.type,
      time: event.time,
      toolCallDelta: toolCallDelta(event),
      roundAnchor: isRoundAnchor(event),
    })
  }
  return nodes
}

/**
 * 最后一个表层事件的写入时间；表层为空时返回 `undefined`。
 *
 * 不能用「最后一个事件」代替：回到旧会话时，回合一开就会写下 `turn/start`
 * （时刻是现在），而真正该看的是上一次**模型可见内容**是什么时候写的。
 * 这个扫描通常只看 1–2 个事件就命中。
 *
 * @param session - 目标会话。
 * @returns 事件时间（Unix 毫秒）。
 */
export function lastSurfaceEventTime(session: Session): number | undefined {
  for (let seq = session.seq - 1; seq >= 0; seq -= 1) {
    const event = session.eventAt(seq)
    if (event === undefined) continue
    if (SURFACE_EVENT_TYPES.has(event.type)) return event.time
  }
  return undefined
}

/**
 * 该节点是否为一轮的起点：来源是真实用户的 `user/message`。
 *
 * 检查点消息与运行时上下文同为 user 角色，但来源是 `compact-checkpoint` /
 * `runtime-context`；把它们算成轮次会让第二次裁剪的计数漂移。
 *
 * @param event - 会话事件。
 * @returns 是否为轮次锚点。
 */
function isRoundAnchor(event: SessionEvent): boolean {
  if (event.type !== 'user/message') return false
  const payload = record(event.data)
  const source = payload === undefined ? undefined : record(payload['source'])
  return source?.['kind'] === 'user'
}

/**
 * 一个节点对未闭合工具调用的净增量。
 * @param event - 会话事件。
 * @returns assistant 的 `tool-call` 块数，或 tool/result 的 −1。
 */
function toolCallDelta(event: SessionEvent): number {
  if (event.type === 'assistant/message') {
    const content = messageContent(event.data)
    let calls = 0
    for (const block of content) {
      if (block.type === 'tool-call') calls += 1
    }
    return calls
  }
  if (event.type === 'tool/result') return -1
  return 0
}

/**
 * 读一条消息事件的内容块。
 *
 * `user/message` 的载荷就是消息本身，其余消息事件把消息放在 `message` 里。
 * @param data - 事件载荷。
 * @returns 内容块；形状不认识时为空数组。
 */
function messageContent(data: unknown): readonly ContentBlock[] {
  const payload = record(data)
  if (payload === undefined) return []
  if (payload['role'] !== undefined) return blocksOf(payload['content'])
  const message = record(payload['message'])
  return message === undefined ? [] : blocksOf(message['content'])
}

/**
 * 把一个 JSON 值收窄成对象。
 * @param value - 任意值。
 * @returns 对象；不是普通对象时 `undefined`。
 */
function record(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
  return value as Record<string, unknown>
}

/**
 * 把一个 JSON 值收窄成内容块数组。
 * @param value - 任意值。
 * @returns 内容块；不是数组时为空数组。
 */
function blocksOf(value: unknown): readonly ContentBlock[] {
  return Array.isArray(value) ? value as readonly ContentBlock[] : []
}
