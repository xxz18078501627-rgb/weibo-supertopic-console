import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const data = fs.mkdtempSync(path.join(os.tmpdir(), 'weibo-verification-'));
process.env.WEIBO_CONSOLE_DATA_DIR = data;
process.env.WEIBO_CONSOLE_LICENSE = 'off';
process.env.WEIBO_CONSOLE_TOPIC_MODE = 'general';
process.env.WEIBO_CONSOLE_NOTIFY = 'off';
const database = await import('../src/db.js');
const { db, clearAllDataForTests, createAccount, updateAccountAuth, createTopic, addPostMaterials, addOriginalMaterials, addCommentMaterials, getJob, getStepAction, listAccounts, listTopics, createJob, listActionLogs, setSetting, updateJob } = database;
const { TaskRunner, buildSteps, createSnapshot } = await import('../src/runner.js');
const { VerificationError, RateLimitError, UnsupportedPageError } = await import('../src/weibo-adapter.js');
const { listRoundReports } = await import('../src/task-reports.js');
const { defaultTaskConfig } = await import('../src/config.js');
const { BrowserManager } = await import('../src/browser.js');
const { AccountLeases } = await import('../src/account-leases.js');
const { WeiboAdapter, weiboShortIdToNumeric } = await import('../src/weibo-adapter.js');
const { chromium } = await import('playwright');

test.beforeEach(() => { process.env.WEIBO_CONSOLE_NOTIFY = 'off'; clearAllDataForTests(); setSetting('task_defaults', defaultTaskConfig); });
test.after(async () => {
  await new Promise(resolve => setTimeout(resolve, 300));
  try { db.close(); } catch {}
  try { fs.rmSync(data, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); } catch {}
});
async function until(predicate, ms = 4000) { const end = Date.now() + ms; while (!predicate()) { if (Date.now() > end) throw Error('等待验证工作流超时'); await new Promise(resolve => setTimeout(resolve, 10)); } }

function fixture(plan, options = {}) {
  const accounts = ['A','B'].map((name, index) => { const account = createAccount(name); return updateAccountAuth(account.id, { status: 'valid', uid: String(1001 + index), nickname: name }); });
  const topics = [createTopic({ name: '主题', url: 'https://example.test/topic' })];
  addPostMaterials(['发帖原文', '发帖原文二']); addOriginalMaterials(['原创甲', '原创乙']); addCommentMaterials(['评论甲', '评论乙']);
  const snapshot = createSnapshot({ accountIds: accounts.map(a => a.id), topicIds: topics.map(t => t.id), actionPlan: plan.map(item => ({ ...item, intervalSeconds: 0 })), roundIntervalSeconds: 0, candidateRefreshSeconds: 0, ...options }, listAccounts(), listTopics());
  return { accounts, topics, job: createJob(snapshot) };
}

function candidates() {
  let n = 0;
  return { collectCandidates: async () => [{ id: `R${++n}`, url: `https://example.test/900/R${n}`, authorUid: '900', commentCount: 0 }], inspectCandidate: async (_account, candidate) => ({ ...candidate, commentCount: 0 }) };
}

test('新快照按操作段遍历账号，旧快照保留账号优先顺序', () => {
  const base = { rounds: 1, topicIds: ['T'], accountIds: ['A','B'], actionPlan: [{ type: 'comment', count: 2 }, { type: 'post', count: 1 }] };
  const format = steps => steps.map(step => `${step.accountId}:${step.kind}:${step.unitIndex}`);
  assert.deepEqual(format(buildSteps({ ...base, schedulerVersion: 2 })), ['A:comment:0','A:comment:1','B:comment:0','B:comment:1','A:post:0','B:post:0']);
  assert.deepEqual(format(buildSteps(base)), ['A:comment:0','A:comment:1','A:post:0','B:comment:0','B:comment:1','B:post:0']);
});

test('工作台同一账号连续评论复用浏览器上下文，整组只释放一次', async () => {
  const account = updateAccountAuth(createAccount('连续评论账号').id, { status: 'valid', uid: '2301', nickname: '连续评论账号' });
  const topic = createTopic({ name: '连续评论超话', url: 'https://weibo.com/p/100808comments' });
  addCommentMaterials(['评论甲', '评论乙']);
  const snapshot = createSnapshot({ accountIds: [account.id], topicIds: [topic.id],
    actionPlan: [{ type: 'comment', count: 3, intervalSeconds: 0 }], roundIntervalSeconds: 0,
    candidateRefreshSeconds: 0 }, listAccounts(), listTopics());
  const job = createJob(snapshot);
  let comments = 0, closes = 0, contextOpen = false, runner;
  const manager = { generation: 1, get context() { return contextOpen ? {} : null; },
    closeRunner: async () => { if (contextOpen) { contextOpen = false; closes += 1; } } };
  runner = new TaskRunner({ ...candidates(), ensureIdentity: async () => { contextOpen = true; return { uid: account.uid }; },
    comment: async (_account, candidate, _content, options) => {
      comments += 1; options.onSubmit(); return { state: 'succeeded', url: candidate.url };
    }, browserManager: manager }, { scope: 'workbench', leases: new AccountLeases() });
  await runner.run(job.id);
  assert.equal(comments, 3);
  assert.equal(getJob(job.id).metrics.success, 3);
  assert.equal(closes, 1, '连续三条评论应只关闭一次浏览器');
  assert.equal(runner.workbenchCommentSession, null);
});

test('工作台评论会话在账号、超话、轮次或操作类型变化时立即释放', async () => {
  const accounts = ['甲','乙'].map((name, index) => updateAccountAuth(createAccount(name).id,
    { status: 'valid', uid: String(2401 + index), nickname: name }));
  const topic = createTopic({ name: '边界超话', url: 'https://weibo.com/p/100808boundary' });
  addCommentMaterials(['评论甲', '评论乙']);
  const snapshot = createSnapshot({ accountIds: accounts.map(item => item.id), topicIds: [topic.id],
    actionPlan: [{ type: 'comment', count: 2, intervalSeconds: 0 }, { type: 'post', count: 1, intervalSeconds: 0 }],
    roundIntervalSeconds: 0, candidateRefreshSeconds: 0 }, listAccounts(), listTopics());
  const job = createJob(snapshot);
  const steps = buildSteps(job.config);
  const firstAccountComments = steps.filter(step => step.accountId === accounts[0].id && step.kind === 'comment');
  const otherAccountComment = steps.find(step => step.accountId === accounts[1].id && step.kind === 'comment');
  const postStep = steps.find(step => step.kind === 'post');
  let closes = 0;
  const leases = new AccountLeases();
  const manager = { generation: 1, closeRunner: async () => { closes += 1; } };
  const runner = new TaskRunner({ ensureIdentity: async () => ({}), browserManager: manager },
    { scope: 'workbench', leases });
  await runner.withAccountLease(job, accounts[0], async () => {}, { step: firstAccountComments[0] });
  await runner.withAccountLease(job, accounts[0], async () => {}, { step: firstAccountComments[1] });
  assert.equal(closes, 0);
  await runner.withAccountLease(job, accounts[1], async () => {}, { step: otherAccountComment });
  assert.equal(closes, 1, '切换账号必须关闭上一账号上下文');
  await runner.withAccountLease(job, accounts[1], async () => {}, { step: { ...otherAccountComment, round: 1 } });
  assert.equal(closes, 2, '轮次变化必须关闭上下文');
  await runner.withAccountLease(job, accounts[1], async () => {}, { step: postStep });
  assert.equal(closes, 4, '切换评论到发帖必须关闭评论会话，发帖步骤本身仍按原生命周期关闭');
  assert.equal(leases.owners.size, 0);
});

test('工作台评论等待候选刷新时保持同一浏览器上下文', async () => {
  const account = updateAccountAuth(createAccount('等待评论账号').id, { status: 'valid', uid: '2403', nickname: '等待评论账号' });
  const topic = createTopic({ name: '等待评论超话', url: 'https://weibo.com/p/100808waiting' });
  addCommentMaterials(['评论甲', '评论乙']);
  const snapshot = createSnapshot({ accountIds: [account.id], topicIds: [topic.id],
    actionPlan: [{ type: 'comment', count: 1, intervalSeconds: 0 }], roundIntervalSeconds: 0,
    candidateRefreshSeconds: 0 }, listAccounts(), listTopics());
  const job = createJob(snapshot);
  let scans = 0, opens = 0, closes = 0, contextOpen = false;
  const manager = { generation: 1, get context() { return contextOpen ? {} : null; },
    closeRunner: async () => { if (contextOpen) { contextOpen = false; closes += 1; } } };
  const runner = new TaskRunner({
    ensureIdentity: async () => { if (!contextOpen) { contextOpen = true; opens += 1; } return { uid: account.uid }; },
    collectCandidates: async () => {
      scans += 1;
      return scans === 1 ? [] : [{ id: 'Rwait', url: 'https://weibo.com/900/Rwait', authorUid: '900', commentCount: 0 }];
    },
    inspectCandidate: async (_account, candidate) => ({ ...candidate, commentCount: 0 }),
    comment: async (_account, candidate, _content, options) => {
      options.onSubmit(); return { state: 'succeeded', url: candidate.url };
    }, browserManager: manager
  }, { scope: 'workbench', leases: new AccountLeases() });
  await runner.run(job.id);
  assert.ok(scans >= 2);
  assert.equal(getJob(job.id).metrics.success, 1);
  assert.equal(opens, 1, '等待刷新不得重新打开浏览器');
  assert.equal(closes, 1, '评论完成后只释放一次');
});

test('复用评论会话时在当前超话页刷新而不是重新打开浏览器', async () => {
  const account = updateAccountAuth(createAccount('评论刷新账号').id, { status: 'valid', uid: '2404', nickname: '评论刷新账号' });
  const topic = createTopic({ name: '刷新超话', url: 'https://weibo.com/p/100808fixture' });
  const profile = fs.mkdtempSync(path.join(data, 'comment-refresh-'));
  let documents = 0;
  const manager = new BrowserManager(async ({ options }) => {
    const context = await chromium.launchPersistentContext(profile, { ...options, headless: true });
    await context.route('**/*', route => {
      const url = new URL(route.request().url());
      if (url.hostname !== 'weibo.com') return route.abort();
      documents += 1;
      return route.fulfill({ contentType: 'text/html; charset=utf-8', body: `
        <script>window.$CONFIG={uid:'2404',user:{screen_name:'fixture'}};</script>
        <div class="chaohua-tab-wrap"><button>超like</button><div class="woo-box-item-inlineBlock cur">超like</div></div>
        <button>最新发帖</button>
        <article><a href="/900/Rrefresh">帖子</a><a href="/p/100808fixture">超话</a><footer>转发 评论 赞</footer></article>` });
    });
    return context;
  }, { headless: true, activate: async () => {} });
  try {
    const adapter = new WeiboAdapter(manager);
    const first = await adapter.collectCandidates(account, topic, { section: '超like', limit: 1, refreshTopicPage: true });
    const second = await adapter.collectCandidates(account, topic, { section: '超like', limit: 1, refreshTopicPage: true });
    assert.equal(first[0].id, 'Rrefresh');
    assert.equal(second[0].id, 'Rrefresh');
    assert.equal(documents, 2, '第二次应刷新当前超话页面，不重新创建页面');
  } finally { await manager.close(); }
});

test('工作台评论遇到验证或网络中断时立即释放会话和账号租约', async () => {
  const account = updateAccountAuth(createAccount('评论中断账号').id, { status: 'valid', uid: '2405', nickname: '评论中断账号' });
  const topic = createTopic({ name: '中断超话', url: 'https://weibo.com/p/100808interrupt' });
  addCommentMaterials(['评论甲', '评论乙']);
  const snapshot = createSnapshot({ accountIds: [account.id], topicIds: [topic.id],
    actionPlan: [{ type: 'comment', count: 1, intervalSeconds: 0 }], roundIntervalSeconds: 0,
    candidateRefreshSeconds: 0 }, listAccounts(), listTopics());
  const job = createJob(snapshot);
  const step = buildSteps(job.config).find(item => item.kind === 'comment');
  let closes = 0, contextOpen = false;
  const leases = new AccountLeases();
  const manager = { generation: 1, get context() { return contextOpen ? {} : null; },
    closeRunner: async () => { if (contextOpen) { contextOpen = false; closes += 1; } } };
  const runner = new TaskRunner({ ensureIdentity: async () => { contextOpen = true; return {}; },
    browserManager: manager }, { scope: 'workbench', leases });
  runner.workflow.ensureSteps(job);
  await runner.withAccountLease(job, account, async () => { contextOpen = true; }, { step });
  const row = runner.workflow.rows(job.id, step.round).find(item => item.step_key === `${step.round}:${step.topicId}:${step.accountId}:${step.segmentId || step.actionIndex}:${step.unitIndex}`);
  await runner.maybeReleaseWorkbenchCommentSession(job.id, row, 'verification');
  assert.equal(closes, 1);
  assert.equal(leases.owners.size, 0);
  assert.equal(runner.workbenchCommentSession, null);
});

test('工作台评论会话期间后台网络探测不关闭复用浏览器', async () => {
  const account = updateAccountAuth(createAccount('探测评论账号').id, { status: 'valid', uid: '2406', nickname: '探测评论账号' });
  const topic = createTopic({ name: '探测超话', url: 'https://weibo.com/p/100808probe' });
  addCommentMaterials(['评论甲', '评论乙']);
  const snapshot = createSnapshot({ accountIds: [account.id], topicIds: [topic.id],
    actionPlan: [{ type: 'comment', count: 1, intervalSeconds: 0 }], roundIntervalSeconds: 0,
    candidateRefreshSeconds: 0 }, listAccounts(), listTopics());
  const job = createJob(snapshot);
  const step = buildSteps(job.config).find(item => item.kind === 'comment');
  let closes = 0, probes = 0, contextOpen = false;
  const manager = { generation: 1, get context() { return contextOpen ? {} : null; },
    closeRunner: async () => { if (contextOpen) { contextOpen = false; closes += 1; } } };
  const runner = new TaskRunner({
    ensureIdentity: async () => { contextOpen = true; return {}; },
    probeConnectivity: async () => { probes += 1; return { state: 'online', contextGeneration: 1 }; },
    browserManager: manager
  }, { scope: 'workbench', leases: new AccountLeases() });
  await runner.withAccountLease(job, account, async () => { contextOpen = true; }, { step });
  await runner.network.monitor(job);
  assert.equal(probes, 0, '评论会话占用期间应跳过后台探测');
  assert.equal(closes, 0);
  assert.equal(contextOpen, true);
  await runner.releaseWorkbenchCommentSession('测试结束');
  assert.equal(closes, 1);
});

test('工作台原创仅任务不选超话也能按账号次数执行', async () => {
  const account = updateAccountAuth(createAccount('原创任务账号').id, { status: 'valid', uid: '2409', nickname: '原创任务账号' });
  addOriginalMaterials(['原创甲', '原创乙']);
  const snapshot = createSnapshot({ accountIds: [account.id], topicIds: [],
    actionPlan: [{ type: 'original', count: 2, intervalSeconds: 0 }], roundIntervalSeconds: 0,
    candidateRefreshSeconds: 0 }, listAccounts(), listTopics());
  const job = createJob(snapshot);
  let sends = 0, closes = 0, contextOpen = false;
  const manager = { generation: 1, get context() { return contextOpen ? {} : null; },
    closeRunner: async () => { if (contextOpen) { contextOpen = false; closes += 1; } } };
  const runner = new TaskRunner({
    ensureIdentity: async () => { contextOpen = true; return { uid: account.uid }; },
    openPostHome: async () => ({}),
    originalPost: async (_account, _text, options) => {
      sends += 1; options.onSubmit(); return { state: 'succeeded', receiptId: '5359362629436099' };
    }, browserManager: manager
  }, { scope: 'workbench', leases: new AccountLeases() });
  await runner.run(job.id);
  assert.equal(sends, 2);
  assert.equal(getJob(job.id).metrics.success, 2);
  assert.equal(closes, 2, '原创按独立步骤保持发帖原有开合规则');
});

test('发帖与评论卡片初始已有验证码，解除后执行原类型且不混做签到', async () => {
  for (const kind of ['post', 'comment']) {
    clearAllDataForTests(); setSetting('task_defaults', defaultTaskConfig);
    const { accounts, job } = fixture([{ type: kind, count: 1 }, { type: 'checkin', count: 1 }]);
    let manual = false, blocked = true, challenge = true;
    const calls = [];
    const action = type => async (account, _target, _text, options) => {
      calls.push(`${manual ? 'manual' : 'background'}:${type}:${account.uid}`);
      if (account.id === accounts[0].id && blocked) throw new VerificationError(`${type}验证码`);
      options?.onSubmit?.(); return { state: 'succeeded' };
    };
    const runner = new TaskRunner({ ...candidates(), ensureIdentity: async () => ({}),
      post: action('post'), comment: action('comment'),
      checkin: async account => { calls.push(`${manual ? 'manual' : 'background'}:checkin:${account.uid}`); if (account.id === accounts[0].id && blocked) throw new VerificationError('签到验证码'); return { state: 'succeeded' }; },
      openVerification: async () => ({ isClosed: () => false }), hasTaskChallenge: async () => manual && challenge,
      isVerificationResolved: async () => !challenge
    });
    await runner.run(job.id);
    manual = true; challenge = false; blocked = false;
    await runner.workflow.requestManual(job.id, '1001');
    await until(() => !runner.workflow.session);
    assert.deepEqual(calls.filter(call => call.startsWith('manual:')), [`manual:${kind}:1001`]);
    assert.equal(runner.workflow.rows(job.id, 0).find(row => row.identity === '1001' && row.kind === kind).outcome, 'succeeded');
    assert.equal(runner.workflow.rows(job.id, 0).find(row => row.identity === '1001' && row.kind === 'checkin').outcome, null);
  }
});

