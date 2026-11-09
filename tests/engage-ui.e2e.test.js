import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import fs from 'node:fs';import os from 'node:os';import path from 'node:path';import test from 'node:test';
import {chromium} from 'playwright';
import {DatabaseSync} from 'node:sqlite';
const root=path.resolve(import.meta.dirname,'..'),dir=fs.mkdtempSync(path.join(os.tmpdir(),'engage-ui-'));
const port=Number(process.env.WEIBO_CONSOLE_TEST_PORT)||45500+Math.floor(Math.random()*400),url=`http://127.0.0.1:${port}`,token='isolated-engage-ui';
const screenshots=process.env.WEIBO_CONSOLE_TEST_SCREENSHOTS || path.join(os.tmpdir(),'weibo-engage-ui-screenshots');
fs.mkdirSync(screenshots,{recursive:true});
let server,browser,accounts;let startupLog='';
test.before(async()=>{
 const childEnv={WEIBO_CONSOLE_DATA_DIR:dir,WEIBO_CONSOLE_LICENSE:'off',WEIBO_CONSOLE_NOTIFY:'off',WEIBO_CONSOLE_TOPIC_MODE:'general',WEIBO_CONSOLE_PORT:String(port),WEIBO_CONSOLE_ACCESS_TOKEN:token};
 for(const key of ['PATH','HOME','TMPDIR','TEMP','TMP','LANG','LC_ALL','USER','LOGNAME','SHELL','SystemRoot','ComSpec','PATHEXT']) if(process.env[key]) childEnv[key]=process.env[key];
 server=spawn(process.execPath,['src/server.js'],{cwd:root,env:childEnv,stdio:['ignore','pipe','pipe']});
 server.stderr.on('data',b=>startupLog+=b);server.stdout.on('data',b=>startupLog+=b);
 server.on('spawn',()=>{startupLog += `\nspawned pid=${server.pid}`;});
 server.on('error',error=>{startupLog += `\nspawn error=${error.message}`;});
 server.on('exit',(code,signal)=>{startupLog += `\nexit code=${code} signal=${signal}`;});
 let ready=false,lastProbeError='';for(let i=0;i<100;i++){try{const response=await fetch(url);if(response.ok){ready=true;break;}lastProbeError='HTTP '+response.status;}catch(error){lastProbeError=error.code||error.message;}await new Promise(r=>setTimeout(r,100));}assert.ok(ready,'isolated server ready: '+startupLog+' last='+lastProbeError);
 const nativeChrome='/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
 browser=await chromium.launch({headless:true,executablePath:process.env.WEIBO_CONSOLE_CHROME || (process.platform === 'darwin' && fs.existsSync(nativeChrome) ? nativeChrome : undefined)});
 const context=await browser.newContext();await context.request.post(url+'/api/login',{data:{token}});
 accounts=[];for(const name of ['示例账号 A','示例账号 B'])accounts.push(await context.request.post(url+'/api/accounts',{data:{name}}).then(r=>r.json()));
 await context.request.post(url+'/api/repost-materials',{data:{texts:['示例转发文案一','示例转发文案二']}});
 await context.request.post(url+'/api/comment-materials',{data:{texts:['示例评论文案一','示例评论文案二']}});await context.close();
});
test.after(async()=>{await browser?.close();if(server){const stopped=new Promise(r=>server.once('exit',r));server.kill('SIGTERM');await stopped;}fs.rmSync(dir,{recursive:true,force:true});});
async function page(){
 const p=await browser.newPage({viewport:{width:1440,height:900}});
 const close=p.close.bind(p);
 p.close=async(...args)=>{await p.unrouteAll({behavior:'ignoreErrors'}).catch(()=>{});return close(...args);};
 p.setDefaultTimeout(7000);await p.request.post(url+'/api/login',{data:{token}});await p.goto(url);await p.locator('#connection-text').getByText('实时连接',{exact:true}).waitFor();return p;
}
async function engage(p){await p.locator('#nav [data-page="engage"]').click();}
async function tab(p,name){await p.locator(`[data-engage-tab="${name}"]`).click();}
async function add(p,type){await p.locator('#engage-add-action').click();await p.locator(`[data-engage-add="${type}"]`).click();}
async function state(p){return p.request.get(url+'/api/state').then(r=>r.json());}

test('内赞可见楼中楼复选框默认关闭，勾选和模板应用均保留且不串其他操作段',async()=>{
 const p=await page();await engage(p);await tab(p,'plan');await add(p,'comment_like');
 const checkbox=p.getByLabel('点可见楼中楼',{exact:true});
 assert.equal(await checkbox.count(),1);assert.equal(await checkbox.isChecked(),false);
 await checkbox.check();
 p.once('dialog',d=>d.accept('楼中楼独立测试模板'));await p.locator('#engage-template-save').click();
 await p.waitForFunction(()=>document.querySelector('#engage-template-select').value.startsWith('engtpl_'));
 const template=(await state(p)).engageTemplates.find(t=>t.name==='楼中楼独立测试模板');
 assert.ok(template);assert.equal(template.config.actionPlan.find(s=>s.type==='comment_like').includeVisibleReplies,true);
 assert.ok(template.config.actionPlan.filter(s=>s.type!=='comment_like').every(s=>s.includeVisibleReplies===false));
 await checkbox.uncheck();await p.locator('#engage-template-select').selectOption('');await p.locator('#engage-template-select').selectOption(template.id);
 assert.equal(await checkbox.isChecked(),true);
 await p.locator('#nav [data-page="accounts"]').click();await engage(p);await tab(p,'plan');assert.equal(await checkbox.isChecked(),true);
 await p.close();
});

