import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright';

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'weibo-console-engage-replies-'));
process.env.WEIBO_CONSOLE_DATA_DIR = tempDir;
process.env.WEIBO_CONSOLE_LICENSE = 'off';
process.env.WEIBO_CONSOLE_TOPIC_MODE = 'general';

const { WeiboAdapter } = await import('../src/weibo-adapter.js');
const { readStreamingComments, visibleLikeState } = await import('../src/engage-dom.js');
const { createSnapshot } = await import('../src/runner.js');
const db = await import('../src/db.js');
const { normalizeEngageSettings, engageTemplateConfig } = await import('../public/defaults.js');

let browser;
test.before(async () => {
  const exe = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
  browser = await chromium.launch({ headless: true, ...(existsSync(exe) ? { executablePath: exe } : {}) });
});
test.after(async () => { await browser?.close(); });

const link = 'https://weibo.com/77/12345';
const account = { id: 'fixture', uid: '55' };

function pageHTML(comments) {
  return `<style>
body{margin:0}.detail{height:150px}.comment-item{padding:8px 0;border-bottom:1px solid #eee}.comment_text{margin:4px 0}.like{color:rgb(147,147,147);border:0;background:none}.liked{color:rgb(255,130,0)}.reply-item{margin-left:32px}#comments{margin-top:10px}
</style>
<div class="detail"><a href="/77/12345">时间</a><p>原微博</p><footer><button>转发</button><button>评论</button><button title="赞" class="like">99</button></footer></div>
<div id="composer"><textarea placeholder="发布你的评论"></textarea><button>评论</button></div>
<div id="comments">${comments}</div><div role="alert"></div>
<script>
window.clicks=[];window.expands=0;
function like(id,b){window.clicks.push(id);b.className='like liked';}
function expand(){window.expands++}
</script>`;
}

function row(id, uid, text, { reply = false, hidden = false, likedLabel = '', likedTitle = '赞', nickname = '', content = '', extra = '' } = {}) {
  const classes = 'comment-item' + (reply ? ' reply-item' : '');
  const style = hidden ? ' style="display:none"' : '';
  const button = likedLabel
    ? `<button title="${likedTitle}" aria-label="${likedLabel}" class="like"><i class="woo-font--like"></i></button>`
    : `<button title="赞" class="like" onclick="like('${id}',this)"><i class="woo-font--like"></i></button>`;
  return `<div class="${classes}"${style} data-comment-id="${id}"><a href="/u/${uid}">${nickname || `用户${uid}`}</a><div class="comment_text">${content || text}</div>${button}${extra}</div>`;
}

async function fixture(comments) {
  const page = await browser.newPage({ viewport: { width: 900, height: 1000 } });
  page.setDefaultTimeout(2000);
  await page.route('https://weibo.com/**', route => {
    if (route.request().isNavigationRequest()) return route.fulfill({ contentType: 'text/html;charset=utf-8', body: pageHTML(comments) });
    return route.fulfill({ json: { ok: 1 } });
  });
  const adapter = new WeiboAdapter({ page: async () => page });
  return { page, adapter };
}

const options = () => ({ onTarget: () => {}, onSubmit: () => {}, assertRunning: () => {} });

test('默认只认顶层评语：顶层五个被点，嵌套回复不点', async () => {
  const parents = [1, 2, 3, 4, 5].map(i => row('p' + i, 100 + i, '顶层' + i, {
    extra: `<div class="replies">${row('r' + i, 200 + i, '回复' + i, { reply: true })}</div>`
  })).join('');
  const f = await fixture(parents);
  await f.adapter.openWeibo(account, link);
  for (let i = 0; i < 5; i++) assert.equal((await f.adapter.likeNextComment(account, link, options())).state, 'succeeded');
  assert.deepEqual(await f.page.evaluate(() => window.clicks), ['p1', 'p2', 'p3', 'p4', 'p5']);
  assert.equal(await f.page.evaluate(() => window.expands), 0);
  await f.page.close();
});

