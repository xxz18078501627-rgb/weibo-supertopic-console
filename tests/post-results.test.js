import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const data = fs.mkdtempSync(path.join(os.tmpdir(), 'weibo-post-results-'));
process.env.WEIBO_CONSOLE_DATA_DIR = data;
process.env.WEIBO_CONSOLE_LICENSE = 'off';
process.env.WEIBO_CONSOLE_TOPIC_MODE = 'general';
process.env.WEIBO_CONSOLE_NOTIFY = 'off';
const d = await import('../src/db.js');
const { TaskRunner, buildSteps, createSnapshot } = await import('../src/runner.js');
const { WeiboAdapter, classifyPostReceipt, classifyCommentReceipt, postReadbackMatches, VerificationError, RateLimitError } = await import('../src/weibo-adapter.js');
const { defaultTaskConfig } = await import('../src/config.js');

test.beforeEach(() => { d.clearAllDataForTests(); d.setSetting('task_defaults', defaultTaskConfig); });
test.after(() => { d.db.close(); fs.rmSync(data, { recursive: true, force: true }); });

function fixture() {
  const a = d.createAccount('测试账号');
  d.updateAccountAuth(a.id, { status: 'valid', uid: '1001', nickname: '测试账号' });
  const topic = d.createTopic({ name: '苏新皓超话', url: 'https://weibo.com/p/100808fixture' });
  d.addPostMaterials(['测试正文甲', '测试正文乙']);
  const config = createSnapshot({ accountIds: [a.id], topicIds: [topic.id], actionPlan: [{ type: 'post', count: 1, intervalSeconds: 0 }], rounds: 1, postDecoration: { mode: 'number', numberPosition: 'prefix' } }, d.listAccounts(), d.listTopics());
  const job = d.createJob(config), step = buildSteps(config)[0];
  return { account: d.getAccount(a.id), topic, job, step };
}

test('提交后验证码显示待验证、不计结果，成功续发只计一次且不重发', async () => {
  const f = fixture(); let sends = 0, accept;
  const runner = new TaskRunner({ post: async (_a, _t, _c, options) => {
    sends++; options.onSubmit(); accept = options.onReceipt;
    throw new VerificationError('微博要求进行安全验证');
  } });
  runner.workflow.ensureSteps(f.job);
  try { await runner.execute(f.job, f.step, f.account, f.topic); assert.fail('应要求验证'); }
  catch (error) { assert.ok(error instanceof VerificationError); runner.workflow.defer(f.job.id, f.step, error); }
  const action = d.listActionLogs(f.job.id)[0];
  assert.equal(action.state, 'uncertain', '已提交保护状态必须保留');
  assert.equal(action.display_state, 'verification_wait');
  assert.deepEqual(d.getJob(f.job.id).metrics, { success: 0, failed: 0, uncertain: 0, skipped: 0 });
  const { recordView } = await import('../src/record-view.js');
  const { dailyStats, startRound, finishRound, listRoundReports } = await import('../src/task-reports.js');
  const { shanghaiDate } = await import('../src/util.js');
  startRound(f.job.id, 0);
  const view = recordView(shanghaiDate(), { flow: true });
  assert.equal(view.uncertain.length, 0);
  assert.equal(view.counts.post.uncertain, 0);
  assert.equal(view.jobCounts[f.job.id].uncertain, 0);
  assert.equal(view.details.find(row => row.id === action.id).display_state, 'verification_wait');
  assert.equal(dailyStats().counts.post.uncertain, 0);
  assert.equal(listRoundReports(f.job.id)[0].counts.post.uncertain, 0);
  assert.equal(listRoundReports(f.job.id)[0].verification.uncertain, 0);
  finishRound(f.job.id, 0, 'stopped');
  const savedRound = d.db.prepare('SELECT * FROM task_rounds WHERE job_id=?').get(f.job.id);
  const oldSummary = JSON.parse(savedRound.summary_json); delete oldSummary.resultStateVersion;
  oldSummary.counts.post.uncertain = 1;
  d.db.prepare('UPDATE task_rounds SET summary_json=? WHERE job_id=?').run(JSON.stringify(oldSummary), f.job.id);
  assert.equal(listRoundReports(f.job.id)[0].counts.post.uncertain, 0, '旧轮次缓存也不计待验证');
  assert.equal(listRoundReports(f.job.id)[0].completedAt, savedRound.completed_at);
  const restored = new TaskRunner({ post: async () => { throw Error('不能补发'); } });
  restored.workflow.recover(f.job.id);
  assert.equal(d.getJob(f.job.id).metrics.uncertain, 0);
  await accept({ state: 'succeeded', successSource: 'page_notice' });
  await accept({ state: 'succeeded', successSource: 'page_notice' });
  assert.equal(d.getJob(f.job.id).metrics.success, 1);
  assert.equal(d.getJob(f.job.id).metrics.uncertain, 0);
  assert.equal(d.listActionLogs(f.job.id)[0].display_state, 'succeeded');
  assert.equal(listRoundReports(f.job.id)[0].counts.post.succeeded, 1);
  assert.equal(sends, 1);
});

