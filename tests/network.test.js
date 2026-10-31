import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'weibo-network-tests-'));
process.env.WEIBO_CONSOLE_DATA_DIR = directory;
process.env.WEIBO_CONSOLE_LICENSE = 'off';
process.env.WEIBO_CONSOLE_TOPIC_MODE = 'general';
const d = await import('../src/db.js');
const { TaskRunner, createSnapshot } = await import('../src/runner.js');
const { taskProgress } = await import('../src/task-progress.js');
const { WeiboAdapter, VerificationError } = await import('../src/weibo-adapter.js');
const runners = [];
test.beforeEach(() => d.clearAllDataForTests());
test.afterEach(() => { for (const runner of runners.splice(0)) runner.network.clear(); });
test.after(async () => {
  await new Promise(resolve => setTimeout(resolve, 500));
  try { d.db.close(); } catch {}
  try { fs.rmSync(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); } catch {}
});
const until = async predicate => { for (let i = 0; i < 100; i++) { if (predicate()) return; await new Promise(resolve => setTimeout(resolve, 10)); } throw Error('等待测试任务结束超时'); };
function fixture(adapter = {}) {
  const account = d.createAccount('网络测试'); d.updateAccountAuth(account.id, { status: 'valid', uid: '1234567890' });
  const topic = d.createTopic({ name: '测试超话', url: 'https://example.test/topic' }); d.addPostMaterials(['固定测试文案', '固定测试文案二']); d.addCommentMaterials(['甲','乙']);
  const config = createSnapshot({ accountIds: [account.id], topicIds: [topic.id], actionPlan: [{ type: 'post', count: 1, intervalSeconds: 0 }], postDecoration: { mode: 'number', numberPosition: 'prefix' } }, d.listAccounts(), d.listTopics());
  const job = d.createJob(config), runner = new TaskRunner({ ensureIdentity: async () => ({}), ...adapter }); runners.push(runner);
  return { job, runner, account, topic };
}

test('提交前断网不计失败，连续两次联网后沿用原文与编号重试一次', async () => {
  let online = true, calls = 0; const texts = [];
  const { job, runner } = fixture({ probeConnectivity: async () => online, post: async (_a, _t, text, options) => {
    calls++; texts.push(text); if (calls === 1) { online = false; throw Error('page.goto: net::ERR_INTERNET_DISCONNECTED'); }
    options.onSubmit(); return { state: 'succeeded' };
  } });
  await runner.run(job.id);
  assert.equal(d.getJob(job.id).status, 'paused'); assert.equal(d.getJob(job.id).metrics.failed, 0);
  assert.equal(d.listActionLogs(job.id)[0].sequence_confirmed, 0);
  online = true; await runner.network.tick(job.id); assert.equal(calls, 1);
  online = false; await runner.network.tick(job.id); online = true;
  await runner.network.tick(job.id); assert.equal(calls, 1);
  await runner.network.tick(job.id); await until(() => d.getJob(job.id).status === 'completed');
  assert.deepEqual(texts, [texts[0], texts[0]]); assert.equal(calls, 2);
  assert.equal(d.getJob(job.id).metrics.success, 1);
});

test('提交后断网恢复仅只读复核，结果未知不重发并保留编号', async () => {
  let online = true, sends = 0, reads = 0;
  const { job, runner } = fixture({ probeConnectivity: async () => online,
    post: async (_a, _t, _text, options) => { sends++; options.onSubmit(); online = false; throw Error('net::ERR_CONNECTION_RESET'); },
    verifyPost: async () => { reads++; return { state: 'uncertain' }; }
  });
  await runner.run(job.id); assert.equal(d.getJob(job.id).metrics.failed, 0);
  online = true; await runner.network.tick(job.id); await runner.network.tick(job.id);
  await until(() => d.getJob(job.id).status === 'completed');
  assert.equal(sends, 1); assert.equal(reads, 1); assert.equal(d.getJob(job.id).metrics.uncertain, 1);
  assert.equal(d.listActionLogs(job.id)[0].sequence_confirmed, 1);
});

test('网络暂停转手动暂停后不自动恢复；重启可恢复网络探测', async () => {
  let online = false;
  const { job, runner } = fixture({ probeConnectivity: async () => online, post: async () => ({ state: 'succeeded' }) });
  await runner.run(job.id); runner.network.clear();
  const restored = new TaskRunner(runner.adapter); runners.push(restored); await restored.recover();
  assert.ok(restored.network.timer); restored.pause(job.id); online = true;
  await restored.network.tick(job.id); await restored.network.tick(job.id);
  assert.equal(d.getJob(job.id).status, 'paused'); assert.equal(d.getJob(job.id).pausedByUser, true);
});

