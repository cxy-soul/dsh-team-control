---
name: dsh-agent-team
description: 用 dsh-team 插件编排「真 sub-agent 成员」团队的最小可用流程（建团前先澄清需求、调研代码）：dsh_team_create → dsh_team_spawn → dsh_team_task → 成员 dsh_team_report_task → dsh_team_status/dsh_team_report；含 20 个 dsh_team_* 工具的字段清单、按任务难度给成员分配 provider/model/思考强度、按成员分配 permissionPreset 沙箱预设与 agentPreset 组合预设（工具/skill/MCP）、成员审批转发给 Lead 后由 dsh_team_approve 决定，以及 Lead（主 agent）的边界：只协调、不写代码、不做二次验收、派发完就结束回话、成员在跑时不催进度/不追问/不重发简报、收尾提一个精简 commit。Use when the user asks to create an agent team, orchestrate teammates, dispatch parallel work to sub-agents, or when a dsh_team_* call failed with an unexpected shape (unknown teamId, assignee by name, member never reports, approval timeout).
user-invocable: true
version: "2.0.0"
---

# dsh-team：把活派给真 sub-agent 成员的流程

插件提供 20 个团队工具：`dsh_team_create` `dsh_team_spawn` `dsh_team_member` `dsh_team_preset` `dsh_team_models` `dsh_team_task` `dsh_team_task_get` `dsh_team_report_task`
`dsh_team_send` `dsh_team_todo` `dsh_team_status` `dsh_team_dispatch` `dsh_team_control` `dsh_team_approve` `dsh_team_report`
`dsh_team_memory_write` `dsh_team_memory_read` `dsh_team_memory_list` `dsh_team_memory_share` `dsh_team_memory_delete`；
另有 4 个看板工具 `dsh_team_board_plan_submit` `dsh_team_board_task_status` `dsh_team_board_task_create` `dsh_team_board_task_get`（看板任务编排时用，普通建团队流程不需要）。
**别按名字猜顺序**，按下面 5 步走，一次就能通。所有成员都是真 DSH 子会话（agent 运行时），不存在 worker 进程。

**显式记忆**：成员收工前若有可复用结论，自己写一条 `dsh_team_memory_write({teamId, scope:"member", key:"handoff/<主题>", kind:"handoff", value:"≤300 字"})`；
没有就跳过，不强制。只有你明确要求时才让成员写 `scope:"team"` 上传共享空间。交换成员成果时：成员写 `visibility:"team"`
（同队可读）或 `"shared"`（凭 id 跨队可读），然后把 `memoryId` 交给别的成员用 `dsh_team_memory_read` 读。
记忆是文件（`<home>/memory/objects/*.json`），团队删除不会删记忆；`dsh_team_memory_list` 只回元数据，正文用 read。

## ⚠️ 先读：Lead 的边界（主 agent 只做协调）

Lead = 主 agent。职责只有三件：**全局理解项目 → 把活拆成 `dsh_team_task` 派给成员 → 在用户和成员之间传话**。
下面几条是硬边界，违反它们比派错任务更伤：

- **不写代码**：改文件、跑命令、修 bug、写脚本都属于成员。Lead 一旦自己下手，就会和成员的改动互相覆盖，
  也失去并行的意义。只有用户明确说「你直接改」时才例外。**只读调研**（自己读文件、grep、codegraph，
  或派 explore subagent 探索）不算「入场」，那是派活前该做的事。
- **派活后不替成员排查**：任务派出去之后，用户报 Bug 时先把复现步骤与怀疑点 `dsh_team_send` 给归属成员，
  由成员读代码、定位、修复；Lead 只做分派、汇总与状态汇报。**派活前的调研是 Lead 的职责**（见下一节），
  派活后不再自己下场定位。
- **不做二次验收**：成员 `dsh_team_report_task` 报 `done` 就是它的交付。**不要去读它改的文件、不要复跑
  lint/build/`npm test`、不要逐行判断改得对不对**——这些是用户的活。Lead 只需要把「谁改了什么、
  产物在哪、怎么验」转述给用户，验收结论由用户下。
- **派完就结束回话**：`dsh_team_task` 派发成功后本回合即可收尾（说明派给了谁、在等什么），
  **不要写 `sleep` / 延迟脚本 / `until` 轮询循环**「等它跑完」。