test('混合签到验证卡不影响发帖待验证，步骤归档后仍保留状态', async () => {
  const f = fixture(), runner = new TaskRunner({}); runner.workflow.ensureSteps(f.job);
  const row = runner.workflow.row(f.job.id, f.step);
  const id = d.createActionLog({ jobId: f.job.id, stepKey: row.step_key, kind: 'post', accountId: f.account.id, topicId: f.topic.id, state: 'uncertain' });
  runner.workflow.defer(f.job.id, f.step, new VerificationError('微博要求进行安全验证'));
  d.db.prepare("UPDATE verification_cards SET source='checkin_unconfirmed' WHERE job_id=?").run(f.job.id);
  assert.equal(d.listActionLogs(f.job.id)[0].display_state, 'verification_wait');
  assert.equal(d.getJob(f.job.id).metrics.uncertain, 0);
  d.db.prepare('DELETE FROM task_step_state WHERE job_id=?').run(f.job.id);
  assert.equal(d.listActionLogs(f.job.id)[0].display_state, 'verification_wait');
  const { shanghaiDate } = await import('../src/util.js');
  assert.equal(d.countActionsByJob(shanghaiDate())[f.job.id].uncertain, 0);
  assert.equal(d.getActionLog(id).state, 'uncertain');
});

test('普通提交中断重启后仍为待核对，不冒充验证码', () => {
  const f = fixture(), runner = new TaskRunner({}); runner.workflow.ensureSteps(f.job);
  const row = runner.workflow.row(f.job.id, f.step);
  d.createActionLog({ jobId: f.job.id, stepKey: row.step_key, kind: 'post', accountId: f.account.id, topicId: f.topic.id, state: 'submitted' });
  d.db.prepare("UPDATE task_step_state SET state='running' WHERE job_id=?").run(f.job.id);
  runner.workflow.recover(f.job.id);
  assert.equal(d.listActionLogs(f.job.id)[0].display_state, 'uncertain');
  assert.equal(d.getJob(f.job.id).metrics.uncertain, 1);
});

test('旧验证码记录按证据迁移一次，已通过和普通未知记录不误改', async () => {
  const records = [], base = fixture();
  for (const [passed, message] of [[false, '微博要求进行安全验证'], [true, '微博要求进行安全验证'], [null, '网络中断'], [false, '微博要求安全验证（回执验证字段）'], [false, 'Please verify your account']]) {
    const f = { ...base, job: d.createJob(base.job.config) }, runner = new TaskRunner({}); runner.workflow.ensureSteps(f.job);
    const row = runner.workflow.row(f.job.id, f.step);
    const id = d.createActionLog({ jobId: f.job.id, stepKey: row.step_key, kind: 'post', accountId: f.account.id, topicId: f.topic.id, state: 'uncertain', error: message });
    if (passed !== null) runner.workflow.defer(f.job.id, f.step, new VerificationError(message));
    if (passed) runner.workflow.markReady(f.job.id, 0, row.identity);
    d.db.prepare('UPDATE action_logs SET verification_pending=0 WHERE id=?').run(id);
    records.push(id);
  }
  d.db.prepare("DELETE FROM settings WHERE key='verification_pending_v1'").run();
  const { migrateVerificationPending } = await import('../src/result-state.js');
  migrateVerificationPending(d.db); migrateVerificationPending(d.db);
  assert.deepEqual(records.map(id => d.getActionLog(id).verification_pending), [1, 0, 0, 1, 1]);
  assert.ok(records.every(id => d.getActionLog(id).state === 'uncertain'));
});

