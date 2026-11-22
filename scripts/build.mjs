#!/usr/bin/env node
/**
 * 构建脚本：用 tsc 产出 Host 端 ESM 与类型声明。
 *
 * 先清空 `lib/`：删掉的源文件不能以旧产物的形式继续被加载。
 * `lib/` 是构建产物，不入库。
 */

import { execFileSync } from 'node:child_process'
import { rmSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

/** 仓库根目录。 */
const root = join(dirname(fileURLToPath(import.meta.url)), '..')

// 先清空：删掉的源文件不能以旧产物的形式继续被加载。
rmSync(join(root, 'lib'), { recursive: true, force: true })

// Host 产物：tsc 按 tsconfig 输出 ESM + 类型声明。
execFileSync(
  process.execPath,
  [join(root, 'node_modules', 'typescript', 'bin', 'tsc'), '-p', join(root, 'tsconfig.json')],
  { cwd: root, stdio: 'inherit' },
)

// 纯类型模块会产出一个只剩文件注释的空壳 JS；没有任何运行时 import 指向它，
// 删掉以免被误当成可加载的入口。
rmSync(join(root, 'lib', 'types.js'), { force: true })
