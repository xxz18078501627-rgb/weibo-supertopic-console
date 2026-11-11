import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'weibo-navigation-recovery-'));
process.env.WEIBO_CONSOLE_DATA_DIR = dir;
process.env.WEIBO_CONSOLE_LICENSE = 'off';
process.env.WEIBO_CONSOLE_NOTIFY = 'off';
process.env.WEIBO_CONSOLE_TOPIC_MODE = 'general';
const d = await import('../src/db.js');
const { TaskRunner, createSnapshot } = await import('../src/runner.js');
const { NavigationUnavailableError } = await import('../src/navigation.js');
const { VerificationError } = await import('../src/weibo-adapter.js');
const runners = [];
const until = async fn => { for (let n = 0; n < 300; n++) { if (fn()) return; await new Promise(resolve => setTimeout(resolve, 5)); } throw new Error('等待恢复超时'); };
const fault = () => new NavigationUnavailableError('测试页面加载失败', { navigationUrl: 'https://weibo.com/p/test?secret=hidden', stage: 'topic', netCode: 'ERR_HTTP_RESPONSE_CODE_FAILURE' });
test.beforeEach(() => d.clearAllDataForTests());
test.afterEach(() => { for (const r of runners.splice(0)) { r.navigation.clear(); r.network.clear(); } });
test.after(() => { d.db.close(); fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10 }); });
function fixture(adapter = {}, { legacy = false, count = 1, accounts = 1, kind = 'post' } = {}) {
  const chosen = Array.from({ length: accounts }, (_, n) => {
    const a = d.createAccount('账号' + n); return d.updateAccountAuth(a.id, { status: 'valid', uid: String(1000 + n) });
  });
  const topic = d.createTopic({ name: '测试', url: 'https://weibo.com/p/test' });
  d.addPostMaterials(['原文一', '原文二']); d.addCommentMaterials(['评论一', '评论二']);
  const config = createSnapshot({ accountIds: chosen.map(x => x.id), topicIds: [topic.id], rounds: 1,
    actionPlan: [{ type: kind, count, intervalSeconds: 0 }], readRetryCount: 2,
    postDecoration: { mode: 'number', numberPosition: 'prefix' } }, d.listAccounts(), d.listTopics());
  if (legacy) config.schedulerVersion = 1;
  const job = d.createJob(config);
  let time = Date.parse('2030-03-15T04:00:00Z');
  d.updateJob(job.id, { cursor: { ...job.cursor, deadlineAt: '2030-03-15T15:59:00Z' } });
  const runner = new TaskRunner({ ensureIdentity: async () => ({}), probeConnectivity: async () => true,
    probeNavigation: async () => ({ state: 'ready' }), ...adapter }, { now: () => time }); runners.push(runner);
  return { job: d.getJob(job.id), runner, account: chosen[0], topic,
    move: ms => { time += ms; },
    async tick() { const next = d.getJob(job.id).cursor.navigationRecovery?.nextCheckAt; if (next) time = Math.max(time, Date.parse(next)); await runner.navigation.tick(job.id); } };
}

for (const legacy of [false, true]) test(`导航失败首次暂停，111个剩余步骤不失败（${legacy ? '旧' : '新'}调度）`, async () => {
  let calls = 0;
  const f = fixture({ ensureIdentity: async () => { calls++; throw fault(); } }, { legacy, count: 4, accounts: 28 });
  await f.runner.run(f.job.id);
  const job = d.getJob(f.job.id);
  assert.equal(job.status, 'paused'); assert.equal(job.metrics.failed, 0); assert.equal(calls, 1);
  assert.equal(job.cursor.stepIndex || 0, 0);
  assert.equal(d.listActionLogs(job.id).length, 1);
  assert.equal(job.cursor.navigationRecovery.url, 'https://weibo.com/p/test');
  assert.equal(d.getAccount(f.account.id).auth_status, 'valid');
  assert.equal(job.cursor.skippedAccountIds?.length || 0, 0);
});

test('退避5/15/30/60秒，失败重置连续成功，robots在线不提前恢复', async () => {
  let identities = 0, state = 'unavailable';
  const f = fixture({ ensureIdentity: async () => { identities++; throw fault(); }, probeNavigation: async () => ({ state }) });
  await f.runner.run(f.job.id);
  const nextDelay = () => Date.parse(d.getJob(f.job.id).cursor.navigationRecovery.nextCheckAt) - f.runner.now();
  assert.equal(nextDelay(), 5000);
  await f.runner.navigation.tick(f.job.id); assert.equal(identities, 1);
  for (const ms of [15000, 30000, 60000, 60000]) { await f.tick(); assert.equal(nextDelay(), ms); }
  state = 'ready'; await f.tick(); assert.equal(d.getJob(f.job.id).cursor.navigationRecovery.successes, 1);
  state = 'unavailable'; await f.tick(); assert.equal(d.getJob(f.job.id).cursor.navigationRecovery.successes, 0);
  assert.equal(d.getJob(f.job.id).metrics.failed, 0);
});