test('验证通过但发布证据不足仍不算成功，普通未知结果继续待核对', async () => {
  const f = fixture(), runner = new TaskRunner({}); runner.workflow.ensureSteps(f.job);
  const row = runner.workflow.row(f.job.id, f.step);
  const id = d.createActionLog({ jobId: f.job.id, stepKey: row.step_key, kind: 'post', accountId: f.account.id, topicId: f.topic.id, state: 'uncertain' });
  runner.workflow.defer(f.job.id, f.step, new VerificationError('安全验证'));
  assert.equal(d.getJob(f.job.id).metrics.uncertain, 0);
  runner.workflow.markReady(f.job.id, 0, row.identity);
  assert.equal(d.getActionLog(id).state, 'uncertain');
  assert.equal(d.listActionLogs(f.job.id)[0].display_state, 'uncertain');
  assert.equal(d.getJob(f.job.id).metrics.success, 0);
  assert.equal(d.getJob(f.job.id).metrics.uncertain, 1);
});

test('已取得成功回执的发帖不会被后续普通/验证/限制异常降级', async () => {
  for (const error of [new Error('页面后续异常'), new VerificationError('延迟出现的验证码'), new RateLimitError('页面旧频繁提示', 'post', true)]) {
    d.clearAllDataForTests(); d.setSetting('task_defaults', defaultTaskConfig);
    const f = fixture();
    const runner = new TaskRunner({ post: async (_a, _t, _c, options) => {
      options.onSubmit();
      await options.onReceipt({ state: 'succeeded', receiptId: '5359362629435909', receiptUrl: 'https://weibo.com/detail/5359362629435909' });
      throw error;
    } });
    runner.workflow.ensureSteps(f.job);
    const result = await runner.execute(f.job, f.step, f.account, f.topic);
    assert.equal(result.state, 'succeeded');
    const action = d.getStepAction(f.job.id, d.db.prepare('SELECT step_key FROM task_step_state WHERE job_id=?').get(f.job.id).step_key);
    assert.equal(action.state, 'succeeded');
    assert.equal(action.sequence_confirmed, 1);
    assert.equal(d.listActiveAccountRestrictions().length, 0);
  }
});

test('日常发帖超时不再自动翻列表，保持待核对且不重发', async () => {
  const f = fixture(); let lookups = 0, sends = 0;
  const runner = new TaskRunner({
    post: async (_a, _t, _c, options) => { sends++; options.onSubmit(); return { state: 'uncertain', reason: '未收到明确发布结果' }; },
    findPublishedPost: async () => { lookups++; return { state: 'succeeded', receiptId: '5359362629435909' }; }
  });
  runner.workflow.ensureSteps(f.job);
  assert.equal((await runner.execute(f.job, f.step, f.account, f.topic)).state, 'uncertain');
  assert.equal((await runner.execute(f.job, f.step, f.account, f.topic)).state, 'uncertain');
  assert.equal(d.listActionLogs(f.job.id)[0].state, 'uncertain');
  assert.equal(lookups, 0); assert.equal(sends, 1);
});

test('发帖明确业务成功可无编号，但评论仍要求编号', () => {
  for (const payload of [{ ok: 1 }, { success: true }, { code: '100000' }, { data: { ok: 1 } }]) {
    assert.equal(classifyPostReceipt(payload).kind, 'succeeded');
    assert.equal(classifyCommentReceipt(payload).kind, 'unknown');
  }
  for (const payload of [{}, { status: 200 }, { ok: 0, msg: '发送失败' }, { ok: 1, validate: { challenge: 'fixture' } }]) {
    assert.notEqual(classifyPostReceipt(payload).kind, 'succeeded');
  }
  for (const payload of [{ ok: '0', msg: '发送失败', data: { idstr: '5359362629435909' } },
    { data: { success: false, idstr: '5359362629435909' } }, { data: { ok: false, idstr: '5359362629435909' } }]) {
    assert.notEqual(classifyPostReceipt(payload).kind, 'succeeded');
  }
});

