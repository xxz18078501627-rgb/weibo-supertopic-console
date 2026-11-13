import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { execFileSync } from 'node:child_process';
import { shanghaiDate } from '../src/util.js';

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'weibo-console-core-'));
process.env.WEIBO_CONSOLE_DATA_DIR = tempDir;
process.env.WEIBO_CONSOLE_LICENSE = 'off';
process.env.WEIBO_CONSOLE_TOPIC_MODE = 'general';

const dbModule = await import('../src/db.js');
const runnerModule = await import('../src/runner.js');

const {
  addCommentMaterials, addOriginalMaterials, addPostMaterials, clearAccountRestrictions, clearAccountRestrictionsFromOpenJobs, clearAllDataForTests, createAccount, createActionLog, createJob, createMaterialGroup, migrateRefreshDefaults,
  createTopic, getActionLog, getJob, hasCommented, listActionLogs, pickCommentMaterial, recordAccountRestriction, listActiveAccountRestrictions, seedAccountRestrictionsFromJobs, updateAccountAuth, updateActionLog
} = dbModule;
const { buildSteps, createSnapshot, TaskRunner, validateSnapshot } = runnerModule;
const { decorateText } = runnerModule;
const { db, getAccount, getSetting, setSetting, nextSequence, listAccounts, listTopics, listOriginalMaterials, listPostMaterials, recordComment } = dbModule;
const { migrateSharedMaterials } = await import('../src/migrations.js');
const { normalizeTaskSettings, DEFAULT_EMOJIS } = await import('../public/defaults.js');
const { LoginService } = await import('../src/login-service.js');
const { BrowserManager } = await import('../src/browser.js');
const { defaultTaskConfig } = await import('../src/config.js');
const { listAccountGroups, saveAccountGroup, deleteAccountGroup, moveAccountsToGroup } = await import('../src/account-groups.js');
const { dailySuccess, startRound, finishRound, listRoundReports, pendingRoundReports, acknowledgeRound } = await import('../src/task-reports.js');
const { buildLanAccess } = await import('../src/lan-access.js');
const { notifyRound } = await import('../src/notifications.js');
const { dailyStopStatus, deadlineFor, DailyStopError } = await import('../src/daily-stop.js');
const { BODY_READ_TIMEOUT_MS, IdentityMismatchError, RateLimitError, UnsupportedPageError, VerificationError, WeiboAdapter, classifyPostReceipt, commentRowMatches, isRateLimitMessage, normalizeWeiboNickname, normalizeWeiboText, postReadbackMatches, readJsonBounded, settleBounded, verificationPageUrl, visibleCommentMatches, weiboShortIdToNumeric } = await import('../src/weibo-adapter.js');

test('发帖验证卡和身份确认直接从主页打开，其他操作保留目标页', () => {
  const topic = { url: 'https://weibo.com/p/100808topic' };
  assert.equal(verificationPageUrl({ kind: 'post' }, topic), 'https://weibo.com/');
  assert.equal(verificationPageUrl({ kind: 'post', url: 'https://weibo.com/77/abc' }, topic), 'https://weibo.com/');
  assert.equal(verificationPageUrl({ kind: 'original', url: 'https://weibo.com/77/stale' }, null), 'https://weibo.com/');
  assert.equal(verificationPageUrl({ kind: 'checkin' }, topic), topic.url);
  assert.equal(verificationPageUrl({ kind: 'comment', forceTopic: true,
    url: 'https://weibo.com/77/stale-target' }, topic), topic.url);
});

test.beforeEach(() => { clearAllDataForTests(); db.exec('DELETE FROM account_groups'); setSetting('task_defaults', defaultTaskConfig); setSetting('task_templates', []); });
test('工作台发帖待核对在任务结束后进入只读复核候选，最多两次', () => {
  const account = createAccount('核对账号');
  const topic = createTopic({ name: '核对超话', url: 'https://weibo.com/p/100808verification' });
  addPostMaterials(['核对文案一', '核对文案二']);
  const snapshot = createSnapshot({ rounds: 1, accountIds: [account.id], topicIds: [topic.id],
    actionPlan: [{ type: 'post', count: 1, intervalSeconds: 0 }] }, listAccounts(), listTopics());
  const job = createJob(snapshot);
  dbModule.updateJob(job.id, { status: 'completed', cursor: { autoReadbacks: {} } });
  db.prepare('INSERT INTO action_logs(id,job_id,step_key,kind,account_id,state,error,started_at,submitted_at) VALUES(?,?,?,?,?,?,?,?,?)')
    .run('uncertain-post', job.id, 'post-step', 'post', account.id, 'uncertain', '提交后结果无法确认', new Date().toISOString(), new Date().toISOString());
  const runner = new TaskRunner({ browserManager: {} }, { scope: 'workbench' });
  assert.deepEqual(runner.autoReadbackCandidates(getJob(job.id)).map(item => item.id), ['uncertain-post']);
  dbModule.updateJob(job.id, { cursor: { autoReadbacks: { 'uncertain-post': { attempts: 2 } } } });
  assert.deepEqual(runner.autoReadbackCandidates(getJob(job.id)), []);
});

test('自动只读复核只为已完成任务排队，已停止任务不再启动浏览器', () => {
  const account = createAccount('停止复核账号');
  const topic = createTopic({ name: '停止复核超话', url: 'https://weibo.com/p/100808stopreadback' });
  addPostMaterials(['停止复核文案一', '停止复核文案二']);
  const snapshot = createSnapshot({ rounds: 1, accountIds: [account.id], topicIds: [topic.id],
    actionPlan: [{ type: 'post', count: 1, intervalSeconds: 0 }] }, listAccounts(), listTopics());
  const job = createJob(snapshot);
  const runner = new TaskRunner({ browserManager: {} }, { scope: 'workbench' });
  dbModule.updateJob(job.id, { status: 'stopped', cursor: { autoReadbacks: {} } });
  db.prepare('INSERT INTO action_logs(id,job_id,step_key,kind,account_id,state,error,started_at,submitted_at) VALUES(?,?,?,?,?,?,?,?,?)')
    .run('stopped-uncertain-post', job.id, 'post-step', 'post', account.id, 'uncertain', '提交后结果无法确认', new Date().toISOString(), new Date().toISOString());
  runner.scheduleAutoReadbacks(job.id);
  assert.equal(runner.readbackTimers.has(job.id), false);
  dbModule.updateJob(job.id, { status: 'completed' });
  runner.scheduleAutoReadbacks(job.id);
  assert.equal(runner.readbackTimers.has(job.id), true);
  runner.cancelAutoReadbacks(job.id);
});
test('记录全天聚合、游标分页、异常去重与任务计数', async () => {
  const { recordView } = await import('../src/record-view.js');
  const stamp='2026-10-30T03:00:00.000Z';
  const a=createAccount(), b=createAccount();
  db.prepare('UPDATE accounts SET uid=?,name=? WHERE id=?').run('123456','账号甲',a.id);
  db.prepare('UPDATE accounts SET uid=?,name=? WHERE id=?').run('123456','旧昵称',b.id);
  db.prepare('INSERT INTO jobs(id,status,config_json,cursor_json,metrics_json,created_at,updated_at) VALUES(?,?,?,?,?,?,?)').run('records-test','completed',JSON.stringify({accountIdentities:{[a.id]:{name:'历史昵称',uid:'123456'}}}),'{}','{}',stamp,stamp);
  const insert=db.prepare('INSERT INTO action_logs(id,job_id,step_key,kind,account_id,state,error,started_at) VALUES(?,?,?,?,?,?,?,?)');
  for(let i=0;i<550;i++)insert.run('record-'+i,'records-test',String(i),'comment',i%2?a.id:b.id,i===0?'failed':'succeeded',i===0?'操作频繁，请稍后重试':null,stamp);
  let view=recordView('2026-10-30',{query:'123456',identity:'123456'});
  assert.equal(view.accounts.length,1);assert.equal(view.accounts[0].counts.comment.succeeded,549);
  assert.equal(view.detailTotal,550);assert.equal(view.details.length,20);assert.ok(view.nextCursor);
  const page2=recordView('2026-10-30',{query:'123456',identity:'123456',cursor:view.nextCursor,snapshot:view.snapshot});
  assert.equal(page2.details.length,20);
  assert.equal(new Set([...view.details,...page2.details].map(row=>row.sortId)).size,40);
  assert.equal(view.issues[0].type,'频繁');assert.equal(view.issues[0].kind,'comment');
  assert.equal(recordView('2026-10-30',{query:'历史昵称',abnormalOnly:true}).accounts.length,1);
  assert.equal(recordView('2026-10-30',{query:'不存在'}).accounts.length,0);
  const tail=recordView('2026-10-30',{identity:'123456',offset:500});
  assert.equal(tail.details.length,20);assert.equal(tail.detailTotal,550);
});
test('同一事件多来源在一分钟内合并，超时分开计数', async () => {
  const { recordView, problemType } = await import('../src/record-view.js');
  const account = createAccount();
  db.prepare('UPDATE accounts SET uid=?,name=? WHERE id=?').run('998877','合并账号',account.id);
  const job='merge-job';
  db.prepare('INSERT INTO jobs(id,status,config_json,cursor_json,metrics_json,created_at,updated_at) VALUES(?,?,?,?,?,?,?)').run(job,'completed',JSON.stringify({accountIdentities:{[account.id]:{name:'合并账号',uid:'998877'}}}),JSON.stringify({rateLimits:[{at:'2026-10-30T03:10:00.000Z',identity:'998877',kind:'comment',reason:'操作频繁，请稍后重试',round:0},{at:'2026-10-30T03:20:00.000Z',identity:'998877',kind:'comment',reason:'操作频繁，请稍后重试',round:0}]}),'{}','2026-10-30T01:00:00.000Z','2026-10-30T03:30:00.000Z');
  const insert=db.prepare('INSERT INTO action_logs(id,job_id,step_key,kind,account_id,state,error,started_at) VALUES(?,?,?,?,?,?,?,?)');
  insert.run('merge-1',job,'0','comment',account.id,'skipped','操作频繁，请稍后重试','2026-10-30T03:10:20.000Z');
  insert.run('merge-2',job,'1','comment',account.id,'verification_wait','需要人工验证','2026-10-30T03:15:00.000Z');
  db.prepare('INSERT INTO verification_cards(job_id,round_index,identity,account_id,status,reason,triggered_at,updated_at) VALUES(?,?,?,?,?,?,?,?)').run(job,0,'998877',account.id,'ready','安全验证','2026-10-30T03:15:00.000Z','2026-10-30T03:15:00.000Z');
  const view=recordView('2026-10-30',{});
  const frequent=view.issues.filter(issue=>issue.type==='频繁');
  assert.equal(frequent.length,2);
  assert.equal(frequent[0].kind,'comment');
  const verify=view.issues.filter(issue=>issue.type==='待验证');
  assert.equal(verify.length,1);assert.equal(verify[0].count,1);
  assert.equal(problemType('网络异常，验证码加载失败'),'待验证');
});
test('任务卡计数不受500条窗口限制', async () => {
  const { countActionsByJob } = await import('../src/db.js');
  const account = createAccount();
  db.prepare('INSERT INTO jobs(id,status,config_json,cursor_json,metrics_json,created_at,updated_at) VALUES(?,?,?,?,?,?,?)').run('big-job','completed','{}','{}','{}','2026-10-30T01:00:00.000Z','2026-10-30T05:00:00.000Z');
  const insert=db.prepare('INSERT INTO action_logs(id,job_id,step_key,kind,account_id,state,error,started_at) VALUES(?,?,?,?,?,?,?,?)');
  for(let i=0;i<720;i++)insert.run('big-'+i,'big-job',String(i),'comment',account.id,i%10===0?'failed':'succeeded',i%10===0?'操作失败':null,'2026-10-30T03:00:00.000Z');
  const counts=countActionsByJob('2026-10-30');
  assert.equal(counts['big-job'].succeeded+counts['big-job'].failed,720);
  assert.equal(counts['big-job'].failed,72);
});
test('历史身份取最新事件昵称，缺失映射时按任务快照回退', async () => {
  const { recordView } = await import('../src/record-view.js');
  const account = createAccount();
  db.prepare('UPDATE accounts SET uid=?,name=? WHERE id=?').run('556677','当前昵称',account.id);
  db.prepare('INSERT INTO jobs(id,status,config_json,cursor_json,metrics_json,created_at,updated_at) VALUES(?,?,?,?,?,?,?)').run('old-job','completed',JSON.stringify({accountIdentities:{[account.id]:{name:'旧昵称',uid:'556677'}}}),'{}','{}','2026-10-30T01:00:00.000Z','2026-10-30T01:10:00.000Z');
  db.prepare('INSERT INTO jobs(id,status,config_json,cursor_json,metrics_json,created_at,updated_at) VALUES(?,?,?,?,?,?,?)').run('new-job','completed',JSON.stringify({accountIdentities:{[account.id]:{name:'新昵称',uid:'556677'}}}),'{}','{}','2026-10-30T02:00:00.000Z','2026-10-30T02:10:00.000Z');
  db.prepare('INSERT INTO jobs(id,status,config_json,cursor_json,metrics_json,created_at,updated_at) VALUES(?,?,?,?,?,?,?)').run('bare-job','completed','{}','{}','{}','2026-10-30T03:00:00.000Z','2026-10-30T03:10:00.000Z');
  const insert=db.prepare('INSERT INTO action_logs(id,job_id,step_key,kind,account_id,state,error,started_at) VALUES(?,?,?,?,?,?,?,?)');
  insert.run('name-1','old-job','0','post',account.id,'succeeded',null,'2026-10-30T01:05:00.000Z');
  insert.run('name-2','new-job','0','post',account.id,'succeeded',null,'2026-10-30T02:05:00.000Z');
  insert.run('name-3','bare-job','0','post',account.id,'succeeded',null,'2026-10-30T04:05:00.000Z');
  const view=recordView('2026-10-30',{});
  assert.equal(view.accounts.length,1);
  assert.equal(view.accounts[0].name,'新昵称');
});
test('实测评论回执操作频繁请您稍后再试必须归账号频繁，不避让发帖人', () => {
  assert.equal(isRateLimitMessage('操作频繁，请您稍后再试'), true);
  assert.equal(classifyPostReceipt({ ok: 0, msg: '操作频繁，请您稍后再试' }, false).kind, 'frequent');
});
test('可见验收窗口只首次前置且不最小化，普通任务仍无头', async () => {
  const account = createAccount(); const calls = [];
  const page = {};
  const context = { pages: () => [page], on() {}, close: async () => {} };
  const visible = new BrowserManager(async ({ options }) => { calls.push(options); return context; }, { headless: true, visibleRunner: true });
  let front = 0, minimized = 0;
  visible.foreground = async () => { front++; };
  visible.setWindowState = async () => { minimized++; };
  await visible.page(account); await visible.page(account); await visible.minimize(page);
  assert.equal(calls[0].headless, false); assert.equal(calls[0].args.includes('--start-minimized'), false);
  assert.equal(front, 1); assert.equal(minimized, 0); await visible.close();
  const normal = new BrowserManager(async ({ options }) => { calls.push(options); return context; }, { headless: true });
  await normal.page(account); assert.equal(calls[1].headless, true); await normal.close();
});

