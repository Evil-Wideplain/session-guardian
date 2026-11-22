/**
 * `list_watched_sessions` 模型工具：列出调用方可见的被看护会话。
 *
 * 每一行给出看护状态、会话是否在线、登记时刻与备注，用来回答「我登记过的
 * 那些长任务还能不能找回来」。
 *
 * @module session-guardian/interfaces/tools/list
 */

import type { GuardianService } from '../../application/guardian-service.ts'
import type { ListResult, WatchRow } from '../../application/dto.ts'
import type { ToolDefinition } from '../../types.ts'
import { asObject, callerOf, inlineText, rejectUnknown, timestampText } from './shared.ts'

/**
 * 构造 `list_watched_sessions` 工具。
 * @param service - 看护应用服务。
 * @returns 可注册的工具定义。
 */
export function createListTool(service: GuardianService): ToolDefinition {
  return {
    name: 'list_watched_sessions',
    description:
      'List the sessions under guardian watch, oldest watch first. Each row carries the session id, the watch state '
      + '(watching, paused or stopped), whether the session is online and busy, when it was registered, and the note '
      + 'given at registration. Sessions you may not watch are counted in `omitted` instead of being listed.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {},
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          sessions: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                session_id: { type: 'string' },
                short_id: { type: 'string' },
                state: { type: 'string', enum: ['watching', 'paused', 'stopped'] },
                online: { type: 'boolean' },
                agent_status: { type: 'string', enum: ['idle', 'running', 'offline'] },
                created_at: { type: 'integer' },
                note: { type: 'string' },
              },
              required: [
                'session_id',
                'short_id',
                'state',
                'online',
                'agent_status',
                'created_at',
              ],
            },
          },
          omitted: { type: 'integer' },
        },
        required: ['sessions', 'omitted'],
      },
      render: (_args, value) => {
        const result = value as ListResult
        if (result.rows.length === 0) {
          return [{ type: 'text', text: '当前没有被看护的会话' }]
        }
        const lines = result.rows.map((row: WatchRow) => {
          const note = row.note === undefined || row.note.trim() === '' ? '' : `，备注：${inlineText(row.note, 80)}`
          return `- ${inlineText(row.shortId)}（id: ${inlineText(row.sessionId)}，state: ${inlineText(row.state)}，`
            + `agent: ${inlineText(row.agentStatus)}，登记于 ${timestampText(row.createdAt)}${note}）`
        })
        const hidden = result.omitted > 0 ? `（另有 ${result.omitted} 个会话对你不可见）` : ''
        return [{ type: 'text', text: `${lines.join('\n')}${hidden}` }]
      },
    },
    async execute(args, exec) {
      const parsed = asObject(args)
      rejectUnknown(parsed, [])
      const caller = callerOf(exec, 'list_watched_sessions')
      const result = service.list(caller)
      return {
        sessions: result.rows.map(row => ({
          session_id: row.sessionId,
          short_id: row.shortId,
          state: row.state,
          online: row.online,
          agent_status: row.agentStatus,
          created_at: row.createdAt,
          ...row.note === undefined ? {} : { note: row.note },
        })),
        omitted: result.omitted,
      }
    },
  }
}
