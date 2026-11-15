// tests/plugin-board.mjs — 看板 Host 调度：claim 后自动建规划会话、同会话执行、done 后追问翻回
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { mkTmp, startSidecar, waitFor, sleep } from './lib/harness.mjs';
import { apply } from '../dsh-plugin/index.js';

const mkFakeCtx = () => {
  const registry = new Map();
  const handlers = new Map();
  const created = [];
  const permissions = [];
  const mounted = [];
  const agents = {
    created,
    async create(options) {
      const rec = { options, followups: [], cancels: [], disposed: false };
      const agent = {
        id: options.sessionId,
        session: { id: options.sessionId },
        status: 'running',
        cancels: rec.cancels,
        cancel(cause) { rec.cancels.push(cause); },
        followup(message) { rec.followups.push(message); },
      };
      rec.agent = agent;
      created.push(rec);
      if (typeof options.setup === 'function') await options.setup({});
      return { agent, dispose: async () => { rec.disposed = true; } };
    },
    get(id) { return created.find((r) => r.agent.id === id)?.agent; },
    list: () => [],
    b: null,
  };
  const agentPresets = {
    defaultId: 'standard',
    async list() { return []; },
    async resolve(id) { return { id }; },
    async mount(_ctx, id) { mounted.push(id); },
    async register() { return () => {}; },
  };
  const presets = {
    names: ['read-only', 'workspace-write', 'danger-full-access'],
    set(session, name) { permissions.push({ sessionId: session?.id, name }); },
  };
  const ctx = {
    tools: {
      register: (tool) => { registry.set(tool.name, tool); return () => registry.delete(tool.name); },
      get: (name) => registry.get(name),
    },
    agents,
    handlers,
    get(name) {
      if (name === 'subagents') return agents;
      if (name === 'agents') return agents;
      if (name === 'permissionPresets') return presets;
      if (name === 'agentPresets') return agentPresets;
      if (name === 'agentDefaultModel') return { currentSelection: () => ({ provider: 'p', model: 'default-m', reasoningEffort: 'high' }) };
      if (name === 'sessions') return { get: (id) => ({ id }) };
      return undefined;
    },
    effect(fn) { const cleanup = fn(); return () => { try { cleanup?.(); } catch { /* ignore */ } }; },
    on(name, fn) {
      const list = handlers.get(name) || [];
      list.push(fn);
      handlers.set(name, list);
      return () => {
        const i = list.indexOf(fn);
        if (i >= 0) list.splice(i, 1);
      };
    },
    emit(name, ...args) { for (const fn of handlers.get(name) || []) fn(...args); },
  };
  return { ctx, created, permissions, mounted };
};