test('人工验证使用可视最大化窗口，并通过页面CDP激活持久化Chrome进程', async () => {
  const account = createAccount('可视验证');
  let manualOptions; let activated = null; let windowState = null;
  let sessionCount = 0;
  const session = {
    send: async command => {
      if (command === 'SystemInfo.getProcessInfo') return { processInfo: [{ type: 'browser', id: 4242 }] };
      if (command === 'Browser.getWindowForTarget') return { windowId: 7 };
      if (command === 'Browser.setWindowBounds') return {};
      return {};
    },
    detach: async () => {},
  };
  const page = {
    bringToFront: async () => {},
    context: () => context,
    isClosed: () => false,
  };
  const context = {
    pages: () => [page], on() {}, close: async () => {},
    browser: () => null,
    newCDPSession: async () => { sessionCount += 1; return session; },
  };
  const manager = new BrowserManager(async ({ options }) => { manualOptions = options; return context; }, {
    headless: true, activate: async pid => { activated = pid; return true; },
  });
  await manager.page(account, 'manual');
  assert.equal(manualOptions.headless, false);
  assert.ok(manualOptions.args.includes('--start-maximized'));
  manager.setWindowState = async (_page, state) => { windowState = state; return true; };
  await manager.foreground(page, { windowState: 'maximized' });
  assert.equal(windowState, 'maximized');
  assert.equal(activated, 4242);
  assert.ok(sessionCount >= 1, '浏览器级CDP不可用时应回退到页面CDP');
  await manager.close();
});
test.after(async () => {
  await new Promise(resolve => setTimeout(resolve, 300));
  try { dbModule.db.close(); } catch {}
  try { fs.rmSync(tempDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); } catch {}
});

const cutoff = Date.parse('2030-03-15T23:59:00+08:00');
function cutoffFixture(actionPlan = [{ type: 'post', count: 1, intervalSeconds: 0 }]) {
  const account = createAccount('截止测试');
  const topic = createTopic({ name: '截止超话', url: 'https://example.test/cutoff' });
  addPostMaterials(['截止文案', '截止文案二']); addCommentMaterials(['评论甲', '评论乙']);
  const config = createSnapshot({ accountIds: [account.id], topicIds: [topic.id], actionPlan, postDecoration: { mode: 'number' }, roundIntervalSeconds: 0 }, listAccounts(), listTopics());
  config.schedulerVersion = 1;
  const job = createJob(config);
  dbModule.updateJob(job.id, { cursor: { stepIndex: 0, deadlineAt: new Date(cutoff).toISOString() } });
  return { account, topic, job: getJob(job.id) };
}

function startLegacy(runner, input, accounts, topics) {
  const job = createJob({ ...createSnapshot(input, accounts, topics), schedulerVersion: 1 });
  runner.run(job.id); return { job, created: true };
}

test('每日截止固定北京时间，23:59拦截，到次日00:00允许新任务', () => {
  assert.equal(dailyStopStatus(cutoff - 1000).blocked, false);
  assert.equal(dailyStopStatus(cutoff).blocked, true);
  assert.equal(dailyStopStatus(cutoff + 59999).blocked, true);
  assert.equal(dailyStopStatus(cutoff + 60000).blocked, false);
  assert.equal(Date.parse(dailyStopStatus(cutoff).blockedUntil), cutoff + 60000);
  assert.equal(deadlineFor(cutoff + 60000), cutoff + 86400000);
  let time = cutoff;
  const runner = new TaskRunner({}, { now: () => time });
  assert.throws(() => runner.start({}, [], []), error => error instanceof DailyStopError && error.statusCode === 409);
  const fixture = cutoffFixture();
  runner.enforceDailyStop();
  assert.equal(getJob(fixture.job.id).status, 'stopped');
  time += 60000;
  assert.throws(() => runner.resume(fixture.job.id), /新建任务/);
  runner.run = () => {};
  const next = runner.start({ accountIds: [fixture.account.id], topicIds: [fixture.topic.id], actionPlan: [{ type: 'post', count: 1 }] }, listAccounts(), listTopics());
  assert.equal(next.created, true);
  assert.equal(Date.parse(next.job.cursor.deadlineAt), cutoff + 86400000);
  assert.equal(getJob(fixture.job.id).status, 'stopped');
});

test('截止时取消未提交操作，不增加失败、不占编号，迟到提交即使跨日也被阻止', async () => {
  const { job } = cutoffFixture();
  let time = cutoff - 1000, release, prepared = false, writes = 0;
  const hold = new Promise(resolve => { release = resolve; });
  const runner = new TaskRunner({ ensureIdentity: async () => ({}), post: async (_account, _topic, _text, options) => {
    prepared = true; await hold; options.onSubmit(); writes++; return { state: 'succeeded' };
  } }, { now: () => time });
  let completed = 0; runner.on('round-completed', () => completed++);
  const running = runner.loop(job.id);
  await waitFor(() => prepared);
  time = cutoff; runner.enforceDailyStop();
  await running;
  assert.equal(getJob(job.id).status, 'stopped');
  assert.equal(listActionLogs(job.id)[0].state, 'skipped');
  assert.equal(getJob(job.id).metrics.failed, 0);
  assert.equal(getJob(job.id).metrics.skipped, 1);
  assert.equal(listActionLogs(job.id)[0].sequence_confirmed, 0);
  assert.equal(completed, 0);
  time = cutoff + 60000; release(); await new Promise(setImmediate);
  assert.equal(writes, 0);
  assert.equal(getJob(job.id).status, 'stopped');
  assert.equal(listRoundReports(job.id)[0].stopReason, '每日 23:59 自动停止');
});

test('已提交操作在截止后只核验，成功结果保留但任务和轮次中止', async () => {
  const { job } = cutoffFixture();
  let time = cutoff - 1000, release, submitted = false, calls = 0;
  const hold = new Promise(resolve => { release = resolve; });
  const runner = new TaskRunner({ ensureIdentity: async () => ({}), post: async (_account, _topic, _text, options) => {
    calls++; options.onSubmit(); submitted = true; await hold; return { state: 'succeeded', url: 'https://example.test/sent' };
  } }, { now: () => time });
  let completed = 0; runner.on('round-completed', () => completed++);
  const running = runner.loop(job.id);
  await waitFor(() => submitted);
  time = cutoff; runner.enforceDailyStop();
  assert.equal(listActionLogs(job.id)[0].state, 'submitted');
  assert.notEqual(getJob(job.id).status, 'stopped');
  time += 1000; release(); await running;
  assert.equal(getJob(job.id).status, 'stopped');
  assert.equal(getJob(job.id).metrics.success, 1);
  assert.equal(listActionLogs(job.id)[0].state, 'succeeded');
  assert.equal(getJob(job.id).cursor.sequences.post.next, 2);
  assert.equal(listRoundReports(job.id)[0].status, 'stopped');
  assert.equal(completed, 0); assert.equal(calls, 1);
});

test('提交核验最多保留30秒，超时转待核对，迟到结果不覆盖或重复计数', async () => {
  const { job } = cutoffFixture();
  let time = cutoff - 1000, release, submitted = false;
  const hold = new Promise(resolve => { release = resolve; });
  const runner = new TaskRunner({ ensureIdentity: async () => ({}), post: async (_account, _topic, _text, options) => {
    options.onSubmit(); submitted = true; await hold; return { state: 'succeeded' };
  } }, { now: () => time });
  const running = runner.loop(job.id);
  await waitFor(() => submitted);
  time = cutoff; runner.enforceDailyStop();
  time += 29999; runner.enforceDailyStop();
  assert.notEqual(getJob(job.id).status, 'stopped');
  time++; runner.enforceDailyStop(); await running;
  assert.equal(getJob(job.id).status, 'stopped');
  assert.equal(getJob(job.id).metrics.uncertain, 1);
  assert.equal(listActionLogs(job.id)[0].sequence_confirmed, 1);
  assert.equal(getJob(job.id).cursor.sequences.post.next, 2);
  release(); await new Promise(setImmediate);
  assert.equal(listActionLogs(job.id)[0].state, 'uncertain');
  assert.equal(getJob(job.id).metrics.success, 0);
  runner.enforceDailyStop(); assert.equal(getJob(job.id).metrics.uncertain, 1);
});

test('跨日清理旧提交时，新任务会在旧执行退出后正常启动', async () => {
  const { account, topic, job } = cutoffFixture();
  let time = cutoff - 1000, release, submitted = false, calls = 0;
  const hold = new Promise(resolve => { release = resolve; });
  const runner = new TaskRunner({ ensureIdentity: async () => ({}), post: async (_a, _t, _text, options) => {
    calls++; options.onSubmit(); if (calls === 1) { submitted = true; await hold; } return { state: 'succeeded' };
  } }, { now: () => time });
  runner.run(job.id); await waitFor(() => submitted);
  time = cutoff + 60000;
  const next = runner.start({ accountIds: [account.id], topicIds: [topic.id], actionPlan: [{ type: 'post', count: 1 }] }, listAccounts(), listTopics());
  assert.equal(next.created, true);
  await waitFor(() => getJob(next.job.id).status === 'completed');
  assert.equal(getJob(job.id).status, 'stopped');
  assert.equal(getJob(job.id).metrics.uncertain, 1);
  assert.equal(getJob(next.job.id).metrics.success, 1);
  release(); await new Promise(setImmediate);
});

test('所有暂停及等待验证任务一并中止，扫描与操作和轮间等待中断', async () => {
  const { job } = cutoffFixture();
  const runner = new TaskRunner({}, { now: () => cutoff });
  const paused = createJob(job.config);
  dbModule.updateJob(paused.id, { status: 'paused', pausedByUser: true, cursor: { stepIndex: 0, deadlineAt: new Date(cutoff).toISOString(), verificationRecovery: { step: buildSteps(job.config)[0] } } });
  const timer = setTimeout(() => {}, 60000); runner.verificationTimers.set(paused.id, timer);
  runner.enforceDailyStop();
  assert.equal(getJob(job.id).status, 'stopped');
  assert.equal(getJob(paused.id).status, 'stopped');
  assert.equal(getJob(paused.id).cursor.verificationRecovery, null);
  assert.equal(runner.verificationTimers.size, 0);
  assert.equal(await runner.interruptibleWait(job.id, 10000, '等待下一轮'), false);
  assert.equal(await runner.interruptibleWait(job.id, 10000, '等待下一项操作'), false);
  assert.throws(() => runner.assertMaySubmit(job.id), DailyStopError);
});

test('扫描中到点立即取消，迟到的扫描结果不能触发评论或恢复等待状态', async () => {
  const { job } = cutoffFixture([{ type: 'comment', count: 1, intervalSeconds: 0 }]);
  let time = cutoff - 1000, release, scanning = false, sends = 0;
  const hold = new Promise(resolve => { release = resolve; });
  const runner = new TaskRunner({ ensureIdentity: async () => ({}), collectCandidates: async (_account, _topic, options) => {
    scanning = true; await hold; options.assertRunning(); return [];
  }, comment: async () => { sends++; } }, { now: () => time });
  const running = runner.loop(job.id); await waitFor(() => scanning);
  time = cutoff; runner.enforceDailyStop(); await running;
  assert.equal(getJob(job.id).status, 'stopped');
  release(); await new Promise(setImmediate);
  assert.equal(sends, 0); assert.equal(getJob(job.id).status, 'stopped');
  assert.equal(getJob(job.id).metrics.failed, 0);
});

test('每日停止只关闭任务Chrome，不关闭扫码登录窗口', async () => {
  let closed = 0;
  const manager = new BrowserManager();
  manager.context = { close: async () => { closed++; } }; manager.owner = 'login';
  await manager.closeRunner(); assert.equal(closed, 0); assert.equal(manager.owner, 'login');
  manager.owner = 'runner'; await manager.closeRunner(); assert.equal(closed, 1);
});

test('跨日重启先中止过期旧任务，不检测身份或恢复提交', async () => {
  const { job } = cutoffFixture();
  // Also cover jobs created before the deadline field was introduced.
  dbModule.updateJob(job.id, { cursor: { stepIndex: 0 } });
  db.prepare('UPDATE jobs SET created_at=? WHERE id=?').run('2030-03-15T12:00:00+08:00', job.id);
  let reads = 0;
  const runner = new TaskRunner({ ensureIdentity: async () => { reads++; } }, { now: () => cutoff + 60000 });
  await runner.recover();
  assert.equal(getJob(job.id).status, 'stopped'); assert.equal(reads, 0);
  assert.equal(Date.parse(getJob(job.id).cursor.deadlineAt), cutoff);
});

