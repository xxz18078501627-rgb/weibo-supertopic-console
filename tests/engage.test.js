import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'weibo-console-engage-'));
process.env.WEIBO_CONSOLE_DATA_DIR = tempDir;
process.env.WEIBO_CONSOLE_LICENSE = 'off';
process.env.WEIBO_CONSOLE_TOPIC_MODE = 'general';

const dbModule = await import('../src/db.js');
const engageModule = await import('../src/engage.js');
const runnerModule = await import('../src/runner.js');
const { buildSteps, createSnapshot, validateSnapshot } = runnerModule;
const { buildEngageSteps, engageExpectedCounts, parseWeiboLink, parseEngageLinks } = engageModule;
const { addCommentMaterials, addRepostMaterials, createAccount, createMaterialGroup, clearAllDataForTests, listAccounts, listRepostMaterials, listCommentMaterials } = dbModule;

test.beforeEach(() => { clearAllDataForTests(); });

test('解析微博链接并规范化，短链和非法链接被识别', () => {
  assert.equal(parseWeiboLink('https://weibo.com/123/AbCdEf').ok, true);
  assert.equal(parseWeiboLink('https://weibo.com/123/AbCdEf').authorUid, '123');
  assert.equal(parseWeiboLink('https://m.weibo.cn/detail/4971234567890').ok, true);
  assert.equal(parseWeiboLink('https://t.cn/xx').ok, false);
  assert.equal(parseWeiboLink('https://example.com/1/abc').ok, false);
});

test('批量链接解析去重并分离无效项', () => {
  const { links, invalidLinks } = parseEngageLinks(['https://weibo.com/1/aaa', 'https://weibo.com/1/aaa', 'https://weibo.com/1/bbb', 'bad']);
  assert.equal(links.length, 2);
  assert.deepEqual(invalidLinks, ['bad']);
});

test('联动展开与首轮外赞只生成一次', () => {
  const snapshot = {
    kind: 'engage', rounds: 2, likePost: true, links: ['https://weibo.com/1/aaa'], accountIds: ['a1', 'a2'],
    actionPlan: [
      { type: 'repost', count: 2, intervalSeconds: 10, alsoComment: true },
      { type: 'comment', count: 1, intervalSeconds: 3, alsoRepost: false },
      { type: 'comment_like', count: 2, intervalSeconds: 3 }
    ],
    segmentIds: ['s1', 's2', 's3']
  };
  const steps = buildEngageSteps(snapshot);
  const likes = steps.filter(s => s.kind === 'like');
  assert.equal(likes.length, 2); // 2 accounts, round 0 only
  const round0likes = likes.filter(s => s.round === 0).length;
  assert.equal(round0likes, 2);
  const comments = steps.filter(s => s.kind === 'comment');
  // repost segment alsoComment: 2 per account * 2 accounts * 2 rounds = 8 coupled comments;
  // comment segment: 1 * 2 * 2 = 4 comments
  assert.equal(comments.length, 8 + 4);
  const reposts = steps.filter(s => s.kind === 'repost');
  assert.equal(reposts.length, 2 * 2 * 2); // repost segment count 2 * 2 accounts * 2 rounds
});

test('预计计数包含联动且外赞不计轮次', () => {
  const snapshot = {
    kind: 'engage', rounds: 2, likePost: true, links: ['L1', 'L2'], accountIds: ['a1'],
    actionPlan: [
      { type: 'repost', count: 2, alsoComment: true },
      { type: 'comment_like', count: 3 }
    ]
  };
  const counts = engageExpectedCounts(snapshot);
  assert.equal(counts.repost, 1 * 2 * 2 * 2); // accounts*links*rounds*count
  assert.equal(counts.comment, 1 * 2 * 2 * 2); // coupled from repost
  assert.equal(counts.comment_like, 1 * 2 * 2 * 3);
  assert.equal(counts.like, 1 * 2); // accounts*links, no rounds
});