test('一次验证仅完成当前签到，同日其余签到在继续运行时跳过且不再次点击', async () => {
  const { accounts, job } = fixture([{ type: 'checkin', count: 1 }, { type: 'checkin', count: 1 }]);
  let manual = false, clicks = 0;
  const runner = new TaskRunner({ ensureIdentity: async () => ({}),
    checkin: async (account, _topic, options) => {
      if (account.id === accounts[0].id && !manual) throw new VerificationError('签到验证码');
      if (manual) clicks++; options.onSubmit(); return { state: 'succeeded' };
    }, verifyCheckin: async () => ({ state: 'uncertain' }),
    openVerification: async () => ({ isClosed: () => false }), hasTaskChallenge: async () => false });
  await runner.run(job.id); manual = true;
  await runner.workflow.requestManual(job.id, '1001');
  await until(() => !runner.workflow.session);
  assert.equal(clicks, 1);
  const rows = runner.workflow.rows(job.id, 0).filter(row => row.identity === '1001');
  assert.equal(rows[0].outcome, 'succeeded'); assert.equal(rows[1].outcome, null);
  runner.workflow.continue(job.id);
  await until(() => getJob(job.id).status === 'completed');
  assert.equal(clicks, 1, '当天签到成功后不应再点');
  assert.equal(runner.workflow.rows(job.id, 0).find(row => row.step_key === rows[1].step_key).outcome, 'skipped');
});

test('人工评论明确拒绝后不递归换帖再发送', async () => {
  const { accounts, job } = fixture([{ type: 'comment', count: 1 }]); let manual = false, clicks = 0;
  const runner = new TaskRunner({ ...candidates(), ensureIdentity: async () => ({}),
    comment: async (account, candidate, _content, options) => {
      if (account.id === accounts[0].id && !manual) throw new VerificationError('评论验证码');
      options.onSubmit();
      if (manual) { clicks++; return { state: 'cancelled', retryElsewhere: true, authorUid: candidate.authorUid, reason: '明确拒绝' }; }
      return { state: 'succeeded', url: candidate.url };
    }, openVerification: async () => ({ isClosed: () => false }), hasTaskChallenge: async () => false });
  await runner.run(job.id); manual = true;
  runner.workflow.requestManual(job.id, '1001'); await until(() => !runner.workflow.session);
  assert.equal(clicks, 1);
  assert.equal(getJob(job.id).metrics.failed, 0);
  assert.equal(getJob(job.id).metrics.uncertain, 0, '待验证未确认结果暂不计入最终待核对');
  assert.equal(runner.workflow.status(getJob(job.id)).cards[0].source, 'manual_unconfirmed');
});

test('人工发送中停止会安全收尾，已确认成功保留且不再执行后续', async () => {
  const { accounts, job } = fixture([{ type: 'post', count: 1 }]); let manual = false, finish;
  const runner = new TaskRunner({ ensureIdentity: async () => ({}),
    post: async (account, _topic, _content, options) => {
      if (account.id === accounts[0].id && !manual) throw new VerificationError('发帖验证码');
      options.onSubmit(); if (manual) await new Promise(resolve => { finish = resolve; });
      return { state: 'succeeded' };
    }, openVerification: async () => ({ isClosed: () => false }), hasTaskChallenge: async () => false });
  await runner.run(job.id); manual = true;
  const manualAttempt = runner.workflow.requestManual(job.id, '1001'); await until(() => Boolean(finish));
  const stopping = runner.stopAndWait(job.id); finish();
  await Promise.allSettled([manualAttempt, runner.promise, stopping]);
  assert.equal(getJob(job.id).status, 'stopped'); assert.equal(getJob(job.id).metrics.success, 2);
  assert.equal(runner.autoReadbackCandidates(getJob(job.id)).length, 0);
});

test('停止把剩余待执行、待验证和待核对步骤统一跳过，并等到浏览器空闲', async () => {
  const { job } = fixture([{ type: 'post', count: 2 }]);
  let busy = true, cancels = 0, readbacks = 0;
  const browserManager = { status: () => ({ busy }), closeRunner: async () => { busy = false; } };
  const runner = new TaskRunner({
    ensureIdentity: async () => ({}), browserManager,
    cancelTask: async () => { cancels += 1; busy = false; },
    verifyPost: async () => { readbacks += 1; return { state: 'uncertain' }; }
  }, { scope: 'workbench' });
  runner.workflow.ensureSteps(job);
  const rows = runner.workflow.rows(job.id, 0);
  const action = state => database.createActionLog({ jobId: job.id, stepKey: rows[state.row].step_key,
    kind: 'post', accountId: rows[state.row].account_id, topicId: rows[state.row].topic_id, state: state.value });
  action({ row: 0, value: 'succeeded' });
  action({ row: 1, value: 'prepared' });
  const deferredId = action({ row: 2, value: 'verification_wait' });
  const uncertainId = action({ row: 3, value: 'uncertain' });
  db.prepare('UPDATE action_logs SET submitted_at=? WHERE id=?').run(new Date().toISOString(), uncertainId);
  db.prepare("UPDATE task_step_state SET state='done',outcome='succeeded' WHERE job_id=? AND step_key=?").run(job.id, rows[0].step_key);
  db.prepare("UPDATE task_step_state SET state='deferred' WHERE job_id=? AND step_key=?").run(job.id, rows[2].step_key);
  db.prepare("UPDATE task_step_state SET state='review',outcome='uncertain' WHERE job_id=? AND step_key=?").run(job.id, rows[3].step_key);
  const now = new Date().toISOString();
  db.prepare("INSERT INTO verification_cards(job_id,round_index,identity,account_id,status,triggered_at,updated_at) VALUES(?,0,?,?,'pending',?,?)")
    .run(job.id, rows[3].identity, rows[3].account_id, now, now);
  const stopped = await runner.stopAndWait(job.id);
  assert.equal(stopped.status, 'stopped');
  assert.equal(busy, false);
  assert.ok(cancels >= 1);
  assert.equal(readbacks, 0);
  const after = runner.workflow.rows(job.id, 0);
  assert.equal(after[0].outcome, 'succeeded');
  assert.ok(after.slice(1).every(item => item.state === 'done' && item.outcome === 'skipped'));
  for (const id of [deferredId, uncertainId]) assert.equal(database.getActionLog(id).state, 'skipped');
  assert.equal(db.prepare('SELECT status FROM verification_cards WHERE job_id=?').get(job.id).status, 'resolved');
  assert.equal(runner.autoReadbackCandidates(stopped).length, 0);
  assert.equal(runner.readbackTimers.has(job.id), false);
});

test('人工续发保存异常时暂停，再次点验证仍会直接触发发帖', async () => {
  const { accounts, job } = fixture([{ type: 'post', count: 1 }]); let manual = false, sends = 0;
  const page = { isClosed: () => false };
  const adapter = { ensureIdentity: async () => ({}), post: async (account, _topic, _content, options) => {
    if (account.id === accounts[0].id && !manual) throw new VerificationError('发帖验证码');
    options.onSubmit(); if (manual) {
      sends++; adapter.manualPostReceipt = { page, actionId: options.actionId, attemptId: options.attemptId,
        read: () => { throw Object.assign(new Error('成功证据保存异常'), { code: 'receipt_persistence_failed' }); } };
      throw new VerificationError('人工验证码');
    }
    return { state: 'succeeded' };
  }, openVerification: async () => page, hasTaskChallenge: async () => false,
    verifyPost: async () => ({ state: 'uncertain' }) };
  const runner = new TaskRunner(adapter); await runner.run(job.id); manual = true;
  runner.workflow.requestManual(job.id, '1001'); await until(() => !runner.workflow.session);
  assert.equal(getJob(job.id).status, 'paused');
  const row = runner.workflow.rows(job.id, 0).find(row => row.identity === '1001');
  assert.equal(getStepAction(job.id, row.step_key).verification_pending, 0);
  runner.workflow.requestManual(job.id, '1001'); await until(() => !runner.workflow.session);
  assert.equal(sends, 2, '重新点验证应直接触发一次新的发帖');
});

test('人工发送结果未确认时每次点击都会重新触发发帖并保持待核对', async () => {
  const { accounts, job } = fixture([{ type: 'post', count: 1 }]); let manual = false, sends = 0, clock = Date.now();
  const page = { isClosed: () => false };
  const adapter = { ensureIdentity: async () => ({}), post: async (account, _topic, _content, options) => {
    if (account.id === accounts[0].id && !manual) throw new VerificationError('发帖验证码');
    options.onSubmit(); if (manual) {
      sends++; adapter.manualPostReceipt = { page, actionId: options.actionId, attemptId: options.attemptId,
        read: () => { clock += 16000; return null; } };
      throw new VerificationError('人工验证码');
    }
    return { state: 'succeeded' };
  }, openVerification: async () => page, hasTaskChallenge: async () => false,
    verifyPost: async () => ({ state: 'uncertain' }) };
  const runner = new TaskRunner(adapter, { now: () => clock }); await runner.run(job.id); manual = true;
  runner.workflow.requestManual(job.id, '1001'); await until(() => !runner.workflow.session);
  const row = runner.workflow.rows(job.id, 0).find(row => row.identity === '1001');
  assert.equal(getStepAction(job.id, row.step_key).state, 'uncertain');
  assert.equal(getStepAction(job.id, row.step_key).verification_pending, 1);
  runner.workflow.waitForManualSubmission = async () => {};
  runner.workflow.requestManual(job.id, '1001'); await until(() => !runner.workflow.session);
  assert.equal(sends, 2); assert.equal(getJob(job.id).metrics.uncertain, 0);
});

test('人工窗口只触发当前发帖一次，验证码自动续发成功不重复发送或计数', async () => {
  const { accounts, job } = fixture([{ type: 'post', count: 1 }], { postDecoration: { mode: 'number' } });
  let manual = false, challenge = false, receipt;
  const calls = [], page = { isClosed: () => false };
  const adapter = { ensureIdentity: async () => ({}), post: async (account, _topic, content, options) => {
    calls.push({ uid: account.uid, content, manual }); options.onSubmit();
    if (account.id === accounts[0].id && !manual) { const error = new VerificationError('微博明确拒绝并要求安全验证'); error.explicitlyUnpublished = true; throw error; }
    if (manual) {
      receipt = options.onReceipt; challenge = true;
      adapter.manualPostReceipt = { page, actionId: options.actionId, attemptId: options.attemptId, read: () => null };
      throw new VerificationError('人工发送触发验证码');
    }
    return { state: 'succeeded' };
  }, openVerification: async () => page, hasTaskChallenge: async () => challenge,
    isVerificationResolved: async () => !challenge };
  const runner = new TaskRunner(adapter);
  await runner.run(job.id);
  const row = runner.workflow.rows(job.id, 0).find(row => row.identity === '1001');
  const before = getStepAction(job.id, row.step_key);
  manual = true; runner.workflow.requestManual(job.id, '1001');
  await until(() => receipt && runner.workflow.session?.wake);
  challenge = false;
  await receipt({ state: 'succeeded', successSource: 'page_notice' });
  await receipt({ state: 'succeeded', successSource: 'page_notice' });
  runner.workflow.session?.wake?.();
  await until(() => !runner.workflow.session);
  const after = getStepAction(job.id, row.step_key);
  assert.equal(calls.filter(call => call.uid === '1001').length, 2, '后台一次、人工窗口初次发送一次；验证后不再点击');
  assert.equal(calls.filter(call => call.manual).length, 1);
  assert.equal(after.id, before.id); assert.equal(after.content.replace(/\d+$/, ''), before.content.replace(/\d+$/, '')); assert.ok(after.sequence_number >= 1);
  assert.equal(after.state, 'succeeded'); assert.equal(getJob(job.id).metrics.success, 2);
});

test('原创验证码进入独立卡片，人工完成后原动作只提交一次', async () => {
  const { accounts, job } = fixture([{ type: 'original', count: 1 }], { postDecoration: { mode: 'number' } });
  let manual = false, challenge = false, receipt;
  const calls = [], page = { isClosed: () => false };
  const adapter = { ensureIdentity: async () => ({}),
    openPostHome: async () => ({}),
    originalPost: async (account, content, options) => {
      calls.push({ uid: account.uid, content, manual }); options.onSubmit();
      if (account.id === accounts[0].id && !manual) {
        const error = new VerificationError('原创发布要求安全验证'); error.explicitlyUnpublished = true; throw error;
      }
      if (manual) {
        receipt = options.onReceipt; challenge = true;
        adapter.manualPostReceipt = { page, actionId: options.actionId, attemptId: options.attemptId, read: () => null };
        throw new VerificationError('人工原创发送触发验证码');
      }
      return { state: 'succeeded' };
    }, openVerification: async () => page, hasTaskChallenge: async () => challenge,
    isVerificationResolved: async () => !challenge };
  const runner = new TaskRunner(adapter);
  await runner.run(job.id);
  const row = runner.workflow.rows(job.id, 0).find(row => row.identity === '1001' && row.kind === 'original');
  const card = db.prepare('SELECT blocked_kinds_json FROM verification_cards WHERE job_id=? AND identity=?').get(job.id, '1001');
  assert.match(card.blocked_kinds_json, /original/);
  manual = true; runner.workflow.requestManual(job.id, '1001', row.step_key);
  await until(() => receipt && runner.workflow.session?.wake);
  challenge = false; await receipt({ state: 'succeeded', successSource: 'page_notice' });
  runner.workflow.session?.wake?.(); await until(() => !runner.workflow.session);
  const after = getStepAction(job.id, row.step_key);
  assert.equal(after.state, 'succeeded');
  assert.equal(calls.filter(call => call.uid === '1001').length, 2);
});

test('发帖明确被验证拦截后保留原编号进入卡片，人工自动发布只计一次', async () => {
  const { accounts, job } = fixture([{ type: 'post', count: 2 }], { postDecoration: { mode: 'number', numberPosition: 'prefix' } });
  let manual = false, sends = 0, callback;
  const page = { isClosed: () => false };
  const adapter = {
    ensureIdentity: async () => ({}),
    post: async (account, topic, content, options) => {
      sends++; options.onSubmit();
      if (account.id !== accounts[0].id) return { state: 'succeeded' };
      if (manual) {
        callback = () => options.onReceipt({ state: 'succeeded', receiptId: '123456789', receiptUrl: 'https://weibo.com/detail/123456789', url: 'https://weibo.com/detail/123456789' });
        adapter.manualPostReceipt = { page };
        const error = new VerificationError('请完成安全验证'); throw error;
      }
      const error = new VerificationError('请完成安全验证'); error.explicitlyUnpublished = true; throw error;
    },
    openVerification: async () => page,
    hasTaskChallenge: async () => false,
    isVerificationResolved: async () => true
  };
  const runner = new TaskRunner(adapter);
  await runner.run(job.id);
  assert.equal(getJob(job.id).metrics.failed, 0);
  const pending = runner.workflow.rows(job.id, 0).find(row => row.identity === '1001');
  assert.equal(getStepAction(job.id, pending.step_key).sequence_confirmed, 1);
  manual = true; runner.workflow.requestManual(job.id, '1001');
  await until(() => Boolean(callback));
  callback(); callback();
  await until(() => !runner.workflow.session);
  assert.equal(getJob(job.id).metrics.success, 3);
  assert.equal(getStepAction(job.id, pending.step_key).sequence_confirmed, 1);
  assert.equal(sends, 4);
});

test('验证码优先尝试A其他类型再切B；未提交释放编号，人工成功与补做不重复计数', async () => {
  const { accounts, job } = fixture([{ type: 'comment', count: 2 }, { type: 'post', count: 1 }, { type: 'checkin', count: 1 }], { commentDecoration: { mode: 'emoji-and-number', emojis: ['✨'], numberPosition: 'suffix' } });
  const calls = [], bodies = [];
  let block = true, opens = 0;
  const runner = new TaskRunner({ ...candidates(), ensureIdentity: async () => ({}),
    comment: async (account, candidate, content, options) => {
      calls.push(`${account.name}:comment`); bodies.push([account.name, content]);
      if (account.id === accounts[0].id && block) throw new VerificationError('评论验证码');
      options.onSubmit(); return { state: 'succeeded', url: candidate.url };
    },
    post: async account => { calls.push(`${account.name}:post`); return { state: 'succeeded' }; },
    checkin: async account => { calls.push(`${account.name}:checkin`); return { state: 'succeeded' }; },
    openVerification: async () => { opens++; }, hasTaskChallenge: async () => false
  });
  await runner.run(job.id);
  assert.deepEqual(calls, ['A:comment','A:post','A:checkin','B:comment','B:comment','B:post','B:checkin']);
  assert.equal(opens, 0);
  assert.equal(getJob(job.id).status, 'waiting');
  assert.equal(getJob(job.id).metrics.success, 6);
  assert.equal(getJob(job.id).metrics.skipped, 0);
  assert.equal(listRoundReports(job.id)[0].status, 'running');
  let view = runner.workflow.status(getJob(job.id));
  assert.equal(view.cards.length, 1); assert.equal(view.cards[0].steps.filter(step => step.state === 'deferred').length, 2);
  assert.equal(view.canContinue, true);
  const key = view.cards[0].steps[0].key, actionId = getStepAction(job.id, key).id;
  assert.equal(getStepAction(job.id, key).sequence_number, null);
  block = false;
  runner.workflow.requestManual(job.id, '1001');
  await until(() => !runner.workflow.session);
  assert.equal(getJob(job.id).status, 'waiting');
  assert.equal(opens, 1); assert.equal(getStepAction(job.id, key).id, actionId);
  assert.equal(getJob(job.id).metrics.success, 7);
  const aBodies = bodies.filter(([name]) => name === 'A').map(([,body]) => body);
  assert.equal(aBodies[0].slice(0,-1), aBodies[1].slice(0,-1));
  assert.match(aBodies[0], /1$/); assert.match(aBodies[1], /3$/);
  assert.equal(runner.workflow.status(getJob(job.id)).canContinue, true);
  runner.workflow.continue(job.id); await until(() => getJob(job.id).status === 'completed');
  assert.equal(getJob(job.id).metrics.success, 8);
  assert.equal(listActionLogs(job.id).length, 8);
  assert.equal(calls.filter(call => call === 'A:post').length, 1);
  assert.equal(calls.filter(call => call === 'A:checkin').length, 1);
  assert.equal(listRoundReports(job.id)[0].status, 'completed');
});