test('逐段间隔迁移保留明确值，旧统一间隔采用类型默认且快照继承保存值', () => {
  const plan = [{ type: 'checkin', count: 1 }, { type: 'post', count: 2 }, { type: 'comment', count: 1 }, { type: 'post', count: 1, intervalSeconds: 20 }];
  const legacy = normalizeTaskSettings({ actionPlan: plan, actionIntervalSeconds: 3 });
  assert.deepEqual(legacy.actionPlan.map(x => x.intervalSeconds), [5, 10, 3, 20]);
  assert.equal('actionIntervalSeconds' in legacy, false);
  const custom = normalizeTaskSettings({ actionPlan: plan, postIntervalSeconds: 0 });
  assert.deepEqual(custom.actionPlan.map(x => x.intervalSeconds), [5, 0, 3, 20]);
  assert.deepEqual(normalizeTaskSettings(legacy), legacy);
  setSetting('task_defaults', { ...legacy, scanLimit: 77 });
  const snapshot = createSnapshot({ rounds: 2 }, [], []);
  assert.deepEqual(snapshot.actionPlan, legacy.actionPlan);
  assert.equal(snapshot.scanLimit, 77);
  const runner = new TaskRunner({});
  assert.equal(runner.intervalFor({ actionPlan: [{ type: 'post' }], actionIntervalSeconds: 9 }, { kind: 'post', actionIndex: 0 }), 9);
  assert.equal(runner.intervalFor({ actionPlan: [{ type: 'post', intervalSeconds: 0 }], postIntervalSeconds: 9 }, { kind: 'post', actionIndex: 0 }), 0);
});

test('扫描与刷新间隔支持自定义，旧 30 秒默认只迁移一次', () => {
  const defaults = normalizeTaskSettings({ candidateRefreshSeconds: 2, scanLimit: 7 });
  assert.equal(defaults.candidateRefreshSeconds, 3);
  assert.equal(defaults.scanLimit, 7);
  assert.equal(normalizeTaskSettings({ candidateRefreshSeconds: 0 }).candidateRefreshSeconds, 0);
  const previousDefaults = getSetting('task_defaults', {});
  const previousTemplates = getSetting('task_templates', []);
  try {
    setSetting('task_defaults', { ...previousDefaults, candidateRefreshSeconds: 30 });
    setSetting('task_templates', [{ id: 'refresh-migration', name: '旧模板', config: { candidateRefreshSeconds: 30 } }]);
    setSetting('refresh_default_v2', false);
    assert.equal(migrateRefreshDefaults(), true);
    assert.equal(getSetting('task_defaults').candidateRefreshSeconds, 3);
    assert.equal(getSetting('task_templates')[0].config.candidateRefreshSeconds, 3);
    setSetting('task_defaults', { ...getSetting('task_defaults'), candidateRefreshSeconds: 30 });
    assert.equal(migrateRefreshDefaults(), false);
    assert.equal(getSetting('task_defaults').candidateRefreshSeconds, 30);
  } finally {
    setSetting('task_defaults', previousDefaults);
    setSetting('task_templates', previousTemplates);
    setSetting('refresh_default_v2', true);
  }
});

test('启动迁移持久保存设置和模板的逐段间隔，但不改写旧任务快照', () => {
  const config = { actionIntervalSeconds: 3, actionPlan: [{ type: 'checkin', count: 1 }, { type: 'post', count: 1 }, { type: 'comment', count: 1 }] };
  setSetting('task_defaults', config);
  setSetting('task_templates', [{ id: 'interval-template', config }]);
  const job = createJob(config);
  const result = execFileSync(process.execPath, ['--input-type=module', '-e', 'const {getSetting}=await import("./src/db.js");console.log(JSON.stringify([getSetting("task_defaults"),getSetting("task_templates")[0].config]))'], { cwd: path.resolve(import.meta.dirname, '..'), env: { ...process.env, WEIBO_CONSOLE_DATA_DIR: tempDir }, encoding: 'utf8' });
  const migrated = JSON.parse(result.trim());
  for (const value of migrated) {
    assert.deepEqual(value.actionPlan.map(x => x.intervalSeconds), [5, 10, 3]);
    assert.equal('actionIntervalSeconds' in value, false);
  }
  assert.deepEqual(getJob(job.id).config, config);
  setSetting('task_templates', []);
});

test('每段间隔用于重复、跨段、跨账号和跨超话，跳过不等待，跨轮不叠加且结束不等待', async () => {
  const accounts = [createAccount(), createAccount()];
  const topics = [createTopic({ name: '甲', url: 'https://example.test/a' }), createTopic({ name: '乙', url: 'https://example.test/b' })];
  const snapshot = { rounds: 2, accountIds: accounts.map(x => x.id), topicIds: topics.map(x => x.id), roundIntervalSeconds: 13, actionPlan: [
    { type: 'post', count: 2, intervalSeconds: 2 },
    { type: 'post', count: 1, intervalSeconds: 7 },
    { type: 'comment', count: 1, intervalSeconds: 0 },
    { type: 'checkin', count: 1, intervalSeconds: 5 }
  ] };
  const job = createJob(snapshot);
  const steps = buildSteps(snapshot), waits = [];
  const runner = new TaskRunner({ ensureIdentity: async () => ({}) });
  runner.execute = async (_job, step) => ({ state: step.actionIndex === 0 && step.unitIndex === 1 ? 'skipped' : 'succeeded' });
  runner.interruptibleWait = async (_id, ms, reason) => { waits.push([ms, reason]); return true; };
  await runner.loop(job.id);
  const expected = [];
  steps.forEach((step, i) => {
    if (i === steps.length - 1) return;
    if (steps[i + 1].round !== step.round) expected.push([13000, '等待下一轮']);
    else if (!(step.actionIndex === 0 && step.unitIndex === 1)) {
      const ms = snapshot.actionPlan[step.actionIndex].intervalSeconds * 1000;
      if (ms) expected.push([ms, '等待下一项操作']);
    }
  });
  assert.deepEqual(waits.map(([ms, reason]) => [reason === '等待下一轮' ? Math.ceil(ms / 1000) * 1000 : ms, reason]), expected);
  assert.equal(getJob(job.id).status, 'completed');
});

test('账号单组归属、批量移动及删除分组，任务快照保留身份和原分组', () => {
  const account = createAccount('账号甲');
  const group = saveAccountGroup(null, '第一组');
  assert.throws(() => saveAccountGroup(null, '第一组'), /已存在/);
  assert.equal(moveAccountsToGroup([account.id, account.id], group.id).length, 1);
  assert.equal(getAccount(account.id).group_id, group.id);
  const snapshot = createSnapshot({ accountIds: [account.id, account.id] }, listAccounts(), []);
  assert.equal(snapshot.accountIds.length, 1);
  assert.equal(snapshot.accountIdentities[account.id].groupName, '第一组');
  saveAccountGroup(group.id, '改名'); deleteAccountGroup(group.id);
  assert.equal(getAccount(account.id).group_id, null);
  assert.equal(snapshot.accountIdentities[account.id].groupName, '第一组');
  assert.deepEqual(listAccountGroups(), [{ id: '', name: '未分组' }]);
  assert.throws(() => moveAccountsToGroup([account.id], 'missing'), /不存在/);
});

test('每日成功统计不受500条限制，签到同UID去重，待核对复核成功后计入', () => {
  const account = createAccount(), duplicate = createAccount();
  db.prepare('UPDATE accounts SET uid=? WHERE id IN (?,?)').run('12345', account.id, duplicate.id);
  const topic = createTopic({ name: '统计', url: 'https://example.test' });
  const job = createJob({});
  const { recordCheckin, updateActionLog } = dbModule;
  const date = shanghaiDate();
  recordCheckin(account.id, topic.id, date); recordCheckin(duplicate.id, topic.id, date);
  for (let i = 0; i < 505; i++) createActionLog({ jobId: job.id, stepKey: `post-${i}`, kind: 'post', state: 'succeeded', accountId: account.id, topicId: topic.id });
  const actionId = createActionLog({ jobId: job.id, stepKey: 'comment', kind: 'comment', state: 'uncertain', accountId: account.id, topicId: topic.id });
  assert.deepEqual(dailySuccess(), { date, checkin: 1, post: 505, original: 0, comment: 0 });
  updateActionLog(actionId, { state: 'succeeded' });
  assert.equal(dailySuccess().comment, 1);
  const priorDate = shanghaiDate(new Date(Date.now() - 86400000));
  db.prepare('UPDATE action_logs SET completed_at=? WHERE id=?').run(new Date(`${priorDate}T00:01:00+08:00`).toISOString(), actionId);
  assert.equal(dailySuccess(priorDate).comment, 1);
});

test('每轮报告保存墙钟耗时、异常详情、确认状态和系统通知去重', async t => {
  const notifySetting = process.env.WEIBO_CONSOLE_NOTIFY;
  delete process.env.WEIBO_CONSOLE_NOTIFY;
  t.after(() => { if (notifySetting == null) delete process.env.WEIBO_CONSOLE_NOTIFY; else process.env.WEIBO_CONSOLE_NOTIFY = notifySetting; });
  const account = createAccount('历史昵称'); const topic = createTopic({ name: '测试', url: 'https://example.test' });
  const job = createJob(createSnapshot({ accountIds: [account.id], topicIds: [topic.id] }, listAccounts(), listTopics()));
  startRound(job.id, 0, new Date(Date.now() - 10000).toISOString());
  startRound(job.id, 0); // restarting must not reset the timer
  createActionLog({ jobId: job.id, stepKey: `0:${topic.id}:${account.id}:0:0`, kind: 'post', accountId: account.id, topicId: topic.id, state: 'failed', error: '发布被拒绝' });
  const report = finishRound(job.id, 0);
  assert.ok(report.durationMs >= 10000);
  assert.equal(report.counts.post.failed, 1);
  assert.equal(report.abnormalAccounts[0].anomalies[0].reason, '发布被拒绝');
  assert.equal(finishRound(job.id, 0), null);
  assert.equal(pendingRoundReports().length, 1);
  let sends = 0;
  const execute = (_binary, args, _options, callback) => { sends++; assert.ok(args.at(-1).includes('异常账号 1 个')); callback(null); };
  assert.equal(await notifyRound(report, execute), true);
  assert.equal(await notifyRound(report, execute), false);
  assert.equal(sends, 1);
  assert.equal(acknowledgeRound(job.id, 0), true);
  assert.equal(pendingRoundReports().length, 0);
  startRound(job.id, 1); finishRound(job.id, 1, 'stopped');
  assert.equal(listRoundReports(job.id).length, 2);
  assert.equal(pendingRoundReports().length, 0);
});

test('超like按批次找到首个关键词就停止，复核不离开列表', async () => {
  const account = createAccount(); const topic = createTopic({ name: '超like', url: 'https://example.test' });
  addCommentMaterials(['甲', '乙']);
  const job = createJob(createSnapshot({ actionPlan: [{ type: 'comment', count: 1 }], commentSection: '超like', commentStrategy: 'random' }, listAccounts(), listTopics()));
  let laterScanned = false; let sent;
  const runner = new TaskRunner({
    collectCandidates: async (_a, _t, options) => {
      const first = [{ id: 'front', url: 'https://example.test/front', text: '差一点', commentCount: 4 }, { id: 'second', url: 'https://example.test/second', text: '捞', commentCount: 1 }];
      if (!await options.onBatch(first)) laterScanned = true;
      return first;
    },
    inspectCandidate: async (_a, item, options) => { assert.equal(options.inFeed, true); return item; },
    comment: async (_a, item) => { sent = item.id; return { state: 'succeeded', url: item.url }; }
  });
  await runner.executeComment(job, buildSteps(job.config)[0], account, topic);
  assert.equal(sent, 'front'); assert.equal(laterScanned, false);
});

test('列表评论数未知仍进入接口复核，零评与20评限制最终由接口确认', async () => {
  const account = createAccount(); const topic = createTopic({ name: '计数复核', url: 'https://example.test' });
  addCommentMaterials(['甲', '乙']);
  const job = createJob(createSnapshot({ actionPlan: [{ type: 'comment', count: 1 }], commentStrategy: 'zero-only', commentMaxCountEnabled: true }, listAccounts(), listTopics()));
  const sent = [], inspected = [];
  const runner = new TaskRunner({
    collectCandidates: async () => [{ id: 'Runknown', url: 'https://example.test/unknown', commentCount: null }],
    inspectCandidate: async (_account, item) => { inspected.push(item.id); return { ...item, commentCount: 0 }; },
    comment: async (_account, item) => { sent.push(item.id); return { state: 'succeeded', url: item.url }; }
  });
  assert.equal((await runner.executeComment(job, buildSteps(job.config)[0], account, topic)).state, 'succeeded');
  assert.deepEqual(inspected, ['Runknown']); assert.deepEqual(sent, ['Runknown']);
});

test('普通随机首批找到首条合格帖立即停止，不继续扫描30条', async () => {
  const account = createAccount(); const topic = createTopic({ name: '水帖', url: 'https://example.test/water' });
  addCommentMaterials(['甲', '乙']);
  const job = createJob(createSnapshot({ actionPlan: [{ type: 'comment', count: 1 }], commentSection: '水帖', commentStrategy: 'random', commentMaxCountEnabled: true }, listAccounts(), listTopics()));
  const checked = [], sent = []; let completedBatch = false;
  const runner = new TaskRunner({
    collectCandidates: async (_a, _t, options) => {
      const batch = [
        { id:'Rrejected', url:'https://example.test/rejected', authorUid:'111', commentCount: 1 },
        { id:'Rfull', url:'https://example.test/full', authorUid:'222', commentCount: 20 },
        { id:'Rok', url:'https://example.test/ok', authorUid:'333', commentCount: 2 },
        { id:'Rlater', url:'https://example.test/later', authorUid:'444', commentCount: 1 }
      ];
      if (await options.onBatch(batch)) return batch;
      completedBatch = true; return batch;
    },
    inspectCandidate: async (_a, item, options) => { assert.equal(options.inFeed, true); checked.push(item.id); return item; },
    comment: async (_a, item) => { sent.push(item.id); return { state:'succeeded', url:item.url }; }
  });
  dbModule.updateJob(job.id, { cursor: { ...job.cursor, commentRejectedAuthors: [{ round:0, authorUid:'111' }] } });
  const result = await runner.executeComment(getJob(job.id), buildSteps(job.config)[0], account, topic);
  assert.equal(result.state,'succeeded'); assert.deepEqual(checked,['Rok']); assert.deepEqual(sent,['Rok']); assert.equal(completedBatch,false);
  assert.equal(getJob(job.id).cursor.commentScan.scanned,3);
});

