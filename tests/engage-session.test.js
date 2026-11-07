import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'weibo-console-engage-session-'));
process.env.WEIBO_CONSOLE_DATA_DIR = tempDir;
process.env.WEIBO_CONSOLE_LICENSE = 'off';
process.env.WEIBO_CONSOLE_TOPIC_MODE = 'general';

const dbModule = await import('../src/db.js');
const runnerModule = await import('../src/runner.js');
const { buildSteps, createSnapshot, TaskRunner } = runnerModule;
const { createAccount, createJob, getJob, updateJob, listAccounts, listActionLogs, clearAllDataForTests, createTopic, updateAccountAuth, addPostMaterials, addCommentMaterials } = dbModule;
const { AccountLeases } = await import('../src/account-leases.js');
const { VerificationError } = await import('../src/weibo-adapter.js');

const LINK_A = 'https://weibo.com/201/AbCdE1';
const LINK_B = 'https://weibo.com/202/AbCdE2';

function identity(name, uid) {
  const account = createAccount(name);
  return updateAccountAuth(account.id, { status: 'valid', uid, nickname: name });
}

function engageJob(accountIds, links, plan, extra = {}) {
  return createJob(createSnapshot({ kind: 'engage', accountIds, links, rounds: 1, actionPlan: plan, ...extra }, listAccounts(), []));
}

function trackedLeases() {
  const leases = new AccountLeases();
  const acquisitions = [];
  const acquire = leases.acquire.bind(leases);
  leases.acquire = (account, owner) => {
    acquisitions.push(String(account.uid || account.id));
    return acquire(account, owner);
  };
  return { leases, acquisitions };
}

const stepKey = step => [step.round, step.link || step.topicId, step.accountId, step.kind, step.actionIndex, step.segmentId, step.unitIndex].join('|');

test.after(() => { try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch {} });
test.beforeEach(() => { clearAllDataForTests(); });

test('engage 快照升级到 schedulerVersion 5', () => {
  const account = identity('版本账号', '8401');
  const snapshot = createSnapshot({ kind: 'engage', accountIds: [account.id], links: [LINK_A], actionPlan: [{ type: 'comment_like', count: 1 }] }, listAccounts(), []);
  assert.equal(snapshot.kind, 'engage');
  assert.equal(snapshot.schedulerVersion, 5);
});

test('旧 schedulerVersion 3 的 engage 步骤顺序保持不变', () => {
  const snapshot = {
    kind: 'engage', schedulerVersion: 3, rounds: 1, links: ['L1'], accountIds: ['a1', 'a2'], likePost: true,
    actionPlan: [{ type: 'repost', count: 1, alsoComment: true }, { type: 'comment', count: 2 }],
    segmentIds: ['s1', 's2']
  };
  assert.deepEqual(buildSteps(snapshot).map(stepKey), [
    '0|L1|a1|like|-1|like-post|0',
    '0|L1|a2|like|-1|like-post|0',
    '0|L1|a1|repost|0|s1|0',
    '0|L1|a1|comment|0|s1_couple_comment|0',
    '0|L1|a2|repost|0|s1|0',
    '0|L1|a2|comment|0|s1_couple_comment|0',
    '0|L1|a1|comment|1|s2|0',
    '0|L1|a1|comment|1|s2|1',
    '0|L1|a2|comment|1|s2|0',
    '0|L1|a2|comment|1|s2|1'
  ]);
});