const main = async () => {
  const tmp = mkTmp('dsh-team-plugin-board');
  const sidecar = await startSidecar({ dataDir: tmp.dataDir, ws: tmp.ws });
  try {
    const api = sidecar.api;
    await api.post('/api/workspaces', { items: [{ id: 'ws-pb', title: 'PB', path: tmp.ws }] });
    const { ctx, created, permissions, mounted } = mkFakeCtx();
    apply(ctx, {
      baseUrl: sidecar.url, home: tmp.dataDir, autoStart: false,
      reportToolCalls: false, reportChanges: false, reportLlmCalls: false,
      reportContext: false, reportWorkspaces: false, reportLlmCatalog: false,
      agentAutoDispatch: false, boardDispatchMs: 300, boardIdleGraceMs: 800,
    });

    // auto=0：泵不建会话
    const manual = await api.post('/api/board/tasks', {
      workspaceId: 'ws-pb', title: '手动任务', auto: false, executionMode: 'same',
    });
    await sleep(900);
    assert.equal(created.length, 0, 'auto=0 不自动建会话');

    // same：规划 → 同会话执行
    const task = await api.post('/api/board/tasks', {
      workspaceId: 'ws-pb', title: '同会话任务', description: '做事', auto: true, executionMode: 'same',
      planRoute: { provider: 'p', model: 'plan-m' },
      leadRoute: { provider: 'p', model: 'lead-m' },
      teamModels: [{ provider: 'p', model: 'm1' }],
    });
    const rec = await waitFor('planning session', () => created[0]?.followups?.length ? created[0] : null);
    assert.equal(rec.options.meta.cwd, tmp.ws, 'cwd 是工作区路径');
    assert.equal(rec.options.meta.agentPreset, 'standard', '未配置时规划会话显式挂宿主默认预设');
    assert(mounted.includes('standard'), 'setup 里 mount 了宿主默认预设');
    assert.deepEqual(rec.options.agentOptions, { provider: 'p', model: 'plan-m' }, '规划用 planRoute');
    assert.equal(perm(permissions, rec.agent.id), 'read-only', '规划只读');
    assert.match(rec.followups[0].content[0].text, /规划 Agent/, '投了规划 prompt');
    assert.match(rec.followups[0].content[0].text, /dsh-agent-team/, '规划 prompt 要求先加载 dsh-agent-team 技能');
    assert.match(rec.followups[0].content[0].text, /board_task_status/, '同会话规划 prompt 自带执行规则，提交后不再补发');
    assert.match(rec.followups[0].content[0].text, /独立的一件事：调用 board_task_create 给它建一张看板卡/, 'Lead 提示词要求先判断新任务归属');
    assert.match(rec.followups[0].content[0].text, /team_task 只拆解当前任务/, 'Lead 提示词声明 team_task 只拆当前任务、不上看板');
    assert.equal((await api.get(`/api/board/tasks/${task.id}`)).status, 'planning', '任务进入 planning');

    const planTool = ctx.tools.get('board_plan_submit');
    assert(planTool, 'board_plan_submit 已注册');
    await planTool.execute({ plan: '# 计划', summary: '一句话' }, { agent: { id: rec.agent.id } });
    const planned = await api.get(`/api/board/tasks/${task.id}`);
    assert.equal(planned.status, 'inprogress', '提交计划即进入执行槽位');
    assert.equal(planned.leadSessionId, rec.agent.id, 'same 模式 lead 是同一会话');

    assert.equal(created.length, 1, 'same 模式不新建会话');
    assert.equal(perm(permissions, rec.agent.id), 'danger-full-access', '执行切到 danger-full-access');
    assert.equal(rec.followups.length, 1, '不再补发「现在开始执行」');
    assert.equal((await api.get(`/api/board/tasks/${task.id}`)).status, 'inprogress', '任务进入 inprogress');

    const statusTool = ctx.tools.get('board_task_status');
    assert(statusTool, 'board_task_status 已注册');
    await statusTool.execute({ status: 'done', summary: '完成' }, { agent: { id: rec.agent.id } });
    assert.equal((await api.get(`/api/board/tasks/${task.id}`)).status, 'done', 'Lead 置 done');

    // 用户再次发消息：done -> inprogress
    ctx.emit('session/event', { id: rec.agent.id }, { type: 'user/message', data: { content: [{ type: 'text', text: '继续' }] } });
    await waitFor('done -> inprogress', async () => (await api.get(`/api/board/tasks/${task.id}`)).status === 'inprogress');
    await sleep(2500);
    assert.equal(rec.followups.length, 1, '用户追问不重复注入执行 prompt');
    await statusTool.execute({ status: 'done', summary: '完成' }, { agent: { id: rec.agent.id } });

    // new：规划完成后新建 Lead 会话
    const task2 = await api.post('/api/board/tasks', {
      workspaceId: 'ws-pb', title: '新会话任务', auto: true, executionMode: 'new',
    });
    const rec2 = await waitFor('second planning session', () => created[1]?.followups?.length ? created[1] : null);
    assert.notEqual(rec2.agent.id, rec.agent.id, 'new 模式规划会话不同');
    await ctx.tools.get('board_plan_submit').execute({ plan: '# 计划2' }, { agent: { id: rec2.agent.id } });
    const rec3 = await waitFor('new lead session', () => created[2]?.followups?.length ? created[2] : null);
    assert.notEqual(rec3.agent.id, rec2.agent.id, 'new 模式执行会话独立');
    assert.equal(rec3.options.agentOptions?.model, 'default-m', '无 route 时回退到宿主动态模型');
    assert.equal((await api.get(`/api/board/tasks/${task2.id}`)).status, 'inprogress', '新会话任务进入执行');
    await statusTool.execute({ status: 'done', summary: '完成2' }, { agent: { id: rec3.agent.id } });
    ctx.emit('session/event', { id: rec3.agent.id }, { type: 'user/message', data: { content: [{ type: 'text', text: '继续2' }] } });
    await waitFor('new-mode follow-up', async () => (await api.get(`/api/board/tasks/${task2.id}`)).status === 'inprogress');
    await sleep(2500);
    assert.equal(created.length, 3, 'new 模式追问复用已有 Lead 会话');
    assert.equal(rec3.followups.length, 1, 'new 模式追问不再注入执行 prompt');

    // 手动任务 start 后由泵接管
    await api.post(`/api/board/tasks/${manual.id}/start`, {});
    await waitFor('manual start claims', () => created.length >= 4);

    // 重试续跑：已有团队时禁止重复建队，force 才放行
    const teamTool = ctx.tools.get('team_create');
    assert(teamTool, 'team_create 已注册');
    const firstTeam = await teamTool.execute({ name: '续跑团队', workspace: tmp.ws }, { agent: { id: rec3.agent.id } });
    assert(firstTeam.team?.id, '首次建队返回 team');
    const bound = await api.get(`/api/board/tasks/${task2.id}/teams`);
    assert.equal(bound.items.length, 1, '团队自动绑定到任务');
    assert.equal(bound.items[0], firstTeam.team.id, '绑定的是刚创建的团队');

    await statusTool.execute({ status: 'failed', summary: '故意失败' }, { agent: { id: rec3.agent.id } });
    assert.equal((await api.get(`/api/board/tasks/${task2.id}`)).status, 'failed', '任务置 failed');
    await api.post(`/api/board/tasks/${task2.id}/retry`, {});
    const recRetry = await waitFor('retry lead session', () => created.find((r) => {
      const text = r.followups[0]?.content?.[0]?.text || '';
      return text.includes('已关联团队');
    }));
    assert.match(recRetry.followups[0].content[0].text, new RegExp(firstTeam.team.id), '重试 prompt 带上既有团队 id');
    await assert.rejects(
      () => teamTool.execute({ name: '不该新建', workspace: tmp.ws }, { agent: { id: recRetry.agent.id } }),
      /已关联团队/,
      '续跑会话禁止重复建队',
    );
    const forced = await teamTool.execute({ name: '并行新团队', workspace: tmp.ws, force: true }, { agent: { id: recRetry.agent.id } });
    assert(forced.team?.id && forced.team.id !== firstTeam.team.id, 'force 放行并行新团队');
    await statusTool.execute({ status: 'done', summary: '续跑完成' }, { agent: { id: recRetry.agent.id } });

    // 停止 solo 任务：没有团队，也要取消 Lead/规划会话的当前回合（stop_requested_at 驱动）
    await api.post(`/api/board/tasks/${manual.id}/stop`, { reason: '释放并发槽位' }); // 手动任务占着 inprogress 槽位
    const mark = created.length;
    const task3 = await api.post('/api/board/tasks', {
      workspaceId: 'ws-pb', title: '停止任务', auto: true, executionMode: 'same',
    });
    const recStop = await waitFor('stop planning session', () => created[mark]?.followups?.length ? created[mark] : null);
    const stopped = await api.post(`/api/board/tasks/${task3.id}/stop`, { reason: '用户停止' });
    assert.equal(stopped.status, 'failed', '任务立即 failed');
    assert(stopped.stopRequestedAt, '任务带 stopRequestedAt');
    await waitFor('停止后取消规划会话回合', () => (recStop.agent.cancels.length ? true : null), { timeout: 5000, interval: 50 });
    assert.deepEqual(recStop.agent.cancels[0], { kind: 'user' }, '以用户停止的语义取消');
    await sleep(700);
    assert.equal(recStop.agent.cancels.length, 1, '同一 stopRequestedAt 只取消一次');

    // 重试后时间戳清空，再次停止会重新取消（新时间戳）
    await api.post(`/api/board/tasks/${task3.id}/retry`, {});
    assert.equal((await api.get(`/api/board/tasks/${task3.id}`)).stopRequestedAt, null, '重试清空停止时间戳');

    console.log('plugin-board: ok');
  } finally {
    await sidecar.close();
    tmp.cleanup();
  }
};

function perm(list, sessionId) {
  return [...list].reverse().find((p) => p.sessionId === sessionId)?.name;
}

main().catch((e) => { console.error(e); process.exit(1); });