test('普通随机详情复核失效时检查下一条，不重新扫描整页', async () => {
  const account=createAccount(),topic=createTopic({name:'水帖',url:'https://example.test/water'});addCommentMaterials(['甲','乙']);
  const job=createJob(createSnapshot({actionPlan:[{type:'comment',count:1}],commentSection:'水帖',commentStrategy:'random',commentMaxCountEnabled:true},listAccounts(),listTopics()));
  const inspected=[],sent=[];
  const runner=new TaskRunner({collectCandidates:async(_a,_t,o)=>o.onBatch([
    {id:'Rstale',url:'https://example.test/stale',authorUid:'1',commentCount:1},{id:'Rok',url:'https://example.test/ok',authorUid:'2',commentCount:3}
  ]),inspectCandidate:async(_a,item)=>{inspected.push(item.id);return item.id==='Rstale'?null:item;},comment:async(_a,item)=>{sent.push(item.id);return{state:'succeeded',url:item.url};}});
  await runner.executeComment(job,buildSteps(job.config)[0],account,topic);
  assert.deepEqual(inspected,['Rstale','Rok']);assert.deepEqual(sent,['Rok']);
});

test('超like等待显示真实过滤原因，不把发帖人避让说成评论数超标', async () => {
  const account = createAccount(); const topic = createTopic({ name: '避让诊断', url: 'https://example.test' });
  addCommentMaterials(['甲', '乙']);
  const job = createJob(createSnapshot({ actionPlan: [{ type: 'comment', count: 1 }], commentSection: '超like', commentMaxCountEnabled: true, candidateRefreshSeconds: 0 }, listAccounts(), listTopics()));
  const step = buildSteps(job.config)[0];
  dbModule.updateJob(job.id, { cursor: { ...job.cursor, commentRejectedAuthors: [{ round: 0, authorUid: '111' }] } });
  const runner = new TaskRunner({
    collectCandidates: async () => [{ id: 'Rblocked', url: 'https://example.test/blocked', text: '捞', authorUid: '111', commentCount: 3 }, { id: 'Rfull', url: 'https://example.test/full', text: '差', authorUid: '222', commentCount: 19 }],
    inspectCandidate: async (_account, item) => ({ ...item, commentCount: 20 }),
    comment: async () => { throw new Error('不可提交'); }
  });
  runner.interruptibleWait = async () => false;
  assert.equal((await runner.executeComment(getJob(job.id), step, account, topic)).waiting, true);
  const saved = getJob(job.id);
  assert.equal(saved.cursor.commentScan.scanned, 2);
  assert.equal(saved.cursor.commentScan.rejectedAuthor, 1);
  assert.equal(saved.cursor.commentScan.countLimit, 1);
  assert.match(saved.wait_reason, /本轮发帖人避让 1 条/);
  assert.match(saved.wait_reason, /已达20评 1 条/);
});

test('超like初扫加两次刷新后单条放宽零评和关键词，强制不足20评并持久恢复', async () => {
  const account = createAccount(); const topic = createTopic({ name: '超like', url: 'https://example.test' });
  addCommentMaterials(['甲', '乙']);
  const job = createJob(createSnapshot({ actionPlan: [{ type: 'comment', count: 2 }], commentSection: '超like', commentStrategy: 'zero-only', candidateRefreshSeconds: 0 }, listAccounts(), listTopics()));
  let scans = 0, sent = [];
  const adapter = {
    collectCandidates: async () => { scans++; return [
      { id: 'twenty', url: 'https://example.test/20', text: '普通帖', commentCount: 20 },
      { id: 'allowed', url: 'https://example.test/4', text: '普通帖', commentCount: 4 }
    ]; },
    inspectCandidate: async (_a, item) => item,
    comment: async (_a, item) => { sent.push(item.id); return { state: 'succeeded', url: item.url }; }
  };
  const step = buildSteps(job.config)[0];
  for (let i = 0; i < 2; i++) assert.equal((await new TaskRunner(adapter).executeComment(getJob(job.id), step, account, topic)).waiting, true);
  const runner = new TaskRunner(adapter);
  assert.equal((await runner.executeComment(getJob(job.id), step, account, topic)).state, 'succeeded');
  assert.equal(scans, 3); assert.deepEqual(sent, ['allowed']);
  await runner.advance(job.id, step, 'succeeded');
  assert.deepEqual(getJob(job.id).cursor.superlikeSteps, {});
  assert.equal((await runner.executeComment(getJob(job.id), buildSteps(job.config)[1], account, topic)).waiting, true);
  assert.equal(sent.length, 1);
});

test('任务窗口最小化，登录和安全验证窗口恢复并前置，窗口控制失败不抛错', async () => {
  const calls = [];
  const session = {
    async send(method, payload) {
      calls.push([method, payload]);
      if (method === 'Browser.getWindowForTarget') return { windowId: 42 };
      if (method === 'Browser.getWindowBounds') return { bounds: { windowState: 'minimized' } };
      return {};
    },
    async detach() { calls.push(['detach']); }
  };
  const page = {
    isClosed: () => false,
    context: () => ({ newCDPSession: async () => session }),
    bringToFront: async () => calls.push(['bringToFront'])
  };
  let launchOptions;
  const context = { pages: () => [page], on: () => {}, close: async () => {} };
  const manager = new BrowserManager(async ({ options }) => {
    launchOptions = options;
    return context;
  }, { activate: async () => calls.push(['activate']) });
  const account = { id: 'window-test', profile_dir: fs.mkdtempSync(path.join(tempDir, 'window-')) };
  await manager.page(account, 'runner');
  assert.ok(launchOptions.args.includes('--start-minimized'));
  assert.ok(calls.some(([method, payload]) => method === 'Browser.setWindowBounds' && payload.bounds.windowState === 'minimized'));
  await manager.foreground(page);
  assert.ok(calls.some(([method, payload]) => method === 'Browser.setWindowBounds' && payload.bounds.windowState === 'normal'));
  assert.ok(calls.some(([method]) => method === 'bringToFront'));
  assert.ok(calls.some(([method]) => method === 'activate'));
  assert.equal(await manager.isMinimized(page), true);
  await manager.close();
  calls.length = 0;
  await manager.page(account, 'login');
  assert.ok(launchOptions.args.includes('--start-maximized'));
  assert.equal(calls.some(([method]) => method === 'bringToFront'), false, '初始空白页不抢焦点');
  await manager.foreground(page);
  assert.ok(calls.some(([method]) => method === 'bringToFront'));
  const unavailable = new BrowserManager(async () => context, { activate: async () => { throw new Error('no native focus'); } });
  await assert.doesNotReject(() => unavailable.foreground({ isClosed: () => false, context: () => ({ newCDPSession: async () => { throw new Error('no CDP'); } }), bringToFront: async () => { throw new Error('no tab focus'); } }));
});

test('登录页加载完成后置前，登录期间仅在窗口最小化时恢复', async () => {
  const navigations = [];
  let foregroundCalls = 0;
  const page = {
    goto: async url => { navigations.push(url); },
    waitForFunction: async () => {},
    url: () => 'https://weibo.com/'
  };
  const adapter = new WeiboAdapter({
    page: async () => page,
    foreground: async () => { foregroundCalls++; }
  });
  adapter.readIdentity = async () => ({ status: 'invalid' });
  await adapter.openLogin({});
  assert.match(navigations.at(-1), /passport\.weibo\.com/);
  assert.equal(foregroundCalls, 1);

  const account = createAccount();
  let minimized = true;
  let closed = 0;
  const manager = {
    accountId: account.id, owner: 'login',
    foreground: async () => { foregroundCalls++; },
    isMinimized: async () => minimized,
    close: async () => { closed++; manager.owner = null; }
  };
  const service = new LoginService({
    openLogin: async () => ({ page: { isClosed: () => false } }),
    ensureQrVisible: async () => false,
    readIdentity: async () => ({ status: 'invalid' }),
    loginChallenge: async () => false
  }, manager, { intervalMs: 5 });
  service.start(account);
  await waitFor(() => foregroundCalls >= 3);
  minimized = false;
  const stableCalls = foregroundCalls;
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(foregroundCalls, stableCalls);
  await service.cancel();
  assert.equal(closed, 1);
});

test('删除账号只清理该记录目录并保留历史关联，允许相同 UID 重新登录', () => {
  const a = createAccount();
  updateAccountAuth(a.id, { status: 'valid', uid: '123', nickname: '原账号' });
  const b = createAccount();
  db.prepare('UPDATE accounts SET uid=? WHERE id=?').run('123', b.id);
  fs.writeFileSync(path.join(a.profile_dir, 'session'), 'a');
  fs.writeFileSync(path.join(b.profile_dir, 'session'), 'b');
  const job = createJob({ accountIds: [a.id] });
  createActionLog({ jobId: job.id, stepKey: 's', kind: 'post', accountId: a.id, topicId: null, content: 'x' });
  dbModule.deleteAccount(a.id);
  assert.equal(fs.existsSync(a.profile_dir), false);
  assert.equal(fs.existsSync(path.join(b.profile_dir, 'session')), true);
  assert.equal(listAccounts().some(item => item.id === a.id), false);
  assert.equal(getAccount(a.id).nickname, '原账号');
  assert.equal(listActionLogs(job.id)[0].account_id, a.id);
});

test('资料目录异常时账号保留为待重试状态', () => {
  const account = createAccount();
  fs.rmSync(account.profile_dir, {recursive:true});
  fs.symlinkSync(tempDir, account.profile_dir);
  assert.throws(() => dbModule.deleteAccount(account.id), /符号链接/);
  assert.equal(getAccount(account.id).cleanup_state, 'pending');
  assert.ok(listAccounts().some(item => item.id === account.id));
});

test('按轮次、超话、账号、操作段生成固定顺序', () => {
  const steps = buildSteps({
    rounds: 2,
    topicIds: ['t1', 't2'],
    accountIds: ['a1', 'a2'],
    actionPlan: [{ type: 'checkin', count: 1 }, { type: 'comment', count: 2 }, { type: 'post', count: 3 }]
  });
  assert.equal(steps.length, 48);
  assert.deepEqual(steps.slice(0, 6).map(step => [step.round, step.topicId, step.accountId, step.kind]), [
    [0, 't1', 'a1', 'checkin'], [0, 't1', 'a1', 'comment'], [0, 't1', 'a1', 'comment'],
    [0, 't1', 'a1', 'post'], [0, 't1', 'a1', 'post'], [0, 't1', 'a1', 'post']
  ]);
  assert.equal(steps[6].accountId, 'a2');
  assert.equal(steps[12].topicId, 't2');
});

test('共享评论原文相邻不重复并跨读取持久', () => {
  addCommentMaterials(['第一条', '第二条', '第三条']);
  const selections = Array.from({ length: 30 }, () => pickCommentMaterial().id);
  for (let index = 1; index < selections.length; index += 1) assert.notEqual(selections[index], selections[index - 1]);
});

test('任务校验要求发帖和评论至少两条不同文案', () => {
  const legacyErrors = validateSnapshot({
    accountIds: ['a1'], topicIds: ['t1'], actionPlan: [{ type: 'post', count: 1 }, { type: 'comment', count: 1 }],
    materials: { posts: { a1: [] }, comments: [{ id: 'c1', text: 'one' }] }
  });
  assert.ok(legacyErrors.some(item => item.includes('评论任务需要至少两条')));
  assert.ok(legacyErrors.some(item => item.includes('至少需要两条发帖文案')));
  const onePost = validateSnapshot({ accountIds: ['a1'], topicIds: ['t1'], actionPlan: [{ type: 'post', count: 1 }], materials: { posts: [{ id: 'p1', text: 'only' }], comments: [] } });
  assert.ok(onePost.some(item => item.includes('至少两条共享发帖文案')));
  const twoPosts = validateSnapshot({ accountIds: ['a1'], topicIds: ['t1'], actionPlan: [{ type: 'post', count: 1 }], materials: { posts: [{ id: 'p1', text: 'one' }, { id: 'p2', text: 'two' }], comments: [] } });
  assert.deepEqual(twoPosts, []);
});

test('创建任务快照按文案组过滤，空组选择表示全部', () => {
  clearAllDataForTests();
  const account = createAccount('分组测试');
  const topic = createTopic({ name: '分组超话', url: 'https://example.test/group-topic' });
  const groupA = createMaterialGroup('组A', 'post');
  const groupB = createMaterialGroup('组B', 'post');
  addPostMaterials(['甲组发帖', '甲组发帖二'], undefined, groupA.id);
  addPostMaterials(['乙组发帖'], undefined, groupB.id);
  addPostMaterials(['未分组发帖']);
  const groupC = createMaterialGroup('组C', 'post');
  addPostMaterials(['单条发帖'], undefined, groupC.id);
  const groupAComment = createMaterialGroup('组A', 'comment');
  addCommentMaterials(['甲组评论', '甲组评论二'], groupAComment.id);
  addCommentMaterials(['未分组评论']);
  const base = { rounds: 1, accountIds: [account.id], topicIds: [topic.id], actionPlan: [{ type: 'post', count: 1 }, { type: 'comment', count: 1 }] };
  const filtered = createSnapshot({ ...base, postGroupIds: [groupA.id], commentGroupIds: [groupAComment.id] }, listAccounts(), listTopics());
  assert.deepEqual(new Set(filtered.materials.posts.map(item => item.text)), new Set(['甲组发帖', '甲组发帖二']));
  assert.deepEqual(new Set(filtered.materials.comments.map(item => item.text)), new Set(['甲组评论', '甲组评论二']));
  assert.deepEqual(validateSnapshot(filtered), []);
  const onePost = createSnapshot({ ...base, postGroupIds: [groupC.id], commentGroupIds: [groupAComment.id] }, listAccounts(), listTopics());
  assert.ok(validateSnapshot(onePost).some(item => item.includes('至少两条共享发帖文案')));
  const all = createSnapshot({ ...base, postGroupIds: [], commentGroupIds: [] }, listAccounts(), listTopics());
  assert.deepEqual(new Set(all.materials.posts.map(item => item.text)), new Set(['甲组发帖', '甲组发帖二', '乙组发帖', '未分组发帖', '单条发帖']));
  assert.deepEqual(new Set(all.materials.comments.map(item => item.text)), new Set(['甲组评论', '甲组评论二', '未分组评论']));
});