test('schedulerVersion 4 按轮→链接→账号→操作→次数排序，仅转发联动且首轮每组只外赞一次', () => {
  const snapshot = {
    kind: 'engage', schedulerVersion: 4, rounds: 2, links: ['L1'], accountIds: ['a1', 'a2'], likePost: true,
    actionPlan: [{ type: 'repost', count: 1, alsoComment: true }, { type: 'comment', count: 1 }],
    segmentIds: ['s1', 's2']
  };
  const steps = buildSteps(snapshot);
  assert.equal(steps.filter(step => step.kind === 'like').length, 2);
  assert.ok(steps.filter(step => step.kind === 'like').every(step => step.round === 0));
  assert.deepEqual(steps.map(stepKey), [
    '0|L1|a1|like|-1|like-post|0',
    '0|L1|a1|repost|0|s1|0',
    '0|L1|a1|comment|0|s1_couple_comment|0',
    '0|L1|a1|comment|1|s2|0',
    '0|L1|a2|like|-1|like-post|0',
    '0|L1|a2|repost|0|s1|0',
    '0|L1|a2|comment|0|s1_couple_comment|0',
    '0|L1|a2|comment|1|s2|0',
    '1|L1|a1|repost|0|s1|0',
    '1|L1|a1|comment|0|s1_couple_comment|0',
    '1|L1|a1|comment|1|s2|0',
    '1|L1|a2|repost|0|s1|0',
    '1|L1|a2|comment|0|s1_couple_comment|0',
    '1|L1|a2|comment|1|s2|0'
  ]);
});

test('engage 组会话：每组一次身份确认和租约，提交期间持租，组边界释放', async () => {
  const a1 = identity('会话A', '8411'), a2 = identity('会话B', '8412');
  const job = engageJob([a1.id, a2.id], [LINK_A, LINK_B], [{ type: 'repost', count: 3, intervalSeconds: 0, repostForm: 'plain' }]);
  const { leases, acquisitions } = trackedLeases();
  const submissions = [], identities = [];
  let closes = 0;
  const adapter = {
    probeConnectivity: async () => true,
    ensureIdentity: async account => { identities.push(String(account.uid)); return { uid: account.uid, status: 'valid' }; },
    browserManager: { closeRunner: async () => { closes += 1; } },
    repostWeibo: async (account, link, content, options) => {
      submissions.push({ account: account.id, link, owners: leases.owners.size });
      options.onSubmit();
      return { state: 'succeeded' };
    }
  };
  const runner = new TaskRunner(adapter, { scope: 'engage', leases });
  assert.equal(typeof runner.releaseEngageSession, 'function');
  await runner.run(job.id);
  assert.equal(getJob(job.id).status, 'completed');
  assert.equal(submissions.length, 12);
  assert.equal(identities.length, 4);
  // 开跑前的网络探测会短暂占用一次租约，之后才是 2 账号 × 2 链接的 4 个组边界。
  assert.equal(acquisitions.length, 5);
  assert.equal(acquisitions.slice(1).length, 4, '每个账号+链接组只取一次租约');
  assert.equal(closes, 5);
  assert.ok(submissions.every(item => item.owners === 1), '每次提交都必须仍持有本组租约');
  assert.equal(leases.owners.size, 0, '任务完成必须释放全部租约');
  assert.deepEqual(submissions.map(item => (item.account === a1.id ? 'a1' : 'a2') + ':' + (item.link === LINK_A ? 'A' : 'B')), [
    'a1:A', 'a1:A', 'a1:A', 'a2:A', 'a2:A', 'a2:A',
    'a1:B', 'a1:B', 'a1:B', 'a2:B', 'a2:B', 'a2:B'
  ]);
  await runner.releaseEngageSession();
  assert.equal(leases.owners.size, 0, '重复释放应安全且不留租约');
});

async function interruptedRun(mode) {
  clearAllDataForTests();
  const account = identity('中断账号', '8421');
  const job = engageJob([account.id], [LINK_A], [{ type: 'repost', count: 2, intervalSeconds: 0, repostForm: 'plain' }]);
  const { leases } = trackedLeases();
  let closes = 0, calls = 0, runner;
  const adapter = {
    probeConnectivity: async () => true,
    ensureIdentity: async acc => ({ uid: acc.uid, status: 'valid' }),
    browserManager: { closeRunner: async () => { closes += 1; } },
    repostWeibo: async (acc, link, content, options) => {
      calls += 1;
      options.onSubmit();
      if (calls === 2) {
        if (mode === 'pause') runner.pause(job.id);
        else if (mode === 'stop') runner.stop(job.id);
        else if (mode === 'verify') throw new VerificationError('需要完成微博验证');
        else throw new Error('模拟普通异常');
      }
      return { state: 'succeeded' };
    }
  };
  runner = new TaskRunner(adapter, { scope: 'engage', leases });
  await runner.run(job.id);
  return { runner, job, leases, closes, calls };
}

