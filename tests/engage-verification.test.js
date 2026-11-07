import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'weibo-console-engage-verification-'));
process.env.WEIBO_CONSOLE_DATA_DIR = tempDir;
process.env.WEIBO_CONSOLE_LICENSE = 'off';
process.env.WEIBO_CONSOLE_TOPIC_MODE = 'general';
process.env.WEIBO_CONSOLE_NOTIFY = 'off';

const db = await import('../src/db.js');
const { TaskRunner, createSnapshot } = await import('../src/runner.js');
const { VerificationError, RateLimitError } = await import('../src/weibo-adapter.js');
const { AccountLeases } = await import('../src/account-leases.js');
const link = 'https://weibo.com/7449968177/RoF58iVPk';

test.after(() => { try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch {} });
test.beforeEach(() => db.clearAllDataForTests());

async function until(predicate, ms = 4000) {
  const end = Date.now() + ms;
  while (!predicate()) {
    if (Date.now() > end) throw new Error('等待转赞评验证流程超时');
    await new Promise(resolve => setTimeout(resolve, 10));
  }
}

function account() {
  const item = db.createAccount('验证账号');
  return db.updateAccountAuth(item.id, { status: 'valid', uid: '88001', nickname: '验证账号' });
}

function jobFor(kind, count = 1) {
  db.addCommentMaterials(['评论文案甲', '评论文案乙']);
  const target = account();
  const plan = kind === 'like' ? []
    : [{ type: kind, count, intervalSeconds: 0, repostForm: 'plain' }];
  const config = createSnapshot({ kind: 'engage', accountIds: [target.id], links: [link], rounds: 1,
    likePost: kind === 'like', actionPlan: plan }, db.listAccounts(), []);
  return { target, job: db.createJob(config) };
}

function page() {
  return {
    context: () => ({}), isClosed: () => false,
    once: () => {}
  };
}

function adapterFor(kind, control) {
  const success = options => {
    options.beforeSubmit?.();
    if (kind === 'comment_like') options.onTarget?.({ id: 'c1', key: 'c1', authorUid: '9001', text: '评论一' });
    options.onSubmit?.();
    return { state: 'succeeded', url: link, targetId: kind === 'comment_like' ? 'c1' : null, successSource: 'page_color' };
  };
  const method = async (_account, _target, contentOrOptions, maybeOptions) => {
    const options = kind === 'comment_like' ? contentOrOptions : kind === 'repost' ? maybeOptions : contentOrOptions;
    if (!control.manual) throw new VerificationError(kind + ' 需要验证');
    control.actions.push(kind);
    return success(options);
  };
  const adapter = {
    probeConnectivity: async () => true,
    ensureIdentity: async item => ({ uid: item.uid, status: 'valid' }),
    browserManager: { closeRunner: async () => {} },
    openVerification: async () => { control.opens += 1; return page(); },
    closeManual: async () => { control.closes += 1; },
    hasTaskChallenge: async () => control.challenge,
    isVerificationResolved: async () => !control.challenge
  };
  if (kind === 'repost') adapter.repostWeibo = async (_a, _l, _text, options) => method(null, null, null, options);
  if (kind === 'comment') adapter.comment = method;
  if (kind === 'like') adapter.likeWeibo = async (_a, _l, options) => method(null, null, options);
  if (kind === 'comment_like') adapter.likeNextComment = method;
  return adapter;
}

for (const kind of ['repost', 'comment', 'comment_like', 'like']) {
  test(`转赞评${kind}验证通过后仅补做一次并自动关窗`, async () => {
    const { target, job } = jobFor(kind);
    const control = { manual: false, challenge: true, opens: 0, closes: 0, actions: [] };
    const leases = new AccountLeases();
    const runner = new TaskRunner(adapterFor(kind, control), { scope: 'engage', leases });
    await runner.run(job.id);
    let verification = runner.workflow.status(db.getJob(job.id));
    assert.equal(verification.cards.length, 1);
    assert.equal(verification.barrier, true);
    assert.equal(verification.cards[0].canOpen, true);

    control.manual = true;
    runner.workflow.requestManual(job.id, target.uid);
    await until(() => runner.workflow.session?.wake);
    control.challenge = false;
    runner.workflow.session.wake();
    await until(() => !runner.workflow.session);

    assert.deepEqual(control.actions, [kind]);
    assert.equal(control.opens, 1);
    assert.equal(control.closes, 1);
    assert.equal(leases.owners.size, 0);
    assert.equal(db.getJob(job.id).metrics.success, 1);
    verification = runner.workflow.status(db.getJob(job.id));
    assert.equal(verification.cards[0].verificationResult, 'passed');
    assert.ok(verification.cards[0].verifiedAt);
  });
}