test('手机访问只公布物理网络接口，排除 VPN 地址', () => {
  const access = buildLanAccess({
    en0: [{ family: 'IPv4', internal: false, address: '192.168.2.244' }],
    utun4: [{ family: 'IPv4', internal: false, address: '172.19.0.1' }],
    bridge0: [{ family: 'IPv4', internal: false, address: '10.0.0.2' }],
    lo0: [{ family: 'IPv4', internal: true, address: '127.0.0.1' }]
  }, 'xiaxizhoudeMacBook-Pro.local', 4178);
  assert.equal(access.interface, 'en0');
  assert.equal(access.ip, '192.168.2.244');
  assert.equal(access.qrUrl, 'http://192.168.2.244:4178');
  assert.deepEqual(access.urls, ['http://192.168.2.244:4178', 'http://xiaxizhoudeMacBook-Pro.local:4178']);
  assert.deepEqual(access.urls.filter(url => url.includes('172.19.0.1')), []);
});

test('仅零评论策略直接评论检测到的零评论帖并记录去重', async () => {
  const account = createAccount('测试账号');
  updateAccountAuth(account.id, { status: 'valid', uid: '1001', nickname: '测试用户' });
  const topic = createTopic({ name: '测试超话', url: 'https://example.test/topic' });
  addCommentMaterials(['评论甲', '评论乙']);
  addPostMaterials(account.id, ['发帖文案']);
  const calls = [];
  const adapter = {
    ensureIdentity: async () => ({ uid: '1001' }),
    collectCandidates: async () => [{ id: 'p0', url: 'https://example.test/p0', commentCount: 0, authorUid: '2002' }],
    comment: async (_account, candidate, content) => { calls.push({ candidate, content }); return { state: 'succeeded', url: candidate.url }; }
  };
  const runner = new TaskRunner(adapter);
  const snapshot = createSnapshot({
    rounds: 1, accountIds: [account.id], topicIds: [topic.id], actionPlan: [{ type: 'comment', count: 1 }],
    commentStrategy: 'zero-only', checkinIntervalSeconds: 0, postIntervalSeconds: 0, commentIntervalSeconds: 0, roundIntervalSeconds: 0, candidateRefreshSeconds: 5
  }, [updateAccountAuth(account.id, { status: 'valid', uid: '1001', nickname: '测试用户' })], [{ ...topic, enabled: true }]);
  const created = runner.start(snapshot, [updateAccountAuth(account.id, { status: 'valid', uid: '1001', nickname: '测试用户' })], [{ ...topic, enabled: true }]);
  await waitFor(() => getJob(created.job.id)?.status === 'completed');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].candidate.id, 'p0');
  assert.equal(hasCommented(account.id, 'p0'), true);
});

test('仅零评论按扫描顺序选择首条零评论帖，不随机跳到后面的候选', async () => {
  const account = createAccount('测试账号');
  updateAccountAuth(account.id, { status: 'valid', uid: '1001', nickname: '测试用户' });
  const topic = createTopic({ name: '测试超话', url: 'https://example.test/topic' });
  addCommentMaterials(['评论甲', '评论乙']);
  const calls = [];
  const runner = new TaskRunner({
    ensureIdentity: async () => ({ uid: '1001' }),
    collectCandidates: async () => [
      { id: 'Runknown', url: 'https://example.test/2000/Runknown', commentCount: null, authorUid: '2000' },
      { id: 'Rfirst', url: 'https://example.test/2001/Rfirst', commentCount: 8, authorUid: '2001' },
      { id: 'RzeroOne', url: 'https://example.test/2002/RzeroOne', commentCount: 0, authorUid: '2002' },
      { id: 'RzeroTwo', url: 'https://example.test/2003/RzeroTwo', commentCount: 0, authorUid: '2003' }
    ],
    inspectCandidate: async (_account, candidate) => candidate,
    comment: async (_account, candidate) => { calls.push(candidate.id); return { state: 'succeeded', url: candidate.url }; }
  });
  const snapshot = createSnapshot({ rounds: 1, accountIds: [account.id], topicIds: [topic.id], actionPlan: [{ type: 'comment', count: 1 }], commentStrategy: 'zero-only', checkinIntervalSeconds: 0, postIntervalSeconds: 0, commentIntervalSeconds: 0, roundIntervalSeconds: 0 }, listAccounts(), listTopics());
  const started = runner.start(snapshot, listAccounts(), listTopics());
  await waitFor(() => getJob(started.job.id)?.status === 'completed');
  assert.deepEqual(calls, ['RzeroOne']);
});

test('同一微博 UID 重新添加账号后仍按短编号和数字编号阻止重复评论', () => {
  const original = createAccount('旧账号');
  updateAccountAuth(original.id, { status: 'valid', uid: '1001', nickname: '旧用户' });
  const shortId = 'RoF9ww8Pq';
  recordComment(original.id, shortId, 'https://weibo.com/2001/RoF9ww8Pq');
  dbModule.deleteAccount(original.id);
  const replacement = createAccount('新账号');
  updateAccountAuth(replacement.id, { status: 'valid', uid: '1001', nickname: '新用户' });
  const ids = dbModule.listCommentedTargetIdsForIdentity(getAccount(replacement.id));
  assert.ok(ids.includes(shortId));
  assert.equal(weiboShortIdToNumeric(ids[0]), weiboShortIdToNumeric(shortId));
});

test('意外中断的提交转为待核对并推进后继续', async () => {
  const snapshot = { rounds: 1, accountIds: ['a1'], topicIds: ['t1'], actionPlan: [{ type: 'post', count: 1 }], materials: { posts: { a1: [{ id: 'p', text: 'x' }] }, comments: [] } };
  const job = createJob(snapshot);
  createActionLog({ jobId: job.id, stepKey: '0:t1:a1:0:0', kind: 'post', accountId: null, topicId: null, content: 'x' });
  const runner = new TaskRunner({});
  const recovered = await runner.recover();
  assert.equal(recovered.status, 'running');
  assert.equal(recovered.cursor.stepIndex, 1);
  assert.equal(recovered.metrics.uncertain, 1);
  assert.equal(listActionLogs(job.id)[0].state, 'uncertain');
  await waitFor(() => getJob(job.id)?.status === 'completed');
});

test('待核对保留记录并继续下一步，评论目标持续去重', async () => {
  const account = createAccount();
  updateAccountAuth(account.id, { status: 'valid', uid: '1001', nickname: '测试用户' });
  const topic = createTopic({ name: '测试超话', url: 'https://example.test/topic' });
  addPostMaterials(['发帖甲', '发帖乙']);
  let calls = 0;
  const runner = new TaskRunner({
    ensureIdentity: async () => ({ uid: '1001' }),
    post: async () => (++calls === 1 ? { state: 'uncertain', reason: '回读失败' } : { state: 'succeeded', url: 'https://example.test/ok' })
  });
  const started = runner.start({ rounds: 1, accountIds: [account.id], topicIds: [topic.id], actionPlan: [{ type: 'post', count: 2 }], checkinIntervalSeconds: 0, postIntervalSeconds: 0, commentIntervalSeconds: 0 }, listAccounts(), listTopics());
  await waitFor(() => getJob(started.job.id)?.status === 'completed');
  const done = getJob(started.job.id);
  assert.equal(calls, 2);
  assert.equal(done.metrics.uncertain, 1);
  assert.equal(done.metrics.success, 1);
  const pending = createActionLog({ jobId: started.job.id, stepKey: 'pending-comment', kind: 'comment', accountId: account.id, topicId: topic.id, targetId: 'target-1', state: 'uncertain' });
  assert.ok(pending);
  assert.equal(hasCommented(account.id, 'target-1'), true);
});

test('登录失效与UID不符跳过该账号剩余操作，其他账号继续', async () => {
  const bad = createAccount();
  const good = createAccount();
  updateAccountAuth(bad.id, { status: 'valid', uid: '1001', nickname: '错号' });
  updateAccountAuth(good.id, { status: 'valid', uid: '2002', nickname: '正常号' });
  const topic = createTopic({ name: '测试超话', url: 'https://example.test/topic' });
  addPostMaterials(['文案', '文案二']);
  let goodPosts = 0;
  const runner = new TaskRunner({
    ensureIdentity: async account => { if (account.id === bad.id) throw new IdentityMismatchError('UID 不一致'); return { uid: account.uid }; },
    post: async () => { goodPosts += 1; return { state: 'succeeded' }; }
  });
  const started = runner.start({ rounds: 1, accountIds: [bad.id, good.id], topicIds: [topic.id], actionPlan: [{ type: 'post', count: 2 }], checkinIntervalSeconds: 0, postIntervalSeconds: 0, commentIntervalSeconds: 0 }, listAccounts(), listTopics());
  await waitFor(() => getJob(started.job.id)?.status === 'completed');
  assert.equal(goodPosts, 2);
  assert.equal(getJob(started.job.id).metrics.failed, 1);
  assert.equal(getJob(started.job.id).metrics.skipped, 1);
});

test('提交后出现验证码时暂停，验证恢复后使用同一动作重试', async () => {
  const account = createAccount();
  updateAccountAuth(account.id, { status: 'valid', uid: '1001', nickname: '测试用户' });
  const topic = createTopic({ name: '测试超话', url: 'https://example.test/topic' });
  addPostMaterials(['文案', '文案二']);
  let posts = 0;
  const runner = new TaskRunner({
    ensureIdentity: async () => ({ uid: '1001' }),
    post: async (_account, _topic, _content, { onSubmit }) => {
      posts += 1;
      onSubmit();
      if (posts === 1) throw new VerificationError('需要人工验证');
      return { state: 'succeeded', url: 'https://example.test/retried' };
    }
  });
  const started = startLegacy(runner, { rounds: 1, accountIds: [account.id], topicIds: [topic.id], actionPlan: [{ type: 'post', count: 1 }], checkinIntervalSeconds: 0, postIntervalSeconds: 0, commentIntervalSeconds: 0 }, listAccounts(), listTopics());
  await waitFor(() => getJob(started.job.id)?.status === 'paused');
  const paused = getJob(started.job.id);
  assert.equal(paused.cursor.stepIndex, 0);
  assert.equal(listActionLogs(started.job.id)[0].state, 'uncertain');
  runner.resume(started.job.id);
  await waitFor(() => getJob(started.job.id)?.status === 'completed');
  assert.equal(posts, 2);
});

test('人工验证解除后自动重试签到，只有已签到终态才完成', async () => {
  const account = createAccount();
  updateAccountAuth(account.id, { status: 'valid', uid: '1001', nickname: '测试用户' });
  const topic = createTopic({ name: '测试超话', url: 'https://example.test/topic' });
  let attempts = 0;
  const runner = new TaskRunner({
    ensureIdentity: async () => ({ uid: '1001' }),
    isVerificationResolved: async () => true,
    checkin: async () => {
      attempts += 1;
      if (attempts === 1) throw new VerificationError('需要人工验证');
      return { state: 'succeeded', url: 'https://example.test/topic', alreadyDone: true, reason: '今日已签到' };
    }
  });
  const started = startLegacy(runner, { rounds: 1, accountIds: [account.id], topicIds: [topic.id], actionPlan: [{ type: 'checkin', count: 1 }], checkinIntervalSeconds: 0, postIntervalSeconds: 0, commentIntervalSeconds: 0 }, listAccounts(), listTopics());
  await waitFor(() => getJob(started.job.id)?.status === 'paused');
  await waitFor(() => getJob(started.job.id)?.status === 'completed', 5000);
  assert.equal(attempts, 2);
  assert.equal(dbModule.getCheckin(account.id, topic.id, shanghaiDate()).status, 'succeeded');
});

test('所有账号共享发帖库且快照不受后续编辑影响', () => {
  createAccount(); createAccount();
  createTopic({ name: '超话', url: 'https://example.test/topic' });
  addPostMaterials(['公共甲', '公共乙', '公共甲']);
  const snapshot = createSnapshot({ actionPlan: [{ type: 'post', count: 1 }] }, listAccounts(), listTopics());
  assert.equal(snapshot.accountIds.length, 2);
  assert.equal(snapshot.materials.posts.length, 2);
  assert.deepEqual(validateSnapshot(snapshot), []);
  addPostMaterials(['后来添加']);
  assert.equal(snapshot.materials.posts.length, 2);
  assert.equal(listPostMaterials().length, 3);
});

test('原创完全脱离超话调度，按账号和次数展开并允许不选超话', () => {
  const account = createAccount();
  addOriginalMaterials(['原创甲', '原创乙']);
  const snapshot = createSnapshot({ rounds: 1, accountIds: [account.id], topicIds: [],
    actionPlan: [{ type: 'original', count: 3 }] }, listAccounts(), listTopics());
  assert.deepEqual(snapshot.topicIds, []);
  assert.equal(snapshot.materials.originals.length, 2);
  assert.deepEqual(validateSnapshot(snapshot), []);
  const steps = buildSteps(snapshot);
  assert.equal(steps.length, 3);
  assert.ok(steps.every(step => step.kind === 'original' && step.topicId === ''));
  assert.deepEqual(new Set(steps.map(step => step.accountId)), new Set([account.id]));

  const multiTopic = buildSteps({ rounds: 1, accountIds: [account.id], topicIds: ['t1', 't2'],
    actionPlan: [{ type: 'original', count: 2 }], segmentIds: ['seg_o'] });
  assert.equal(multiTopic.length, 2, '多超话不能重复执行原创');
});