for (const legacy of [false, true]) test(`未提交恢复沿用原文/编号，只成功一次（${legacy ? '旧' : '新'}调度）`, async () => {
  const texts = []; let calls = 0;
  const f = fixture({ post: async (_a, _t, text, options) => {
    calls++; texts.push(text); if (calls === 1) throw fault(); options.onSubmit(); return { state: 'succeeded' };
  } }, { legacy });
  await f.runner.run(f.job.id);
  const action = d.listActionLogs(f.job.id)[0]; assert.equal(action.state, 'prepared');
  await f.tick(); assert.equal(calls, 1);
  await f.tick(); await until(() => d.getJob(f.job.id).status === 'completed');
  if (f.runner.promise) await f.runner.promise;
  assert.deepEqual(texts, [texts[0], texts[0]]); assert.equal(calls, 2);
  const final = d.listActionLogs(f.job.id)[0]; assert.equal(final.id, action.id); assert.equal(final.sequence_number, action.sequence_number);
  assert.equal(d.getJob(f.job.id).metrics.success, 1); assert.equal(d.getJob(f.job.id).metrics.failed, 0);
});

for (const legacy of [false, true]) for (const confirmed of [false, true]) test(`已提交导航故障只核验不重发（旧=${legacy},确认=${confirmed}）`, async () => {
  let sends = 0, reads = 0;
  const f = fixture({ post: async (_a, _t, _text, opts) => { sends++; opts.onSubmit(); throw fault(); },
    verifyPost: async () => { reads++; return { state: confirmed ? 'succeeded' : 'uncertain' }; } }, { legacy });
  await f.runner.run(f.job.id); assert.equal(d.listActionLogs(f.job.id)[0].state, 'uncertain');
  await f.tick(); await f.tick(); await until(() => d.getJob(f.job.id).status === 'completed');
  if (f.runner.promise) await f.runner.promise;
  assert.equal(sends, 1); assert.equal(reads, 1);
  const metrics = d.getJob(f.job.id).metrics; assert.equal(metrics.success, confirmed ? 1 : 0); assert.equal(metrics.uncertain, confirmed ? 0 : 1);
});

test('重启保持nextCheckAt和成功次数，手动暂停不恢复，继续后接续探测', async () => {
  const f = fixture({ ensureIdentity: async () => { throw fault(); } }); await f.runner.run(f.job.id);
  await f.tick(); const before = d.getJob(f.job.id).cursor.navigationRecovery;
  f.runner.navigation.clear();
  const other = new TaskRunner(f.runner.adapter, { now: f.runner.now }); runners.push(other); await other.recover();
  assert.ok(other.navigation.timer); assert.deepEqual(d.getJob(f.job.id).cursor.navigationRecovery, before);
  other.pause(f.job.id); await other.navigation.tick(f.job.id); assert.equal(d.getJob(f.job.id).pausedByUser, true);
  other.resume(f.job.id); assert.equal(d.getJob(f.job.id).status, 'paused'); assert.ok(other.navigation.timer);
});

for (const end of ['pause', 'stop', 'deadline']) test(`探测期间${end}优先，迟到成功不能恢复`, async () => {
  let resolveProbe;
  const f = fixture({ ensureIdentity: async () => { throw fault(); }, probeNavigation: async () => new Promise(resolve => { resolveProbe = resolve; }) });
  await f.runner.run(f.job.id);
  const pending = f.tick(); await until(() => Boolean(resolveProbe));
  if (end === 'pause') f.runner.pause(f.job.id);
  if (end === 'stop') f.runner.stop(f.job.id);
  if (end === 'deadline') { f.move(24 * 60 * 60 * 1000); f.runner.enforceDailyStop(); }
  resolveProbe({ state: 'ready' }); await pending;
  if (end === 'pause') { assert.equal(d.getJob(f.job.id).pausedByUser, true); assert.equal(d.getJob(f.job.id).status, 'paused'); }
  else await until(() => d.getJob(f.job.id).status === 'stopped');
  assert.notEqual(d.getJob(f.job.id).cursor.navigationRecovery.state, 'recovered');
});