test('主线任务进行中请求验证会安全暂停，验证结束后等待手动继续', async () => {
  db.addCommentMaterials(['评论文案甲', '评论文案乙']);
  const target = account();
  const config = createSnapshot({ kind: 'engage', accountIds: [target.id], links: [link], rounds: 1,
    actionPlan: [{ type: 'comment_like', count: 2, intervalSeconds: 0 }, { type: 'repost', count: 1, intervalSeconds: 0, repostForm: 'plain' }] }, db.listAccounts(), []);
  const job = db.createJob(config);
  let inRepost = false, releaseRepost, opens = 0, innerCalls = 0, dismissed = 0, identities = 0, closes = 0;
  let manual = false;
  const hold = new Promise(resolve => { releaseRepost = resolve; });
  const leases = new AccountLeases();
  const runner = new TaskRunner({
    probeConnectivity: async () => true,
    ensureIdentity: async item => { identities += 1; return { uid: item.uid, status: 'valid' }; },
    browserManager: { closeRunner: async () => { closes += 1; } },
    likeNextComment: async (_a, _l, options) => {
      innerCalls += 1;
      if (manual) {
        options.onTarget?.({ id: 'manual-' + innerCalls, key: 'manual-' + innerCalls });
        options.onSubmit();
        return { state: 'succeeded', url: link };
      }
      const error = new VerificationError('内赞验证');
      error.challengePage = page();
      throw error;
    },
    repostWeibo: async (_a, _l, _t, options) => { inRepost = true; await hold; options.onSubmit(); return { state: 'succeeded', url: link }; },
    openVerification: async () => { opens += 1; return page(); },
    dismissBackgroundChallenge: async () => { dismissed += 1; return true; },
    hasTaskChallenge: async () => false
  }, { scope: 'engage', leases });
  const running = runner.run(job.id);
  await until(() => inRepost);
  runner.workflow.requestManual(job.id, target.uid);
  assert.equal(db.getJob(job.id).status, 'paused');
  assert.equal(db.getJob(job.id).cursor.verificationAutoPaused, true);
  assert.equal(db.getJob(job.id).cursor.manualVerification.phase, 'requested');
  assert.equal(opens, 0);
  manual = true;
  releaseRepost();
  await running;
  await until(() => opens === 1);
  await until(() => !runner.workflow.session && db.getJob(job.id).status === 'waiting');
  assert.equal(runner.workflow.status(db.getJob(job.id)).canContinue, true);
  runner.workflow.continue(job.id);
  await until(() => db.getJob(job.id).status === 'completed');
  const verification = runner.workflow.status(db.getJob(job.id));
  assert.equal(verification.cards[0].verificationResult, 'passed');
  assert.equal(innerCalls, 3, '首次受拦截、人工验证一次、继续运行补足剩余一次');
  assert.equal(dismissed, 1);
  assert.ok(identities >= 1);
  assert.ok(closes >= 2);
  assert.ok(verification.cards[0].steps.filter(step => step.kind === 'comment_like').every(step => step.outcome === 'succeeded'));
  assert.equal(verification.cards[0].steps.find(step => step.kind === 'repost').outcome, 'succeeded');
  assert.equal(db.getJob(job.id).cursor.verificationAutoPaused, false);
  assert.equal(db.getJob(job.id).cursor.manualVerification, null);
  assert.equal(leases.owners.size, 0);
});