test('工作台配置头部按钮与转赞评一致，底部分步按钮已移除',async()=>{
 const p=await page();
 const read=scope=>p.evaluate(scope=>{
  const pairs=scope==='workbench'
   ? {select:'#template-select',save:'#save-template',delete:'#delete-template',saveDefault:'#save-task',start:'#start-task',group:'#page-overview .template-group'}
   : {select:'#engage-template-select',save:'#engage-template-save',delete:'#engage-template-delete',saveDefault:'#engage-save',start:'#engage-start',group:'#page-engage .engage-template-group'};
  const style=selector=>{
   const s=getComputedStyle(document.querySelector(selector));
   return {height:s.height,minHeight:s.minHeight,borderRadius:s.borderRadius,backgroundColor:s.backgroundColor,color:s.color,fontSize:s.fontSize,fontWeight:s.fontWeight,padding:s.padding,borderTopWidth:s.borderTopWidth,borderTopColor:s.borderTopColor,boxShadow:s.boxShadow};
  };
  const group=getComputedStyle(document.querySelector(pairs.group));
  return {group:{display:group.display,alignItems:group.alignItems,gap:group.gap,flexWrap:group.flexWrap},controls:Object.fromEntries(['select','save','delete','saveDefault','start'].map(key=>[key,style(pairs[key])]))};
 },scope);
 await p.locator('#nav [data-page="overview"]').click();
 await p.waitForTimeout(250);
 const workbench=await read('workbench');
 await engage(p);
 await p.waitForTimeout(250);
 const engageStyles=await read('engage');
 assert.deepEqual(workbench.group,engageStyles.group);
 assert.deepEqual(workbench.controls,engageStyles.controls);
 assert.equal(await p.locator('#config-prev').count(),0);
 assert.equal(await p.locator('#config-next').count(),0);
 assert.equal(await p.locator('#config-card [role="tab"]').count(),3);
 await p.close();
});

test('转赞评暂停后可修改当前任务参数，保存和继续分别提交编辑版本',async()=>{
 const p=await page();
 const config={kind:'engage',rounds:2,roundIntervalSeconds:0,accountIds:[accounts[0].id],links:['https://weibo.com/123/AbCdEf'],likePost:false,repostForm:'text',innerLikeKeyword:'',innerLikeKeywords:[],likeBlacklistProfiles:[],likeBlacklistUids:[],likeBlacklistKeywords:[],segmentIds:['edit-segment'],actionPlan:[{type:'comment_like',segmentId:'edit-segment',count:4,intervalSeconds:3,alsoComment:false,alsoRepost:false,includeVisibleReplies:true}],repostDecoration:{mode:'none',emojis:['🙂'],emojiPosition:'suffix',numberPosition:'suffix'},commentDecoration:{mode:'none',emojis:['🙂'],emojiPosition:'suffix',numberPosition:'suffix'},repostGroupIds:[],commentGroupIds:[]};
 const bodies=[];
 await p.route('**/api/events',route=>route.fulfill({contentType:'text/event-stream',body:': edit fixture\n\n'}));
 await p.route('**/api/state',async route=>{
  const result=await route.fetch(),s=await result.json();
  s.engageNetwork={state:'online'};s.engageBrowser={busy:false,owner:null};
  s.engageJob={id:'virtual-edit',status:'paused',pausedByUser:true,scope:'engage',config:{rounds:2},cursor:{verificationBarrier:false,configVersion:0},metrics:{success:1,uncertain:0,failed:0,skipped:0},progress:{currentRound:1,total:4,processed:1,percent:25}};
  s.engageEdit={jobId:'virtual-edit',version:0,config,status:'paused',canEdit:true};
  s.engageVerification={jobId:'virtual-edit',jobStatus:'paused',canContinue:false,barrier:false,session:null,cards:[]};
  await route.fulfill({response:result,json:s});
 });
 await p.route('**/api/jobs/virtual-edit/edit',async route=>{
  if(route.request().method()==='GET') return route.fulfill({json:{jobId:'virtual-edit',version:0,config,status:'paused',canEdit:true}});
  const body=route.request().postDataJSON();bodies.push(body);await route.fulfill({json:{job:{id:'virtual-edit',status:body.resume?'running':'paused',config:body.config},version:Number(body.version)+1}});
 });
 await p.reload();await engage(p);
 await p.waitForFunction(()=>document.querySelector('#engage-edit'));
 await p.locator('#engage-edit').click();await p.waitForFunction(()=>document.querySelector('#engage-start').textContent==='保存并继续');
 assert.equal(await p.locator('#engage-save').textContent(),'保存修改');
 assert.equal(await p.locator('#engage-links').inputValue(),'https://weibo.com/123/AbCdEf');
 assert.equal(await p.locator('[data-engage-count="0"]').inputValue(),'4');
 await p.locator('#engage-save').click();await p.waitForFunction(()=>document.querySelector('#engage-save-status').textContent.includes('已保存'));
 assert.equal(bodies.length,1);assert.equal(bodies[0].resume,false);assert.deepEqual(bodies[0].config.accountIds,[accounts[0].id]);assert.deepEqual(bodies[0].config.links,['https://weibo.com/123/AbCdEf']);
 await p.locator('#engage-start').click();await p.waitForFunction(()=>document.querySelector('#engage-run-headline').textContent.includes('修改任务参数')===false);
 assert.equal(bodies.length,2);assert.equal(bodies[1].resume,true);assert.equal(bodies[1].version,1);
 await p.close();
});

test('账号选择保存、SSE、切页、刷新均保留；批量链接去重和错误行提示',async()=>{
 const p=await page();const errors=[];p.on('pageerror',e=>errors.push(e.message));await engage(p);
 await p.locator('#engage-pick-accounts').click();await p.locator('#picker-none').click();await p.locator(`[data-picker-account="${accounts[0].id}"]`).check();await p.locator('#picker-confirm').click();
 await p.locator('#engage-links').fill('https://weibo.com/123/AbCdEf\nhttps://weibo.com/123/AbCdEf\nwrong');assert.match(await p.locator('#engage-links-count').textContent(),/共 3 条 · 去重后 1 条/);assert.match(await p.locator('#engage-links-errors').textContent(),/第 3 行/);assert.equal(await p.locator('#engage-start').isDisabled(),true);await p.locator('#engage-save').click();assert.match(await p.locator('#toast').textContent(),/修正无效链接/);assert.equal((await state(p)).engageDefaults.links.length,0);
 await p.locator('#engage-links').fill('https://weibo.com/123/AbCdEf');await p.locator('#engage-save').click();await p.waitForFunction(()=>document.querySelector('#engage-save-status').textContent.includes('已保存'));
 assert.deepEqual((await state(p)).engageDefaults.accountIds,[accounts[0].id]);
 await p.request.post(url+'/api/account-groups',{data:{name:'SSE 刷新测试'}});await p.waitForTimeout(350);assert.match(await p.locator('#engage-pick-accounts').textContent(),/已选 1/);
 await tab(p,'advanced');await p.locator('#engage-inner-keyword').fill('未保存关键词');await p.request.post(url+'/api/account-groups',{data:{name:'另一次刷新'}});await p.waitForTimeout(250);assert.equal(await p.locator('#engage-inner-keyword').inputValue(),'未保存关键词');
 await p.locator('#nav [data-page="materials"]').click();await engage(p);assert.match(await p.locator('#engage-pick-accounts').textContent(),/已选 1/);
 await p.reload();await engage(p);assert.match(await p.locator('#engage-pick-accounts').textContent(),/已选 1/);assert.equal(await p.locator('#engage-links').inputValue(),'https://weibo.com/123/AbCdEf');assert.deepEqual(errors,[]);await p.close();
});