test('页面成功无编号正常保存来源、计数，重启不补发', async () => {
  const f = fixture(); let sends = 0;
  const runner = new TaskRunner({ post: async (_a, _t, _c, options) => {
    sends++; options.onSubmit(); await options.onReceipt({ state: 'succeeded', successSource: 'page_notice', receiptId: null, receiptUrl: null, url: null });
    return { state: 'succeeded', successSource: 'page_notice', receiptId: null, receiptUrl: null, url: null };
  } });
  runner.workflow.ensureSteps(f.job);
  const result = await runner.execute(f.job, f.step, f.account, f.topic);
  assert.equal(result.state, 'succeeded');
  runner.workflow.finishStep(f.job.id, f.step, result.state);
  assert.equal(d.getJob(f.job.id).metrics.success, 1);
  const stored = d.listActionLogs(f.job.id)[0];
  assert.equal(stored.success_source, 'page_notice'); assert.equal(stored.receipt_id, null); assert.equal(stored.url, null);
  const restored = new TaskRunner({ post: async () => { throw Error('不能补发'); } });
  assert.equal((await restored.execute(d.getJob(f.job.id), f.step, f.account, f.topic)).state, 'succeeded');
  assert.equal(sends, 1);
});

test('成功的发帖操作在数据库与步骤结算两层均不可降级', () => {
  const f = fixture(), runner = new TaskRunner({}); runner.workflow.ensureSteps(f.job);
  const key = d.db.prepare('SELECT step_key FROM task_step_state WHERE job_id=?').get(f.job.id).step_key;
  const actionId = d.createActionLog({ jobId: f.job.id, stepKey: key, kind: 'post', accountId: f.account.id, topicId: f.topic.id, state: 'succeeded', receiptId: '5359362629435909' });
  d.updateActionLog(actionId, { state: 'failed', error: '过期失败结果' });
  assert.equal(d.getActionLog(actionId).state, 'succeeded');
  runner.workflow.finishStep(f.job.id, f.step, 'uncertain', '过期未知结果');
  assert.equal(runner.workflow.row(f.job.id, f.step).outcome, 'succeeded');
  assert.equal(d.getJob(f.job.id).metrics.failed, 0);
});

test('只读匹配要求正文完整一致，不能把包含相同片段的另一篇帖子算成功', () => {
  const post = { idstr: '5359362629435909', user: { idstr: '1001' }, text_raw: '苏新皓[超话] 原正文还有其他文字' };
  assert.equal(postReadbackMatches(post, { receiptId: post.idstr, uid: '1001', content: '原正文', topicName: '苏新皓超话' }), false);
});

test('旧attempt回调不能修改新的发帖尝试', () => {
  const f = fixture();
  const actionId = d.createActionLog({ jobId: f.job.id, stepKey: 'attempt-test', kind: 'post', accountId: f.account.id, topicId: f.topic.id, state: 'prepared' });
  d.beginPostAttempt(actionId, 'first');
  d.updateActionLog(actionId, { state: 'prepared', attemptId: 'first' });
  d.beginPostAttempt(actionId, 'second');
  d.updateActionLog(actionId, { state: 'succeeded', receiptId: '5359362629435909', attemptId: 'first' });
  assert.equal(d.getActionLog(actionId).state, 'prepared');
  d.updateActionLog(actionId, { state: 'succeeded', receiptId: '5359362629435909', attemptId: 'second' });
  assert.equal(d.getActionLog(actionId).state, 'succeeded');
});

