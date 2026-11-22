/**
 * 看护账本：落点、JSONL 文件原语与仓储（基础设施层）。
 *
 * 看护记录落在插件自己的 JSONL 文件里，而不是会话日志：会话日志只接受 DSH 认识
 * 的事件类型，插件自定义事件写进去会被恢复读路径拒绝。账本格式：
 *
 * ```text
 * {"op":"put","record":{"sessionId":…,"state":…,"actionCount":…}}
 * {"op":"remove","sessionId":…}
 * ```
 *
 * `put` 与 `remove` 都是「最后一次生效」：读取时按 sessionId 折叠，后写的覆盖
 * 先写的。因此状态变化、动作计数都不需要额外的 op——每次变化写一条完整的
 * `put` 即可。
 *
 * 文件原语统一处理三件容易被单点实现忽略的事：
 * 1. append 前保证上一行以 `\n` 收尾——崩溃留下的半行若直接与下一条记录拼接，
 *    会得到一条非法 JSON，`forEach` 会同时丢掉两条记录；
 * 2. rewrite 用「临时文件 + fsync + rename」原子替换——直接 `'w'` 截断后重写，
 *    进程中途被杀就丢掉整本账，而这恰好只发生在崩溃恢复路径上；
 * 3. 按 (size, mtime) 缓存文件内容——心跳每轮都要读一次账本，全量
 *    `readFileSync` + 逐行 JSON.parse 会把事件循环卡在同步 I/O 上。
 *
 * 账本是文件边界，读回来的一律重新校验：文件可能被外部编辑过，也可能因为崩溃
 * 留下半行。校验不过的行直接丢弃，不让它污染内存里的看护表。
 *
 * @module session-guardian/infrastructure/watch-ledger
 */

import {
  chmodSync,
  closeSync,
  fsyncSync,
  fstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  renameSync,
  statSync,
  writeSync,
} from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { WatchRepository } from '../application/ports.ts'
import type { WatchRecord, WatchState } from '../domain/watch.ts'
import type { SessionId } from '../types.ts'

/** 账本文件名。 */
const LEDGER_NAME = 'watches.jsonl'

/** 合法的看护状态。 */
const WATCH_STATES: readonly WatchState[] = ['watching', 'paused', 'stopped']

/** 账本文件超过该体积时触发压缩，避免只增不减。 */
const COMPACT_THRESHOLD_BYTES = 64 * 1024

/**
 * 看护账本的默认目录。
 *
 * 默认在 `$DSH_HOME/session-guardian/` 下；`$DSH_HOME` 缺席时退回 `~/.dsh`。
 * @returns 绝对路径。
 */
export function defaultStateDir(): string {
  const configured = process.env['DSH_HOME']
  const home = configured !== undefined && configured !== '' ? configured : join(homedir(), '.dsh')
  return join(home, 'session-guardian')
}

/**
 * 递归创建目录并收紧为属主专用权限。
 *
 * `mkdirSync` 的 `mode` 只对「本次新建」生效：目录已存在时权限会原样保留，
 * 因此已存在的目录要显式 chmod 一次。失败只失去额外加固，不阻断插件——
 * 账本里没有凭据，只有会话 id 与策略。
 * @param dir - 目标目录。
 */
function ensurePrivateDir(dir: string): void {
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  if (process.platform === 'win32') return
  try {
    chmodSync(dir, 0o700)
  } catch {
    // 非属主或文件系统不支持权限位：保持现状，仅失去额外收紧。
  }
}

/**
 * 追加式 JSONL 账本文件（只提供文件原语，不解释账本语义）。
 */
class JsonlLedgerFile {
  /** 按 (size, mtime) 缓存的文件内容。 */
  private cache: { readonly signature: string; readonly raw: string } | undefined

  /**
   * @param path - 账本文件路径。
   * @param onSizePressure - 体积超阈值时的压缩回调（由仓储提供保留语义）。
   */
  constructor(
    private readonly path: string,
    private readonly onSizePressure?: () => void,
  ) {}

  /**
   * 追加一条记录并落盘。
   *
   * 用 `a+` 打开以便读最后一字节：崩溃留下的半行必须先补换行，否则下一条
   * 记录会与它拼成非法 JSON，两条一起丢。
   * @param record - 可 JSON 序列化的记录。
   */
  append(record: unknown): void {
    const fd = openSync(this.path, 'a+', 0o600)
    try {
      const size = fstatSync(fd).size
      if (size > 0) {
        const tail = Buffer.alloc(1)
        readSync(fd, tail, 0, 1, size - 1)
        if (tail[0] !== 0x0a) writeSync(fd, '\n')
      }
      writeSync(fd, `${JSON.stringify(record)}\n`)
      fsyncSync(fd)
    } finally {
      closeSync(fd)
    }
    this.cache = undefined
    this.compactIfLarge()
  }

  /**
   * 以原子替换的方式重写整本账本。
   *
   * 先写 `*.tmp` 再 rename：rename 在同一目录内是原子的，进程在写临时文件期间
   * 被杀也只会留下垃圾临时文件，原账本保持完整。
   * @param records - 需要保留的记录（已是完整记录对象）。
   */
  rewrite(records: readonly unknown[]): void {
    const temp = `${this.path}.tmp`
    const fd = openSync(temp, 'w', 0o600)
    try {
      for (const record of records) writeSync(fd, `${JSON.stringify(record)}\n`)
      fsyncSync(fd)
    } finally {
      closeSync(fd)
    }
    renameSync(temp, this.path)
    this.cache = undefined
  }