test('全部类型触发验证后继续其他账号，同UID跨超话待办合并且不反复尝试', async () => {
  const { accounts, job } = fixture([{ type: 'comment', count: 1 }, { type: 'post', count: 1 }, { type: 'checkin', count: 1 }]);
  const other = createTopic({ name: '第二主题', url: 'https://example.test/second' });
  db.prepare('UPDATE jobs SET config_json=? WHERE id=?').run(JSON.stringify({ ...job.config, topicIds: [...job.config.topicIds, other.id] }), job.id);
  const calls = [];
  const action = kind => async account => { calls.push(`${account.name}:${kind}`); if (account.id === accounts[0].id) throw new VerificationError(`${kind}验证`); return { state: 'succeeded' }; };
  const runner = new TaskRunner({ ...candidates(), ensureIdentity: async () => ({}), comment: action('comment'), post: action('post'), checkin: action('checkin') });
  await runner.run(job.id);
  assert.equal(calls.filter(value => value.startsWith('A:')).length, 3);
  assert.equal(calls.filter(value => value.startsWith('B:')).length, 6);
  const view = runner.workflow.status(getJob(job.id));
  assert.equal(view.cards.length, 1); assert.equal(view.cards[0].steps.length, 6);
  assert.equal(getJob(job.id).metrics.failed, 0); assert.equal(getJob(job.id).metrics.skipped, 0);
});

test('普通已提交未知步骤首次点验证直接触发发帖并保留原编号', async () => {
  const { accounts, job } = fixture([{ type: 'post', count: 1 }], { postDecoration: { mode: 'number' } });
  let calls = 0, first = true, reads = 0;
  const runner = new TaskRunner({ ensureIdentity: async () => ({}), post: async (account, _topic, _text, options) => {
    calls++; options.onSubmit();
    if (account.id === accounts[0].id && first) { first = false; const error = new VerificationError('提交中断，结果未知'); error.verificationRequired = false; throw error; }
    return { state: 'succeeded' };
  }, openVerification: async () => {}, hasTaskChallenge: async () => false, verifyPost: async () => { reads++; return { state: 'uncertain' }; } });
  await runner.run(job.id);
  const card = runner.workflow.status(getJob(job.id)).cards[0], key = card.steps[0].key;
  const callsAfterRun = calls;
  assert.equal(callsAfterRun, 2, '账号 A 待核对，账号 B 已成功');
  assert.ok(getStepAction(job.id, key).submitted_at);
  assert.equal(getJob(job.id).metrics.uncertain, 1, '普通未知结果仍计待核对');
  runner.workflow.waitForManualSubmission = async () => {};
  await runner.workflow.requestManual(job.id, card.identity);
  await until(() => !runner.workflow.session);
  assert.equal(calls, callsAfterRun + 1, '首次点验证必须直接触发发帖');
  assert.equal(reads, 0, '首次点验证不得先做只读复核');
  assert.equal(getStepAction(job.id, key).state, 'succeeded');
  const passedCard = runner.workflow.status(getJob(job.id)).cards.find(item => item.identity === card.identity);
  assert.equal(passedCard.verificationResult, 'passed');
  const original = getStepAction(job.id, key).content;
  assert.equal(getStepAction(job.id, key).content, original);
});

test('未确认的未知提交点验证后直接触发，不阻止其他待办完成', async () => {
  const { accounts, job } = fixture([{ type: 'post', count: 1 }]);
  let calls = 0;
  const runner = new TaskRunner({ ensureIdentity: async () => ({}), post: async (account, _topic, _text, options) => {
    calls++; options.onSubmit(); if (account.id === accounts[0].id) { const error = new VerificationError('提交中断，结果未知'); error.verificationRequired = false; throw error; } return { state: 'succeeded' };
  }, openVerification: async () => {}, hasTaskChallenge: async () => false, verifyPost: async () => ({ state: 'uncertain' }) });
  await runner.run(job.id);
  runner.workflow.waitForManualSubmission = async () => {};
  await runner.workflow.requestManual(job.id, '1001'); await until(() => !runner.workflow.session);
  assert.equal(calls, 3, '点验证卡应直接触发该账号的新发帖尝试');
  assert.equal(getJob(job.id).metrics.uncertain, 0);
  const card = runner.workflow.status(getJob(job.id)).cards.find(item => item.identity === '1001');
  assert.equal(card.verificationResult, 'pending');
  assert.equal(card.source, 'manual_unconfirmed');
});

test('混合验证卡时继续运行只补做已验证账号，未验证账号保持卡片', async () => {
  const { accounts, job } = fixture([{ type: 'post', count: 1 }]);
  const manual = new Set(), calls = [];
  const runner = new TaskRunner({
    ensureIdentity: async () => ({}),
    browserManager: { closeRunner: async () => {} },
    post: async (account, _topic, _content, options) => {
      calls.push(`${manual.has(account.id) ? 'manual' : 'background'}:${account.uid}`);
      if (!manual.has(account.id)) throw new VerificationError('需要验证');
      options.onSubmit();
      return { state: 'succeeded', receiptId: 'receipt-' + account.uid };
    },
    openVerification: async () => ({ context: () => ({}), isClosed: () => false, once: () => {} }),
    hasTaskChallenge: async () => false
  }, { scope: 'workbench', leases: new AccountLeases() });
  await runner.run(job.id);
  let view = runner.workflow.status(getJob(job.id));
  assert.equal(view.cards.length, 2);
  assert.equal(view.canContinue, true);
  const cardA = view.cards.find(card => card.identity === accounts[0].uid);
  const cardB = view.cards.find(card => card.identity === accounts[1].uid);
  manual.add(accounts[0].id);
  runner.workflow.requestManual(job.id, cardA.identity, cardA.currentStepKey);
  await until(() => !runner.workflow.session);
  view = runner.workflow.status(getJob(job.id));
  assert.equal(view.canContinue, true, '其他账号未验证不阻止继续运行');
  runner.workflow.continue(job.id);
  await until(() => getStepAction(job.id, cardA.currentStepKey).state === 'succeeded');
  await until(() => getJob(job.id).status === 'waiting');
  assert.equal(db.prepare('SELECT state FROM task_step_state WHERE job_id=? AND step_key=?').get(job.id, cardB.currentStepKey).state, 'deferred');
  assert.equal(getStepAction(job.id, cardB.currentStepKey).verification_pending, 1);
  assert.deepEqual(calls, [`background:${accounts[0].uid}`, `background:${accounts[1].uid}`, `manual:${accounts[0].uid}`]);

  manual.add(accounts[1].id);
  view = runner.workflow.status(getJob(job.id));
  runner.workflow.requestManual(job.id, cardB.identity, cardB.currentStepKey);
  await until(() => !runner.workflow.session);
  runner.workflow.continue(job.id);
  await until(() => getJob(job.id).status === 'completed');
  assert.equal(getStepAction(job.id, cardB.currentStepKey).state, 'succeeded');
  assert.equal(calls.filter(value => value === `manual:${accounts[1].uid}`).length, 1);
});

test('继续运行的剩余项再次遇验证码仍回同一卡片，不提前结束轮次', async () => {
  const { accounts, job } = fixture([{ type: 'post', count: 2 }]);
  let manual = false, blocked = true;
  const runner = new TaskRunner({ ensureIdentity: async () => ({}), post: async account => {
    if (account.id === accounts[0].id && blocked && !manual) throw new VerificationError('再次验证');
    return { state: 'succeeded' };
  }, openVerification: async () => {}, hasTaskChallenge: async () => false });
  let finished = 0; runner.on('round-completed', () => finished++);
  await runner.run(job.id);
  manual = true; runner.workflow.requestManual(job.id, '1001'); await until(() => !runner.workflow.session);
  assert.equal(runner.workflow.rows(job.id, 0).filter(row => row.identity === '1001' && row.outcome === 'succeeded').length, 1);
  manual = false; runner.workflow.continue(job.id); await until(() => !runner.promise);
  assert.equal(finished, 0); assert.equal(getJob(job.id).cursor.workflowRound || 0, 0);
  const card = runner.workflow.status(getJob(job.id)).cards[0];
  assert.equal(card.status, 'pending'); assert.equal(card.attempts, 2);
  blocked = false; manual = true;
  runner.workflow.requestManual(job.id, '1001'); await until(() => !runner.workflow.session);
  runner.workflow.continue(job.id); await until(() => getJob(job.id).status === 'completed');
  assert.equal(finished, 1);
});

test('验证队列和原文组成重启后保留，待验证不重发；频繁不能通过补做绕过', async () => {
  const { accounts, job } = fixture([{ type: 'post', count: 2 }]);
  const runner = new TaskRunner({ ensureIdentity: async () => ({}), post: async account => {
    if (account.id === accounts[0].id) throw new VerificationError('需要验证'); throw new RateLimitError('发帖频繁', 'post', true);
  } });
  await runner.run(job.id);
  const before = runner.workflow.status(getJob(job.id));
  const recovered = new TaskRunner({});
  await recovered.recover();
  assert.equal(recovered.promise, null);
  assert.deepEqual(recovered.workflow.status(getJob(job.id)).cards.map(card => [card.identity,card.steps.length]), before.cards.map(card => [card.identity,card.steps.length]));
  assert.equal(getJob(job.id).metrics.failed, 0); assert.equal(getJob(job.id).metrics.skipped, 2);
  assert.equal(getJob(job.id).cursor.rateLimits[0].identity, accounts[1].uid);
});

test('手动验证请求等当前操作完成，期间不切账号；取消验证保留待办', async () => {
  const { accounts, job } = fixture([{ type: 'post', count: 1 }]);
  let release, inB = false, opens = 0;
  const hold = new Promise(resolve => { release = resolve; });
  const runner = new TaskRunner({ ensureIdentity: async () => ({}), post: async account => {
    if (account.id === accounts[0].id) throw new VerificationError('A验证'); inB = true; await hold; return { state: 'succeeded' };
  }, openVerification: async () => { opens++; }, hasTaskChallenge: async () => true, isVerificationResolved: async () => false });
  runner.run(job.id); await until(() => inB);
  const opening = runner.workflow.requestManual(job.id, '1001');
  assert.equal(opens, 0); assert.equal(runner.workflow.status(getJob(job.id)).session.phase, 'opening');
  release(); await opening;
  assert.equal(opens, 1); assert.equal(getJob(job.id).metrics.success, 1);
  await assert.rejects(runner.workflow.requestManual(job.id, '1001'), /已经打开/);
  await runner.workflow.endManual(job.id);
  assert.equal(runner.workflow.status(getJob(job.id)).cards[0].status, 'pending');
  assert.equal(getJob(job.id).status, 'waiting');
  assert.equal(runner.workflow.busy(), false);
});

test('连续点击同一验证卡只创建一个窗口并共享同一个请求编号', async () => {
  const { accounts, job } = fixture([{ type: 'post', count: 1 }]);
  const page = { context: () => ({}), isClosed: () => false, once: () => {} };
  let opens = 0, releaseOpen;
  const gate = new Promise(resolve => { releaseOpen = resolve; });
  const runner = new TaskRunner({
    ensureIdentity: async () => ({}),
    post: async account => { if (account.id === accounts[0].id) throw new VerificationError('需要验证'); return { state: 'succeeded' }; },
    openVerification: async () => { opens += 1; await gate; return page; },
    hasTaskChallenge: async () => true,
    isVerificationResolved: async () => false
  });
  await runner.run(job.id);
  const card = runner.workflow.status(getJob(job.id)).cards.find(item => item.identity === '1001');
  const first = runner.workflow.requestManual(job.id, card.identity, card.currentStepKey);
  const second = runner.workflow.requestManual(job.id, card.identity, card.currentStepKey);
  await until(() => opens === 1);
  releaseOpen();
  const [a, b] = await Promise.all([first, second]);
  assert.equal(opens, 1);
  assert.equal(a.session.requestId, b.session.requestId);
  assert.equal(getJob(job.id).cursor.manualVerification.requestId, a.session.requestId);
  await runner.workflow.endManual(job.id);
});

test('其他操作每次验证只自动触发一次，未触发时保留卡片供下次点击', async () => {
  const { accounts, job } = fixture([{ type: 'post', count: 1 }]);
  const page = { context: () => ({}), isClosed: () => false, once: () => {} };
  let opens = 0, attempts = 0;
  const runner = new TaskRunner({
    ensureIdentity: async () => ({}),
    post: async (account, _topic, _content, options) => {
      if (account.id !== accounts[0].id) return { state: 'succeeded' };
      if (!runner.workflow.session) throw new VerificationError('需要验证');
      attempts += 1;
      return { state: 'failed', reason: '页面目标未出现' };
    },
    openVerification: async () => { opens += 1; return page; },
    hasTaskChallenge: async () => false,
    closeManual: async () => {}
  });
  await runner.run(job.id);
  const card = runner.workflow.status(getJob(job.id)).cards.find(item => item.identity === '1001');
  await assert.rejects(runner.workflow.requestManual(job.id, card.identity, card.currentStepKey), /已尝试 1\/1 次/);
  await until(() => !runner.workflow.session);
  assert.equal(opens, 1);
  assert.equal(attempts, 1);
  const pending = runner.workflow.status(getJob(job.id)).cards.find(item => item.identity === '1001');
  assert.equal(pending.verificationResult, 'pending');
  assert.equal(pending.currentActionable, true);
});

test('动作未触发后重新点验证只再触发一次', async () => {
  const { accounts, job } = fixture([{ type: 'post', count: 1 }]);
  let opens = 0, attempts = 0;
  const runner = new TaskRunner({
    ensureIdentity: async () => ({}),
    post: async (account, _topic, _content, options) => {
      if (account.id !== accounts[0].id) return { state: 'succeeded' };
      if (!runner.workflow.session) throw new VerificationError('需要验证');
      attempts += 1;
      if (attempts === 1) return { state: 'failed', reason: '发帖入口没有出现' };
      options.onSubmit();
      return { state: 'succeeded', receiptId: '5359362629437778', receiptUrl: 'https://weibo.com/detail/5359362629437778' };
    },
    openVerification: async () => { opens += 1; return { context: () => ({}), isClosed: () => false, once: () => {} }; },
    hasTaskChallenge: async () => false,
    closeManual: async () => {}
  });
  await runner.run(job.id);
  let card = runner.workflow.status(getJob(job.id)).cards.find(item => item.identity === '1001');
  await assert.rejects(runner.workflow.requestManual(job.id, card.identity, card.currentStepKey), /已尝试 1\/1 次/);
  await until(() => !runner.workflow.session);
  assert.equal(opens, 1);
  assert.equal(attempts, 1);
  card = runner.workflow.status(getJob(job.id)).cards.find(item => item.identity === '1001');
  await runner.workflow.requestManual(job.id, card.identity, card.currentStepKey);
  await until(() => !runner.workflow.session);
  assert.equal(opens, 2);
  assert.equal(attempts, 2);
  assert.equal(getJob(job.id).metrics.success, 2);
});

test('第一次触发送后出现验证码时立即停止重试并等待人工处理', async () => {
  const { accounts, job } = fixture([{ type: 'post', count: 1 }]);
  let manualActions = 0, challenge = false;
  const runner = new TaskRunner({
    ensureIdentity: async () => ({}),
    post: async (account, _topic, _content, options) => {
      if (account.id !== accounts[0].id) return { state: 'succeeded' };
      if (!runner.workflow.session) throw new VerificationError('需要验证');
      manualActions += 1;
      options.onSubmit();
      challenge = true;
      throw new VerificationError('发送后要求人工验证');
    },
    openVerification: async () => ({ context: () => ({}), isClosed: () => false, once: () => {} }),
    hasTaskChallenge: async () => challenge,
    isVerificationResolved: async () => false,
    closeManual: async () => {}
  });
  await runner.run(job.id);
  const card = runner.workflow.status(getJob(job.id)).cards.find(item => item.identity === '1001');
  await runner.workflow.requestManual(job.id, card.identity, card.currentStepKey);
  await until(() => getJob(job.id).cursor.manualVerification?.phase === 'challenge');
  await new Promise(resolve => setTimeout(resolve, 150));
  assert.equal(manualActions, 1);
  assert.equal(runner.workflow.session.requestId, getJob(job.id).cursor.manualVerification.requestId);
  await runner.workflow.endManual(job.id);
});

