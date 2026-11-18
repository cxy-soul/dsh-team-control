// tests/plugin-board-agent-tools.mjs — agent 侧工具：dsh_team_board_task_create / dsh_team_board_task_get / dsh_team_task_get
import assert from 'node:assert/strict';
import { mkTmp, startSidecar } from './lib/harness.mjs';
import { apply } from '../dsh-plugin/index.js';

// 最小假 ctx：工具注册 + 事件钩子 + agents/presets 干跑（本测试不真正拉起会话）
const mkFakeCtx = () => {
  const registry = new Map();
  const handlers = new Map();
  const created = [];
  const agents = {
    created,
    async create(options) {
      const rec = { options, followups: [], steers: [], disposed: false };
      const agent = {
        id: options.sessionId,
        session: { id: options.sessionId, seq: 0, eventAt: () => undefined },
        followup(message) { rec.followups.push(message); },
        steer(message) { rec.steers.push(message); },
      };
      rec.agent = agent;
      created.push(rec);
      if (typeof options.setup === 'function') await options.setup({});
      return { agent, dispose: async () => { rec.disposed = true; } };
    },
    get(id) { return created.find((r) => r.agent.id === id)?.agent; },
    list: () => [],
  };
  const agentPresets = {
    defaultId: 'standard',
    async list() { return []; },
    async resolve(id) { return { id }; },
    async mount() {},
    async register() { return () => {}; },
  };
  const presets = {
    names: ['read-only', 'workspace-write', 'danger-full-access'],
    set() {},
  };
  const ctx = {
    tools: {
      register: (tool) => { registry.set(tool.name, tool); return () => registry.delete(tool.name); },
      get: (name) => registry.get(name),
    },
    agents,
    handlers,
    get(name) {
      if (name === 'subagents' || name === 'agents') return agents;
      if (name === 'permissionPresets') return presets;
      if (name === 'agentPresets') return agentPresets;
      if (name === 'sessionController') return { agents: { selectionFor: () => ({ current: null }), selectForNextRequest() {} } };
      if (name === 'agentDefaultModel') return { currentSelection: () => ({ provider: 'p', model: 'm' }) };
      if (name === 'sessions') return { get: (id) => ({ id }) };
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
  return { ctx, created };
};

const main = async () => {
  const tmp = mkTmp('dsh-team-plugin-board-agent-tools');
  const sidecar = await startSidecar({ dataDir: tmp.dataDir, ws: tmp.ws });
  try {
    const api = sidecar.api;
    await api.post('/api/workspaces', { items: [{ id: 'ws-at', title: 'AT', path: tmp.ws }] });
    const { ctx, created } = mkFakeCtx();
    apply(ctx, {
      baseUrl: sidecar.url, home: tmp.dataDir, autoStart: false,
      reportToolCalls: false, reportChanges: false, reportLlmCalls: false,
      reportContext: false, reportWorkspaces: false, reportLlmCatalog: false,
      agentAutoDispatch: false, boardDispatchMs: 200, boardIdleGraceMs: 800,
    });

    const createTool = ctx.tools.get('dsh_team_board_task_create');
    const getTool = ctx.tools.get('dsh_team_board_task_get');
    const teamGetTool = ctx.tools.get('dsh_team_task_get');
    assert.ok(createTool && getTool && teamGetTool, '三个 agent 侧工具已注册');

    // 1) 成员建看板任务：只返回精简 task，带上 git 分支与工作区
    const exec = { agent: { id: 'session-agent-1' } };
    const made = await createTool.execute({
      title: 'Agent 建的任务', description: '由成员创建', workspaceId: 'ws-at',
      gitBranch: 'feat/agent-x', auto: false,
    }, exec);
    assert.ok(String(made.task?.id || '').startsWith('bt_'), '返回看板任务');
    assert.equal(made.task.workspaceId, 'ws-at', '落到指定工作区');
    assert.equal(made.task.gitBranch, 'feat/agent-x', '带上 git 分支');
    assert.equal(made.task.status, 'todo', '手动入队时停在待办');
    assert.equal(made.task.prompt, undefined, '不泄露内部 prompt 字段');
    assert.equal(created.length, 0, '不自动执行就不拉起会话');

    // 1b) 手填占位 workspaceId：按 workspacePath 改挂到已注册工作区，不落幽灵工作区
    const ghosted = await createTool.execute({
      title: '幽灵工作区任务', description: '路径能对上', workspacePath: tmp.ws,
      workspaceId: '00000000-0000-0000-0000-000000000000', auto: false,
    }, exec);
    assert.equal(ghosted.task.workspaceId, 'ws-at', '占位 workspaceId 按路径改挂');

    // 1c) workspaceId 与路径都对不上：直接报错，不建幽灵卡
    let ghostErr = null;
    try {
      await createTool.execute({
        title: '无效工作区', workspaceId: '00000000-0000-0000-0000-000000000000',
        workspacePath: '/definitely/not/a/registered/workspace', auto: false,
      }, exec);
    } catch (e) { ghostErr = e; }
    assert.match(String(ghostErr?.message || ghostErr), /workspaceId 不存在/, '无法解析时拒绝建卡');

    // 1d) 计划/执行/团队模型路由：对象与 "provider/model" 字符串都归一化后落库
    const routed = await createTool.execute({
      title: '带模型路由的任务', workspaceId: 'ws-at', auto: false,
      planRoute: { provider: 'p', model: 'm-plan', reasoningEffort: 'high' },
      leadRoute: 'p/m-lead',
      teamModels: [{ provider: 'p', model: 'm-team' }, 'p/m-team2'],
      prewalk: true,
    }, exec);
    assert.deepEqual(routed.task.planRoute, { provider: 'p', model: 'm-plan', reasoningEffort: 'high' }, '计划模型落库');
    assert.deepEqual(routed.task.leadRoute, { provider: 'p', model: 'm-lead', reasoningEffort: null }, '执行模型从字符串归一化');
    assert.deepEqual(routed.task.teamModels.map((m) => m.model), ['m-team', 'm-team2'], '团队模型白名单落库');
    assert.equal(routed.task.prewalk, true, 'prewalk 落库');

    // 1e) 模型路由在 board_task_get 里可见
    const routedGot = await getTool.execute({ taskId: routed.task.id }, exec);
    assert.equal(routedGot.task.planRoute.model, 'm-plan', 'board_task_get 返回计划模型');
    assert.equal(routedGot.task.teamModels.length, 2, 'board_task_get 返回团队模型白名单');

    // 1f) 非法 route：缺 model / teamModels 不是数组时直接报错，不建卡
    let routeErr = null;
    try {
      await createTool.execute({ title: '坏计划路由', workspaceId: 'ws-at', auto: false, planRoute: { provider: 'p' } }, exec);
    } catch (e) { routeErr = e; }
    assert.match(String(routeErr?.message || routeErr), /planRoute 需要 model/);
    routeErr = null;
    try {
      await createTool.execute({ title: '坏白名单', workspaceId: 'ws-at', auto: false, teamModels: 'p/m' }, exec);
    } catch (e) { routeErr = e; }
    assert.match(String(routeErr?.message || routeErr), /teamModels 需要数组/);

    // 2) 按 taskId 查看板任务
    const got = await getTool.execute({ taskId: made.task.id }, exec);
    assert.equal(got.task.id, made.task.id);
    assert.equal(got.task.title, 'Agent 建的任务');

    // 3) 不给 taskId 时按调用会话反查；会话无关联任务应明确报错
    let err = null;
    try { await getTool.execute({}, exec); } catch (e) { err = e; }
    assert.match(String(err?.message || err), /没有关联的看板任务/);

    // 4) 团队任务：返回 task + DAG 节点（含依赖与 ready）
    const team = await api.post('/api/teams', { name: 'T', workspace: tmp.ws });
    const up = await api.post('/api/tasks', { teamId: team.id, subject: '上游任务' });
    const down = await api.post('/api/tasks', { teamId: team.id, subject: '下游任务' });
    await api.post('/api/deps', { from: up.id, to: down.id });
    const one = await teamGetTool.execute({ taskId: down.id }, {});
    assert.equal(one.task.id, down.id);
    assert.equal(one.task.subject, '下游任务');
    assert.equal(one.node.taskId, down.id, '附带 DAG 节点');
    assert.deepEqual(one.node.dependsOn, [up.id], '依赖来自 DAG');
    assert.equal(one.node.ready, false, '上游未完成时不可就绪');

    err = null;
    try { await teamGetTool.execute({ taskId: down.id, teamId: 'team_nope' }, {}); } catch (e) { err = e; }
    assert.match(String(err?.message || err), /不属于/, 'teamId 不匹配时拒绝');

    console.log('plugin-board-agent-tools: ok');
  } finally {
    await sidecar.close();
    tmp.cleanup();
  }
};

main().catch((e) => { console.error(e); process.exit(1); });