test('原创文案与发帖文案及分组完全隔离', () => {
  const postGroup = createMaterialGroup('发帖组', 'post');
  const originalGroup = createMaterialGroup('原创组', 'original');
  addPostMaterials(['发帖原文'], undefined, postGroup.id);
  addOriginalMaterials(['原创原文甲', '原创原文乙'], originalGroup.id);
  assert.equal(listPostMaterials().length, 1);
  assert.equal(listOriginalMaterials().length, 2);
  const snapshot = createSnapshot({ accountIds: [], topicIds: [], originalGroupIds: [originalGroup.id],
    actionPlan: [{ type: 'original', count: 1 }] }, listAccounts(), listTopics());
  assert.deepEqual(new Set(snapshot.materials.originals.map(item => item.text)), new Set(['原创原文甲', '原创原文乙']));
  assert.deepEqual(snapshot.materials.posts.map(item => item.text), ['发帖原文']);
});

test('重复导入原文不能绕过相邻不重复，旧库重复 ID 也不能绕过', () => {
  addCommentMaterials(['甲', '乙', '甲']);
  const fake = { config: { materials: { comments: [{ id: 'a', text: '甲' }, { id: 'b', text: '甲' }, { id: 'c', text: '乙' }] } } };
  const runner = new TaskRunner({});
  let last;
  for (let i = 0; i < 30; i++) {
    const selected = runner.pickSnapshotComment(fake);
    assert.notEqual(selected.text, last);
    last = selected.text;
  }
  assert.ok(validateSnapshot({ accountIds: ['a'], topicIds: ['t'], actionPlan: [{ type: 'comment', count: 1 }], materials: { comments: [{ id: 'a', text: '甲' }, { id: 'b', text: '甲' }] } }).length);
});

test('发帖、评论装饰独立，默认24表情，旧配置与自定义表情保留', () => {
  assert.equal(new Set(DEFAULT_EMOJIS).size, 24);
  const upgraded = normalizeTaskSettings({ decoration: { mode: 'number', emojis: ['🙂', '👏', '✨', '🌟'] } });
  assert.equal(upgraded.commentDecoration.mode, 'number');
  assert.equal(upgraded.commentDecoration.emojis.length, 24);
  assert.equal(upgraded.postDecoration.mode, 'none');
  assert.deepEqual(normalizeTaskSettings({ decoration: { emojis: ['🌈'] } }).commentDecoration.emojis, ['🌈']);
  assert.equal(decorateText('原文', { mode: 'emoji-and-number', emojis: ['✨'], emojiPosition: 'prefix', numberPosition: 'suffix' }, 'post'), '✨原文1');
  assert.equal(decorateText('评论', { mode: 'number', numberPosition: 'prefix' }, 'comment'), '1评论');
  assert.equal(nextSequence('post'), 2);
  const result = execFileSync(process.execPath, ['--input-type=module', '-e', 'const {nextSequence}=await import("./src/db.js");console.log(nextSequence("post"))'], { cwd: path.resolve(import.meta.dirname, '..'), env: { ...process.env, WEIBO_CONSOLE_DATA_DIR: tempDir }, encoding: 'utf8' });
  assert.equal(result.trim(), '3');
});

test('提交前失败再次执行保留最终文案和序号，不重复抽取', async () => {
  const account = createAccount();
  const topic = createTopic({ name: '超话', url: 'https://example.test/topic' });
  addPostMaterials(['原文']);
  const snapshot = createSnapshot({ actionPlan: [{ type: 'post', count: 1 }], postDecoration: { mode: 'number', numberPosition: 'suffix' } }, listAccounts(), listTopics());
  const job = createJob(snapshot);
  const step = buildSteps(snapshot)[0];
  const sent = [];
  const runner = new TaskRunner({ post: async (_a, _t, text, options) => {
    sent.push(text);
    if (sent.length === 1) throw new UnsupportedPageError('等待页面恢复');
    options.onSubmit();
    return { state: 'succeeded' };
  } });
  await assert.rejects(runner.execute(job, step, account, topic), /等待页面恢复/);
  await runner.execute(job, step, account, topic);
  assert.deepEqual(sent, ['原文1', '原文1']);
  assert.equal(getJob(job.id).cursor.sequences.post.next, 2);
  assert.equal(listActionLogs(job.id).length, 1);
});

test('无名称账号自动使用昵称，掉线不清空身份，错误UID不能覆盖', () => {
  const account = createAccount();
  assert.equal(account.name, '等待扫码');
  updateAccountAuth(account.id, { status: 'valid', nickname: '微博昵称', uid: '123456' });
  updateAccountAuth(account.id, { status: 'invalid', nickname: '', uid: '' });
  assert.equal(getAccount(account.id).name, '微博昵称');
  assert.equal(getAccount(account.id).uid, '123456');
  assert.throws(() => updateAccountAuth(account.id, { status: 'valid', nickname: '其他用户', uid: '987654' }), /UID 不一致/);
  assert.equal(getAccount(account.id).nickname, '微博昵称');
  const legacy = createAccount();
  db.prepare('UPDATE accounts SET uid=? WHERE id=?').run('123456', legacy.id);
  assert.doesNotThrow(() => updateAccountAuth(account.id, { status: 'valid', nickname: '已更新昵称', uid: '123456' }));
  const fresh = createAccount();
  assert.throws(() => updateAccountAuth(fresh.id, { status: 'valid', nickname: '重复账号', uid: '123456' }), /已存在/);
});

test('自动扫码检测完成后保存身份并释放锁，重复登录请求只开一次', async () => {
  const account = createAccount();
  let opened = 0; let checked = 0; let closed = 0;
  const page = { isClosed: () => false };
  const manager = { accountId: account.id, owner: 'login', close: async () => { closed++; manager.owner = null; } };
  const adapter = {
    openLogin: async () => { opened++; return { page }; }, ensureQrVisible: async () => true,
    loginChallenge: async () => false,
    readIdentity: async () => (++checked === 1 ? { status: 'invalid' } : { status: 'valid', uid: '1234', nickname: '自动识别' })
  };
  const service = new LoginService(adapter, manager, { intervalMs: 5 });
  service.start(account); service.start(account);
  assert.throws(() => service.start(createAccount()), /先完成/);
  await waitFor(() => !service.active);
  assert.equal(opened, 1); assert.equal(closed, 1);
  assert.equal(getAccount(account.id).name, '自动识别');
  assert.equal(service.status().phase, 'success');
});

test('取消扫码终止检测且不覆盖已有身份；网络错误会重试', async () => {
  const account = createAccount();
  updateAccountAuth(account.id, { status: 'valid', uid: '1234', nickname: '原昵称' });
  let checked = 0;
  const manager = { accountId: account.id, owner: 'login', close: async () => {} };
  const adapter = { openLogin: async () => ({ page: { isClosed: () => false } }), ensureQrVisible: async () => true,
    loginChallenge: async () => false, readIdentity: async () => { checked++; if (checked === 1) throw new Error('断网'); return { status: 'invalid' }; } };
  const service = new LoginService(adapter, manager, { intervalMs: 5 });
  service.start(account);
  await waitFor(() => checked > 1);
  await service.cancel();
  const afterCancel = checked;
  await new Promise(resolve => setTimeout(resolve, 30));
  assert.equal(checked, afterCancel);
  assert.equal(service.status().phase, 'cancelled');
  assert.equal(getAccount(account.id).uid, '1234');
});

test('身份检测读取微博当前登录身份，不导航二维码页面', async () => {
  let requests = 0;
  const page = { url: () => 'https://weibo.com/', evaluate: async () => { requests++; return { uid: '1234', nickname: '昵称' }; } };
  const adapter = new WeiboAdapter({});
  const result = await adapter.readIdentity(page);
  assert.equal(result.uid, '1234'); assert.equal(requests, 1);
  page.url = () => 'https://passport.weibo.com/sso/signin';
  assert.equal((await adapter.readIdentity(page)).status, 'invalid');
  assert.equal(requests, 1);
});

test('微博评论核验工具能转换短编号并规范化 HTML、空白和表情', () => {
  assert.equal(weiboShortIdToNumeric('RoEqepe6X'), '5358752586012447');
  assert.equal(normalizeWeiboText('<span>早安&nbsp;🌟</span>\n朋友'), '早安🌟朋友');
  assert.equal(isRateLimitMessage('操作过于频繁，请稍后再试'), true);
  assert.equal(isRateLimitMessage('帖子正文只是提醒大家注意操作频率'), false);
});

test('发帖复核以发布回执、作者和正文超话标识为准，不依赖详情中的 page id', () => {
  const post = {
    idstr: '5358752586012447',
    user: { idstr: '1001' },
    text_raw: '苏新皓[超话] 早安\n朋友 🌟'
  };
  assert.equal(postReadbackMatches(post, {
    receiptId: '5358752586012447', uid: '1001', content: '早安朋友 🌟', topicName: '苏新皓超话'
  }), true);
  assert.equal(postReadbackMatches(post, {
    receiptId: '5358752586012447', uid: '1001', content: '早安朋友 🌟', topicName: '别的超话'
  }), false);
  assert.equal(postReadbackMatches(post, {
    receiptId: 'wrong-id', uid: '1001', content: '早安朋友 🌟', topicName: '苏新皓超话'
  }), false);
  assert.equal(postReadbackMatches({ ...post, text_raw: '早安朋友 🌟', topic_struct: [{ title: '苏新皓超话' }] }, {
    receiptId: '5358752586012447', uid: '1001', content: '早安朋友 🌟', topicName: '苏新皓超话'
  }), true);
});

test('原创回执只核对作者与正文，不要求超话标识', () => {
  const post = { idstr: '5359362629436098', user: { idstr: '1001' }, text_raw: '原创正文' };
  assert.equal(postReadbackMatches(post, { receiptId: '5359362629436098', uid: '1001', content: '原创正文', requireTopic: false }), true);
  assert.equal(postReadbackMatches(post, { receiptId: '5359362629436098', uid: '1001', content: '原创正文', requireTopic: true }), false);
});

test('发帖短链仅按该微博明确映射还原，正文作者ID超话仍严格核验', () => {
  const long = 'https://video.weibo.com/show?fid=1034:5298236634890298&from=post#video';
  const short = 'http://t.cn/AXixvY0l';
  const values = { receiptId:'12345678901',uid:'1001',content:`原文 ${long}`,topicName:'苏新皓' };
  const post = { idstr:values.receiptId,user:{idstr:values.uid},text_raw:`苏新皓[超话] 原文 ${short}`,url_struct:[{short_url:short,long_url:long}] };
  assert.equal(postReadbackMatches(post,values),true);
  assert.equal(postReadbackMatches({...post,text_raw:null,text:`苏新皓[超话] 原文 <a href="${short}">微博视频</a>`},values),true);
  for (const changed of [
    {...post,url_struct:[]}, {...post,url_struct:[{short_url:short,long_url:long+'&other=1'}]},
    {...post,url_struct:[...post.url_struct,{short_url:short,long_url:'https://other.test/video'}]},
    {...post,text_raw:`苏新皓[超话] 原文 ${short}suffix`}, {...post,text_raw:`苏新皓[超话] 别的文案 ${short}`},
    {...post,user:{idstr:'2002'}}, {...post,idstr:'other'}, {...post,idstr:undefined}, {...post,text_raw:`其他超话 原文 ${short}`}
  ]) assert.equal(postReadbackMatches(changed,values),false);
  assert.equal(postReadbackMatches({...post,url_struct:[...post.url_struct,...post.url_struct]},values),true);
  const twice={...values,content:`原文 ${long} 和 ${long}`};
  assert.equal(postReadbackMatches({...post,text_raw:`苏新皓[超话] 原文 ${short} 和 ${short}`},twice),true);
});

test('后台发帖详情默认仅查一次，不轮询、不等待或前置窗口', async () => {
  const {verifyPublishedPost}=await import('../src/weibo-adapter.js');
  let reads=0;
  const context={request:{get:async (_url,options)=>{reads++;assert.equal(options.timeout,2000);return {ok:()=>true,json:async()=>({ok:0})};}}};
  const page={context:()=>context,isClosed:()=>false,waitForTimeout:()=>{throw Error('不应等待');}};
  const result=await verifyPublishedPost(page,{context},{receiptId:'123',uid:'1',content:'测试',topicName:'苏新皓'},{background:true});
  assert.equal(reads,1);assert.equal(result.state,'uncertain');
});

test('实测20067英文验证回执、验证字段及普通HTTP失败正确分流', () => {
  const actual = { ok: 0, message: 'For your safety, please verify your account', error_code: 20067, validate: { exception_key: '[redacted]', challenge: '[redacted]', alitest: {} } };
  assert.equal(classifyPostReceipt(actual, false).kind, 'verification');
  assert.equal(classifyPostReceipt(actual, false).explicitlyUnpublished, true);
  assert.equal(classifyPostReceipt({ ok: 0, validate: { challenge: '[fixture]' } }, false).kind, 'verification');
  assert.equal(classifyPostReceipt(null, false).kind, 'unknown');
  assert.equal(classifyPostReceipt({ ok: 0 }, false).kind, 'unknown');
  assert.equal(classifyPostReceipt({ ok: 0, message: '正文不符合发布要求' }, false).kind, 'failed');
  assert.equal(classifyPostReceipt({ ok: 1, data: { idstr: '5359413485371450' } }).kind, 'succeeded');
});

test('发帖回执 ID 与详情 URL 独立保存，后续主页 URL 不覆盖它们', () => {
  const account = createAccount('回执账号');
  const topic = createTopic({ name: '苏新皓超话', url: 'https://example.test/topic' });
  const job = createJob(createSnapshot({ accountIds: [account.id], topicIds: [topic.id], actionPlan: [{ type: 'post', count: 1 }], rounds: 1 }, listAccounts(), listTopics()));
  const actionId = createActionLog({ jobId: job.id, stepKey: 'receipt-post', kind: 'post', accountId: account.id, topicId: topic.id, state: 'submitted' });
  updateActionLog(actionId, { receiptId: '123456', receiptUrl: 'https://weibo.com/detail/123456', url: 'https://weibo.com/detail/123456' });
  const stored = updateActionLog(actionId, { state: 'succeeded', url: 'https://weibo.com/' });
  assert.equal(stored.receipt_id, '123456');
  assert.equal(stored.receipt_url, 'https://weibo.com/detail/123456');
});