test('未确认发帖第一次点击就打开窗口并重新发帖', async () => {
  const { accounts, job } = fixture([{ type: 'post', count: 1 }]);
  let manual = false, writes = 0, opens = 0;
  const page = { context: () => ({}), isClosed: () => false, once: () => {} };
  const runner = new TaskRunner({
    ensureIdentity: async () => ({}),
    post: async (account, _topic, _content, options) => {
      if (account.id !== accounts[0].id) return { state: 'succeeded' };
      writes += 1;
      if (!manual) throw new VerificationError('需要验证');
      options.onSubmit();
      return { state: 'succeeded', receiptId: '5359362629439999', receiptUrl: 'https://weibo.com/detail/5359362629439999' };
    },
    openVerification: async () => { opens += 1; return page; },
    hasTaskChallenge: async () => false,
    closeManual: async () => {},
    verifyPost: async () => ({ state: 'uncertain', reason: '仍未找到唯一已发布帖子' })
  });
  await runner.run(job.id);
  let card = runner.workflow.status(getJob(job.id)).cards.find(item => item.identity === '1001');
  const action = getStepAction(job.id, card.currentStepKey);
  db.prepare("UPDATE action_logs SET state='uncertain',submitted_at=?,verification_pending=1,error='历史提交结果未知' WHERE id=?")
    .run('2026-11-08T00:00:00.000Z', action.id);
  db.prepare("UPDATE task_step_state SET state='review',outcome='uncertain' WHERE job_id=? AND step_key=?").run(job.id, card.currentStepKey);
  const writesBefore = writes;
  const stepKey = card.currentStepKey;

  manual = true;
  await runner.workflow.requestManual(job.id, card.identity, card.currentStepKey);
  await until(() => !runner.workflow.session);
  card = runner.workflow.status(getJob(job.id)).cards.find(item => item.identity === '1001');
  assert.equal(writes, writesBefore + 1, '第一次点击必须实际发起新的发帖');
  assert.equal(opens, 1);
  assert.equal(getStepAction(job.id, stepKey).attempt_id !== undefined, true);
  assert.equal(card.verificationResult, 'passed');
  assert.ok(card.verifiedAt);
});

test('历史未确认成功却已通过的验证卡会恢复为再次验证', async () => {
  const { accounts, job } = fixture([{ type: 'post', count: 1 }]);
  const runner = new TaskRunner({
    ensureIdentity: async () => ({}),
    post: async account => { if (account.id === accounts[0].id) throw new VerificationError('需要验证'); return { state: 'succeeded' }; }
  });
  await runner.run(job.id);
  const card = runner.workflow.status(getJob(job.id)).cards.find(item => item.identity === '1001');
  const action = getStepAction(job.id, card.currentStepKey);
  db.prepare("UPDATE action_logs SET state='uncertain',submitted_at=?,error='人工验证后仍未观察到本次操作的成功提示，保留核对且不重复发送' WHERE id=?")
    .run(new Date().toISOString(), action.id);
  db.prepare("UPDATE task_step_state SET state='review',outcome='uncertain' WHERE job_id=? AND step_key=?").run(job.id, action.step_key);
  db.prepare("UPDATE verification_cards SET status='ready',verification_result='passed',verified_at=?,reason='已发送，结果待核对，不会自动重发' WHERE job_id=? AND identity=?")
    .run(new Date().toISOString(), job.id, '1001');
  const repaired = runner.workflow.status(getJob(job.id)).cards.find(item => item.identity === '1001');
  assert.equal(repaired.status, 'pending');
  assert.equal(repaired.verificationResult, 'pending');
  assert.equal(repaired.verifiedAt, null);
  assert.equal(repaired.source, 'manual_unconfirmed');
  assert.equal(repaired.canOpen, true);
  db.prepare("UPDATE action_logs SET state='uncertain',verification_pending=0,error='人工验证后仍未观察到本次操作的成功提示，保留核对且不重复发送' WHERE id=?").run(action.id);
  db.prepare("UPDATE task_step_state SET state='review',outcome='uncertain' WHERE job_id=? AND step_key=?").run(job.id, action.step_key);
  db.prepare("UPDATE verification_cards SET status='pending',verification_result='pending',verified_at=NULL,source='verification_detected',reason='之后另一操作再次触发验证' WHERE job_id=? AND identity='1001'").run(job.id);
  const repairedAgain = runner.workflow.status(getJob(job.id)).cards.find(item => item.identity === '1001');
  assert.equal(repairedAgain.source, 'manual_unconfirmed');
  assert.equal(repairedAgain.currentStepKey, action.step_key);
  assert.equal(getStepAction(job.id, action.step_key).verification_pending, 1);
});

test('待验证发帖即使有旧 submitted_at 也会在验证卡中发起新一次发送', async () => {
  const { accounts, job } = fixture([{ type: 'post', count: 1 }]);
  let manual = false, writes = 0;
  const runner = new TaskRunner({
    ensureIdentity: async () => ({}),
    post: async (account, _topic, _content, options) => {
      if (account.id !== accounts[0].id) return { state: 'succeeded' };
      writes += 1;
      if (!manual) throw new VerificationError('For your safety, please verify your account');
      options.onSubmit();
      return { state: 'succeeded', receiptId: '5359362629438888', receiptUrl: 'https://weibo.com/detail/5359362629438888' };
    },
    openVerification: async () => ({ context: () => ({}), isClosed: () => false, once: () => {} }),
    hasTaskChallenge: async () => false,
    closeManual: async () => {}
  });
  await runner.run(job.id);
  const card = runner.workflow.status(getJob(job.id)).cards.find(item => item.identity === '1001');
  db.prepare("UPDATE action_logs SET submitted_at=?,verification_pending=1 WHERE job_id=? AND step_key=?")
    .run(new Date().toISOString(), job.id, card.currentStepKey);
  const before = writes;
  manual = true;
  await runner.workflow.requestManual(job.id, card.identity, card.currentStepKey);
  await until(() => !runner.workflow.session);
  assert.equal(writes, before + 1, '明确待人工验证的发帖必须在验证卡中重新触发一次');
  assert.equal(getStepAction(job.id, card.currentStepKey).state, 'succeeded');
});

test('服务残留的验证游标不会阻止重新开窗', async () => {
  const { accounts, job } = fixture([{ type: 'post', count: 1 }]);
  let opens = 0;
  const runner = new TaskRunner({
    ensureIdentity: async () => ({}),
    post: async account => { if (account.id === accounts[0].id) throw new VerificationError('需要验证'); return { state: 'succeeded' }; },
    openVerification: async () => { opens += 1; return { context: () => ({}), isClosed: () => false, once: () => {} }; },
    hasTaskChallenge: async () => true,
    isVerificationResolved: async () => false
  });
  await runner.run(job.id);
  const current = getJob(job.id);
  updateJob(job.id, { cursor: { ...current.cursor, manualVerification: {
    requestId: 'vreq_stale', identity: '1001', phase: 'opening', requestedAt: new Date().toISOString()
  } } });
  const opened = await runner.workflow.requestManual(job.id, '1001');
  assert.equal(opens, 1);
  assert.notEqual(opened.session.requestId, 'vreq_stale');
  assert.match(getJob(job.id).cursor.manualVerification.phase, /waiting_challenge|challenge/);
  await runner.workflow.endManual(job.id);
  assert.equal(runner.workflow.busy(), false);
});

test('验证窗口创建失败会恢复卡片并释放账号租约', async () => {
  const { accounts, job } = fixture([{ type: 'post', count: 1 }]);
  const leases = new AccountLeases();
  const runner = new TaskRunner({
    ensureIdentity: async () => ({}),
    post: async account => { if (account.id === accounts[0].id) throw new VerificationError('需要验证'); return { state: 'succeeded' }; },
    openVerification: async () => { throw new Error('Chrome launch failed'); },
    hasTaskChallenge: async () => false
  }, { scope: 'workbench', leases });
  await runner.run(job.id);
  const card = runner.workflow.status(getJob(job.id)).cards.find(item => item.identity === '1001');
  await assert.rejects(runner.workflow.requestManual(job.id, card.identity, card.currentStepKey), /Chrome launch failed/);
  assert.equal(runner.workflow.session, null);
  assert.equal(getJob(job.id).cursor.manualVerification, null);
  assert.equal(leases.owners.size, 0);
  const failedCard = runner.workflow.status(getJob(job.id)).cards.find(item => item.identity === '1001');
  assert.equal(failedCard.status, 'pending');
  assert.match(failedCard.reason, /Chrome launch failed/);
});

test('验证卡片不被存活的等待循环卡住，初始标签关闭后恢复为可重试', async () => {
  const { accounts, job } = fixture([{ type: 'post', count: 1 }]);
  let blocked = true, opens = 0;
  const closedPage = { isClosed: () => true };
  const runner = new TaskRunner({
    ensureIdentity: async () => ({}),
    post: async () => {
      if (blocked) throw new VerificationError('需要验证');
      return { state: 'succeeded' };
    },
    openVerification: async () => (++opens === 1 ? closedPage : closedPage),
    hasTaskChallenge: async () => false
  });
  await runner.run(job.id);
  // Simulate an already-settled execution promise.  The old implementation
  // only opened a manual browser when this value was null.
  runner.promise = new Promise(() => {});
  blocked = false;
  await assert.rejects(runner.workflow.requestManual(job.id, '1001'), /立即关闭|无法打开/);
  await until(() => opens === 1);
  assert.equal(runner.workflow.session, null);
  assert.equal(getJob(job.id).cursor.manualVerification, null);
  assert.equal(runner.workflow.status(getJob(job.id)).cards[0].status, 'pending');
  assert.equal(getJob(job.id).metrics.success, 0);
  runner.promise = null;
});

test('评论回执明确拒绝时全轮避开发帖人，释放编号并改选其他帖子', async () => {
  const { accounts, job } = fixture([{ type: 'comment', count: 1 }], {
    commentStrategy: 'zero-only',
    commentDecoration: { mode: 'number', numberPosition: 'suffix' }
  });
  const rejected = { id: 'bad-post', url: 'https://example.test/900/bad-post', authorUid: '900', commentCount: 0 };
  const accepted = { id: 'good-post', url: 'https://example.test/901/good-post', authorUid: '901', commentCount: 0 };
  const calls = [];
  const runner = new TaskRunner({
    ensureIdentity: async () => ({}),
    collectCandidates: async () => [rejected, accepted],
    inspectCandidate: async (_account, item) => item,
    comment: async (_account, candidate, content, options) => {
      calls.push([candidate.authorUid, content]);
      options.onSubmit();
      if (candidate.authorUid === '900') return { state: 'cancelled', retryElsewhere: true, authorUid: '900', reason: '微博回执明确表示评论未被接受' };
      return { state: 'succeeded', url: candidate.url };
    }
  });
  await runner.run(job.id);
  assert.deepEqual(calls.map(([author]) => author), ['900', '901', '901']);
  assert.match(calls[0][1], /1$/);
  assert.equal(calls[0][1], calls[1][1]);
  assert.match(calls[2][1], /2$/);
  assert.equal(getJob(job.id).metrics.failed, 0);
  assert.equal(getJob(job.id).metrics.success, 2);
  assert.equal(getJob(job.id).cursor.commentRejectedAuthors[0].authorUid, '900');
});

test('23:59终止手动验证、保留未完成待办历史，禁止继续补做', async () => {
  const { accounts, job } = fixture([{ type: 'post', count: 1 }]);
  const deadline = Date.now() + 1000;
  database.updateJob(job.id, { cursor: { stepIndex: 0, deadlineAt: new Date(deadline).toISOString() } });
  let time = deadline - 1000, closes = 0;
  const runner = new TaskRunner({ ensureIdentity: async () => ({}), post: async account => { if (account.id === accounts[0].id) throw new VerificationError('验证'); return { state: 'succeeded' }; }, openVerification: async () => {}, hasTaskChallenge: async () => true, isVerificationResolved: async () => false, cancelTask: async () => { closes++; } }, { now: () => time });
  await runner.run(job.id);
  runner.workflow.requestManual(job.id, '1001'); await until(() => runner.workflow.session?.wake);
  time = deadline; runner.enforceDailyStop(); await until(() => !runner.workflow.session);
  assert.equal(getJob(job.id).status, 'stopped'); assert.ok(closes > 0);
  assert.equal(getJob(job.id).metrics.failed, 0);
  assert.equal(listRoundReports(job.id)[0].status, 'stopped');
  assert.throws(() => runner.workflow.continue(job.id), /23:59/);
  assert.equal(runner.workflow.status(getJob(job.id)).canContinue, false);
});

test('签到结果未知时首次验证直接打开窗口，核验未签到后触发一次', async () => {
  const { job } = fixture([{ type: 'checkin', count: 1 }]);
  let submits = 0, reads = 0, opens = 0, manual = false;
  const runner = new TaskRunner({ ensureIdentity: async () => ({}),
    checkin: async (_a, _t, {onSubmit}) => { submits++; onSubmit(); return manual ? {state:'succeeded'} : {state:'uncertain'}; },
    verifyCheckin: async () => { reads++; return manual ? {state:'uncertain'} : {state:'uncertain'}; },
    openVerification: async () => { opens++; return {isClosed:()=>false}; }, hasTaskChallenge: async () => false });
  await runner.run(job.id);
  const before = submits;
  manual = true;
  await runner.workflow.requestManual(job.id,'1001');
  await until(() => !runner.workflow.session, 6000);
  assert.equal(opens,1);
  assert.equal(submits,before+1);
  assert.ok(reads>=1);
  const card=runner.workflow.status(getJob(job.id)).cards.find(item=>item.identity==='1001');
  assert.equal(card.verificationResult,'passed');
  assert.ok(['ready','resolved'].includes(card.status));
});

test('关闭人工验证窗口后卡片立即恢复为可再次验证', async () => {
  const { accounts, job } = fixture([{ type: 'post', count: 1 }]);
  let closeWindow;
  const page = {
    isClosed: () => false,
    once: (event, listener) => { if (event === 'close') closeWindow = listener; }
  };
  const runner = new TaskRunner({
    ensureIdentity: async () => ({}),
    post: async account => { if (account.id === accounts[0].id) throw new VerificationError('需要验证'); return { state: 'succeeded' }; },
    openVerification: async () => page,
    hasTaskChallenge: async () => true,
    isVerificationResolved: async () => false
  });
  await runner.run(job.id);
  const opening = runner.workflow.requestManual(job.id, '1001');
  const rejectedOpening = assert.rejects(opening, /关闭/);
  await until(() => runner.workflow.session?.wake);
  closeWindow();
  await until(() => !runner.workflow.session);
  await rejectedOpening;
  const view = runner.workflow.status(getJob(job.id));
  assert.equal(view.cards[0].status, 'pending');
  assert.equal(view.session, null);
  assert.match(view.cards[0].reason, /验证窗口已关闭/);
});

test('人工验证窗口打开后直接触发操作，不预扫验证码', async () => {
  const { accounts, job } = fixture([{ type: 'post', count: 1 }]);
  let manual = false, actions = 0, challengeChecks = 0;
  const runner = new TaskRunner({
    ensureIdentity: async () => ({}),
    post: async (account, _topic, _content, options) => {
      if (account.id === accounts[0].id && !manual) throw new VerificationError('需要验证');
      actions += 1;
      options.onSubmit();
      return { state: 'succeeded', receiptId: '5359362629438888' };
    },
    openVerification: async () => ({ context: () => ({}), isClosed: () => false, once: () => {} }),
    hasTaskChallenge: async () => { challengeChecks += 1; return false; },
    closeManual: async () => {}
  }, { scope: 'workbench', leases: new AccountLeases() });
  await runner.run(job.id);
  const card = runner.workflow.status(getJob(job.id)).cards.find(item => item.identity === '1001');
  const actionsBefore = actions;
  manual = true;
  await runner.workflow.requestManual(job.id, card.identity, card.currentStepKey);
  await until(() => !runner.workflow.session);
  assert.equal(actions, actionsBefore + 1);
  assert.equal(challengeChecks, 0, '打开窗口后必须先直接触发操作，不能预扫验证码');
  assert.equal(getJob(job.id).metrics.success, 2);
});

test('人工验证中成功回执立即唤醒会话并标记验证通过', async () => {
  const { accounts, job } = fixture([{ type: 'post', count: 1 }]);
  let manual = false, challenge = false;
  const runner = new TaskRunner({
    ensureIdentity: async () => ({}),
    post: async (account, _topic, _content, options) => {
      if (account.id !== accounts[0].id) return { state: 'succeeded' };
      if (!manual) throw new VerificationError('需要验证');
      options.onSubmit();
      challenge = true;
      throw new VerificationError('点击后出现验证码');
    },
    openVerification: async () => ({ context: () => ({}), isClosed: () => false, once: () => {} }),
    hasTaskChallenge: async () => challenge,
    isVerificationResolved: async () => false,
    closeManual: async () => {}
  }, { scope: 'workbench', leases: new AccountLeases() });
  await runner.run(job.id);
  const card = runner.workflow.status(getJob(job.id)).cards.find(item => item.identity === '1001');
  manual = true;
  await runner.workflow.requestManual(job.id, card.identity, card.currentStepKey);
  await until(() => runner.workflow.session?.challengeSeen);
  const action = getStepAction(job.id, card.currentStepKey);
  const started = Date.now();
  runner.settlePostAction(action.id, {
    state: 'succeeded', receiptId: '5363450649774999', receiptUrl: 'https://weibo.com/detail/5363450649774999',
    successSource: 'api_receipt', attemptId: action.attempt_id,
  });
  await until(() => !runner.workflow.session, 1500);
  assert.ok(Date.now() - started < 1500, '成功回执应立即结束等待');
  const passed = runner.workflow.status(getJob(job.id)).cards.find(item => item.identity === '1001');
  assert.equal(passed.verificationResult, 'passed');
  assert.ok(passed.verifiedAt);
});

