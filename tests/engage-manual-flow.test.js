import test from 'node:test';
import assert from 'node:assert/strict';
import {chromium} from 'playwright';
import {WeiboAdapter} from '../src/weibo-adapter.js';
let browser;
test.before(async()=>{browser=await chromium.launch({headless:true,executablePath:'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'});});
test.after(async()=>{await browser?.close();});
const html=`<div><article data-mid="999"><footer><button title="赞">广告</button></footer></article></div>
<div class="detail"><div><a href="/77/12345">发布时间</a><p>目标原微博</p></div><div class="toolbar_main"><div class="woo-box-item" onclick="show('repost')"><i class="woo-font woo-font--retweet">&#xe012;</i><span>100万+</span></div><div class="woo-box-item" onclick="show('comment')"><i class="woo-font woo-font--comment">&#xe011;</i><span>34.4万</span></div><button title="赞" style="color:rgb(147,147,147)" onclick="this.style.color='rgb(255,130,0)'">258万</button></div></div>
<div id="composer"><textarea placeholder="发布你的评论"></textarea><label><input id="couple" type="checkbox" style="pointer-events:none"><span id="couple-label">同时转发</span></label><label><input id="unrelated" type="checkbox" checked><span>不相关</span></label><button id="send" onclick="send()">评论</button></div>
<div class="comment_row"><a href="/u/88">用户</a><div>支持目标</div><button title="赞" style="color:rgb(147,147,147)" onclick="this.style.color='rgb(255,130,0)'">25</button></div>
<div id="toast" role="alert"></div><script>
function show(kind){document.querySelector('textarea').placeholder=kind==='repost'?'说说分享心得':'发布你的评论';document.querySelector('#send').textContent=kind==='repost'?'转发':'评论';document.querySelector('#couple-label').textContent=kind==='repost'?'同时评论':'同时转发';}
function send(){const kind=document.querySelector('#send').textContent;window.lastCoupled=document.querySelector('#couple').checked;document.querySelector('#toast').textContent=kind+'成功';document.querySelector('textarea').value='';}
</script>`;
async function fixture(){const p=await browser.newPage();p.setDefaultTimeout(1800);await p.route('https://weibo.com/**',r=>{const u=new URL(r.request().url());if(u.pathname==='/ajax/statuses/buildComments')return r.fulfill({json:{data:[{idstr:'c1',text:'支持目标',user:{idstr:'88'},like_status:0}]}});if(u.pathname==='/ajax/statuses/show')return r.fulfill({json:{idstr:'12345',user:{idstr:'77'},text:'目标原微博',liked:false}});return r.fulfill({contentType:'text/html;charset=utf-8',body:html});});return p;}
const account={id:'fixture',uid:'55'},link='https://weibo.com/77/12345';
test('转发数字/图标入口、div详情卡、页内编辑器，成功提示无需回执ID',async()=>{const p=await fixture();const a=new WeiboAdapter({page:async()=>p});let submitted=0,saved=[];
 const result=await a.repostWeibo(account,link,'正文',{receiptTimeoutMs:1200,onSubmit:()=>submitted++,onReceipt:r=>saved.push(r)});
 assert.equal(result.state,'succeeded');assert.equal(result.successSource,'page_notice');assert.equal(saved.length,1);assert.equal(submitted,1);assert.equal(saved[0].receiptId,null);await p.close();});
test('engage评论使用原微博图标入口、正确编辑器，评论成功即可',async()=>{const p=await fixture();const a=new WeiboAdapter({page:async()=>p});let saved=[];
 const r=await a.comment(account,{url:link,id:'12345'},'支持目标',{engage:true,onReceipt:r=>saved.push(r)});assert.equal(r.state,'succeeded');assert.equal(r.successSource,'page_notice');assert.equal(saved.length,1);await p.close();});