test('普通页面超时但微博仍连通，不误判为断网', async () => {
  const { job, runner } = fixture({ probeConnectivity: async () => true });
  assert.equal(await runner.network.isNetworkError(Error('Timeout 30000ms exceeded'), job.id), false);
});

test('三态探测：单次不可达不暂停，未知重置连续失败，两次不可达才暂停', async () => {
  let state = 'offline';
  const { job, runner } = fixture({ probeConnectivity: async () => ({ state, code: 'ERR_CONNECTION_RESET' }) });
  await runner.network.monitor(d.getJob(job.id));
  assert.equal(d.getJob(job.id).status, 'running');
  state = 'unknown'; await runner.network.monitor(d.getJob(job.id));
  assert.equal(d.getJob(job.id).cursor.networkRecovery.failures, 0);
  state = 'offline'; await runner.network.monitor(d.getJob(job.id));
  assert.equal(d.getJob(job.id).status, 'running');
  await runner.network.monitor(d.getJob(job.id));
  assert.equal(d.getJob(job.id).status, 'paused');
  assert.equal(d.getJob(job.id).metrics.failed, 0);
  assert.equal(d.getJob(job.id).cursor.networkRecovery.lastProbe.code, 'ERR_CONNECTION_RESET');
});

test('共享探测只计一次；浏览器切换、手动暂停及旧任务结果不覆盖状态', async () => {
  let release, calls = 0;
  const manager = { generation: 1 };
  const { job, runner } = fixture({ browserManager: manager, probeConnectivity: () => { calls++; return new Promise(resolve => { release = resolve; }); } });
  const first = runner.network.probe(d.getJob(job.id)), second = runner.network.probe(d.getJob(job.id));
  release({ state: 'offline', contextGeneration: 1 }); await Promise.all([first, second]);
  assert.equal(calls, 1); assert.equal(d.getJob(job.id).cursor.networkRecovery.failures, 1);
  const switched = runner.network.probe(d.getJob(job.id)); manager.generation++;
  release({ state: 'offline', contextGeneration: 1 }); await switched;
  assert.equal(d.getJob(job.id).cursor.networkRecovery.failures, 1);
  const paused = runner.network.probe(d.getJob(job.id)); runner.pause(job.id);
  release({ state: 'online', contextGeneration: 2 }); await paused;
  assert.equal(d.getJob(job.id).pausedByUser, true);
  assert.equal(d.getJob(job.id).status, 'paused');
});

test('探测硬超时取消底层操作，返回未知而不是断网', async () => {
  let cancelled = false;
  const { job, runner } = fixture({ probeConnectivity: (_account, { signal }) => new Promise(() => { signal.addEventListener('abort', () => { cancelled = true; }); }) });
  const start = Date.now(); const result = await runner.network.probe(job);
  assert.equal(result, true); assert.equal(cancelled, true);
  assert.ok(Date.now() - start < 3400);
  assert.equal(d.getJob(job.id).cursor.networkRecovery.probeState, 'unknown');
  assert.equal(d.getJob(job.id).status, 'running');
});

test('恢复清除当前断网来源，新一轮中断独立计时且不恢复过期步骤', async () => {
  const { job, runner } = fixture({ probeConnectivity: async () => ({ state: 'online' }) });
  let time = Date.now(); runner.now = () => time;
  runner.workflow.session = { jobId: job.id };
  runner.network.pause(job.id, { accountId: 'old', kind: 'post' }, '首次断网');
  const firstSince = d.getJob(job.id).cursor.networkRecovery.since;
  // Use the fixture account for probes; the synthetic step above is only an
  // obsolete interruption marker and must be cleared after recovery.
  d.updateJob(job.id, { cursor: { ...d.getJob(job.id).cursor, networkRecovery: { ...d.getJob(job.id).cursor.networkRecovery, step: null } } });
  await runner.network.tick(job.id); await runner.network.tick(job.id);
  const online = d.getJob(job.id).cursor.networkRecovery;
  assert.equal(online.state, 'online'); assert.equal(online.reason, null); assert.equal(online.step, null); assert.equal(online.since, null);
  assert.equal(online.lastOutage.reason, '首次断网');
  time += 1000; runner.network.pause(job.id, null, '第二次断网');
  assert.notEqual(d.getJob(job.id).cursor.networkRecovery.since, firstSince);
  runner.workflow.session = null;
});

test('恢复只读复核再次要求验证码时保留待办，不被待核对终态覆盖', async () => {
  let online = true;
  const { job, runner } = fixture({ probeConnectivity: async () => online,
    post: async (_a, _t, _text, options) => { options.onSubmit(); online = false; throw Error('net::ERR_INTERNET_DISCONNECTED'); },
    verifyPost: async () => { throw new VerificationError('需要安全验证'); }
  });
  await runner.run(job.id); online = true;
  await runner.network.tick(job.id); await runner.network.tick(job.id);
  assert.equal(runner.workflow.status(d.getJob(job.id)).cards[0].status, 'pending');
  assert.equal(runner.workflow.rows(job.id, 0)[0].state, 'review');
  await until(() => d.getJob(job.id).status === 'waiting');
});