test('勾选外显回复后按视觉顺序点父评与可见子回复；隐藏子与展开更多都不点', async () => {
  const comments = [
    row('p1', 101, '父1', { extra: `<div class="replies">${row('r1', 201, '子1', { reply: true })}${row('h1', 202, '隐藏子', { reply: true, hidden: true })}<button onclick="expand()">展开更多回复</button></div>` }),
    row('p2', 102, '父2', { extra: `<div class="replies">${row('r2', 203, '子2', { reply: true })}</div>` })
  ].join('');
  const f = await fixture(comments);
  await f.adapter.openWeibo(account, link);
  const rows = await readStreamingComments(f.page);
  assert.deepEqual(rows.map(r => [r.id, r.isReply]), [['p1', false], ['r1', true], ['p2', false], ['r2', true]]);
  assert.equal(rows[0].text, '父1');
  for (let i = 0; i < 4; i++) {
    const r = await f.adapter.likeNextComment(account, link, { ...options(), includeVisibleReplies: true });
    assert.equal(r.state, 'succeeded');
  }
  assert.deepEqual(await f.page.evaluate(() => window.clicks), ['p1', 'r1', 'p2', 'r2']);
  assert.equal(await f.page.evaluate(() => window.expands), 0);
  await f.page.close();
});

test('图片表情楼中楼按昵称识别，不因正文为空而漏扫', async () => {
  const comments = row('p1', 101, '父1', {
    extra: '<div class="list2">'
      + '<div class="con2"><div class="item2"><a href="/u/201">表情回复者</a><div class="comment_text"><img alt="[么么哒]"></div><button title="赞" class="like" onclick="like(\'e1\',this)"><i class="woo-font--like"></i></button></div></div>'
      + '<div class="con2"><div class="item2"><a href="/u/202">文字回复者</a><div class="comment_text">文字回复</div><button title="赞" class="like" onclick="like(\'e2\',this)"><i class="woo-font--like"></i></button></div></div>'
      + '</div>'
  });
  const f = await fixture(comments);
  await f.adapter.openWeibo(account, link);
  const rows = await readStreamingComments(f.page);
  assert.deepEqual(rows.map(r => [r.authorName, r.text, r.isReply]), [
    ['用户101', '父1', false],
    ['表情回复者', '[么么哒]', true],
    ['文字回复者', '文字回复', true]
  ]);
  assert.match(rows[1].key, /表情回复者/);
  assert.match(rows[2].key, /文字回复者/);
  for (let i = 0; i < 3; i++) {
    assert.equal((await f.adapter.likeNextComment(account, link, { ...options(), includeVisibleReplies: true })).state, 'succeeded');
  }
  assert.deepEqual(await f.page.evaluate(() => window.clicks), ['p1', 'e1', 'e2']);
  await f.page.close();
});

test('关键词只按父评自身文本判断，不被子回复命中而误点父评', async () => {
  const comments = row('p1', 101, '父评无关内容', {
    extra: `<div class="replies">${row('r1', 201, '这里支持目标', { reply: true })}</div>`
  });
  const f = await fixture(comments);
  await f.adapter.openWeibo(account, link);
  const r = await f.adapter.likeNextComment(account, link, { ...options(), keywords: ['支持目标'] });
  assert.equal(r.state, 'skipped');
  assert.deepEqual(await f.page.evaluate(() => window.clicks), []);
  await f.page.close();
});

test('title/aria 任一已赞均跳过；已赞父评下未赞子回复默认不点', async () => {
  const comments = row('p0', 100, '标题赞但 aria 取消赞', {
    likedLabel: '取消赞', likedTitle: '赞',
    extra: `<div class="replies">${row('r0', 200, '冲突项的子回复', { reply: true })}</div>`
  }) + row('p1', 101, '已赞父评', {
    likedLabel: '已赞',
    extra: `<div class="replies">${row('r1', 201, '已赞父评下未赞子回复', { reply: true })}</div>`
  }) + row('p2', 102, '未赞父评');
  const f = await fixture(comments);
  await f.adapter.openWeibo(account, link);
  const r = await f.adapter.likeNextComment(account, link, options());
  assert.equal(r.state, 'succeeded');
  assert.equal(r.targetId, 'p2');
  assert.deepEqual(await f.page.evaluate(() => window.clicks), ['p2']);
  await f.page.close();
});

