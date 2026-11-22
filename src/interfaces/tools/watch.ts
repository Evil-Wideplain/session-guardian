/**
 * `watch_session` 模型工具：登记一个会话进入看护。
 *
 * 只做参数校验与 DTO 投影；授权、落账本与投影成行都在应用服务里完成。
 *
 * 参数刻意保持最少：看护「期间做什么」由核心机制决定，而机制尚未定下来，
 * 因此这里不暴露续跑提示词、续跑次数之类的旋钮——它们属于机制，不属于登记。
 *
 * @module session-guardian/interfaces/tools/watch
 */

import type { GuardianService } from '../../application/guardian-service.ts'
import type { WatchResult } from '../../application/dto.ts'
import type { ToolDefinition } from '../../types.ts'
import { asObject, callerOf, inlineText, optionalString, rejectUnknown, requiredString } from './shared.ts'

/**
 * 构造 `watch_session` 工具。
 * @param service - 看护应用服务。
 * @returns 可注册的工具定义。
 */
export function createWatchTool(service: GuardianService): ToolDefinition {
  return {
    name: 'watch_session',
    description:
      'Put a session under guardian watch, so this plugin keeps checking on it while long work runs. Use it when a '
      + 'task may take many turns: register the session, let the guardian do its job, and check on it later with '
      + 'list_watched_sessions. Watching your own session is always allowed; watching a session in another working '
      + 'directory needs the deployment to allow cross-workspace watching. Calling it again on the same session '
      + 'updates the existing watch instead of failing.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        session_id: {
          type: 'string',
          description: 'The session to watch. Pass your own session id to watch the work in this very session.',
        },
        note: {
          type: 'string',
          description: 'One line describing what this watch is for. Shown in list_watched_sessions.',
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
          created: { type: 'boolean' },
          state: { type: 'string', enum: ['watching', 'paused', 'stopped'] },
        },
        required: ['session_id', 'created', 'state'],
      },
      render: (_args, value) => {
        const result = value as WatchResult
        const verb = result.created ? '已登记看护' : '已更新看护'
        return [{
          type: 'text',
          text: `${verb}：${inlineText(result.sessionId)}，状态 ${inlineText(result.state)}`,
        }]
      },
    },
    async execute(args, exec) {
      const parsed = asObject(args)
      rejectUnknown(parsed, ['session_id', 'note'])
      const sessionId = requiredString(parsed, 'session_id')
      const note = optionalString(parsed, 'note')

      const caller = callerOf(exec, 'watch_session')
      const result = await service.watch(caller, {
        sessionId,
        ...note === undefined ? {} : { note },
      })
      return {
        session_id: result.sessionId,
        created: result.created,
        state: result.state,
      }
    },
  }
}