for (const state of ['verification', 'authentication']) test(`恢复遇${state}转人工，不提交也不把账号标失效`, async () => {
  let sends = 0;
  const f = fixture({ ensureIdentity: async () => { throw fault(); }, post: async () => { sends++; return { state: 'succeeded' }; }, probeNavigation: async () => ({ state }) });
  await f.runner.run(f.job.id); await f.tick();
  const job = d.getJob(f.job.id);
  assert.equal(job.status, 'waiting'); assert.equal(job.cursor.navigationRecovery.state, 'human_required');
  assert.equal(f.runner.workflow.status(job).cards.length, 1);
  assert.equal(job.metrics.failed, 0); assert.equal(d.getAccount(f.account.id).auth_status, 'valid'); assert.equal(sends, 0);
});

test('已提交恢复复核遇验证码，保留review及回执，不改成prepared', async () => {
  const f = fixture({ post: async (_a,_t,_text,o) => { o.onSubmit(); throw fault(); }, verifyPost: async () => { throw new VerificationError('需验证'); } });
  await f.runner.run(f.job.id); await f.tick(); await f.tick();
  const j = d.getJob(f.job.id); assert.equal(j.status, 'waiting');
  assert.equal(d.listActionLogs(j.id)[0].state, 'uncertain');
  assert.equal(f.runner.workflow.rows(j.id, 0)[0].state, 'review');
  assert.equal(f.runner.workflow.status(j).cards.length, 1);
});

test('人工窗口占用只等待，不关闭窗口、不启动后续步骤', async () => {
  let identities = 0;
  const f = fixture({ ensureIdentity: async () => { identities++; throw fault(); }, probeNavigation: async () => ({ state: 'busy' }),
    browserManager: { owner: 'manual', closeRunner: async () => { throw new Error('不得关闭manual窗口'); } } });
  await f.runner.run(f.job.id); await f.tick();
  assert.equal(d.getJob(f.job.id).status, 'paused'); assert.equal(identities, 1);
  assert.equal(d.getJob(f.job.id).cursor.navigationRecovery.successes, 0);
});

test('普通未知异常仍正常计失败，不被页面恢复逻辑吞掉', async () => {
  const f = fixture({ ensureIdentity: async () => { throw new Error('普通适配器错误'); } }); await f.runner.run(f.job.id);
  const j = d.getJob(f.job.id); assert.equal(j.status, 'completed'); assert.equal(j.metrics.failed, 1); assert.equal(j.cursor.navigationRecovery, undefined);
});

test('错误页about:blank恢复目标回退到超话，不永久探测空白页', async () => {
  const f = fixture({ ensureIdentity: async () => { throw new NavigationUnavailableError('空白页', { navigationUrl: 'about:blank', stage: 'identity' }); } });
  await f.runner.run(f.job.id); assert.equal(d.getJob(f.job.id).cursor.navigationRecovery.url, f.topic.url);
});

test('手动暂停后编辑导致故障步骤被撤销，不自动执行旧配置', async () => {
  const f = fixture({ ensureIdentity: async () => { throw fault(); } }); await f.runner.run(f.job.id);
  f.runner.pause(f.job.id);
  const job = d.getJob(f.job.id); d.updateJob(job.id, { cursor: { ...job.cursor, configVersion: 1 } });
  f.runner.resume(job.id); await f.tick(); await f.tick();
  const changed = d.getJob(job.id); assert.equal(changed.pausedByUser, true); assert.equal(changed.cursor.navigationRecovery.state, 'cancelled');
  assert.equal(changed.metrics.failed, 0);
});

test('人工窗口就地恢复连续两次通过，不关闭上下文、不接续后台任务', async () => {
  const f = fixture({ ensureIdentity: async () => { throw fault(); }, browserManager: { owner: 'manual', closeRunner: async () => assert.fail('不得关人工窗口') } });
  await f.runner.run(f.job.id);
  f.runner.workflow.session = { jobId: f.job.id };
  await f.tick(); await f.tick();
  assert.equal(d.getJob(f.job.id).status, 'waiting'); assert.equal(d.getJob(f.job.id).cursor.navigationRecovery.state, 'recovered');
  assert.ok(f.runner.workflow.session); f.runner.workflow.session = null;
});

test('已提交故障停止后仍计待核对，不留network_review非终态', async () => {
  const f = fixture({ post: async (_a,_t,_text,o) => { o.onSubmit(); throw fault(); } });
  await f.runner.run(f.job.id); f.runner.stop(f.job.id); await until(() => d.getJob(f.job.id).status === 'stopped');
  assert.equal(d.getJob(f.job.id).metrics.uncertain, 1);
  assert.equal(f.runner.workflow.rows(f.job.id, 0)[0].state, 'review');
  assert.equal(d.listActionLogs(f.job.id)[0].state, 'uncertain');
});