- **保持空闲等用户**：成员在跑时 Lead 应该静默。成员完成、任务推进时 Host 会正常把 Lead 会话拉起，
  不需要 Lead 守着或轮询；不要用 `dsh_team_status` 刷进度（要看只在给用户汇报时看一眼快照）。
- **成员在跑就不干涉**（最容易犯的一条）：成员 `running` 期间，Lead 既不催进度、也不追问「到哪了 / 还要多久」、
  更不重发任务简报。`dsh_team_send` 是**改道工具，不是催工工具**——它默认先打断成员当前回合，
  催一次就丢一次中间成果，还会把成员逼成「为了回话而提前交卷」。要么挂起等它自己
  `dsh_team_report_task`，要么只在三种情况发：方向性错误必须立刻纠正（发一次、说清改什么，
  用 `interrupt:false` 让它在下一个 step 生效）、成员 `blocked` 需要决策、成员报错需要补信息。
  发完立刻结束回合，不要等答复。
- **「新任务」先判归属**：用户提出新需求时，先判断它是不是本任务的下一步。同一目标/模块/验收 → 留在本任务；
  交付物或验收不同、要单独分支或规划 → 用 `dsh_team_board_task_create` 单开一张卡，**不要塞进当前团队的 DAG**；
  用户明说「建看板任务 / 加张卡 / 单开会话」就一律建卡。拿不准先问一句。`dsh_team_task` 只拆解当前任务，不会出现在看板上。
- **收尾时提交一个精简 commit**：本批任务全部 `done` 后，由 **Lead** 提交一次（成员不各自提交）：
  只 `git add` 本次任务涉及的文件、commit message 一行说清做了什么，不写多段 body、不把无关改动一起带进来。

Lead 主动出手只有三种情况：用户给了新指令（改派/加任务/叫停）、成员卡死或报错（`dsh_team_control` 重派/换人）、
成员触发审批（`dsh_team_approve` 放行或拒绝）。

## 派活之前：先澄清，再调研，最后才建团

**看到需求不要直接 `dsh_team_create`。** 先把需求问清（grilling），再把代码摸清（调研），最后才拆任务；
跳过这一步，成员只能按你猜的意思干完，然后全队返工。

### 1) 澄清：grilling（参考 `/grill-me`）

把需求当一棵设计树问，**一轮问完当前能问的全部问题**：每题编号、给出你的推荐答案，用户答「是」即采纳推荐。

```text
❓ **Q1** - **范围**：这次只改 A 模块，还是连 B 一起？  ➡️ 只改 A
❓ **Q2** - **验收**：……  ➡️ ……
```

- **事实自己查，决策问用户**：文件在哪、现有实现怎么写、依赖什么版本——自己读代码/跑命令查，
  不要向用户要（可派一个一次性 `subagent` 并行查）。只把真正的取舍（范围、验收、优先级、风险偏好）交给用户。
- 每轮答完重算 frontier：依赖未落地的问题放到下一轮，不猜答案。
- **frontier 空了、用户确认「就这么干」之后**才允许建团。规格已很明确的小改动，一轮确认即可，别硬套。

### 2) 调研：先摸清代码，再写简报

- 必读：`AGENTS.md` / `CLAUDE.md`（本仓 + 目标目录的）、目录结构、相关模块入口。
- 用 codegraph / grep 找现有实现、调用点、测试；确认「要改哪些文件、有没有现成模式、会碰谁」。
- 调研只读不写（不违反「Lead 不写代码」）；**调研结论必须进任务简报**：文件路径、现状、约束、验收，
  让成员不必再猜或重复找。
- **Lead 上下文不够时，就派 explore subagent 去探索，不必自己读完**（这一步不算「入场」）：
  用内置 `subagent`（fresh context，用完即弃，不进团队、不占团队名额）给一个**只读**任务——
  明确写「只读探索，不要改文件」，要它回答 2~4 个具体问题，只回「文件路径 + 行号 + 结论 + 风险」；
  事实多就并行派 2~3 个，汇总后再写简报。需要临时成员时用 scout 成员，但不要为此先建正式团队。

### 3) 然后才是：建团 → 派任务

调研完再定成员数与能力域（见「拆任务与并发」），让每个 `dsh_team_task.plan` 自带调研结论。

## 0. 权限：给每个成员分配 permissionPreset