test('历史修正保留日期、刷新已结束轮次报告并幂等计数', async () => {
  const { startRound, finishRound, listRoundReports, dailySuccess } = await import('../src/task-reports.js');
  const f = fixture(), runner = new TaskRunner({}); runner.workflow.ensureSteps(f.job);
  startRound(f.job.id, 0);
  runner.workflow.finishStep(f.job.id, f.step, 'failed', '微博回执明确表示发帖未被接受');
  const action = d.listActionLogs(f.job.id)[0];
  const original = '2026-10-31T03:00:00.000Z';
  d.db.prepare('UPDATE action_logs SET started_at=?,completed_at=? WHERE id=?').run(original, original, action.id);
  finishRound(f.job.id, 0);
  d.updateJob(f.job.id, { status: 'completed' });
  const found = { state: 'succeeded', receiptId: '5359362629435909', receiptUrl: 'https://weibo.com/detail/5359362629435909', url: 'https://weibo.com/detail/5359362629435909' };
  runner.repairPostResult(d.getActionLog(action.id), found);
  runner.repairPostResult(d.getActionLog(action.id), found);
  assert.equal(d.getActionLog(action.id).completed_at, original);
  assert.equal(d.getJob(f.job.id).status, 'completed');
  assert.equal(d.getJob(f.job.id).metrics.success, 1);
  assert.equal(d.getJob(f.job.id).metrics.failed, 0);
  assert.equal(listRoundReports(f.job.id)[0].counts.post.succeeded, 1);
  assert.equal(listRoundReports(f.job.id)[0].counts.post.failed, 0);
  assert.equal(dailySuccess('2026-10-31').post, 1);
  const audit = d.db.prepare('SELECT * FROM post_result_repairs WHERE action_id=?').all(action.id);
  assert.equal(audit.length, 1);
  assert.equal(audit[0].original_error, '微博回执明确表示发帖未被接受');
});

test('历史事务发生错误时动作与步骤同时回滚', () => {
  const f = fixture(), runner = new TaskRunner({}); runner.workflow.ensureSteps(f.job);
  runner.workflow.finishStep(f.job.id, f.step, 'failed', '原失败');
  const action = d.listActionLogs(f.job.id)[0];
  d.db.exec("CREATE TEMP TRIGGER reject_post_repair BEFORE UPDATE ON task_step_state WHEN NEW.outcome='succeeded' BEGIN SELECT RAISE(ABORT,'fixture rejection'); END");
  try {
    assert.throws(() => runner.repairPostResult(action, { state: 'succeeded', receiptId: '5359362629435909' }), /fixture rejection/);
    assert.equal(d.getActionLog(action.id).state, 'failed');
    assert.equal(runner.workflow.row(f.job.id, f.step).outcome, 'failed');
  } finally { d.db.exec('DROP TRIGGER reject_post_repair'); }
});

test('历史核对只纳入回执失败，默认不修正failed且可重复执行', async () => {
  const f = fixture(); let lookups = 0;
  const runner = new TaskRunner({ findPublishedPost: async () => { lookups++; return { state: 'succeeded', receiptId: '5359362629435909', url: 'https://weibo.com/detail/5359362629435909' }; } });
  runner.workflow.ensureSteps(f.job);
  runner.workflow.finishStep(f.job.id, f.step, 'failed', '微博回执明确表示发帖未被接受');
  d.createActionLog({ jobId: f.job.id, stepKey: 'unsubmitted', kind: 'post', accountId: f.account.id, topicId: f.topic.id, state: 'failed', error: '未发送' });
  d.updateJob(f.job.id, { status: 'completed' });
  assert.equal((await runner.repairUncertainPosts(f.job.id)).results.length, 0);
  const first = await runner.repairUncertainPosts(f.job.id, { includeReceiptFailures: true });
  assert.equal(first.results.length, 1); assert.equal(first.results[0].state, 'succeeded');
  assert.equal((await runner.repairUncertainPosts(f.job.id, { includeReceiptFailures: true })).results.length, 0);
  assert.equal(lookups, 1);
});

test('同一帖子落入两条历史操作的时间窗口时不得认领', () => {
  const f = fixture(), runner = new TaskRunner({});
  const stamp = new Date().toISOString(), actions = [];
  for (const stepKey of ['one', 'two']) {
    const actionId = d.createActionLog({ jobId: f.job.id, stepKey, kind: 'post', accountId: f.account.id, topicId: f.topic.id, state: 'failed', content: '完全相同正文' });
    d.db.prepare('UPDATE action_logs SET started_at=?,completed_at=? WHERE id=?').run(stamp, stamp, actionId);
    actions.push(d.getActionLog(actionId));
  }
  assert.equal(runner.postClaimIsUnique(actions[0], { receiptId: '5359362629435909', createdAt: stamp }), false);
});

