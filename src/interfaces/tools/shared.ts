/**
 * 模型工具共用件：参数校验、调用方派生与文本清洗。
 *
 * 这些函数只做「形状 + 类型」校验，错误文案稳定可测；业务规则仍在应用服务
 * 与领域层。
 *
 * render 的输出是「一行一条」的结构化文本，而其中会话名、备注等字段来自模型
 * 本身或别的会话：它们只要带一个换行，就能伪造出新的结果行，所以动态文本
 * 一律先过 {@link inlineText}。
 *
 * @module session-guardian/interfaces/tools/shared
 */

import type { Caller } from '../../application/guardian-service.ts'
import type { ToolExecution } from '../../types.ts'

/** 拒绝非普通对象参数。 */
export function asObject(args: unknown): Record<string, unknown> {
  if (typeof args !== 'object' || args === null || Array.isArray(args)) {
    throw new Error('参数错误：需要一个对象')
  }
  return args as Record<string, unknown>
}

/** 读取必填字符串参数。 */
export function requiredString(args: Record<string, unknown>, key: string): string {
  const value = args[key]
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`参数错误："${key}" 必须是非空字符串`)
  }
  return value
}

/** 读取可选字符串参数。 */
export function optionalString(args: Record<string, unknown>, key: string): string | undefined {
  const value = args[key]
  if (value === undefined) return undefined
  if (typeof value !== 'string') throw new Error(`参数错误："${key}" 必须是字符串`)
  return value
}

/**
 * 拒绝宿主未拦截的未知顶层参数（宿主不执行 `additionalProperties`）。
 *
 * 多个未知参数时按字典序取第一个报错，保证错误文案稳定可测。
 * @param args - 已确认是普通对象的参数。
 * @param allowed - 该工具声明的顶层参数名。
 */
export function rejectUnknown(args: Record<string, unknown>, allowed: readonly string[]): void {
  const unknown = Object.keys(args).filter(key => !allowed.includes(key)).sort()
  const first = unknown[0]
  if (first !== undefined) throw new Error(`参数错误：未知参数 "${first}"`)
}

/**
 * 把动态文本压成不会破坏渲染结构的单行文本。
 *
 * 换行、U+2028/U+2029（行/段分隔符）与 C0/C1 控制字符都替换成空格：render
 * 按「一行一条」组织输出，残留的换行或行首 `- ` 会被模型当成新的结果行。
 * 连续空白折叠后 trim。
 * @param value - 原始文本；`undefined` 视为空串。
 * @param maximum - 可选的显示字符上限（含省略号）。
 * @returns 单行、已 trim、可选截断的文本。
 */
export function inlineText(value: string | undefined, maximum?: number): string {
  const flattened = (value ?? '')
    .replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim()
  if (maximum === undefined) return flattened
  const points = [...flattened]
  if (points.length <= maximum) return flattened
  return `${points.slice(0, Math.max(maximum - 1, 0)).join('')}…`
}

/**
 * 取运行时验证过的调用方；缺失时直接失败。
 * @param exec - 工具执行上下文。
 * @param tool - 工具名（用于错误信息）。
 * @returns 调用方身份。
 */
export function callerOf(exec: ToolExecution, tool: string): Caller {
  const agent = exec.agent
  if (agent === undefined) {
    throw new Error(`${tool} 需要调用方 Agent（exec.agent 为空）`)
  }
  return { sessionId: agent.id, cwd: agent.session.header.cwd ?? '' }
}

/** 把 Unix 毫秒格式化成 `HH:mm:ss`；非法时间返回 `—`。 */
export function clockText(time: number | undefined): string {
  if (time === undefined || !Number.isFinite(time)) return '—'
  const date = new Date(time)
  const pad = (value: number): string => String(value).padStart(2, '0')
  return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
}