test('engage 快照校验与文案分组过滤', () => {
  const account = createAccount('转赞评账号');
  const g = createMaterialGroup('转发组', 'repost');
  const gc = createMaterialGroup('评论组', 'comment');
  addRepostMaterials(['转发一', '转发二'], g.id);
  addCommentMaterials(['评论一', '评论二'], gc.id);
  const snapshot = createSnapshot({ kind: 'engage', accountIds: [account.id], links: ['https://weibo.com/1/aaa'], repostForm: 'text', actionPlan: [{ type: 'repost', count: 1 }, { type: 'comment', count: 1 }], repostGroupIds: [g.id], commentGroupIds: [gc.id] }, listAccounts(), []);
  assert.equal(snapshot.kind, 'engage');
  assert.deepEqual(new Set(snapshot.materials.reposts.map(m => m.text)), new Set(['转发一', '转发二']));
  assert.deepEqual(new Set(snapshot.materials.comments.map(m => m.text)), new Set(['评论一', '评论二']));
  assert.deepEqual(validateSnapshot(snapshot), []);
  const bad = createSnapshot({ kind: 'engage', accountIds: [account.id], links: [], actionPlan: [{ type: 'repost', count: 1 }] }, listAccounts(), []);
  assert.ok(validateSnapshot(bad).some(e => e.includes('微博链接')));
});

test('构建的 engage 步骤可由 runner.buildSteps 调度', () => {
  const account = createAccount('调度账号');
  addRepostMaterials(['r1', 'r2']);
  addCommentMaterials(['c1', 'c2']);
  const snapshot = createSnapshot({ kind: 'engage', accountIds: [account.id], links: ['https://weibo.com/1/aaa'], actionPlan: [{ type: 'repost', count: 1, alsoComment: true }] }, listAccounts(), []);
  const steps = buildSteps(snapshot);
  assert.equal(steps.filter(s => s.kind === 'repost').length, 1);
  assert.equal(steps.filter(s => s.kind === 'comment').length, 1);
});


const { TaskRunner } = runnerModule;
const { createJob, updateJob, getJob, listActionLogs, createActionLog, updateActionLog, updateAccountAuth, listPostMaterials, addPostMaterials, setMaterialsGroup, deleteMaterialGroup, listMaterialGroups, renameMaterialGroup, setSetting, getSetting, db } = dbModule;
const { AccountLeases, AccountBusyError } = await import('../src/account-leases.js');
const { dailySuccess } = await import('../src/task-reports.js');
const { taskProgress } = await import('../src/task-progress.js');
const { normalizeEngageSettings } = await import('../public/defaults.js');
const { VerificationError } = await import('../src/weibo-adapter.js');
const link = 'https://weibo.com/123/AbCdEf';
function identity(name, uid) { const a = createAccount(name); return updateAccountAuth(a.id, { status: 'valid', uid, nickname: name }); }
function engageJob(account, plan = [{ type:'repost',count:1,intervalSeconds:0,repostForm:'plain' }], extra = {}) {
 return createJob(createSnapshot({kind:'engage',accountIds:[account.id],links:[link],repostForm:'plain',roundIntervalSeconds:0,actionPlan:plan,...extra},listAccounts(),[]));
}
const adapterBase = () => ({ ensureIdentity:async()=>({}), probeConnectivity:async()=>true });

test('新默认只有转发10次/3秒，新评论10次、内赞20条，零间隔不被覆盖', () => {
 const cfg=normalizeEngageSettings(); assert.equal(cfg.actionPlan.length,1); assert.equal(cfg.actionPlan[0].count,10); assert.equal(cfg.actionPlan[0].intervalSeconds,3);
 const legacyComment=normalizeEngageSettings({actionPlan:[{type:'comment',alsoRepost:true}]});
 assert.equal(legacyComment.actionPlan[0].alsoRepost,false,'评论同时转发已停用，历史配置必须降级为关闭');
 const mixed=normalizeEngageSettings({actionPlan:[{type:'comment'},{type:'comment_like'},{type:'repost',intervalSeconds:0}]});
 assert.deepEqual(mixed.actionPlan.map(x=>x.count),[10,20,10]); assert.deepEqual(mixed.actionPlan.map(x=>x.intervalSeconds),[3,3,0]);
 assert.equal(normalizeEngageSettings({actionPlan:[]}).actionPlan.length,0);
});

test('空账号不隐式全选；单段纯转发不要求文案；带文案段独立校验',()=>{
 const a=identity('A','8101');
 const none=createSnapshot({kind:'engage',accountIds:[],links:[link]},listAccounts(),[]);
 assert.deepEqual(none.accountIds,[]);assert.ok(validateSnapshot(none).some(x=>x.includes('账号')));
 const plain=createSnapshot({kind:'engage',accountIds:[a.id],links:[link],actionPlan:[{type:'repost',repostForm:'plain'}]},listAccounts(),[]);
 assert.deepEqual(validateSnapshot(plain),[]);
 const mixed=createSnapshot({...plain,actionPlan:[{type:'repost',repostForm:'text'}],repostForm:'plain'},listAccounts(),[]);
 assert.ok(validateSnapshot(mixed).some(x=>x.includes('转发文案')));
});