test('评论频繁只跳过评论，转发、内赞和外赞继续', async () => {
  db.addCommentMaterials(['评论文案甲', '评论文案乙']);
  const target = account();
  const config = createSnapshot({ kind: 'engage', accountIds: [target.id], links: [link], rounds: 1, likePost: true,
    actionPlan: [
      { type: 'comment', count: 1, intervalSeconds: 0 },
      { type: 'repost', count: 1, intervalSeconds: 0, repostForm: 'plain' },
      { type: 'comment_like', count: 1, intervalSeconds: 0 }
    ] }, db.listAccounts(), []);
  const job = db.createJob(config);
  const calls = [];
  const runner = new TaskRunner({
    probeConnectivity: async () => true,
    ensureIdentity: async item => ({ uid: item.uid, status: 'valid' }),
    browserManager: { closeRunner: async () => {} },
    comment: async () => { calls.push('comment'); throw new RateLimitError('评论频繁', 'comment', true); },
    repostWeibo: async (_a, _l, _t, options) => { calls.push('repost'); options.onSubmit(); return { state: 'succeeded', url: link }; },
    likeNextComment: async (_a, _l, options) => { calls.push('inner'); options.onTarget?.({ id: 'c1', key: 'c1' }); options.onSubmit(); return { state: 'succeeded', url: link }; },
    likeWeibo: async (_a, _l, options) => { calls.push('outer'); options.onSubmit(); return { state: 'succeeded', url: link }; }
  }, { scope: 'engage', leases: new AccountLeases() });
  await runner.run(job.id);
  const byKind = kind => db.listActionLogs(job.id).filter(item => item.kind === kind).map(item => item.state);
  assert.deepEqual(calls, ['outer', 'comment', 'repost', 'inner']);
  assert.deepEqual(byKind('comment'), ['skipped']);
  assert.deepEqual(byKind('repost'), ['succeeded']);
  assert.deepEqual(byKind('comment_like'), ['succeeded']);
  assert.deepEqual(byKind('like'), ['succeeded']);
  assert.ok(db.getJob(job.id).cursor.rateLimits.every(item => item.kind === 'comment'));
});

test('转发频繁只跳过转发，评论、内赞和外赞继续', async () => {
  db.addCommentMaterials(['评论文案甲', '评论文案乙']);
  const target = account();
  const config = createSnapshot({ kind: 'engage', accountIds: [target.id], links: [link], rounds: 1, likePost: true,
    actionPlan: [
      { type: 'repost', count: 1, intervalSeconds: 0, repostForm: 'plain' },
      { type: 'comment', count: 1, intervalSeconds: 0 },
      { type: 'comment_like', count: 1, intervalSeconds: 0 }
    ] }, db.listAccounts(), []);
  const job = db.createJob(config);
  const calls = [];
  const runner = new TaskRunner({
    probeConnectivity: async () => true,
    ensureIdentity: async item => ({ uid: item.uid, status: 'valid' }),
    browserManager: { closeRunner: async () => {} },
    repostWeibo: async () => { calls.push('repost'); throw new RateLimitError('转发频繁', 'repost', true); },
    comment: async (_a, _c, _t, options) => { calls.push('comment'); options.onSubmit(); return { state: 'succeeded', url: link }; },
    likeNextComment: async (_a, _l, options) => { calls.push('inner'); options.onTarget?.({ id: 'c1', key: 'c1' }); options.onSubmit(); return { state: 'succeeded', url: link }; },
    likeWeibo: async (_a, _l, options) => { calls.push('outer'); options.onSubmit(); return { state: 'succeeded', url: link }; }
  }, { scope: 'engage', leases: new AccountLeases() });
  await runner.run(job.id);
  const byKind = kind => db.listActionLogs(job.id).filter(item => item.kind === kind).map(item => item.state);
  assert.deepEqual(calls, ['outer', 'repost', 'comment', 'inner']);
  assert.deepEqual(byKind('repost'), ['skipped']);
  assert.deepEqual(byKind('comment'), ['succeeded']);
  assert.deepEqual(byKind('comment_like'), ['succeeded']);
  assert.deepEqual(byKind('like'), ['succeeded']);
  assert.ok(db.getJob(job.id).cursor.rateLimits.every(item => item.kind === 'repost'));
});

