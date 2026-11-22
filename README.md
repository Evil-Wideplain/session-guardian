# session-guardian

[![License: MIT](https://img.shields.io/badge/license-MIT-green.svg)](./LICENSE)
[![Node](https://img.shields.io/badge/node-%E2%89%A522-brightgreen.svg)](https://nodejs.org)
[![DSH plugin](https://img.shields.io/badge/DSH-plugin-4B6BFB.svg)](https://github.com/Evil-Wideplain/session-messaging)

**DSH（DeepSeek Harness）插件：长会话看护。**
让一个会话在被看护期间保持推进——回合收口后由看护插件决定要不要接着跑、
写不写检查点、要不要告警；隔了一段时间回来时，把已经冷掉的上下文裁小，
让会话不用换一个重开。

> 状态：**v0.1.0 骨架 + 上下文裁剪**。看护登记、心跳调度、账本与工具面已经
> 落地并可编译；上下文裁剪（`session-guardian/trim`）与检索式压缩后端
> （`session-guardian/compaction`）已经实现并有单测。**自动续跑的核心机制
> 尚未定稿**，实现留在一个明确的接缝里。运行时基线为 DSH 0.2.x、Node.js ≥ 22。

## 目录

- [这个插件解决什么](#这个插件解决什么)
- [当前状态：已落地什么、还差什么](#当前状态已落地什么还差什么)
- [插件结构：四个装载行](#插件结构四个装载行)
- [上下文裁剪：回到旧会话](#上下文裁剪回到旧会话)
- [代码分层](#代码分层)
- [已核实的 DSH API 契约](#已核实的-dsh-api-契约)
- [工具面](#工具面)
- [看护登记与授权](#看护登记与授权)
- [心跳与机制接缝](#心跳与机制接缝)
- [账本与崩溃恢复](#账本与崩溃恢复)
- [待定决策](#待定决策)
- [开发与验证](#开发与验证)
- [许可证](#许可证)

## 这个插件解决什么

DSH 里一个会话跑长任务时，模型常常在某个回合结束后就停住了——它在等一句
「继续」，而这句「继续」没人来说。常见的三种处理都不理想：

- **人盯着**：用户每隔几分钟回来敲一句「继续」，长任务被切成很多碎回合；
- **模型自己说**：让模型在每次回复末尾追加「如果还有事请继续」，等于把续跑
  决策交给一个已经被上下文淹没的判断；
- **换一个更强的循环器**：重跑整个任务，浪费已经完成的进度。

看护插件把「要不要接着跑」从会话里拿出来，交给一个**在会话之外、看得见全局**
的调度器：它知道这个会话被看护着、上一次动作是什么时候、已经花了多少次预算、
还有没有别的会话在排队。决策因此可以有限额、有记录、可暂停。

DSH 里已经有相邻但不同的机制，可以对照着看：

| 机制 | 作用域 | 与本插件的区别 |
|---|---|---|
| `dsh-goal-round-driver` | 一个 goal 的回合续跑 | 绑定 goal 服务；本插件是通用看护表 |
| `dsh-schedule` | 持久化定时提醒 | 到点提醒一次；本插件是「回合结束后要不要接着跑」 |
| `dsh-tool-ralph` | 迭代循环 | 每轮起一个**新子会话**；本插件在**同一个会话**里接着跑 |

DSH 本身**没有** keep-alive / 自动续跑服务——`packages/` 里 grep 不到任何
`heartbeat` / `keep-alive` / `auto-continue` 的同会话续跑实现。所以这个插件没有
现成对手，机制怎么设计是开放问题。

## 当前状态：已落地什么、还差什么

**已落地**（`npm run typecheck` 通过，`npm run build` 通过，35 个单测通过）：

- 包骨架与构建链：`package.json`、`tsconfig.json`、vitest 配置、
  `scripts/build.mjs`（Host 产物用 tsc）；
- 四个装载行与它们的装配（组合根 → 应用服务 → 基础设施适配器）；
- 看护注册表：登记 / 更新 / 停看 / 列举，账本落盘，启动时恢复；
- 心跳调度器：按配置节奏驱动，不重叠、可回收；
- 三个模型工具：`watch_session` / `unwatch_session` / `list_watched_sessions`；
- **上下文裁剪行**：`agent/pre-step` 空闲判定 +「保留最近 N 轮」+
  `ctx.compaction.compactRegion()` 调用；
- **检索式压缩后端**：实现 `ctx.compaction` 的三个操作，用「固定说明 + 检索
  指针」代替模型摘要，写标准的 `compaction/*` 事件；
- 单元测试：轮次选择与空闲判定、检查点正文、工具交换移出、压缩事务（假会话上的四个事件与替换）、四个装载行的导出形状。

**还差**：

- 自动续跑核心机制的实现（取决于[待定决策](#待定决策)）；
- README 之外的用户文档。

## 插件结构：四个装载行

`cordis.patch.yml` 把一个包拆成四个 Loader 行，在插件页上是四个可独立启停的
组件：

```yaml
- insert:
    - id: session-guardian
      name: session-guardian

    - id: session-guardian-auto-continue
      name: session-guardian/auto-continue

    - id: session-guardian-trim
      name: session-guardian/trim

    - id: session-guardian-compaction
      name: session-guardian/compaction
      disabled: true
```

| 行 | 入口 | 职责 | 关掉它会怎样 |
|---|---|---|---|
| `session-guardian`（主行） | `src/index.ts` | 看护注册表、账本、三个工具、启动恢复 | 续跑行等依赖，能力一并消失 |
| `session-guardian-auto-continue`（续跑行） | `src/auto-continue.ts` | 心跳调度器 + 核心机制 | 只少机制本身，登记与账本照常 |
| `session-guardian-trim`（裁剪行） | `src/trim.ts` | 空闲判定、保留最近 N 轮、调用压缩后端、常驻检索指引 | 不再自动裁剪，会话照常可聊 |
| `session-guardian-session-query`（检索组） | bundle patch | 装载会话检索服务与工具，裁剪的前置能力 | 裁剪行会因 `requireRetrieval` 跳过 |
| `session-guardian-compaction`（压缩后端行） | `src/compaction.ts` | 提供 `ctx.compaction`，写检索检查点 | 退回随附后端的模型摘要 |

带 `disabled: true` 的那一行默认停用：一个上下文只能有一个压缩后端，而基础
bundle 已经挂载了 `@deepseek-ai/dsh-compaction-basic`。要用本包的后端，先停用
随附后端那一行，再启用本行（见[上下文裁剪](#上下文裁剪回到旧会话)）。

包的 `cordis.patch.yml` 还会插入一个 `session-guardian-session-query` 组，随插件
一起装载 `session-query-sqlite`（`openAt: first-search`）与
`tool-session-query`，让会话检索工具成为**裁剪的前置能力**，而不是让用户另外
启用实验性 bundle。因此不要再同时启用
`@deepseek-ai/dsh-experimental-session-search`——同名工具会被注册两次。

**为什么拆行**：四件事的变化频率和代价完全不同。看护登记与账本是纯本地状态；
续跑机制会产生模型调用；裁剪是每步之前的一次判定；压缩后端只在「决定换一种
检查点」时才动。拆开之后，用户可以只关掉花钱或想换掉的那部分。

## 上下文裁剪：回到旧会话

**问题**：离开一个会话一段时间再回来，提供方的前缀缓存已经冷了，继续对话要按
全价重放整段历史。常见的绕法是新建一个会话（上下文短、便宜），让模型用会话
检索去翻旧会话——但那样就换了会话，历史、目标、进行中的工作都不在同一个壳里。

**做法**：在**同一个会话**里，把最旧的一段历史替换成一条检查点消息。原始事件
不删除，只是被 `surfaceOp: replace` 遮出模型可见范围，仍然留在日志里。

- 触发：`agent/pre-step`（请求组装之前）。会话最后一个表层事件距今超过
  `idleMs` 才动作，所以正常的多步工具调用不会被误裁；压缩写进表层后，
  紧接着的这次请求就能看到检查点，不必等下一轮。
- 区间：跳过系统提示词，**保留最近 N 轮**（一轮 = 一条真实用户消息及其后续的
  工具调用与结果），更早的整段遮蔽。`N = 0` 表示一轮都不保留：只留系统提示词、
  检查点与本次输入。按轮次而不是按 token 选，边界可解释，也天然是工具调用配对
  的完整边界；`steer` 插进来的用户消息可能落在配对中间，所以仍保留余额校验
  作为兜底。零保留时还要求整层工具调用余额为 0，否则这次不裁。
- 工具记录：由**压缩后端**的 `keepToolRecords` 统一控制（默认保留）。设为
  `false` 时，保留窗口里的每段「带 `tool-call` 的 assistant 消息 + 其后的
  `tool/result`」会被整段替换成一条**空 content 的 `system/message`**：空 system
  节点留在表层占位，但派生历史时返回 `null`，因此调用与结果都不会进入 provider
  请求，也没有任何占位文本。
- 这个开关的代价要写清楚：一条 assistant 消息里如果同时有正文和工具调用，整段
  移除会连正文一起消失（表层没有「只删块」的操作，assistant 消息也不能作为
  替换目标）。相邻两条用户消息可能因此连续出现，适配器通常接受，但需实测。
- 下限：被遮掉的量小于 `minShadowTokens` 就不裁——检查点和固定提示本身也有成本。
- 检索：检查点正文自带一段固定提示，给出**可照抄的调用示例**
  （`session_event_search({"query": "...", "surfaces": ["shadowed"]})`），并强调
  `surfaces` 必须包含 `shadowed`、检索是字面匹配；命中后用
  `session_event_read(<seq>)` 读原文。
  这段提示有两个载体：**检查点正文**（本包后端）与**一段常驻系统提示词**
  （覆盖随附的摘要后端）。两处的文本都按「`session_event_search` 是否真的挂载」
  决定是否出现——不在场时整段消失，而不是让模型去调一个不存在的工具。
  注意 `session_search` 不能用：它只搜别的会话。

配置（plugin 页的 `session-guardian-trim` 行，或 profile 的 patch 层）：

```yaml
- id: session-guardian-trim
  name: session-guardian/trim
  config:
    idleMs: 1800000       # 默认 30 分钟
    retainRounds: 3       # 保留最近 3 轮；0 = 一轮都不保留
    minShadowTokens: 2000 # 太小不值得裁
    requireRetrieval: true # 检索工具不在场时跳过裁剪（默认开）
```

检查点正文是一段固定说明（不含历史目录）。压缩后端还能决定保留窗口里的工具
记录怎么处理：

```yaml
- id: session-guardian-compaction
  name: session-guardian/compaction
  config:
    retainRounds: 3
    keepToolRecords: true # false = 保留窗口里的工具交换整段移出
```

**缓存已经冷的时候压缩，恰好免费。** 压缩会让「从第一条被遮蔽 token 起」的
前缀缓存失效；而这时前缀本来就要 miss，重写不额外损失。反过来，缓存热的时候
压缩是主动击穿——所以按空闲时间触发，比按 token 压力触发更适合这个场景。

### 两种检查点

| | 随附后端（默认） | 本包的 `session-guardian/compaction` |
|---|---|---|
| 正文 | 模型写结构化摘要 | 固定说明 + 检索指针（约 560 字符） |
| 额外模型调用 | 一次（回放被裁前缀） | 0 |
| 语义信息 | 强 | 弱（只有区间与检索指引，没有目录） |
| `/compact` 与溢出恢复 | 完整 | 可用；预期错误不见得被命令本地化 |

裁剪行与后端正交：只启用裁剪行时，检查点仍是随附后端的摘要；启用本包后端后，
检查点变成一段固定说明，裁剪的成本几乎只剩一次本地估算。

### 扩展接口

后端把「事务」与「写什么」分开，两处都可以替换：

- `CheckpointBuilder` / `buildCheckpointNotice()`（`src/domain/checkpoint.ts`）：
  前者是契约，输入被遮蔽区间、返回检查点内容块；后者是默认实现（固定说明，
  按「检索工具是否在场」切换措辞）。
- `RetrievalCompactionEngine.buildCheckpoint()` / `selectRange()`：子类覆盖点，
  分别对应「正文怎么写」与「裁到哪里」。
- 事务本身（`src/application/compaction-transaction.ts`）不依赖 Cordis，可以用
  假会话直接测试——它保持与 `dsh-compaction` 相同的四个事件与替换语义，并且
  复用引擎测好的压力快照，不再重复回放日志。

## 代码分层

按 DDD 分层，依赖方向单向向内（`interfaces` → `application` → `domain`）；
`infrastructure` 只实现 `application/ports.ts` 里的端口，由组合根注进应用服务，
应用层不 import 具体实现。

```
src/
  index.ts                     主行入口：看护表、账本、三个工具、启动恢复
  auto-continue.ts             续跑行入口：心跳调度器 + 机制接缝
  trim.ts                      裁剪行入口：空闲判定、保留最近 N 轮（可为 0）、调用压缩后端
  compaction.ts                压缩后端行入口：转出 RetrievalCompactionEngine
  config.ts                    主行 + 裁剪行的配置 schema 与 resolve
  composition.ts               组合根：唯一的「接口 → 实现」映射处
  types.ts                     DSH 服务与数据结构契约（只声明，不运行）
  domain/
    watch.ts                   看护记录与短会话 id（纯数据 + 纯函数）
    authorization.ts           看护授权规则（纯函数）
    trim.ts                    空闲判定与「保留最近 N 轮」的区间选择（可为 0）
    checkpoint.ts              检查点正文：固定说明 + 构造器契约
  application/
    guardian-service.ts        用例编排：watch / unwatch / list / heartbeat；
                               跨装载行的服务契约也在这里
    heartbeat.ts               心跳调度器
    ports.ts                   端口接口
    dto.ts                     应用层出参投影
    trim-service.ts            裁剪用例：判定 → 选区间 → 交给压缩后端
    surface-view.ts            会话日志 → 表层视图（读模型）
    tool-exchange-strip.ts     把保留窗口里的工具交换整段替换成空 system 节点
    compaction-engine.ts       检索式压缩后端（ctx.compaction）
    compaction-transaction.ts  同步压缩事务：四个事件与表层替换
  infrastructure/
    watch-ledger.ts            账本落点、JSONL 文件原语与看护仓储
  interfaces/
    tools/                     watch / unwatch / list 的实现与参数校验
    prompt-guide.ts            常驻检索指引（按工具是否在场动态出现）
```

一个装载行一个入口文件，入口直接承载实现（不再有 `entries/` 中转和纯转出
barrel）；同一主题的小模块合并到同一个文件，文件数从 43 降到 26。

**插件刻意不 import 任何 `@deepseek-ai/dsh-*` 包**：它是 bundle 插件，必须在
不同 alpha 版本之间继续可用，因此只在自己 `src/types.ts` 里声明用到的服务切片，
真实对象由 Cordis 传入。构建产物里不会留下对 `@deepseek-ai/dsh-*` 的 import。

## 已核实的 DSH API 契约

下面每一条都对着 `C:\Code\deepseek-harness` 的源码核对过，行号是核对时的位置。
插件的 `src/types.ts` 就是照着这些抄的。

### Agent 与生命周期

| 事实 | 出处 |
|---|---|
| `Agent.status: 'idle' \| 'running'`；`idle` 的含义是「没有驱动被调度或处于活动状态」 | `packages/core/agent/src/runtime-types.ts:55,118` |
| `agent.followup(message)` 排一个后续回合并唤醒驱动，该消息成为该回合唯一的普通消息 | `packages/core/agent/src/runtime-types.ts:168` |
| `agent.steer(message)` 提交给最近的 step 边界；空闲的驱动会开一个回合 | `packages/core/agent/src/runtime-types.ts:177` |
| `agent.inject(message)` 排模型可见上下文但**不唤醒**驱动 | `packages/core/agent/src/runtime-types.ts:188` |
| `agent.runMaintenance(task)` 在 Agent 真正空闲的阶段占住它；已经被占用时**同步抛错** | `packages/core/agent/src/runtime-types.ts:139-148` |
| `ctx.agents.get(id)` / `ctx.agents.list()` / `ctx.agents.resume(options)` | `packages/core/agent/src/index.ts:578,598,419` |
| `AgentHandle.dispose()` 是**能力**：只有持有者能拆掉这个 Agent | `packages/core/agent/src/index.ts:151-168` |

### 回合生命周期

| 事实 | 出处 |
|---|---|
| `turn/end` 载荷是 `{ turn: number; reason: TurnEndReason }` | `packages/core/session/src/types.ts:276` |
| `TurnEndReason` = `completed \| max-tokens \| blocked \| aborted \| error \| interrupted` | `packages/core/session/src/types.ts:192-213` |
| `blocked` 只有一种来源：`agent/pre-step` 的监听方返回 `{ kind: 'reject' }`，模型根本没被调用 | `packages/core/agent-loop/src/agent.ts:279-282` |
| `max-tokens` 在一个回合内是**粘性**的（后续 step 撞上限不会覆盖它） | `packages/core/agent-loop/src/agent.ts:302` |
| `interrupted` 只由崩溃修复 / 冷读补写，运行时从不主动写 | `packages/core/session/src/types.ts:204-212` |
| `session/event` 是提交后触发、fire-and-forget；监听方抛错会被记录并吞掉 | `packages/core/session/src/index.ts:39-83` |
| `agent/status` 事件载荷 `{ agent, status }`；`agent/turn-stopping` 在回合边界提交**之前**触发 | `packages/core/agent/src/runtime-types.ts:192-262` |
| `agent/error` 载荷是 `{ agent, turn, step, error }` | `packages/core/agent/src/runtime-types.ts:192-262` |

### 持久化与挂载点

| 事实 | 出处 |
|---|---|
| `ctx.sessions.flush(session)` 是**唯一**的落盘入口；`goal-round-driver` 在排下一个回合前先 flush | `packages/core/session/src/index.ts:1117`、`packages/goal/goal-round-driver/src/index.ts:142-154` |
| 会话日志的消息来源校验对**未知 `kind`** 只要求它是非空字符串，因此插件可以加自己的 kind | `packages/session/session-format-v0-to-v1/src/payload-validation.ts:592-594` |
| 反过来，`kind: 'plugin'` 的来源**只能**带 `kind / plugin / form / sections / summary` 这几个键 | `packages/session/session-format-v0-to-v1/src/payload-validation.ts:598-620` |
| `ctx.tools.register` 要求 `output: { schema, render }`；`render` 必须是纯投影 | `packages/core/tools/src/index.ts:1022-1053` |
| `ctx.provide(name, value)` 注册服务并返回注销函数 | `vendor/cordis/src/reflect.ts:277-305` |
| `ctx.get(name)` 读全局服务存储（可选服务用它）；`ctx.<name>` 只对声明过的注入有效 | `vendor/cordis/src/reflect.ts:233-243` |
| `ctx.effect(execute, label)` 收集清理函数，插件卸载时逆序执行 | `vendor/cordis/src/fiber.ts:402-418` |
| 基础 bundle 有 `timer` 行（`@deepseek-ai/cordis-plugin-timer`），提供 `ctx.timer.interval` | `packages/bundle/base/cordis.patch.yml` |

### 上下文裁剪（对照已安装的 0.2.2-rc.3）

| 事实 | 出处（安装目录内的包源码） |
|---|---|
| `agent/pre-step` 在请求组装前串行执行；随附压缩后端就挂在这个 waterfall 上 | `@deepseek-ai/dsh-compaction-basic/src/index.ts` |
| `ctx.compaction` 是三个操作：`compactIfNeeded` / `compactNow` / `compactRegion` | `@deepseek-ai/dsh-compaction/src/index.ts` |
| 成功压缩写四个事件：`compaction/start` → `compaction/summary` → 带 `surfaceOp: replace` 的 `user/message` → `compaction/end` | `@deepseek-ai/dsh-compaction-basic/src/region.ts` |
| 检查点消息的 source 是 `{ kind: 'compact-checkpoint', compactionId }` | `@deepseek-ai/dsh-compaction/src/checkpoint.ts` |
| `deriveMessages()` 把摘要渲染成 **user 角色**消息；被遮蔽事件仍留在日志里 | `@deepseek-ai/dsh-session/src/index.ts` |
| 表层第 0 号系统提示词节点不能被普通替换覆盖，因此裁剪区间必须从它之后开始 | `@deepseek-ai/dsh-session/README.zh.md` |
| 会话检索可以查当前会话，且 `surfaces` 支持 `shadowed` / `log-only` | `@deepseek-ai/dsh-tool-session-query/src/input.ts` |
| `session_event_search` 省略 `session_id` 就是当前会话；`session_search` 则**排除**调用方会话 | 同上 |
| 实时会话也会被索引（连接内 TEMP 表），因此刚写下的历史立刻可检索 | `@deepseek-ai/dsh-session-query-sqlite/README.zh.md` |

## 工具面

三个工具，名字都带 `session_` 前缀，避免和 DSH 内置的 `list_agents` 混淆。

### `watch_session`

把一个会话登记进看护表。

| 参数 | 类型 | 说明 |
|---|---|---|
| `session_id` | string（必填） | 被看护的会话；传自己的 session id 就是看护当前会话 |
| `note` | string（选填） | 一行说明这次看护是为了什么 |

重复调用同一个 `session_id` 是**更新**既有看护，不会报错。

### `unwatch_session`

停止看护。不取消正在跑的回合，不删会话历史——只是插件不再检查它。

| 参数 | 类型 | 说明 |
|---|---|---|
| `session_id` | string（必填） | 要停看的会话 |

本来就没在看护时，返回「本来就没有在看护」而不是报错。

### `list_watched_sessions`

列出调用方可见的被看护会话，按登记时间从早到晚。每行给出：`session_id`、
`short_id`、`state`（`watching` / `paused` / `stopped`）、`online`、
`agent_status`（`idle` / `running` / `offline`）、`heartbeat_count`、
`action_count`、`last_heartbeat_at`、`last_action_at`、`note`。不可见的会话
只计数（`omitted`），不列出来。

> `action_count` 记的是**插件对这条看护做过的动作次数**，不是某一种动作的计数。
> 这样限流与配额可以按「动作」算，核心机制换了也不用改账本格式。

## 看护登记与授权

看护比「看一眼」重：它让插件在调用方不在场时对这个会话动手。因此授权比
「看得见」更严：

- **同一个会话永远可以看护自己**——长任务在自己的会话里跑是主用例；
- **同一个工作目录**可以看护（cwd 规范化后比较；Windows 下大小写不敏感）；
- **跨目录**需要显式放行：`allowCrossWorkspace: true`，或把目录放进 `allowlist`。

不放行「团队成员自动可见」：看护权与跨会话投递是两件事，后者由
`session-messaging` 插件负责管，这里保持窄。

> 这条矩阵是我方的设计选择，不是 DSH 的既有约定。列为[待定决策](#待定决策)
> 里的一项，确认后再固化。

## 心跳与机制接缝

心跳调度器按 `heartbeatIntervalMs` 的节奏触发一轮检查。三条约束：

- **不重叠**：上一轮没跑完就跳过这一轮。检查本身是同步的（读内存里的看护表），
  但机制可能触发模型请求，重叠会让节奏失控；
- **定时器可回收**：优先用宿主的 `ctx.timer`（基础 bundle 的 `timer` 行），
  拿不到才退回进程内 `setInterval` 并 `unref`，并打一条日志说明退回了；
- **不阻塞进程退出**。

一轮心跳的流程：遍历看护表里 `state === 'watching'` 的记录 → 更新心跳计数
（**不写账本**，心跳是观测值，写账本会把账本冲成噪声）→ 把每条记录交给机制。

机制就是**一个函数**：

```ts
// src/auto-continue.ts
async function onHeartbeat(
  record: WatchRecord,     // 被看护的会话记录
  agent: Agent | undefined, // 目标 Agent；会话不在线时是 undefined
  now: number,             // 本轮时刻（Unix 毫秒）
): Promise<HeartbeatOutcome>   // { acted: boolean }——这一轮是否动了手
```

返回 `acted: true` 时，看护服务会把 `actionCount` 加一并把这条记录写回账本。
接缝的形状已经定死了，机制换几种实现都不用改看护表、账本或工具面。

> **注意**：机制在 Agent 空闲时动手，应该用 `agent.runMaintenance(...)` 占住
> 空闲阶段，而不是直接 `agent.followup(...)`——后者会和一个正在跑的回合抢。
> `runMaintenance` 在 Agent 已被占用时**同步抛错**，必须 try/catch。

## 账本与崩溃恢复

看护记录落在插件自己的 JSONL 文件里（`$DSH_HOME/session-guardian/watches.jsonl`），
而不是会话日志：会话日志只接受 DSH 认识的事件类型，插件自定义事件写进去会被
恢复读路径拒绝。

```text
{"op":"put","record":{"sessionId":"…","state":"watching","actionCount":3}}
{"op":"remove","sessionId":"…"}
```

`put` / `remove` 都是「最后一次生效」：读取时按 `sessionId` 折叠，后写的覆盖
先写的。文件原语做了三件容易被单点实现忽略的事：

1. **append 前补换行**——崩溃留下的半行若直接与下一条拼接，会得到非法 JSON，
   折叠时两条一起丢；
2. **压缩用「临时文件 + fsync + rename」原子替换**——直接截断后重写，进程中途
   被杀就丢掉整本账，而这恰好只发生在崩溃恢复路径上；
3. **按 (size, mtime) 缓存文件内容**——心跳每轮都要读账本，全量
   `readFileSync` + 逐行 parse 会把事件循环卡在同步 I/O 上。

启动时按 `recoverOnStart` 从账本恢复看护记录。恢复出来的记录里「已动作次数」
也还在，因此重启不会让配额被绕过。账本损坏时只记一条日志并放弃恢复，不让
插件起不来。

读回来的一律重新校验（文件可能被外部编辑过，也可能因崩溃留下半行）：校验
不过的行直接丢弃，不让它污染内存里的看护表。

## 待定决策

核心机制还没定。三个候选方案与各自的代价：

| 方案 | 机制 | 代价 |
|---|---|---|
| A 自动续跑 | 回合正常收口后 `followup` 一条「继续未完成的工作」 | 会烧额度；需要配额、冷却与停看 |
| B 只监控告警 | 不主动发消息；只在卡住 / 离线 / 出错时告警 | 需要一条告警通路；活还是得人干 |
| C 检查点 + 恢复 | 把会话状态快照到账本，必要时 `ctx.agents.resume` 拉起来 | 需要决定快照什么；恢复要拿回句柄所有权 |

选定之后要动的只有 `src/auto-continue.ts` 的 `onHeartbeat`，以及
`src/config.ts` 里对应的旋钮。

另有一项次要决策：授权矩阵（见[看护登记与授权](#看护登记与授权)）是本插件的
设计选择，不是 DSH 的既有约定。

## 开发与验证

```sh
pnpm install          # 安装依赖（prepare 钩子会先跑一次 build）
pnpm run typecheck    # tsc --noEmit
pnpm run build        # tsc 产出 lib/
pnpm test             # 跑 vitest
```

单测用 `fileParallelism: false`：心跳相关的用例会起真实定时器并断言时序，
并行跑不同文件会互相干扰。

## 许可证

[MIT](./LICENSE)