test('engage 中途暂停释放租约', async () => {
  const { job, leases, closes, calls } = await interruptedRun('pause');
  assert.equal(getJob(job.id).status, 'paused');
  assert.equal(calls, 2);
  assert.ok(closes >= 1);
  assert.equal(leases.owners.size, 0);
});

test('engage 安全暂停后可编辑当前任务，并只补跑新参数中的剩余次数', async () => {
  const account = identity('暂停编辑账号', '8421');
  const job = engageJob([account.id], [LINK_A], [{ type: 'repost', count: 2, intervalSeconds: 0, repostForm: 'plain' }]);
  let calls = 0, release, started;
  const began = new Promise(resolve => { started = resolve; });
  const hold = new Promise(resolve => { release = resolve; });
  const runner = new TaskRunner({
    probeConnectivity: async () => true,
    ensureIdentity: async item => ({ uid: item.uid, status: 'valid' }),
    browserManager: { closeRunner: async () => {} },
    repostWeibo: async (_a, _l, _t, options) => {
      calls += 1; options.onSubmit();
      if (calls === 1) { started(); await hold; }
      return { state: 'succeeded', url: LINK_A };
    }
  }, { scope: 'engage', leases: new AccountLeases() });
  const running = runner.run(job.id);
  await began;
  runner.pause(job.id);
  release();
  await running;
  const editable = runner.editableTask(job.id);
  assert.equal(editable.canEdit, true);
  assert.equal(editable.version, 0);
  const current = getJob(job.id);
  const edited = { ...current.config, segmentIds: current.config.segmentIds,
    actionPlan: current.config.actionPlan.map(item => ({ ...item, count: 3 })) };
  const result = runner.applyTaskEdit(job.id, edited, editable.version, { resume: true });
  assert.equal(result.version, 1);
  await runner.run(job.id);
  assert.equal(getJob(job.id).status, 'completed');
  assert.equal(calls, 3, '已成功的首项保留，修改后补足到新的总次数');
  assert.equal(getJob(job.id).metrics.success, 3);
});

test('engage 中途停止释放租约', async () => {
  const { job, leases } = await interruptedRun('stop');
  assert.ok(['stopped', 'stopping'].includes(getJob(job.id).status));
  assert.equal(leases.owners.size, 0);
});

test('engage 抛出 VerificationError 释放租约并留下验证卡', async () => {
  const { runner, job, leases } = await interruptedRun('verify');
  assert.equal(runner.workflow.status(getJob(job.id)).cards.length, 1);
  assert.equal(leases.owners.size, 0);
});

test('engage 普通异常不会泄漏租约', async () => {
  const { job, leases } = await interruptedRun('error');
  assert.equal(getJob(job.id).status, 'completed');
  // 提交后抛错的普通异常按“结果未知”处理，不再重发。
  assert.ok(getJob(job.id).metrics.uncertain >= 1);
  assert.ok(listActionLogs(job.id).some(item => item.state === 'uncertain'));
  assert.equal(leases.owners.size, 0);
});