沙箱由 DSH 的 permission preset 决定，sidecar 不再做 fs/exec/net/env 四域判定：

- `dsh_team_create({permissionPreset})` 设团队默认值，**默认 `workspace-write`**（可写工作区、需要审批的操作会问）；
  `danger-full-access` 表示完全放开（不再有审批），`read-only` 只读。
- `dsh_team_spawn({permissionPreset})` 给单个成员覆盖；不传就继承团队值。
- 插件在子会话创建后调 `ctx.permissionPresets.set(session, preset)`，返回里看 `permissionPresetApplied`；
  `false` 时 `permissionPresetWarning` 会说明宿主没有这个预设（别慌，成员仍按宿主默认权限运行）。
- 预设名必须是宿主 `permissionPresets.names` 里的项；传错会直接报错并列出可用预设。
- **`ops_bash` 报工作区缺 `WRITE_OWNER` / ACL 无法启动**：这不是 `agentPreset` 的问题；`workspace-write` 在 Windows 上要求工作区目录由当前用户拥有且具备 `WRITE_OWNER`。`procm-mcp`、文件读写能正常工作，不代表 bash 沙箱能完成 provisioning。先看 `dsh_team_status` 的 `permissionPreset`；临时可 `dsh_team_member({action:"update", permissionPreset:"danger-full-access"})`（运行中即时生效，无需 interrupt），根因用 DSH 的 `diagnose-windows-sandbox-acl` 技能修目录权限。

## 0.1 组合：给成员换一套工具/skill/MCP（agentPreset）

`agentPreset` 和 `permissionPreset` 是两套东西：前者决定成员**拥有什么**（组合里的工具插件、skill 提供方、MCP client、系统提示词），后者决定成员**被允许做什么**（沙箱 + 审批）。

- 内置预设由 DSH bundle / profile 的 Cordis YAML 声明；不够用时用 §0.2 的 `dsh_team_preset` 自建一个。
- `dsh_team_create({agentPreset})` 设团队默认；`dsh_team_spawn({agentPreset})` 按成员覆盖；都不传时插件显式使用宿主当前默认预设（不会继承 Lead 的临时组合，避免 Lead 是看板裸会话时成员连 shell 都没有）。
- 插件用宿主 `ctx.get('agentPresets').list()` 校验 id，找不到会报错并列出可用预设。
- 只有 `contextMode: 'fresh'`（默认，`spawn` provider）支持独立 preset；`fork` 会继承 Lead 的组合，此时传 `agentPreset` 会在返回里给 `agentPresetWarning` 且不生效。
- 成员的**系统提示词**来自 preset 组合 + 工作区 `AGENTS.md`；`prompt` 只是第一条用户消息，别把长期规则只写在 prompt 里（要强制就落到 preset）。

## 0.2 内置预设不合适时：自建一个 preset

先 `dsh_team_preset({ action: "list" })` 看宿主已有的（`source:"host"`）和团队自建的（`source:"team"`）。
都不满足时，复制一个最接近的内置预设的形状再改：

```text
dsh_team_preset({ action: "show", id: "standard" })      // 看内置组合长什么样（只读）
dsh_team_preset({ action: "delete", id: "my-old" })      // 删团队自建（内置不可删）
// 覆盖同名团队预设要加 confirm: true；内置预设永远不可覆盖
dsh_team_preset({ action: "save", id: "strict-reviewer", name: "严格审阅",
  plugins: [
    { name: "@deepseek-ai/dsh-persona", config: { prefix: "You are a strict code reviewer." } },
    { name: "@deepseek-ai/dsh-agent-instructions" },
    { name: "@deepseek-ai/dsh-tool-fs" },
    { name: "@deepseek-ai/dsh-tool-fs-search" },
    { name: "@deepseek-ai/dsh-skill-filesystem" },
    { name: "@deepseek-ai/dsh-tool-skill" },
    { name: "@deepseek-ai/plugin-mcp-client", config: { serverName: "codegraph", ... } }
  ] })
→ { id, file: "~/.dsh/team/presets/strict-reviewer.json", registered: true }

dsh_team_spawn({ teamId, name: "reviewer", prompt: "…", agentPreset: "strict-reviewer" })
```

规则与边界：