test('三类文案组完全隔离，跨类型移动被拒绝，改名与删除只影响本组',()=>{
 const groups=['post','comment','repost'].map(type=>createMaterialGroup('同名组',type));
 addPostMaterials(['发帖'],undefined,groups[0].id); addCommentMaterials(['评论'],groups[1].id);addRepostMaterials(['转发'],groups[2].id);
 const c=listCommentMaterials()[0];assert.throws(()=>setMaterialsGroup('comment',[c.id],groups[0].id),/当前文案类型/);
 const target=createMaterialGroup('评论目标','comment');setMaterialsGroup('comment',[c.id],target.id);assert.equal(listCommentMaterials()[0].group_id,target.id);
 renameMaterialGroup(target.id,'评论新名');assert.equal(listMaterialGroups('comment').find(x=>x.id===target.id).name,'评论新名');
 deleteMaterialGroup(target.id);assert.equal(listCommentMaterials()[0].group_id,'');
 assert.equal(listPostMaterials()[0].group_id,groups[0].id);assert.equal(listRepostMaterials()[0].group_id,groups[2].id);
});

test('全流程真实调度使用链接日志，外赞跨轮只执行一次，联动和内赞计数正确',async()=>{
 const a=identity('A','8102');addCommentMaterials(['c1','c2']);
 const job=engageJob(a,[{type:'repost',count:2,intervalSeconds:0,alsoComment:true,repostForm:'plain'},{type:'comment_like',count:3,intervalSeconds:0}],{rounds:2,likePost:true});
 const calls={repost:0,comment:0,like:0,inner:0}, couplings=[];let rid=0;
 const submit=kind=>async(...args)=>{const opts=args.at(-1);assert.ok(opts.attemptId,kind);if(kind==='repost')couplings.push(opts.alsoComment);opts.onSubmit();calls[kind]++;return{state:'succeeded'};};
 const runner=new TaskRunner({...adapterBase(),repostWeibo:submit('repost'),comment:submit('comment'),likeWeibo:submit('like'),scanComments:async()=>[{id:'c1'},{id:'c2'}],likeComment:submit('inner')},{scope:'engage',leases:new AccountLeases()});
 await runner.run(job.id);
 assert.equal(getJob(job.id).status,'completed');assert.deepEqual(calls,{repost:4,comment:0,like:1,inner:4});assert.deepEqual(couplings,[true,true,true,true]);
 const logs=listActionLogs(job.id);assert.ok(logs.every(x=>x.scope==='engage' && x.link===link && x.topic_id===null));
 assert.equal(logs.filter(x=>x.kind==='comment'&&x.state==='succeeded').length,4);
 assert.equal(logs.filter(x=>x.kind==='comment_like'&&x.state==='skipped').length,2);
 assert.equal(taskProgress(getJob(job.id)).total,15);assert.equal(getJob(job.id).metrics.success,13);
});

test('评论步骤的历史同时转发配置被关闭，不生成转发结果',async()=>{
 const a=identity('原生联动','81021');addCommentMaterials(['c1','c2']);
 const job=engageJob(a,[{type:'comment',count:1,intervalSeconds:0,alsoRepost:true,repostForm:'plain'}]);
 let comments=0,reposts=0;
 const runner=new TaskRunner({...adapterBase(),
  comment:async(_a,_c,_t,options)=>{comments++;assert.equal(options.alsoRepost,undefined);options.onSubmit();return{state:'succeeded',url:link};},
  repostWeibo:async()=>{reposts++;return{state:'succeeded',url:link};}},{scope:'engage',leases:new AccountLeases()});
 await runner.run(job.id);
 assert.equal(comments,1);assert.equal(reposts,0);
 const logs=listActionLogs(job.id);
 assert.equal(logs.find(x=>x.kind==='comment')?.state,'succeeded');
 assert.equal(logs.find(x=>x.kind==='repost'),undefined);
 assert.equal(getJob(job.id).metrics.success,1);
});

