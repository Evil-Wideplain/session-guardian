/**
 * `list_watched_sessions` 模型工具：列出调用方可见的被看护会话。
 *
 * 每一行给出看护状态、会话是否在线、已心跳/已动作次数与最近一次时间，
 * 用来回答「我登记的那些长任务现在到哪一步了」。
 *
 * @module session-guardian/interfaces/tools/list
 */

import type { GuardianService } from '../../application/guardian-service.ts'
import type { ListResult, WatchRow } from '../../application/dto.ts'
import type { ToolDefinition } from '../../types.ts'
import { asObject, callerOf, clockText, inlineText, rejectUnknown } from './shared.ts'

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
      + '(watching, paused or stopped), whether the session is online and busy, how many heartbeats the watch has '
      + 'taken, how many times the guardian acted on it, and the last heartbeat and action times. Sessions you may '
      + 'not watch are counted in `omitted` instead of being listed.',
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
                heartbeat_count: { type: 'integer' },
                action_count: { type: 'integer' },
                last_heartbeat_at: { type: 'integer' },
                last_action_at: { type: 'integer' },
                note: { type: 'string' },
              },
              required: [
                'session_id',
                'short_id',
                'state',
                'online',
                'agent_status',
                'heartbeat_count',
                'action_count',
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
          const last = row.lastActionAt === undefined
            ? '尚未动作'
            : `最近动作 ${clockText(row.lastActionAt)}`
          return `- ${inlineText(row.shortId)}（id: ${inlineText(row.sessionId)}，state: ${inlineText(row.state)}，`
            + `agent: ${inlineText(row.agentStatus)}，心跳 ${row.heartbeatCount} 次，`
            + `动作 ${row.actionCount} 次，${last}${note}）`
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
          heartbeat_count: row.heartbeatCount,
          action_count: row.actionCount,
          ...row.lastHeartbeatAt === undefined ? {} : { last_heartbeat_at: row.lastHeartbeatAt },
          ...row.lastActionAt === undefined ? {} : { last_action_at: row.lastActionAt },
          ...row.note === undefined ? {} : { note: row.note },
        })),
        omitted: result.omitted,
      }
    },
  }
}