- 文档写到固定目录 `~/.dsh/team/presets/<id>.json`（可用 `DSH_TEAM_PRESET_DIR` 或插件配置 `presetDir` 覆盖）；JSON 是合法 YAML，可手工编辑，插件重启会重新注册。
- `save` 会**立刻**调宿主 `agentPresets.register()`，不需要重启 DSH；`broken` 字段会带出挂载诊断（缺服务/插件名拼错）。
- 同名覆盖：团队自建的可覆盖；宿主内置的 id（如 `standard`）拒绝覆盖，换一个 id。
- `plugins` 只能引用**已安装**的包；不确定包名就先看内置 preset 的 `plugins` 或问用户。
- 自建 preset 不含沙箱策略；沙箱与审批仍由 `permissionPreset` 决定，两者要一起给。

## 0.5 审批：成员卡住时由 Lead 决定

成员（`workspace-write` 等带 `ask` 策略的预设）遇到需要审批的操作时会暂停，插件把请求转发给 Lead：

```text
【dsh-team 权限审批】
teamId=team_x1
memberId=m_...
memberName=writer
toolName=exec
reason：...
requestId=req-...
批准：dsh_team_approve({ teamId: "team_x1", requestId: "req-...", decision: "allow" })
拒绝：decision 改成 "deny"（可加 reason）
```

- `allow` = 只放行这一次操作（DSH 的 `allowed-once`）；`deny` = 拒绝。
- 低风险 shell 命令（白名单程序、只读管道、常见 PowerShell 只读 cmdlet、无重定向/命令替换、不命中敏感规则）由插件自动放行，不打扰你；`autoApproveTools` 里显式列出的工具（支持 `*` 通配）也直接放行。只有敏感命令、未列入白名单的工具才需要 `dsh_team_approve`。
- 只有该团队的 Lead 能批；不是成员会话的审批请求不会拦截，仍走宿主原链路。
- 超时（插件配置 `approvalTimeoutMs`，默认 10 分钟）自动拒绝；请求也会镜像到 sidecar，
  `dsh-team approvals <team>`、`GET /api/approvals`、运行报告里都能看到。
- 收到审批消息就尽快批，成员此时是暂停的；不要用 `dsh_team_control` 绕过。

## 1. 最小配方（照抄改字段）

**前提**：已完成上一节的澄清与调研，顺序不能省。

```text
dsh_team_create({ name: "writer-team", workspace: "C:\\abs\\workdir", permissionPreset: "workspace-write", agentPreset: "standard" })
  → 返回 { team, panel }；记住 id = result.team.id（如 team_mvt5atfv1b4fe），后续每次调用都要带

dsh_team_spawn({ teamId: result.team.id, name: "writer", prompt:
  "你是 writer-team 的成员。工作目录 <workspace>。\n" +
  "职责：按 Lead 派的任务写文件；完成后必须调用 dsh_team_report_task({teamId, taskId, status, summary})。\n" +
  "不要新建团队，不要调用 dsh_team_create。" })
  → 返回 { member, permissionPreset, agentPreset, permissionPresetApplied }；记住 memberId = result.member.id

dsh_team_spawn({ teamId, name: "reviewer", prompt: "...同上，职责改成审阅..." })

dsh_team_task({ teamId, subject: "写 README 的安装章节",
            acceptance: "README.md 里有 ## 安装 小节，命令块可复制执行",
            assignee: memberId })   // 可省；省了由调度器挑 idle 成员
  → 任务立即派给 idle 成员，简报投进它信箱；返回 { task, dispatched }
```

成员自己会：调工具干活 → `dsh_team_report_task` → 任务 `done` → 依赖解锁 → 下一波 `dsh_team_task` 自动派发。
**派发成功这一回合就可以结束**，不要轮询、不要守着：成员回报后调度自动推进，需要时 Host 会把 Lead 会话拉起。

## 1.5 按任务难度分配模型

用户的 DSH 里可能配置了多个 provider/model。**不要默认所有成员都用 Lead 的模型**：先 `dsh_team_models({})`
看用户启用了哪些 route（含 `name` / `description` / 用户写的 `note`），再按任务难度选：

| 任务 | 选型建议 |
|---|---|
| 机械改动、批量重命名、找文件/读代码、格式化、跑测试 | 便宜/快的 route（`description`/`note` 里带 fast、cheap、mini 之类） |
| 架构、疑难调试、安全/正确性审阅、跨文件重构 | 强推理 route（reasoner、large、strong 之类） |
| 需要长思考的开放式设计 | 强推理 route + 显式 `reasoningEffort`（只有模型支持时才传） |