  /**
   * 读取全部原始文本；文件不存在时返回空串。
   *
   * 命中缓存时（size 与 mtime 都没变）不再读盘：账本几乎每次心跳都会被查询。
   * @returns 文件内容。
   */
  read(): string {
    let stats
    try {
      stats = statSync(this.path)
    } catch {
      return ''
    }
    const signature = `${stats.size}:${stats.mtimeMs}`
    if (this.cache !== undefined && this.cache.signature === signature) return this.cache.raw
    const raw = readFileSync(this.path, 'utf8')
    this.cache = { signature, raw }
    return raw
  }

  /**
   * 逐行解析 JSON 记录；非法 JSON（崩溃残行）直接跳过，不影响后续记录。
   * @param visit - 每条合法记录对象的回调。
   */
  forEach(visit: (record: Record<string, unknown>) => void): void {
    for (const line of this.read().split('\n')) {
      if (line.trim() === '') continue
      let parsed: unknown
      try {
        parsed = JSON.parse(line)
      } catch {
        continue
      }
      if (parsed === null || typeof parsed !== 'object') continue
      visit(parsed as Record<string, unknown>)
    }
  }

  /** 体积超过阈值时交给仓储压缩；读取失败忽略。 */
  private compactIfLarge(): void {
    if (this.onSizePressure === undefined) return
    try {
      if (statSync(this.path).size <= COMPACT_THRESHOLD_BYTES) return
    } catch {
      return
    }
    this.onSizePressure()
  }
}

/**
 * 看护账本仓储。
 */
export class JsonlWatchRepository implements WatchRepository {
  /** 账本文件。 */
  private readonly ledger: JsonlLedgerFile

  /**
   * @param dir - 账本目录。
   */
  constructor(dir: string) {
    ensurePrivateDir(dir)
    this.ledger = new JsonlLedgerFile(join(dir, LEDGER_NAME), () => this.compact())
  }

  /**
   * 读取全部看护记录。
   *
   * @returns 折叠后的记录；账本不存在时返回空数组。
   */
  async readAll(): Promise<readonly WatchRecord[]> {
    return this.fold()
  }

  /**
   * 写入或覆盖一条记录。
   * @param record - 看护记录。
   */
  async write(record: WatchRecord): Promise<void> {
    this.ledger.append({ op: 'put', record })
  }

  /**
   * 删除一条记录。
   * @param sessionId - 会话 id。
   */
  async remove(sessionId: SessionId): Promise<void> {
    this.ledger.append({ op: 'remove', sessionId })
  }

  /**
   * 把账本压缩成「每个会话一条最新记录」。
   *
   * 压缩是同步的：`append` 之后立刻调用它，异步会让压缩与随后的写入交错。
   */
  compact(): void {
    const survivors: unknown[] = this.fold().map(record => ({ op: 'put', record }))
    this.ledger.rewrite(survivors)
  }

  /**
   * 折叠账本，得到每个会话最新的一条记录。
   * @returns 折叠后的记录。
   */
  private fold(): WatchRecord[] {
    const folded = new Map<SessionId, WatchRecord>()
    this.ledger.forEach((entry) => {
      const op = entry['op']
      if (op === 'remove') {
        const sessionId = entry['sessionId']
        if (typeof sessionId === 'string') folded.delete(sessionId)
        return
      }
      if (op !== 'put') return
      const record = recordOf(entry['record'])
      if (record !== undefined) folded.set(record.sessionId, record)
    })
    return [...folded.values()]
  }
}

/**
 * 校验账本里的一条记录并还原成领域对象。
 * @param value - 账本里的原始值。
 * @returns 合法的看护记录；不合法时 undefined。
 */
function recordOf(value: unknown): WatchRecord | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const raw = value as Record<string, unknown>
  const sessionId = raw['sessionId']
  if (typeof sessionId !== 'string' || sessionId === '') return undefined
  const state = raw['state']
  if (typeof state !== 'string' || !WATCH_STATES.includes(state as WatchState)) return undefined
  const createdAt = raw['createdAt']
  const updatedAt = raw['updatedAt']
  if (typeof createdAt !== 'number' || !Number.isFinite(createdAt)) return undefined
  if (typeof updatedAt !== 'number' || !Number.isFinite(updatedAt)) return undefined
  return {
    sessionId,
    createdAt,
    updatedAt,
    state: state as WatchState,
    note: typeof raw['note'] === 'string' ? raw['note'] : undefined,
    heartbeatCount: countOf(raw['heartbeatCount']),
    actionCount: countOf(raw['actionCount']),
    lastHeartbeatAt: optionalTimestamp(raw['lastHeartbeatAt']),
    lastActionAt: optionalTimestamp(raw['lastActionAt']),
  }
}

/**
 * 读取一个可选的时间戳字段。
 * @param value - 原始值。
 * @returns 合法的时间戳；缺省或非法时 undefined。
 */
function optionalTimestamp(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

/**
 * 读取一个计数字段。
 * @param value - 原始值。
 * @returns 合法的计数；缺省或非法时 0。
 */
function countOf(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : 0
}