test('Chrome探测将HTTP拒绝视为连通，帧异常用备用地址，缺页与CDP异常为未知', async () => {
  let statuses = [], calls = 0, detached = 0;
  const page = { isClosed: () => false, evaluate: async () => true };
  const context = { pages: () => [page], newCDPSession: async () => ({
    send: async method => {
      if (method === 'Page.getFrameTree') return { frameTree: { frame: { id: 'frame' } } };
      if (method === 'Network.loadNetworkResource') { calls++; const next = statuses.shift(); if (next instanceof Error) throw next; return { resource: next }; }
      return {};
    }, detach: async () => { detached++; }
  }) };
  const adapter = new WeiboAdapter({ context });
  for (const httpStatusCode of [401, 403, 429]) {
    statuses = [{ success: false, httpStatusCode }];
    const value = await adapter.probeConnectivity({}); assert.equal(value.state, 'online'); assert.equal(value.httpStatus, httpStatusCode);
  }
  statuses = [Error('Frame not found during navigation'), { success: true, httpStatusCode: 200 }];
  assert.equal((await adapter.probeConnectivity({})).state, 'online');
  statuses = [{ success: false, netErrorName: 'net::ERR_CONNECTION_RESET' }, { success: false, netErrorName: 'net::ERR_CONNECTION_RESET' }];
  assert.equal((await adapter.probeConnectivity({})).state, 'offline');
  context.pages = () => [];
  assert.equal((await adapter.probeConnectivity({})).state, 'unknown');
  context.pages = () => [page]; context.newCDPSession = async () => { throw Error('Session closed'); };
  assert.equal((await adapter.probeConnectivity({})).state, 'unknown');
  assert.equal(calls, 7); assert.equal(detached, 7);
});

test('暂停参数保存、版本冲突和保存后新顺序生效，完成结果不重复', async () => {
  const { job, runner } = fixture(); runner.workflow.ensureSteps(job);
  d.updateJob(job.id, { status: 'paused', pausedByUser: true });
  const before = d.getJob(job.id).config;
  const saved = runner.applyTaskEdit(job.id, { ...before, actionPlan: [{ type: 'comment', count: 2, intervalSeconds: 3 }, ...before.actionPlan], segmentIds: ['new-comment', ...before.segmentIds], rounds: 2 }, 0);
  assert.equal(saved.job.status, 'paused'); assert.equal(saved.version, 1);
  assert.equal(runner.workflow.rows(job.id, 0).filter(r => r.state === 'pending')[0].kind, 'comment');
  assert.throws(() => runner.applyTaskEdit(job.id, before, 0), /其他页面更新/);
  assert.equal(d.getJob(job.id).config.rounds, 2);
});

test('断网期间手动停止及每日截止均终止恢复，不会再次执行', async () => {
  const { job, runner } = fixture({ probeConnectivity: async () => false });
  await runner.run(job.id); runner.stop(job.id); await until(() => d.getJob(job.id).status === 'stopped');
  await runner.network.tick(job.id); assert.equal(runner.network.timer, null);
  const next = d.createJob(d.getJob(job.id).config);
  d.updateJob(next.id, { cursor: { deadlineAt: new Date(Date.now() + 1000).toISOString() } });
  await runner.run(next.id); runner.now = () => Date.now() + 2000;
  await runner.network.tick(next.id);
  assert.equal(d.getJob(next.id).status, 'stopped'); assert.equal(d.getJob(next.id).metrics.failed, 0);
});

test('保存并继续仍断网时按新参数等待联网，成功后只执行目标次数', async () => {
  let online = false, sends = 0;
  const { job, runner } = fixture({ probeConnectivity: async () => online, post: async () => { sends++; return { state: 'succeeded' }; } });
  await runner.run(job.id); runner.pause(job.id);
  runner.applyTaskEdit(job.id, { ...d.getJob(job.id).config, actionPlan: [{ type: 'post', count: 2, intervalSeconds: 0 }] }, 0, { resume: true });
  await until(() => !runner.promise);
  assert.equal(d.getJob(job.id).status, 'paused'); assert.equal(d.getJob(job.id).config.actionPlan[0].count, 2);
  online = true; await runner.network.tick(job.id); await runner.network.tick(job.id);
  await until(() => d.getJob(job.id).status === 'completed'); assert.equal(sends, 2);
});

