/**
 * 压缩检查点的扩展契约与默认正文构造（纯类型 + 纯函数）。
 *
 * 默认正文**只有固定说明**，不含目录：
 *
 * 1. 早前这段历史被移出了上下文，但完整地留在会话日志里；
 * 2. 怎么取回（`session_event_search` 省略 session_id、`surfaces: ["shadowed"]`，
 *    `session_event_read(seq)` 读原文）；
 * 3. 本次被移出的区间与估算 token 数。
 *
 * 为什么不再生成「每轮一条」的目录：目录需要逐条读取被遮消息、成本随历史线性
 * 增长，而且模型真正缺的是「知道可以搜、以及搜索的精确用法」，不是一份可能
 * 与真实日志有偏差的摘要。去掉目录后检查点大小基本恒定（约 560 字符），
 * 也就能把「检查点必须比被遮内容小」这条约束当成一个稳定的前提。
 *
 * 想换成别的形态（模板、规则摘要、远程服务），实现 {@link CheckpointBuilder}
 * 替换后端的那一个扩展点即可，区间选择、事务与计量都不必重写。
 *
 * 检索指令必须点名 `session_event_search`：`session_search` 只搜**别的**会话
 * （按 workspace 过滤并排除调用方），用它取不回当前会话的历史。检索是字面
 * token 匹配，所以提示里要强调用路径、命令、报错原文这类精确词。
 *
 * @module session-guardian/domain/checkpoint
 */

import type { ContentBlock } from '../types.ts'

/** 一次检查点构造的输入。 */
export interface CheckpointInput {
  /** 会话标识；写进正文供模型确认检索目标。 */
  readonly sessionId: string
  /** 被遮蔽区间的首事件序号。 */
  readonly start: number
  /** 被遮蔽区间的末事件序号。 */
  readonly end: number
  /** 被遮蔽内容的估算 token 数。 */
  readonly shadowedTokens: number
}

/** 检查点正文的构造选项。 */
export interface CheckpointOptions {
  /**
   * 本部署里 `session_event_search` 是否真的挂载。
   *
   * 不在场时不点名工具：提示词里提到一个不存在的工具比不提更糟。
   */
  readonly retrieval?: boolean
}

/**
 * 检查点正文构造器。
 *
 * 返回值会作为一条 `user/message` 的 content 写进表层，替换被遮蔽区间。
 * 实现必须保证产物明显小于被遮蔽内容，否则压缩后端会拒绝提交。
 */
export type CheckpointBuilder = (input: CheckpointInput) => readonly ContentBlock[]

/**
 * 构造检查点正文：说明发生了什么，再给出取回方式。
 * @param input - 会话与被遮蔽区间。
 * @param options - 检索能力开关。
 * @returns 模型可见的检查点正文。
 */
export function buildCheckpointNotice(
  input: CheckpointInput,
  options: CheckpointOptions = {},
): string {
  const lines = [
    '[context-trim] Earlier turns of this session were moved out of the context to save tokens. '
    + 'Their full text is still in the session event log.',
  ]
  if (options.retrieval === true) {
    lines.push(
      '',
      'To retrieve them, call session_event_search with:',
      '- session_id omitted (that means the current session);',
      '- surfaces: ["shadowed"] — required; without it, trimmed events are not searched;',
      '- query: an exact string, because search is literal full-text matching, not semantic.',
      '',
      'Example: session_event_search({"query": "compaction-transaction.ts", "surfaces": ["shadowed"]})',
      'Follow a hit with session_event_read(<seq>) for the full event. Start from terms in the current '
      + 'request; if nothing matches, try a shorter term, a known file path, a command name, or an error '
      + 'string. Prefer searching over asking the user to repeat earlier work.',
    )
  } else {
    lines.push(
      '',
      'No history-search tool is mounted in this deployment, so those turns cannot be read back by '
      + 'the model; rely on the retained recent turns.',
    )
  }
  lines.push(
    '',
    `This trim moved about ${input.shadowedTokens} tokens of history out of the context.`,
  )
  return lines.join('\n')
}
