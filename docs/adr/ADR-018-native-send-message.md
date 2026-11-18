# ADR-018：有原生 `send_message` 工具时优先走工具层

- 状态：已接受
- 日期：2026-11-18
- 关联：`dsh-plugin/index.js`（`sendAgentMessage` / `canDeliverTo` / `nativeSendTools`）/ `tests/plugin-native-send.mjs` / `docs/CONTRACT.md`

## 背景

DSH 0.2.2 起把「给另一个 agent 发消息」收敛成**宿主工具** `send_message({ agent, message })`
（`@deepseek-ai/dsh-tool-subagent-control`，注册在全局层，`dsh-base/cordis.patch.yml` 注释写明
“registers the one global `send_message`”）。工具内部做两件事：`ctx.subagents.resolveName(sender, name)`
把名字/会话 id 解析成 `SessionId`，再 `ctx.subagents.sendMessage(sender, targetId, content, { signal })`。

插件此前直接调 `subagents.sendMessage(sender, sessionId, [{type:'text',text}], { signal })`，
在 0.2.2 上仍然可用，但绕过了宿主对「消息从哪来、怎么唤醒、未来怎么投递」的统一收口：
一旦宿主改动消息语义（来源标记、投递策略、跨进程转发），直调服务层就跟不上。

## 决策

- 新增统一投递入口 `sendAgentMessage(ctx, sender, targetSessionId, text, { signal })`：
  - **高版本**：`nativeSendTools()` 探测到原生 `send_message` 工具时，用
    `ctx.tools.execute({ calls: [{ type:'tool-call', id, name:'send_message', arguments }], signal, agent: sender })`
    调工具层，取 `results[0].result`：`isError` 为真则抛错，否则返回 `value.messageId`。
  - **低版本**：没有该工具（或没有 `tools.execute`）时保留原来的 `subagents.sendMessage(...)`。
- 探测带发送者作用域：`ctx.tools.get('send_message', sender)`。工具名以宿主实际注册的为准：先试下划线
  `send_message`，再试连字符别名 `send-message`，调用时用命中的那个名字。工具可能注册在 agent preset 的 scope 里，
  只查全局会漏；`ResolvedToolSet.view(scope)` 在 `scope !== agent` 时返回空表，所以检测与执行都必须
  把 `sender` 作为作用域/`agent` 传下去。
- 五处投递全部改走该入口：派发简报（`deliverTask`）、审批通知（`notifyLeadOfApproval`）、
  成员中断通知（`notifyLeadOfMemberInterrupt`）、面板 steer 泵（`steerPump`）、`dsh_team_send`。
- `send_message` 的 `agent` 参数直接传**会话 id**：`resolveName` 对不含 `/` 的未命中名字会原样当会话 id 返回，
  所以调用方不需要额外做名字解析，行为与旧路径等价。
- 打断仍走 `subagents.interrupt`（ADR-016 的语义不变）：原生工具对应的是 `interrupt_agent`，
  这里不切换，避免一次改动同时动两条链路。

## 权衡

- 走工具层比直调服务多一层 schema 校验与结果包装，性能差别可忽略；换来的是宿主后续改动自动继承。
- 工具失败（`isError`）会作为异常抛出，`dsh_team_send` 记进 `failed[]`、泵保持 queued 重试——**不会**因为
  原生路径失败而静默降级去重发一次（可能造成重复投递）。
- 低版本行为完全不变，`inject = ['tools']` 保证 `ctx.tools` 存在；测试用的假 ctx 只有 `register`/`get`、
  没有 `execute`，因此天然走回退分支，既有 33 个脚本无需改动。