test('三段同屏、直接拖动排序、默认数值、联动计数；高级自然高度、手机单行导航',async()=>{
 const p=await page();await engage(p);
 await p.locator('#engage-pick-accounts').click();await p.locator('#picker-none').click();await p.locator(`[data-picker-account="${accounts[0].id}"]`).check();await p.locator('#picker-confirm').click();
 await p.locator('#engage-links').fill('https://weibo.com/123/AbCdEf');await tab(p,'plan');assert.equal(await p.locator('.engage-action-card').count(),1);assert.equal(await p.locator('[data-engage-count="0"]').inputValue(),'10');assert.equal(await p.locator('[data-engage-interval="0"]').inputValue(),'3');
 await add(p,'comment');await add(p,'comment_like');assert.deepEqual(await p.locator('[data-engage-count]').evaluateAll(es=>es.map(e=>e.value)),['10','10','20']);
 assert.equal(await p.locator('[data-engage-couple="1"]').count(),0);assert.doesNotMatch(await p.locator('.engage-action-card').nth(1).innerText(),/同时转发/);
 const boxes=await p.locator('.engage-action-card').evaluateAll(es=>es.map(e=>{const b=e.getBoundingClientRect();return{x:b.x,y:b.y,width:b.width,right:b.right};}));const rail=await p.locator('#engage-action-plan').boundingBox();assert.ok(boxes.every(b=>b.y===boxes[0].y && b.right<=rail.x+rail.width+1));
 await p.locator('[data-engage-couple="0"]').check();assert.match(await p.locator('#engage-summary').textContent(),/转发 10 · 评论 20 · 内赞 20/);
 const handle=await p.locator('[data-engage-drag="0"]').boundingBox();await p.mouse.move(handle.x+handle.width/2,handle.y+handle.height/2);await p.mouse.down();await p.mouse.move(boxes[2].x+boxes[2].width/2,handle.y+handle.height/2,{steps:16});await p.mouse.up();assert.deepEqual(await p.locator('[data-engage-type]').evaluateAll(es=>es.map(e=>e.value)),['comment','comment_like','repost']);
 await p.screenshot({path:path.join(screenshots,'implemented-engage-operations.png'),fullPage:true});
 await tab(p,'advanced');const row=await p.locator('.engage-runtime-grid input').evaluateAll(es=>es.map(e=>e.getBoundingClientRect().y));assert.equal(new Set(row).size,1);
 const config=await p.locator('#engage-config-card').boundingBox(),black=await p.locator('#engage-black-keywords').boundingBox();assert.ok(black.y+black.height<config.y+config.height);assert.equal(await p.locator('#engage-config-card .config-body').evaluate(e=>getComputedStyle(e).overflowY),'visible');
 const colors=await p.locator('[data-engage-deco="emojiPosition"]').first().evaluate(e=>({disabled:getComputedStyle(e).backgroundColor,normal:getComputedStyle(document.querySelector('#engage-inner-keyword')).backgroundColor}));assert.equal(colors.disabled,colors.normal);
 assert.equal(await p.locator('#engage-verification').isVisible(),true);assert.equal(await p.locator('#engage-recent-actions').isVisible(),true);
 await p.screenshot({path:path.join(screenshots,'implemented-engage-advanced.png'),fullPage:true});
 for(const width of [621,390]){await p.setViewportSize({width,height:926});const nav=await p.locator('#mobile-nav button').evaluateAll(es=>es.map(e=>e.getBoundingClientRect().y));assert.equal(new Set(nav).size,1);assert.equal(await p.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);}
 await tab(p,'plan');assert.equal(await p.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false, 'operation rail must not widen the page');await p.screenshot({path:path.join(screenshots,'implemented-engage-mobile.png'),fullPage:true});await p.close();
});

test('文案三种类型新建组即时同步到筛选、添加与移动；移动和跨类型拦截',async()=>{
 const p=await page();await p.locator('#nav [data-page="materials"]').click();const groups={};
 for(const type of ['post','comment','repost']){
  await p.locator(`[data-material-tab="${type}"]`).click();p.once('dialog',d=>d.accept('独立'+type));await p.locator('#new-material-group').click();await p.waitForFunction(type=>[...document.querySelector('#material-group-filter').options].some(o=>o.textContent==='独立'+type),type);
  groups[type]=(await state(p)).materialGroups.find(g=>g.name==='独立'+type);
  assert.ok(await p.locator('#material-add-group option').evaluateAll((es,name)=>es.some(e=>e.textContent===name),'独立'+type));
  await p.locator('#material-add-group').selectOption(groups[type].id);await p.locator('#material-texts').fill(type+'独立文案');await p.locator('#material-add').click();await p.waitForFunction(type=>document.querySelector('#material-list').textContent.includes(type+'独立文案'),type);
  await p.locator('[data-select-material]').first().check();assert.ok(await p.locator('#material-move-target option').evaluateAll((es,name)=>es.some(e=>e.textContent===name),'独立'+type));
  await p.locator('#material-move-target').selectOption(groups[type].id);await p.locator('#material-move-apply').click();await p.waitForFunction(()=>document.querySelector('#material-move-bar').classList.contains('hidden'));
  assert.ok((await state(p))[{post:'posts',comment:'comments',repost:'reposts'}[type]].some(m=>m.group_id===groups[type].id));
 }
 await p.locator('[data-material-tab="comment"]').click();assert.equal(await p.locator(`#material-group-filter option[value="${groups.post.id}"]`).count(),0);assert.equal(await p.locator(`#material-group-filter option[value="${groups.repost.id}"]`).count(),0);
 const c=(await state(p)).comments[0];const wrong=await p.request.post(url+'/api/materials/group',{data:{type:'comment',ids:[c.id],groupId:groups.post.id}});assert.equal(wrong.status(),400);
 await p.screenshot({path:path.join(screenshots,'implemented-materials.png'),fullPage:true});await p.close();
});