test('验证完成后立即解除下一张卡禁用，浏览器在后台继续关闭', async () => {
  const { accounts, job } = fixture([{ type: 'post', count: 1 }]);
  let manual = false, releaseClose;
  const closeGate = new Promise(resolve => { releaseClose = resolve; });
  const runner = new TaskRunner({
    ensureIdentity: async () => ({}),
    post: async (account, _topic, _content, options) => {
      if (account.id !== accounts[0].id) return { state: 'succeeded' };
      if (!manual) throw new VerificationError('需要验证');
      options.onSubmit();
      return { state: 'succeeded', receiptId: '5363450649774888' };
    },
    openVerification: async () => ({ context: () => ({}), isClosed: () => false, once: () => {} }),
    hasTaskChallenge: async () => false,
    closeManual: async () => closeGate,
  }, { scope: 'workbench', leases: new AccountLeases() });
  await runner.run(job.id);
  const card = runner.workflow.status(getJob(job.id)).cards.find(item => item.identity === '1001');
  manual = true;
  await runner.workflow.requestManual(job.id, card.identity, card.currentStepKey);
  await until(() => !runner.workflow.session && Boolean(releaseClose), 3000);
  const cleanup = runner.workflow.manualCleanupPromise;
  assert.ok(cleanup, '浏览器关闭应在后台继续执行');
  assert.equal(runner.workflow.status(getJob(job.id)).canContinue, false, '浏览器关闭期间只阻止继续运行，不阻止下一张验证卡');
  releaseClose();
  await cleanup;
  assert.equal(runner.workflow.manualCleanupPromise, null);
});

test('真实管理器和适配器的身份检查、复核、签到全程复用人工验证上下文', async () => {
  const { accounts, topics, job } = fixture([{ type: 'checkin', count: 1 }]);
  db.prepare('UPDATE topics SET url=? WHERE id=?').run('https://weibo.com/p/localfixture', topics[0].id);
  let launches = 0, clicks = 0;
  const manager = new BrowserManager(async ({ profile, options }) => {
    launches++;
    assert.equal(options.headless, false, '人工会话必须请求可见窗口');
    const context = await chromium.launchPersistentContext(profile, { ...options, headless: true });
    await context.route('https://weibo.com/**', route => route.fulfill({ contentType: 'text/html; charset=utf-8', body: `
      <script>window.$CONFIG={uid:'1001',user:{screen_name:'A'}};</script>
      <button class="signBtn" onclick="this.textContent='已签到';fetch('/fixture-click')">签到</button>` }));
    context.on('request', request => { if (request.url().endsWith('/fixture-click')) clicks++; });
    return context;
  }, { headless: true, activate: async () => {} });
  const runner = new TaskRunner(new WeiboAdapter(manager), {scope:'workbench', leases:new AccountLeases()});
  runner.workflow.ensureSteps(job);
  const step = buildSteps(job.config)[0];
  database.createActionLog({ jobId: job.id, stepKey: runner.workflow.rows(job.id, 0)[0].step_key,
    kind: 'checkin', accountId: accounts[0].id, topicId: topics[0].id, state: 'uncertain' });
  runner.workflow.defer(job.id, step, new VerificationError('模拟已观察到的签到验证码'));
  runner.workflow.requestManual(job.id, '1001');
  try {
    await until(() => !runner.workflow.session, 45000);
    assert.equal(launches, 1);
    assert.equal(getJob(job.id).metrics.success, 1, JSON.stringify(runner.workflow.status(getJob(job.id))));
    assert.equal(clicks, 1);
  } finally { await manager.close(); }
});

test('停止任务只复制授权签到到独立任务，保留源记录且重复执行不重复建任务', async () => {
  const { job } = fixture([{ type: 'checkin', count: 1 }, { type: 'post', count: 2 }]);
  const runner = new TaskRunner({}); runner.workflow.ensureSteps(job);
  db.prepare("UPDATE task_step_state SET ever_verification=1 WHERE job_id=? AND kind='checkin'").run(job.id);
  database.updateJob(job.id, { status: 'stopped' });
  const sourceBefore = JSON.stringify(getJob(job.id));
  const { restoreCheckinFollowups } = await import('../scripts/restore-checkin-followups.mjs');
  const followup = restoreCheckinFollowups(job.id, ['1001','1002']);
  assert.equal(followup.status, 'waiting');
  assert.deepEqual(followup.config.actionPlan, [{ type: 'checkin', count: 1, intervalSeconds: 5 }]);
  assert.equal(runner.workflow.rows(followup.id, 0).length, 2);
  assert.equal(runner.workflow.status(followup).cards.length, 2);
  assert.equal(JSON.stringify(getJob(job.id)), sourceBefore);
  assert.equal(restoreCheckinFollowups(job.id, ['1001','1002']).id, followup.id);
});

test('验证通过后在同一人工会话内完成签到，重新检测不发送且不重复计数', async () => {
  const { job } = fixture([{ type: 'checkin', count: 1 }]);
  let submissions = 0, resolved = false, manual = false;
  const runner = new TaskRunner({ ensureIdentity: async () => ({}),
    checkin: async () => { submissions++; return manual ? { state: 'succeeded' } : { state: 'uncertain' }; },
    verifyCheckin: async () => ({ state: 'uncertain' }),
    openVerification: async () => ({ isClosed: () => false }), hasTaskChallenge: async () => !resolved,
    isVerificationResolved: async () => resolved
  });
  await runner.run(job.id);
  for (const identity of ['1001','1002']) {
    runner.workflow.requestManual(job.id, identity);
    await until(() => runner.workflow.session?.wake);
    const before = submissions;
    assert.equal((await runner.workflow.recheckManual(job.id)).detectionResolved, false);
    assert.equal(submissions, before, '重新检测只能读取');
    resolved = true; manual = true;
    await runner.workflow.recheckManual(job.id);
    await until(() => !runner.workflow.session);
    const card = runner.workflow.status(getJob(job.id)).cards.find(c => c.identity === identity);
    assert.equal(card.verificationResult, 'passed');
    assert.equal(card.checkinResult, 'succeeded');
    assert.equal(getJob(job.id).metrics.success, identity === '1001' ? 1 : 2);
    resolved = false; manual = false;
  }
  assert.equal(runner.workflow.status(getJob(job.id)).canContinue, true);
  runner.workflow.continue(job.id);
  await until(() => getJob(job.id).status === 'completed');
  assert.equal(getJob(job.id).metrics.success, 2);
});

test('人工签到再次遇到真实验证码会留在原会话等待处理', async () => {
  const { job } = fixture([{ type: 'checkin', count: 1 }]);
  let securityChallenge = false, resolved = false, manual = false;
  const runner = new TaskRunner({ ensureIdentity: async () => ({}),
    checkin: async () => { if (!manual) return { state: 'uncertain' }; if (securityChallenge) throw new VerificationError('新的真实验证码'); return { state: 'succeeded' }; },
    verifyCheckin: async () => ({ state: 'uncertain' }), openVerification: async () => ({ isClosed: () => false }),
    hasTaskChallenge: async () => securityChallenge, isVerificationResolved: async () => resolved
  });
  await runner.run(job.id);
  manual = true; securityChallenge = true;
  runner.workflow.requestManual(job.id, '1001');
  await until(() => runner.workflow.session?.wake);
  assert.equal(runner.workflow.status(getJob(job.id)).cards.find(card => card.identity === '1001').status, 'validating');
  securityChallenge = false; resolved = true;
  runner.workflow.session.wake();
  await until(() => !runner.workflow.session);
  assert.equal(getJob(job.id).metrics.success, 1);
});

test('验证检测来源的卡片验证通过后自动补做签到并收尾隐藏', async () => {
  const { job } = fixture([{ type: 'checkin', count: 1 }]);
  let challenge = true, resolved = false, clicks = 0;
  const runner = new TaskRunner({ ensureIdentity: async () => ({}),
    checkin: async () => { clicks++; if (challenge) throw new VerificationError('需要安全验证'); return { state: 'succeeded' }; },
    verifyCheckin: async () => ({ state: 'uncertain' }),
    openVerification: async () => ({ isClosed: () => false }),
    hasTaskChallenge: async () => challenge,
    isVerificationResolved: async () => resolved
  });
  await runner.run(job.id);
  const before = runner.workflow.status(getJob(job.id)).cards;
  assert.equal(before.length, 2);
  assert.ok(before.every(card => card.source === 'verification_detected' && card.status === 'pending'));
  for (const identity of ['1001', '1002']) {
    runner.workflow.requestManual(job.id, identity);
    await until(() => runner.workflow.session?.wake);
    challenge = false; resolved = true;
    await runner.workflow.recheckManual(job.id);
    await until(() => !runner.workflow.session);
    const card = runner.workflow.status(getJob(job.id)).cards.find(item => item.identity === identity);
    assert.equal(card.checkinResult, 'succeeded');
    assert.equal(card.status, 'resolved');
    assert.equal(card.visible, false);
    challenge = true; resolved = false;
  }
  assert.equal(getJob(job.id).metrics.success, 2);
  assert.equal(clicks, 4, '每个账号只允许在人工会话里点一次签到');
});

test('补做签到前再次出现验证码时保持手动验证状态', async () => {
  const { job } = fixture([{ type: 'checkin', count: 1 }]);
  let challenge = true, probes = 0, verifyCalls = 0;
  const phases = [];
  const runner = new TaskRunner({ ensureIdentity: async () => ({}),
    checkin: async () => { if (challenge) throw new VerificationError('需要安全验证'); return { state: 'succeeded' }; },
    verifyCheckin: async () => { verifyCalls++; return { state: 'succeeded' }; },
    openVerification: async () => ({ isClosed: () => false }),
    hasTaskChallenge: async () => challenge,
    isVerificationResolved: async () => {
      phases.push(getJob(job.id).cursor.manualVerification?.phase);
      probes++;
      // 第一次通过后立刻又弹出验证码：必须切回 challenge，而不是直接补做签到。
      if (probes === 2) { challenge = true; return true; }
      if (probes === 3) { challenge = false; return true; }
      return false;
    }
  });
  await runner.run(job.id);
  db.prepare("UPDATE verification_cards SET source='manual_unconfirmed' WHERE job_id=? AND identity='1001'").run(job.id);
  runner.workflow.requestManual(job.id, '1001');
  await until(() => phases.length >= 3 && !runner.workflow.session, 15000);
  assert.equal(verifyCalls, 1, '第二次验证码解除前不能做签到核验');
  assert.equal(phases[2], 'challenge', '第二次验证码期间必须处于手动验证状态，实际 ' + JSON.stringify(phases));
  const card = runner.workflow.status(getJob(job.id)).cards.find(item => item.identity === '1001');
  assert.equal(card.checkinResult, 'succeeded');
  assert.equal(card.status, 'resolved');
});

test('签到点击后仍待核对时保持窗口并按只读核验补记', async () => {
  const { job } = fixture([{ type: 'checkin', count: 1 }]);
  let confirmed = false;
  const runner = new TaskRunner({ ensureIdentity: async () => ({}),
    checkin: async (_account, _topic, { onSubmit }) => { onSubmit(); return { state: 'uncertain' }; },
    verifyCheckin: async () => ({ state: confirmed ? 'succeeded' : 'uncertain' }),
    openVerification: async () => ({ isClosed: () => false }),
    hasTaskChallenge: async () => false,
    isVerificationResolved: async () => true
  });
  await runner.run(job.id);
  db.prepare("UPDATE verification_cards SET source='manual_unconfirmed' WHERE job_id=? AND identity='1001'").run(job.id);
  runner.workflow.requestManual(job.id, '1001');
  await until(() => getJob(job.id).cursor.manualVerification?.phase === 'signing_checkin');
  await new Promise(resolve => setTimeout(resolve, 2600));
  assert.ok(runner.workflow.session, '签到未确认时必须保持可见窗口');
  const action = db.prepare("SELECT state FROM action_logs WHERE job_id=? AND kind='checkin' AND account_id=(SELECT id FROM accounts WHERE uid='1001')").get(job.id);
  assert.equal(action.state, 'uncertain');
  const card = runner.workflow.status(getJob(job.id)).cards.find(item => item.identity === '1001');
  assert.equal(card.checkinResult, 'pending');
  assert.match(card.reason, /请在当前 Chrome 窗口完成签到/);
  confirmed = true;
  await until(() => !runner.workflow.session, 8000);
  const done = runner.workflow.status(getJob(job.id)).cards.find(item => item.identity === '1001');
  assert.equal(done.checkinResult, 'succeeded');
  assert.equal(getJob(job.id).metrics.success, 1);
});

test('进入等待人工验证时只发一次「还有 N 个号待验证」', async t => {
  const notifySetting = process.env.WEIBO_CONSOLE_NOTIFY;
  delete process.env.WEIBO_CONSOLE_NOTIFY;
  t.after(() => { if (notifySetting == null) delete process.env.WEIBO_CONSOLE_NOTIFY; else process.env.WEIBO_CONSOLE_NOTIFY = notifySetting; });
  const { setNotificationExecutor, notifyVerification, resetVerificationNotifications } = await import('../src/notifications.js');
  const messages = [];
  setNotificationExecutor((cmd, args, options, callback) => { messages.push(args.at(-1)); callback(null); });
  const { job } = fixture([{ type: 'checkin', count: 1 }]);
  const runner = new TaskRunner({ ensureIdentity: async () => ({}),
    checkin: async (_account, _topic, { onSubmit }) => { onSubmit(); return { state: 'uncertain' }; },
    verifyCheckin: async () => ({ state: 'uncertain' }),
    openVerification: async () => ({ isClosed: () => false }),
    hasTaskChallenge: async () => false,
    isVerificationResolved: async () => true
  });
  await runner.run(job.id);
  await until(() => messages.length > 0, 2000);
  assert.equal(messages.length, 1);
  assert.ok(String(messages[0]).includes('还有 2 个号待验证'));
  assert.ok(getJob(job.id).cursor.verificationNotifiedAt);
  await runner.workflow.notifyBarrier(job.id, 0);
  assert.equal(messages.length, 1);
  assert.equal(await notifyVerification({ id: job.id }, { count: 2, round: 0 }), false);
  assert.equal(await notifyVerification({ id: job.id }, { count: 2, round: 1 }), false);
  assert.equal(messages.length, 1);
  assert.equal(await notifyVerification({ id: job.id + '-next' }, { count: 1, round: 0 }), true);
  assert.equal(messages.length, 2);
  assert.equal(await notifyVerification({ id: job.id }, { count: 0, round: 2 }), false);
  resetVerificationNotifications(job.id);
  assert.equal(await notifyVerification({ id: job.id }, { count: 1, round: 0 }), true);
  setNotificationExecutor(null);
});

test('测试环境关闭系统通知后不会弹出 macOS 提醒', async () => {
  const { setNotificationExecutor, notifyRound, notifyVerification } = await import('../src/notifications.js');
  const messages = [];
  setNotificationExecutor((cmd, args, options, callback) => { messages.push(args.at(-1)); callback(null); });
  process.env.WEIBO_CONSOLE_NOTIFY = 'off';
  try {
    assert.equal(await notifyVerification({ id: 'job-notify-off' }, { count: 3, round: 0 }), false);
    assert.equal(await notifyRound({ jobId: 'job-notify-off', round: 0, counts: { checkin: { succeeded: 1 }, post: { succeeded: 0 }, comment: { succeeded: 0 } }, abnormalAccounts: [] }), false);
    assert.equal(messages.length, 0);
  } finally {
    process.env.WEIBO_CONSOLE_NOTIFY = 'off';
    setNotificationExecutor(null);
  }
});