test('主页兜底搜索排除旧帖、错误作者和缺少时间的候选', async () => {
  const submittedAt = '2026-11-01T12:00:00.000Z';
  const base = { idstr: '5359362629435909', user: { idstr: '1001' }, text_raw: '苏新皓[超话]完整正文', created_at: submittedAt };
  let posts = [
    { ...base, idstr: '5359362629435914', created_at: '2026-11-01T11:59:50.000Z' },
    { ...base, idstr: '5359362629435910', created_at: '2026-10-31T12:00:00.000Z' },
    { ...base, idstr: '5359362629435911', created_at: undefined },
    { ...base, idstr: '5359362629435912', user: { idstr: '1002' } }
  ];
  const adapter = new WeiboAdapter({ page: async () => ({ evaluate: async () => ({ data: { list: posts } }) }) });
  adapter.ensureIdentity = async () => {};
  const args = { content: '完整正文', topicName: '苏新皓超话', submittedAt, pages: 1 };
  assert.equal((await adapter.findUniqueRecentPost({ uid: '1001' }, args)).state, 'uncertain');
  posts.push(base);
  const found = await adapter.findUniqueRecentPost({ uid: '1001' }, args);
  assert.equal(found.state, 'succeeded'); assert.equal(found.receiptId, base.idstr);
  posts.push({ ...base, idstr: '5359362629435913' });
  assert.equal((await adapter.findUniqueRecentPost({ uid: '1001' }, args)).state, 'uncertain');
});

test('验证码分流晚于成功回执时不创建待验证卡或降级步骤', () => {
  const f = fixture(), runner = new TaskRunner({}); runner.workflow.ensureSteps(f.job);
  const key = runner.workflow.rows(f.job.id, 0)[0].step_key;
  d.createActionLog({ jobId: f.job.id, stepKey: key, kind: 'post', accountId: f.account.id, topicId: f.topic.id, state: 'succeeded', receiptId: '5359362629435909' });
  runner.workflow.defer(f.job.id, f.step, new VerificationError('迟到的验证异常'));
  assert.equal(runner.workflow.row(f.job.id, f.step).outcome, 'succeeded');
  assert.equal(d.getJob(f.job.id).metrics.success, 1);
  assert.equal(d.db.prepare('SELECT COUNT(*) n FROM verification_cards WHERE job_id=?').get(f.job.id).n, 0);
});

test('历史明细清理后以汇总差量修复，不丢失已归档成功计数', async () => {
  const { startRound, finishRound, listRoundReports } = await import('../src/task-reports.js');
  const f = fixture(), runner = new TaskRunner({}); runner.workflow.ensureSteps(f.job); startRound(f.job.id, 0);
  runner.workflow.finishStep(f.job.id, f.step, 'uncertain', '历史未知');
  const action = d.listActionLogs(f.job.id)[0];
  d.createActionLog({ jobId: f.job.id, stepKey: '0:archived', kind: 'post', accountId: f.account.id, topicId: f.topic.id, state: 'succeeded' });
  finishRound(f.job.id, 0);
  d.updateJob(f.job.id, { status: 'completed', metrics: { success: 1, failed: 0, uncertain: 1, skipped: 0 } });
  d.db.prepare('DELETE FROM action_logs WHERE job_id=? AND state=?').run(f.job.id, 'succeeded');
  d.db.prepare('DELETE FROM task_step_state WHERE job_id=?').run(f.job.id);
  runner.repairPostResult(action, { state: 'succeeded', receiptId: '5359362629435909' });
  assert.equal(d.getJob(f.job.id).metrics.success, 2);
  assert.equal(d.getJob(f.job.id).metrics.uncertain, 0);
  const counts = listRoundReports(f.job.id)[0].counts.post;
  assert.equal(counts.succeeded, 2); assert.equal(counts.uncertain, 0);
  assert.equal(listRoundReports(f.job.id, true)[0].accounts[0].counts.post.succeeded, 2);
  d.db.prepare("UPDATE task_rounds SET status='stopped' WHERE job_id=?").run(f.job.id);
  assert.equal(listRoundReports(f.job.id)[0].counts.post.succeeded, 2);
  assert.equal(listRoundReports(f.job.id, true)[0].accounts[0].counts.post.succeeded, 2);
});