test('同身份重复可见且另有视口外副本时不点击歧义项，只点唯一可辨认的评论', async () => {
  const comments = row('dup', 101, '重复评论') + row('dup', 101, '重复评论')
    + row('uniq', 102, '唯一评论') + '<div style="height:2200px"></div>' + row('dup', 101, '重复评论');
  const f = await fixture(comments);
  await f.adapter.openWeibo(account, link);
  const rows = await readStreamingComments(f.page);
  assert.ok(!rows.some(r => r.id === 'dup'));
  const r = await f.adapter.likeNextComment(account, link, options());
  assert.equal(r.state, 'succeeded');
  assert.equal(r.targetId, 'uniq');
  assert.deepEqual(await f.page.evaluate(() => window.clicks), ['uniq']);
  await f.page.close();
});
test('微博点赞按钮悬停变橙不算已赞，只有持久化已赞标记才跳过', async () => {
  const page = await browser.newPage({ viewport: { width: 900, height: 650 } });
  const html = `<style>
    .comment-item{padding:8px}.comment_text{margin:4px 0}
    .woo-like-main{background:none;border:0;color:rgb(128,128,128)}
    .woo-like-main:hover .woo-like-icon{color:rgb(255,130,0)}
  </style><div class="comment-item"><a href="/u/123">作者</a><div class="comment_text">悬停测试</div><div class="time">10:00</div><button class="woo-like-main" title="赞"><span class="woo-like-iconWrap"><svg class="woo-like-icon" width="20" height="20"><path fill="currentColor"></path></svg></span><span class="woo-like-count">1</span></button></div>`;
  await page.route('https://weibo.com/**', route => route.fulfill({ contentType: 'text/html;charset=utf-8', body: html }));
  await page.goto('https://weibo.com/77/12345');
  const button = page.locator('.woo-like-main');
  await button.hover();
  assert.equal(await visibleLikeState(button), false);
  assert.equal((await readStreamingComments(page, { viewportOnly: false }))[0].liked, false);
  await page.locator('.woo-like-count').evaluate(e => e.classList.add('woo-like-liked'));
  assert.equal(await visibleLikeState(button), true);
  assert.equal((await readStreamingComments(page, { viewportOnly: false }))[0].liked, true);
  await page.close();
});

test('内赞设置与模板：includeVisibleReplies 默认 false、显式 true 保留，快照与模板不丢字段', () => {
  assert.equal(normalizeEngageSettings().actionPlan.every(item => item.includeVisibleReplies === false), true);
  assert.deepEqual(normalizeEngageSettings({ actionPlan: [{ type: 'comment_like' }] }).actionPlan.map(item => item.includeVisibleReplies), [false]);
  assert.deepEqual(normalizeEngageSettings({ actionPlan: [{ type: 'comment_like', includeVisibleReplies: true }, { type: 'comment' }] }).actionPlan.map(item => item.includeVisibleReplies), [true, false]);

  db.clearAllDataForTests();
  const saved = normalizeEngageSettings({ actionPlan: [{ type: 'comment_like', includeVisibleReplies: true }, { type: 'repost' }] });
  db.setSetting('engage_defaults', saved);
  const snapshot = createSnapshot({ kind: 'engage', accountIds: [], links: [link] }, [], []);
  assert.deepEqual(snapshot.actionPlan.map(item => item.includeVisibleReplies), [true, false]);

  const template = engageTemplateConfig(db.getSetting('engage_defaults'));
  assert.deepEqual(template.actionPlan.map(item => item.includeVisibleReplies), [true, false]);
  assert.equal(template.accountIds, undefined);
  assert.equal(template.links, undefined);
});