test('记录沿用四宫格和原有筛选，转赞评明细接入且每日评论独立',async()=>{
 const p=await page();const now=new Date().toISOString(),sql=new DatabaseSync(path.join(dir,'console.sqlite'));
 sql.prepare("INSERT INTO jobs(id,status,scope,config_json,cursor_json,metrics_json,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)").run('engage-record-fixture','completed','engage',JSON.stringify({kind:'engage',rounds:1,links:['https://weibo.com/123/AbCdEf'],accountIds:[accounts[0].id],actionPlan:[]}), '{}','{}',now,now);
 for(const [id,kind]of [['repost-record','repost'],['comment-record','comment'],['inner-record','comment_like']])sql.prepare('INSERT INTO action_logs(id,job_id,step_key,scope,kind,account_id,state,url,link,started_at,completed_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)').run(id,'engage-record-fixture',id,'engage',kind,accounts[0].id,'succeeded','https://weibo.com/123/AbCdEf','https://weibo.com/123/AbCdEf',now,now);
 sql.close();await p.reload();await engage(p);assert.equal(await p.locator('[data-engage-daily-kind="comment"]').textContent(),'1');assert.equal(await p.locator('[data-daily-kind="comment"]').textContent(),'0');
 await p.locator('#nav [data-page="logs"]').click();await p.locator('.record-scope-toggle [data-record-scope="engage"]').click();await p.waitForFunction(()=>document.querySelector('#record-grid')?.innerText.includes('转发'));assert.equal(await p.locator('#record-grid > *').count(),4);assert.equal(await p.getByLabel('任务来源',{exact:true}).count(),0);assert.match(await p.locator('#record-grid').innerText(),/转发/);await p.close();
});

const { WeiboAdapter } = await import('../src/weibo-adapter.js');
test('点赞 toggle 先读后点、只点目标；缺 liked 时灰色可点、已赞跳过',async()=>{
 const p=await browser.newPage();p.setDefaultTimeout(1500);let postLiked=false,commentLiked=false,unknown=false,clicks=[],gates=0;
 const target='https://weibo.com/77/12345';
 const html=`<article data-mid="999"><footer><button title="赞" onclick="fetch('/fixture/like?kind=wrong')">广告赞</button></footer></article><article data-mid="12345"><a href="/77/12345">时间</a><p>目标正文</p><blockquote><footer><button title="赞" onclick="fetch('/fixture/like?kind=nested-wrong')">嵌套微博赞</button></footer></blockquote><footer><button title="赞" onclick="this.style.color='rgb(255,130,0)';fetch('/fixture/like?kind=post')">赞</button></footer></article><div data-commentid="c1"><button title="赞" onclick="this.style.color='rgb(255,130,0)';fetch('/fixture/like?kind=comment')">评论赞</button></div>`;
 await p.route('https://weibo.com/**',async route=>{const u=new URL(route.request().url());if(u.pathname==='/ajax/statuses/show')return route.fulfill({json:{idstr:'12345',user:{idstr:'77'},text_raw:'目标正文',liked:unknown?null:postLiked}});if(u.pathname==='/ajax/statuses/buildComments')return route.fulfill({json:{data:[{idstr:'c1',user:{idstr:'88'},text:'支持目标',like_status:unknown?undefined:commentLiked?1:0}]}});if(u.pathname==='/fixture/like'){const kind=u.searchParams.get('kind');clicks.push(kind);if(kind==='post')postLiked=true;if(kind==='comment')commentLiked=true;return route.fulfill({json:{ok:1}});}return route.fulfill({contentType:'text/html; charset=utf-8',body:html});});
 const adapter=new WeiboAdapter({page:async()=>p}),account={id:'fake',uid:'123'};const onSubmit=()=>gates++;
 assert.equal((await adapter.likeWeibo(account,target,{onSubmit,blacklistUids:['77']})).state,'skipped');assert.deepEqual(clicks,[]);
 unknown=true;assert.equal((await adapter.likeWeibo(account,target,{onSubmit})).state,'succeeded');assert.equal(gates,1);assert.deepEqual(clicks,['post']);assert.equal((await adapter.likeWeibo(account,target,{onSubmit})).alreadyDone,true);assert.equal(gates,1);await assert.rejects(adapter.likeComment(account,target,'c1',{onSubmit}),/已赞状态/);
 unknown=false;postLiked=false;commentLiked=false;await p.locator('[data-engage-control="engage-like"]').evaluate(button=>button.style.color='rgb(147,147,147)');await assert.rejects(adapter.likeWeibo(account,target,{onSubmit,beforeSubmit:async()=>{await Promise.resolve();throw Error('fixture offline before click');}}),/fixture offline/);assert.equal(gates,1);assert.deepEqual(clicks,['post']);assert.equal((await adapter.likeWeibo(account,target,{onSubmit})).state,'succeeded');assert.equal((await adapter.likeWeibo(account,target,{onSubmit})).alreadyDone,true);assert.deepEqual(clicks,['post','post']);assert.equal(gates,2);
 assert.equal((await adapter.verifyLike(account,target)).state,'succeeded');assert.deepEqual(clicks,['post','post']);
 assert.equal((await adapter.likeComment(account,target,'c1',{onSubmit})).state,'succeeded');assert.equal((await adapter.likeComment(account,target,'c1',{onSubmit})).alreadyDone,true);assert.deepEqual(clicks,['post','post','comment']);assert.equal(gates,3);
 assert.equal((await adapter.verifyCommentLike(account,target,'c1')).state,'succeeded');assert.deepEqual(clicks,['post','post','comment']);
 await p.close();
});