test('转发步骤遇到评论频繁时只跳过联动评论，转发去掉联动后重试一次', async () => {
  db.addCommentMaterials(['评论文案甲', '评论文案乙']);
  const target = account();
  const config = createSnapshot({ kind: 'engage', accountIds: [target.id], links: [link], rounds: 1, likePost: true,
    actionPlan: [
      { type: 'repost', count: 1, intervalSeconds: 0, repostForm: 'plain', alsoComment: true },
      { type: 'comment', count: 1, intervalSeconds: 0 },
      { type: 'comment_like', count: 1, intervalSeconds: 0 }
    ] }, db.listAccounts(), []);
  const job = db.createJob(config);
  const calls = [], coupled = [];
  const runner = new TaskRunner({
    probeConnectivity: async () => true,
    ensureIdentity: async item => ({ uid: item.uid, status: 'valid' }),
    browserManager: { closeRunner: async () => {} },
    repostWeibo: async (_a, _l, _t, options) => {
      calls.push('repost'); coupled.push(options.alsoComment);
      if (coupled.length === 1) throw new RateLimitError('评论频繁', 'comment', true);
      options.onSubmit(); return { state: 'succeeded', url: link };
    },
    comment: async () => { calls.push('comment'); return { state: 'succeeded', url: link }; },
    likeNextComment: async (_a, _l, options) => { calls.push('inner'); options.onTarget?.({ id: 'c1', key: 'c1' }); options.onSubmit(); return { state: 'succeeded', url: link }; },
    likeWeibo: async (_a, _l, options) => { calls.push('outer'); options.onSubmit(); return { state: 'succeeded', url: link }; }
  }, { scope: 'engage', leases: new AccountLeases() });
  await runner.run(job.id);
  assert.deepEqual(calls, ['outer', 'repost', 'repost', 'inner']);
  assert.deepEqual(coupled, [true, false]);
  const logs = db.listActionLogs(job.id);
  assert.equal(logs.find(item => item.kind === 'repost')?.state, 'succeeded');
  assert.equal(logs.find(item => item.kind === 'comment')?.state, 'skipped');
  assert.equal(logs.find(item => item.kind === 'comment_like')?.state, 'succeeded');
  assert.equal(logs.find(item => item.kind === 'like')?.state, 'succeeded');
});

test('转发验证码后评论继续执行，评论端历史同时转发配置被忽略', async () => {
  db.addCommentMaterials(['评论文案甲', '评论文案乙']);
  const target = account();
  const config = createSnapshot({ kind: 'engage', accountIds: [target.id], links: [link], rounds: 1, likePost: true,
    actionPlan: [
      { type: 'repost', count: 3, intervalSeconds: 0, repostForm: 'plain', alsoComment: true },
      { type: 'comment', count: 2, intervalSeconds: 0, repostForm: 'plain', alsoRepost: true },
      { type: 'comment_like', count: 1, intervalSeconds: 0 }
    ] }, db.listAccounts(), []);
  const job = db.createJob(config);
  let reposts = 0, inner = 0;
  const commentCoupling = [];
  const runner = new TaskRunner({
    probeConnectivity: async () => true,
    ensureIdentity: async item => ({ uid: item.uid, status: 'valid' }),
    browserManager: { closeRunner: async () => {} },
    repostWeibo: async (_a, _l, _t, options) => {
      reposts += 1;
      if (reposts === 2) throw new VerificationError('转发验证码');
      options.onSubmit(); return { state: 'succeeded', url: link };
    },
    comment: async (_a, _c, _t, options) => {
      commentCoupling.push(options.alsoRepost);options.onSubmit();return { state: 'succeeded', url: link };
    },
    likeNextComment: async (_a, _l, options) => {
      inner += 1;options.onTarget?.({ id: 'c1', key: 'c1' });options.onSubmit();return { state: 'succeeded', url: link };
    },
    likeWeibo: async (_a, _l, options) => { options.onSubmit();return { state: 'succeeded', url: link }; },
    openVerification: async () => page(), hasTaskChallenge: async () => true, isVerificationResolved: async () => false
  }, { scope: 'engage', leases: new AccountLeases() });
  await runner.run(job.id);
  assert.equal(reposts, 2);
  assert.equal(inner, 1);
  assert.deepEqual(commentCoupling, [undefined, undefined]);
  const logs = db.listActionLogs(job.id);
  assert.deepEqual(logs.filter(item => item.kind === 'repost' && item.state === 'succeeded').map(item => item.state), ['succeeded']);
  assert.equal(logs.filter(item => item.kind === 'repost' && item.state === 'skipped').length, 0);
  assert.equal(logs.filter(item => item.kind === 'comment' && item.state === 'succeeded').length, 3);
  assert.equal(db.db.prepare("SELECT COUNT(*) n FROM task_step_state WHERE job_id=? AND kind='repost' AND segment_id LIKE '%_couple_repost'").get(job.id).n, 0);
  const card = runner.workflow.status(db.getJob(job.id)).cards[0];
  assert.equal(card.currentKind, 'repost');
  const unfinished = db.db.prepare("SELECT COUNT(*) n FROM task_step_state WHERE job_id=? AND round_index=0 AND state IN ('deferred','running','pending','review','network_review')").get(job.id).n;
  assert.equal(card.remainingStepCount, unfinished, '联动待办必须计入验证卡待补做数量');
});