test('评论昵称核验忽略显示空白，正文规范化后完整匹配且不接受部分文案', () => {
  const expected = '🌟你好朋友';
  const row = { user: { screen_name: '夏曦宙 Gin' }, text: '<span>🌟 你好&nbsp;朋友</span>' };
  assert.equal(normalizeWeiboNickname('夏曦宙\tGin'), '夏曦宙Gin');
  assert.equal(commentRowMatches(row, { nickname: '夏曦宙Gin', content: expected }), true);
  assert.equal(visibleCommentMatches('<span>夏曦宙 Gin</span><p>🌟你好朋友</p>', { nickname: '夏曦宙Gin', content: expected }), true);
  assert.equal(visibleCommentMatches('<span>夏曦宙 Gin</span><p>🌟你好朋友的一部分</p>', { nickname: '夏曦宙Gin', content: expected }), false);
  assert.equal(commentRowMatches({ ...row, text: '🌟你好' }, { nickname: '夏曦宙Gin', content: expected }), false);
  assert.equal(commentRowMatches({ ...row, user: { screen_name: '别的昵称' } }, { nickname: '夏曦宙Gin', content: expected }), false);
  assert.equal(commentRowMatches({ user: { id: '99' }, id: 'c1', text: expected }, { nickname: '夏曦宙Gin', content: expected }), false);
  assert.equal(commentRowMatches({ user: { id: '99' }, id: 'c1', text: expected }, { nickname: '夏曦宙Gin', content: expected, uid: '99', commentId: 'c1' }), true);
});

test('待核对评论只读复核后回写成功、去重记录和任务计数且重复调用不重复计数', async () => {
  const account = createAccount('原微博昵称');
  updateAccountAuth(account.id, { status: 'valid', uid: '7186259742', nickname: '夏曦宙 Gin' });
  const topic = createTopic({ name: '苏新皓', url: 'https://weibo.com/p/100808topic' });
  const job = createJob({ accountIds: [account.id], topicIds: [topic.id] });
  const actionId = createActionLog({ jobId: job.id, stepKey: 'comment-once', kind: 'comment', accountId: account.id, topicId: topic.id, targetId: 'RoF9ww8Pq', content: '本次最终文案🌟', state: 'uncertain', url: 'https://weibo.com/7854161153/RoF9ww8Pq?comment_id=old' });
  const stored = getActionLog(actionId);
  assert.equal(stored.state, 'uncertain');
  let verifyCalls = 0;
  let submitCalls = 0;
  const runner = new TaskRunner({
    verifyComment: async (_account, candidate, content, options) => {
      verifyCalls++;
      assert.equal(candidate.url, 'https://weibo.com/7854161153/RoF9ww8Pq');
      assert.equal(content, '本次最终文案🌟');
      assert.deepEqual(options.delays, [0]);
      return { state: 'succeeded', url: 'https://weibo.com/7854161153/RoF9ww8Pq?comment_id=found' };
    },
    comment: async () => { submitCalls++; throw new Error('复核不得重新提交'); }
  });
  const result = await runner.recheckCommentAction(job.id, actionId);
  assert.equal(result.state, 'succeeded');
  assert.equal(getActionLog(actionId).state, 'succeeded');
  assert.equal(hasCommented(account.id, 'RoF9ww8Pq'), true);
  assert.deepEqual(getJob(job.id).metrics, { success: 1, failed: 0, uncertain: 0, skipped: 0 });
  await runner.recheckCommentAction(job.id, actionId);
  assert.equal(verifyCalls, 1);
  assert.equal(submitCalls, 0);
  assert.equal(getJob(job.id).metrics.success, 1);
});

test('频繁按 UID 类型持久标记，当前任务后续轮次也按 1 小时冷却跳过', async () => {
  const first = createAccount('主记录');
  updateAccountAuth(first.id, { status: 'valid', uid: '7186259742', nickname: '同一微博' });
  const duplicate = createAccount('重复记录');
  db.prepare('UPDATE accounts SET uid=?,nickname=? WHERE id=?').run('7186259742', '同一微博', duplicate.id);
  const second = createAccount('另一个账号');
  updateAccountAuth(second.id, { status: 'valid', uid: '6484593022', nickname: '另一个账号' });
  const topicA = createTopic({ name: '超话甲', url: 'https://example.test/a' });
  const topicB = createTopic({ name: '超话乙', url: 'https://example.test/b' });
  addCommentMaterials(['评论一', '评论二']);
  addPostMaterials(first.id, ['发帖一', '发帖一备用']);
  addPostMaterials(second.id, ['发帖二', '发帖二备用']);
  let rateOnce = true;
  let postRateOnce = true;
  let candidateNumber = 0;
  let currentRound = 0;
  const calls = [];
  const adapter = {
    ensureIdentity: async account => ({ uid: account.uid }),
    collectCandidates: async (_account, topic) => { candidateNumber += 1; return [{ id: `p-${topic.id}-${candidateNumber}`, url: `https://example.test/${topic.id}/${candidateNumber}`, commentCount: 4, authorUid: 'other' }]; },
    comment: async (account, candidate) => {
      calls.push(['comment', account.id, candidate.id, currentRound]);
      if (account.id === first.id && rateOnce) { rateOnce = false; throw new RateLimitError('操作过于频繁', 'comment', true); }
      return { state: 'succeeded', url: candidate.url };
    },
    post: async (account, topic) => {
      calls.push(['post', account.id, topic.id, currentRound]);
      if (account.id === second.id && postRateOnce) { postRateOnce = false; throw new RateLimitError('发帖过于频繁', 'post', true); }
      return { state: 'succeeded' };
    }
  };
  const runner = new TaskRunner(adapter);
  runner.on('update', job => { if (Number.isInteger(job.cursor?.current?.round)) currentRound = job.cursor.current.round; });
  const snapshot = createSnapshot({
    rounds: 2, accountIds: [first.id, duplicate.id, second.id], topicIds: [topicA.id, topicB.id],
    actionPlan: [{ type: 'comment', count: 2 }, { type: 'post', count: 1 }], checkinIntervalSeconds: 0, postIntervalSeconds: 0, commentIntervalSeconds: 0, roundIntervalSeconds: 0
  }, listAccounts(), listTopics());
  const created = runner.start(snapshot, listAccounts(), listTopics());
  await waitFor(() => getJob(created.job.id)?.status === 'completed');
  const final = getJob(created.job.id);
  assert.ok(final.cursor.rateLimits.some(item => item.round === 0 && item.identity === '7186259742' && item.kind === 'comment'));
  assert.ok(final.cursor.rateLimits.some(item => item.round === 0 && item.identity === '6484593022' && item.kind === 'post'));
  assert.equal(calls.some(([kind, accountId, candidateId, round]) => kind === 'comment' && accountId === first.id && candidateId.startsWith(`p-${topicB.id}-`) && round === 0), false);
  assert.equal(calls.some(([kind, accountId, topicId]) => kind === 'post' && accountId === first.id && topicId === topicB.id), true);
  assert.equal(calls.some(([kind, accountId, _candidateId, round]) => kind === 'comment' && accountId === duplicate.id && round === 0), false);
  assert.equal(calls.some(([kind, accountId, candidateId, round]) => kind === 'comment' && accountId === first.id && candidateId.startsWith(`p-${topicA.id}-`) && round === 1), false);
  assert.equal(calls.some(([kind, accountId, candidateId, round]) => kind === 'comment' && accountId === second.id && candidateId.startsWith(`p-${topicB.id}-`) && round === 0), true);
  assert.equal(calls.some(([kind, accountId, topicId, round]) => kind === 'post' && accountId === second.id && topicId === topicB.id && round === 0), false);
  assert.equal(calls.some(([kind, accountId, topicId, round]) => kind === 'post' && accountId === second.id && topicId === topicB.id && round === 1), false);
  assert.equal(final.metrics.failed, 0);
  assert.ok(final.metrics.skipped >= 1);
});

test('频繁限制持久 1 小时且只匹配对应操作类型', () => {
  clearAllDataForTests();
  const account = createAccount('频繁限制测试');
  const identity = '7000000001';
  const detectedAt = new Date().toISOString();
  recordAccountRestriction({ accountId: account.id, identity, type: 'frequent', kind: 'comment', reason: '评论频繁', detectedAt, expiresAt: new Date(Date.now() + 60 * 60 * 1000).toISOString() });
  const active = listActiveAccountRestrictions();
  assert.equal(active.length, 1);
  assert.equal(active[0].accountId, account.id);
  assert.equal(active[0].kind, 'comment');
  const runner = new TaskRunner({});
  assert.equal(runner.restrictionFor(account.id, 'comment', identity)?.type, 'frequent');
  assert.equal(runner.restrictionFor(account.id, 'post', identity), null);
  db.prepare('UPDATE account_restrictions SET expires_at=? WHERE account_id=?').run(new Date(Date.now() - 1000).toISOString(), account.id);
  runner.accountRestrictionsAt = 0;
  assert.equal(runner.restrictionFor(account.id, 'comment', identity), null);
});

test('手动解除账号限制会清除限制表和进行中任务游标', () => {
  clearAllDataForTests();
  const account = createAccount('解除限制测试');
  updateAccountAuth(account.id, { status: 'valid', uid: '7000000002', nickname: '解除限制测试' });
  const identity = '7000000002';
  const detectedAt = new Date().toISOString();
  recordAccountRestriction({ accountId: account.id, identity, type: 'mute', reason: '测试禁言', detectedAt, expiresAt: new Date(Date.now() + 3600000).toISOString() });
  recordAccountRestriction({ accountId: account.id, identity, type: 'frequent', kind: 'comment', reason: '测试频繁', detectedAt, expiresAt: new Date(Date.now() + 600000).toISOString() });
  const running = createJob({ accountIds: [account.id], topicIds: [], rounds: 1, actionPlan: [] });
  dbModule.updateJob(running.id, { cursor: { stepIndex: 0, muteLimits: [{ round: 0, identity, accountId: account.id, at: detectedAt }], rateLimits: [{ round: 0, identity, accountId: account.id, kind: 'comment', at: detectedAt }] } });
  const finished = createJob({ accountIds: [account.id], topicIds: [], rounds: 1, actionPlan: [] });
  dbModule.updateJob(finished.id, { status: 'completed', cursor: { stepIndex: 0, muteLimits: [{ round: 0, identity, accountId: account.id, at: detectedAt }] } });
  assert.equal(listActiveAccountRestrictions().length, 2);
  assert.equal(clearAccountRestrictions(account.id), 2);
  assert.equal(clearAccountRestrictionsFromOpenJobs({ accountId: account.id, identity }), 1);
  assert.equal(listActiveAccountRestrictions().length, 0);
  assert.deepEqual(getJob(running.id).cursor.muteLimits, []);
  assert.deepEqual(getJob(running.id).cursor.rateLimits, []);
  assert.equal(getJob(finished.id).cursor.muteLimits.length, 1);
  const runner = new TaskRunner({});
  runner.accountRestrictionsAt = 0;
  assert.equal(runner.restrictionFor(account.id, 'comment', identity), null);
});

test('启动回填只恢复未过期的游标限制', () => {
  clearAllDataForTests();
  const account = createAccount('回填测试');
  const identity = '7000000003';
  const at = Date.now();
  const job = createJob({ accountIds: [account.id], topicIds: [], rounds: 1, actionPlan: [] });
  dbModule.updateJob(job.id, { status: 'completed', cursor: { stepIndex: 0,
    muteLimits: [
      { round: 0, identity, accountId: account.id, at: new Date(at - 2 * 3600000).toISOString(), reason: '两小时前禁言' },
      { round: 0, identity: identity + '9', accountId: account.id, at: new Date(at - 25 * 3600000).toISOString(), reason: '过期禁言' }
    ],
    rateLimits: [{ round: 0, identity: identity + '8', accountId: account.id, kind: 'comment', at: new Date(at - 30 * 60000).toISOString(), reason: '半小时前频繁' }]
  } });
  assert.equal(seedAccountRestrictionsFromJobs(), 2);
  assert.deepEqual(listActiveAccountRestrictions().map(item => item.type + ':' + item.kind).sort(), ['frequent:comment', 'mute:']);
});

test('登录验证状态会显示，关闭窗口后停止检测，不清理登录目录', async () => {
  const account = createAccount();
  let closed = false; let verified = 0;
  const page = { isClosed: () => closed };
  const manager = { accountId: account.id, owner: 'login', close: async () => { closed = true; } };
  const adapter = { openLogin: async () => ({ page }), ensureQrVisible: async () => true,
    loginChallenge: async () => true, readIdentity: async () => { verified++; return { status: 'invalid' }; } };
  const service = new LoginService(adapter, manager, { intervalMs: 5 });
  service.start(account);
  await waitFor(() => service.status()?.phase === 'verification');
  closed = true;
  await waitFor(() => !service.active);
  const done = verified;
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(verified, done);
  assert.equal(service.status().phase, 'cancelled');
  assert.ok(fs.existsSync(account.profile_dir));
});

test('二维码稳定显示前初始标签关闭会在同一登录会话恢复一次', async () => {
  const account = createAccount();
  let opens = 0, closed = 0;
  const first = { isClosed: () => true };
  const second = { isClosed: () => false };
  const manager = { accountId: account.id, owner: 'login', foreground: async () => {}, isMinimized: async () => false, close: async () => { closed++; manager.owner = null; } };
  const adapter = {
    openLogin: async () => ({ page: ++opens === 1 ? first : second }),
    ensureQrVisible: async () => true,
    loginChallenge: async () => false,
    readIdentity: async () => ({ status: 'invalid' })
  };
  const service = new LoginService(adapter, manager, { intervalMs: 5 });
  service.start(account);
  await waitFor(() => opens === 2 && service.status()?.phase === 'waiting');
  assert.equal(service.status().recoveryAttempts, 1);
  assert.equal(service.status().qrShown, true);
  await service.cancel();
  assert.equal(closed, 1);
});