test('外赞缺少 liked 且目标卡片无法唯一定位时不点击',async()=>{
 const p=await browser.newPage();p.setDefaultTimeout(1500);let gates=0,clicks=0;
 const target='https://weibo.com/77/67890';
 await p.route('https://weibo.com/**',async route=>{
  const u=new URL(route.request().url());
  if(u.pathname==='/ajax/statuses/show')return route.fulfill({json:{idstr:'67890',user:{idstr:'77'},text_raw:'目标正文'}});
  if(u.pathname==='/fixture/wrong'){clicks+=1;return route.fulfill({json:{ok:1}});}
  return route.fulfill({contentType:'text/html; charset=utf-8',body:`<article data-mid="999"><footer><button title="赞" onclick="fetch('/fixture/wrong')">广告赞</button></footer></article>`});
 });
 const adapter=new WeiboAdapter({page:async()=>p}),account={id:'fake',uid:'123'};
 await assert.rejects(adapter.likeWeibo(account,target,{onSubmit:()=>gates++}),/没有唯一识别到目标微博的点赞入口/);
 assert.equal(gates,0);assert.equal(clicks,0);await p.close();
});

test('内赞关键词和UID/关键词黑名单先筛选，跳过已赞和状态未知，不借用外赞按钮',async()=>{
 const p=await browser.newPage();p.setDefaultTimeout(1000);let clicks=0;
 const rows=[{idstr:'a',text:'<b>支持</b>目标',user:{idstr:'1'},like_status:0},{idstr:'b',text:'支持目标',user:{idstr:'black'},like_status:0},{idstr:'c',text:'支持黑词',user:{idstr:'3'},like_status:0},{idstr:'d',text:'支持目标',user:{idstr:'4'},like_status:1},{idstr:'unknown',text:'支持目标',user:{idstr:'5'}},{idstr:'e',text:'无关',user:{idstr:'6'},like_status:0}];
 await p.route('https://weibo.com/**',route=>{const u=new URL(route.request().url());if(u.pathname==='/ajax/statuses/buildComments')return route.fulfill({json:{data:rows}});if(u.pathname==='/fixture/like'){clicks++;return route.fulfill({json:{ok:1}});}return route.fulfill({contentType:'text/html; charset=utf-8',body:'<article data-mid="12345"><footer><button title="赞" onclick="fetch(\'/fixture/like\')">外赞</button></footer></article><div data-commentid="a"><a href="/u/1">用户一</a><div class="comment_text">支持目标</div><button title="赞">1</button></div><div data-commentid="b"><a href="/u/black">用户二</a><div class="comment_text">支持目标</div><button title="赞">2</button></div><div data-commentid="c"><a href="/u/3">用户三</a><div class="comment_text">支持黑词</div><button title="赞">3</button></div><div data-commentid="d"><a href="/u/4">用户四</a><div class="comment_text">支持目标</div><button title="赞" style="color:rgb(255,130,0)">4</button></div><div data-commentid="unknown"><a href="/u/5">用户五</a><div class="comment_text">支持目标</div><button title="赞">5</button></div><div data-commentid="e"><a href="/u/6">用户六</a><div class="comment_text">无关</div><button title="赞">6</button></div>'});});
 const adapter=new WeiboAdapter({page:async()=>p}),account={id:'fake'},target='https://weibo.com/77/12345';
 assert.deepEqual((await adapter.scanComments(account,target,{keyword:'支持',blacklistUids:['black'],blacklistKeywords:['黑词']})).map(r=>r.id),['a']);
 assert.deepEqual((await adapter.scanComments(account,target,{keyword:'支持、无关、支持',blacklistUids:['black'],blacklistKeywords:['黑词']})).map(r=>r.id),['a','e']);
 assert.deepEqual((await adapter.scanComments(account,target,{keywords:['无关'],keyword:'支持',blacklistUids:['black'],blacklistKeywords:['黑词']})).map(r=>r.id),['e']);
 assert.deepEqual((await adapter.scanComments(account,target,{blacklistUids:['black'],blacklistKeywords:['黑词']})).map(r=>r.id),['a','e']);
 await p.evaluate(()=>document.querySelectorAll('[data-commentid]').forEach(node=>node.remove()));
 await assert.rejects(adapter.likeComment(account,target,'a'),/评论点赞入口/);assert.equal(clicks,0);
 await p.close();
});

test('转发必须取得当前目标唯一回执，弹窗关闭/其他目标回执不能计成功',async()=>{
 const p=await browser.newPage();p.setDefaultTimeout(1500);let mode='correct',clicks=0,gates=0,saves=[];
 await p.route('https://weibo.com/**',async route=>{
  const u=new URL(route.request().url());if(u.pathname==='/ajax/statuses/repost'){clicks++;return route.fulfill({json:{ok:1,data:{idstr:'5990012345678901'}}});}
  return route.fulfill({contentType:'text/html; charset=utf-8',body:`<article data-mid="12345"><footer><button onclick="document.querySelector('.woo-modal-wrap').style.display='block'">转发</button></footer></article><div class="woo-modal-wrap" style="display:none"><textarea></textarea><button onclick="fetch('/ajax/statuses/repost',{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams({id:window.nextRepostTarget||'12345',status:document.querySelector('textarea').value})}).then(()=>document.querySelector('.woo-modal-wrap').style.display='none')">转发</button></div>`});
 });
 const adapter=new WeiboAdapter({page:async()=>p}),account={id:'fake'},target='https://weibo.com/77/12345';
 const options={attemptId:'repost-attempt',actionId:'action',receiptTimeoutMs:300,onSubmit:()=>gates++,onReceipt:r=>saves.push(r)};
 await assert.rejects(adapter.repostWeibo(account,target,'转发文案',{...options,beforeSubmit:async()=>{throw Error('fixture offline before repost');}}),/fixture offline/);assert.equal(clicks,0);assert.equal(gates,0);
 const result=await adapter.repostWeibo(account,target,'转发文案',options);assert.equal(result.state,'succeeded');assert.equal(result.receiptId,'5990012345678901');assert.equal(saves.length,1);assert.equal(clicks,1);assert.equal(gates,1);
 await p.evaluate(()=>{window.nextRepostTarget='99999';});const uncertain=await adapter.repostWeibo(account,target,'转发文案',{...options,attemptId:'other-attempt'});assert.equal(uncertain.state,'uncertain');assert.equal(saves.length,1);assert.equal(clicks,2);await p.close();
});