test('签到验证只阻塞签到，评论继续；继续运行只补签到', async () => {
  const { accounts, job } = fixture([{ type: 'checkin', count: 1 }, { type: 'comment', count: 2 }]);
  let verified = false;
  const calls = [];
  const runner = new TaskRunner({ ...candidates(), ensureIdentity: async () => ({}),
    checkin: async account => {
      calls.push('checkin:' + account.name);
      if (account.id === accounts[0].id && !verified) throw new VerificationError('签到验证');
      return { state: 'succeeded' };
    },
    comment: async account => { calls.push('comment:' + account.name); return { state: 'succeeded' }; }
  });
  await runner.run(job.id);
  assert.equal(getJob(job.id).status, 'waiting');
  assert.ok(calls.filter(call => call.startsWith('comment:')).length >= 3, '签到验证后评论仍需执行');
  const card = runner.workflow.status(getJob(job.id)).cards[0];
  assert.deepEqual(JSON.parse(db.prepare('SELECT blocked_kinds_json FROM verification_cards WHERE job_id=? AND identity=?').get(job.id, card.identity).blocked_kinds_json), ['checkin']);
  const commentCount = calls.filter(call => call.startsWith('comment:')).length;
  db.prepare("UPDATE verification_cards SET status='ready',verification_result='passed',verified_at=? WHERE job_id=? AND identity=?").run(new Date().toISOString(), job.id, card.identity);
  verified = true;
  runner.workflow.continue(job.id);
  await until(() => getJob(job.id).status === 'completed');
  assert.equal(calls.filter(call => call.startsWith('comment:')).length, commentCount, '继续运行不应重复评论');
  assert.equal(calls.filter(call => call === 'checkin:A').length, 2, '只应补做一次签到');
});
function deferredCheckinFixture() {
  const { accounts, job } = fixture([{ type: 'checkin', count: 1 }, { type: 'comment', count: 1 }]);
  const runner = new TaskRunner({}, { scope: 'workbench' });
  runner.run = async () => {};
  runner.workflow.ensureSteps(job);
  const rows = runner.workflow.rows(job.id, 0).filter(row => row.account_id === accounts[0].id);
  const checkin = rows.find(row => row.kind === 'checkin');
  const comment = rows.find(row => row.kind === 'comment');
  const checkinAction = database.createActionLog({ jobId: job.id, stepKey: checkin.step_key, kind: 'checkin',
    accountId: checkin.account_id, topicId: checkin.topic_id, state: 'uncertain' });
  database.updateActionLog(checkinAction, { state: 'uncertain', submittedAt: new Date().toISOString(),
    verificationPending: 0, error: '点击签到后未验收到“已签到”状态' });
  const commentAction = database.createActionLog({ jobId: job.id, stepKey: comment.step_key, kind: 'comment',
    accountId: comment.account_id, topicId: comment.topic_id, state: 'succeeded' });
  database.updateActionLog(commentAction, { state: 'succeeded' });
  db.prepare("UPDATE task_step_state SET state='done',outcome='succeeded' WHERE job_id=? AND step_key=?").run(job.id, comment.step_key);
  runner.workflow.deferUnconfirmedCheckin(job.id, { round: checkin.round_index, topicId: checkin.topic_id,
    accountId: checkin.account_id, kind: 'checkin', actionIndex: checkin.action_index,
    segmentId: checkin.segment_id, unitIndex: checkin.unit_index }, '点击签到后未验收到“已签到”状态');
  return { job, runner, checkin, comment };
}

test('签到未确认时评论成功不能把验证卡改成已验证', () => {
  const { job, runner, checkin, comment } = deferredCheckinFixture();
  assert.equal(getStepAction(job.id, checkin.step_key).verification_pending, 1);
  assert.equal(runner.workflow.markActionVerificationPassed(job.id, comment.step_key), false);
  const card = db.prepare('SELECT status,verification_result,source,verified_at FROM verification_cards WHERE job_id=? AND identity=?')
    .get(job.id, checkin.identity);
  assert.equal(card.status, 'pending');
  assert.equal(card.verification_result, 'pending');
  assert.equal(card.source, 'checkin_unconfirmed');
  assert.equal(card.verified_at, null);
  const view = runner.workflow.status(job).cards.find(item => item.identity === checkin.identity);
  assert.equal(view.currentKind, 'checkin');
  assert.equal(view.currentActionable, true);
  assert.equal(view.canOpen, true);
});

test('已误判为已验证的签到卡会在状态刷新时恢复为待验证', () => {
  const { job, runner, checkin } = deferredCheckinFixture();
  db.prepare("UPDATE verification_cards SET status='ready',verification_result='passed',source='action_receipt',verified_at=?,checkin_result='unknown' WHERE job_id=? AND identity=?")
    .run(new Date().toISOString(), job.id, checkin.identity);
  const view = runner.workflow.status(job);
  const card = view.cards.find(item => item.identity === checkin.identity);
  assert.equal(card.status, 'pending');
  assert.equal(card.verificationResult, 'pending');
  assert.equal(card.source, 'checkin_unconfirmed');
  assert.equal(getStepAction(job.id, checkin.step_key).verification_pending, 1);
  assert.equal(card.currentActionable, true);
});

test('继续运行会重新排队未确认的签到而不是被 submitted_at 跳过', () => {
  const { job, runner, checkin } = deferredCheckinFixture();
  db.prepare("UPDATE verification_cards SET status='ready',verification_result='passed',source='manual_retry',verified_at=?,checkin_result='pending' WHERE job_id=? AND identity=?")
    .run(new Date().toISOString(), job.id, checkin.identity);
  db.prepare("UPDATE jobs SET status='waiting' WHERE id=?").run(job.id);
  runner.workflow.continue(job.id);
  const action = getStepAction(job.id, checkin.step_key);
  assert.equal(action.state, 'prepared');
  assert.equal(action.submitted_at, null);
  assert.equal(db.prepare('SELECT state FROM task_step_state WHERE job_id=? AND step_key=?').get(job.id, checkin.step_key).state, 'pending');
});

test('结束验证能立即打断签到等待，不会卡住会话', async () => {
  const { job } = fixture([{ type: 'checkin', count: 1 }]);
  const runner = new TaskRunner({ ensureIdentity: async () => ({}),
    checkin: async (_account, _topic, { onSubmit }) => { onSubmit(); return { state: 'uncertain' }; },
    verifyCheckin: async () => ({ state: 'uncertain' }),
    openVerification: async () => ({ isClosed: () => false }),
    hasTaskChallenge: async () => false,
    isVerificationResolved: async () => true
  });
  await runner.run(job.id);
  db.prepare("UPDATE verification_cards SET source='manual_unconfirmed' WHERE job_id=? AND identity='1001'").run(job.id);
  runner.workflow.requestManual(job.id, '1001');
  await until(() => getJob(job.id).cursor.manualVerification?.phase === 'signing_checkin');
  const stopped = runner.workflow.endManual(job.id);
  const result = await Promise.race([stopped.then(() => 'done'), new Promise(resolve => setTimeout(() => resolve('timeout'), 5000))]);
  assert.equal(result, 'done');
  await until(() => !runner.workflow.session);
  const card = runner.workflow.status(getJob(job.id)).cards.find(item => item.identity === '1001');
  assert.equal(card.checkinResult, 'pending');
  const action = db.prepare("SELECT state FROM action_logs WHERE job_id=? AND kind='checkin' AND account_id=(SELECT id FROM accounts WHERE uid='1001')").get(job.id);
  assert.equal(action.state, 'uncertain');
});

test('签到未触发时同一窗口最多触发两次，第二次成功后完成', async () => {
  const { job, topics } = fixture([{ type: 'checkin', count: 1 }]);
  let manual = false, opens = 0, attempts = 0, openedTopic = null;
  const runner = new TaskRunner({
    ensureIdentity: async () => ({}),
    checkin: async (_account, topic, { onSubmit }) => {
      if (!manual) throw new VerificationError('签到需要验证');
      attempts += 1;
      if (attempts < 2) return { state: 'failed', reason: '签到按钮点击没有生效' };
      onSubmit();
      return { state: 'succeeded', url: topic.url };
    },
    verifyCheckin: async () => ({ state: 'uncertain' }),
    openVerification: async (_account, topic) => {
      opens += 1; openedTopic = topic;
      return { context: () => ({}), isClosed: () => false, once: () => {} };
    },
    closeManual: async () => {},
    hasTaskChallenge: async () => false
  });
  await runner.run(job.id);
  manual = true;
  const card = runner.workflow.status(getJob(job.id)).cards.find(item => item.identity === '1001');
  await runner.workflow.requestManual(job.id, card.identity, card.currentStepKey);
  await until(() => !runner.workflow.session);
  assert.equal(opens, 1);
  assert.equal(attempts, 2);
  assert.equal(openedTopic.url, topics[0].url);
  assert.notEqual(openedTopic.url, 'https://weibo.com/');
  assert.equal(getStepAction(job.id, card.currentStepKey).state, 'succeeded');
});

test('工作台评论验证回到对应超话页重新找帖并评论', async () => {
  const { job, topics } = fixture([{ type: 'comment', count: 1 }]);
  let manual = false, opens = 0, forceTopic = false, selected = null, openedInfo = null;
  const runner = new TaskRunner({
    ...candidates(), ensureIdentity: async () => ({}),
    collectCandidates: async () => [{ id: 'new-comment-target', url: 'https://weibo.com/900/new-comment-target', authorUid: '900', commentCount: 0 }],
    inspectCandidate: async (_account, candidate) => candidate,
    comment: async (_account, candidate, _text, options) => {
      if (!manual) throw new VerificationError('评论需要验证');
      selected = candidate;
      options.onSubmit();
      return { state: 'succeeded', url: candidate.url };
    },
    openVerification: async (_account, topic, action) => {
      opens += 1; forceTopic = action.forceTopic === true; openedInfo = { topic: topic.url, actionUrl: action.url };
      return { context: () => ({}), isClosed: () => false, once: () => {} };
    },
    closeManual: async () => {}, hasTaskChallenge: async () => false
  });
  await runner.run(job.id);
  manual = true;
  const card = runner.workflow.status(getJob(job.id)).cards.find(item => item.identity === '1001');
  await runner.workflow.requestManual(job.id, card.identity, card.currentStepKey);
  await until(() => !runner.workflow.session);
  assert.equal(opens, 1);
  assert.equal(forceTopic, true);
  assert.equal(openedInfo.topic, topics[0].url);
  assert.equal(selected.id, 'new-comment-target');
  assert.equal(getStepAction(job.id, card.currentStepKey).target_id, 'new-comment-target');
  assert.equal(getStepAction(job.id, card.currentStepKey).state, 'succeeded');
});
test('已提交待核对的签到在验证通过后补点一次并收尾', async () => {
  const { job } = fixture([{ type: 'checkin', count: 1 }]);
  let challenge = true, resolved = false, clicks = 0;
  const runner = new TaskRunner({ ensureIdentity: async () => ({}),
    checkin: async (_account, _topic, { onSubmit }) => { clicks++; if (challenge) { onSubmit(); throw new VerificationError('微博要求进行安全验证'); } return { state: 'succeeded' }; },
    verifyCheckin: async () => ({ state: 'uncertain' }),
    openVerification: async () => ({ isClosed: () => false }),
    hasTaskChallenge: async () => challenge,
    isVerificationResolved: async () => resolved
  });
  await runner.run(job.id);
  db.prepare("UPDATE verification_cards SET source='manual_unconfirmed' WHERE job_id=? AND identity='1001'").run(job.id);
  assert.equal(db.prepare("SELECT state FROM task_step_state WHERE job_id=? AND identity='1001'").get(job.id).state, 'review');
  assert.equal(runner.workflow.status(getJob(job.id)).cards.find(card => card.identity === '1001').status, 'pending');
  runner.workflow.requestManual(job.id, '1001');
  await until(() => runner.workflow.session?.wake);
  challenge = false; resolved = true;
  await runner.workflow.recheckManual(job.id);
  await until(() => !runner.workflow.session);
  assert.equal(clicks, 3, '两个账号各失败一次后，验证通过只补点一次签到');
  const card = runner.workflow.status(getJob(job.id)).cards.find(item => item.identity === '1001');
  assert.equal(card.checkinResult, 'succeeded');
  assert.equal(card.status, 'resolved');
  assert.equal(card.visible, false);
});

test('scoped runner：签到只挂起本类型；账号验证通过后评论/发帖各只处理当前一步，其余须继续', async () => {
  const { accounts, job } = fixture([{type:'checkin',count:1},{type:'comment',count:2},{type:'post',count:2}]);
  let manual=false, cleared=false, closes=0; const calls=[];
  const action=kind=>async(account,_target,_text,options)=>{
    calls.push(`${manual?'manual':'background'}:${kind}:${account.uid}`);
    if(account.id===accounts[0].id && !cleared) throw new VerificationError(kind+'真实验证码');
    (kind==='checkin'?_text:options)?.onSubmit?.(); return {state:'succeeded'};
  };
  const leases=new AccountLeases();
  const runner=new TaskRunner({...candidates(),ensureIdentity:async()=>({}),browserManager:{closeRunner:async()=>{closes++;}},
    checkin:action('checkin'),comment:action('comment'),post:action('post'),
    verifyCheckin:async()=>({state:'uncertain'}),openVerification:async()=>({isClosed:()=>false}),hasTaskChallenge:async()=>false
  },{scope:'workbench',leases});
  await runner.run(job.id);
  assert.deepEqual(calls.filter(s=>s.startsWith('background:')&&s.endsWith(':1001')),['background:checkin:1001','background:comment:1001','background:post:1001']);
  assert.equal(leases.owners.size,0);assert.ok(closes>=3);
  manual=true;cleared=true;
  for(const kind of ['checkin','comment','post']) {
    const card=runner.workflow.status(getJob(job.id)).cards.find(c=>c.identity==='1001');
    assert.equal(card.currentKind,kind);
    runner.workflow.requestManual(job.id,'1001',card.currentStepKey);await until(()=>!runner.workflow.session);
    const after = runner.workflow.status(getJob(job.id));
    assert.equal(after.cards.find(c=>c.identity==='1001').verificationResult, kind === 'post' ? 'passed' : 'pending');
    assert.equal(after.canContinue, true);
    assert.equal(calls.filter(s=>s===`manual:${kind}:1001`).length,1);
  }
  const unfinished=runner.workflow.rows(job.id,0).filter(r=>r.identity==='1001'&&r.state==='deferred');assert.equal(unfinished.length,2);
  assert.equal(calls.filter(s=>s.startsWith('manual:')).length,3);
  runner.workflow.continue(job.id);await until(()=>getJob(job.id).status==='completed'); await runner.promise;
  assert.equal(calls.filter(s=>s==='manual:comment:1001').length,2);assert.equal(calls.filter(s=>s==='manual:post:1001').length,2);assert.equal(leases.owners.size,0);
});

test('签到连续两次真实验证码解除各补点一次；重新检测/轮询/重开不会重复授予额度', async () => {
  const {accounts,job}=fixture([{type:'checkin',count:1}]);
  let manual=false, challenge=false, clicks=0, checked=false, clock=Date.now();
  const runner=new TaskRunner({ensureIdentity:async()=>({}),
    checkin:async(account,_topic,{onSubmit})=>{
      if(account.id!==accounts[0].id)return {state:'succeeded'};
      if(!manual)throw new VerificationError('后台验证码');
      onSubmit(); clicks++;
      if(clicks===1){challenge=true;throw new VerificationError('第二次验证码');}
      return {state:'uncertain'};
    },verifyCheckin:async()=>({state:checked?'succeeded':'uncertain'}),
    openVerification:async()=>({isClosed:()=>false}),hasTaskChallenge:async()=>challenge,isVerificationResolved:async()=>!challenge
  },{scope:'workbench',leases:new AccountLeases(),now:()=>clock});
  await runner.run(job.id);
  db.prepare("UPDATE verification_cards SET source='manual_unconfirmed' WHERE job_id=? AND identity='1001'").run(job.id);
  manual=true;
  try {
    runner.workflow.requestManual(job.id,'1001');await until(()=>clicks===1&&runner.workflow.session?.wake);
    assert.equal(getJob(job.id).cursor.manualVerification.phase,'challenge');
    challenge=false;clock+=6000;await runner.workflow.recheckManual(job.id);
    await until(()=>clicks===2&&runner.workflow.session?.wake);
    await runner.workflow.recheckManual(job.id);clock+=6000;
    runner.workflow.session?.wake?.();await until(()=>runner.workflow.session?.wake);
    assert.equal(clicks,2,'没有新验证码，不可第三次点击');
    await runner.workflow.endManual(job.id);
    runner.workflow.requestManual(job.id,'1001');await until(()=>runner.workflow.session?.wake);assert.equal(clicks,3,'再次验证允许重新触发一次签到');
    checked=true;runner.workflow.session.wake();await until(()=>!runner.workflow.session);
    assert.equal(clicks,3);assert.equal(getJob(job.id).metrics.success,2);
  } finally {await runner.workflow.endManual(job.id);}
});

test('评论和发帖验证卡首次点击都会重新触发当前操作', async () => {
  for(const kind of ['comment','post']) {
    clearAllDataForTests();setSetting('task_defaults',defaultTaskConfig);
    const {accounts,job}=fixture([{type:kind,count:1}]);let clicks=0,reads=0;const order=[];
    const runner=new TaskRunner({...candidates(),ensureIdentity:async()=>({}),
      [kind]:async(account,_target,_text,options)=>{options.onSubmit();clicks++;if(account.id===accounts[0].id)throw new VerificationError('提交后验证码，结果未知');return{state:'succeeded'};},
      openVerification:async()=>{order.push('open');return{isClosed:()=>false};},hasTaskChallenge:async()=>false,
      verifyComment:async()=>{order.push('verify');reads++;return{state:'uncertain'};},verifyPost:async()=>{order.push('verify');reads++;return{state:'uncertain'};}
    });
    await runner.run(job.id);
    runner.workflow.waitForManualSubmission = async () => {};
    await runner.workflow.requestManual(job.id,'1001');await until(()=>!runner.workflow.session);
    assert.ok(clicks>=2,'首次验证必须实际触发当前操作');
    const clicksAfterVerification=clicks;
    assert.equal(order[0],'open','必须先打开验证窗口再执行操作');
    assert.equal(runner.workflow.status(getJob(job.id)).cards[0].source,'manual_unconfirmed');
    runner.workflow.continue(job.id);await until(()=>getJob(job.id).status==='waiting');assert.equal(clicks,clicksAfterVerification);
    assert.equal(runner.workflow.rows(job.id,0).find(r=>r.identity==='1001').outcome,'uncertain');
  }
});