```text
dsh_team_models({}) → { models: [{provider:"deepseek", model:"deepseek-chat", note:"日常改代码"}, ...] }
dsh_team_spawn({ teamId, name:"scout", prompt:"...", agentProvider:"deepseek", model:"deepseek-chat" })
dsh_team_spawn({ teamId, name:"architect", prompt:"...", agentProvider:"deepseek", model:"deepseek-reasoner", reasoningEffort:"high" })
```

- `agentProvider` 是 **provider id**（如 `deepseek-official`、`zai-coding-cn`），不是模型名；填成模型名会报「不是模型「X」所属的 provider：应填 …」。`agentProvider` + `model` 必须是 `dsh_team_models` 里出现过的启用项，没启用就报错，别自己拼 id。
- 换 route 且不传 `reasoningEffort` → 成员用模型默认值（继承的 effort 被丢弃）；route 不变 → 继承 Lead 的 effort。
- `dsh_team_models` 里每条 route 的 `efforts` 是用户允许派发的 effort（面板「模型路由」页可逐个关闭）：传了被关闭的 effort 会报“已禁止”，传了未声明的值会报“不支持”。被禁止时省略该参数即可用模型默认值。
- 面板成员卡片与 `dsh_team_status.members[].reasoningEffort` 显示成员派发时锁定的 effort。
- 省略 `agentProvider`/`model` → 完全继承 Lead；但如果 Lead 的 route 已被用户停用，spawn 同样会被拒（换成启用项即可）。
- 用户要加/减可用模型：让他在面板「模型路由」页勾选/写备注，不要改代码。

## 2. 参数清单（最容易错的三处）

- `teamId`：`result.team.id`，**不是团队 name**（用 name 会 `unknown team`）。
- `assignee`：`result.member.id`，**不是** `name`。name 只用于 `dsh_team_send({to})` 和展示。
- `dsh_team_report_task` 的 `taskId`/`teamId`：成员必须知道才能回报 → 写在 `prompt` 或任务简报里。
  任务 `subject` 不唯一，别拿它当 id。

其他常用参数：`dsh_team_spawn({agentProvider, model, reasoningEffort, permissionPreset, agentPreset, contextMode})`；
`dsh_team_task({dispatch:false})` 只建不派；`deps:[{from: taskId}]` 声明上游；
`dsh_team_send({teamId, to: "writer"|"*"|"lead", message, interrupt?})` 给成员递话；成员正在跑时默认先打断当前回合再投递（`interrupt:false` 则不打断、等下个 step 边界：消息不会丢，但只能保证“读到”，不保证当前回合改道）；**它是改道工具、不是催进度的工具**：成员在跑时不要用它问「到哪了 / 还要多久」或重发简报（见开头「Lead 的边界」）；它只回执投递状态、不回成员答复——不要用 `sleep`/`Start-Sleep`/延迟脚本或轮询等回复，答复会作为后续回合的新消息异步到达；
`dsh_team_approve({teamId, requestId, decision:"allow"|"deny", reason})` 决定成员审批。
`dsh_team_control({action, memberId, taskId})`：`interrupt` 停成员并把在途任务转 `paused`（不计重试）；
`resume` 解冻；`assign` 把任务交给 idle 成员；`abort` 永久作废任务（`aborted`，不重试）。
`dsh_team_member({action:"update", memberId, model?, agentProvider?, contextMode?, reasoningEffort?, agentPreset?, permissionPreset?, role?})`：
改模型/上下文会重建该成员的子会话（旧上下文丢失，须先 idle/interrupted）；只改 `role`/`permissionPreset` 不重建，**运行中也能热改权限**，立即生效。
`dsh_team_member({action:"retire"|"remove", memberId, confirm?})`：retire 保留历史，remove 物理删除且必须 `confirm:true`；两者都会释放子会话。

## 3. 拆任务与并发

- 一个 `dsh_team_task` = 一个 DAG 节点；`deps` 声明上游后调度器自己解锁，**不要手写 `dsh_team_dispatch`**
  （它只在 `dsh_team_control` 恢复或审批处理后补一次）。