test('文案三种类型的未提交草稿、目标组和筛选独立保存；删除当前组不会留下空筛选',async()=>{
 const p=await page();await p.locator('#nav [data-page="materials"]').click();const group=(await state(p)).materialGroups.find(g=>g.name==='独立post');
 await p.locator('#material-texts').fill('发帖未提交草稿');await p.locator('#material-add-group').selectOption(group.id);await p.locator('#material-group-filter').selectOption(group.id);
 await p.locator('[data-material-tab="comment"]').click();assert.equal(await p.locator('#material-texts').inputValue(),'');assert.equal(await p.locator('#material-add-group').inputValue(),'');await p.locator('#material-texts').fill('评论未提交草稿');
 await p.locator('[data-material-tab="repost"]').click();assert.equal(await p.locator('#material-texts').inputValue(),'');await p.locator('#material-texts').fill('转发未提交草稿');
 await p.locator('[data-material-tab="post"]').click();assert.equal(await p.locator('#material-texts').inputValue(),'发帖未提交草稿');assert.equal(await p.locator('#material-add-group').inputValue(),group.id);assert.equal(await p.locator('#material-group-filter').inputValue(),group.id);
 await p.locator('[data-material-tab="comment"]').click();assert.equal(await p.locator('#material-texts').inputValue(),'评论未提交草稿');await p.locator('[data-material-tab="post"]').click();
 await p.request.delete(url+'/api/material-groups/'+group.id);await p.locator('#material-texts').blur();await p.waitForFunction(()=>document.querySelector('#material-group-filter').value==='');assert.ok((await p.locator('#material-list .material-row').count())>0);await p.close();
});

test('独立模板增改删保留账号/链接及草稿，设为默认不改工作台；主页黑名单错误阻断',async()=>{
 const p=await page();await engage(p);const before=await state(p);
 await p.locator('#engage-links').fill('https://weibo.com/321/AbcDEF\ninvalid-draft');
 await tab(p,'advanced');await p.locator('#engage-inner-keyword').fill('支持、加油、支持');
 await p.locator('#engage-black-uids').fill('https://weibo.com/u/777\nhttps://m.weibo.cn/profile/888');await p.locator('#engage-black-uids').blur();
 await p.waitForFunction(()=>document.querySelector('#engage-blacklist-results').textContent.includes('已识别 2'));
 p.once('dialog',d=>d.accept('转赞评独立模板'));await p.locator('#engage-template-save').click();await p.waitForFunction(()=>document.querySelector('#engage-template-select').value.startsWith('engtpl_'));
 let next=await state(p);let t=next.engageTemplates.find(x=>x.name==='转赞评独立模板');assert.ok(t);assert.equal(t.config.accountIds,undefined);assert.equal(t.config.links,undefined);assert.deepEqual(t.config.innerLikeKeywords,['支持','加油']);assert.deepEqual(t.config.likeBlacklistUids,['777','888']);
 assert.deepEqual(next.taskTemplates,before.taskTemplates);assert.deepEqual(next.taskDefaults,before.taskDefaults);
 // Applying a template does not drop even invalid raw scope draft lines.
 await p.locator('#engage-inner-keyword').fill('临时内容');await p.locator('#engage-template-select').selectOption('');await p.locator('#engage-template-select').selectOption(t.id);
 assert.equal(await p.locator('#engage-links').inputValue(),'https://weibo.com/321/AbcDEF\ninvalid-draft');assert.equal(await p.locator('#engage-inner-keyword').inputValue(),'支持、加油');
 await p.locator('#engage-inner-keyword').fill('更新后的关键词');const updated=p.waitForResponse(r=>r.url().endsWith('/api/engage-templates/'+t.id)&&r.request().method()==='PUT');await p.locator('#engage-template-save').click();assert.equal((await updated).status(),200);next=await state(p);assert.equal(next.engageTemplates.filter(x=>x.id===t.id).length,1);assert.equal(next.engageTemplates.find(x=>x.id===t.id).config.innerLikeKeyword,'更新后的关键词');
 const group=await p.request.post(url+'/api/material-groups',{data:{name:'模板引用组',type:'comment'}}).then(r=>r.json());
 assert.equal((await p.request.put(url+'/api/engage-templates/'+t.id,{data:{config:{...t.config,commentGroupIds:[group.id]}}})).status(),200);
 await p.request.delete(url+'/api/material-groups/'+group.id);assert.deepEqual((await state(p)).engageTemplates.find(x=>x.id===t.id).config.commentGroupIds,[]);
 p.once('dialog',d=>d.accept());await p.locator('#engage-template-delete').click();await p.waitForFunction(()=>document.querySelector('#engage-template-select').value==='');assert.equal(await p.locator('#engage-inner-keyword').inputValue(),'更新后的关键词');assert.equal(await p.locator('#engage-links').inputValue(),'https://weibo.com/321/AbcDEF\ninvalid-draft');
 await tab(p,'range');await p.locator('#engage-links').fill('https://weibo.com/321/AbcDEF');await tab(p,'advanced');
 await p.locator('#engage-black-uids').fill('https://example.test/u/777');await p.locator('#engage-black-uids').blur();await p.waitForFunction(()=>document.querySelector('#engage-black-uids').getAttribute('aria-invalid')==='true');assert.equal(await p.locator('#engage-start').isDisabled(),true);
 const badSave=await p.request.put(url+'/api/settings/engage',{data:{likeBlacklistProfiles:['https://example.test/u/777'],likeBlacklistUids:['777']}});assert.equal(badSave.status(),400);
 const badStart=await p.request.post(url+'/api/jobs',{data:{kind:'engage',likeBlacklistProfiles:['bad'],accountIds:before.accounts.map(a=>a.id),links:['https://weibo.com/321/AbcDEF']}});assert.equal(badStart.status(),400);
 await p.locator('#engage-black-uids').fill('777\nhttps://m.weibo.cn/profile/888');await p.locator('#engage-save').click();await p.waitForFunction(()=>document.querySelector('#engage-save-status').textContent.includes('已保存'));
 next=await state(p);assert.deepEqual(next.engageDefaults.likeBlacklistUids,['777','888']);assert.deepEqual(next.engageDefaults.likeBlacklistProfiles,['https://weibo.com/u/777','https://m.weibo.cn/profile/888']);assert.deepEqual(next.taskDefaults,before.taskDefaults);
 await p.close();
});