test('转发频繁后评论继续，但评论端不会再产生同时转发', async () => {
  db.addCommentMaterials(['评论文案甲', '评论文案乙']);
  const target = account();
  const config = createSnapshot({ kind: 'engage', accountIds: [target.id], links: [link], rounds: 1,
    actionPlan: [
      { type: 'repost', count: 1, intervalSeconds: 0, repostForm: 'plain' },
      { type: 'comment', count: 1, intervalSeconds: 0, repostForm: 'plain', alsoRepost: true }
    ] }, db.listAccounts(), []);
  const job = db.createJob(config);
  const commentCoupling = [];
  const runner = new TaskRunner({
    probeConnectivity: async () => true,
    ensureIdentity: async item => ({ uid: item.uid, status: 'valid' }),
    browserManager: { closeRunner: async () => {} },
    repostWeibo: async () => { throw new RateLimitError('转发频繁', 'repost', true); },
    comment: async (_a, _c, _t, options) => {
      commentCoupling.push(options.alsoRepost);
      options.onSubmit();
      return { state: 'succeeded', url: link };
    }
  }, { scope: 'engage', leases: new AccountLeases() });
  await runner.run(job.id);
  assert.deepEqual(commentCoupling, [undefined]);
  const logs = db.listActionLogs(job.id);
  assert.equal(logs.find(item => item.kind === 'comment')?.state, 'succeeded');
  assert.ok(logs.filter(item => item.kind === 'repost').every(item => item.state === 'skipped'));
  assert.equal(db.getJob(job.id).metrics.success, 1);
  assert.equal(db.getJob(job.id).metrics.skipped, 1);
});

test('无关频繁提示重复出现时当前操作重试一次后跳过，不死循环', async () => {
  db.addCommentMaterials(['评论文案甲', '评论文案乙']);
  const target = account();
  const config = createSnapshot({ kind: 'engage', accountIds: [target.id], links: [link], rounds: 1, likePost: true,
    actionPlan: [
      { type: 'repost', count: 1, intervalSeconds: 0, repostForm: 'plain' },
      { type: 'comment', count: 1, intervalSeconds: 0 },
      { type: 'comment_like', count: 1, intervalSeconds: 0 }
    ] }, db.listAccounts(), []);
  const job = db.createJob(config);
  let repostCalls = 0;
  const runner = new TaskRunner({
    probeConnectivity: async () => true,
    ensureIdentity: async item => ({ uid: item.uid, status: 'valid' }),
    browserManager: { closeRunner: async () => {} },
    repostWeibo: async () => { repostCalls += 1; throw new RateLimitError('评论频繁', 'comment', true); },
    comment: async () => ({ state: 'succeeded', url: link }),
    likeNextComment: async (_a, _l, options) => { options.onTarget?.({ id: 'c1', key: 'c1' }); options.onSubmit(); return { state: 'succeeded', url: link }; },
    likeWeibo: async (_a, _l, options) => { options.onSubmit(); return { state: 'succeeded', url: link }; }
  }, { scope: 'engage', leases: new AccountLeases() });
  await runner.run(job.id);
  assert.equal(repostCalls, 2);
  assert.equal(db.getJob(job.id).status, 'completed');
  assert.equal(db.listActionLogs(job.id).find(item => item.kind === 'repost')?.state, 'skipped');
});

