/**
 * `unwatch_session` 模型工具：停止看护一个会话。
 *
 * 停止看护不会取消正在跑的回合，也不删除会话历史：它只让插件不再检查这个会话、
 * 不再为它排续跑。
 *
 * @module session-guardian/interfaces/tools/unwatch
 */

import type { GuardianService } from '../../application/guardian-service.ts'
import type { UnwatchResult } from '../../application/dto.ts'
import type { ToolDefinition } from '../../types.ts'
import { asObject, callerOf, inlineText, rejectUnknown, requiredString } from './shared.ts'

/**
 * 构造 `unwatch_session` 工具。
 * @param service - 看护应用服务。
 * @returns 可注册的工具定义。
 */
export function createUnwatchTool(service: GuardianService): ToolDefinition {
  return {
    name: 'unwatch_session',
    description:
      'Stop watching a session. The guardian no longer checks it and no longer queues automatic continuations for '
      + 'it. A session that was never watched is reported as not watched rather than treated as an error. The running '
      + 'turn and the session history are left untouched.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        session_id: {
          type: 'string',
          description: 'The session to stop watching.',
        },
      },
      required: ['session_id'],
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          session_id: { type: 'string' },
          removed: { type: 'boolean' },
        },
        required: ['session_id', 'removed'],
      },
      render: (_args, value) => {
        const result = value as UnwatchResult
        const text = result.removed
          ? `已停止看护：${inlineText(result.sessionId)}`
          : `该会话本来就没有在看护：${inlineText(result.sessionId)}`
        return [{ type: 'text', text }]
      },
    },
    async execute(args, exec) {
      const parsed = asObject(args)
      rejectUnknown(parsed, ['session_id'])
      const sessionId = requiredString(parsed, 'session_id')
      const caller = callerOf(exec, 'unwatch_session')
      const result = await service.unwatch(caller, sessionId)
      return { session_id: result.sessionId, removed: result.removed }
    },
  }
}