test('人工验证断网保留会话，联网后仍等待人工处理而不启动普通任务', async () => {
  const { job, runner } = fixture({ probeConnectivity: async () => true });
  runner.workflow.session = { jobId: job.id, identity: '1234567890' };
  d.updateJob(job.id, { cursor: { manualVerification: { identity: '1234567890', phase: 'challenge' } } });
  runner.network.pause(job.id);
  const wait = runner.network.wait(job.id);
  await runner.network.tick(job.id); await runner.network.tick(job.id); await wait;
  assert.ok(runner.workflow.session); assert.equal(d.getJob(job.id).status, 'waiting'); assert.equal(runner.promise, null);
  runner.workflow.session = null;
});

test('参数保存中途异常回滚配置和步骤，失败不会留下部分计划', () => {
  const { job, runner } = fixture(); runner.workflow.ensureSteps(job);
  d.updateJob(job.id, { status: 'paused', pausedByUser: true });
  const before = JSON.stringify(runner.workflow.rows(job.id, 0));
  const reconcile = runner.workflow.reconcile.bind(runner.workflow);
  runner.workflow.reconcile = (...args) => { reconcile(...args); throw Error('模拟保存中途失败'); };
  assert.throws(() => runner.applyTaskEdit(job.id, { ...job.config, actionPlan: [{ type: 'post', count: 3, intervalSeconds: 0 }] }, 0), /模拟保存/);
  assert.equal(JSON.stringify(runner.workflow.rows(job.id, 0)), before);
  assert.equal(d.getJob(job.id).config.actionPlan[0].count, 1);
});

test('进度按全部轮次和最终步骤计算，验证待核对和补做不提前计入', () => {
  const { job, runner, account } = fixture();
  const updated = d.updateJob(job.id, { config: { ...job.config, rounds: 2, actionPlan: [{ type: 'post', count: 4, intervalSeconds: 0 }] } });
  runner.workflow.ensureSteps(updated); const rows = runner.workflow.rows(job.id, 0);
  for (let i = 0; i < 3; i++) d.db.prepare("UPDATE task_step_state SET state='done',outcome=? WHERE job_id=? AND step_key=?").run(['succeeded','failed','skipped'][i], job.id, rows[i].step_key);
  d.db.prepare("UPDATE task_step_state SET state='review',ever_verification=1 WHERE job_id=? AND step_key=?").run(job.id, rows[3].step_key);
  const stamp = new Date().toISOString();
  d.db.prepare("INSERT INTO verification_cards(job_id,round_index,identity,account_id,status,triggered_at,updated_at) VALUES(?,0,?,?,'pending',?,?)").run(job.id, account.uid || '1234567890', account.id, stamp, stamp);
  assert.deepEqual(taskProgress(d.getJob(job.id)), { total: 8, processed: 3, remaining: 5, percent: 37.5, currentRound: 1, rounds: 2, planAdjusted: false });
  d.db.prepare("UPDATE verification_cards SET status='ready' WHERE job_id=?").run(job.id);
  assert.equal(taskProgress(d.getJob(job.id)).processed, 4);
  d.db.prepare("UPDATE task_step_state SET state='done' WHERE job_id=?").run(job.id);
  assert.equal(taskProgress(d.getJob(job.id)).percent, 99.9);
  assert.equal(taskProgress(d.updateJob(job.id, { status: 'completed' })).percent, 100);
});

test('修改计划撤销未提交步骤后重算，停止不消除剩余分母，旧任务兼容游标', () => {
  const { job, runner } = fixture();
  const first = d.updateJob(job.id, { config: { ...job.config, actionPlan: [{ type: 'post', count: 4, intervalSeconds: 0 }] } });
  runner.workflow.ensureSteps(first);
  const row = runner.workflow.rows(job.id, 0)[0];
  d.db.prepare("UPDATE task_step_state SET state='done',outcome='succeeded' WHERE job_id=? AND step_key=?").run(job.id, row.step_key);
  d.updateJob(job.id, { status: 'paused', pausedByUser: true });
  runner.applyTaskEdit(job.id, { ...first.config, actionPlan: [{ type: 'post', count: 2, intervalSeconds: 0 }] }, 0);
  assert.equal(taskProgress(d.getJob(job.id)).total, 2); assert.equal(taskProgress(d.getJob(job.id)).percent, 50);
  assert.equal(taskProgress(d.getJob(job.id)).planAdjusted, true);
  runner.workflow.finalizeStop(job.id, '测试停止');
  assert.equal(taskProgress(d.getJob(job.id)).total, 2); assert.equal(taskProgress(d.getJob(job.id)).percent, 50);
  const legacy = d.createJob({ ...first.config, schedulerVersion: 1 });
  d.updateJob(legacy.id, { cursor: { stepIndex: 1 } });
  assert.equal(taskProgress(d.getJob(legacy.id)).percent, 25);
});