test('数字 mid 链接在正文页渲染成短编号时仍能定位目标卡片',async()=>{const p=await browser.newPage();p.setDefaultTimeout(1800);
 await p.route('https://weibo.com/**',r=>r.fulfill({contentType:'text/html;charset=utf-8',body:
  '<article class="woo-panel-main"><div><a href="/77/RquazFEBs">26-11-8</a><p>目标原微博</p></div><div class="toolbar_main"><button title="赞">1</button></div></article>'}));
 await p.goto('https://weibo.com/77/5363125039927530');
 const a=new WeiboAdapter({page:async()=>p});const started=Date.now();
 const card=await a.engagePostCard(p,'5363125039927530');
 assert.ok(card);assert.equal(await p.locator('[data-engage-toolbar]').count(),1);assert.ok(Date.now()-started<5000);await p.close();});
test('转发按配置勾选同时评论，评论不再操作同时转发',async()=>{
 for(const coupled of [true,false]){
  const p=await fixture(),a=new WeiboAdapter({page:async()=>p});
  const r=await a.repostWeibo(account,link,'正文',{alsoComment:coupled});
  assert.equal(r.state,'succeeded');assert.equal(await p.evaluate(()=>window.lastCoupled),coupled);assert.equal(await p.locator('#unrelated').isChecked(),true);await p.close();
 }
 const p=await fixture(),a=new WeiboAdapter({page:async()=>p});
 const r=await a.comment(account,{url:link,id:'12345'},'支持目标',{engage:true});
 assert.equal(r.state,'succeeded');assert.equal(await p.evaluate(()=>window.lastCoupled),false);assert.equal(await p.locator('#unrelated').isChecked(),true);await p.close();
});
test('点赞按灰变橙；无评论ID属性也能定位，已赞跳过，不误点外赞',async()=>{const p=await fixture();const a=new WeiboAdapter({page:async()=>p});let gates=0;
 const targets=await a.scanComments(account,link,{limit:1});assert.deepEqual(targets.map(x=>x.id),['c1']);
 const r=await a.likeComment(account,link,'c1',{onSubmit:()=>gates++});assert.equal(r.state,'succeeded');assert.equal(gates,1);
 const again=await a.likeComment(account,link,'c1',{onSubmit:()=>gates++});assert.equal(again.state,'skipped');assert.equal(gates,1);
 assert.equal((await a.verifyCommentLike(account,link,'c1')).state,'succeeded');
 assert.equal((await a.likeWeibo(account,link,{onSubmit:()=>gates++})).state,'succeeded');assert.equal((await a.likeWeibo(account,link)).state,'skipped');await p.close();});
test('外赞接口缺少 liked 字段时，目标微博页面已赞仍记为跳过',async()=>{const p=await fixture();await p.goto(link);
 await p.locator('.detail .toolbar_main button[title="赞"]').evaluate(button=>button.style.color='rgb(255,130,0)');
 await p.unroute('https://weibo.com/**');
 await p.route('https://weibo.com/**',route=>{const url=new URL(route.request().url());if(url.pathname==='/ajax/statuses/show')return route.fulfill({json:{idstr:'12345',user:{idstr:'77'},text:'目标原微博'}});return route.continue();});
 const a=new WeiboAdapter({page:async()=>p});let submits=0;
 const result=await a.likeWeibo(account,link,{onSubmit:()=>submits++});
 assert.equal(result.state,'skipped');assert.equal(result.alreadyDone,true);assert.equal(submits,0);await p.close();});
test('断网闸门拒绝时不点击转发，旧成功提示不能认领本次',async()=>{const p=await fixture();const a=new WeiboAdapter({page:async()=>p});let submits=0;
 await assert.rejects(a.repostWeibo(account,link,'正文',{beforeSubmit:()=>{throw Error('offline gate');},onSubmit:()=>submits++}),/offline gate/);assert.equal(submits,0);await p.close();});
test('后台验证码标签只关闭验证页，不关闭账号任务页和浏览器上下文',async()=>{
 let challengeClosed=0,taskClosed=0;
 const task={isClosed:()=>Boolean(taskClosed),close:async()=>{taskClosed+=1;}};
 const challenge={isClosed:()=>Boolean(challengeClosed),close:async()=>{challengeClosed+=1;}};
 const manager={context:{pages:()=>[task,challenge]}};
 const a=new WeiboAdapter(manager);
 const handled=await a.withChallengeMode('background',()=>a.dismissBackgroundChallenge(challenge));
 assert.equal(handled,true);assert.equal(challengeClosed,1);assert.equal(taskClosed,0);
});