test('旧版未提交签到验证行迁移为一次补点资格，已签到只读确认不再点击',async()=>{
  for(const alreadyDone of [false,true]) {
    clearAllDataForTests();setSetting('task_defaults',defaultTaskConfig);
    const {accounts,job}=fixture([{type:'checkin',count:1}]);let manual=false,clicks=0;
    const runner=new TaskRunner({ensureIdentity:async()=>({}),checkin:async account=>{
      if(account.id===accounts[0].id&&!manual)throw new VerificationError('旧版签到验证');
      if(manual)clicks++;return{state:'succeeded'};
    },verifyCheckin:async()=>({state:alreadyDone?'succeeded':'uncertain'}),openVerification:async()=>({isClosed:()=>false}),hasTaskChallenge:async()=>false});
    await runner.run(job.id);
    const cursor={...getJob(job.id).cursor};delete cursor.checkinVerificationCycles;database.updateJob(job.id,{cursor});
    manual=true;runner.workflow.requestManual(job.id,'1001');await until(()=>!runner.workflow.session);
    assert.equal(clicks,alreadyDone?0:1);assert.equal(runner.workflow.rows(job.id,0).find(r=>r.identity==='1001').outcome,'succeeded');
  }
});

test('仅恢复当前轮匹配可信 20067 的旧工作台发帖；无二次尝试，且恢复幂等', async () => {
  const { job } = fixture([{ type: 'post', count: 6 }]);
  const runner = new TaskRunner({}, {scope:'workbench'});
  runner.workflow.ensureSteps(job);
  const rows = runner.workflow.rows(job.id, 0).filter(row => row.identity === '1001');
  const original = [];
  for (const [i, row] of rows.entries()) {
    const actionId = database.createActionLog({ jobId: job.id, stepKey: row.step_key, kind: 'post', accountId: row.account_id,
      topicId: row.topic_id, content: '原始文案' + i, state: 'prepared', sequenceNumber: i + 1, sequenceConfirmed: true });
    const attemptId = 'original-' + i;
    database.beginPostAttempt(actionId, attemptId);
    database.updateActionLog(actionId, {state:'submitted', submittedAt: new Date().toISOString()});
    const error = new VerificationError('待安全验证'); error.submittedUncertain = true;
    const step = buildSteps(job.config).find(step => step.accountId === row.account_id && step.unitIndex === row.unit_index);
    runner.workflow.defer(job.id, step, error);
    db.prepare('UPDATE task_step_state SET attempts=? WHERE job_id=? AND step_key=?').run(i === 4 ? 2 : 1, job.id, row.step_key);
    if (i === 5) database.updateActionLog(actionId, { receiptId: '已有凭据' });
    const event = { actionId, attemptId: i === 1 ? 'old-attempt' : attemptId, path:'/ajax/statuses/update',
      code:'20067', httpStatus:400, kind:'verification', message:i === 2 ? 'Request body could not be verified' : 'Response classified' };
    database.log('info', '发帖回执：' + JSON.stringify(event));
    if (i === 3) database.log('info', '发帖回执：' + JSON.stringify({...event, code:null, kind:'unknown'}));
    original.push(getStepAction(job.id, row.step_key));
  }
  const fresh = getJob(job.id);
  database.updateJob(job.id, { status:'waiting', cursor:{...fresh.cursor, verificationBarrier:true} });
  assert.equal(new TaskRunner({}, {scope:'engage'}).workflow.restoreRejectedWorkbenchPosts(job.id), 0);
  assert.equal(runner.workflow.restoreRejectedWorkbenchPosts(job.id), 1);
  assert.equal(runner.workflow.restoreRejectedWorkbenchPosts(job.id), 0);
  const recovered = getStepAction(job.id, rows[0].step_key);
  for (const key of ['id','attempt_id','sequence_number','sequence_confirmed','content','submitted_at']) assert.equal(recovered[key], original[0][key]);
  assert.equal(recovered.state, 'verification_wait');
  assert.equal(runner.workflow.rows(job.id, 0)[0].state, 'deferred');
  for (let i = 1; i < rows.length; i++) assert.deepEqual(getStepAction(job.id, rows[i].step_key), original[i]);
  assert.equal(getJob(job.id).status, 'waiting');
  assert.equal(runner.workflow.status(getJob(job.id)).canContinue, true);
  assert.equal(runner.workflow.session, null);
});

for (const kind of ['post', 'comment']) test('工作台浏览器验证契约：' + kind + ' 后台明确被拦截，卡片只触发原动作一次', async () => {
  const { topics, job } = fixture([{type:kind,count:1}]);
  db.prepare('UPDATE topics SET url=?,name=? WHERE id=?').run('https://weibo.com/p/100808fixture', '测试超话', topics[0].id);
  const requests = [], launches = [];
  const clickCounts = [];
  const manager = new BrowserManager(async ({profile, options}) => {
    const uid = profile.includes(job.config.accountIds[0]) ? '1001' : '1002';
    const manual = !options.headless;
    const context = await chromium.launchPersistentContext(profile, {...options, headless:true});
    launches.push({uid,manual,context});
    await context.route('**/*', route => {
      const url = new URL(route.request().url());
      if (url.hostname !== 'weibo.com') return route.abort();
      if (url.pathname === '/ajax/stopic/list') return route.fulfill({json:{data:[{title:'测试',page_id:'100808fixture'}]}});
      if (url.pathname === '/ajax/statuses/update' || url.pathname === '/ajax/comments/create') {
        const body = route.request().postDataJSON();
        requests.push({uid,manual,body});
        return route.fulfill(uid === '1001' && !body.verified
          ? {status:400,json:{error_code:20067,message:'For your safety, please verify your account',validate:{challenge:'fixture'}}}
          : {json:{ok:1,data:{idstr:uid === '1001' ? '5359362629435909' : '5359362629435910'}}});
      }
      if (url.pathname === '/fixture-click') { clickCounts.push({uid,manual}); return route.fulfill({body:''}); }
      const script = `
        <script>window.$CONFIG={uid:'${uid}',user:{screen_name:'fixture'}};
        async function send(verified) {
          if (!verified) await fetch('/fixture-click');
          const text=document.querySelector('textarea').value;
          const body=${kind === 'post' ? "{status:text,page_id:'100808fixture',verified}" : `{comment:text,id:'${weiboShortIdToNumeric(uid === '1001' ? 'AbCdE1' : 'AbCdE2')}',verified}`};
          const r=await fetch('${kind === 'post' ? '/ajax/statuses/update' : '/ajax/comments/create'}',{method:'POST',body:JSON.stringify(body)});
          if (!r.ok) document.querySelector('#captcha').hidden=false;
        }</script>
        <div hidden id="captcha" class="geetest_panel">请完成安全验证
          <button onclick="this.parentElement.hidden=true;send(true)">模拟通过</button></div>`;
      const composer = kind === 'post' ? `<button>更多</button><button>超话</button>
        <div class="woo-modal-wrap"><button>选择超话</button><input placeholder="搜索超话" oninput="fetch('/ajax/stopic/list')">
        <div class="_h3_fixture" onclick="document.querySelector('textarea').value='测试[超话]'">测试</div>
        <textarea placeholder="掐指一算，此贴必火"></textarea><label><input type="checkbox">同步到微博</label>
        <button onclick="send(false)">发送</button></div>` : `<div><div><div><textarea placeholder="发布你的评论"></textarea>
        <button onclick="send(false)">评论</button></div></div></div>`;
      return route.fulfill({contentType:'text/html; charset=utf-8',body:script+composer});
    });
    return context;
  }, {headless:true, activate:async()=>{}});
  const adapter = new WeiboAdapter(manager);
  adapter.collectCandidates = async account => {
    const id = account.uid === '1001' ? 'AbCdE1' : 'AbCdE2';
    return [{id,url:'https://weibo.com/900/'+id,authorUid:'900',commentCount:0}];
  };
  adapter.inspectCandidate = async (_a, candidate) => candidate;
  const runner = new TaskRunner(adapter, {scope:'workbench',leases:new AccountLeases()});
  try {
    await runner.run(job.id);
    const card = runner.workflow.status(getJob(job.id)).cards.find(item => item.identity === '1001');
    const before = getStepAction(job.id, card.currentStepKey);
    assert.equal(before.state, 'verification_wait');
    assert.equal(runner.workflow.status(getJob(job.id)).canContinue, true);
    assert.ok(launches.filter(item => !item.manual).every(item => !item.context.pages().length));
    runner.workflow.requestManual(job.id,'1001',card.currentStepKey);
    await until(() => requests.some(item => item.uid === '1001' && item.manual) && runner.workflow.session?.wake, 30000);
    const page = runner.workflow.session.page;
    assert.equal(runner.workflow.status(getJob(job.id)).canContinue, false);
    await page.getByRole('button',{name:'模拟通过'}).click();
    await until(() => !runner.workflow.session && !runner.workflow.manualCleanupPromise, 15000);
    const after = getStepAction(job.id, card.currentStepKey);
    assert.equal(after.state, 'succeeded');
    assert.equal(after.content, before.content);
    assert.equal(after.target_id, before.target_id);
    assert.equal(after.receipt_id, '5359362629435909');
    assert.equal(getJob(job.id).metrics.success, 2);
    const own = requests.filter(item => item.uid === '1001');
    assert.deepEqual(own.map(item => [item.manual,item.body.verified]),[[false,false],[true,false],[true,true]]);
    assert.deepEqual(own[1].body, own[0].body);
    assert.equal(clickCounts.filter(item => item.uid === '1001' && item.manual).length,1);
    assert.equal(launches.filter(item => item.manual).length,1);
    assert.equal(runner.workflow.status(getJob(job.id)).canContinue,true);
  } finally { await runner.workflow.endManual(job.id); await manager.close(); }
});

test('原创直接填写主页输入框并在按钮启用后提交一次', async () => {
  const account = updateAccountAuth(createAccount('原创账号').id, { status: 'valid', uid: '2407', nickname: '原创账号' });
  const profile = fs.mkdtempSync(path.join(data, 'original-home-'));
  let sends = 0, sentText = '', sentDisabled = false;
  const manager = new BrowserManager(async ({ options }) => {
    const context = await chromium.launchPersistentContext(profile, { ...options, headless: true });
    await context.route('**/*', route => {
      const url = new URL(route.request().url());
      if (url.hostname !== 'weibo.com') return route.abort();
      if (url.pathname === '/ajax/statuses/update') {
        sends += 1;
        sentText = route.request().postDataJSON().status;
        sentDisabled = context.pages()[0]?.evaluate?.(() => document.querySelector('button')?.disabled).catch(() => false);
        return route.fulfill({ json: { ok: 1, data: { idstr: '5359362629436020' } } });
      }
      return route.fulfill({ contentType: 'text/html; charset=utf-8', body: `
        <script>window.$CONFIG={uid:'2407',user:{screen_name:'fixture'}};</script>
        <div id="homeWrap" class="_wrap"><div class="publish">
          <textarea placeholder="有什么新鲜事想分享给大家？" oninput="document.querySelector('#send').disabled=!this.value.trim()"></textarea>
          <button id="send" disabled onclick="fetch('/ajax/statuses/update',{method:'POST',body:JSON.stringify({status:document.querySelector('textarea').value})})">发送</button>
        </div></div>` });
    });
    return context;
  }, { headless: true, activate: async () => {} });
  try {
    let submitted = 0;
    const result = await new WeiboAdapter(manager).originalPost(account, '原创正文',
      { onSubmit: () => { submitted += 1; } });
    assert.equal(result.state, 'succeeded');
    assert.equal(submitted, 1);
    assert.equal(sends, 1);
    assert.equal(sentText, '原创正文');
  } finally { await manager.close(); }
});

test('主页已有其他原创草稿时保留原内容且不发送', async () => {
  const account = updateAccountAuth(createAccount('原创草稿账号').id, { status: 'valid', uid: '2408', nickname: '原创草稿账号' });
  const profile = fs.mkdtempSync(path.join(data, 'original-draft-'));
  let sends = 0;
  const manager = new BrowserManager(async ({ options }) => {
    const context = await chromium.launchPersistentContext(profile, { ...options, headless: true });
    await context.route('**/*', route => {
      const url = new URL(route.request().url());
      if (url.hostname !== 'weibo.com') return route.abort();
      if (url.pathname === '/ajax/statuses/update') { sends += 1; return route.fulfill({ json: { ok: 1 } }); }
      return route.fulfill({ contentType: 'text/html; charset=utf-8', body: `
        <script>window.$CONFIG={uid:'2408',user:{screen_name:'fixture'}};</script>
        <div id="homeWrap"><textarea placeholder="有什么新鲜事想分享给大家？">旧草稿</textarea><button disabled>发送</button></div>` });
    });
    return context;
  }, { headless: true, activate: async () => {} });
  try {
    await assert.rejects(new WeiboAdapter(manager).originalPost(account, '新原创正文'), /保留原内容/);
    assert.equal(sends, 0);
  } finally { await manager.close(); }
});

test('发帖超话搜索忽略旧响应，按page_id对应显示别名卡片并只提交一次', async () => {
  const account = updateAccountAuth(createAccount('超话搜索账号').id, { status: 'valid', uid: '2201', nickname: '超话搜索账号' });
  const topic = createTopic({ name: '测试超话', url: 'https://weibo.com/p/100808fixture' });
  const profile = fs.mkdtempSync(path.join(data, 'topic-search-'));
  let searches = 0, sends = 0;
  const manager = new BrowserManager(async ({ options }) => {
    const context = await chromium.launchPersistentContext(profile, { ...options, headless: true });
    await context.route('**/*', route => {
      const url = new URL(route.request().url());
      if (url.hostname !== 'weibo.com') return route.abort();
      if (url.pathname === '/ajax/stopic/list') {
        searches += 1;
        return route.fulfill({ json: { data: [{ title: '测试', page_id: searches === 1 ? '100808stale' : '100808fixture' }] } });
      }
      if (url.pathname === '/ajax/statuses/update') {
        sends += 1;
        return route.fulfill({ json: { ok: 1, data: { idstr: '5359362629435999' } } });
      }
      return route.fulfill({ contentType: 'text/html; charset=utf-8', body: `
        <script>window.$CONFIG={uid:'2201',user:{screen_name:'fixture'}};</script>
        <button>更多</button><button>超话</button>
        <div class="woo-modal-wrap"><button>选择超话</button>
          <input placeholder="搜索超话" oninput="fetch('/ajax/stopic/list')">
          <div class="_h3_fixture" onclick="document.querySelector('textarea').value='测试[超话]'">测试</div>
          <textarea placeholder="掐指一算，此贴必火">测试[超话]</textarea><label><input type="checkbox">同步到微博</label>
          <button onclick="fetch('/ajax/statuses/update',{method:'POST',body:JSON.stringify({status:document.querySelector('textarea').value,page_id:'100808fixture'})})">发送</button>
        </div>` });
    });
    return context;
  }, { headless: true, activate: async () => {} });
  try {
    const adapter = new WeiboAdapter(manager);
    let submitted = 0;
    const result = await adapter.post(account, topic, '正文', { onSubmit: () => { submitted += 1; } });
    assert.equal(result.state, 'succeeded');
    assert.equal(submitted, 1);
    assert.equal(sends, 1);
    assert.ok(searches >= 2, '必须忽略旧搜索响应并等待目标响应');
  } finally { await manager.close(); }
});

test('精确目标标题唯一时不被带超话后缀的另一条接口结果误判为歧义', async () => {
  const account = updateAccountAuth(createAccount('精确标题账号').id, { status: 'valid', uid: '2207', nickname: '精确标题账号' });
  const topic = createTopic({ name: '苏新皓', url: 'https://weibo.com/p/100808fixture' });
  const profile = fs.mkdtempSync(path.join(data, 'topic-exact-title-suffix-'));
  let sends = 0, sentText = '';
  const items = Array.from({ length: 20 }, (_, index) => ({ title: `其他超话${index}`, page_id: `100808other${index}` }));
  items[0] = { title: '苏新皓', page_id: '100808fixture' };
  items[17] = { title: '苏新皓超话', page_id: '100808other17' };
  const manager = new BrowserManager(async ({ options }) => {
    const context = await chromium.launchPersistentContext(profile, { ...options, headless: true });
    await context.route('**/*', route => {
      const url = new URL(route.request().url());
      if (url.hostname !== 'weibo.com') return route.abort();
      if (url.pathname === '/ajax/stopic/list') return route.fulfill({ json: { data: items } });
      if (url.pathname === '/ajax/statuses/update') {
        sends += 1; sentText = route.request().postDataJSON().status;
        return route.fulfill({ json: { ok: 1, data: { idstr: '5359362629436010' } } });
      }
      return route.fulfill({ contentType: 'text/html; charset=utf-8', body: `
        <script>window.$CONFIG={uid:'2207',user:{screen_name:'fixture'}};</script>
        <button>更多</button><button>超话</button>
        <div class="woo-modal-wrap"><button>选择超话</button><input placeholder="搜索超话" oninput="fetch('/ajax/stopic/list')">
          <div class="_h3_fixture" onclick="document.querySelector('textarea').value='苏新皓[超话]'">苏新皓</div>
          <div class="_h3_fixture">苏新皓周边中转站</div><div class="_h3_fixture">信号满格苏新皓</div>
          <div class="_h3_fixture">全能ACE苏新皓</div><div class="_h3_fixture">苏新皓帅帅</div>
          <textarea placeholder="掐指一算，此贴必火"></textarea><label><input type="checkbox">同步到微博</label>
          <button onclick="fetch('/ajax/statuses/update',{method:'POST',body:JSON.stringify({status:document.querySelector('textarea').value,page_id:'100808fixture'})})">发送</button>
        </div>` });
    });
    return context;
  }, { headless: true, activate: async () => {} });
  try {
    const result = await new WeiboAdapter(manager).post(account, topic, '精确标题测试正文');
    assert.equal(result.state, 'succeeded');
    assert.equal(sends, 1);
    assert.equal(sentText, '苏新皓[超话]精确标题测试正文');
  } finally { await manager.close(); }
});