test('工作台仍按每一步释放租约与浏览器', async () => {
  const a1 = identity('工作台A', '8431'), a2 = identity('工作台B', '8432');
  const topic = createTopic({ name: '步进超话', url: 'https://example.test/step' });
  const job = createJob(createSnapshot({ accountIds: [a1.id, a2.id], topicIds: [topic.id], rounds: 1, actionPlan: [{ type: 'checkin', count: 1, intervalSeconds: 0 }] }, listAccounts(), dbModule.listTopics()));
  const { leases, acquisitions } = trackedLeases();
  const ownersAtCall = [];
  let closes = 0;
  const adapter = {
    probeConnectivity: async () => true,
    ensureIdentity: async acc => ({ uid: acc.uid, status: 'valid' }),
    browserManager: { closeRunner: async () => { closes += 1; } },
    checkin: async (account, target, options) => {
      ownersAtCall.push(leases.owners.size);
      options.onSubmit?.();
      return { state: 'succeeded' };
    }
  };
  const runner = new TaskRunner(adapter, { scope: 'workbench', leases });
  await runner.run(job.id);
  assert.equal(getJob(job.id).status, 'completed');
  assert.deepEqual(ownersAtCall, [1, 1]);
  // 同样有一次开跑前的网络探测租约；两步各取各放，共 2 次组内租约。
  assert.equal(acquisitions.length, 3);
  assert.equal(acquisitions.slice(1).length, 2);
  assert.equal(closes, 3);
  assert.equal(leases.owners.size, 0);
});

test('新版内赞使用 likeNextComment，每次只点一个新赞并传递目标与排除键', async () => {
  const account = identity('内赞账号', '8441');
  const job = engageJob([account.id], [LINK_A], [{ type: 'comment_like', count: 3, intervalSeconds: 0 }]);
  const calls = [], targets = [];
  let scanCalls = 0, likeCalls = 0;
  const adapter = {
    probeConnectivity: async () => true,
    ensureIdentity: async acc => ({ uid: acc.uid, status: 'valid' }),
    browserManager: { closeRunner: async () => {} },
    scanComments: async () => { scanCalls += 1; return []; },
    likeComment: async () => { likeCalls += 1; return { state: 'succeeded' }; },
    likeNextComment: async (acc, link, options) => {
      calls.push({ excluded: [...options.excludedKeys] });
      assert.equal(typeof options.onTarget, 'function');
      assert.equal(typeof options.onSubmit, 'function');
      assert.equal(typeof options.assertRunning, 'function');
      options.assertRunning();
      const target = { id: 'c' + calls.length, key: 'k' + calls.length, authorUid: '9001', text: '评论' + calls.length };
      targets.push(target);
      options.onTarget(target);
      options.onSubmit();
      return { state: 'succeeded', succeeded: true, targetId: target.key, successSource: 'page_color' };
    }
  };
  const { leases } = trackedLeases();
  const runner = new TaskRunner(adapter, { scope: 'engage', leases });
  await runner.run(job.id);
  assert.equal(getJob(job.id).status, 'completed');
  assert.equal(calls.length, 3);
  assert.equal(scanCalls, 0, '新版内赞不应回落到 scanComments 池');
  assert.equal(likeCalls, 0, '新版内赞不应回落到 likeComment');
  assert.equal(leases.owners.size, 0);
  const logs = listActionLogs(job.id).filter(item => item.kind === 'comment_like');
  assert.equal(logs.length, 3);
  assert.ok(logs.every(item => item.state === 'succeeded'));
  assert.ok(logs.every(item => item.success_source === 'page_color'));
  assert.deepEqual(new Set(logs.map(item => item.target_id)), new Set(['k1', 'k2', 'k3']));
  assert.deepEqual(Object.keys(targets[0]).sort(), ['authorUid', 'id', 'key', 'text']);
  assert.deepEqual(new Set(calls[2].excluded), new Set(['k1', 'k2']));
});