test('v5原生联动结果未知时转发和评论同时保留待核对',async()=>{
 const a=identity('联动未知','81022');addCommentMaterials(['c1','c2']);
 const job=engageJob(a,[{type:'repost',count:1,intervalSeconds:0,alsoComment:true,repostForm:'plain'}]);
 let submits=0;
 const runner=new TaskRunner({...adapterBase(),
  repostWeibo:async(_a,_l,_t,options)=>{submits++;options.onSubmit();return{state:'uncertain',reason:'未观察到完整回执'};}},{scope:'engage',leases:new AccountLeases()});
 await runner.run(job.id);
 assert.equal(submits,1);
 const logs=listActionLogs(job.id);
 assert.equal(logs.find(x=>x.kind==='repost')?.state,'uncertain');
 assert.equal(logs.find(x=>x.kind==='comment')?.state,'uncertain');
 assert.equal(getJob(job.id).metrics.uncertain,2);
});

test('两页不同账号可并行，同UID互斥租约会释放且不重复点击',async()=>{
 const a=identity('A','8103'),same={id:'historical-same-uid',uid:'8103'},b=identity('B','8104');const leases=new AccountLeases();
 const release=leases.acquire(a,'workbench');assert.throws(()=>leases.acquire(same,'engage'),error=>error instanceof AccountBusyError && error.statusCode===409);leases.acquire(b,'engage')();release();leases.acquire(same,'engage')();
 const topic=dbModule.createTopic({name:'并行',url:'https://example.test/topic'});
 const work=createJob(createSnapshot({accountIds:[a.id],topicIds:[topic.id],actionPlan:[{type:'checkin',count:1,intervalSeconds:0}]},listAccounts(),dbModule.listTopics()));
 const engage=engageJob(b);let opened=0;let unblock;const gate=new Promise(r=>unblock=r);
 const op=async(...args)=>{opened++;if(opened===2)unblock();await gate;args.at(-1)?.onSubmit?.();return{state:'succeeded'};};
 const w=new TaskRunner({...adapterBase(),checkin:op},{scope:'workbench',leases});const e=new TaskRunner({...adapterBase(),repostWeibo:op},{scope:'engage',leases});
 const timer=setTimeout(()=>unblock(),1500);try{await Promise.all([w.run(work.id),e.run(engage.id)]);}finally{clearTimeout(timer);}
 assert.equal(opened,2);assert.equal(getJob(work.id).status,'completed');assert.equal(getJob(engage.id).status,'completed');assert.equal(leases.owners.size,0);
});

test('同UID任务等待前台租约释放后继续，停止另一页不受影响',async()=>{
 const a=identity('A','8105');const leases=new AccountLeases();const release=leases.acquire(a,'workbench');let clicks=0;
 const job=engageJob(a);const runner=new TaskRunner({...adapterBase(),repostWeibo:async(_a,_l,_t,o)=>{o.onSubmit();clicks++;return{state:'succeeded'};}},{scope:'engage',leases});
 const timer=setTimeout(release,50);try{await runner.run(job.id);}finally{clearTimeout(timer);release();}
 assert.equal(clicks,1);assert.equal(getJob(job.id).status,'completed');assert.equal(leases.owners.size,0);
});

test('每日评论按任务来源独立统计，记录明细保持总量',()=>{
 const a=identity('A','8106'); const e=engageJob(a);const w=createJob({accountIds:[a.id],topicIds:[],rounds:1,actionPlan:[]});
 for(const j of [e,e,w]) { const id=createActionLog({jobId:j.id,stepKey:crypto.randomUUID(),kind:'comment',accountId:a.id,state:'prepared'});updateActionLog(id,{state:'succeeded'}); }
 assert.equal(dailySuccess(undefined,'engage').comment,2);assert.equal(dailySuccess(undefined,'workbench').comment,1);assert.equal(dailySuccess().comment,3);
});

test('点赞验证码只进自己的验证卡，提交未知不会自动重试',async()=>{
 const a=identity('A','8107');const job=engageJob(a,[],{likePost:true});let clicks=0;
 const runner=new TaskRunner({...adapterBase(),likeWeibo:async(_a,_l,o)=>{o.onSubmit();clicks++;throw new VerificationError('点赞验证码');}},{scope:'engage',leases:new AccountLeases()});
 await runner.run(job.id);assert.equal(clicks,1);assert.equal(runner.workflow.status(getJob(job.id)).cards.length,1);
 await runner.run(job.id);assert.equal(clicks,1);assert.equal(listActionLogs(job.id)[0].state,'uncertain');
 runner.stop(job.id);
});

