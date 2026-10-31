import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const data = fs.mkdtempSync(path.join(os.tmpdir(), 'weibo-verification-'));
process.env.WEIBO_CONSOLE_DATA_DIR = data;
process.env.WEIBO_CONSOLE_LICENSE = 'off';
process.env.WEIBO_CONSOLE_TOPIC_MODE = 'general';
const database = await import('../src/db.js');
const { db, clearAllDataForTests, createAccount, updateAccountAuth, createTopic, addPostMaterials, addCommentMaterials, getJob, getStepAction, listAccounts, listTopics, createJob, listActionLogs, setSetting } = database;
const { TaskRunner, buildSteps, createSnapshot } = await import('../src/runner.js');
const { VerificationError, RateLimitError } = await import('../src/weibo-adapter.js');
const { listRoundReports } = await import('../src/task-reports.js');
const { defaultTaskConfig } = await import('../src/config.js');
const { BrowserManager } = await import('../src/browser.js');
const { WeiboAdapter } = await import('../src/weibo-adapter.js');
const { chromium } = await import('playwright');

test.beforeEach(() => { clearAllDataForTests(); setSetting('task_defaults', defaultTaskConfig); });
test.after(() => fs.rmSync(data, { recursive: true, force: true }));
async function until(predicate, ms = 4000) { const end = Date.now() + ms; while (!predicate()) { if (Date.now() > end) throw Error('等待验证工作流超时'); await new Promise(resolve => setTimeout(resolve, 10)); } }

