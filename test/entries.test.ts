/**
 * 装载行入口契约：Cordis Loader 按包名 / 子路径解析这些模块，形状不能变。
 *
 * 用例只断言导出形状，不启动插件：`apply` 需要真实的 `ctx.tools` 等服务，
 * 那属于端到端验证，不是单元测试的范围。
 */

import { describe, expect, it } from 'vitest'
import * as autoContinue from '../src/auto-continue.ts'
import * as compaction from '../src/compaction.ts'
import * as main from '../src/index.ts'
import * as trim from '../src/trim.ts'

describe('装载行入口', () => {
  it('主行导出 Config / name / inject / apply', () => {
    expect(main.name).toBe('session-guardian')
    expect(main.Config).toBeDefined()
    expect(main.inject).toEqual(['tools', 'agents', 'sessions'])
    expect(typeof main.apply).toBe('function')
  })

  it('续跑行与裁剪行导出各自的 name / inject / apply', () => {
    expect(autoContinue.name).toBe('session-guardian-auto-continue')
    expect(typeof autoContinue.apply).toBe('function')

    expect(trim.name).toBe('session-guardian-trim')
    expect(trim.Config).toBeDefined()
    // 系统提示词与工具表是常驻检索指引的前提；计量与压缩后端按需取。
    expect(trim.inject).toEqual(['systemPrompt', 'tools'])
    expect(typeof trim.apply).toBe('function')
  })

  it('压缩后端行是普通插件：apply 登记服务，并暴露配置 schema', () => {
    expect(compaction.name).toBe('session-guardian-compaction')
    expect(typeof compaction.apply).toBe('function')
    expect(compaction.inject).toEqual(['tokenMeter'])
    expect(compaction.Config).toBeDefined()
  })
})