test('两种来源分别建立活跃任务，转赞评不受每日截止限制',async()=>{
 const a=identity('A','8111');const topic=dbModule.createTopic({name:'独立任务',url:'https://example.test/scopes'});
 const w=new TaskRunner(adapterBase(),{scope:'workbench'}),e=new TaskRunner(adapterBase(),{scope:'engage'});w.run=async()=>{};e.run=async()=>{};
 const work=w.start({accountIds:[a.id],topicIds:[topic.id],actionPlan:[{type:'checkin',count:1,intervalSeconds:0}]},listAccounts(),dbModule.listTopics()).job;
 const engage=e.start({kind:'engage',accountIds:[a.id],links:[link],repostForm:'plain',actionPlan:[{type:'repost',count:1,intervalSeconds:0}]},listAccounts(),[]).job;
 assert.notEqual(work.id,engage.id);assert.equal(w.current().id,work.id);assert.equal(e.current().id,engage.id);
 w.pause(work.id);assert.equal(getJob(engage.id).status,'running');e.stop(engage.id);assert.equal(getJob(work.id).status,'paused');
 const late=engageJob(a);const future=new TaskRunner(adapterBase(),{scope:'engage',now:()=>Date.parse(new Date().toISOString().slice(0,10)+'T23:59:30+08:00')+86400000});future.enforceDailyStop();
 assert.equal(getJob(late.id).status,'running');assert.equal(getJob(work.id).status,'paused');
});

test('禁言与评论频繁在两页共享，点赞不受禁言但仍受本类频繁限制',()=>{
 const a=identity('A','8112'),leases=new AccountLeases();const w=new TaskRunner(adapterBase(),{scope:'workbench',leases}),e=new TaskRunner(adapterBase(),{scope:'engage',leases});
 dbModule.recordAccountRestriction({accountId:a.id,identity:a.uid,type:'mute',reason:'测试禁言',detectedAt:new Date().toISOString(),expiresAt:new Date(Date.now()+60000).toISOString()});
 for(const kind of ['post','comment','repost'])assert.equal(e.restrictionFor(a.id,kind,a.uid).type,'mute');assert.equal(e.restrictionFor(a.id,'like',a.uid),null);assert.equal(e.restrictionFor(a.id,'comment_like',a.uid),null);
 dbModule.recordAccountRestriction({accountId:a.id,identity:a.uid,type:'frequent',kind:'like',reason:'测试频繁',detectedAt:new Date().toISOString(),expiresAt:new Date(Date.now()+60000).toISOString()});
 assert.equal(w.restrictionFor(a.id,'like',a.uid).type,'frequent');
});

test('历史修复同步分来源归档计数，不让工作台旧成功数回退或污染转赞评',()=>{
 const a=identity('A','8113');const job=createJob({accountIds:[a.id],topicIds:[],rounds:1,actionPlan:[]});
 const actionId=createActionLog({jobId:job.id,stepKey:'0:archive',kind:'post',accountId:a.id,state:'uncertain'});
 const date='2020-01-02',at=date+'T12:00:00+08:00';db.prepare('UPDATE action_logs SET started_at=?,completed_at=? WHERE id=?').run(at,at,actionId);
 db.prepare('INSERT OR REPLACE INTO daily_scope_stats(date,scope,counts_json,success_json,job_count) VALUES(?,?,?,?,?)').run(date,'workbench',JSON.stringify({post:{succeeded:2,uncertain:1}}),JSON.stringify({post:2}),1);
 db.prepare('INSERT OR REPLACE INTO daily_stats(date,counts_json,job_count,abnormal_accounts,captured_at) VALUES(?,?,?,?,?)').run(date,JSON.stringify({post:{succeeded:2,uncertain:1}}),1,0,at);
 const runner=new TaskRunner(adapterBase());const action=dbModule.getActionLog(actionId);runner.repairPostResult(action,{state:'succeeded',receiptId:'5990012345678942'});
 assert.equal(dailySuccess(date,'workbench').post,3);assert.equal(dailySuccess(date,'engage').post,0);
 const archived=JSON.parse(db.prepare('SELECT counts_json FROM daily_scope_stats WHERE date=? AND scope=?').get(date,'workbench').counts_json);assert.equal(archived.post.succeeded,3);assert.equal(archived.post.uncertain,0);
 runner.repairPostResult(dbModule.getActionLog(actionId),{state:'succeeded',receiptId:'5990012345678942'});assert.equal(dailySuccess(date,'workbench').post,3);
});