- 并发上限 = 建团时 `maxConcurrency`（默认 8）；成员上限 `maxMembers`（默认 64，超出变 `queued` 不报错）。
- 同一文件别让两个成员同时写：按文件/目录切 owner，或串成 `deps`。
- 成员按能力域分配，不按需求条目数量：同一模块/相邻改动、或一个成员能顺手做完的多个功能，
  合并给同一个成员（多个 `dsh_team_task` 可以同一个 `assignee`）；成员数取能完成工作的最小值，
  不要一条需求一个人。
- 失败重试 `maxAttempts`（默认 3）+ `failurePolicy`(`continue`/`abort`)。Lead 只在汇报时读一眼 `dsh_team_status`，
  不替成员复核产物（见开头「Lead 的边界」）。

### 3.1 新任务 ≠ 当前团队的新 DAG 节点

用户说「再做个 X」「帮我建个任务」时，先判断归属，别条件反射 `dsh_team_task`：

| 判据 | 归属 |
|---|---|
| 同一目标、同一模块/文件、同一验收、同一分支 | 本任务的一部分 → 照旧 `dsh_team_task` 或直接做 |
| 交付物/验收不同、要单独分支或单独规划、做完不再需要本任务上下文 | 独立任务 → `dsh_team_board_task_create` 建一张新卡 |
| 用户明确说「建看板任务 / 加一张卡 / 单开一个会话」 | 一律 `dsh_team_board_task_create`，禁止 `dsh_team_task` |

`dsh_team_board_task_create` 的 `workspaceId` / `workspacePath` 沿用它所在任务的值，不要手填占位 UUID；判断不清先问用户一句。

## 4. 常见错法与症状

