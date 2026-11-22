import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    // 这些用例会起真实定时器并断言「心跳间隔」「空闲超时」等与进程级资源
    // 相关的语义；并行跑不同文件会互相干扰时序，保持串行。
    fileParallelism: false,
  },
})