function fixture(plan, options = {}) {
  const accounts = ['A','B'].map((name, index) => { const account = createAccount(name); return updateAccountAuth(account.id, { status: 'valid', uid: String(1001 + index), nickname: name }); });
  const topics = [createTopic({ name: '主题', url: 'https://example.test/topic' })];
  addPostMaterials(['发帖原文', '发帖原文二']); addCommentMaterials(['评论甲', '评论乙']);
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

test('发帖回执要求验证时释放未发布编号并进入卡片，人工自动发布只计一次', async () => {
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
  assert.equal(getStepAction(job.id, pending.step_key).sequence_confirmed, 0);
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
  assert.throws(() => runner.workflow.continue(job.id), /先完成/);
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

test('已提交验证码步骤只读复核，未知结果经明确确认后才能用原编号补发', async () => {
  const { accounts, job } = fixture([{ type: 'post', count: 1 }], { postDecoration: { mode: 'number' } });
  let calls = 0, first = true, reads = 0;
  const runner = new TaskRunner({ ensureIdentity: async () => ({}), post: async (account, _topic, _text, options) => {
    calls++; options.onSubmit();
    if (account.id === accounts[0].id && first) { first = false; throw new VerificationError('发送后验证'); }
    return { state: 'succeeded' };
  }, openVerification: async () => {}, hasTaskChallenge: async () => false, verifyPost: async () => { reads++; return { state: 'uncertain' }; } });
  await runner.run(job.id);
  const card = runner.workflow.status(getJob(job.id)).cards[0], key = card.steps[0].key;
  assert.equal(getJob(job.id).metrics.uncertain, 1);
  runner.workflow.requestManual(job.id, card.identity); await until(() => !runner.workflow.session);
  assert.equal(calls, 2); assert.ok(reads >= 1);
  assert.equal(getStepAction(job.id, key).state, 'uncertain');
  const original = getStepAction(job.id, key).content;
  runner.workflow.confirmUnpublished(job.id, key);
  assert.equal(getJob(job.id).metrics.uncertain, 0);
  runner.workflow.continue(job.id); await until(() => getJob(job.id).status === 'completed');
  assert.equal(calls, 3); assert.equal(getJob(job.id).metrics.success, 2);
  assert.equal(getStepAction(job.id, key).content, original);
});

test('未明确确认的未知提交保留待核对，不自动补发，也不阻止其他待办完成', async () => {
  const { accounts, job } = fixture([{ type: 'post', count: 1 }]);
  let calls = 0;
  const runner = new TaskRunner({ ensureIdentity: async () => ({}), post: async (account, _topic, _text, options) => {
    calls++; options.onSubmit(); if (account.id === accounts[0].id) throw new VerificationError('发送后验证'); return { state: 'succeeded' };
  }, openVerification: async () => {}, hasTaskChallenge: async () => false, verifyPost: async () => ({ state: 'uncertain' }) });
  await runner.run(job.id);
  runner.workflow.requestManual(job.id, '1001'); await until(() => !runner.workflow.session);
  runner.workflow.continue(job.id); await until(() => getJob(job.id).status === 'completed');
  assert.equal(calls, 2); assert.equal(getJob(job.id).metrics.uncertain, 1);
});

test('补做再次验证仍回到同一卡片，本轮完成与下一轮必须等补做结束', async () => {
  const { accounts, job } = fixture([{ type: 'post', count: 1 }], { rounds: 2 });
  let block = true, showing = false;
  const runner = new TaskRunner({ ensureIdentity: async () => ({}), post: async account => {
    if (account.id === accounts[0].id && block) throw new VerificationError('再次验证'); return { state: 'succeeded' };
  }, openVerification: async () => { showing = true; }, hasTaskChallenge: async () => showing, isVerificationResolved: async () => true });
  let finished = 0; runner.on('round-completed', () => finished++);
  await runner.run(job.id);
  runner.workflow.requestManual(job.id, '1001'); await until(() => runner.workflow.session?.wake);
  runner.workflow.session.wake(); await until(() => !runner.workflow.session);
  runner.workflow.continue(job.id); await until(() => !runner.promise);
  assert.equal(finished, 0); assert.equal(getJob(job.id).cursor.workflowRound || 0, 0);
  const card = runner.workflow.status(getJob(job.id)).cards[0];
  assert.equal(card.status, 'pending'); assert.equal(card.attempts, 2);
  block = false; showing = false;
  runner.adapter.openVerification = async () => {};
  runner.workflow.requestManual(job.id, '1001'); await until(() => !runner.workflow.session);
  runner.workflow.continue(job.id); await until(() => getJob(job.id).status === 'completed');
  assert.equal(finished, 2);
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
  runner.workflow.requestManual(job.id, '1001');
  assert.equal(opens, 0); assert.equal(runner.workflow.status(getJob(job.id)).session.phase, 'requested');
  release(); await until(() => runner.workflow.session?.wake);
  assert.equal(opens, 1); assert.equal(getJob(job.id).metrics.success, 1);
  assert.throws(() => runner.workflow.requestManual(job.id, '1001'), /先结束/);
  await runner.workflow.endManual(job.id);
  assert.equal(runner.workflow.status(getJob(job.id)).cards[0].status, 'pending');
  assert.equal(getJob(job.id).status, 'waiting');
  assert.equal(runner.workflow.busy(), false);
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
  runner.workflow.requestManual(job.id, '1001');
  await until(() => opens === 1);
  await until(() => !runner.workflow.session);
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

test('签到结果未确认进入待验证卡片，点击卡片会在可见会话中自动尝试一次签到', async () => {
  const { accounts, job } = fixture([{ type: 'checkin', count: 1 }]);
  let submits = 0, opens = 0;
  const runner = new TaskRunner({
    ensureIdentity: async () => ({}),
    checkin: async (_account, _topic, { onSubmit }) => { submits++; onSubmit(); return submits <= 2 ? { state: 'uncertain', reason: '未验收到已签到' } : { state: 'succeeded' }; },
    openVerification: async () => { opens++; return { isClosed: () => false }; },
    hasTaskChallenge: async () => false
  });
  await runner.run(job.id);
  const view = runner.workflow.status(getJob(job.id));
  assert.equal(getJob(job.id).status, 'waiting');
  assert.equal(view.cards.length, 2);
  assert.ok(view.cards.every(card => card.source === 'checkin_unconfirmed'));
  assert.equal(submits, 2);
  runner.workflow.requestManual(job.id, '1001');
  await until(() => !runner.workflow.session);
  assert.equal(opens, 1);
  assert.equal(submits, 3);
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
  runner.workflow.requestManual(job.id, '1001');
  await until(() => runner.workflow.session?.wake);
  closeWindow();
  await until(() => !runner.workflow.session);
  const view = runner.workflow.status(getJob(job.id));
  assert.equal(view.cards[0].status, 'pending');
  assert.equal(view.session, null);
  assert.match(view.cards[0].reason, /验证窗口已关闭/);
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
  const runner = new TaskRunner(new WeiboAdapter(manager));
  runner.workflow.ensureSteps(job);
  const step = buildSteps(job.config)[0];
  database.createActionLog({ jobId: job.id, stepKey: runner.workflow.rows(job.id, 0)[0].step_key,
    kind: 'checkin', accountId: accounts[0].id, topicId: topics[0].id, state: 'uncertain' });
  runner.workflow.deferUnconfirmedCheckin(job.id, step, 'fixture');
  runner.workflow.requestManual(job.id, '1001');
  try {
    await until(() => !runner.workflow.session, 15000);
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
    checkin: async () => ({ state: 'uncertain' }),
    verifyCheckin: async () => ({ state: confirmed ? 'succeeded' : 'uncertain' }),
    openVerification: async () => ({ isClosed: () => false }),
    hasTaskChallenge: async () => false,
    isVerificationResolved: async () => true
  });
  await runner.run(job.id);
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

test('进入等待人工验证时只发一次「还有 N 个号待验证」', async () => {
  const { setNotificationExecutor, notifyVerification, resetVerificationNotifications } = await import('../src/notifications.js');
  const messages = [];
  setNotificationExecutor((cmd, args, options, callback) => { messages.push(args.at(-1)); callback(null); });
  const { job } = fixture([{ type: 'checkin', count: 1 }]);
  const runner = new TaskRunner({ ensureIdentity: async () => ({}),
    checkin: async () => ({ state: 'uncertain' }),
    verifyCheckin: async () => ({ state: 'uncertain' }),
    openVerification: async () => ({ isClosed: () => false }),
    hasTaskChallenge: async () => false,
    isVerificationResolved: async () => true
  });
  await runner.run(job.id);
  await until(() => messages.length > 0, 2000);
  assert.equal(messages.length, 1);
  assert.equal(messages[0], '还有 2 个号待验证');
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
    delete process.env.WEIBO_CONSOLE_NOTIFY;
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
test('结束验证能立即打断签到等待，不会卡住会话', async () => {
  const { job } = fixture([{ type: 'checkin', count: 1 }]);
  const runner = new TaskRunner({ ensureIdentity: async () => ({}),
    checkin: async () => ({ state: 'uncertain' }),
    verifyCheckin: async () => ({ state: 'uncertain' }),
    openVerification: async () => ({ isClosed: () => false }),
    hasTaskChallenge: async () => false,
    isVerificationResolved: async () => true
  });
  await runner.run(job.id);
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
