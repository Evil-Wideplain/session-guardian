/**
 * 看护授权规则（领域层，纯函数）。
 *
 * 看护比「看一眼」重：它让插件在调用方不在场时对这个会话动手。因此授权比
 * 「看得见」更严：
 * - 同一个会话永远可以看护自己——长任务在自己的会话里跑是主用例；
 * - 同一个工作目录（cwd 规范化后相同）可以看护；
 * - 跨目录需要显式放行：`allowCrossWorkspace`，或把目录放进 `allowlist`。
 *
 * 不做「团队成员自动可见」的放宽：看护权与跨会话投递是两件事，后者由
 * session-messaging 插件负责管，这里保持窄。
 *
 * @module session-guardian/domain/authorization
 */

import type { ResolvedConfig } from '../config.ts'
import type { SessionId } from '../types.ts'
import { resolve } from 'node:path'

/** 一个待授权的看护请求。 */
export interface WatchAuthorizationInput {
  /** 调用方所在的会话。 */
  readonly callerId: SessionId
  /** 调用方会话的工作目录；没有记录时为空串。 */
  readonly callerCwd: string
  /** 目标会话。 */
  readonly targetId: SessionId
  /** 目标会话的工作目录；没有记录时为空串。 */
  readonly targetCwd: string
}

/** 授权结果。 */
export type WatchAuthorization =
  /** 允许看护。 */
  | { readonly allowed: true }
  /** 拒绝看护，并说明原因。 */
  | { readonly allowed: false; readonly reason: string }

/**
 * 规范化路径用于比较。
 *
 * Windows 文件系统大小写不敏感，`C:\A` 与 `c:\a` 指的是同一个目录，必须先
 * 归一化再比较，否则同目录的会话会被误判成跨目录。
 * @param path - 原始路径。
 * @param caseInsensitive - 平台是否大小写不敏感。
 * @returns 归一化后的路径；空串原样返回。
 */
function normalizePath(path: string, caseInsensitive: boolean): string {
  const trimmed = path.trim()
  if (trimmed === '') return ''
  const absolute = resolve(trimmed)
  return caseInsensitive ? absolute.toLowerCase() : absolute
}

/**
 * 判断目录是否命中例外清单。
 *
 * 清单项可以是精确目录，也可以是目录前缀（`/repo` 命中 `/repo/app`）。
 * @param cwd - 已归一化的目录。
 * @param allowlist - 例外清单原始项。
 * @param caseInsensitive - 平台是否大小写不敏感。
 * @returns 命中时为 true。
 */
function matchesAllowlist(
  cwd: string,
  allowlist: readonly string[],
  caseInsensitive: boolean,
): boolean {
  if (cwd === '') return false
  for (const raw of allowlist) {
    const entry = raw.trim()
    if (entry === '') continue
    const normalized = caseInsensitive ? entry.toLowerCase() : entry
    if (normalized === cwd) return true
    // 前缀匹配：清单项是目标目录的祖先目录。
    if (cwd.startsWith(`${normalized}/`) || cwd.startsWith(`${normalized}\\`)) return true
  }
  return false
}

/**
 * 判定一次看护请求是否被允许。
 * @param input - 看护请求。
 * @param config - 生效配置。
 * @returns 授权结果。
 */
export function authorizeWatch(
  input: WatchAuthorizationInput,
  config: ResolvedConfig,
): WatchAuthorization {
  if (input.callerId === input.targetId) return { allowed: true }

  const caseInsensitive = config.pathCaseInsensitive
  const callerCwd = normalizePath(input.callerCwd, caseInsensitive)
  const targetCwd = normalizePath(input.targetCwd, caseInsensitive)

  if (callerCwd !== '' && callerCwd === targetCwd) return { allowed: true }
  if (matchesAllowlist(targetCwd, config.allowlist, caseInsensitive)) return { allowed: true }
  if (config.allowCrossWorkspace) return { allowed: true }

  return {
    allowed: false,
    reason: '目标会话不在你的工作目录里：跨工作区看护需要 allowCrossWorkspace 或目录白名单',
  }
}