| 症状 | 原因 | 修法 |
|---|---|---|
| `dsh_team_spawn` 报需要 `prompt` | 成员必填 | 写清角色 + 工作目录 + 「完成后调 dsh_team_report_task」 |
| `dsh_team_spawn` 报「permissionPreset 不存在」 | 宿主没有这个预设 | 用报错里的「可用预设」，或省略让团队默认值生效 |
| `dsh_team_spawn` 报「agentPreset 不存在」 | profile 里没声明该组合预设 | 用报错里的「可用预设」，或省略沿用好宿主默认 |
| `dsh_team_spawn` 报「agentPreset「X」在宿主里启动失败：…」 | 该预设有插件在宿主里挂载失败（缺包/缺服务），`broken` 在进程内缓存 | 用报错里的「可用预设」；修好环境后需重启 DSH 才会重新挂载 |
| `dsh_team_spawn` 报「agentProvider「X」不是模型「Y」所属的 provider」 | 把模型名当成 provider 填了 | 改成 `dsh_team_models` 里的 provider id |
| 返回 `agentPresetWarning` 提到 fork | `contextMode:'fork'` 继承 Lead 组合 | 改用 `fresh`，或接受成员与 Lead 同组合 |
| `dsh_team_preset` save 报「已由宿主定义」 | id 与内置预设撞名 | 换 id；内置预设只读 |
| `permissionPresetApplied: false` | 宿主没启用 permission-presets 服务 | 看 `permissionPresetWarning`；成员会按宿主默认权限运行，换团队预设或让用户开插件 |
| `ops_bash` 启动报工作区缺 `WRITE_OWNER` | 成员是 `workspace-write`，但 Windows 工作区目录 ACL 不满足 bash 沙箱 provisioning；与 `agentPreset` 是否 `standard` 无关 | 运行中直接 `dsh_team_member({action:"update", permissionPreset:"danger-full-access"})` 临时绕过（无需 interrupt）；根因用 `diagnose-windows-sandbox-acl` 修 ACL |
| 成员跑很久仍 `running` | 简报没让它调 `dsh_team_report_task`，或卡在审批，或确实在跑长任务 | 先看 `dsh_team_status` 的 `seq`/`stale`/blockers 与 `/api/approvals`：`seq` 在涨说明它还在干活，**别动**；只有 `stale`、或超过 `agentStartTimeoutMs`（默认 120s）毫无进展，才补 `prompt` → `interrupt` → `resume` → `assign`；确定不要了就 `abort` |
| 成员还在跑，Lead 反复 `dsh_team_send` 催「到哪了」/重发简报 | 默认会打断成员当前回合，催一次丢一次中间成果，并把它逼成提前交卷 | 挂起等 `dsh_team_report_task`；只有方向错了 / `blocked` / 报错才发一次，改道优先 `interrupt:false` |
| `dsh_team_task` 建完没人接 | 成员全 busy/queued，或 `assignee` 用了 name | 省略 `assignee` 让调度器挑，或 `dsh_team_status` 看谁 idle |
| 用户一句话需求就 `dsh_team_create` 派活 | 没澄清范围/验收、没看代码，简报只能靠猜，成员干完才发现方向错 | 先按 grilling 问一轮（每题带推荐答案），再读 `AGENTS.md` + 相关代码，最后才建团 |
| 简报只写「实现 X」，没有文件与现状 | 成员重头找、理解偏、返工；Lead 还得再解释一遍 | 调研结论写进 `plan`：目标文件、现有实现、约束、验收命令 |
| Lead 上下文快满了还硬读整个仓库 | 越读越糊，简报没写完就爆上下文 | 派 1~3 个只读 explore subagent（fresh context）并行查，只收「路径+行号+结论+风险」 |
| 任务 `done` 但产物不对 | 成员看不到 Lead 的对话 | 简报自包含：目标文件、验收标准、不要假设它读过本对话；产物好坏交给用户判定，Lead 不自己返工复核 |
| Lead 又去读 diff / 复跑 lint、测试「确认没问题」 | 做了二次验收，把用户的活抢了，还白烧一轮上下文 | 停手：只向用户转告改了什么、产物在哪、怎么验 |
| Lead 顺手自己改一个小地方 | 与成员并发写同一文件，改动互相覆盖 | 一律走 `dsh_team_task` 派给成员；只有用户明确说「你直接改」才自己动手 |
| `dsh_team_spawn` 报「模型路由未启用」 | 指定的 provider/model 没在面板启用 | `dsh_team_models` 看可用项；让用户在面板「模型路由」页启用 |
| `deps` 报 `E_BAD_REQUEST`：`"m_xxx" 是成员「alice」的 id` | `deps.from` 填了成员 id | 用 `dsh_team_task` 返回的 `task_…` 作为 `from` |
| 成员会话「failed before it finished」/ 回合报错 | provider 路由挂了 | 插件的派发监视会在 `agentStartTimeoutMs`（默认 120s）无活动后把任务交回重试；换模型重派 `dsh_team_control({action:"assign"})`，或 `dsh_team_spawn` 换一个成员 |
| `dsh_team_dispatch` 报 `no_idle_agent` 但成员看起来 idle | 成员还挂着未收尾的 running 任务，或被指定 `assignee` 卡住 | 看返回的 `idleMembers` 与 `hint`；等一次心跳、`dsh_team_control({action:"resume"})` 或去掉 `assignee` 重派 |
| `dsh_team_send` 后跑 `sleep`/延迟脚本等回复，白等还烧上下文 | 回执≠答复；答复是后续回合的新消息 | 发完就继续别的活或结束回合，不要轮询、不要重复 `dsh_team_status` |
| Lead 在成员 `running` 时反复追问、刷 `dsh_team_status` 盯进度 | 「守着」不等于推进；每催一次都可能打断成员，`seq` 在涨就是在干活 | 派完就结束回合，Host 会在成员完成时拉起 Lead；汇报时才看一眼快照 |

## 5. 观察与收尾

- `dsh_team_status({teamId, detail:"summary"})`：成员 status/step/pct/next/blockers/permissionPreset；
  `detail:"dag"`：依赖与关键路径。
- `dsh_team_task_get({taskId})`：只看单个任务的 status/attempts/lastError 与它在 DAG 里的节点
  （`dependsOn`/`ready`/`blockers`），比拉整张 `dsh_team_status` 更省上下文。
- DSH 里看：对话右上角「团队成员」条（点 chip → 右侧栏内嵌该成员对话）；侧车面板 `http://127.0.0.1:4317/panel`
  （Trace 瀑布 / DAG / 模型路由 / 消息回执）。
- 收工顺序：成员全部 `done` → **Lead 提一个精简 commit**（`git add` 本批任务涉及的文件，message 一行
  说明做了什么）→ `dsh_team_report({teamId})` 导出 Markdown（成员、DAG、审批、审计含 before/after 哈希）给用户。
- 验收归用户：把「产物路径 + 最短验收步骤」写给用户就结束，**不要再自己去跑一遍确认**；
  用户说有问题时，再把反馈拆成新的 `dsh_team_task` 派回去。
