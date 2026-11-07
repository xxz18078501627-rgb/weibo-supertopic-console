import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { chromium } from 'playwright';
import {WeiboAdapter} from '../src/weibo-adapter.js';
import {readStreamingComments} from '../src/engage-dom.js';
let browser;
test.before(async()=>{const exe='/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';browser=await chromium.launch({headless:true,...(existsSync(exe)?{executablePath:exe}:{})});});
test.after(async()=>{await browser?.close();});
const link='https://weibo.com/77/12345',account={id:'fixture',uid:'55'};
const fixtureHTML=`<style>body{margin:0}.detail{height:160px}.row{height:105px;border:1px solid #eee}.like{color:rgb(147,147,147)}.liked{color:rgb(255,130,0)}#comments{margin-top:20px}</style>
<div class="detail"><a href="/77/12345">时间</a><p>原微博</p><footer><button onclick="show('repost')">转发</button><button onclick="show('comment')">评论</button><button title="赞" class="like" onclick="window.wrong++">99</button></footer></div>
<div id="composer"><textarea placeholder="发布你的评论"></textarea><button onclick="post()">评论</button></div><div id="comments"></div><div role="alert"></div>
<script>
window.clicks=[];window.wrong=0;window.scrollCount=0;window.available=8;window.loaded=0;window.autoLoad=false;window.redraw=false;window.unknown=false;
function row(i){return '<div class="row"><a href="/u/'+(100+i)+'">用户'+i+'</a><div class="comment_text">支持目标'+i+'</div><button title="赞" class="like '+(i===0?'liked':'')+'" onclick="like('+i+',this)">'+(20+i)+'</button></div>';}
function load(n){while(window.loaded<n){document.querySelector('#comments').insertAdjacentHTML('beforeend',row(window.loaded++));}}
function like(i,b){window.clicks.push(i);if(!window.unknown)b.className='like liked';if(window.redraw)document.querySelector('#comments').innerHTML=document.querySelector('#comments').innerHTML;}
function show(k){document.querySelector('textarea').placeholder=k==='comment'?'发布你的评论':'说说分享心得';document.querySelector('#composer button').textContent=k==='comment'?'评论':'转发';}
function post(){document.querySelector('[role=alert]').remove();const notice=document.createElement('div');notice.setAttribute('role','alert');notice.textContent=document.querySelector('#composer button').textContent+'成功';document.body.append(notice);document.querySelector('textarea').value='';}
window.addEventListener('scroll',()=>{window.scrollCount++;if(window.autoLoad && window.loaded<window.available && window.scrollY+innerHeight>document.body.scrollHeight-160)load(Math.min(window.loaded+3,window.available));});
load(4);
</script>`;
async function fixture(html=fixtureHTML){const p=await browser.newPage({viewport:{width:900,height:650}});p.setDefaultTimeout(1800);let navigations=0,apis=0;await p.route('https://weibo.com/**',r=>{if(r.request().isNavigationRequest()){navigations++;return r.fulfill({contentType:'text/html;charset=utf-8',body:html});}apis++;return r.fulfill({json:{ok:1}});});const adapter=new WeiboAdapter({page:async()=>p});return{p,adapter,stats:()=>({navigations,apis})};}
function options(){return{onTarget:()=>{},onSubmit:()=>{},assertRunning:()=>{}};}
test('同页边扫边点：已赞跳过、从上到下补足，滚动后加载，不重导航不调用评论池',async()=>{
 const f=await fixture(),o=options();await f.adapter.openWeibo(account,link);await f.p.evaluate(()=>{window.autoLoad=true;});
 for(let i=0;i<5;i++)assert.equal((await f.adapter.likeNextComment(account,link,o)).state,'succeeded');
 assert.deepEqual(await f.p.evaluate(()=>window.clicks),[1,2,3,4,5]);assert.deepEqual(f.stats(),{navigations:1,apis:0});assert.equal(await f.p.evaluate(()=>window.wrong),0);assert.ok(await f.p.evaluate(()=>window.scrollCount)>0);await f.p.close();
});
test('编辑器先出现、评论列表后加载时，等评论出现后再返回会话',async()=>{
 const f=await fixture(fixtureHTML.replace('load(4);','setTimeout(()=>load(4),900);'));
 const scan=await f.adapter.streamingCommentSession(account,link,options());
 const rows=await readStreamingComments(scan.page,{viewportOnly:false});
 assert.ok(rows.length>0);await f.p.close();
});
test('每次点赞Vue重绘整列表：重新按身份读取，不依赖临时标记和旧按钮',async()=>{
 const f=await fixture();await f.adapter.openWeibo(account,link);await f.p.evaluate(()=>{window.redraw=true;load(6);});
 for(let i=0;i<5;i++)assert.equal((await f.adapter.likeNextComment(account,link,options())).state,'succeeded');
 assert.deepEqual(await f.p.evaluate(()=>window.clicks),[1,2,3,4,5]);assert.equal(await f.p.locator('[data-engage-comment-like]').count(),0);await f.p.close();
});
test('目标节点在滚动前脱离 DOM 时，按评论身份重新定位后再点',async()=>{
 const f=await fixture(),originalLocator=f.p.locator.bind(f.p);let detach=true;
 f.p.locator=selector=>{
  const locator=originalLocator(selector);
  if(typeof selector==='string' && selector.startsWith('html > ')) return {
   elementHandle:async(...args)=>{
    const handle=await locator.elementHandle(...args);
    if(detach){detach=false;await f.p.evaluate(()=>{const root=document.querySelector('#comments');root.innerHTML=root.innerHTML;});}
    return handle;
   },
   scrollIntoViewIfNeeded:async()=>{throw new Error('locator.scrollIntoViewIfNeeded: Element is not attached to the DOM');}
  };
  return locator;
 };
 const r=await f.adapter.likeNextComment(account,link,{...options(),deadlineAt:Date.now()+10000});
 assert.equal(r.state,'succeeded',JSON.stringify(r));assert.deepEqual(await f.p.evaluate(()=>window.clicks),[1]);await f.p.close();
});
test('DOM 位置路径漂移到另一条评论时，拒绝误点并重新定位原评论',async()=>{
 const f=await fixture(),originalLocator=f.p.locator.bind(f.p);let drift=true;
 f.p.locator=selector=>{
  const locator=originalLocator(selector);
  if(typeof selector!=='string' || !selector.startsWith('html > ')) return locator;
  return {
   elementHandle:async(...args)=>{
    if(drift){drift=false;await f.p.evaluate(()=>document.querySelector('#comments').insertAdjacentHTML('afterbegin','<div class="ad">广告</div>'));}
    return locator.elementHandle(...args);
   },
   scrollIntoViewIfNeeded:(...args)=>locator.scrollIntoViewIfNeeded(...args)
  };
 };
 const r=await f.adapter.likeNextComment(account,link,options());
 assert.equal(r.state,'succeeded');assert.deepEqual(await f.p.evaluate(()=>window.clicks),[1]);await f.p.close();
});
test('点击预检遇到节点脱离时，视为未提交并重新定位原评论',async()=>{
 const f=await fixture(),originalLocator=f.p.locator.bind(f.p);let fail=true;
 f.p.locator=selector=>{
  const locator=originalLocator(selector);
  if(typeof selector!=='string' || !selector.startsWith('html > ')) return locator;
  return {
   elementHandle:async(...args)=>{
    const handle=await locator.elementHandle(...args);if(!handle)return handle;
    const shouldFail=fail;if(shouldFail)fail=false;
    return new Proxy(handle,{get(target,prop){if(prop==='click'&&shouldFail)return async()=>{throw new Error('elementHandle.click: Element is not attached to the DOM');};const value=Reflect.get(target,prop,target);return typeof value==='function'?value.bind(target):value;}});
   },
   scrollIntoViewIfNeeded:(...args)=>locator.scrollIntoViewIfNeeded(...args)
  };
 };
 const r=await f.adapter.likeNextComment(account,link,{...options(),deadlineAt:Date.now()+10000});
 assert.equal(r.state,'succeeded',JSON.stringify(r));assert.deepEqual(await f.p.evaluate(()=>window.clicks),[1]);await f.p.close();
});
test('关键词任意命中和黑名单均在当前行判断，加载到底才报不足',async()=>{
 const f=await fixture();const o={...options(),keywords:['目标1','目标2'],blacklistUids:['101']};
 assert.equal((await f.adapter.likeNextComment(account,link,o)).state,'succeeded');assert.deepEqual(await f.p.evaluate(()=>window.clicks),[2]);
 const r=await f.adapter.likeNextComment(account,link,o);assert.equal(r.state,'skipped');assert.equal(r.exhausted,true);assert.match(r.reason,/数量不足/);assert.deepEqual(await f.p.evaluate(()=>window.clicks),[2]);await f.p.close();
});
test('提交后未变橙是uncertain，只点一次不自动补点；断网前置闸门不提交',async()=>{
 const f=await fixture();await f.adapter.openWeibo(account,link);await f.p.evaluate(()=>{window.unknown=true;});
 const r=await f.adapter.likeNextComment(account,link,options());assert.equal(r.state,'uncertain');assert.deepEqual(await f.p.evaluate(()=>window.clicks),[1]);
 await assert.rejects(f.adapter.likeNextComment(account,link,{...options(),beforeSubmit:()=>{throw Error('ERR_INTERNET_DISCONNECTED');}}),/ERR_INTERNET/);assert.deepEqual(await f.p.evaluate(()=>window.clicks),[1]);await f.p.close();
});
test('网络闸门等待时重绘：提交前重新定位同一条而非旧DOM序号',async()=>{
 const f=await fixture();let once=false;const o={...options(),beforeSubmit:async()=>{if(once)return;once=true;await f.p.evaluate(()=>{const root=document.querySelector('#comments');root.innerHTML='<div class="ad">新插入广告</div>'+root.innerHTML;});}};
 assert.equal((await f.adapter.likeNextComment(account,link,o)).state,'succeeded');assert.deepEqual(await f.p.evaluate(()=>window.clicks),[1]);await f.p.close();
});
test('转发重复及评论切换复用同一页面；页面外赞不被当作内赞',async()=>{
 const f=await fixture();for(let n=0;n<3;n++)assert.equal((await f.adapter.repostWeibo(account,link,'文案'+n,{receiptTimeoutMs:1200})).state,'succeeded');
 assert.equal((await f.adapter.comment(account,{url:link,id:'12345'},'评论',{engage:true})).state,'succeeded');
 assert.equal((await f.adapter.likeNextComment(account,link,options())).state,'succeeded');assert.equal(f.stats().navigations,1);assert.equal(await f.p.evaluate(()=>window.wrong),0);await f.p.close();
});
test('未知结果恢复只读核对：DOM身份和真实评论ID都能认领，未赞不补点',async()=>{
 const f=await fixture();await f.adapter.openWeibo(account,link);
 await f.p.evaluate(()=>document.querySelectorAll('.row')[1].setAttribute('data-comment-id','fixture-cid'));
 const rows=await readStreamingComments(f.p),orange=rows.find(r=>r.liked),grey=rows.find(r=>r.id==='fixture-cid');
 assert.equal((await f.adapter.verifyCommentLike(account,link,orange.key)).state,'succeeded');
 assert.equal((await f.adapter.verifyCommentLike(account,link,grey.key)).state,'uncertain');
 await f.p.evaluate(()=>document.querySelector('[data-comment-id] button').className='like liked');
 assert.equal((await f.adapter.verifyCommentLike(account,link,grey.key)).state,'succeeded');
 assert.deepEqual(await f.p.evaluate(()=>window.clicks),[]);assert.equal(f.stats().navigations,1);await f.p.close();
});
test('扫描页面关闭后，重建微博页面并继续未提交的内赞',async()=>{
 const context=await browser.newContext({viewport:{width:900,height:650}});
 await context.route('https://weibo.com/**',route=>{
  if(route.request().isNavigationRequest())return route.fulfill({contentType:'text/html;charset=utf-8',body:fixtureHTML});
  return route.fulfill({json:{ok:1}});
 });
 await context.newPage();
 const manager={context,owner:'runner',page:async()=>context.pages()[0]||context.newPage()};
 const adapter=new WeiboAdapter(manager);let closed=false;
 const originalFind=adapter.findStreamingComment.bind(adapter);
 adapter.findStreamingComment=async(page,target)=>{const result=await originalFind(page,target);if(!closed){closed=true;await page.close();}return result;};
 const r=await adapter.likeNextComment(account,link,options());
 assert.equal(r.state,'succeeded');
 const current=context.pages()[0];assert.deepEqual(await current.evaluate(()=>window.clicks),[1]);
 await context.close();
});
