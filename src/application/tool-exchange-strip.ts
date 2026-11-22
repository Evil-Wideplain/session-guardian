/**
 * 把保留窗口里的「工具交换」从模型可见历史中整段移出（`keepToolRecords: false`）。
 *
 * 一段工具交换是：一条带 `tool-call` 块的 assistant 消息，加上它后面连续的
 * `tool/result` 节点。移除方式是**表层替换成一条空 content 的 `system/message`**：
 *
 * - 空 system 节点留在表层占位，但 `deriveEventMessage()` 对它返回 `null`，
 *   因此不会进入任何 provider 请求；
 * - 替换事件不是 `assistant/message`，允许携带 `sourceEventSeqs`（assistant 被
 *   禁止携带，这是「不能把 assistant 换成 assistant」的唯一原因）；
 * - 目标不是表层第 0 号节点，不受「系统提示词只能被系统提示词替换」的保护规则
 *   限制（该规则只检查 `startIdx === 0`）。
 *
 * 代价写在明处：一条 assistant 消息里如果同时有正文和工具调用，整段移除会连
 * 正文一起消失——表层没有「只删块、保留消息」的操作。相邻的两条用户消息可能
 * 因此变成连续出现，适配器通常能接受，但需要在真实会话上验证。
 *
 * @module session-guardian/application/tool-exchange-strip
 */

import { randomUUID } from 'node:crypto'
import type { ContentBlock, Session, SessionEvent } from '../types.ts'

/** 空占位节点的来源标记：系统提示词生产者，与 system 角色一致。 */
const PLACEHOLDER_SOURCE_KIND = 'system-prompt'

/** 一次工具交换清理的结果。 */
export interface ToolExchangeStripOutcome {
  /** 被整段移出的交换数。 */
  readonly stripped: number
}

/**
 * 移除保留窗口里的全部工具交换。
 *
 * 失败不向上抛：压缩已经落账，清理失败只记一条警告。单段失败不影响后续段落。
 *
 * @param session - 目标会话。
 * @param afterSeq - 检查点节点的事件序号；只处理它**之后**的表层节点。
 * @param warn - 诊断日志。
 * @returns 移除的交换数。
 */
export function stripToolExchanges(
  session: Session,
  afterSeq: number,
  warn: (message: string) => void = () => {},
): ToolExchangeStripOutcome {
  const nodes = [...session.surface.nodes]
  const checkpoint = nodes.indexOf(afterSeq)
  if (checkpoint < 0) return { stripped: 0 }
  const retained = nodes.slice(checkpoint + 1)

  let stripped = 0
  for (let index = 0; index < retained.length; index += 1) {
    const seq = retained[index]
    if (seq === undefined) continue
    const event = session.eventAt(seq)
    if (event?.type !== 'assistant/message') continue
    if (!hasToolCall(blocksOf(event))) continue

    const span: number[] = [seq]
    let cursor = index + 1
    while (cursor < retained.length) {
      const nextSeq = retained[cursor]
      if (nextSeq === undefined) break
      const next = session.eventAt(nextSeq)
      if (next?.type !== 'tool/result') break
      span.push(nextSeq)
      cursor += 1
    }

    const coordinates = turnStepOf(event)
    if (coordinates === undefined) {
      warn(`tool exchange at seq ${seq} was not stripped: missing turn/step coordinates`)
      continue
    }

    try {
      session.append('system/message', {
        turn: coordinates.turn,
        step: coordinates.step,
        message: {
          id: randomUUID(),
          role: 'system',
          content: [],
          source: { kind: PLACEHOLDER_SOURCE_KIND },
        },
      }, {
        surfaceOp: { op: 'replace', startSeq: seq, endSeq: span[span.length - 1] as number },
        sourceEventSeqs: span,
      })
      stripped += 1
      index = cursor - 1
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error)
      warn(`tool exchange at seq ${seq} was not stripped: ${message}`)
    }
  }
  return { stripped }
}

/**
 * 一条 assistant 事件里是否包含工具调用块。
 * @param content - 消息内容块。
 * @returns 是否包含 `tool-call`。
 */
function hasToolCall(content: readonly ContentBlock[]): boolean {
  return content.some(block => block.type === 'tool-call')
}

/**
 * 读 assistant 消息的内容块。
 * @param event - assistant 事件。
 * @returns 内容块；形状不认识时为空数组。
 */
function blocksOf(event: SessionEvent): readonly ContentBlock[] {
  const data = record(event.data)
  const message = data === undefined ? undefined : record(data['message'])
  if (message === undefined) return []
  const content = message['content']
  return Array.isArray(content) ? content as readonly ContentBlock[] : []
}

/**
 * 读 assistant 事件的回合/步骤坐标。
 * @param event - assistant 事件。
 * @returns 坐标；缺失或不是整数时 undefined。
 */
function turnStepOf(event: SessionEvent): { readonly turn: number; readonly step: number } | undefined {
  const data = record(event.data)
  if (data === undefined) return undefined
  const turn = data['turn']
  const step = data['step']
  if (typeof turn !== 'number' || !Number.isInteger(turn)) return undefined
  if (typeof step !== 'number' || !Number.isInteger(step)) return undefined
  return { turn, step }
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
