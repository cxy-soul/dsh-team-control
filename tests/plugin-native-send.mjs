// tests/plugin-native-send.mjs — 高版本 DSH 有原生 `send_message` 工具时，消息投递必须走它；
// 低版本没有该工具时保留原来的 `subagents.sendMessage`。
//
// 两代宿主的差异只在「有没有 send_message 工具」：
// - 有：调 `ctx.tools.execute({ calls:[...], agent: sender })`，接收方由宿主 resolveName 解析；
// - 没有：`subagents.sendMessage(sender, sessionId, content, { signal })`。
// 这里用同一个假 ctx 切换两种形态，验证 dsh_team_send 的分支与失败透传。
import assert from 'node:assert/strict';
import { mkTmp, startSidecar } from './lib/harness.mjs';
import { apply } from '../dsh-plugin/index.js';

const SID = 'sess-alice';

const mkFakeCtx = () => {
  const tools = new Map();
  const native = {
    enabled: false,
    /** 宿主注册的工具名：主名 `send_message`，别名 `send-message` 也要能探测到。 */
    toolName: 'send_message',
    calls: [],
    /** 每次 execute 的返回：默认成功，isError 时模拟工具失败。 */
    fail: null,
    get(name, scope) {
      if (name !== native.toolName || !native.enabled) return undefined;
      return { name, scope, description: 'native send_message', execute: async () => ({}) };
    },
    async execute(input) {
      native.calls.push(input);
      const call = input.calls[0];
      if (native.fail) {
        return { results: [{ callId: call.id, result: { isError: true, error: { message: native.fail }, content: [] } }] };
      }
      return {
        results: [{ callId: call.id, result: { isError: false, value: { messageId: `native-${native.calls.length}` }, content: [] } }],
      };
    },
  };
  const agents = {
    messages: [],
    async sendMessage(caller, targetId, content) {
      agents.messages.push({ caller, targetId, content });
      return `svc-${agents.messages.length}`;
    },
    interrupt() { /* noop */ },
    list: () => ['spawn', 'fork'],
  };
  return {
    native,
    agents,
    ctx: {
      tools: {
        register: (tool) => { tools.set(tool.name, tool); return () => { /* noop */ }; },
        get: (name, scope) => tools.get(name) || native.get(name, scope),
        execute: (input) => native.execute(input),
      },
      get(name) { return name === 'subagents' ? agents : undefined; },
      effect(fn) { const cleanup = fn(); return () => { try { cleanup?.(); } catch { /* ignore */ } }; },
      on() { return () => { /* noop */ }; },
    },
  };
};

const main = async () => {
  const tmp = mkTmp('dsh-team-plugin-native-send');
  const sidecar = await startSidecar({ dataDir: tmp.dataDir, ws: tmp.ws });
  try {
    const api = sidecar.api;
    const team = await api.post('/api/teams', { name: 'native-send', workspace: tmp.ws });
    await api.post('/api/agents/register', { teamId: team.id, name: 'alice', sessionId: SID, permissionPreset: 'workspace-write' });

    const fake = mkFakeCtx();
    apply(fake.ctx, {
      baseUrl: sidecar.url, autoStart: false, requestTimeoutMs: 5000,
      reportToolCalls: false, reportChanges: false, reportLlmCalls: false, reportContext: false,
      reportWorkspaces: false, reportLlmCatalog: false, agentAutoDispatch: false,
    });
    const send = fake.ctx.tools.get('dsh_team_send');
    assert.equal(typeof send?.execute, 'function', 'dsh_team_send 已注册');
    const lead = { agent: { id: 'sess-lead' } };

    // ① 低版本：没有 send_message 工具 → 走 subagents.sendMessage
    const legacy = await send.execute({ teamId: team.id, to: 'alice', message: '第一版消息', interrupt: false }, lead);
    assert.deepEqual(legacy.delivered, ['alice'], '低版本投递成功');
    assert.equal(fake.agents.messages.length, 1, '低版本调用 subagents.sendMessage');
    assert.equal(fake.agents.messages[0].targetId, SID, '收件人是成员会话 id');
    assert.equal(fake.native.calls.length, 0, '低版本不碰 tools.execute');

    // ② 高版本：有 send_message 工具 → 走工具层，消息体与发送者都按工具协议传
    fake.native.enabled = true;
    const modern = await send.execute({ teamId: team.id, to: 'alice', message: '第二版消息' }, lead);
    assert.deepEqual(modern.delivered, ['alice'], '高版本投递成功');
    assert.equal(fake.native.calls.length, 1, '高版本调用原生 send_message 一次');
    assert.equal(fake.agents.messages.length, 1, '高版本不再直调 subagents.sendMessage');
    const call = fake.native.calls[0].calls[0];
    assert.equal(call.type, 'tool-call', '按 ToolCallBlock 组装');
    assert.equal(call.name, 'send_message', '工具名是 send_message');
    assert.deepEqual(JSON.parse(call.arguments), { agent: SID, message: '第二版消息' }, '参数只有 agent/message');
    assert.equal(fake.native.calls[0].agent, lead.agent, '发送者作为 agent 作用域传下去');

    // ③ 原生工具失败：错误要透出到 failed，不能假装送达
    fake.native.fail = '成员会话不可写';
    const broken = await send.execute({ teamId: team.id, to: 'alice', message: '第三版消息' }, lead);
    assert.deepEqual(broken.delivered, [], '失败不计入 delivered');
    assert.equal(broken.failed?.[0]?.target, 'alice', '失败记在 failed 上');
    assert.match(String(broken.failed[0].error), /成员会话不可写/, '错误正文透传');

    // ④ 宿主若把工具名写成连字符 `send-message`：同样认，按真实名字调用
    fake.native.fail = null;
    fake.native.toolName = 'send-message';
    const alias = await send.execute({ teamId: team.id, to: 'alice', message: '第五版消息' }, lead);
    assert.deepEqual(alias.delivered, ['alice'], '连字符别名也能投递');
    assert.equal(fake.native.calls.at(-1).calls[0].name, 'send-message', '调用时用宿主注册的真实名字');
    fake.native.toolName = 'send_message';

    // ⑤ 工具层不可用（无 tools.execute）时仍回退服务层：模拟只读注册表
    fake.native.enabled = false;
    fake.ctx.tools.execute = undefined;
    fake.ctx.tools.get = () => undefined;
    const before = fake.agents.messages.length;
    const fallback = await send.execute({ teamId: team.id, to: 'alice', message: '第四版消息' }, lead);
    assert.deepEqual(fallback.delivered, ['alice'], '没有 tools.execute 时回退服务层');
    assert.equal(fake.agents.messages.length, before + 1, '回退确实走 subagents.sendMessage');

    console.log('PASS plugin-native-send — 高版本走原生 send_message，低版本保留 subagents.sendMessage');
  } finally {
    await sidecar.close();
    tmp.cleanup();
  }
};

main().catch((err) => {
  console.error('FAIL plugin-native-send —', err?.stack || err);
  process.exitCode = 1;
});