test('发帖准备遇到重复同名卡片无法唯一对应时不发送且不重复打开弹层', async () => {
  const account = updateAccountAuth(createAccount('超话歧义账号').id, { status: 'valid', uid: '2203', nickname: '超话歧义账号' });
  const topic = createTopic({ name: '测试超话', url: 'https://weibo.com/p/100808fixture' });
  const profile = fs.mkdtempSync(path.join(data, 'topic-ambiguous-'));
  let prepareClicks = 0, sends = 0;
  const manager = new BrowserManager(async ({ options }) => {
    const context = await chromium.launchPersistentContext(profile, { ...options, headless: true });
    await context.route('**/*', route => {
      const url = new URL(route.request().url());
      if (url.hostname !== 'weibo.com') return route.abort();
      if (url.pathname === '/ajax/stopic/list') return route.fulfill({ json: { data: [{ title: '测试', page_id: '100808fixture' }] } });
      if (url.pathname === '/ajax/statuses/update') { sends += 1; return route.fulfill({ json: { ok: 1, data: { idstr: '5359362629436002' } } }); }
      if (url.pathname === '/fixture-prepare') { prepareClicks += 1; return route.fulfill({ body: '' }); }
      return route.fulfill({ contentType: 'text/html; charset=utf-8', body: `
        <script>window.$CONFIG={uid:'2203',user:{screen_name:'fixture'}};</script>
        <button onclick="fetch('/fixture-prepare')">更多</button><button>超话</button>
        <div class="woo-modal-wrap"><button>选择超话</button>
          <input placeholder="搜索超话" oninput="fetch('/ajax/stopic/list')">
          <div class="_h3_fixture">测试</div><div class="_h3_fixture">测试</div>
          <textarea placeholder="掐指一算，此贴必火"></textarea><label><input type="checkbox">同步到微博</label><button>发送</button>
        </div>` });
    });
    return context;
  }, { headless: true, activate: async () => {} });
  try {
    const adapter = new WeiboAdapter(manager);
    await assert.rejects(adapter.post(account, topic, '正文'), /不能唯一识别超话搜索结果/);
    assert.equal(prepareClicks, 3);
    assert.equal(sends, 0);
  } finally { await manager.close(); }
});

test('同步到微博被遮挡时安全切换，不等待普通点击超时', async () => {
  const account = updateAccountAuth(createAccount('同步选项账号').id, { status: 'valid', uid: '2204', nickname: '同步选项账号' });
  const topic = createTopic({ name: '测试超话', url: 'https://weibo.com/p/100808fixture' });
  const profile = fs.mkdtempSync(path.join(data, 'sync-toggle-'));
  let body = null;
  const manager = new BrowserManager(async ({ options }) => {
    const context = await chromium.launchPersistentContext(profile, { ...options, headless: true });
    await context.route('**/*', route => {
      const url = new URL(route.request().url());
      if (url.hostname !== 'weibo.com') return route.abort();
      if (url.pathname === '/ajax/stopic/list') return route.fulfill({ json: { data: [{ title: '测试', page_id: '100808fixture' }] } });
      if (url.pathname === '/ajax/statuses/update') {
        body = route.request().postDataJSON();
        return route.fulfill({ json: { ok: 1, data: { idstr: '5359362629436003' } } });
      }
      return route.fulfill({ contentType: 'text/html; charset=utf-8', body: `
        <script>window.$CONFIG={uid:'2204',user:{screen_name:'fixture'}};</script>
        <span style="position:relative;display:inline-block"><button>更多</button><div class="woo-modal-mask" style="position:absolute;inset:0;z-index:2"></div></span><button>超话</button>
        <div class="woo-modal-wrap"><button>选择超话</button>
          <input placeholder="搜索超话" oninput="fetch('/ajax/stopic/list')">
          <div class="_h3_fixture" onclick="document.querySelector('textarea').value='测试[超话]'">测试</div>
          <textarea placeholder="掐指一算，此贴必火"></textarea>
          <div style="position:relative;display:inline-block"><label><input type="checkbox" checked>同步到微博</label><span style="position:absolute;inset:0;z-index:2"></span></div>
          <button onclick="fetch('/ajax/statuses/update',{method:'POST',body:JSON.stringify({status:document.querySelector('textarea').value,page_id:'100808fixture',sync:document.querySelector('input[type=checkbox]').checked})})">发送</button>
        </div>` });
    });
    return context;
  }, { headless: true, activate: async () => {} });
  try {
    const adapter = new WeiboAdapter(manager);
    const started = Date.now();
    const result = await adapter.post(account, topic, '正文', { syncToHome: false });
    assert.equal(result.state, 'succeeded');
    assert.equal(body?.sync, false);
    assert.ok(Date.now() - started < 10000, '同步选项不得阻塞到分钟级');
  } finally { await manager.close(); }
});

test('转发无回执时只按目标、文案和时间窗口匹配近期微博', async () => {
  const account = updateAccountAuth(createAccount('转发复核账号').id, { status: 'valid', uid: '2202', nickname: '转发复核账号' });
  const profile = fs.mkdtempSync(path.join(data, 'repost-readback-'));
  const link = 'https://weibo.com/7449968177/RoF58iVPk';
  const targetId = weiboShortIdToNumeric('RoF58iVPk');
  const now = Date.now();
  const manager = new BrowserManager(async ({ options }) => {
    const context = await chromium.launchPersistentContext(profile, { ...options, headless: true });
    await context.route('**/*', route => {
      const url = new URL(route.request().url());
      if (url.hostname !== 'weibo.com') return route.abort();
      if (url.pathname === '/ajax/statuses/mymblog') return route.fulfill({ json: { data: { list: [{
        idstr: '5359362629436001', user: { idstr: '2202' }, retweeted_status: { idstr: targetId },
        text_raw: '转发正文', created_at: new Date(now).toISOString()
      }] } } });
      return route.fulfill({ contentType: 'text/html; charset=utf-8', body: `<script>window.$CONFIG={uid:'2202',user:{screen_name:'fixture'}};</script>` });
    });
    return context;
  }, { headless: true, activate: async () => {} });
  try {
    const adapter = new WeiboAdapter(manager);
    const result = await adapter.verifyRepost(account, { link, content: '转发正文',
      started_at: new Date(now - 10000).toISOString(), submitted_at: new Date(now - 5000).toISOString() });
    assert.equal(result.state, 'succeeded');
    assert.equal(result.receiptId, '5359362629436001');
    assert.equal(result.successSource, 'recent_repost_match');
  } finally { await manager.close(); }
});

test('人工验证后发帖准备失败保留可重试卡，不重复提交且失败数不增加', async () => {
  const { accounts, job } = fixture([{ type: 'post', count: 1 }]);
  const account = accounts[0];
  let mode = 'background', submits = 0, opens = 0;
  const runner = new TaskRunner({
    ensureIdentity: async item => ({ uid: item.uid, status: 'valid' }),
    browserManager: { closeRunner: async () => {} },
    post: async (_account, _topic, _content, options) => {
      if (mode === 'background') throw new VerificationError('需要验证');
      if (mode === 'manual_fail') throw new UnsupportedPageError('不能唯一核对所选超话的标识，未发送');
      submits += 1; options.onSubmit();
      return { state: 'succeeded', receiptId: '5359362629436000', receiptUrl: 'https://weibo.com/detail/5359362629436000' };
    },
    openVerification: async () => { opens += 1; return { context: () => ({}), isClosed: () => false, once: () => {} }; },
    closeManual: async () => {},
    hasTaskChallenge: async () => false
  }, { scope: 'workbench', leases: new AccountLeases() });
  try {
    await runner.run(job.id);
    let card = runner.workflow.status(getJob(job.id)).cards.find(item => item.identity === account.uid);
    mode = 'manual_fail';
    await assert.rejects(runner.workflow.requestManual(job.id, account.uid, card.currentStepKey), /已尝试 1\/1 次/);
    await until(() => opens === 1 && !runner.workflow.session, 10000);
    card = runner.workflow.status(getJob(job.id)).cards.find(item => item.identity === account.uid);
    assert.equal(card.verificationResult, 'pending');
    assert.equal(card.currentActionable, true);
    assert.match(card.reason, /已尝试 1\/1 次/);
    assert.equal(submits, 0);
    assert.equal(getJob(job.id).metrics.failed, 0);
    const row = db.prepare('SELECT state FROM task_step_state WHERE job_id=? AND step_key=?').get(job.id, card.currentStepKey);
    assert.equal(row.state, 'review');
    mode = 'manual_success';
    runner.workflow.requestManual(job.id, account.uid, card.currentStepKey);
    await until(() => opens === 2 && !runner.workflow.session, 10000);
    assert.equal(submits, 1);
    assert.equal(getStepAction(job.id, card.currentStepKey).state, 'succeeded');
    assert.equal(getJob(job.id).metrics.success, 1);
  } finally { await runner.workflow.endManual(job.id); }
});

test('已提交未知发帖首次点击直接打开窗口并重新发帖', async () => {
  const { accounts, job } = fixture([{ type: 'post', count: 1 }]);
  const account = accounts[0];
  let writes = 0, opens = 0, rechecks = 0;
  const runner = new TaskRunner({
    ensureIdentity: async item => ({ uid: item.uid, status: 'valid' }),
    browserManager: { closeRunner: async () => {} },
    post: async (_account, _topic, _content, options) => {
      writes += 1;
      options.onSubmit();
      if (writes === 1) throw new VerificationError('需要验证');
      return { state: 'succeeded', receiptId: '5359362629439998', receiptUrl: 'https://weibo.com/detail/5359362629439998' };
    },
    openVerification: async () => { opens += 1; return { context: () => ({}), isClosed: () => false, once: () => {} }; },
    closeManual: async () => {},
    hasTaskChallenge: async () => false
  }, { scope: 'workbench', leases: new AccountLeases() });
  await runner.run(job.id);
  const writesBeforeManual = writes;
  const card = runner.workflow.status(getJob(job.id)).cards.find(item => item.identity === account.uid);
  const action = db.prepare('SELECT * FROM action_logs WHERE job_id=? AND step_key=?').get(job.id, card.currentStepKey);
  db.prepare("UPDATE action_logs SET state='uncertain',submitted_at=? WHERE id=?").run(new Date().toISOString(), action.id);
  runner.workflow.recheckRow = async () => { rechecks += 1; return { state: 'uncertain' }; };
  await runner.workflow.requestManual(job.id, account.uid, card.currentStepKey);
  await until(() => !runner.workflow.session, 10000);
  assert.equal(writes, writesBeforeManual + 1, '第一次点击必须重新发帖');
  assert.equal(opens, 1, '第一次点击必须打开验证窗口');
  assert.equal(rechecks, 0, '首次验证不得先做只读复核');
  const passed = runner.workflow.status(getJob(job.id)).cards.find(item => item.identity === account.uid);
  assert.equal(passed.verificationResult, 'passed');
});

test('人工验证后晚到的发帖成功回执直接把验证卡标记通过', async () => {
  const { accounts, job } = fixture([{ type: 'post', count: 1 }]);
  const runner = new TaskRunner({
    ensureIdentity: async () => ({}),
    post: async account => { if (account.id === accounts[0].id) throw new VerificationError('需要验证'); return { state: 'succeeded' }; },
    openVerification: async () => ({ context: () => ({}), isClosed: () => false, once: () => {} }),
    hasTaskChallenge: async () => false,
    closeManual: async () => {}
  }, { scope: 'workbench', leases: new AccountLeases() });
  await runner.run(job.id);
  const card = runner.workflow.status(getJob(job.id)).cards.find(item => item.identity === '1001');
  const action = getStepAction(job.id, card.currentStepKey);
  runner.settlePostAction(action.id, {
    state: 'succeeded', receiptId: '5363450649774055', receiptUrl: 'https://weibo.com/detail/5363450649774055',
    successSource: 'api_receipt', attemptId: action.attempt_id,
  });
  const passed = runner.workflow.status(getJob(job.id)).cards.find(item => item.identity === '1001');
  assert.equal(passed.verificationResult, 'passed');
  assert.ok(passed.verifiedAt);
  assert.equal(passed.status, 'ready');
  assert.match(passed.reason, /发帖已完成/);
});

test('验证卡首次点击打开窗口失败时保持待验证并允许重试', async () => {
  const { accounts, job } = fixture([{ type: 'post', count: 1 }]);
  let writes = 0, openAttempts = 0;
  const runner = new TaskRunner({
    ensureIdentity: async item => ({ uid: item.uid, status: 'valid' }),
    browserManager: { closeRunner: async () => {} },
    post: async () => { writes += 1; throw new VerificationError('需要验证'); },
    openVerification: async () => { openAttempts += 1; throw new Error('验证窗口打开失败'); },
    closeManual: async () => {}, hasTaskChallenge: async () => false
  }, { scope: 'workbench', leases: new AccountLeases() });
  await runner.run(job.id);
  const card = runner.workflow.status(getJob(job.id)).cards.find(item => item.identity === accounts[0].uid);
  db.prepare("UPDATE action_logs SET state='uncertain',submitted_at=? WHERE job_id=? AND step_key=?")
    .run(new Date().toISOString(), job.id, card.currentStepKey);
  const before = writes;
  await assert.rejects(runner.workflow.requestManual(job.id, card.identity, card.currentStepKey), /验证窗口打开失败/);
  await until(() => !runner.workflow.session, 10000);
  assert.equal(openAttempts, 1);
  assert.equal(writes, before, '窗口未打开时不得执行发帖');
  const pending = runner.workflow.status(getJob(job.id)).cards.find(item => item.identity === accounts[0].uid);
  assert.equal(pending.verificationResult, 'pending');
  assert.equal(pending.canOpen, true);
});

test('历史“已验证但发帖未发送”卡片自动恢复为安全重试且幂等', async () => {
  const { accounts, job } = fixture([{ type: 'post', count: 1 }]);
  const account = accounts[0];
  const runner = new TaskRunner({
    ensureIdentity: async item => ({ uid: item.uid, status: 'valid' }),
    browserManager: { closeRunner: async () => {} },
    post: async () => { throw new VerificationError('需要验证'); },
    openVerification: async () => ({ context: () => ({}), isClosed: () => false, once: () => {} }),
    hasTaskChallenge: async () => false
  }, { scope: 'workbench', leases: new AccountLeases() });
  await runner.run(job.id);
  let card = runner.workflow.status(getJob(job.id)).cards.find(item => item.identity === account.uid);
  const action = getStepAction(job.id, card.currentStepKey);
  db.prepare("UPDATE action_logs SET state='failed',verification_pending=0,submitted_at=NULL,completed_at=?,error=? WHERE id=?")
    .run('2026-11-07T10:00:00.000Z', '不能唯一核对所选超话的标识，未发送', action.id);
  db.prepare("UPDATE task_step_state SET state='done',outcome='failed' WHERE job_id=? AND step_key=?").run(job.id, card.currentStepKey);
  db.prepare("UPDATE verification_cards SET status='ready',verification_result='passed',verified_at=?,reason=? WHERE job_id=? AND identity=?")
    .run('2026-11-07T10:01:00.000Z', '发帖已完成，其余操作请点击继续运行', job.id, account.uid);
  updateJob(job.id, { metrics: { ...getJob(job.id).metrics, success: 0, failed: 1 } });

  card = runner.workflow.status(getJob(job.id)).cards.find(item => item.identity === account.uid);
  assert.equal(card.currentActionable, true);
  assert.match(card.reason, /发帖未发送.*(?:允许|可)安全重试/);
  assert.equal(getJob(job.id).metrics.failed, 0);
  assert.equal(getStepAction(job.id, card.currentStepKey).state, 'verification_wait');
  assert.equal(getStepAction(job.id, card.currentStepKey).verification_pending, 1);
  const row = db.prepare('SELECT state FROM task_step_state WHERE job_id=? AND step_key=?').get(job.id, card.currentStepKey);
  assert.equal(row.state, 'deferred');

  runner.workflow.status(getJob(job.id));
  assert.equal(getJob(job.id).metrics.failed, 0);
  assert.equal(getStepAction(job.id, card.currentStepKey).state, 'verification_wait');
});

test('同步到微博点击超时的未提交发帖自动恢复为待执行并幂等', async () => {
  const { accounts, job } = fixture([{ type: 'post', count: 1 }]);
  const runner = new TaskRunner({
    ensureIdentity: async () => ({}),
    browserManager: { closeRunner: async () => {} },
    post: async account => {
      if (account.id === accounts[0].id) throw new Error('locator.click: Timeout 5000ms exceeded while clicking 同步到微博');
      return { state: 'succeeded' };
    }
  }, { scope: 'workbench' });
  await runner.run(job.id);
  assert.equal(getJob(job.id).metrics.failed, 1);
  const key = runner.workflow.rows(job.id, 0)[0].step_key;
  runner.workflow.status(getJob(job.id));
  assert.equal(getJob(job.id).metrics.failed, 0);
  assert.equal(getStepAction(job.id, key).state, 'prepared');
  assert.equal(db.prepare('SELECT state FROM task_step_state WHERE job_id=? AND step_key=?').get(job.id, key).state, 'pending');
  runner.workflow.status(getJob(job.id));
  assert.equal(getJob(job.id).metrics.failed, 0);
  assert.match(getStepAction(job.id, key).error, /同步到微博选项临时失败/);
});