test('内赞没有更多目标时按 skipped/exhausted 结束', async () => {
  const account = identity('内赞耗尽', '8442');
  const job = engageJob([account.id], [LINK_A], [{ type: 'comment_like', count: 3, intervalSeconds: 0 }]);
  let calls = 0;
  const adapter = {
    probeConnectivity: async () => true,
    ensureIdentity: async acc => ({ uid: acc.uid, status: 'valid' }),
    browserManager: { closeRunner: async () => {} },
    likeNextComment: async () => { calls += 1; return { state: 'skipped', skipped: true, reason: 'exhausted' }; }
  };
  const { leases } = trackedLeases();
  const runner = new TaskRunner(adapter, { scope: 'engage', leases });
  await runner.run(job.id);
  assert.equal(getJob(job.id).status, 'completed');
  assert.ok(calls >= 1 && calls <= 3);
  const logs = listActionLogs(job.id).filter(item => item.kind === 'comment_like');
  assert.equal(logs.length, 3);
  assert.ok(logs.every(item => item.state === 'skipped'));
  assert.equal(leases.owners.size, 0);
});

test('无 likeNextComment 时内赞仍走 scanComments/likeComment 旧路径', async () => {
  const account = identity('内赞回落', '8443');
  const job = engageJob([account.id], [LINK_A], [{ type: 'comment_like', count: 2, intervalSeconds: 0 }]);
  const clicked = [];
  let scans = 0;
  const adapter = {
    probeConnectivity: async () => true,
    ensureIdentity: async acc => ({ uid: acc.uid, status: 'valid' }),
    browserManager: { closeRunner: async () => {} },
    scanComments: async () => { scans += 1; return [{ id: 'x1' }, { id: 'x2' }]; },
    likeComment: async (acc, link, id, options) => { clicked.push(id); options.onSubmit(); return { state: 'succeeded' }; }
  };
  const { leases } = trackedLeases();
  const runner = new TaskRunner(adapter, { scope: 'engage', leases });
  await runner.run(job.id);
  assert.equal(getJob(job.id).status, 'completed');
  assert.deepEqual(clicked, ['x1', 'x2']);
  assert.ok(scans >= 1);
  assert.equal(getJob(job.id).metrics.success, 2);
  assert.equal(leases.owners.size, 0);
});

async function intervalInterrupt(mode) {
  clearAllDataForTests();
  const account = identity('间隔账号', mode === 'pause' ? '8461' : '8462');
  const job = engageJob([account.id], [LINK_A], [{ type: 'repost', count: 3, intervalSeconds: 1, repostForm: 'plain' }]);
  const { leases } = trackedLeases();
  let calls = 0, runner;
  const adapter = {
    probeConnectivity: async () => true,
    ensureIdentity: async acc => ({ uid: acc.uid, status: 'valid' }),
    browserManager: { closeRunner: async () => {} },
    repostWeibo: async (acc, link, content, options) => {
      calls += 1;
      options.onSubmit();
      if (calls === 1) setTimeout(() => (mode === 'pause' ? runner.pause(job.id) : runner.stop(job.id)), 100);
      return { state: 'succeeded' };
    }
  };
  runner = new TaskRunner(adapter, { scope: 'engage', leases });
  await runner.run(job.id);
  return { job, leases, calls };
}

test('第一步成功后间隔中暂停：不再提交后续并释放组租约', async () => {
  const { job, leases, calls } = await intervalInterrupt('pause');
  assert.equal(calls, 1);
  assert.equal(getJob(job.id).status, 'paused');
  assert.equal(leases.owners.size, 0);
});

test('第一步成功后间隔中停止：不再提交后续并释放组租约', async () => {
  const { job, leases, calls } = await intervalInterrupt('stop');
  assert.equal(calls, 1);
  assert.equal(getJob(job.id).status, 'stopped');
  assert.equal(leases.owners.size, 0);
});