test('人工会话中已提交的导航故障恢复为review，不恢复为可重发pending', async () => {
  const f = fixture();
  f.runner.workflow.ensureSteps(f.job);
  const row = f.runner.workflow.rows(f.job.id, 0)[0];
  const step = { round: row.round_index, topicId: row.topic_id, accountId: row.account_id, kind: row.kind, actionIndex: row.action_index, segmentId: row.segment_id, unitIndex: row.unit_index };
  d.createActionLog({ jobId: f.job.id, stepKey: row.step_key, kind: step.kind, accountId: step.accountId, topicId: step.topicId, state: 'submitted' });
  d.db.prepare('UPDATE task_step_state SET ever_verification=1 WHERE job_id=?').run(f.job.id);
  f.runner.workflow.session = { jobId: f.job.id };
  await f.runner.navigation.handle(fault(), f.job.id, step); await f.tick(); await f.tick();
  assert.equal(f.runner.workflow.rows(f.job.id, 0)[0].state, 'review');
  assert.equal(d.getJob(f.job.id).metrics.uncertain, 1);
  assert.equal(d.getJob(f.job.id).status, 'waiting'); f.runner.workflow.session = null;
});

test('人工未提交导航故障后关闭窗口，pending仍可继续而非无卡deferred死锁', async () => {
  const f = fixture(); f.runner.workflow.ensureSteps(f.job);
  const row = f.runner.workflow.rows(f.job.id, 0)[0];
  const step = { round: row.round_index, topicId: row.topic_id, accountId: row.account_id, kind: row.kind, actionIndex: row.action_index, segmentId: row.segment_id, unitIndex: row.unit_index };
  f.runner.workflow.session = { jobId: f.job.id }; await f.runner.navigation.handle(fault(), f.job.id, step);
  assert.equal(f.runner.workflow.rows(f.job.id, 0)[0].state, 'pending');
  f.runner.workflow.session = null;
  f.runner.adapter.post = async (_a,_t,_text,o) => { o.onSubmit(); return { state: 'succeeded' }; };
  await f.tick(); await f.tick(); await until(() => d.getJob(f.job.id).status === 'completed');
  assert.equal(d.getJob(f.job.id).metrics.success, 1);
});

test('人工会话在探测完成前已确认成功，恢复不能降级为uncertain', async () => {
  const f = fixture(); f.runner.workflow.ensureSteps(f.job);
  const row = f.runner.workflow.rows(f.job.id, 0)[0];
  const step = { round: row.round_index, topicId: row.topic_id, accountId: row.account_id, kind: row.kind, actionIndex: row.action_index, segmentId: row.segment_id, unitIndex: row.unit_index };
  d.createActionLog({ jobId: f.job.id, stepKey: row.step_key, kind: step.kind, accountId: step.accountId, topicId: step.topicId, state: 'submitted' });
  f.runner.workflow.session = { jobId: f.job.id }; await f.runner.navigation.handle(fault(), f.job.id, step);
  await f.tick(); f.runner.workflow.finishStep(f.job.id, step, 'succeeded'); await f.tick();
  assert.equal(d.listActionLogs(f.job.id)[0].state, 'succeeded'); assert.equal(d.getJob(f.job.id).metrics.success, 1);
  assert.equal(d.getJob(f.job.id).metrics.uncertain, 0); f.runner.workflow.session = null;
});

test('人工会话中恢复遇验证码后窗口关闭，仍有卡片与review归属', async () => {
  const f = fixture({ probeNavigation: async () => ({ state: 'verification' }) }); f.runner.workflow.ensureSteps(f.job);
  const row = f.runner.workflow.rows(f.job.id, 0)[0];
  const step = { round: row.round_index, topicId: row.topic_id, accountId: row.account_id, kind: row.kind, actionIndex: row.action_index, segmentId: row.segment_id, unitIndex: row.unit_index };
  d.createActionLog({ jobId: f.job.id, stepKey: row.step_key, kind: step.kind, accountId: step.accountId, topicId: step.topicId, state: 'submitted' });
  f.runner.workflow.session = { jobId: f.job.id }; await f.runner.navigation.handle(fault(), f.job.id, step); await f.tick();
  f.runner.workflow.session = null;
  assert.equal(f.runner.workflow.rows(f.job.id, 0)[0].state, 'review');
  const status = f.runner.workflow.status(d.getJob(f.job.id)); assert.equal(status.cards.length, 1); assert.equal(status.cards[0].status, 'pending');
  assert.equal(d.getJob(f.job.id).cursor.verificationBarrier, true);
});