test('初次扫码导航异常后恢复的轮询在取消前不触发关闭', async () => {
  const account = createAccount();
  let opens = 0, closes = 0, polls = 0;
  const page = { isClosed: () => false };
  const manager = { accountId: account.id, owner: 'login', close: async () => { closes++; } };
  const service = new LoginService({
    openLogin: async () => { if (++opens === 1) throw new Error('initial navigation interrupted'); return { page }; },
    ensureQrVisible: async () => true, readIdentity: async () => { polls++; return { status: 'invalid' }; },
    loginChallenge: async () => false
  }, manager, { intervalMs: 5 });
  service.start(account);
  await waitFor(() => polls >= 3);
  assert.equal(opens, 2);
  assert.equal(closes, 0);
  assert.equal(service.status().active, true);
  await service.cancel();
  assert.equal(closes, 1);
});

test('已有任务的按账号文案快照仍能执行', async () => {
  const account = createAccount();
  const topic = createTopic({ name: '超话', url: 'https://example.test/topic' });
  const snapshot = { rounds: 1, accountIds: [account.id], topicIds: [topic.id], actionPlan: [{ type: 'post', count: 1 }], materials: { posts: { [account.id]: [{ id: 'p', text: '旧任务原文' }] }, comments: [] } };
  const job = createJob(snapshot);
  let sent;
  const runner = new TaskRunner({ post: async (_a, _t, content) => { sent = content; return { state: 'succeeded' }; } });
  await runner.execute(job, buildSteps(snapshot)[0], account, topic);
  assert.equal(sent, '旧任务原文');
});

test('旧发帖库迁移备份后合并去重且重复启动不重复导入', () => {
  const dir = fs.mkdtempSync(path.join(tempDir, 'migration-'));
  const old = new DatabaseSync(path.join(dir, 'old.sqlite'));
  old.exec("CREATE TABLE settings(key TEXT PRIMARY KEY,value TEXT NOT NULL); CREATE TABLE post_materials(id TEXT PRIMARY KEY,account_id TEXT,text TEXT,enabled INTEGER,created_at TEXT)");
  const insert = old.prepare('INSERT INTO post_materials VALUES(?,?,?,?,?)');
  insert.run('p1', 'a', '共同文案', 1, '2026-01-01');
  insert.run('p2', 'b', '共同文案', 1, '2026-01-02');
  insert.run('p3', 'b', '另一个文案', 1, '2026-01-03');
  old.prepare('INSERT INTO settings VALUES(?,?)').run('task_defaults', JSON.stringify({ decoration: { mode: 'number', emojis: ['🌈'] } }));
  const backup = migrateSharedMaterials(old, dir);
  assert.ok(fs.existsSync(backup));
  assert.equal(old.prepare('SELECT COUNT(*) n FROM shared_post_materials').get().n, 2);
  assert.equal(migrateSharedMaterials(old, dir), null);
  assert.equal(old.prepare('SELECT COUNT(*) n FROM shared_post_materials').get().n, 2);
  const restored = new DatabaseSync(backup, { readOnly: true });
  assert.equal(restored.prepare('SELECT COUNT(*) n FROM post_materials').get().n, 3);
  restored.close(); old.close();
});

async function waitFor(predicate, timeout = 4000) {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started > timeout) throw new Error('等待条件超时');
    await new Promise(resolve => setTimeout(resolve, 20));
  }
}
test('详细记录只保留10天，每日计数归档且轮次摘要保留', async () => {
  const { pruneDetailedRecords, shiftDate } = await import('../src/retention.js');
  const { dailySuccess } = await import('../src/task-reports.js');
  const today = shanghaiDate();
  const old = shiftDate(today, -12);
  const busy = shiftDate(today, -13);
  const recent = shiftDate(today, -3);
  const account = createAccount();
  db.prepare('UPDATE accounts SET uid=?,name=? WHERE id=?').run('112233','归档账号',account.id);
  const topic = createTopic({ name: '归档超话', url: 'https://example.test/archive' });
  const jobStmt = db.prepare('INSERT INTO jobs(id,status,config_json,cursor_json,metrics_json,created_at,updated_at) VALUES(?,?,?,?,?,?,?)');
  jobStmt.run('old-job-r','completed',JSON.stringify({accountIdentities:{[account.id]:{name:'归档账号',uid:'112233'}}}),'{}','{}',old+'T01:00:00.000Z',old+'T02:00:00.000Z');
  jobStmt.run('paused-job-r','paused','{}','{}','{}',busy+'T01:00:00.000Z',busy+'T02:00:00.000Z');
  const insert = db.prepare('INSERT INTO action_logs(id,job_id,step_key,kind,account_id,state,error,started_at) VALUES(?,?,?,?,?,?,?,?)');
  insert.run('old-a1','old-job-r','0:1','post',account.id,'succeeded',null,old+'T01:05:00.000Z');
  insert.run('old-a2','old-job-r','0:2','post',account.id,'succeeded',null,old+'T01:06:00.000Z');
  insert.run('old-a3','old-job-r','0:3','post',account.id,'failed','操作失败',old+'T01:07:00.000Z');
  insert.run('old-a4','old-job-r','0:4','comment',account.id,'submitted','待核对回执',old+'T01:08:00.000Z');
  insert.run('busy-a1','paused-job-r','0:1','comment',account.id,'succeeded',null,busy+'T01:05:00.000Z');
  insert.run('recent-a1','old-job-r','1:1','comment',account.id,'succeeded',null,recent+'T01:05:00.000Z');
  db.prepare("INSERT INTO system_logs(level,message,created_at) VALUES('warning','旧日志',?)").run(old+'T01:08:00.000Z');
  db.prepare('INSERT INTO verification_cards(job_id,round_index,identity,account_id,status,reason,triggered_at,updated_at) VALUES(?,?,?,?,?,?,?,?)').run('old-job-r',0,'112233',account.id,'resolved','旧验证',old+'T01:09:00.000Z',old+'T01:09:00.000Z');
  const stepStmt = db.prepare('INSERT INTO task_step_state(job_id,step_key,ordinal,round_index,account_id,identity,topic_id,kind,action_index,unit_index,state) VALUES(?,?,?,?,?,?,?,?,?,?,?)');
  stepStmt.run('old-job-r','0:1',1,0,account.id,'112233',topic.id,'post',0,0,'done');
  stepStmt.run('paused-job-r','0:1',1,0,account.id,'112233',topic.id,'post',0,0,'pending');
  db.prepare('INSERT INTO task_rounds(job_id,round_index,started_at,completed_at,status,summary_json) VALUES(?,?,?,?,?,?)').run('old-job-r',0,old+'T01:00:00.000Z',old+'T02:00:00.000Z','completed',JSON.stringify({counts:{checkin:{succeeded:0,failed:0,uncertain:0,skipped:0},post:{succeeded:2,failed:1,uncertain:0,skipped:0},comment:{succeeded:0,failed:0,uncertain:1,skipped:0}},accounts:[],abnormalAccounts:[],accountCount:1,topicCount:1}));
  db.prepare('INSERT INTO comment_history(account_id,target_id,created_at) VALUES(?,?,?)').run(account.id,'target-old',old+'T03:00:00.000Z');
  db.prepare('INSERT INTO checkins(account_id,topic_id,local_date,status,created_at) VALUES(?,?,?,?,?)').run(account.id,topic.id,old,'succeeded',old+'T03:00:00.000Z');

  const result = pruneDetailedRecords({ days: 10 });
  assert.equal(result.deleted.actions, 3);
  assert.equal(result.deleted.cards, 1);
  assert.equal(result.deleted.steps, 1);
  assert.ok(result.backup && fs.existsSync(result.backup));
  assert.deepEqual(result.busyDates, [busy]);
  assert.equal(db.prepare("SELECT COUNT(*) c FROM action_logs WHERE strftime('%Y-%m-%d',started_at,'+8 hours')=?").get(old).c, 1);
  assert.equal(db.prepare("SELECT state FROM action_logs WHERE id='old-a4'").get().state, 'submitted');
  assert.equal(db.prepare("SELECT COUNT(*) c FROM action_logs WHERE strftime('%Y-%m-%d',started_at,'+8 hours')=?").get(busy).c, 1);
  assert.equal(db.prepare('SELECT COUNT(*) c FROM daily_stats WHERE date=?').get(busy).c, 0);
  assert.equal(db.prepare("SELECT COUNT(*) c FROM action_logs WHERE strftime('%Y-%m-%d',started_at,'+8 hours')=?").get(recent).c, 1);
  assert.equal(db.prepare('SELECT COUNT(*) c FROM jobs').get().c, 2);
  assert.equal(db.prepare('SELECT COUNT(*) c FROM task_rounds').get().c, 1);
  assert.equal(db.prepare('SELECT COUNT(*) c FROM comment_history').get().c, 1);
  assert.equal(db.prepare('SELECT COUNT(*) c FROM checkins').get().c, 1);
  assert.equal(db.prepare("SELECT COUNT(*) c FROM task_step_state WHERE job_id='paused-job-r'").get().c, 1);
  const archived = db.prepare('SELECT * FROM daily_stats WHERE date=?').get(old);
  assert.ok(archived);
  assert.equal(JSON.parse(archived.counts_json).post.succeeded, 2);
  assert.equal(JSON.parse(archived.counts_json).comment.submitted, undefined);
  const success = dailySuccess(old);
  assert.equal(success.post, 2);
  assert.equal(success.checkin, 1);
  const rounds = listRoundReports('old-job-r', true);
  assert.equal(rounds[0].counts.post.succeeded, 2);
  assert.equal(rounds[0].counts.comment.uncertain, 1);
  const again = pruneDetailedRecords({ days: 10 });
  assert.equal(again.deleted.actions, 0);
  assert.equal(db.prepare('SELECT captured_at FROM daily_stats WHERE date=?').get(old).captured_at, archived.captured_at);
});
test('同日签到成功后不会被后续 uncertain 覆盖', async () => {
  const { recordCheckin, getCheckin } = await import('../src/db.js');
  const account = createAccount();
  const topic = createTopic({ name: '签到超话', url: 'https://example.test/ci' });
  recordCheckin(account.id, topic.id, '2026-10-30', 'succeeded');
  const first = getCheckin(account.id, topic.id, '2026-10-30');
  recordCheckin(account.id, topic.id, '2026-10-30', 'uncertain');
  const after = getCheckin(account.id, topic.id, '2026-10-30');
  assert.equal(after.status, 'succeeded');
  assert.equal(after.created_at, first.created_at);
  recordCheckin(account.id, topic.id, '2026-10-29', 'uncertain');
  recordCheckin(account.id, topic.id, '2026-10-29', 'succeeded');
  assert.equal(getCheckin(account.id, topic.id, '2026-10-29').status, 'succeeded');
});

test('响应体读取有上限：永不返回的 body 不会挂住调用方', async () => {
  const started = Date.now();
  assert.equal(await readJsonBounded({ json: () => new Promise(() => {}) }, 40), null);
  assert.ok(Date.now() - started < 2000);
  assert.deepEqual(await readJsonBounded({ json: async () => ({ ok: 1 }) }, 40), { ok: 1 });
  assert.equal(await readJsonBounded({ json: async () => { throw new Error('bad body'); } }, 40), null);
  assert.equal(await readJsonBounded(null, 40), null);
  assert.ok(Number.isFinite(BODY_READ_TIMEOUT_MS) && BODY_READ_TIMEOUT_MS > 0);
  const waited = Date.now();
  assert.equal(await settleBounded(new Set([new Promise(() => {})]), 50), true);
  assert.ok(Date.now() - waited < 2000);
  assert.equal(await settleBounded(new Set(), 50), false);
});

test('发帖兜底搜索遇到永不返回的响应体仍能完成并匹配到帖子', async () => {
  const created = createAccount();
  updateAccountAuth(created.id, { status: 'valid', uid: '1234567890', nickname: '测试账号' });
  const account = getAccount(created.id);
  const topic = createTopic({ name: '苏新皓超话', url: 'https://weibo.com/p/100808abcdef' });
  const content = '苏新皓[超话]测试文案';
  const post = { idstr: '5000000000000001', created_at: new Date().toISOString(), text_raw: content, user: { idstr: '1234567890' } };
  const listeners = new Set();
  const page = {
    isClosed: () => false,
    frames: () => [],
    on(event, fn) { if (event === 'response') listeners.add(fn); },
    off(event, fn) { if (event === 'response') listeners.delete(fn); },
    context: () => ({ pages: () => [page], request: { get: async () => ({ ok: () => false, json: async () => null }) } }),
    url: () => topic.url,
    goto: async () => {
      // A body that never settles (cancelled navigation / long-poll) must not
      // park the fallback search, while a normal payload is still collected.
      for (const fn of [...listeners]) fn({ url: () => 'https://weibo.com/ajax/feed/hung', json: () => new Promise(() => {}) });
      for (const fn of [...listeners]) fn({ url: () => 'https://weibo.com/ajax/statuses/list', json: async () => ({ data: { list: [post] } }) });
    },
    getByText: () => ({ count: async () => 1, nth: () => ({ isVisible: async () => true, click: async () => {} }) }),
    waitForTimeout: async () => {},
    mouse: { wheel: async () => {} },
    evaluate: async fn => {
      const source = String(fn);
      if (source.includes('querySelectorAll')) return [];
      if (source.includes('statuses/show')) return { data: post };
      return null;
    }
  };
  const adapter = new WeiboAdapter({ page: async () => page });
  adapter.ensureIdentity = async () => {};
  const started = Date.now();
  const result = await adapter.findPublishedPost(account, { content, topic, startedAt: new Date(Date.parse(post.created_at) - 1000).toISOString() });
  assert.ok(Date.now() - started < 15000, '兜底搜索不应被单个响应体卡死');
  assert.equal(result.state, 'succeeded');
  assert.equal(result.matchedPostId, '5000000000000001');
});