test('1490/1280/900/621/390/801：关键词始终可见、链接112px内滚动、最近运行首屏可见、运行四结果与进度、继续门槛',async()=>{
 const p=await page();let mode='ready',continued=0;
 await p.route('**/api/events',route=>route.fulfill({contentType:'text/event-stream',body:': isolated status fixture\n\n'}));
 await p.route('**/api/state',async route=>{
  const result=await route.fetch(),s=await result.json();
  s.engageRecentActions=Array.from({length:15},(_,i)=>({id:'engage-ui-recent-'+i,kind:'comment_like',account_name:'示例账号 A',state:'succeeded',display_state:'succeeded',started_at:new Date(Date.now()-i*1000).toISOString(),completed_at:new Date(Date.now()-i*1000).toISOString()}));
  s.engageNetwork={state:mode==='offline'?'offline':mode==='unknown'?'unknown':'online'};
  s.engageBrowser={busy:mode==='session',owner:mode==='session'?'manual':null};
  s.engageJob={id:'virtual-engage-ui',status:'waiting',scope:'engage',config:{rounds:2},cursor:{verificationBarrier:true},metrics:{success:10,uncertain:1,failed:1,skipped:0},progress:{currentRound:1,total:40,processed:12,percent:30}};
  const pendingCard={identity:'pending-account',accountId:'pending-account',name:'未验证账号',uid:'pending-account',status:'pending',source:'verification_detected',attempts:1,verificationResult:'pending',verifiedAt:null,triggeredAt:new Date().toISOString(),checkinResult:'unknown',remainingStepCount:1,remainingCheckins:0,visible:true,currentActionable:true,currentStepKey:'pending-step',currentKind:'comment_like',canOpen:true,reason:'需要验证',steps:[{key:'pending-step',kind:'comment_like',topicId:'post',topicName:'指定微博',state:'deferred',outcome:null,needsReview:false,verificationPending:true,reason:'需要验证'}]};
  s.engageVerification={jobId:'virtual-engage-ui',jobStatus:'waiting',canContinue:!['session','offline','closed','deadline'].includes(mode),barrier:true,cards:mode==='pending'?[pendingCard]:[],session:mode==='session'?{phase:'challenge'}:null};
  if(mode==='closed'){s.engageVerification.jobStatus='stopped';s.engageJob.status='stopped';}
  if(mode==='deadline')s.dailyStop={...s.dailyStop,blocked:true};
  await route.fulfill({response:result,json:s});
 });
 await p.route('**/api/jobs/virtual-engage-ui/verification/continue',async route=>{continued++;await route.fulfill({json:{ok:true}});});
 await p.reload();await engage(p);
 assert.equal(await p.locator('#engage-operation-counts').count(),0);assert.deepEqual(await p.locator('#engage-run-metrics .task-metric').allTextContents(),['10成功','1待核对','1失败','0跳过']);assert.equal(await p.locator('#engage-run-progress [role="progressbar"]').getAttribute('aria-valuenow'),'30');assert.match(await p.locator('#engage-run-progress').innerText(),/已处理 12 \/ 40/);
 for(const width of [1490,1280,900,621,390]){
  await p.setViewportSize({width,height:926});await tab(p,'advanced');const field=p.locator('#engage-inner-keyword');assert.equal(await field.isVisible(),true);const box=await field.boundingBox();assert.ok(box.height>=28 && box.width>60);assert.match(await field.getAttribute('placeholder'),/顿号/);
  await field.fill('支持、加油');await p.request.post(url+'/api/account-groups',{data:{name:'视口'+width}});await p.waitForTimeout(120);assert.equal(await field.inputValue(),'支持、加油');
  await p.screenshot({path:path.join(screenshots,'engage-refined-'+width+'.png'),fullPage:true});
  await tab(p,'range');await p.locator('#engage-links').fill(Array.from({length:30},(_,i)=>'https://weibo.com/123/AB'+i).join('\n'));
  const dimensions=await p.locator('#engage-links').evaluate(e=>({height:e.getBoundingClientRect().height,scroll:e.scrollHeight,client:e.clientHeight,overflow:getComputedStyle(e).overflowY}));assert.equal(dimensions.height,112);assert.ok(dimensions.scroll>dimensions.client);assert.equal(dimensions.overflow,'auto');
  assert.equal(await p.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
 }
 await p.setViewportSize({width:801,height:920});await tab(p,'range');await p.evaluate(()=>scrollTo(0,0));
 const compact=await p.evaluate(()=>{
  const heading=document.querySelector('#engage-recent-panel .panel-head h2').getBoundingClientRect();
  const textarea=document.querySelector('#engage-links').getBoundingClientRect();
  const row=document.querySelector('#engage-recent-actions .recent-row')?.getBoundingClientRect();
  const body=document.querySelector('#engage-config-card .config-body');
  return {innerHeight,headingTop:heading.top,headingBottom:heading.bottom,textareaHeight:textarea.height,rowHeight:row?.height||0,bodyHeight:body.getBoundingClientRect().height,overflowY:getComputedStyle(body).overflowY};
 });
 assert.equal(compact.textareaHeight,112);
 assert.equal(compact.rowHeight,30);
 assert.ok(compact.headingTop>=0&&compact.headingTop<compact.innerHeight,'最近运行标题应进入首屏');
 assert.equal(compact.overflowY,'visible');
 await p.setViewportSize({width:1280,height:926});
 for(const [next,reason]of [['offline','网络断开'],['session','结束'],['closed','结束'],['deadline','截止']]){
  mode=next;await p.locator('#refresh').click();const button=p.locator('#engage-verification [data-verification-continue]');await p.waitForFunction(reason=>document.querySelector('#engage-verification [data-verification-continue]').title.includes(reason),reason);assert.equal(await button.isDisabled(),true);assert.match(await button.getAttribute('title'),new RegExp(reason));
 }
 mode='pending';await p.locator('#refresh').click();await p.waitForFunction(()=>!document.querySelector('#engage-verification [data-verification-continue]').disabled);assert.equal(await p.locator('#engage-verification [data-verification-continue]').isDisabled(),false);
 mode='unknown';await p.locator('#refresh').click();await p.waitForFunction(()=>document.querySelector('#engage-status-lights').textContent.includes('未检测'));assert.doesNotMatch(await p.locator('#engage-status-lights').textContent(),/在线/);
 mode='ready';await p.locator('#refresh').click();await p.waitForFunction(()=>!document.querySelector('#engage-verification [data-verification-continue]').disabled);await p.locator('#engage-verification [data-verification-continue]').click();assert.equal(continued,1);await p.close();
});

test('主线进行中可直接请求验证，已验证卡按完成时间排到最后',async()=>{
 const p=await page();let waiting=false,opened=0;
 const card=(identity,name,{result='pending',triggeredAt,verifiedAt=null,canOpen=false})=>({identity,accountId:identity,name,uid:identity,status:result==='passed'?'ready':'pending',source:'verification_detected',attempts:1,verificationResult:result,verifiedAt,triggeredAt,checkinResult:'unknown',remainingStepCount:1,remainingCheckins:0,visible:true,currentActionable:result!=='passed',currentStepKey:identity+':step',currentKind:'comment_like',canOpen,steps:[{key:identity+':step',kind:'comment_like',topicId:'post',topicName:'指定微博',state:'deferred',outcome:null,needsReview:false,verificationPending:result!=='passed',reason:result==='passed'?'内赞已完成':'需要验证'}],reason:result==='passed'?'验证已通过':'需要验证'});
 await p.route('**/api/events',route=>route.fulfill({contentType:'text/event-stream',body:': verification order fixture\n\n'}));
 await p.route('**/api/state',async route=>{
  const result=await route.fetch(),s=await result.json();
  s.engageNetwork={state:'online'};s.engageBrowser={busy:false,owner:null};
  s.engageJob={id:'virtual-order',status:waiting?'waiting':'running',scope:'engage',config:{rounds:1},cursor:{verificationBarrier:waiting},metrics:{success:1,uncertain:0,failed:0,skipped:0},progress:{currentRound:1,total:3,processed:1,percent:33}};
  s.engageVerification={jobId:'virtual-order',jobStatus:waiting?'waiting':'running',canContinue:false,barrier:waiting,mainlineBusy:!waiting,session:null,cards:[
   card('B','已验证账号',{result:'passed',triggeredAt:'2026-11-04T01:00:00.000Z',verifiedAt:'2026-11-04T02:00:00.000Z',canOpen:false}),
   card('A','待验证甲',{triggeredAt:'2026-11-04T03:00:00.000Z',canOpen:true}),
   card('C','待验证乙',{triggeredAt:'2026-11-04T04:00:00.000Z',canOpen:true})
  ]};
  await route.fulfill({response:result,json:s});
 });
 await p.route('**/api/jobs/virtual-order/verification/open',async route=>{opened+=1;await route.fulfill({json:{ok:true}});});
 await p.reload();await engage(p);
 const names=()=>p.locator('#engage-verification .verify-row > b').allTextContents();
 assert.deepEqual(await names(),['待验证甲','待验证乙','已验证账号']);
 const first=p.locator('#engage-verification [data-verify-identity="A"]');assert.equal(await first.isDisabled(),false);assert.match(await first.getAttribute('title'),/安全暂停主线任务/);await first.click();assert.equal(opened,1);
 await p.close();
});

test('存在未验证卡时仍可继续，提示只执行已验证和未受阻操作',async()=>{
 const p=await page();let continued=0;
 await p.route('**/api/events',route=>route.fulfill({contentType:'text/event-stream',body:': continue fixture\n\n'}));
 await p.route('**/api/state',async route=>{
  const result=await route.fetch(),s=await result.json();
  s.engageNetwork={state:'online'};s.engageBrowser={busy:false,owner:null};
  s.engageJob={id:'virtual-continue',status:'waiting',scope:'engage',config:{rounds:1},cursor:{verificationBarrier:true},metrics:{success:1,uncertain:0,failed:0,skipped:0},progress:{currentRound:1,total:3,processed:1,percent:33}};
  s.engageVerification={jobId:'virtual-continue',jobStatus:'waiting',canContinue:true,barrier:true,session:null,cards:[{identity:'pending-a',accountId:'pending-a',name:'未验证账号',uid:'pending-a',status:'pending',source:'verification_detected',attempts:1,verificationResult:'pending',verifiedAt:null,triggeredAt:new Date().toISOString(),checkinResult:'unknown',remainingStepCount:1,remainingCheckins:0,visible:true,currentActionable:true,currentStepKey:'pending-step',currentKind:'comment_like',canOpen:true,reason:'需要验证',steps:[{key:'pending-step',kind:'comment_like',topicId:'post',topicName:'指定微博',state:'deferred',outcome:null,needsReview:false,verificationPending:true,reason:'需要验证'}]}]};
  await route.fulfill({response:result,json:s});
 });
 await p.route('**/api/jobs/virtual-continue/verification/continue',async route=>{continued+=1;await route.fulfill({json:{ok:true}});});
 await p.reload();await engage(p);
 const button=p.locator('#engage-verification [data-verification-continue]');
 assert.equal(await button.isDisabled(),false);
 assert.match(await button.getAttribute('title'),/先执行已验证账号和未受阻操作/);
 await button.click();assert.equal(continued,1);
 await p.close();
});
