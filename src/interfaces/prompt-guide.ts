/**
 * 模型可见的检索指引（常驻系统提示词段落）。
 *
 * 检查点正文里已经有一段固定提示；这一段是**兜底**：裁剪行可以与任意压缩后端
 * 搭配，而随附的 `dsh-compaction-basic` 写的是模型摘要，不会带上我们的提示。
 * 没有这一段，用默认后端的部署就只在检查点里看到一句摘要，模型不知道还能检索。
 *
 * 文本是动态的：每次组装时检查 `session_event_search` 是否真的挂载。只检查
 * `ctx.sessionQuery` 服务不够——服务在场不代表工具已注册，也不代表搜索没被
 * 配置成关闭；提示词里提到一个不存在的工具比不提更糟。
 *
 * @module session-guardian/interfaces/prompt-guide
 */

import type { Context } from '@deepseek-ai/cordis'

/** 段落在提示词里的唯一名字。 */
const RETRIEVAL_GUIDE_NAME = 'session-guardian:retrieval-guide'

/** 缺省段位：紧跟在会话检索工具自带指引之后。 */
const FALLBACK_ORDER = 2301

/** 模型看到的那段指引。 */
const RETRIEVAL_GUIDE_TEXT = [
  'Earlier turns of this session may have been moved out of the context to save tokens; their full text',
  'is still in the session event log. To read them, call session_event_search with session_id omitted',
  '(the current session) and surfaces: ["shadowed"] — for example',
  '{"query": "src/application/trim-service.ts", "surfaces": ["shadowed"]}. Search is literal full-text:',
  'use exact file paths, command names, identifiers, or error strings, then session_event_read(seq) for',
  'the full event. Prefer searching over asking the user to repeat earlier work.',
].join(' ')

/**
 * 在系统提示词里登记检索指引。
 * @param ctx - 插件上下文。
 * @returns 释放函数。
 */
export function registerRetrievalGuide(ctx: Context): () => void {
  return ctx.systemPrompt.section({
    name: RETRIEVAL_GUIDE_NAME,
    order: resolveGuideOrder(ctx),
    text: () => retrievalAvailable(ctx) ? RETRIEVAL_GUIDE_TEXT : '',
  })
}

/**
 * 面向模型的会话事件检索工具是否在场。
 * @param ctx - 插件上下文。
 * @returns 是否可用。
 */
function retrievalAvailable(ctx: Context): boolean {
  try {
    return ctx.tools.get?.('session_event_search') !== undefined
  } catch {
    return false
  }
}

/**
 * 取检索指引的段位；取不到命名段位时退回固定值。
 * @param ctx - 插件上下文。
 * @returns 升序拼接用的序数。
 */
function resolveGuideOrder(ctx: Context): number {
  try {
    const base = ctx.systemPrompt.getSectionOrder('TOOL_SESSION_QUERY')
    if (Number.isFinite(base)) return base + 1
  } catch {
    // 段位表不认识这个名字时用固定值：提示词顺序是装饰，不是正确性。
  }
  return FALLBACK_ORDER
}