test('普通异常保留当前组会话，后续步骤不重开浏览器', async () => {
  const account = identity('首步异常', '8471');
  const { leases, acquisitions } = trackedLeases();
  let calls = 0;
  const adapter = {
    probeConnectivity: async () => true,
    ensureIdentity: async acc => ({ uid: acc.uid, status: 'valid' }),
    browserManager: { closeRunner: async () => {} },
    repostWeibo: async (acc, link, content, options) => {
      calls += 1;
      options.onSubmit();
      if (calls === 1) throw new Error('模拟首步普通异常');
      return { state: 'succeeded' };
    }
  };
  const runner = new TaskRunner(adapter, { scope: 'engage', leases });
  const job = engageJob([account.id], [LINK_A], [{ type: 'repost', count: 2, intervalSeconds: 0, repostForm: 'plain' }]);
  await runner.run(job.id);
  assert.equal(calls, 2);
  assert.equal(getJob(job.id).status, 'completed');
  assert.ok(getJob(job.id).metrics.uncertain >= 1);
  // 探测 1 次 + 整个链接会话 1 次；首步异常不触发二次开组。
  assert.equal(acquisitions.length, 2);
  assert.equal(leases.owners.size, 0);
  const next = engageJob([account.id], [LINK_A], [{ type: 'repost', count: 1, intervalSeconds: 0, repostForm: 'plain' }]);
  await runner.run(next.id);
  assert.equal(getJob(next.id).status, 'completed');
  assert.equal(calls, 3);
  assert.equal(leases.owners.size, 0);
});

test('旧 schedulerVersion 3 的 taskEditPreview 不会升级到新版本', () => {
  const account = identity('旧版编辑', '8481');
  const job = engageJob([account.id], [LINK_A], [{ type: 'repost', count: 1, intervalSeconds: 0, repostForm: 'plain' }]);
  const legacy = updateJob(job.id, {
    status: 'paused', pausedByUser: true,
    config: { ...getJob(job.id).config, schedulerVersion: 3, snapshotVersion: 5 }
  });
  const runner = new TaskRunner({ probeConnectivity: async () => true, ensureIdentity: async acc => ({ uid: acc.uid }), browserManager: {} }, { scope: 'engage' });
  const preview = runner.taskEditPreview(job.id, { rounds: 2 }, legacy.cursor.configVersion);
  assert.equal(preview.config.kind, 'engage');
  assert.equal(preview.config.schedulerVersion, 3);
});

test('manager.generation 与 accountId 稳定时组内仍只确认一次身份', async () => {
  const account = identity('代际账号', '8491');
  const job = engageJob([account.id], [LINK_A], [{ type: 'repost', count: 3, intervalSeconds: 0, repostForm: 'plain' }]);
  const { leases, acquisitions } = trackedLeases();
  let identities = 0, closes = 0;
  const adapter = {
    probeConnectivity: async () => true,
    ensureIdentity: async acc => { identities += 1; return { uid: acc.uid, status: 'valid' }; },
    browserManager: { generation: 7, accountId: account.id, closeRunner: async () => { closes += 1; } },
    repostWeibo: async (acc, link, content, options) => { options.onSubmit(); return { state: 'succeeded' }; }
  };
  const runner = new TaskRunner(adapter, { scope: 'engage', leases });
  await runner.run(job.id);
  assert.equal(getJob(job.id).status, 'completed');
  assert.equal(identities, 1);
  assert.equal(acquisitions.length, 2);
  assert.equal(closes, 2);
  assert.equal(leases.owners.size, 0);
});