test('一个账号触发验证不阻塞其他账号继续执行', async () => {
  const first = account();
  const second = db.createAccount('并行账号');
  db.updateAccountAuth(second.id, { status: 'valid', uid: '88002', nickname: '并行账号' });
  const config = createSnapshot({ kind: 'engage', accountIds: [first.id, second.id], links: [link], rounds: 1,
    actionPlan: [{ type: 'repost', count: 1, intervalSeconds: 0, repostForm: 'plain' }] }, db.listAccounts(), []);
  const job = db.createJob(config);
  const calls = [];
  const runner = new TaskRunner({
    probeConnectivity: async () => true,
    ensureIdentity: async item => ({ uid: item.uid, status: 'valid' }),
    browserManager: { closeRunner: async () => {} },
    repostWeibo: async item => {
      calls.push(item.uid);
      if (item.uid === first.uid) throw new VerificationError('转发验证');
      return { state: 'succeeded', url: link };
    }
  }, { scope: 'engage', leases: new AccountLeases() });
  await runner.run(job.id);
  assert.equal(db.getJob(job.id).metrics.success, 1);
  assert.equal(runner.workflow.status(db.getJob(job.id)).cards.length, 1);
  assert.equal(runner.workflow.status(db.getJob(job.id)).cards[0].name, '验证账号');
});

test('内赞验证只新增一条，继续运行后按扫描顺序补足', async () => {
  const { target, job } = jobFor('comment_like', 2);
  let manual = false, challenge = true, backgroundFailures = 1, targets = [];
  const leases = new AccountLeases();
  const runner = new TaskRunner({
    probeConnectivity: async () => true,
    ensureIdentity: async item => ({ uid: item.uid, status: 'valid' }),
    browserManager: { closeRunner: async () => {} },
    openVerification: async () => page(),
    closeManual: async () => {},
    hasTaskChallenge: async () => challenge,
    isVerificationResolved: async () => !challenge,
    likeNextComment: async (_a, _l, options) => {
      if (backgroundFailures > 0 && !manual) { backgroundFailures -= 1; throw new VerificationError('内赞验证'); }
      const next = { id: 'c' + (targets.length + 1), key: 'c' + (targets.length + 1), authorUid: '9001', text: '评论' + (targets.length + 1) };
      targets.push(next.id); options.assertRunning(); await options.beforeSubmit?.(); options.onTarget(next); options.onSubmit();
      return { state: 'succeeded', targetId: next.id, url: link, successSource: 'page_color' };
    }
  }, { scope: 'engage', leases });
  await runner.run(job.id);
  manual = true; runner.workflow.requestManual(job.id, target.uid);
  await until(() => runner.workflow.session?.wake); challenge = false; runner.workflow.session.wake();
  await until(() => !runner.workflow.session);
  assert.equal(runner.workflow.status(db.getJob(job.id)).canContinue, true);
  runner.workflow.continue(job.id);
  await until(() => db.getJob(job.id).status === 'completed');
  assert.deepEqual(targets, ['c1', 'c2']);
  manual = false;
  const view = runner.workflow.status(db.getJob(job.id));
  assert.equal(view.cards[0].verificationResult, 'passed');
  assert.equal(db.getJob(job.id).metrics.success, 2);
  assert.equal(leases.owners.size, 0);
});

