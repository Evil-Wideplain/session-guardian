import { describe, expect, it } from 'vitest'
import { readConfig, resolveTrimConfig } from '../src/config.ts'
import { Config as CompactionConfig } from '../src/application/compaction-engine.ts'
import { TrimConfig } from '../src/config.ts'

describe('volatile 配置', () => {
  it('readConfig 取引用当前快照，普通值原样返回', () => {
    let current = 1
    expect(readConfig({ get: () => current }, 0)).toBe(1)
    current = 2
    expect(readConfig({ get: () => current }, 0)).toBe(2)
    expect(readConfig(3, 0)).toBe(3)
    expect(readConfig(undefined, 4)).toBe(4)
  })

  it('裁剪策略每次读取热更新值', () => {
    let idleMs = 1_000
    const resolved = resolveTrimConfig({ idleMs: { get: () => idleMs }, retainRounds: 2 })
    expect(resolved.idleMs()).toBe(1_000)
    idleMs = 2_000
    expect(resolved.idleMs()).toBe(2_000)
    expect(resolved.retainRounds()).toBe(2)
  })

  it('两个 schema 的界面字段都是 volatile', () => {
    const trim = TrimConfig({})
    expect(trim.idleMs.get()).toBe(1_800_000)
    expect(trim.retainRounds.get()).toBe(3)
    expect(trim.minShadowTokens.get()).toBe(2_000)
    expect(trim.requireRetrieval.get()).toBe(true)

    const compaction = CompactionConfig({})
    expect(compaction.retainRounds.get()).toBe(3)
    expect(compaction.minShadowTokens.get()).toBe(2_000)
    expect(compaction.pressureTokens.get()).toBe(0)
    expect(compaction.keepToolRecords.get()).toBe(true)
    expect(compaction.checkpointTemplate.get()).toBeUndefined()
  })
})