test('两页同账号冲突时较早任务保留，后到任务先做其他账号并在释放后补做', async () => {
  const a1 = identity('冲突账号A', '8461'), a2 = identity('冲突账号B', '8462');
  const topic = createTopic({ name: '冲突超话', url: 'https://weibo.com/p/100808fixture' });
  addPostMaterials(['冲突发帖文案甲', '冲突发帖文案乙']);
  addCommentMaterials(['冲突评论文案', '冲突评论文案二']);
  const workJob = createJob(createSnapshot({ accountIds: [a1.id, a2.id], topicIds: [topic.id], rounds: 1,
    actionPlan: [{ type: 'post', count: 1, intervalSeconds: 0 }] }, listAccounts(), dbModule.listTopics()));
  const engageJob = createJob(createSnapshot({ kind: 'engage', accountIds: [a1.id, a2.id], links: [LINK_A], rounds: 1,
    actionPlan: [{ type: 'comment', count: 1, intervalSeconds: 0 }] }, listAccounts(), []));
  const leases = new AccountLeases();
  let releaseA, holdingA;
  const heldA = new Promise(resolve => { holdingA = resolve; });
  const release = new Promise(resolve => { releaseA = resolve; });
  const workPosts = [], comments = [];
  const workRunner = new TaskRunner({
    probeConnectivity: async () => true,
    ensureIdentity: async item => ({ uid: item.uid, status: 'valid' }),
    browserManager: { closeRunner: async () => {} },
    post: async (account, _topic, _content, options) => {
      workPosts.push(account.uid); options.onSubmit();
      if (account.uid === a1.uid) { holdingA(); await release; }
      return { state: 'succeeded', receiptId: 'receipt-' + account.uid };
    }
  }, { scope: 'workbench', leases });
  const engageRunner = new TaskRunner({
    probeConnectivity: async () => true,
    ensureIdentity: async item => ({ uid: item.uid, status: 'valid' }),
    browserManager: { closeRunner: async () => {} },
    comment: async (account, candidate, _content, options) => {
      comments.push(account.uid); options.onSubmit();
      return { state: 'succeeded', url: candidate.url };
    }
  }, { scope: 'engage', leases });
  const workPromise = workRunner.run(workJob.id);
  await heldA;
  const engagePromise = engageRunner.run(engageJob.id);
  const deadline = Date.now() + 4000;
  while (!comments.includes(a2.uid) && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 20));
  assert.deepEqual(comments, [a2.uid], '冲突账号先跳过，立即执行其他账号');
  assert.equal(getJob(engageJob.id).cursor.postponedAccounts[a1.uid]?.accountId, a1.id);
  releaseA();
  await workPromise;
  await engagePromise;
  const end = Date.now() + 8000;
  while (getJob(engageJob.id).status !== 'completed' && Date.now() < end) await new Promise(resolve => setTimeout(resolve, 50));
  assert.equal(getJob(engageJob.id).status, 'completed');
  assert.deepEqual(comments.sort(), [a1.uid, a2.uid].sort());
  assert.equal(getJob(engageJob.id).metrics.failed, 0);
  assert.equal(getJob(engageJob.id).metrics.skipped, 0);
});

test('engage 组内间隔期间 network.monitor/probe 不重入租约也不关闭 manager', async () => {
  const account = identity('监控账号', '8501');
  const job = engageJob([account.id], [LINK_A], [{ type: 'repost', count: 2, intervalSeconds: 1, repostForm: 'plain' }]);
  const { leases, acquisitions } = trackedLeases();
  const closes = [], inside = [];
  let runner, calls = 0, pending = null;
  const adapter = {
    probeConnectivity: async () => true,
    ensureIdentity: async acc => ({ uid: acc.uid, status: 'valid' }),
    browserManager: { closeRunner: async () => { closes.push('close'); } },
    repostWeibo: async (acc, link, content, options) => {
      calls += 1;
      options.onSubmit();
      if (calls === 1) {
        // 第一步完成后的间隔期没有 currentExecution，正是 monitor 会临时取租的时机。
        pending = new Promise(resolve => setTimeout(async () => {
          const before = closes.length;
          await runner.network.probe(getJob(job.id));
          await runner.network.monitor(getJob(job.id));
          inside.push({ owners: leases.owners.size, closeDelta: closes.length - before });
          resolve();
        }, 200));
      }
      return { state: 'succeeded' };
    }
  };
  runner = new TaskRunner(adapter, { scope: 'engage', leases });
  await runner.run(job.id);
  await pending;
  assert.equal(calls, 2);
  assert.deepEqual(inside, [{ owners: 1, closeDelta: 0 }]);
  assert.equal(acquisitions.length, 2, '探测 1 次 + 组会话 1 次，组内监控不得再取租');
  assert.equal(closes.length, 2, '组内监控不得 closeRunner');
  assert.equal(getJob(job.id).status, 'completed');
  assert.equal(leases.owners.size, 0);
});