test('已提交的外赞验证只读核对，不再次点击', async () => {
  const { target, job } = jobFor('like');
  let clicks = 0, reads = 0, challenge = true;
  const leases = new AccountLeases();
  const runner = new TaskRunner({
    probeConnectivity: async () => true,
    ensureIdentity: async item => ({ uid: item.uid, status: 'valid' }),
    browserManager: { closeRunner: async () => {} },
    openVerification: async () => page(), closeManual: async () => {},
    hasTaskChallenge: async () => challenge, isVerificationResolved: async () => !challenge,
    likeWeibo: async (_a, _l, options) => { clicks += 1; options.onSubmit(); throw new VerificationError('外赞验证'); },
    verifyLike: async () => { reads += 1; return { state: 'succeeded', url: link }; }
  }, { scope: 'engage', leases });
  await runner.run(job.id);
  runner.workflow.requestManual(job.id, target.uid);
  await until(() => runner.workflow.session?.wake); challenge = false; runner.workflow.session.wake();
  await until(() => !runner.workflow.session);
  assert.equal(clicks, 1); assert.ok(reads >= 1);
  assert.equal(db.getJob(job.id).metrics.success, 1);
  assert.equal(leases.owners.size, 0);
});

test('已提交内赞经人工验证确认未赞时只补点原目标一次', async () => {
  const { target, job } = jobFor('comment_like');
  let manual = false, calls = 0, reads = 0;
  const runner = new TaskRunner({
    probeConnectivity: async () => true,
    ensureIdentity: async item => ({ uid: item.uid, status: 'valid' }),
    browserManager: { closeRunner: async () => {} },
    openVerification: async () => page(), closeManual: async () => {}, hasTaskChallenge: async () => false,
    likeNextComment: async (_a, _l, options) => {
      calls += 1;
      if (!manual) {
        options.onTarget?.({ id: 'c1', key: 'c1', authorUid: '9001', text: '评论一' });
        options.onSubmit?.();
        throw new VerificationError('内赞验证');
      }
      options.onTarget?.({ id: 'c1', key: 'c1', authorUid: '9001', text: '评论一' });
      options.onSubmit?.();
      return { state: 'succeeded', targetId: 'c1', url: link, successSource: 'page_color' };
    },
    verifyCommentLike: async () => {
      reads += 1;
      return { state: 'uncertain', found: true, notLiked: true, reason: '原评论明确未赞' };
    }
  }, { scope: 'engage', leases: new AccountLeases() });
  await runner.run(job.id);
  manual = true;
  runner.workflow.requestManual(job.id, target.uid);
  await until(() => !runner.workflow.session);
  assert.equal(reads, 1);
  assert.equal(calls, 2, '后台提交一次，人工验证确认未赞后补点一次');
  const action = db.listActionLogs(job.id).find(item => item.kind === 'comment_like');
  assert.equal(action.state, 'succeeded');
  assert.equal(action.target_id, 'c1');
  assert.equal(db.getJob(job.id).metrics.success, 1);
});

test('转赞评提交后频繁待核对会自动只读复核，成功后只计一次', async () => {
  const { job } = jobFor('comment');
  let reads = 0, writes = 0;
  const runner = new TaskRunner({
    probeConnectivity: async () => true,
    ensureIdentity: async item => ({ uid: item.uid, status: 'valid' }),
    browserManager: { closeRunner: async () => {} },
    comment: async (_account, _candidate, _content, options) => {
      writes += 1;
      options.onSubmit?.();
      throw new RateLimitError('操作频繁，请您稍后再试', 'comment', false);
    },
    verifyComment: async (_account, candidate) => {
      reads += 1;
      return { state: 'succeeded', url: candidate.url + '?comment_id=verified' };
    }
  }, { scope: 'engage', leases: new AccountLeases() });
  await runner.run(job.id);
  let action = db.listActionLogs(job.id).find(item => item.kind === 'comment');
  assert.equal(action.state, 'uncertain');
  assert.ok(action.submitted_at);
  await until(() => db.listActionLogs(job.id).find(item => item.kind === 'comment')?.state === 'succeeded', 6000);
  action = db.listActionLogs(job.id).find(item => item.kind === 'comment');
  assert.equal(writes, 1, '只读复核不得再次提交评论');
  assert.equal(reads, 1);
  assert.equal(db.getJob(job.id).metrics.success, 1);
  assert.equal(db.getJob(job.id).metrics.uncertain, 0);
  assert.equal(db.getJob(job.id).cursor.autoReadbacks[action.id].attempts, 1);
});