test('转赞评未检测显示 unknown，工作台默认 online，两页网络状态互不串',()=>{
 const a=identity('A','8201');const e=engageJob(a),w=createJob({accountIds:[a.id],topicIds:[],rounds:1,actionPlan:[]});
 const er=new TaskRunner(adapterBase(),{scope:'engage'}),wr=new TaskRunner(adapterBase(),{scope:'workbench'});
 assert.deepEqual(er.network.status(getJob(e.id)),{state:'unknown',pauseSource:null});
 assert.deepEqual(wr.network.status(getJob(w.id)),{state:'online',pauseSource:null});
 updateJob(e.id,{cursor:{...getJob(e.id).cursor,networkRecovery:{state:'offline',pauseSource:'network',lastProbe:{state:'offline'}}}});
 assert.equal(er.network.status(getJob(e.id)).state,'offline');assert.equal(wr.network.status(getJob(w.id)).state,'online');
 updateJob(w.id,{cursor:{...getJob(w.id).cursor,networkRecovery:{state:'offline',pauseSource:'network',lastProbe:{state:'offline'}}}});
 assert.equal(wr.network.status(getJob(w.id)).state,'offline');
 const untouched=engageJob(a);assert.equal(er.network.status(getJob(untouched.id)).state,'unknown');
});

test('转赞评提交前探测断网只暂停，不创建动作也不点击提交',async()=>{
 const a=identity('A','8202'),job=engageJob(a);let clicks=0;
 const runner=new TaskRunner({...adapterBase(),probeConnectivity:async()=>false,repostWeibo:async()=>{clicks++;return{state:'succeeded'};}},{scope:'engage',leases:new AccountLeases()});
 try{await runner.run(job.id);}finally{runner.network.clear();}
 assert.equal(clicks,0);assert.equal(getJob(job.id).status,'paused');assert.equal(getJob(job.id).metrics.failed,0);
 assert.equal(getJob(job.id).cursor.networkRecovery.state,'offline');assert.equal(listActionLogs(job.id).length,0);
});

test('转赞评提交后断网恢复只读核对，结果未知不重发',async()=>{
 const a=identity('A','8203'),job=engageJob(a);let online=true,sends=0,reads=0;
 const runner=new TaskRunner({...adapterBase(),probeConnectivity:async()=>online,
  repostWeibo:async(_a,_l,_c,options)=>{sends++;options.onSubmit();online=false;throw Error('net::ERR_CONNECTION_RESET');},
  verifyRepost:async()=>{reads++;return{state:'uncertain'};}
 },{scope:'engage',leases:new AccountLeases()});
 try{
  await runner.run(job.id);
  assert.equal(sends,1);assert.equal(getJob(job.id).status,'paused');assert.equal(getJob(job.id).metrics.failed,0);
  online=true;await runner.network.tick(job.id);await runner.network.tick(job.id);
  if(runner.promise)await runner.promise;
  assert.equal(sends,1);assert.equal(reads,1);
  assert.equal(listActionLogs(job.id).find(x=>x.kind==='repost').state,'uncertain');
  assert.equal(getJob(job.id).metrics.uncertain,1);
 }finally{runner.network.clear();}
});

test('转赞评运行开始在线，操作前或实际点击前断网均暂停；不会标记已提交',async()=>{
 for(const phase of ['operation','click']) {
  clearAllDataForTests();const a=identity('A','8204'),job=engageJob(a);let probes=0,clicks=0;
  const runner=new TaskRunner({...adapterBase(),probeConnectivity:async()=>++probes<(phase==='operation'?2:3),
   repostWeibo:async(_a,_l,_t,options)=>{await options.beforeSubmit();options.onSubmit();clicks++;return{state:'succeeded'};}
  },{scope:'engage',leases:new AccountLeases()});
  try{await runner.run(job.id);}finally{runner.network.clear();}
  assert.equal(clicks,0);assert.equal(getJob(job.id).status,'paused');assert.ok(listActionLogs(job.id).every(row=>!row.submitted_at));
 }
});

test('内赞缓存目标后来已赞：同一步跳过该目标并继续补足，未知结果不换目标',async()=>{
 const a=identity('A','8123');const job=engageJob(a,[{type:'comment_like',count:2,intervalSeconds:0}]);let calls=[];
 const runner=new TaskRunner({...adapterBase(),scanComments:async()=>[{id:'already'},{id:'next'},{id:'last'}],likeComment:async(_a,_l,id,o)=>{
   calls.push(id);if(id==='already')return{state:'skipped',alreadyDone:true};o.onSubmit();return{state:'succeeded'};
 }},{scope:'engage',leases:new AccountLeases()});
 await runner.run(job.id);assert.deepEqual(calls,['already','next','last']);assert.equal(getJob(job.id).metrics.success,2);
});
