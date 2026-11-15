// tests/plugin-stop-lead.mjs — 面板/看板停止团队时，Lead 会话也必须停
// 场景：用户在面板点「停止团队」，sidecar 只把成员置 interrupted；Lead 是团队创建者
//       （team.lead_session_id），它的回合还在跑，于是出现「成员停了、Leader 还在转」。
// 期望：插件泵看到 team.stop_requested_at 后取消 Lead 当前回合（等价用户按停止键），
//       同一时间戳只取消一次；Lead 本来空闲则不动它。
import assert from 'node:assert/strict';
import { mkTmp, startSidecar, waitFor, sleep } from './lib/harness.mjs';
import { apply } from '../dsh-plugin/index.js';

const mkFakeCtx = () => {
  const registry = new Map();
  const handlers = new Map();
  const agents = {
    spawned: [], messages: [], interrupts: [],
    async startActivation(spec) {
      agents.spawned.push({ req: spec });
      return { childId: spec.childId, messageId: `msg-${agents.spawned.length}`, result: Promise.resolve({ output: [], stopReason: 'completed' }), dispose: async () => {} };
    },
    async sendMessage(caller, targetId, content) {
      agents.messages.push({ caller, target: String(targetId), content });
      return `msg-${agents.messages.length}`;
    },
    interrupt(targetId, authority) { agents.interrupts.push({ targetId, authority }); },
    list: () => ['spawn', 'fork'],
  };
  // 顶层 Agent（Lead）由 ctx.agents 暴露；成员走 subagents。
  const liveAgents = new Map();
  const ctx = {
    tools: {
      register: (tool) => { registry.set(tool.name, tool); return () => registry.delete(tool.name); },
      get: (name) => registry.get(name),
    },
    agents,
    handlers,
    get: (name) => {
      if (name === 'subagents') return agents;
      if (name === 'agents') return { get: (id) => liveAgents.get(String(id)) };
      if (name === 'sessions') return { get: (id) => ({ id }) };
      if (name === 'sessionProjections') return { stateOf: () => null };
      return undefined;
    },
    effect(fn) { const cleanup = fn(); return () => { try { cleanup?.(); } catch { /* ignore */ } }; },
    on(name, fn) {
      const list = handlers.get(name) || [];
      list.push(fn);
      handlers.set(name, list);
      return () => { const i = list.indexOf(fn); if (i >= 0) list.splice(i, 1); };
    },
    emit(name, ...args) { for (const fn of handlers.get(name) || []) fn(...args); },
  };
  return { ctx, subagents: agents, liveAgents };
};

const fakeLead = ({ id, status = 'running' }) => ({
  id, status, cancels: [],
  cancel(cause) { this.cancels.push(cause); },
});

const main = async () => {
  const tmp = mkTmp('dsh-team-stop-lead');
  const sidecar = await startSidecar({ dataDir: tmp.dataDir, ws: tmp.ws });
  try {
    const { ctx, subagents, liveAgents } = mkFakeCtx();
    apply(ctx, {
      baseUrl: sidecar.url, autoStart: false, reportToolCalls: false,
      agentDispatchMs: 300, agentIdleSettleMs: 200, forceStopPollMs: 100,
    });
    const tool = (name) => {
      const t = ctx.tools.get(name);
      assert(t, `工具 ${name} 已注册`);
      return t;
    };
    const api = sidecar.api;
    const lead = { agent: { id: 'sess-lead' } };
    const leadAgent = fakeLead({ id: 'sess-lead' });
    liveAgents.set('sess-lead', leadAgent);

    const team = (await tool('team_create').execute({ name: 'stop-lead', workspace: tmp.ws, maxAttempts: 2 }, lead)).team;
    assert.equal(team.leadSessionId, 'sess-lead', '团队记录了 Lead 会话');

    // 让团队里有一个 running 成员，贴近「用户在成员干活时点停止」的现场。
    const spawned = await tool('team_spawn').execute(
      { teamId: team.id, name: 'alice', role: 'writer', prompt: '你是 alice。' }, lead,
    );
    const created = await tool('team_task').execute({ teamId: team.id, subject: '写一段话', plan: [] }, lead);
    const taskId = created.task?.id || created.taskId;
    await waitFor('任务被派发（running）', async () => {
      const t = await api.get(`/api/tasks/${taskId}`);
      return t.status === 'running' ? t : null;
    }, { timeout: 8000, interval: 100 });

    const stopped = await api.post(`/api/teams/${team.id}/stop`, { reason: 'panel stop' });
    assert.ok(stopped.stopped.includes(spawned.member.id), '成员被停止');

    // 成员真正被中断（旧行为保持）
    await waitFor('成员会话被 subagents.interrupt', () => (
      subagents.interrupts.find((i) => i.targetId === String(spawned.member.agentSessionId)) || null
    ), { timeout: 5000, interval: 50 });

    // Lead 当前回合被取消（新行为）
    await waitFor('Lead 当前回合被取消', () => (leadAgent.cancels.length ? true : null), { timeout: 5000, interval: 50 });
    assert.deepEqual(leadAgent.cancels[0], { kind: 'user' }, '以用户停止的语义取消 Lead 回合');

    // /api/status 暴露停止时间戳，便于插件去重
    const status = await api.get('/api/status');
    const row = status.teams.find((t) => t.id === team.id);
    assert(row && row.stopRequestedAt, '状态里带 stopRequestedAt');
    assert.equal(row.leadSessionId, 'sess-lead', '状态里带 Lead 会话');

    // 同一个停止时间戳不重复取消
    const before = leadAgent.cancels.length;
    await sleep(600);
    assert.equal(leadAgent.cancels.length, before, '同一停止只取消一次');

    // Lead 本来空闲：没有可取消的回合，不应误伤
    const lead2 = fakeLead({ id: 'sess-lead-2', status: 'idle' });
    liveAgents.set('sess-lead-2', lead2);
    const team2 = (await tool('team_create').execute({ name: 'stop-lead-idle', workspace: tmp.ws }, { agent: { id: 'sess-lead-2' } })).team;
    await api.post(`/api/teams/${team2.id}/stop`, { reason: 'panel stop idle' });
    await sleep(600);
    assert.equal(lead2.cancels.length, 0, 'Lead 空闲时不取消');

    console.log('PASS plugin-stop-lead — 停止团队会取消 Lead 当前回合，且只取消一次、空闲不误伤');
  } finally {
    await sidecar.close();
    tmp.cleanup();
  }
};

main().catch((e) => { console.error('FAIL plugin-stop-lead —', e?.stack || e); process.exitCode = 1; });
