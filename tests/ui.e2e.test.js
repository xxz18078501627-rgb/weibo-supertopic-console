import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { chromium } from 'playwright';
import { WeiboAdapter, VerificationError } from '../src/weibo-adapter.js';
import { DatabaseSync } from 'node:sqlite';

const root = path.resolve(import.meta.dirname, '..');
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'weibo-console-ui-'));
const port = 43000 + Math.floor(Math.random() * 1000);
const token = 'e2e-test-token';
let server;
let browser;

test.before(async () => {
  server = spawn(process.execPath, ['src/server.js'], {
    cwd: root,
    env: { ...process.env, WEIBO_CONSOLE_NOTIFY: 'off', WEIBO_CONSOLE_LICENSE: 'off', WEIBO_CONSOLE_TOPIC_MODE: 'general', WEIBO_CONSOLE_DATA_DIR: tempDir, WEIBO_CONSOLE_PORT: String(port), WEIBO_CONSOLE_ACCESS_TOKEN: token },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  await waitForServer();
  const chrome = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
  browser = await chromium.launch({ headless: true, ...(process.env.WEIBO_CONSOLE_CHROME
    ? { executablePath: process.env.WEIBO_CONSOLE_CHROME }
    : fs.existsSync(chrome) ? { executablePath: chrome } : {}) });
});

test.after(async () => {
  await browser?.close();
  server?.kill('SIGTERM');
  fs.rmSync(tempDir, { recursive: true, force: true });
});

test('访问口令、配置流程和手机导航可用', async () => {
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  let loginRequests = 0;
  await page.route('**/api/accounts/*/login', route => {
    loginRequests += 1;
    return route.fulfill({ status: 202, contentType: 'application/json', body: JSON.stringify({ phase: 'waiting' }) });
  });
  await page.goto(`http://127.0.0.1:${port}`);
  await page.locator('#token').fill(token);
  await page.getByRole('button', { name: '进入工坊' }).click();
  await page.locator('#nav [data-page="accounts"]').click();
  assert.equal(await page.locator('#account-name').count(), 0);
  await page.getByRole('button', { name: '添加账号并扫码登录' }).click();
  await page.waitForFunction(() => document.querySelectorAll('#account-list .list-row').length === 1);
  await page.waitForTimeout(200);
  assert.equal(loginRequests, 1);
  assert.equal(await page.locator('#qr-dialog').count(), 0);
  assert.equal(await page.getByRole('button', { name: '检查登录', exact: true }).count(), 0);

  await page.locator('#nav [data-page="materials"]').click();
  assert.equal(await page.locator('#material-account').count(), 0);
  await page.locator('#material-texts').fill('发帖甲\n发帖乙');
  await page.locator('#material-add').click();
  await page.locator('[data-material-tab="comment"]').click();
  await page.locator('#material-texts').fill('评论甲\n评论乙');
  await page.locator('#material-add').click();
  await page.waitForFunction(() => document.querySelector('#comment-count')?.textContent === '2');
  assert.equal((await page.request.get(`http://127.0.0.1:${port}/api/post-materials`).then(r => r.json())).length, 2);

  await page.setViewportSize({ width: 390, height: 844 });
  assert.equal(await page.locator('#mobile-nav').isVisible(), true);
  assert.equal(await page.locator('.sidebar').isVisible(), false);
  await page.locator('#mobile-nav').getByRole('button', { name: '超话工作台' }).click();
  await page.locator('.config-tabs [data-pane="advanced"]').click();
  await page.locator('#sync-to-home').waitFor();
  await page.locator('#sync-to-home').check();
  await page.locator('#post-decoration-mode').selectOption('emoji-and-number');
  await page.locator('#post-emoji-position').selectOption('prefix');
  await page.locator('#comment-decoration-mode').selectOption('number');
  await page.getByRole('button', { name: '设为默认', exact: true }).click();
  await page.waitForTimeout(150);
  const state = await page.request.get(`http://127.0.0.1:${port}/api/state`).then(r => r.json());
  assert.equal(state.taskDefaults.postDecoration.mode, 'emoji-and-number');
  assert.equal(state.taskDefaults.postDecoration.emojiPosition, 'prefix');
  assert.equal(state.taskDefaults.commentDecoration.mode, 'number');
  assert.equal(state.taskDefaults.syncToHome, true);
  assert.equal(state.taskDefaults.postDecoration.emojis.length, 24);
  await page.reload();
  await page.locator('#mobile-nav [data-page="overview"]').click();
  assert.equal(await page.locator('#sync-to-home').isChecked(), true);
  await page.locator('#mobile-nav [data-page="accounts"]').click();
  await page.getByRole('button', {name:'全选', exact:true}).click();
  await page.locator('[data-bulk-accounts="disable"]').click();
    await page.waitForFunction(() => document.querySelector('#toast')?.textContent.includes('已停用'));
    assert.equal(await page.locator('#account-operation-results').count(), 0);
  await page.locator('#mobile-nav [data-page="materials"]').click();
  await page.waitForFunction(() => document.querySelector('#post-count')?.textContent === '2');
  await page.close();
});

test('更新弹窗展示平台版本和只读命令，关闭重启开关可切换命令，手机可进入', async () => {
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  await page.route('**/api/update/status*', route => route.fulfill({ json: {
    currentVersion: '1.1.0', latestVersion: '1.2.0', platformKey: 'mac-arm64', available: true,
    downloaded: true, checkedAt: new Date().toISOString(), blockedReason: '',
    command: 'node "/tmp/ZhibingStudio/bootstrap.mjs" update --platform mac-arm64 --version 1.2.0 --restart',
    commandNoRestart: 'node "/tmp/ZhibingStudio/bootstrap.mjs" update --platform mac-arm64 --version 1.2.0 --no-restart',
    release: { notes: '新增应用内更新。' }
  } }));
  await page.context().grantPermissions(['clipboard-read', 'clipboard-write'], { origin: `http://127.0.0.1:${port}` });
  await page.goto(`http://127.0.0.1:${port}`);
  await page.locator('#token').fill(token);
  await page.getByRole('button', { name: '进入工坊' }).click();
  await page.locator('#update-entry').click();
  await page.locator('#update-dialog').waitFor({ state: 'visible' });
  await page.waitForFunction(() => document.querySelector('#update-latest')?.textContent === 'v1.2.0');
  assert.equal(await page.locator('#update-latest').textContent(), 'v1.2.0');
  assert.equal(await page.locator('#update-platform').textContent(), 'mac-arm64');
  assert.match(await page.locator('#update-command').inputValue(), /--restart$/);
  await page.locator('#update-restart-toggle').uncheck();
  assert.match(await page.locator('#update-command').inputValue(), /--no-restart$/);
  await page.locator('#update-copy').click();
  assert.match(await page.evaluate(() => navigator.clipboard.readText()), /--no-restart$/);
  await page.locator('[data-close-update]').click();
  await page.setViewportSize({ width: 390, height: 844 });
  await page.locator('#update-entry-mobile').click();
  assert.equal(await page.locator('#update-dialog').isVisible(), true);
  await page.close();
});

test('发帖拒绝后延迟验证码进入验证，人工完成后原窗口自动回执且只点一次发送', async () => {
  const page = await browser.newPage();
  let sends = 0, posted = null;
  await page.route('https://weibo.com/**', async route => {
    const url = new URL(route.request().url());
    if (url.pathname === '/ajax/stopic/list') return route.fulfill({ json: { data: [{ title: '苏新皓', page_id: '100808fixture' }] } });
    if (url.pathname === '/ajax/statuses/update') {
      sends++;
      return route.fulfill({ status: sends === 1 ? 400 : 200, json: sends === 1 ? { ok: 0, error_code: 20067, message: 'For your safety, please verify your account', validate: { exception_key: '[fixture]', challenge: '[fixture]', alitest: {} } } : { ok: 1, data: { idstr: '5359362629435909' } } });
    }
    return route.fulfill({ contentType: 'text/html; charset=utf-8', body: `<button>更多</button><button>超话</button>
      <div class="woo-modal-wrap"><button>选择超话</button><input placeholder="搜索超话" oninput="fetch('/ajax/stopic/list')">
      <div class="_h3_fixture" onclick="document.querySelector('textarea').value='苏新皓[超话]'">苏新皓</div>
      <textarea placeholder="掐指一算，此贴必火"></textarea><label><input type="checkbox">同步到微博</label>
      <button onclick="fetch('/ajax/statuses/update',{method:'POST',body:JSON.stringify({status:document.querySelector('textarea').value,page_id:'100808fixture'})});setTimeout(()=>document.querySelector('#captcha').style.display='block',300)">发送</button></div>
      <div id="captcha" class="geetest_panel" style="display:none">请完成安全验证<button onclick="this.parentElement.style.display='none';fetch('/ajax/statuses/update',{method:'POST',body:JSON.stringify({status:document.querySelector('textarea').value,page_id:'100808fixture'})})">验证通过</button></div>` });
  });
  const manager = { page: async () => page, context: page.context(), foreground: async () => {} };
  const adapter = new WeiboAdapter(manager); adapter.ensureIdentity = async () => ({});
  try {
    await assert.rejects(adapter.withChallengeMode('manual', () => adapter.post({ id: 'fixture', uid: '1001' }, { name: '苏新皓', url: 'https://weibo.com/p/100808fixture' }, '本次文案1', { intervalSeconds: 1, onReceipt: result => { posted = result; } })), error => error.code === 'verification_required');
    assert.equal(sends, 1);
    await page.getByRole('button', { name: '验证通过', exact: true }).click();
    // Wait for durable asynchronous receipt handling, not an arbitrary 100ms.
    for (let attempt=0; attempt<100 && !posted; attempt++) await page.waitForTimeout(50);
    assert.ok(posted, '人工验证后的本次回执应自动保存');
    assert.equal(posted.receiptId, '5359362629435909');
    assert.equal(posted.state, 'succeeded');
    assert.equal(sends, 2, '第二个请求由验证码完成触发，没有再次点击发送');
  } finally { await page.close(); }
});

test('实测易盾组件可见时识别验证，隐藏组件不阻止任务', async () => {
  const page = await browser.newPage();
  await page.setContent('<div class="yidun_modal__wrap" style="display:none"><div class="yidun_control">加载中...</div></div>');
  const adapter = new WeiboAdapter({ page: async () => page, context: page.context() });
  assert.equal(await adapter.hasTaskChallenge({}), false);
  await page.locator('.yidun_modal__wrap').evaluate(node => node.style.display = 'block');
  assert.equal(await adapter.hasTaskChallenge({}), true);
  await page.close();
});

test('HTTP400后延迟成功回执仍成功，零任务间隔不会提前关闭监听', async () => {
  const page = await browser.newPage(); let requests = 0;
  await installPostFixture(page, async route => {
    requests++;
    return route.fulfill({ status: requests === 1 ? 400 : 200, json: requests === 1
      ? { ok: 0, message: '临时响应异常' } : { ok: 1, data: { idstr: '5359362629435909' } } });
  }, true);
  const adapter = new WeiboAdapter({ page: async () => page, context: page.context() });
  adapter.ensureIdentity = async () => {};
  try {
    const result = await adapter.post({ id: 'fixture', uid: '1001' }, { name: '苏新皓', url: 'https://weibo.com/p/100808fixture' }, '本次正文', { intervalSeconds: 0, receiptTimeoutMs: 1000 });
    assert.equal(result.state, 'succeeded'); assert.equal(result.receiptId, '5359362629435909');
    assert.equal(await page.evaluate(() => window.sendClicks), 1);
    assert.equal(requests, 2);
  } finally { await page.close(); }
});

test('只有HTTP400且无明确业务拒绝时保持待核对，主动只读复核仍可用', async () => {
  const page = await browser.newPage(); let requests = 0;
  const startedAt = new Date().toISOString();
  await installPostFixture(page, route => {
    requests++; return route.fulfill({ status: 400, json: {} });
  });
  const adapter = new WeiboAdapter({ page: async () => page, context: page.context() });
  adapter.ensureIdentity = async () => {};
  try {
    const topic = { name: '苏新皓', url: 'https://weibo.com/p/100808fixture' };
    const result = await adapter.post({ id: 'fixture', uid: '1001' }, topic, '本次正文', { receiptTimeoutMs: 100 });
    assert.equal(result.state, 'uncertain'); assert.equal(result.needsReadback, undefined);
    const found = await adapter.findPublishedPost({ uid: '1001' }, { content: '本次正文', topic, startedAt, submittedAt: startedAt });
    assert.equal(found.state, 'succeeded'); assert.equal(found.receiptId, '5359362629435909');
    assert.equal(requests, 1);
  } finally { await page.close(); }
});

async function installPostFixture(page, update, delayedSuccess = false) {
  await page.route('https://weibo.com/**', route => {
    const url = new URL(route.request().url());
    if (url.pathname === '/ajax/stopic/list') return route.fulfill({ json: { data: [{ title: '苏新皓', page_id: '100808fixture' }] } });
    if (url.pathname === '/ajax/statuses/update') return update(route);
    if (url.pathname === '/ajax_proxy/chaohua/page') return route.fulfill({ json: { items: [{ idstr: '5359362629435909',
      user: { idstr: '1001' }, text_raw: '苏新皓[超话]本次正文', created_at: new Date().toISOString() }] } });
    if (url.pathname.startsWith('/p/')) return route.fulfill({ contentType: 'text/html', body: '<div id="list"></div><script>fetch(\'/ajax_proxy/chaohua/page\')</script>' });
    return route.fulfill({ contentType: 'text/html; charset=utf-8', body: `<button>更多</button><button>超话</button>
      <div class="woo-modal-wrap"><button>选择超话</button><input placeholder="搜索超话" oninput="fetch('/ajax/stopic/list')">
      <div class="_h3_fixture" onclick="document.querySelector('textarea').value='苏新皓[超话]'">苏新皓</div>
      <textarea placeholder="掐指一算，此贴必火"></textarea><label><input type="checkbox">同步到微博</label>
      <button onclick="window.sendClicks=(window.sendClicks||0)+1;const send=()=>fetch('/ajax/statuses/update',{method:'POST',body:JSON.stringify({status:document.querySelector('textarea').value,page_id:'100808fixture'})});send();${delayedSuccess ? 'setTimeout(send,50);' : ''}">发送</button></div>` });
  });
}

test('发帖明确成功可无编号，HTTP200本身和旧提示不能算成功', async () => {
  for (const mode of ['api', 'notice', 'stale', 'plain']) {
    const page = await browser.newPage(); let sends = 0, navigations = 0;
    await installPostFixture(page, route => {
      sends++;
      return route.fulfill({ json: mode === 'api' ? { ok: 1 } : {} });
    });
    const manager = { page: async () => page, context: page.context() };
    const adapter = new WeiboAdapter(manager); adapter.ensureIdentity = async () => {};
    const original = adapter.post.bind(adapter);
    // Add notices through actual DOM mutations triggered by this click, using
    // the same renderer as the live adapter. No real network is permitted.
    await page.addInitScript(kind => {
      window.addEventListener('DOMContentLoaded', () => {
        if (kind === 'stale') { const notice = document.createElement('div'); notice.setAttribute('role', 'status'); notice.textContent = '发布成功'; document.body.append(notice); }
        document.addEventListener('click', event => {
          if (event.target?.textContent !== '发送') return;
          if (kind === 'notice') {
            const notice = document.createElement('div'); notice.className = 'woo-message'; notice.textContent = '发送成功'; document.body.append(notice);
          }
        });
      });
    }, mode);
    page.on('framenavigated', frame => { if (frame === page.mainFrame()) navigations++; });
    try {
      const result = await original({ id: 'fixture', uid: '1001' }, { name: '苏新皓', url: 'https://weibo.com/p/100808fixture' }, '正文含有发布成功这几个字', { receiptTimeoutMs: 500 });
      assert.equal(result.state, ['api', 'notice'].includes(mode) ? 'succeeded' : 'uncertain', mode);
      if (result.state === 'succeeded') {
        assert.equal(result.receiptId, null); assert.equal(result.url, null);
        assert.equal(result.successSource, mode === 'api' ? 'api_receipt' : 'page_notice');
      }
      assert.equal(sends, 1); assert.equal(navigations, 1);
    } finally { await page.close(); }
  }
});

test('超时边缘才读出验证码回执，人工随后出现成功提示仍保存本次成功', async () => {
  const page = await browser.newPage(); const receipts = [];
  await installPostFixture(page, route => route.fulfill({ status: 400,
    json: { ok: 0, error_code: 20067, message: '请完成安全验证' } }));
  const delayBody = response => {
    if (new URL(response.url()).pathname !== '/ajax/statuses/update') return;
    const read = response.json.bind(response);
    // Hold an admitted response until the collector actually expires. Fixed
    // 80/180ms sleeps could expire before Chrome had even sent the request.
    response.json = async () => {
      while (page.context().listenerCount('response') > baselineListeners) {
        await new Promise(resolve => setTimeout(resolve, 10));
      }
      return read();
    };
  };
  page.context().on('response', delayBody);
  const baselineListeners = page.context().listenerCount('response');
  const receiptSaved = Promise.withResolvers();
  const adapter = new WeiboAdapter({ page: async () => page, context: page.context() });
  adapter.ensureIdentity = async () => {};
  try {
    await assert.rejects(adapter.withChallengeMode('manual', () => adapter.post({ id: 'fixture', uid: '1001' },
      { name: '苏新皓', url: 'https://weibo.com/p/100808fixture' }, '本次正文',
      { receiptTimeoutMs: 1000, onReceipt: receipt => { receipts.push(receipt); receiptSaved.resolve(); } })), error => error.code === 'verification_required');
    await page.evaluate(() => { const notice = document.createElement('div'); notice.setAttribute('role', 'status'); notice.textContent = '发布成功'; document.body.append(notice); });
    let saveTimer;
    try {
      await Promise.race([receiptSaved.promise, new Promise((_, reject) => {
        saveTimer = setTimeout(() => reject(new Error('人工验证后的成功提示未保存')), 5000);
      })]);
    } finally { clearTimeout(saveTimer); }
    assert.equal(receipts.length, 1); assert.equal(receipts[0].successSource, 'page_notice');
    assert.equal(await page.evaluate(() => window.sendClicks), 1);
  } finally { await adapter.manualPostReceipt?.stop(); page.context().off('response', delayBody); await page.close(); }
});

test('人工发帖续发的成功提示保存失败会通过read传播，且不再次发送', async () => {
  const page = await browser.newPage();
  await installPostFixture(page, route => route.fulfill({ status: 400,
    json: { ok: 0, error_code: 20067, message: '请完成安全验证' } }));
  const adapter = new WeiboAdapter({ page: async () => page, context: page.context() });
  adapter.ensureIdentity = async () => {};
  try {
    await assert.rejects(adapter.withChallengeMode('manual', () => adapter.post({ id: 'fixture', uid: '1001' },
      { name: '苏新皓', url: 'https://weibo.com/p/100808fixture' }, '本次正文',
      { onReceipt: () => { throw new Error('模拟保存失败'); } })), error => error.code === 'verification_required');
    await page.evaluate(() => {
      const notice = document.createElement('div'); notice.setAttribute('role', 'status');
      notice.textContent = '发布成功'; document.body.append(notice);
    });
    await assert.rejects(adapter.manualPostReceipt.read(), error => error.code === 'receipt_persistence_failed');
    assert.equal(await page.evaluate(() => window.sendClicks), 1);
  } finally { await adapter.manualPostReceipt?.stop(); await page.close(); }
});

test('连通性探测使用Chrome网络，断网返回离线且不导航任务页面', async () => {
  const context = await browser.newContext(); const page = await context.newPage();
  const url = `http://127.0.0.1:${port}/api/session`;
  await page.goto(`http://127.0.0.1:${port}/`);
  const before = page.url();
  const adapter = new WeiboAdapter({ context });
  try {
    assert.equal((await adapter.probeConnectivity({}, { url })).state, 'online');
    await context.setOffline(true);
    assert.equal((await adapter.probeConnectivity({}, { url })).state, 'offline');
    await context.setOffline(false);
    assert.equal((await adapter.probeConnectivity({}, { url })).state, 'online');
    assert.equal(page.url(), before);
  } finally { await context.close(); }
});

test('网络三态提示、状态乱序、前台重同步及实时断线后的只读刷新', async () => {
  const page = await browser.newPage();
  try {
    await page.request.post(`http://127.0.0.1:${port}/api/login`, { data: { token } });
    const base = await page.request.get(`http://127.0.0.1:${port}/api/state`).then(r => r.json());
    const stamp = new Date().toISOString();
    const current = { round: 0, topicId: 't', accountId: 'a', segmentId: 's', unitIndex: 0, kind: 'comment', topicName: '测试超话', accountName: '测试账号' };
    const job = { id: 'network-ui-fixture', status: 'paused', pausedByUser: false, created_at: stamp, metrics: {}, config: { rounds: 1 }, wait_reason: '网络中断，任务已自动暂停', cursor: { current, networkRecovery: { state: 'offline', lastCheckedAt: stamp, successes: 0 } } };
    let payload = { ...base, activeJob: job, recentJobs: [job], verification: null, stateVersion: 1000 };
    let gets = 0;
    await page.route('**/api/state', route => { gets++; return route.fulfill({ json: payload }); });
    await page.addInitScript(() => {
      window.EventSource = class extends EventTarget {
        constructor() { super(); window.testEvents = this; queueMicrotask(() => this.onopen?.()); }
        close() {}
        emit(type, payload) { this.dispatchEvent(new MessageEvent(type, { data: JSON.stringify(payload) })); }
      };
    });
    await page.goto(`http://127.0.0.1:${port}`);
    await page.locator('#run-detail').waitFor();
    assert.match(await page.locator('#run-detail').innerText(), /网络中断/);
    await page.waitForFunction(() => typeof window.testEvents?.onerror === 'function');
    job.status = 'running'; job.wait_reason = null;
    job.cursor.networkRecovery = { state: 'online', probeState: 'unknown', lastCheckedAt: stamp, lastProbe: { code: 'PROBE_CONTEXT_CHANGED' } };
    payload = { ...payload, stateVersion: 1001 };
    await page.evaluate(data => window.testEvents.emit('state', data), payload);
    assert.match(await page.locator('#run-detail').innerText(), /尚未确认断网|网络检测暂不可用/);
    job.status = 'waiting'; job.wait_reason = '扫描 30 条；本轮发帖人避让 17 条，已达20评 2 条';
    job.cursor.commentScan = { stepKey: '0:t:a:s:0', scanned: 30, rejectedAuthor: 17, countLimit: 2 };
    job.cursor.networkRecovery = { state: 'online', probeState: 'online', lastCheckedAt: stamp };
    payload = { ...payload, stateVersion: 1002 };
    await page.evaluate(data => window.testEvents.emit('state', data), payload);
    assert.match(await page.locator('#run-detail').innerText(), /网络正常，正在筛选评论目标/);
    assert.match(await page.locator('#run-headline').innerText(), /本轮发帖人避让 17 条/);
    const old = structuredClone(payload); old.stateVersion = 1001; old.activeJob.status = 'paused'; old.activeJob.cursor.networkRecovery.state = 'offline';
    await page.evaluate(data => window.testEvents.emit('state', data), old);
    assert.match(await page.locator('#run-detail').innerText(), /网络正常/);
    // A visibility event must fetch the latest state without touching drafts.
    payload = { ...payload, stateVersion: 1003, activeJob: { ...job, status: 'running', wait_reason: '重新同步成功' } };
    const beforeFocus = gets;
    await page.evaluate(() => window.dispatchEvent(new Event('focus')));
    await page.waitForFunction(() => document.querySelector('#run-headline').textContent === '重新同步成功');
    assert.ok(gets > beforeFocus);
    payload = { ...payload, stateVersion: 1004, activeJob: { ...payload.activeJob, wait_reason: '备用轮询成功' } };
    await page.evaluate(() => window.testEvents.onerror());
    await page.waitForFunction(() => document.querySelector('#run-headline').textContent === '备用轮询成功', null, { timeout: 12000 });
    assert.match(await page.locator('#run-detail').innerText(), /网络正常/);
    await page.setViewportSize({ width: 390, height: 844 });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  } finally { await page.close(); }
});

test('每段间隔默认正确，自定义、排序、保存和模板切换在桌面及手机可用', async () => {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  await page.request.post(`http://127.0.0.1:${port}/api/login`, { data: { token } });
  const original = await page.request.get(`http://127.0.0.1:${port}/api/state`).then(r => r.json());
  let templateId;
  try {
    await page.request.put(`http://127.0.0.1:${port}/api/settings/task`, { data: { ...original.taskDefaults, actionPlan: [{ type: 'checkin', count: 1 }, { type: 'post', count: 2 }, { type: 'comment', count: 1 }], actionIntervalSeconds: 3 } });
    await page.goto(`http://127.0.0.1:${port}`);
    await page.locator('.config-tabs [data-pane="plan"]').click();
    await page.locator('[data-plan-interval="0"]').waitFor();
    assert.deepEqual(await page.locator('[data-plan-interval]').evaluateAll(nodes => nodes.map(n => n.value)), ['5', '10', '3']);
    assert.equal(await page.locator('#checkin-interval,#post-interval,#comment-interval').count(), 0);
  await page.locator('.config-tabs [data-pane="plan"]').click();
    await page.locator('[data-plan-interval="1"]').fill('0');
    await page.locator('#add-action').click();
    await page.locator('[data-plan-type="3"]').selectOption('post');
    assert.equal(await page.locator('[data-plan-interval="3"]').inputValue(), '10');
  await page.locator('.config-tabs [data-pane="plan"]').click();
    await page.locator('[data-plan-interval="3"]').fill('20');
    const dragCard = page.locator('.action-card[data-index="3"]');
    const dragBox = await dragCard.locator('.drag-handle').boundingBox();
    await page.mouse.move(dragBox.x + dragBox.width / 2, dragBox.y + dragBox.height / 2);
    await page.mouse.down();
    await page.mouse.move(dragBox.x - 300, dragBox.y + dragBox.height / 2, { steps: 8 });
    await page.mouse.up();
    await page.waitForTimeout(150);
    assert.equal(await page.locator('[data-plan-interval="2"]').inputValue(), '20');
    await page.locator('.config-tabs [data-pane="advanced"]').click();
  await page.locator('#save-task').click();
    await page.waitForFunction(() => document.querySelector('#toast')?.textContent === '设置已保存');
    await page.reload();
    await page.locator('.config-tabs [data-pane="plan"]').click();
    await page.locator('[data-plan-interval="0"]').waitFor();
    assert.deepEqual(await page.locator('[data-plan-interval]').evaluateAll(nodes => nodes.map(n => n.value)), ['5', '0', '20', '3']);
    const saved = await page.request.get(`http://127.0.0.1:${port}/api/state`).then(r => r.json());
    const response = await page.request.post(`http://127.0.0.1:${port}/api/task-templates`, { data: { name: '逐段间隔', config: saved.taskDefaults } });
    const template = await response.json(); templateId = template.id;
    await page.reload();
  await page.locator('.config-tabs [data-pane="advanced"]').click();
    await page.locator('#template-select').selectOption(templateId);
    await page.locator('.config-tabs [data-pane="plan"]').click();
    assert.deepEqual(await page.locator('[data-plan-interval]').evaluateAll(nodes => nodes.map(n => n.value)), ['5', '0', '20', '3']);
    for (const width of [1440, 390]) {
      await page.setViewportSize({ width, height: 1000 });
      assert.equal(await page.locator('[data-plan-interval="2"]').isVisible(), true);
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    }
  } finally {
    if (templateId) await page.request.delete(`http://127.0.0.1:${port}/api/task-templates/${templateId}`);
    await page.request.put(`http://127.0.0.1:${port}/api/settings/task`, { data: original.taskDefaults });
    await page.close();
  }
});

test('普通短信验证码登录框不误判为安全验证，真实验证弹窗会识别', async () => {
  const page = await browser.newPage();
  try {
    await page.setContent('<h1>扫描二维码登录</h1><input placeholder="请输入验证码"><button>验证码登录</button>');
    const adapter = new WeiboAdapter({});
    assert.equal(await adapter.loginChallenge(page), false);
    await page.setContent('<div role="dialog">请完成安全验证</div>');
    assert.equal(await adapter.loginChallenge(page), true);
  } finally { await page.close(); }
});

test('批量删除逐项返回结果，未结束任务占用的账号不能删除', async () => {
  const page = await browser.newPage();
  await page.goto(`http://127.0.0.1:${port}`);
  await page.request.post(`http://127.0.0.1:${port}/api/login`, {data:{token}});
  const first = await page.request.post(`http://127.0.0.1:${port}/api/accounts`, {data:{}}).then(r=>r.json());
  const second = await page.request.post(`http://127.0.0.1:${port}/api/accounts`, {data:{}}).then(r=>r.json());
  const db = new DatabaseSync(path.join(tempDir, 'console.sqlite'));
  const stamp = new Date().toISOString();
  db.prepare('INSERT INTO jobs(id,status,config_json,cursor_json,metrics_json,created_at,updated_at) VALUES(?,?,?,?,?,?,?)').run('busy-test','paused',JSON.stringify({accountIds:[first.id]}),'{}','{}',stamp,stamp);
  const conflict = await page.request.post(`http://127.0.0.1:${port}/api/jobs`, {data:{}});
  assert.equal(conflict.status(), 409);
  assert.match((await conflict.json()).error, /已有未结束任务/);
  const result = await page.request.post(`http://127.0.0.1:${port}/api/accounts/bulk`, {data:{ids:[first.id,second.id],action:'delete'}}).then(r=>r.json());
  assert.equal(result.results[0].ok, false);
  assert.match(result.results[0].error, /未结束/);
  assert.equal(result.results[1].ok, true);
  assert.equal(fs.existsSync(path.join(tempDir,'profiles',second.id)), false);
  db.prepare("UPDATE jobs SET status='stopped' WHERE id='busy-test'").run();
  db.close();
  await page.close();
});

test('签到只读取签到控件，普通页面文字不计为成功', async () => {
  const page = await browser.newPage();
  try {
    await page.setContent('<article>连续签到 已签到</article><div class="_signBtn">签到</div>');
    const adapter = new WeiboAdapter({});
    adapter.pageFor = async () => page;
    const result = await adapter.checkin({}, {});
    assert.equal(result.state, 'uncertain');
    await page.setContent('<article>连续签到</article><div class="_signBtn">已签到</div>');
    assert.equal((await adapter.checkin({}, {})).alreadyDone, true);
  } finally { await page.close(); }
});

test('评论须回读匹配编号、作者和内容，输入框内容不算成功', async () => {
  const page = await browser.newPage();
  let reads = 0;
  await page.route('https://weibo.com/**', route => {
    const url = route.request().url();
    if (url.includes('/ajax/comments/create')) return route.fulfill({json:{data:{idstr:'456'}}});
    if (url.includes('/ajax/statuses/buildComments')) { reads += 1; return route.fulfill({json:{data:[{idstr:'456',user:{idstr:'999'},text_raw:'测试评论'}]}}); }
    return route.fulfill({contentType:'text/html; charset=utf-8',body:`<div><div><div><textarea placeholder="发布你的评论"></textarea><button onclick="fetch('/ajax/comments/create',{method:'POST'})">评论</button></div></div></div><div class="item" onclick="this.classList.add('curr')">按倒序</div><article>测试评论 验证码</article>`});
  });
  try {
    const adapter = new WeiboAdapter({page:async()=>page});
    const candidate = {id:'789',url:'https://weibo.com/detail/789'};
    page.waitForTimeout = async () => {};
    assert.equal((await adapter.comment({uid:'123'},candidate,'测试评论')).state,'uncertain');
    assert.equal(reads,4);
  } finally { await page.close(); }
});

test('普通评论接口已精确读到新评论时直接成功，不依赖按倒序入口', async () => {
  const page = await browser.newPage();
  let reads = 0;
  await page.route('https://weibo.com/**', route => {
    const url = route.request().url();
    if (url.includes('/ajax/comments/create')) return route.fulfill({ json: { data: { idstr: 'comment-456' } } });
    if (url.includes('/ajax/statuses/buildComments')) {
      reads += 1;
      return route.fulfill({ json: { data: [{ idstr: 'comment-456', user: { idstr: '123' }, text_raw: '测试评论' }] } });
    }
    return route.fulfill({ contentType: 'text/html; charset=utf-8', body: '<div><div><div><textarea placeholder="发布你的评论"></textarea><button onclick="fetch(\'/ajax/comments/create\',{method:\'POST\'})">评论</button></div></div></div>' });
  });
  try {
    const adapter = new WeiboAdapter({ page: async () => page });
    page.waitForTimeout = async () => {};
    const result = await adapter.comment({ uid: '123' }, { id: '789', url: 'https://weibo.com/detail/789' }, '测试评论');
    assert.equal(result.state, 'succeeded');
    assert.equal(result.verificationMethod, 'default_comment_readback');
    assert.equal(reads, 1);
  } finally { await page.close(); }
});

test('评论成功提示无须编号直接成功，且不调用verifyComment或翻评论列表', async () => {
  const page = await browser.newPage();
  let createRequests = 0, readRequests = 0, receipts = 0;
  await page.route('https://weibo.com/**', route => {
    const url = new URL(route.request().url());
    if (url.pathname === '/ajax/comments/create') {
      createRequests += 1;
      return route.fulfill({ json: { ok: 1, data: {} } });
    }
    if (url.pathname === '/ajax/statuses/buildComments') {
      readRequests += 1;
      return route.fulfill({ json: { data: [] } });
    }
    return route.fulfill({ contentType: 'text/html; charset=utf-8', body: `<div><div><div>
      <textarea placeholder="发布你的评论"></textarea>
      <button onclick="window.commentClicks=(window.commentClicks||0)+1;fetch('/ajax/comments/create',{method:'POST'}).then(()=>{const notice=document.createElement('div');notice.setAttribute('role','status');notice.textContent='评论成功';document.body.append(notice)})">评论</button>
    </div></div></div>` });
  });
  try {
    const adapter = new WeiboAdapter({ page: async () => page, context: page.context() });
    adapter.ensureIdentity = async () => { throw new Error('评论成功提示不应读取身份'); };
    adapter.verifyComment = async () => { throw new Error('评论成功提示不应回读评论列表'); };
    const account = { uid: '1001', nickname: '测试账号' };
    const candidate = { id: '5359362629435909', url: 'https://weibo.com/1001/5359362629435909' };
    const result = await adapter.comment(account, candidate, '新评论文案', { onReceipt: receipt => { receipts += 1; assert.equal(receipt.successSource, 'page_notice'); } });
    assert.equal(result.state, 'succeeded');
    assert.equal(result.successSource, 'page_notice');
    assert.equal(result.receiptId, null);
    assert.equal(receipts, 1);
    assert.equal(createRequests, 1);
    assert.equal(readRequests, 0);
    assert.equal(await page.evaluate(() => window.commentClicks), 1);
  } finally { await page.close(); }
});

test('评论验证码中断后人工通过原请求自动续发，提示成功且只保存一次回执', async () => {
  const page = await browser.newPage();
  let createRequests = 0, receipts = 0;
  await page.route('https://weibo.com/**', route => {
    const url = new URL(route.request().url());
    if (url.pathname === '/ajax/comments/create') {
      createRequests += 1;
      return route.fulfill(createRequests === 1
        ? { status: 400, json: { ok: 0, error_code: 20067, message: '请完成安全验证' } }
        : { json: { ok: 1, data: {} } });
    }
    if (url.pathname === '/ajax/statuses/buildComments') return route.fulfill({ json: { data: [] } });
    return route.fulfill({ contentType: 'text/html; charset=utf-8', body: `<div><div><div>
      <textarea placeholder="发布你的评论"></textarea>
      <button onclick="window.commentClicks=(window.commentClicks||0)+1;window.sendComment(false);setTimeout(()=>{document.querySelector('#captcha').style.display='block'},300)">评论</button>
    </div></div></div>
    <div id="captcha" class="geetest_panel" style="display:none">请完成安全验证<button onclick="this.parentElement.style.display='none';window.sendComment(true)">验证通过</button></div>
    <script>window.sendComment=(verified)=>fetch('/ajax/comments/create',{method:'POST'}).then(response=>{if(!verified||!response.ok)return;const notice=document.createElement('div');notice.className='toast';notice.textContent='评论成功';document.body.append(notice)});</script>` });
  });
  const adapter = new WeiboAdapter({ page: async () => page, context: page.context(), foreground: async () => {} });
  try {
    adapter.verifyComment = async () => { throw new Error('评论成功提示不应回读评论列表'); };
    const account = { uid: '1001', nickname: '测试账号' };
    const candidate = { id: '5359362629435909', url: 'https://weibo.com/1001/5359362629435909' };
    await assert.rejects(adapter.withChallengeMode('manual', () => adapter.comment(account, candidate, '验证码评论文案', {
      onReceipt: () => { receipts += 1; }
    })), error => error instanceof VerificationError && error.code === 'verification_required');
    assert.equal(createRequests, 1);
    assert.equal(await page.evaluate(() => window.commentClicks), 1);
    await page.getByRole('button', { name: '验证通过', exact: true }).click();
    await page.waitForTimeout(400);
    assert.equal(createRequests, 2, '验证通过触发的续发请求，没有再次点击评论');
    assert.equal(receipts, 1);
    assert.equal(await page.evaluate(() => window.commentClicks), 1);
    assert.equal(await page.locator('.toast').innerText(), '评论成功');
  } finally { await adapter.manualCommentReceipt?.stop(); await page.close(); }
});

test('默认读取未命中后切到倒序，短编号换成数字 ID 并按 1、3 秒回读', async () => {
  const page = await browser.newPage();
  let reads = 0;
  const delays = [];
  await page.route('https://weibo.com/detail/**', route => route.fulfill({contentType:'text/html; charset=utf-8',body:`<div><div><div><textarea placeholder="发布你的评论"></textarea><button onclick="fetch('/ajax/comments/create',{method:'POST'})">评论</button></div></div></div><div class="item" onclick="this.classList.add('curr');document.body.dataset.sorting='desc'">按倒序</div>`}));
  await page.route('https://weibo.com/ajax/comments/create', route => route.fulfill({json:{data:{idstr:'comment-456'}}}));
  await page.route('https://weibo.com/ajax/statuses/buildComments**', async route => {
    const query = new URL(route.request().url()).searchParams;
    assert.equal(query.get('id'), '5358752586012447');
    assert.equal(query.get('uid'), '7854161153');
    assert.equal(query.get('count'), '50');
    if (reads > 0) assert.equal(await page.evaluate(() => document.body.dataset.sorting), 'desc');
    reads += 1;
    return route.fulfill({json:{data: reads < 3 ? [] : [{idstr:'comment-456',user:{idstr:'123'},text_raw:'<span>测试🌟</span><br>来了'}]}});
  });
  try {
    const adapter = new WeiboAdapter({page:async()=>page});
    page.waitForTimeout = async ms => { delays.push(ms); };
    const candidate = {id:'RoEqepe6X',url:'https://weibo.com/detail/RoEqepe6X',authorUid:'7854161153'};
    await page.goto(candidate.url);
    assert.equal(await page.locator('textarea').count(), 1);
    assert.equal(await page.locator('button').count(), 1);
    const result = await adapter.comment({uid:'123'},candidate,'测试🌟来了');
    assert.equal(result.state,'succeeded');
    assert.equal(reads,3);
    assert.deepEqual(delays.filter(ms => ms >= 1000),[1000,3000]);
  } finally { await page.close(); }
});

test('超like切换到最新发帖并只返回分区帖子及真实评论数', async () => {
  const page = await browser.newPage();
  try {
    await page.setContent(`
      <nav><button onclick="window.section='superlike'">超like</button></nav>
      <div><button onclick="window.order='latest'">最新发帖</button><button>最新评论</button></div>
      <main>
        <article><a href="https://weibo.com/p/100808target">测试超话</a><a title="2026-10-27 22:18" href="https://weibo.com/111/Rzero">刚刚</a><p>零评论候选</p><footer>转发\n评论\n赞</footer></article>
        <article><a href="https://weibo.com/p/100808target">测试超话</a><a title="2026-10-27 22:17" href="https://weibo.com/222/Rfive">1分钟前</a><p>五条评论</p><footer>转发\n5\n1</footer></article>
        <article><a href="https://weibo.com/p/100808target">测试超话</a><a href="https://weibo.com/999/Rself">刚刚</a><footer>转发\n评论\n赞</footer></article>
      </main>
      <aside><a href="https://weibo.com/333/Rside">推荐帖</a><footer>转发\n评论\n赞</footer></aside>`);
    const adapter = new WeiboAdapter({});
    adapter.pageFor = async () => page;
    const rows = await adapter.collectCandidates({ uid: '999' }, { url: 'https://weibo.com/p/100808target' }, { section: '超like', limit: 50 });
    assert.equal(await page.evaluate(() => window.section), 'superlike');
    assert.equal(await page.evaluate(() => window.order), 'latest');
    assert.deepEqual(rows.map(row => [row.id, row.authorUid, row.commentCount]), [['Rzero','111',0],['Rfive','222',5]]);
    assert.equal(rows[0].createdAt, '2026-10-27 22:18');
  } finally { await page.close(); }
});

test('扫描不漏掉有转发数的帖子，未知评论数留给接口复核，不借用嵌套工具栏', async () => {
  const page = await browser.newPage();
  try {
    await page.setContent(`<button>超like</button><button>最新发帖</button>
      <article><a href="https://weibo.com/p/100808target">超话</a><a href="https://weibo.com/11/Rforward">刚刚</a><p>捞一下</p><footer>2\n3\n4</footer></article>
      <article><a href="https://weibo.com/p/100808target">超话</a><a href="https://weibo.com/22/Rlarge">刚刚</a><p>稳</p><footer>1万\n1.2万\n赞</footer></article>
      <article><a href="https://weibo.com/p/100808target">超话</a><a href="https://weibo.com/33/Runknown">刚刚</a><p>差一点</p><footer>转发\n评论加载中\n赞</footer></article>
      <article><a href="https://weibo.com/p/100808target">超话</a><a href="https://weibo.com/44/Router">刚刚</a><p>普通正文</p><blockquote><footer>转发\n评论\n赞</footer></blockquote><footer>转发\n25\n赞</footer></article>
      <aside><a href="https://weibo.com/55/Raside">推荐</a><footer>转发\n评论\n赞</footer></aside>`);
    const adapter = new WeiboAdapter({}); adapter.pageFor = async () => page;
    let wheels = 0; page.mouse.wheel = async () => { wheels++; };
    const rows = await adapter.collectCandidates({}, { url: 'https://weibo.com/p/100808target' }, { section: '超like', limit: 30, onBatch: async () => true });
    assert.deepEqual(rows.map(row => [row.id, row.commentCount]), [['Rforward', 3], ['Rlarge', 12000], ['Runknown', null], ['Router', 25]]);
    assert.equal(wheels, 0);
    // Some layouts use div cards instead of article elements.
    await page.setContent('<div><a href="https://weibo.com/p/100808target">超话</a><a href="https://weibo.com/66/Rdiv">刚刚</a><p>捞</p><div class="toolbar">1\n2\n3</div></div>');
    const divRows = await adapter.collectCandidates({}, { url: 'https://weibo.com/p/100808target' }, { section: '', limit: 1 });
    assert.deepEqual(divRows.map(row => row.commentCount), [2]);
  } finally { await page.close(); }
});

test('评论数复核支持数字微博ID并拒绝不匹配和缺失计数', async () => {
  const page = await browser.newPage();
  let payload = { idstr: '5123456789012345', comments_count: 3 };
  try {
    await page.route('https://weibo.com/**', route => route.request().url().includes('/ajax/statuses/show')
      ? route.fulfill({ json: payload }) : route.fulfill({ body: '<main>超话</main>', contentType: 'text/html' }));
    await page.goto('https://weibo.com/p/100808target');
    const adapter = new WeiboAdapter({ page: async () => page });
    const candidate = { id: '5123456789012345', url: 'https://weibo.com/11/5123456789012345' };
    assert.equal((await adapter.inspectCandidate({}, candidate, { inFeed: true })).commentCount, 3);
    payload = { idstr: '5123456789012346', comments_count: 3 };
    assert.equal(await adapter.inspectCandidate({}, candidate, { inFeed: true }), null);
    payload = { idstr: candidate.id };
    assert.equal(await adapter.inspectCandidate({}, candidate, { inFeed: true }), null);
  } finally { await page.close(); }
});

test('评论回执安全验证不会变成发帖人拒绝，并保留脱敏业务原因', async () => {
  const page = await browser.newPage();
  try {
    let responsePayload = { ok: 0, error_code: 20067, msg: 'security verification', validate: { challenge: 'do-not-log-secret' } };
    await page.route('https://weibo.com/**', route => route.request().url().includes('/ajax/comments/create')
      ? route.fulfill({ status: 400, json: responsePayload })
      : route.fulfill({ contentType: 'text/html; charset=utf-8', body: `<div><div><div><textarea placeholder="评论"></textarea><button onclick="fetch('/ajax/comments/create',{method:'POST'})">评论</button></div></div></div>` }));
    const adapter = new WeiboAdapter({ page: async () => page });
    const logs = []; adapter.log = (_level, message) => logs.push(message);
    const candidate = { id: 'RoEqepe6X', url: 'https://weibo.com/11/RoEqepe6X', authorUid: '11' };
    await assert.rejects(adapter.comment({ uid: '22' }, candidate, 'fixture'), error => error.code === 'verification_required' && error.explicitlyUnpublished);
    assert.ok(logs.some(message => message.includes('20067')));
    assert.equal(logs.some(message => message.includes('do-not-log-secret')), false);
    responsePayload = { ok: 0, error_code: 999, msg: '对方不允许评论' };
    const refused = await adapter.comment({ uid: '22' }, candidate, 'fixture');
    assert.equal(refused.retryElsewhere, true);
    assert.match(refused.reason, /对方不允许评论/);
    responsePayload = { ok: 0, msg: '发的太多啦，休息一下再来吧' };
    await assert.rejects(adapter.comment({ uid: '22' }, candidate, 'fixture'), error => error.code === 'rate_limited' && error.kind === 'comment');
    responsePayload = { error: 'temporary upstream error' };
    const unavailable = await adapter.comment({ uid: '22' }, candidate, 'fixture');
    assert.equal(unavailable.state, 'uncertain'); assert.equal(unavailable.retryElsewhere, undefined);
  } finally { await page.close(); }
});

test('分组组合选择、批量移动、每日统计、完成提醒确认与逐轮记录贯通', async () => {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  await page.request.post(`http://127.0.0.1:${port}/api/login`, { data: { token } });
  const api = '/api';
  const post = async (url, data) => {
    const response = await page.request.post(`http://127.0.0.1:${port}${api}${url}`, { data });
    assert.ok(response.ok(), await response.text()); return response.json();
  };
  const group = await post('/account-groups', { name: '组合测试组' });
  const destination = await post('/account-groups', { name: '移动目标组' });
  const accounts = [];
  for (let i = 0; i < 3; i++) accounts.push(await post('/accounts', {}));
  await post('/accounts/group', { ids: accounts.slice(0, 2).map(x => x.id), groupId: group.id });
  await page.goto(`http://127.0.0.1:${port}`);
  await page.locator('#pick-accounts').click();
  await page.locator('#picker-none').click();
  await page.locator('[data-picker-account="' + accounts[1].id + '"]').check();
  await page.locator('[data-picker-account="' + accounts[2].id + '"]').check();
  await page.locator('#picker-confirm').click();
  await page.locator('.config-tabs [data-pane="advanced"]').click();
  await page.locator('#save-task').click();
  await page.waitForFunction(() => document.querySelector('#toast')?.textContent === '设置已保存');
  const state = await page.request.get(`http://127.0.0.1:${port}/api/state`).then(r => r.json());
  assert.deepEqual(new Set(state.taskDefaults.accountIds), new Set([accounts[1].id, accounts[2].id]));
  await page.locator('.config-tabs [data-pane="plan"]').click();
  await page.locator('[data-plan-interval="0"]').fill('17');
  await page.request.patch(`http://127.0.0.1:${port}/api/account-groups/${group.id}`, { data: { name: '实时更新组' } });
  await page.waitForTimeout(150);
  assert.equal(await page.locator('[data-plan-interval="0"]').inputValue(), '17');
  assert.equal(await page.locator('[data-plan-interval="0"]').evaluate(el => el === document.activeElement), true);

  await page.locator('#nav [data-page="accounts"]').click();
  await page.locator(`[data-account-group-filter="${group.id}"]`).click();
  await page.locator('[data-select-accounts="all"]').click();
  await page.locator('[data-toggle-groups]').click();
  await page.locator('#move-group-target').selectOption(destination.id);
  await page.locator('#move-selected-group').click();
  await page.waitForFunction(() => document.querySelector('#toast')?.textContent === '账号已移动');
  const updated = await page.request.get(`http://127.0.0.1:${port}/api/state`).then(r => r.json());
  assert.ok(accounts.slice(0, 2).every(account => updated.accounts.find(item => item.id === account.id).group_id === destination.id));

  const topic = await post('/topics', { name: '轮次测试', url: 'https://weibo.com/p/100808round/super_index' });
  const db = new DatabaseSync(path.join(tempDir, 'console.sqlite'));
  const completedAt = new Date().toISOString(), startedAt = new Date(Date.parse(completedAt) - 600000).toISOString();
  const jobId = 'report-ui-fixture';
  const snapshot = { accountIds: accounts.map(x => x.id), topicIds: [topic.id], rounds: 2, accountIdentities: Object.fromEntries(accounts.map((account, i) => [account.id, { name: `测试账号${i + 1}`, uid: `${7000 + i}`, groupName: '移动目标组' }])), topicIdentities: { [topic.id]: { name: topic.name } } };
  db.prepare('INSERT INTO jobs(id,status,config_json,cursor_json,metrics_json,created_at,updated_at) VALUES(?,?,?,?,?,?,?)').run(jobId, 'completed', JSON.stringify(snapshot), '{}', JSON.stringify({ success: 1, failed: 1, uncertain: 0, skipped: 1 }), startedAt, completedAt);
  for (const [index, kind, actionState, error] of [[0, 'post', 'succeeded', null], [1, 'comment', 'failed', '评论频繁，已跳过本轮后续评论']]) {
    db.prepare('INSERT INTO action_logs(id,job_id,step_key,kind,account_id,topic_id,state,error,started_at,completed_at) VALUES(?,?,?,?,?,?,?,?,?,?)').run(`report-action-${index}`, jobId, `0:${topic.id}:${accounts[index].id}:0:0`, kind, accounts[index].id, topic.id, actionState, error, startedAt, completedAt);
  }
  const historicalDate = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai' }).format(new Date(Date.now() - 86400000));
  const historicalAt = `${historicalDate}T12:00:00.000+08:00`;
  db.prepare('INSERT INTO action_logs(id,job_id,step_key,kind,account_id,topic_id,state,started_at,completed_at) VALUES(?,?,?,?,?,?,?,?,?)').run('historical-daily-comment', jobId, 'history:comment', 'comment', accounts[0].id, topic.id, 'succeeded', historicalAt, historicalAt);
  for (let round = 0; round < 2; round++) db.prepare('INSERT INTO task_rounds(job_id,round_index,started_at,completed_at,status,notification_attempted_at) VALUES(?,?,?,?,?,?)').run(jobId, round, startedAt, completedAt, 'completed', completedAt);
  db.close();
  await page.reload();
  await page.locator('#round-complete-dialog[open]').waitFor();
  assert.match(await page.locator('#round-complete-title').innerText(), /第 1 轮/);
  assert.match(await page.locator('#round-complete-dialog').innerText(), /测试账号2/);
  assert.match(await page.locator('#round-complete-dialog').innerText(), /评论频繁/);
  if (process.env.WEIBO_CONSOLE_TEST_SCREENSHOTS) await page.screenshot({ path: path.join(process.env.WEIBO_CONSOLE_TEST_SCREENSHOTS, 'round-dialog.png'), animations: 'disabled' });
  assert.equal(Number(await page.locator('[data-daily-kind="post"]').innerText()), updated.dailySuccess.post + 1);
  await page.locator('[data-confirm-round]').filter({ hasText: '知道了' }).click();
  await page.getByText('第 2 轮已完成', { exact: true }).waitFor();
  await page.reload();
  await page.getByText('第 2 轮已完成', { exact: true }).waitFor();
  assert.equal(await page.getByText('第 1 轮已完成', { exact: true }).count(), 0);
  await page.locator('[data-view-round]').click();
  await page.locator('.record-detail-dialog[open]').waitFor();
  assert.ok(await page.locator('.record-detail-dialog [data-report-key="report-ui-fixture:1"]').count());
  assert.match(await page.locator('.record-detail-dialog').innerText(), /耗时 10分/);
  await page.locator('[data-close-record]').click();
  const reports = await page.request.get(`http://127.0.0.1:${port}/api/jobs/${jobId}/rounds`).then(r => r.json());
  assert.ok(reports.every(report => report.acknowledgedAt));
  await page.reload();
  await page.locator('#daily-success').waitFor();
  assert.equal(await page.locator('#round-complete-dialog[open]').count(), 0);
  const history = await page.request.get(`http://127.0.0.1:${port}/api/records?date=${historicalDate}`).then(r => r.json());
  assert.equal(history.dailySuccess.checkin, 0);
  assert.equal(history.dailySuccess.post, 0);
  assert.equal(history.dailySuccess.comment, 1);
  for (const width of [1440, 390]) {
    await page.setViewportSize({ width, height: 1000 });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    if (process.env.WEIBO_CONSOLE_TEST_SCREENSHOTS) {
      await page.waitForTimeout(350);
      await page.screenshot({ path: path.join(process.env.WEIBO_CONSOLE_TEST_SCREENSHOTS, `overview-${width}.png`), animations: 'disabled' });
      const previousPane = await page.locator('#config-card .config-tabs .tab.on').getAttribute('data-pane');
      await page.locator('#config-card .config-tabs [data-pane="plan"]').click();
      await page.locator('#action-plan').scrollIntoViewIfNeeded();
      await page.screenshot({ path: path.join(process.env.WEIBO_CONSOLE_TEST_SCREENSHOTS, `configuration-${width}.png`), animations: 'disabled' });
      await page.locator('#config-card .config-tabs [data-pane="' + previousPane + '"]').click();
      await page.evaluate(() => scrollTo(0,0));
    }
  }
  await page.close();
});

test('每日截止UI禁用开始与继续，次日解除；过期旧任务恢复接口返回409', async () => {
  const page = await browser.newPage();
  await page.request.post(`http://127.0.0.1:${port}/api/login`, { data: { token } });
  const state = await page.request.get(`http://127.0.0.1:${port}/api/state`).then(response => response.json());
  assert.equal(state.dailyStop.time, '23:59'); assert.equal(state.dailyStop.timezone, 'Asia/Shanghai');
  let blocked = true;
  await page.route('**/api/state', route => route.fulfill({ contentType: 'application/json', body: JSON.stringify({ ...state, pendingRoundReports: [], dailyStop: { ...state.dailyStop, blocked }, activeJob: { id: 'daily-ui-fixture', status: 'paused', metrics: {}, cursor: {}, created_at: new Date().toISOString() } }) }));
  await page.route('**/api/events', route => route.fulfill({ contentType: 'text/event-stream', body: '' }));
  await page.goto(`http://127.0.0.1:${port}`);
  await page.locator('#start-task').waitFor();
  assert.equal(await page.locator('#start-task').isDisabled(), true);
  assert.equal(await page.locator('[data-job-action="resume"]').isDisabled(), true);
  blocked = false; await page.reload();
  await page.locator('#start-task').waitFor();
  assert.equal(await page.locator('#start-task').isDisabled(), false);
  assert.equal(await page.locator('[data-job-action="resume"]').isDisabled(), false);
  const db = new DatabaseSync(path.join(tempDir, 'console.sqlite'));
  const stamp = new Date().toISOString();
  db.prepare('INSERT INTO jobs(id,status,config_json,cursor_json,metrics_json,created_at,updated_at) VALUES(?,?,?,?,?,?,?)').run('expired-resume-fixture', 'paused', JSON.stringify({ rounds: 1, accountIds: [], topicIds: [], actionPlan: [] }), JSON.stringify({ deadlineAt: '2020-01-01T15:59:00.000Z' }), '{}', stamp, stamp);
  const resumed = await page.request.post(`http://127.0.0.1:${port}/api/jobs/expired-resume-fixture/resume`);
  assert.equal(resumed.status(), 409);
  assert.equal(db.prepare('SELECT status FROM jobs WHERE id=?').get('expired-resume-fixture').status, 'stopped');
  db.close(); await page.close();
});

test('截止前节点检查和浏览器实际点击均有保护，签到未提交不会触发点击', async () => {
  const page = await browser.newPage();
  try {
    await page.setContent('<button class="signBtn" onclick="window.sent=true">签到</button>');
    const adapter = new WeiboAdapter({}); adapter.pageFor = async () => page;
    let calls = 0;
    await assert.rejects(adapter.checkin({}, {}, { onSubmit: () => { calls++; throw new Error('截止阻止提交'); } }), /截止阻止提交/);
    assert.equal(calls, 1); assert.equal(await page.evaluate(() => Boolean(window.sent)), false);
    const deadline = Date.now() + 60000;
    await page.evaluate(value => { Date.now = () => value; }, deadline + 1);
    await assert.rejects(adapter.checkin({}, {}, { deadlineAt: deadline, onSubmit: () => {} }), error => error.code === 'daily_stop' && error.unsubmitted === true);
    assert.equal(await page.evaluate(() => Boolean(window.sent)), false);
    assert.equal(await page.evaluate(() => Boolean(document.querySelector('button').__workbenchSubmitGuard)), false);
  } finally { await page.close(); }
});

test('后台验证码不前置，手动验证模式才恢复窗口', async () => {
  const page = await browser.newPage();
  try {
    await page.setContent('<div role="dialog">请完成安全验证</div><button class="signBtn">签到</button>');
    page.goto = async () => {};
    let foreground = 0;
    const adapter = new WeiboAdapter({ page: async () => page, foreground: async () => { foreground++; } });
    await assert.rejects(adapter.withChallengeMode('background', () => adapter.checkin({}, { url: 'https://example.test' })), error => error.code === 'verification_required');
    assert.equal(foreground, 0);
    await assert.rejects(adapter.withChallengeMode('manual', () => adapter.checkin({}, { url: 'https://example.test' })), error => error.code === 'verification_required');
    assert.equal(foreground, 1);
  } finally { await page.close(); }
});

test('人工验证检测同一上下文的新标签验证码，只读签到复核不跳转', async () => {
  const context = await browser.newContext();
  const page = await context.newPage(), popup = await context.newPage();
  await page.setContent('<button class="signBtn">签到</button>');
  await popup.setContent('<div role="dialog">请完成安全验证</div>');
  let foreground = 0, navigations = 0;
  page.goto = async () => { navigations++; };
  const adapter = new WeiboAdapter({ context, owner: 'manual', page: async () => page, foreground: async target => { assert.equal(target, popup); foreground++; } });
  try {
    assert.equal(await adapter.hasTaskChallenge({}), true);
    await assert.rejects(adapter.withChallengeMode('manual', () => adapter.verifyCheckin({}, { url: 'https://weibo.com/topic' })), error => error.code === 'verification_required');
    assert.equal(foreground, 1);
    assert.equal(navigations, 0);
  } finally { await context.close(); }
});

test('iframe验证码通过后残留面板和隐藏模板不再阻止验证完成', async () => {
  const page = await browser.newPage();
  const adapter = new WeiboAdapter({ page: async () => page, owner: 'manual' });
  try {
    await page.setContent(`<iframe srcdoc='<div class="geetest_panel"><div role="dialog">请完成安全验证</div></div>'></iframe>`);
    assert.equal(await adapter.hasTaskChallenge({}), true);
    await page.frames()[1].locator('.geetest_panel').evaluate(node => {
      node.innerHTML = '<span class="geetest_success">验证成功</span><span hidden>请完成安全验证</span>';
    });
    assert.equal(await adapter.hasTaskChallenge({}), false);
  } finally { await page.close(); }
});

test('待验证账号卡片、互斥、明确确认与继续运行按钮可用', async () => {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  await page.request.post(`http://127.0.0.1:${port}/api/login`, { data: { token } });
  const account = await page.request.post(`http://127.0.0.1:${port}/api/accounts`, { data: {} }).then(r => r.json());
  const topic = await page.request.post(`http://127.0.0.1:${port}/api/topics`, { data: { name: '验证主题', url: 'https://weibo.com/p/100808verification/super_index' } }).then(r => r.json());
  const db = new DatabaseSync(path.join(tempDir, 'console.sqlite'));
  const jobId = 'verification-ui-fixture', stamp = new Date().toISOString();
  const snapshot = { schedulerVersion: 2, rounds: 1, accountIds: [account.id], topicIds: [topic.id], actionPlan: [{ type: 'comment', count: 1 }, { type: 'post', count: 1 }], accountIdentities: { [account.id]: { name: '待验证昵称', uid: '10086' } }, topicIdentities: { [topic.id]: { name: '验证主题' } } };
  const keys = [`0:${topic.id}:${account.id}:0:0`, `0:${topic.id}:${account.id}:1:0`];
  const cursor = { workflowRound: 0, stepIndex: 1, verificationBarrier: true };
  db.prepare('INSERT INTO jobs(id,status,config_json,cursor_json,metrics_json,created_at,updated_at) VALUES(?,?,?,?,?,?,?)').run(jobId, 'waiting', JSON.stringify(snapshot), JSON.stringify(cursor), JSON.stringify({ success: 0, failed: 0, uncertain: 1, skipped: 0 }), stamp, stamp);
  for (let index = 0; index < 2; index++) {
    db.prepare('INSERT INTO task_step_state(job_id,step_key,ordinal,round_index,account_id,identity,topic_id,kind,action_index,unit_index,state,outcome,ever_verification) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)').run(jobId, keys[index], index, 0, account.id, '10086', topic.id, index ? 'post' : 'comment', index, 0, index ? 'review' : 'deferred', index ? 'uncertain' : null, 1);
    db.prepare('INSERT INTO action_logs(id,job_id,step_key,kind,account_id,topic_id,state,error,started_at,verification_pending) VALUES(?,?,?,?,?,?,?,?,?,1)').run(`verification-action-${index}`, jobId, keys[index], index ? 'post' : 'comment', account.id, topic.id, index ? 'uncertain' : 'verification_wait', '需要验证码', stamp);
  }
  db.prepare('INSERT INTO verification_cards(job_id,round_index,identity,account_id,status,blocked_kinds_json,reason,triggered_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?)').run(jobId, 0, '10086', account.id, 'pending', '["comment","post"]', '需要验证码', stamp, stamp);
  const refused = await page.request.post(`http://127.0.0.1:${port}/api/jobs/${jobId}/verification/confirm-unpublished`, { data: { stepKey: keys[1], confirmed: false } });
  assert.equal(refused.status(), 400);
  db.prepare('UPDATE jobs SET cursor_json=? WHERE id=?').run(JSON.stringify({ ...cursor, manualVerification: { identity: '10086', phase: 'challenge' } }), jobId);
  assert.equal((await page.request.post(`http://127.0.0.1:${port}/api/accounts/${account.id}/login`)).status(), 409);
  db.prepare('UPDATE jobs SET cursor_json=? WHERE id=?').run(JSON.stringify(cursor), jobId);
  let state = await page.request.get(`http://127.0.0.1:${port}/api/state`).then(r => r.json());
  assert.equal(state.activeJob.metrics.uncertain, 0);
  assert.ok(state.recentActions.every(action => action.display_state === 'verification_wait'));
  const requests = [];
  await page.route('**/api/state', route => route.fulfill({ contentType: 'application/json', body: JSON.stringify(state) }));
  await page.route('**/api/events', route => route.fulfill({ contentType: 'text/event-stream', body: '' }));
  await page.route('**/verification/*', async route => {
    const action = new URL(route.request().url()).pathname.split('/').at(-1), body = route.request().postDataJSON();
    requests.push([action, body]);
    if (action === 'open') state.verification.session = { identity: '10086', phase: 'challenge' };
    if (action === 'end') { state.verification.session = null; state.verification.cards[0].status = 'ready'; state.verification.canContinue = true; }
    if (action === 'continue') { state.verification.canContinue = false; state.verification.barrier = false; state.verification.cards[0].status = 'retrying'; }
    await route.fulfill({ contentType: 'application/json', body: '{}' });
  });
  try {
    await page.goto(`http://127.0.0.1:${port}`);
    await page.locator('#verification-panel').waitFor();
    assert.match(await page.locator('#verification-panel').innerText(), /待验证昵称/);
    assert.match(await page.locator('#verification-panel').innerText(), /10086/);
    assert.equal(await page.locator('.recent-state.verification_wait').count(), 2);
    assert.equal(await page.locator('.recent-state.uncertain').count(), 0);
    assert.match(await page.locator('#run-metrics').innerText(), /0\s*待核对/);
    assert.equal(await page.locator('#verification-panel [data-verification-continue]').isDisabled(), false);
    await page.locator('[data-verify-toggle]').first().click();
    assert.match(await page.locator('.verify-detail').innerText(), /待补做 \d+ 项 · 待验证 \d+ 项/);
    await page.locator('[data-verify-identity]').click();
    await page.locator('#verification-panel [data-verification-end]').waitFor();
    assert.equal(await page.locator('[data-verify-identity]').isDisabled(), true);
    await page.locator('#verification-panel [data-verification-recheck]').click();
    await page.waitForFunction(() => !document.querySelector('#verification-panel [data-verification-recheck]').disabled);
    await page.locator('#verification-panel [data-verification-end]').click();
    await page.waitForFunction(() => !document.querySelector('#verification-panel [data-verification-continue]').disabled);
    page.once('dialog', dialog => dialog.accept());
    await page.locator('[data-confirm-unpublished]').click();
    await page.waitForTimeout(100);
    assert.equal(requests.find(([action]) => action === 'confirm-unpublished')[1].confirmed, true);
    assert.equal(requests.find(([action]) => action === 'confirm-unpublished')[1].stepKey, keys[1]);
    await page.locator('#verification-panel [data-verification-continue]').click();
    await page.waitForFunction(() => document.querySelector('#verification-panel [data-verification-continue]').disabled);
    assert.deepEqual(requests.map(([action]) => action), ['open','recheck','end','confirm-unpublished','continue']);
    for (const width of [1440, 390]) {
      await page.setViewportSize({ width, height: 1000 });
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    }
  } finally { db.prepare("UPDATE jobs SET status='stopped' WHERE id=?").run(jobId); db.close(); await page.close(); }
});

test('会话状态文案区分手动验证、提交与等待回执', async () => {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  await page.request.post(`http://127.0.0.1:${port}/api/login`, { data: { token } });
  const state = await page.request.get(`http://127.0.0.1:${port}/api/state`).then(r => r.json());
  state.verification = {
    jobId: 'phase-copy-fixture', jobStatus: 'waiting', round: 0, barrier: true, canContinue: false,
    session: { identity: '10086', phase: 'challenge' },
    cards: [
      { identity: '10086', name: '文案账号', uid: '10086', status: 'pending', reason: '需要验证码', visible: true, steps: [{ kind: 'checkin', state: 'deferred' }] },
      { identity: '10088', name: '待补签到账号', uid: '10088', status: 'ready', verificationResult: 'passed', reason: '安全验证已通过，签到待补做', visible: true, remainingStepCount: 1, checkinResult: 'pending', steps: [{ kind: 'checkin', state: 'deferred' }] },
      { identity: '10087', name: '已完成账号', uid: '10087', status: 'resolved', reason: '验证与签到已完成', visible: false, remainingStepCount: 0, checkinResult: 'succeeded', steps: [] }
    ]
  };
  await page.route('**/api/state', route => route.fulfill({ contentType: 'application/json', body: JSON.stringify(state) }));
  await page.route('**/api/events', route => route.fulfill({ contentType: 'text/event-stream', body: '' }));
  try {
    await page.goto(`http://127.0.0.1:${port}`);
    await page.locator('.verify-session').waitFor();
    assert.equal(await page.locator('#verification-panel .verify-count').innerText(), '2/3');
    assert.equal(await page.locator('.verify-session').innerText(), '正在当前窗口手动验证…');
    assert.equal(await page.locator('#verification-panel [data-verification-recheck]').count(), 1);
    for (const [phase, expected] of [
      ['signing_checkin', '正在当前窗口补做签到…'],
      ['submitting_post', '正在当前窗口发帖…'],
      ['submitting_comment', '正在当前窗口评论…'],
      ['awaiting_comment_receipt', '正在等待本次评论成功提示…'],
      ['awaiting_post_receipt', '正在等待本次发帖成功提示…']
    ]) {
      state.verification.session = { identity: '10086', phase };
      await page.reload();
      await page.locator('.verify-session').waitFor();
      assert.equal(await page.locator('.verify-session').innerText(), expected, phase);
    }
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  } finally { await page.close(); }
});

test('超like正文关键词不受昵称、评论、转发影响，前排命中立即停止滚动', async () => {
  const page = await browser.newPage();
  try {
    await page.setContent(`<button>超like</button><button>最新发帖</button>
      <article><a href="https://weibo.com/p/100808target">超话</a><a href="https://weibo.com/11/Rone">刚刚</a><span>稳稳的昵称</span><p>普通正文</p><blockquote><p>捞我</p></blockquote><div class="comment"><p>差一点</p></div><footer>转发\n评论\n赞</footer></article>
      <article><a href="https://weibo.com/p/100808target">超话</a><a href="https://weibo.com/22/Rtwo">刚刚</a><p>差几个，捞一下</p><footer>转发\n2\n赞</footer></article>`);
    let wheels = 0;
    page.mouse.wheel = async () => { wheels++; };
    const adapter = new WeiboAdapter({}); adapter.pageFor = async () => page;
    let selected;
    const rows = await adapter.collectCandidates({}, { url: 'https://weibo.com/p/100808target' }, { section: '超like', limit: 30, onBatch: async batch => { selected = batch.find(item => /[差捞稳]/.test(item.text)); return Boolean(selected); } });
    assert.equal(selected.id, 'Rtwo'); assert.equal(wheels, 0);
    assert.equal(rows[0].text, '普通正文');
  } finally { await page.close(); }
});

test('记录页在1440×900 一屏内显示四宫格并分页', async () => {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const testDate = '2026-10-28';
  const stamp = testDate + 'T12:00:00.000+08:00';
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai' }).format(new Date());
  const db = new DatabaseSync(path.join(tempDir, 'console.sqlite'));
  db.prepare('INSERT OR REPLACE INTO jobs(id,status,config_json,cursor_json,metrics_json,created_at,updated_at) VALUES(?,?,?,?,?,?,?)').run('e2e-grid-job', 'completed', '{}', '{}', '{}', stamp, stamp);
  const insertAccount = db.prepare('INSERT OR REPLACE INTO accounts(id,name,nickname,uid,enabled,sort_order,profile_dir,auth_status,created_at,updated_at) VALUES(?,?,?,?,1,?,?,?,?,?)');
  const insertAction = db.prepare('INSERT INTO action_logs(id,job_id,step_key,kind,account_id,state,error,started_at,completed_at) VALUES(?,?,?,?,?,?,?,?,?)');
  for (let i = 0; i < 40; i++) {
    insertAccount.run('e2e-grid-acc-' + i, '压测账号' + i, null, '9000' + i, i, '/tmp/e2e-grid-' + i, 'valid', stamp, stamp);
    insertAction.run('e2e-grid-act-' + i, 'e2e-grid-job', '0:' + i, i % 2 ? 'comment' : 'post', 'e2e-grid-acc-' + i, i % 7 === 0 ? 'failed' : 'succeeded', i % 7 === 0 ? '操作频繁，请稍后重试' : null, stamp, stamp);
  }
  db.close();
  try {
    await page.request.post('http://127.0.0.1:' + port + '/api/login', { data: { token } });
    await page.goto('http://127.0.0.1:' + port);
    await page.locator('#nav [data-page="logs"]').click();
    await page.locator('#record-date').fill(testDate);
    await page.locator('#record-date').dispatchEvent('change');
    await page.locator('.record-account-row').first().waitFor();
    await page.waitForTimeout(600);
    const box = await page.evaluate(() => ({
      vh: innerHeight,
      doc: document.documentElement.scrollHeight,
      panels: [...document.querySelectorAll('.record-panel')].map(node => Math.round(node.getBoundingClientRect().height)),
      rows: document.querySelectorAll('.record-account-row').length,
      issues: document.querySelectorAll('.record-issue').length,
      overflowX: document.documentElement.scrollWidth > innerWidth,
      parts: ['.topbar', '#page-logs', '.record-toolbar', '#record-status', '#log-summary', '#record-grid'].map(sel => {
        const node = document.querySelector(sel);
        if (!node) return [sel, null];
        const rect = node.getBoundingClientRect();
        return [sel, Math.round(rect.top), Math.round(rect.height), getComputedStyle(node).display];
      }),
      bodyH: document.body.scrollHeight,
      mainPad: getComputedStyle(document.querySelector('main')).paddingBottom,
    }));
    assert.ok(box.doc <= box.vh + 4, '记录页应在 1440×900 一屏内，实际 ' + box.doc);
    assert.equal(box.panels.length, 4);
    assert.equal(box.rows, 7);
    assert.equal(box.issues, 6);
    assert.equal(box.overflowX, false);
    const jobsPanel = await page.evaluate(() => {
      const list = document.querySelector('#job-list');
      const panel = document.querySelector('#record-jobs');
      const pager = document.querySelector('#record-jobs .panel-pager');
      const style = getComputedStyle(list);
      return {
        overflowY: style.overflowY,
        flexGrow: style.flexGrow,
        display: style.display,
        gap: style.rowGap,
        panelBottom: Math.round(panel.getBoundingClientRect().bottom),
        pagerBottom: Math.round(pager.getBoundingClientRect().bottom),
        text: pager.querySelector('span').textContent.trim(),
        prevDisabled: pager.querySelector('[data-pager-prev]').disabled,
        nextDisabled: pager.querySelector('[data-pager-next]').disabled,
        rows: document.querySelectorAll('#job-list .record-job').length
      };
    });
    assert.equal(jobsPanel.display, 'flex', '任务明细列表应与其余面板同为 flex 列');
    assert.equal(jobsPanel.flexGrow, '1', '任务明细列表应撑满面板剩余高度');
    assert.equal(jobsPanel.overflowY, 'auto', '任务明细列表应可滚动');
    assert.equal(jobsPanel.gap, 'normal', '任务明细不应保留工作台列表的 grid 间距');
    assert.ok(jobsPanel.panelBottom - jobsPanel.pagerBottom >= 0 && jobsPanel.panelBottom - jobsPanel.pagerBottom < 24, '分页条应贴在面板底部，实际间距 ' + (jobsPanel.panelBottom - jobsPanel.pagerBottom));
    assert.equal(jobsPanel.rows, 1);
    assert.equal(jobsPanel.text, '1 / 1');
    assert.equal(jobsPanel.prevDisabled, true);
    assert.equal(jobsPanel.nextDisabled, true, '只有一个任务时不应出现可翻页状态');
    const pager = await page.locator('#record-accounts .panel-pager span').innerText();
    assert.match(pager, /^1 \/ \d+$/);
    assert.equal(await page.locator('#record-accounts [data-pager-prev]').isDisabled(), true);
    const first = await page.locator('.record-account-row strong').first().innerText();
    await page.locator('#record-accounts [data-pager-next]').click();
    assert.match(await page.locator('#record-accounts .panel-pager span').innerText(), /^2 \/ \d+$/);
    assert.notEqual(await page.locator('.record-account-row strong').first().innerText(), first);
    await page.locator('.record-job').first().click();
    await page.locator('.record-detail-dialog[open]').waitFor();
    assert.match(await page.locator('.record-detail-dialog h2').innerText(), /任务明细/);
    await page.locator('[data-close-record]').click();
    const oldDate = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai' }).format(new Date(Date.parse(today + 'T00:00:00Z') - 20 * 86400000));
    await page.locator('#record-date').fill(oldDate);
    await page.locator('#record-date').dispatchEvent('change');
    await page.locator('#record-archived:not(.hidden)').waitFor();
    assert.match(await page.locator('#record-archived').innerText(), /详细记录已按 10 天保留清理/);
    assert.equal(await page.locator('#record-grid').isHidden(), true);
    await page.setViewportSize({ width: 375, height: 812 });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  } finally { await page.close(); }
});

test('任务明细面板可翻页且与其余面板同构', async () => {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const testDate = '2027-06-15';
  const stamp = testDate + 'T12:00:00.000+08:00';
  const db = new DatabaseSync(path.join(tempDir, 'console.sqlite'));
  const insertJob = db.prepare('INSERT OR REPLACE INTO jobs(id,status,config_json,cursor_json,metrics_json,created_at,updated_at) VALUES(?,?,?,?,?,?,?)');
  for (let i = 0; i < 7; i += 1) insertJob.run('e2e-jobs-page-' + i, 'completed', '{}', '{}', JSON.stringify({ success: i + 1 }), stamp, stamp);
  db.close();
  try {
    await page.request.post('http://127.0.0.1:' + port + '/api/login', { data: { token } });
    await page.goto('http://127.0.0.1:' + port);
    await page.locator('#nav [data-page="logs"]').click();
    await page.locator('#record-date').fill(testDate);
    await page.locator('#record-date').dispatchEvent('change');
    await page.locator('#job-list .record-job').first().waitFor();
    await page.waitForFunction(() => document.querySelectorAll('#job-list .record-job').length === 5);
    assert.equal((await page.locator('#record-jobs .panel-pager span').innerText()).trim(), '1 / 2');
    assert.equal(await page.locator('#record-jobs [data-pager-prev]').isDisabled(), true);
    assert.equal(await page.locator('#record-jobs [data-pager-next]').isDisabled(), false);
    await page.locator('#record-jobs [data-pager-next]').click();
    await page.waitForFunction(() => document.querySelectorAll('#job-list .record-job').length === 2);
    assert.equal((await page.locator('#record-jobs .panel-pager span').innerText()).trim(), '2 / 2');
    assert.equal(await page.locator('#record-jobs [data-pager-next]').isDisabled(), true);
    await page.locator('#record-jobs [data-pager-prev]').click();
    await page.waitForFunction(() => document.querySelectorAll('#job-list .record-job').length === 5);
    assert.equal((await page.locator('#record-jobs .panel-pager span').innerText()).trim(), '1 / 2');
    assert.equal(await page.locator('#job-list').evaluate(node => getComputedStyle(node).overflowY), 'auto');
    await page.setViewportSize({ width: 375, height: 812 });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  } finally { await page.close(); }
});

test('账号记录搜索、异常筛选、面板与详情游标分页可用', async () => {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const stamp = new Date().toISOString();
  const queries = [];
  const counts = { checkin: { succeeded: 1, failed: 0, uncertain: 0, skipped: 0 }, post: { succeeded: 0, failed: 0, uncertain: 0, skipped: 0 }, comment: { succeeded: 1, failed: 0, uncertain: 0, skipped: 2 } };
  const account = { identity: '123456', uid: '123456', name: '测试昵称', counts, tags: [{ type: '频繁', kind: 'comment' }] };
  try {
    await page.request.post('http://127.0.0.1:' + port + '/api/login', { data: { token } });
    await page.route(url => url.pathname === '/api/records', route => {
      const p = new URL(route.request().url()).searchParams;
      queries.push(p.toString());
      const panel = p.get('panel') || '';
      const view = {
        accounts: p.get('q') === '不存在' ? [] : [account],
        counts,
        abnormalCount: 1,
        issues: Array.from({ length: 8 }, (_, i) => ({ identity: '123456', name: '测试昵称', type: '频繁', kind: 'comment', kinds: ['comment'], count: i + 1, latest: stamp })),
        jobCounts: {},
        details: [],
        detailTotal: 0,
        nextCursor: null,
        snapshot: stamp,
      };
      if (panel === 'flow') {
        view.details = [{ account_name: '测试昵称', source: 'action', state: 'skipped', kind: 'comment', created_at: stamp, message: '流水行' }];
        view.detailTotal = 12;
        view.nextCursor = p.get('cursor') ? null : stamp + '|flow2';
      }
      if (panel === 'identity') {
        const firstPage = !p.get('cursor');
        view.details = [{ account_name: '测试昵称', source: 'action', state: 'skipped', kind: 'comment', created_at: stamp, message: firstPage ? '操作频繁，保留的完整业务原因' : '第二批完整原因' }];
        view.detailTotal = 40;
        view.nextCursor = firstPage ? stamp + '|detail2' : null;
      }
      return route.fulfill({ json: { logs: [], actions: [], jobs: [], rounds: [], dailySuccess: {}, dailyStats: { date: '2026-10-30', counts, jobCount: 0, abnormalAccounts: 1, archived: false }, recordView: view } });
    });
    await page.goto('http://127.0.0.1:' + port);
    await page.locator('#nav [data-page="logs"]').click();
    await page.locator('.record-account-row').waitFor();
    assert.equal(await page.locator('.record-issue').count(), 6);
    assert.match(await page.locator('#key-events .panel-pager span').innerText(), /^1 \/ 2$/);
    await page.locator('#key-events [data-pager-next]').click();
    assert.equal(await page.locator('.record-issue').count(), 2);
    assert.match(await page.locator('#key-events .panel-pager span').innerText(), /^2 \/ 2$/);
    await page.locator('#record-search').fill('123456');
    await page.waitForFunction(() => location.search.includes('recordSearch=123456'));
    assert.match(await page.locator('#key-events .panel-pager span').innerText(), /^1 \/ 2$/);
    await page.locator('#record-abnormal').click();
    await page.waitForFunction(() => location.search.includes('recordAbnormal=1'));
    assert.ok(queries.some(q => q.includes('q=123456') && q.includes('abnormal=1')));
    await page.locator('.record-account-row button').first().click();
    await page.getByText('操作频繁，保留的完整业务原因', { exact: true }).waitFor();
    assert.match(await page.locator('.record-detail-dialog .panel-pager span').innerText(), /^1 \/ 2$/);
    const size = await page.locator('.record-detail-dialog').evaluate(node => { const r = node.getBoundingClientRect(); return [Math.round(r.width), Math.round(r.height)]; });
    assert.equal(size[0], 720);
    await page.locator('[data-detail-next]').click();
    await page.getByText('第二批完整原因', { exact: true }).waitFor();
    assert.match(await page.locator('.record-detail-dialog .panel-pager span').innerText(), /^2 \/ 2$/);
    await page.locator('[data-close-record]').click();
    assert.ok(queries.some(q => q.includes('panel=flow')));
    assert.ok(queries.some(q => q.includes('panel=identity')));
    await page.setViewportSize({ width: 375, height: 812 });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    await page.locator('#record-search').fill('不存在');
    await page.getByText('无匹配账号', { exact: true }).waitFor();
  } finally { await page.close(); }
});

async function assertText(page, text) {
  await page.getByText(text, { exact: true }).filter({ visible: true }).first().waitFor({ state: 'visible' });
}

test('固定苏新皓模式下拉含12分区，超话只读，保存及手机布局正常', async () => {
  const folder=fs.mkdtempSync(path.join(os.tmpdir(),'weibo-fixed-ui-')),fixedPort=port+1100;
  const child=spawn(process.execPath,['src/server.js'],{cwd:root,env:{...process.env,WEIBO_CONSOLE_NOTIFY:'off',WEIBO_CONSOLE_LICENSE:'off',WEIBO_CONSOLE_TOPIC_MODE:'fixed',WEIBO_CONSOLE_DATA_DIR:folder,WEIBO_CONSOLE_PORT:String(fixedPort),WEIBO_CONSOLE_ACCESS_TOKEN:token},stdio:'ignore'});
  const page=await browser.newPage();const base=`http://127.0.0.1:${fixedPort}`;
  try{
    for(let i=0;i<60;i++){if(await fetch(base+'/api/session').then(r=>r.ok).catch(()=>false))break;await new Promise(r=>setTimeout(r,100));}
    await page.request.post(base+'/api/login',{data:{token}});
    const state=await page.request.get(base+'/api/state').then(r=>r.json());
    assert.equal(state.allowCustomTopics,false);assert.equal(state.fixedTopic.name,'苏新皓');assert.equal(state.commentSections.length,12);
    for(const [method,url]of[['post','/api/topics'],['patch','/api/topics/'+state.fixedTopic.id],['delete','/api/topics/'+state.fixedTopic.id],['post','/api/topics/bulk-delete']])assert.equal((await page.request[method](base+url,{data:{name:'其他',url:'https://weibo.com/p/100808other',ids:[state.fixedTopic.id]}})).status(),403);
    assert.equal((await page.request.post(base+'/api/jobs',{data:{topicIds:['other']}})).status(),400);
    await page.goto(base);await page.locator('.config-tabs [data-pane="advanced"]').click();await page.locator('select#comment-section').waitFor();
    assert.deepEqual(await page.locator('#comment-section option').allTextContents(),state.commentSections);
    assert.equal(await page.locator('#comment-section').inputValue(),'超like');
    await page.locator('#comment-section').selectOption('创作🫙');await page.getByRole('button',{name:'设为默认',exact:true}).click();
    await page.reload();await page.waitForFunction(()=>document.querySelector('#comment-section')?.value==='创作🫙');assert.equal(await page.locator('#comment-section').inputValue(),'创作🫙');
    await page.setViewportSize({width:390,height:844});assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
  }finally{await page.close();child.kill('SIGTERM');await new Promise(resolve=>child.exitCode!==null?resolve():child.once('exit',resolve));fs.rmSync(folder,{recursive:true,force:true});}
});

test('隐藏分区先展开更多，成功选择后才扫描，不回退其他分区',async()=>{
  const page=await browser.newPage();try{
    await page.setContent(`<div class="chaohua-tab-wrap"><div class="woo-box-item-inlineBlock cur"><span>热门</span></div><button title="更多" onclick="document.querySelector('#fold').hidden=false">更多</button><div id="fold" hidden><div class="woo-box-item-inlineBlock" onclick="document.querySelector('.cur').classList.remove('cur');this.classList.add('cur')"><span>创作🫙</span></div></div></div><article><a href="https://weibo.com/p/100808target">超话</a><a href="https://weibo.com/11/Rhidden">刚刚</a><p>正文</p><footer>转发\n2\n赞</footer></article>`);
    const adapter=new WeiboAdapter({});adapter.pageFor=async()=>page;
    const rows=await adapter.collectCandidates({}, {url:'https://weibo.com/p/100808target'},{section:'创作🫙',limit:1});
    assert.equal(rows[0].id,'Rhidden');assert.equal(await page.locator('#fold').isVisible(),true);
    assert.equal(await page.locator('.cur').innerText(),'创作🫙');
  }finally{await page.close();}
});

test('手动暂停后真实保存接口成功，保存失败保留草稿，网络暂停提示可转手动', async () => {
  const page = await browser.newPage();
  await page.goto(`http://127.0.0.1:${port}`);
  await page.locator('#token').fill(token); await page.getByRole('button', { name: '进入工坊' }).click();
  await page.request.post(`http://127.0.0.1:${port}/api/accounts`, { data: {} });
  await page.request.post(`http://127.0.0.1:${port}/api/topics`, { data: { name: '编辑测试', url: 'https://weibo.com/p/100808editfixture' } });
  await page.request.post(`http://127.0.0.1:${port}/api/post-materials`, { data: { texts: ['编辑测试文案'] } });
  const state = await page.request.get(`http://127.0.0.1:${port}/api/state`).then(r => r.json());
  const account = state.accounts.find(a => a.enabled), topic = state.topics.find(t => t.enabled);
  const stamp = new Date().toISOString(), jobId = 'edit-network-fixture';
  const cfg = { ...state.taskDefaults, schedulerVersion: 3, rounds: 1, accountIds: [account.id], topicIds: [topic.id], segmentIds: ['edit-fixture'], actionPlan: [{ type: 'post', count: 1, intervalSeconds: 10 }], materials: { posts: state.posts, comments: state.comments } };
  const local = new DatabaseSync(path.join(tempDir, 'console.sqlite')); local.exec('PRAGMA foreign_keys=ON; DELETE FROM jobs');
  local.prepare('INSERT INTO jobs(id,status,config_json,cursor_json,metrics_json,paused_by_user,created_at,updated_at) VALUES(?,?,?,?,?,1,?,?)').run(jobId, 'paused', JSON.stringify(cfg), JSON.stringify({ stepIndex: 0, deadlineAt: '2030-03-15T15:59:00.000Z' }), JSON.stringify({ success: 0, failed: 0, uncertain: 0, skipped: 0 }), stamp, stamp);
  await page.reload();
  await page.getByRole('button', { name: '修改任务参数', exact: true }).click();
  await page.locator('.config-tabs [data-pane="advanced"]').click();
  await page.getByRole('button', { name: '保存修改', exact: true }).waitFor();
  assert.equal(await page.locator('[data-job-action="resume"]').count(), 0);
  assert.equal(await page.getByRole('button', { name: '保存并继续运行', exact: true }).filter({ visible: true }).count(), 2);
  assert.match(await page.locator('#run-headline').innerText(), /正在修改任务参数/);
  await page.locator('.config-tabs [data-pane="plan"]').click();
  await page.locator('[data-plan-count="0"]').fill('2');
  page.once('dialog', dialog => dialog.accept());
  await page.getByRole('button', { name: '取消修改', exact: true }).click();
  assert.equal(await page.locator('[data-plan-count="0"]').inputValue(), '1');
  await page.getByRole('button', { name: '修改任务参数', exact: true }).click();
  await page.locator('[data-edit-action="cancel"]').waitFor();
  await page.locator('.config-tabs [data-pane="plan"]').click();
  await page.locator('[data-plan-interval="0"]').fill('17');
  await page.locator('.config-tabs [data-pane="advanced"]').click();
  await page.getByRole('button', { name: '保存修改', exact: true }).click();
  await page.waitForFunction(() => document.querySelector('#toast')?.textContent.includes('修改已保存'));
  let saved = await page.request.get(`http://127.0.0.1:${port}/api/jobs/${jobId}/edit`).then(r => r.json());
  assert.equal(saved.version, 1); assert.equal(saved.config.actionPlan[0].intervalSeconds, 17); assert.equal(saved.status, 'paused');
  await page.getByRole('button', { name: '修改任务参数', exact: true }).click();
  await page.locator('[data-edit-action="cancel"]').waitFor();
  await page.route(`**/api/jobs/${jobId}/edit`, route => route.request().method() === 'POST' ? route.fulfill({ status: 500, json: { error: '模拟保存失败' } }) : route.continue());
  await page.locator('.config-tabs [data-pane="plan"]').click();
  await page.locator('[data-plan-count="0"]').fill('3');
  await page.locator('.config-tabs [data-pane="advanced"]').click();
  await page.getByRole('button', { name: '保存修改', exact: true }).click();
  await page.waitForFunction(() => document.querySelector('#toast')?.textContent.includes('模拟保存失败'));
  assert.equal(await page.locator('[data-plan-count="0"]').inputValue(), '3');
  assert.equal(await page.getByRole('button', { name: '取消修改', exact: true }).count(), 1);
  await page.unroute(`**/api/jobs/${jobId}/edit`);
  let resumeRequest;
  await page.route(`**/api/jobs/${jobId}/edit`, async route => {
    if (route.request().method() !== 'POST') return route.continue();
    resumeRequest = route.request().postDataJSON();
    return route.fulfill({ json: { version: 2, change: { added: 0, cancelled: 0 }, job: { id: jobId, status: 'running' } } });
  });
  await page.locator('.config-tabs [data-pane="plan"]').click();
  await page.locator('[data-plan-count="0"]').fill('4');
  await page.locator('[data-edit-action="save-resume"]').click();
  await page.waitForFunction(() => !document.querySelector('[data-edit-action="cancel"]'));
  assert.equal(resumeRequest.resume, true);
  assert.equal(resumeRequest.config.actionPlan[0].count, 4);
  await page.unroute(`**/api/jobs/${jobId}/edit`);
  const cursor = JSON.parse(local.prepare('SELECT cursor_json FROM jobs WHERE id=?').get(jobId).cursor_json);
  local.prepare('UPDATE jobs SET paused_by_user=0,wait_reason=?,cursor_json=? WHERE id=?').run('网络中断，任务已自动暂停，正在检测恢复', JSON.stringify({ ...cursor, networkRecovery: { state: 'offline', lastCheckedAt: stamp } }), jobId);
  await page.reload();
  await page.getByRole('button', { name: '改为手动暂停', exact: true }).waitFor();
  assert.match(await page.locator('#run-detail').innerText(), /连续两次连通/);
  local.close(); await page.close();
});

test('任务进度百分比与进度条实时更新，手机不溢出，无任务时隐藏', async () => {
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  await page.goto(`http://127.0.0.1:${port}`);
  await page.locator('#token').fill(token); await page.getByRole('button', { name: '进入工坊' }).click();
  await page.waitForFunction(() => document.querySelector('#login')?.classList.contains('hidden'));
  const base = await page.request.get(`http://127.0.0.1:${port}/api/state`).then(r => r.json());
  const job = { id: 'progress-fixture', status: 'running', config: { rounds: 2 }, cursor: { current: { round: 0, kind: 'comment', accountName: '进度测试', topicName: '苏新皓' } }, metrics: { success: 400, failed: 39, skipped: 247 }, progress: { total: 1420, processed: 686, remaining: 734, percent: 48.3, currentRound: 1, rounds: 2, planAdjusted: false } };
  const mocked = { ...base, activeJob: job, recentJobs: [job], verification: null };
  await page.route('**/api/state', route => route.fulfill({ json: mocked }));
  await page.route('**/api/events', route => route.fulfill({ contentType: 'text/event-stream', body: `event: state\ndata: ${JSON.stringify(mocked)}\n\n` }));
  await page.reload();
  const progress = page.getByRole('progressbar', { name: '任务进度' });
  await progress.waitFor();
  assert.equal(await progress.getAttribute('aria-valuenow'), '48.3');
  assert.match(await page.locator('#run-progress').innerText(), /已处理 686 \/ 1420 项/);
  assert.match(await page.locator('#run-progress').innerText(), /当前第 1 \/ 2 轮/);
  job.status = 'paused'; job.progress = { ...job.progress, total: 1400, percent: 49, remaining: 714, planAdjusted: true };
  await page.getByRole('button', { name: '刷新', exact: true }).click();
  await page.waitForFunction(() => document.querySelector('[role="progressbar"]')?.getAttribute('aria-valuenow') === '49');
  assert.match(await page.locator('#run-progress').innerText(), /计划已调整/);
  await page.setViewportSize({ width: 390, height: 844 });
  assert.equal(await progress.isVisible(), true);
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  job.status = 'completed'; job.progress = { ...job.progress, processed: 1400, remaining: 0, percent: 100 };
  await page.reload(); await page.waitForFunction(() => document.querySelector('[role="progressbar"]')?.getAttribute('aria-valuenow') === '100');
  mocked.activeJob = null; mocked.recentJobs = [job];
  await page.reload();
  await page.getByRole('button', { name: '新建任务', exact: true }).click();
  await page.waitForTimeout(450);
  assert.equal(await page.locator('#config-card').isVisible(), true);
  assert.equal(await page.evaluate(() => /^(INPUT|SELECT|BUTTON)$/.test(document.activeElement?.tagName || '')), true);
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  mocked.recentJobs = [];
  await page.reload(); await page.locator('#run-progress[hidden]').waitFor({ state: 'attached' });
  assert.equal(await page.locator('#run-progress').isVisible(), false);
  await page.close();
});

async function waitForServer() {
  const deadline = Date.now() + 8000;
  while (Date.now() < deadline) {
    const ok = await new Promise(resolve => {
      const req = http.get(`http://127.0.0.1:${port}/api/session`, response => { response.resume(); resolve(response.statusCode === 200); });
      req.on('error', () => resolve(false));
    });
    if (ok) return;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error('测试服务器启动超时');
}
test('工作台一屏显示、三标签原位切换与不保存直接运行', async () => {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  let posted = null;
  try {
    await page.request.post('http://127.0.0.1:' + port + '/api/login', { data: { token } });
    await page.request.post('http://127.0.0.1:' + port + '/api/accounts', { data: {} });
    await page.request.post('http://127.0.0.1:' + port + '/api/topics', { data: { name: '面板超话' + Date.now(), url: 'https://weibo.com/p/100808panel/super_index' } });
    await page.route('**/api/jobs', route => {
      if (route.request().method() !== 'POST') return route.continue();
      posted = route.request().postDataJSON();
      return route.fulfill({ status: 201, json: { job: { id: 'new-job' } } });
    });
    await page.goto('http://127.0.0.1:' + port);
    await page.waitForTimeout(900);
    const box = await page.evaluate(() => ({ doc: document.documentElement.scrollHeight, vh: innerHeight, overflow: document.documentElement.scrollWidth > innerWidth }));
    assert.equal(box.overflow, false);
    const heightOf = () => page.locator('#config-card').evaluate(n => Math.round(n.getBoundingClientRect().height));
    const rangeHeight = await heightOf();
    await page.locator('.config-tabs [data-pane="plan"]').click();
    const planHeight = await heightOf();
    await page.locator('.config-tabs [data-pane="advanced"]').click();
    const advancedHeight = await heightOf();
    assert.ok(rangeHeight < planHeight && planHeight < advancedHeight, '配置卡应随标签内容自适应：' + [rangeHeight, planHeight, advancedHeight].join('/'));
    assert.ok(rangeHeight <= 200 && advancedHeight >= 300, '范围页应很矮、高级页最高：' + [rangeHeight, advancedHeight].join('/'));
    assert.equal(await page.locator('#page-overview .config-head .template-group').count(), 1);
    await page.locator('.config-tabs [data-pane="range"]').click();
    assert.equal(await page.locator('#nav [data-page="topics"]').count(), 0);
    assert.match(await page.locator('.brand-sub').innerText(), /信号灯偷懒神器/);
    await page.locator('#pick-accounts').click();
    await page.locator('#picker-all').click();
    await page.locator('#picker-confirm').click();
    await page.locator('.config-tabs [data-pane="plan"]').click();
    while (await page.locator('[data-plan-action="delete"]').count() > 1) await page.locator('[data-plan-action="delete"]').last().click();
    await page.locator('[data-plan-type="0"]').selectOption('checkin');
    await page.locator('[data-plan-interval="0"]').fill('7');
    await page.locator('.config-tabs [data-pane="advanced"]').click();
    assert.equal(await page.locator('#rounds').isVisible(), true);
    await page.locator('#rounds').fill('2');
    await page.locator('.config-tabs [data-pane="range"]').click();
    await page.locator('.config-tabs [data-pane="plan"]').click();
    assert.equal(await page.locator('[data-plan-interval="0"]').inputValue(), '7');
    await page.locator('#start-task').click();
    await page.waitForTimeout(800);
    assert.ok(posted, '点击开始运行应立即提交，实际提示：' + await page.locator('#task-errors').innerText());
    assert.equal(Number(posted.rounds), 2);
    assert.equal(Number(posted.actionPlan[0].intervalSeconds), 7);
    await page.setViewportSize({ width: 390, height: 844 });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    assert.equal(await page.locator('#mobile-nav').getByRole('button', { name: '超话工作台' }).count(), 1);
  } finally { await page.close(); }
});

test('最近运行点开可看返链与回执，且一次只展开一条', async () => {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const stamp = new Date().toISOString();
  const db = new DatabaseSync(path.join(tempDir, 'console.sqlite'));
  try {
    await page.request.post('http://127.0.0.1:' + port + '/api/login', { data: { token } });
    db.prepare('INSERT OR REPLACE INTO jobs(id,status,config_json,cursor_json,metrics_json,created_at,updated_at) VALUES(?,?,?,?,?,?,?)').run('recent-fixture', 'completed', '{}', '{}', '{}', stamp, stamp);
    db.prepare("INSERT OR REPLACE INTO action_logs(id,job_id,step_key,kind,account_id,state,url,receipt_id,content,started_at,completed_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)").run('recent-a1', 'recent-fixture', '0:1', 'post', null, 'succeeded', 'https://weibo.com/1/abc', '998877', '测试文案', stamp, stamp);
    db.prepare("INSERT OR REPLACE INTO action_logs(id,job_id,step_key,kind,account_id,state,error,started_at,completed_at) VALUES(?,?,?,?,?,?,?,?,?)").run('recent-a2', 'recent-fixture', '0:2', 'comment', null, 'failed', '评论失败原因', stamp, stamp);
    db.close();
    await page.goto('http://127.0.0.1:' + port);
    await page.waitForTimeout(1200);
    await page.locator('.recent-row').first().waitFor();
    await page.locator('.recent-row').filter({ hasText: '发帖' }).first().click();
    await page.locator('.recent-detail').first().waitFor();
    assert.equal(await page.locator('.recent-detail a').first().getAttribute('href'), 'https://weibo.com/1/abc');
    assert.match(await page.locator('.recent-detail').first().innerText(), /998877/);
    await page.locator('.recent-row').filter({ hasText: '评论' }).first().click();
    assert.equal(await page.locator('.recent-detail').count(), 1);
    assert.match(await page.locator('.recent-detail').innerText(), /无返链/);
  } finally { await page.close(); }
});
test('状态条可按日期查看成功数字并可回到今天', async () => {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  try {
    await page.request.post('http://127.0.0.1:' + port + '/api/login', { data: { token } });
    await page.route('**/api/records?*', route => {
      const date = new URL(route.request().url()).searchParams.get('date');
      const counts = date === '2026-10-21' ? { date, checkin: 3, post: 4, comment: 5 } : { date, checkin: 72, post: 69, comment: 800 };
      return route.fulfill({ json: { date, logs: [], actions: [], jobs: [], rounds: [], dailySuccess: counts, recordView: null } });
    });
    await page.goto('http://127.0.0.1:' + port);
    await page.waitForTimeout(900);
    await page.locator('#daily-date-button').click();
    assert.equal(await page.locator('#daily-date-popover').isVisible(), true);
    await page.locator('#daily-date').fill('2026-10-21');
    await page.locator('#daily-date').dispatchEvent('change');
    await page.waitForTimeout(500);
    assert.equal(await page.locator('#daily-date-button').innerText(), '10/21');
    assert.equal(await page.locator('[data-daily-kind="comment"]').innerText(), '5');
    await page.locator('#daily-date-button').click();
    await page.locator('#daily-today').click();
    await page.waitForTimeout(300);
    assert.equal(await page.locator('#daily-date-button').innerText(), '今日');
    assert.equal(await page.locator('#daily-date-popover').isVisible(), false);
  } finally { await page.close(); }
});

test('验证队列显示完成/总数，按状态排序且点开不跳回顶部', async () => {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  try {
    await page.request.post('http://127.0.0.1:' + port + '/api/login', { data: { token } });
    const base = await page.request.get('http://127.0.0.1:' + port + '/api/state').then(r => r.json());
    const card = (i, status, extra = {}) => ({ identity: 'p' + i, name: '账号' + String(i).padStart(2, '0'), uid: '9000' + i, status, source: 'verification_detected', reason: '需要验证', checkinResult: status === 'resolved' ? 'succeeded' : 'pending', remainingStepCount: status === 'resolved' ? 0 : 1, visible: true, steps: status === 'resolved' ? [] : [{ key: 's' + i, kind: 'checkin', topicId: 't', topicName: '主题', state: 'deferred', outcome: null, actionId: null, needsReview: false, reason: '' }], ...extra });
    const cards = [];
    for (let i = 0; i < 10; i++) cards.push(card(i, 'pending'));
    for (let i = 10; i < 20; i++) cards.push(card(i, 'ready'));
    for (let i = 20; i < 30; i++) cards.push(card(i, 'resolved'));
    const mocked = { ...base, activeJob: null, recentJobs: [], verification: { jobId: 'v', round: 0, jobStatus: 'waiting', cards, session: null, barrier: true, canContinue: false } };
    await page.route('**/api/state', route => route.fulfill({ json: mocked }));
    await page.route('**/api/events', route => route.fulfill({ contentType: 'text/event-stream', body: '' }));
    await page.goto('http://127.0.0.1:' + port);
    await page.waitForTimeout(900);
    assert.equal(await page.locator('#verification-panel .verify-count').innerText(), '10/30');
    const names = await page.locator('.verify-row b').allTextContents();
    assert.equal(names[0], '账号00');
    assert.equal(names[names.length - 1], '账号29');
    const scroller = page.locator('#verification-panel .verify-rows');
    await scroller.evaluate(el => { el.scrollTop = 250; });
    const before = await scroller.evaluate(el => el.scrollTop);
    assert.ok(before > 0);
    await page.locator('.verify-row [data-verify-toggle]').nth(8).click();
    await page.waitForTimeout(200);
    const after = await scroller.evaluate(el => el.scrollTop);
    assert.equal(Math.abs(after - before) <= 2, true, '重渲染后应保持滚动位置，' + before + ' -> ' + after);
  } finally { await page.close(); }
});
test('圆点勾选、装饰两行、横卡添加固定与最近运行 20 条', async () => {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const stamp = new Date().toISOString();
  try {
    await page.request.post('http://127.0.0.1:' + port + '/api/login', { data: { token } });
    const base = await page.request.get('http://127.0.0.1:' + port + '/api/state').then(r => r.json());
    const job = { id: 'v4-fixture', status: 'completed', config: { rounds: 1 }, cursor: {}, metrics: { success: 1, failed: 0, uncertain: 0, skipped: 0 } };
    const actions = Array.from({ length: 20 }, (_, i) => ({ id: 'r' + i, account_name: '账号' + i, kind: 'post', state: 'succeeded', started_at: stamp, content: '文案', url: 'https://weibo.com/' + i, receipt_id: String(i) }));
    const mocked = {
      ...base,
      activeJob: null,
      recentJobs: [job],
      verification: null,
      recentActions: actions,
      taskDefaults: { ...base.taskDefaults, accountIds: base.accounts.filter(a => a.enabled).map(a => a.id), actionPlan: [{ type: 'checkin', count: 1, intervalSeconds: 5 }, { type: 'post', count: 10, intervalSeconds: 10 }, { type: 'comment', count: 10, intervalSeconds: 10 }, { type: 'post', count: 2, intervalSeconds: 8 }] },
    };
    await page.route('**/api/state', route => route.fulfill({ json: mocked }));
    await page.route('**/api/events', route => route.fulfill({ contentType: 'text/event-stream', body: '' }));
    await page.goto('http://127.0.0.1:' + port);
    await page.waitForFunction(() => document.querySelector('#login')?.classList.contains('hidden'));
    await page.waitForFunction(() => document.querySelectorAll('.recent-row').length === 20);
    assert.equal(await page.locator('.recent-row').count(), 20);
    const list = page.locator('#page-overview .recent-list');
    assert.equal(await list.evaluate(el => el.scrollHeight > el.clientHeight), true);
    const header = await page.evaluate(() => [document.querySelector('#page-title').getBoundingClientRect().bottom, document.querySelector('.brand-sub').getBoundingClientRect().bottom]);
    assert.ok(Math.abs(header[0] - header[1]) <= 2, '页头两段文字底部应对齐');
    await page.locator('.config-tabs [data-pane="plan"]').click();
    assert.equal(await page.locator('.action-card').count(), 4);
    const plan = page.locator('#action-plan');
    assert.equal(await plan.evaluate(el => el.scrollWidth > el.clientWidth), true);
    const addBefore = await page.locator('#add-action').boundingBox();
    await plan.evaluate(el => { el.scrollLeft = 200; });
    const addAfter = await page.locator('#add-action').boundingBox();
    assert.ok(Math.abs(addBefore.x - addAfter.x) <= 1 && Math.abs(addBefore.y - addAfter.y) <= 1, '添加一段按钮应固定');
    await page.locator('.config-tabs [data-pane="advanced"]').click();
    assert.equal(await page.locator('#page-overview .deco-row').count(), 2);
    assert.equal(await page.locator('#toggle-decorations').count(), 0);
    if (await page.locator('#page-overview .deco-row label.off').count()) assert.equal(await page.locator('#page-overview .deco-row label.off').first().evaluate(el => getComputedStyle(el).opacity), '1');
    const dot = await page.locator('#sync-to-home').evaluate(el => { el.checked = true; const s = getComputedStyle(el); return { radius: s.borderRadius, bg: s.backgroundColor }; });
    assert.equal(dot.radius, '50%');
    assert.equal(dot.bg, 'rgb(125, 23, 49)');
  } finally { await page.close(); }
});
test('模板只保存操作与高级参数，不含账号与范围', async () => {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  let templateId;
  try {
    await page.request.post('http://127.0.0.1:' + port + '/api/login', { data: { token } });
    const state = await page.request.get('http://127.0.0.1:' + port + '/api/state').then(r => r.json());
    const accountIds = state.accounts.slice(0, 3).map(a => a.id);
    const created = await page.request.post('http://127.0.0.1:' + port + '/api/task-templates', {
      data: { name: '白名单测试', config: { ...state.taskDefaults, accountIds, topicIds: ['topic_x'], postGroupIds: ['mg_fixture'], commentGroupIds: ['mg_fixture'], actionPlan: [{ type: 'checkin', count: 2, intervalSeconds: 4 }], rounds: 3, scanLimit: 45 } },
    });
    assert.equal(created.status(), 201);
    const template = await created.json(); templateId = template.id;
    assert.equal(template.config.accountIds, undefined);
    assert.equal(template.config.topicIds, undefined);
    assert.equal(template.config.rounds, 3);
    assert.equal(template.config.scanLimit, 45);
    assert.deepEqual(template.config.postGroupIds, ['mg_fixture']);
    assert.deepEqual(template.config.commentGroupIds, ['mg_fixture']);
    assert.equal(template.config.actionPlan[0].type, 'checkin');
    const refreshed = await page.request.get('http://127.0.0.1:' + port + '/api/state').then(r => r.json());
    const listed = (refreshed.taskTemplates || []).find(item => item.id === templateId);
    assert.ok(listed);
    assert.equal(listed.config.accountIds, undefined);
  } finally {
    if (templateId) await page.request.delete('http://127.0.0.1:' + port + '/api/task-templates/' + templateId);
    await page.close();
  }
});

test('账号拖拽排序、禁言筛选与文案分组全文弹窗可用', async () => {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const api = async (method, pathname, data) => {
    const url = `http://127.0.0.1:${port}${pathname}`;
    const call = { GET: () => page.request.get(url), POST: () => page.request.post(url, { data }), PATCH: () => page.request.patch(url, { data }) }[method];
    const response = await call();
    assert.ok(response.ok(), await response.text());
    return response.json();
  };
  try {
    await page.request.post(`http://127.0.0.1:${port}/api/login`, { data: { token } });
    const first = await api('POST', '/api/accounts', {});
    const second = await api('POST', '/api/accounts', {});
    await api('PATCH', `/api/accounts/${first.id}`, { name: '拖拽甲', sortOrder: 0 });
    await api('PATCH', `/api/accounts/${second.id}`, { name: '拖拽乙', sortOrder: 1 });
    const restrictionDb = new DatabaseSync(path.join(tempDir, 'console.sqlite'));
    restrictionDb.prepare('INSERT INTO account_restrictions(account_id,type,kind,identity,reason,detected_at,expires_at,job_id) VALUES(?,?,?,?,?,?,?,?)')
      .run(first.id, 'frequent', 'comment', '', '测试频繁', new Date().toISOString(), new Date(Date.now() + 3600000).toISOString(), '');
    restrictionDb.close();

    await page.goto(`http://127.0.0.1:${port}`);
    await page.locator('#nav [data-page="accounts"]').click();
    await page.locator('#account-search').fill('拖拽');
    await page.waitForTimeout(200);
    assert.equal(await page.locator('#account-list .account-row .result.warning').count(), 1);
    assert.equal((await page.locator('#account-list .account-row .result.warning').innerText()).trim(), '频繁');
    const rows = page.locator('#account-list .account-row:not(.hidden)');
    assert.equal(await rows.count(), 2);
    const source = await rows.nth(1).locator('[data-drag-account]').boundingBox();
    const target = await rows.nth(0).boundingBox();
    await page.mouse.move(source.x + source.width / 2, source.y + source.height / 2);
    await page.mouse.down();
    await page.mouse.move(target.x + 8, target.y + target.height / 2, { steps: 6 });
    await page.mouse.up();
    await page.waitForTimeout(600);
    const reordered = await page.request.get(`http://127.0.0.1:${port}/api/state`).then(r => r.json());
    const order = reordered.accounts.map(item => item.id);
    assert.ok(order.indexOf(second.id) < order.indexOf(first.id), '拖拽后乙应排在甲之前');

    const box = await rows.nth(0).locator('input[type=checkbox]').evaluate(node => {
      const style = getComputedStyle(node);
      return { width: style.width, height: style.height, radius: style.borderRadius, ratio: node.getBoundingClientRect().width / node.getBoundingClientRect().height };
    });
    assert.equal(box.width, '16px');
    assert.equal(box.height, '16px');
    assert.equal(box.radius, '50%');
    assert.ok(Math.abs(box.ratio - 1) < 0.02);

    await page.locator('#account-status-chips [data-account-status="muted"]').click();
    assert.equal(await page.locator('#account-list .account-row:not(.hidden)').count(), 0);
    await page.locator('#account-status-chips [data-account-status="limited"]').click();
    assert.equal(await page.locator('#account-list .account-row:not(.hidden)').count(), 1);
    await page.locator('#account-status-chips [data-account-status="all"]').click();

    page.once('dialog', dialog => dialog.accept());
    await page.locator('[data-account-action="clear-restriction"]').click();
    await page.waitForFunction(() => !document.querySelector('#account-list .result.warning'));
    const clearedState = await page.request.get(`http://127.0.0.1:${port}/api/state`).then(r => r.json());
    assert.equal(clearedState.restrictedAccounts.length, 0);

    await page.locator('#nav [data-page="materials"]').click();
    page.once('dialog', dialog => dialog.accept('测试组'));
    await page.locator('#new-material-group').click();
    await page.waitForFunction(() => document.querySelector('#material-group-filter')?.options.length > 1);
    const group = await page.request.get(`http://127.0.0.1:${port}/api/material-groups`).then(r => r.json()).then(items => items.at(-1));
    assert.ok(group?.id);
    await page.locator('#material-add-group').selectOption(group.id);
    await page.locator('#material-texts').fill('分组发帖甲\n分组发帖乙');
    await page.locator('#material-add').click();
    await page.waitForTimeout(400);
    await page.locator('#material-group-filter').selectOption(group.id);
    await page.waitForTimeout(200);
    assert.equal(await page.locator('#material-list .material-row').count(), 2);
    const line = await page.locator('#material-list .material-text').first().evaluate(node => ({ white: getComputedStyle(node).whiteSpace, overflow: getComputedStyle(node).textOverflow }));
    assert.equal(line.white, 'nowrap');
    assert.equal(line.overflow, 'ellipsis');
    await page.locator('#material-list .material-text').first().click();
    await page.locator('#material-dialog[open]').waitFor();
    assert.match(await page.locator('#material-dialog-body').innerText(), /分组发帖/);
    await page.locator('[data-close-material]').first().click();

    await page.locator('[data-manage-groups]').click();
    page.once('dialog', dialog => dialog.accept());
    await page.locator(`[data-delete-material-group="${group.id}"]`).click();
    await page.waitForFunction(() => document.querySelector('#material-group-filter')?.options.length === 1);
  } finally {
    await page.close();
  }
});

test('登录页头像、文案分段标签与移动分组操作条可用', async () => {
  const page = await browser.newPage({ viewport: { width: 711, height: 924 } });
  const base = `http://127.0.0.1:${port}`;
  try {
    await page.goto(base);
    await page.waitForTimeout(250);
    const login = await page.evaluate(() => {
      const avatar = document.querySelector('.login-avatar');
      const button = document.querySelector('#login-form .primary.wide');
      const token = document.querySelector('#token');
      const error = document.querySelector('#login-error');
      const rect = avatar.getBoundingClientRect();
      return {
        width: rect.width, height: rect.height, radius: getComputedStyle(avatar).borderRadius,
        fit: getComputedStyle(avatar).objectFit, text: document.querySelector('#login-form p').textContent,
        buttonRadius: getComputedStyle(button).borderRadius, inputMargin: getComputedStyle(token).marginBottom,
        errorHeight: error.getBoundingClientRect().height, errorDisplay: getComputedStyle(error).display
      };
    });
    assert.equal(login.width, 64);
    assert.equal(login.height, 64);
    assert.equal(login.radius, '50%');
    assert.equal(login.fit, 'cover');
    assert.equal(login.text, '输入开发者提供的口令');
    assert.equal(login.buttonRadius, '12px');
    assert.equal(login.inputMargin, '9px');
    assert.equal(login.errorHeight, 0);
    assert.equal(login.errorDisplay, 'none');

    await page.locator('#token').fill('wrong-token');
    await page.getByRole('button', { name: '进入工坊' }).click();
    await page.waitForTimeout(350);
    assert.match(await page.locator('#login-error').innerText(), /口令/);
    assert.ok((await page.locator('#login-error').boundingBox()).height > 0);

    await page.setViewportSize({ width: 1440, height: 900 });
    await page.locator('#token').fill(token);
    await page.getByRole('button', { name: '进入工坊' }).click();
    await page.waitForTimeout(800);
    await page.request.post(base + '/api/login', { data: { token } });
    await page.request.post(base + '/api/post-materials', { data: { texts: ['v7 测试文案甲', 'v7 测试文案乙'], groupId: '' } });
    await page.reload();
    await page.waitForTimeout(700);
    await page.locator('#nav [data-page="materials"]').click();
    await page.waitForTimeout(250);
    const tabs = await page.evaluate(() => {
      const track = document.querySelector('#material-tabs');
      const on = track.querySelector('button.on');
      const off = track.querySelector('button:not(.on)');
      return { track: getComputedStyle(track).backgroundColor, padding: getComputedStyle(track).padding, gap: getComputedStyle(track).gap, on: getComputedStyle(on).backgroundColor, off: getComputedStyle(off).backgroundColor };
    });
    assert.equal(tabs.track, 'rgb(251, 238, 242)');
    assert.equal(tabs.padding, '3px');
    assert.equal(tabs.gap, '2px');
    assert.equal(tabs.on, 'rgb(255, 255, 255)');
    assert.equal(tabs.off, 'rgba(0, 0, 0, 0)');

    const visibleCount = await page.locator('#material-list .material-row').count();
    await page.locator('[data-select-all-material-btn]').click();
    await page.waitForFunction(count => document.querySelector('#material-move-label')?.textContent === `已选 ${count} 条`, visibleCount);
    assert.equal(await page.locator('[data-clear-material-btn]').isDisabled(), false);
    await page.locator('[data-clear-material-btn]').click();
    await page.waitForFunction(() => document.querySelector('#material-move-bar')?.classList.contains('hidden'));
    assert.equal(await page.locator('[data-clear-material-btn]').isDisabled(), true);
    assert.equal(await page.locator('[data-bulk-material-btn]').isDisabled(), true);

    const group = await page.request.post(base + '/api/material-groups', { data: { name: 'v7移动组', type: 'post' } }).then(r => r.json());
    await page.reload();
    await page.waitForTimeout(700);
    await page.locator('#nav [data-page="materials"]').click();
    await page.waitForTimeout(250);
    const ids = await page.locator('#material-list input[type=checkbox]').evaluateAll(nodes => nodes.slice(0, 2).map(node => node.dataset.id));
    await page.locator('#material-list input[type=checkbox]').nth(0).check();
    await page.locator('#material-list input[type=checkbox]').nth(1).check();
    await page.waitForFunction(() => document.querySelector('#material-move-label')?.textContent === '已选 2 条');
    assert.equal(await page.locator('#material-move-apply').isDisabled(), true);
    await page.locator('#material-move-target').selectOption(group.id);
    assert.equal(await page.locator('#material-move-apply').isDisabled(), false);
    await page.locator('#material-move-apply').click();
    await page.waitForFunction(() => document.querySelector('#toast')?.textContent.includes('已移动 2 条'));
    const movedState = await page.request.get(base + '/api/state').then(r => r.json());
    assert.deepEqual(movedState.posts.filter(item => ids.includes(item.id)).map(item => item.group_id), [group.id, group.id]);
    assert.equal(await page.locator('#material-move-bar').evaluate(node => node.classList.contains('hidden')), true);

    for (let index = 0; index < 12; index++) {
      const createdGroup = await page.request.post(base + '/api/material-groups', { data: { name: `v7超长分组名称第${index}号`, type: 'post' } });
      assert.equal(createdGroup.status(), 201, await createdGroup.text());
      const commentGroup = await page.request.post(base + '/api/material-groups', { data: { name: `v7评论独立组第${index}号`, type: 'comment' } });
      assert.equal(commentGroup.status(), 201);
    }
    await page.reload();
    await page.waitForTimeout(700);
    await page.locator('.config-tabs [data-pane="advanced"]').click();
    await page.waitForTimeout(250);
    const groupDebug = await page.evaluate(async () => {
      const data = await fetch('/api/state').then(response => response.json());
      return { api: (data.materialGroups || []).filter(group => ['post','comment'].includes(group.type)).length, dom: document.querySelectorAll('#material-group-picks .check-inline').length };
    });
    assert.equal(groupDebug.dom, groupDebug.api, JSON.stringify(groupDebug));
    const template = await page.evaluate(() => [...document.querySelectorAll('#page-overview .template-group select, #page-overview .template-group button')].map(node => {
      const rect = node.getBoundingClientRect();
      return { top: rect.top, bottom: rect.bottom, height: rect.height };
    }));
    assert.ok(Math.max(...template.map(item => item.top)) - Math.min(...template.map(item => item.top)) <= 1);
    assert.ok(Math.max(...template.map(item => item.bottom)) - Math.min(...template.map(item => item.bottom)) <= 1);
    assert.ok(template.every(item => item.height === 34));
    const picks = await page.evaluate(() => [...document.querySelectorAll('#material-group-picks .pick-row')].map(row => ({ clientWidth: row.clientWidth, scrollWidth: row.scrollWidth, overflowX: getComputedStyle(row).overflowX, wrap: getComputedStyle(row).flexWrap })));
    assert.ok(picks.every(row => row.scrollWidth > row.clientWidth && row.overflowX === 'auto' && row.wrap === 'nowrap'), JSON.stringify(picks));

    await page.setViewportSize({ width: 375, height: 844 });
    await page.locator('#mobile-nav [data-page="materials"]').click();
    await page.waitForTimeout(250);
    await page.locator('#material-list input[type=checkbox]').nth(0).check();
    await page.locator('#material-list input[type=checkbox]').nth(1).check();
    await page.waitForTimeout(150);
    const mobile = await page.evaluate(() => {
      const bar = document.querySelector('#material-move-bar').getBoundingClientRect();
      const nav = document.querySelector('#mobile-nav').getBoundingClientRect();
      return { overflow: document.documentElement.scrollWidth - innerWidth, barBottom: bar.bottom, navTop: nav.top };
    });
    assert.equal(mobile.overflow, 0);
    assert.ok(mobile.barBottom <= mobile.navTop);
  } finally {
    await page.close();
  }
});

test('桌面四页页头统一紧凑，后三页填满可用高度', async () => {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const base = `http://127.0.0.1:${port}`;
  try {
    await page.request.post(base + '/api/login', { data: { token } });
    await page.request.post(base + '/api/accounts', { data: {} });
    await page.goto(base);
    await page.waitForFunction(() => document.querySelectorAll('#account-list .account-row').length > 0);
    const measure = () => page.evaluate(() => {
      const box = selector => {
        const node = document.querySelector(selector);
        if (!node) return null;
        const rect = node.getBoundingClientRect();
        return { top: Math.round(rect.top), bottom: Math.round(rect.bottom), height: Math.round(rect.height) };
      };
      return {
        topbar: box('#main-content > header.topbar'),
        titleFont: getComputedStyle(document.querySelector('#page-title')).fontSize,
        page: box('.page.active'), pageDisplay: getComputedStyle(document.querySelector('.page.active')).display,
        list: box('#account-list'), panel: box('.material-panel'), grid: box('#record-grid'),
        panels: [...document.querySelectorAll('.record-panel')].map(node => Math.round(node.getBoundingClientRect().height)),
        doc: document.documentElement.scrollHeight, overflow: document.documentElement.scrollWidth - innerWidth
      };
    });
    const pages = {};
    for (const name of ['overview', 'accounts', 'materials', 'logs']) {
      await page.evaluate(pageName => document.querySelector(`[data-page="${pageName}"]`)?.click(), name);
      await page.waitForTimeout(250);
      pages[name] = await measure();
    }
    for (const [name, data] of Object.entries(pages)) {
      assert.ok(Math.abs(data.topbar.height - 76) <= 1, `${name} 页头应约 76px，实际 ${data.topbar.height}`);
      assert.equal(data.titleFont, '30px', `${name} 标题字号`);
      assert.equal(data.overflow, 0, `${name} 不应横向溢出`);
    }
    assert.equal(pages.accounts.page.height, 734);
    assert.equal(pages.accounts.list.bottom, pages.accounts.page.bottom);
    assert.equal(pages.materials.page.height, 734);
    assert.ok(Math.abs(pages.logs.page.bottom - 890) <= 4, `记录页底部应约 890px，实际 ${pages.logs.page.bottom}`);
    assert.equal(pages.logs.grid.bottom, pages.logs.page.bottom);
    assert.ok(Math.abs(pages.logs.grid.height - 654) <= 4);
    assert.ok(pages.logs.panels.every(height => Math.abs(height - 321) <= 3));
    assert.ok(pages.logs.doc <= 904);

    await page.setViewportSize({ width: 1280, height: 800 });
    await page.waitForTimeout(250);
    const compact = await measure();
    assert.equal(compact.grid.height, 554);
    assert.ok(compact.panels.every(height => Math.abs(height - 271) <= 1));
    assert.ok(compact.doc <= 804);

    await page.setViewportSize({ width: 375, height: 844 });
    await page.waitForTimeout(250);
    const mobile = await measure();
    assert.equal(mobile.overflow, 0);
    assert.ok(mobile.topbar.height <= 82);
    assert.notEqual(mobile.pageDisplay, 'flex');
  } finally {
    await page.close();
  }
});

test('文案不足弹窗拦截开始，补足后可提交', async () => {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const base = `http://127.0.0.1:${port}`;
  let posted = null;
  try {
    await page.request.post(base + '/api/login', { data: { token } });
    await page.request.post(base + '/api/accounts', { data: {} });
    await page.request.post(base + '/api/topics', { data: { name: '文案弹窗超话' + Date.now(), url: 'https://weibo.com/p/100808v10/super_index' } });
    await page.request.put(base + '/api/settings/task', { data: { actionPlan: [{ type: 'post', count: 1, intervalSeconds: 1 }, { type: 'comment', count: 1, intervalSeconds: 1 }], rounds: 1, roundIntervalSeconds: 0 } });
    const postOne = await page.request.post(base + '/api/material-groups', { data: { name: 'v10单条发帖', type: 'post' } }).then(r => r.json());
    const postTwo = await page.request.post(base + '/api/material-groups', { data: { name: 'v10两条发帖', type: 'post' } }).then(r => r.json());
    const commentGroup = await page.request.post(base + '/api/material-groups', { data: { name: 'v10评论组', type: 'comment' } }).then(r => r.json());
    await page.request.post(base + '/api/post-materials', { data: { texts: ['v10 单条发帖'], groupId: postOne.id } });
    await page.request.post(base + '/api/post-materials', { data: { texts: ['v10 发帖甲', 'v10 发帖乙'], groupId: postTwo.id } });
    await page.request.post(base + '/api/comment-materials', { data: { texts: ['v10 评论甲', 'v10 评论乙'], groupId: commentGroup.id } });
    await page.goto(base);
    await page.waitForFunction(() => document.querySelectorAll('#account-list .account-row').length > 0);
    await page.locator('#nav [data-page="materials"]').click();
    assert.equal(await page.locator('#material-hint').count(), 0);
    await page.locator('#nav [data-page="overview"]').click();
    await page.locator('.config-tabs [data-pane="advanced"]').click();
    await page.waitForTimeout(250);
    const pickValues = await page.locator('[data-material-group-pick]').evaluateAll(nodes => nodes.map(node => node.value));
    assert.ok(pickValues.includes(postOne.id), JSON.stringify({ postOne, pickValues }));
    for (const box of await page.locator('[data-material-group-pick="postGroupIds"]').all()) await box.uncheck();
    for (const box of await page.locator('[data-material-group-pick="commentGroupIds"]').all()) await box.uncheck();
    await page.locator(`[data-material-group-pick="postGroupIds"][value="${postOne.id}"]`).check();
    await page.locator(`[data-material-group-pick="commentGroupIds"][value="${commentGroup.id}"]`).check();
    await page.route('**/api/jobs', route => {
      if (route.request().method() !== 'POST') return route.continue();
      posted = route.request().postDataJSON();
      return route.fulfill({ status: 201, json: { job: { id: 'v10-job' } } });
    });
    await page.locator('#start-task').click();
    await page.locator('#material-shortage-dialog[open]').waitFor();
    assert.match(await page.locator('#material-shortage-body').innerText(), /发帖文案/);
    assert.match(await page.locator('#material-shortage-body').innerText(), /1 条/);
    assert.equal(posted, null);
    await page.locator('[data-go-material-groups]').click();
    assert.equal(await page.locator('#material-shortage-dialog').evaluate(node => node.open), false);
    assert.equal(await page.locator('#material-group-picks').isVisible(), true);
    await page.locator(`[data-material-group-pick="postGroupIds"][value="${postTwo.id}"]`).check();
    await page.locator('#start-task').click();
    await page.waitForTimeout(600);
    assert.ok(posted, '补足文案后应提交任务');
  } finally {
    await page.close();
  }
});

test('第一页手机访问按钮打开二维码对话框', async () => {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const base = `http://127.0.0.1:${port}`;
  try {
    await page.request.post(base + '/api/login', { data: { token } });
    await page.goto(base);
    await page.waitForTimeout(700);
    const lanState = await page.request.get(base + '/api/state').then(r => r.json()).then(data => data.lanAccess || {});
    assert.equal(await page.locator('#lan-access-button').isVisible(), true);
    await page.locator('#lan-access-button').click();
    await page.locator('#lan-access-dialog[open]').waitFor();
    await page.waitForFunction(hasQr => hasQr
      ? document.querySelector('#lan-qr')?.getAttribute('src')?.startsWith('/api/lan-qr.svg?ts=')
      : document.querySelector('#lan-qr')?.hidden, Boolean(lanState.qrUrl));
    assert.match(await page.locator('#lan-ip-url').innerText(), /^http:\/\/\d+\.\d+\.\d+\.\d+:\d+$/);
    assert.match(await page.locator('#lan-host-url').innerText(), /\.local:\d+$/);
    if (lanState.qrUrl) assert.match(await page.locator('#lan-qr').getAttribute('src'), /^\/api\/lan-qr\.svg\?ts=/);
    else assert.equal(await page.locator('#lan-qr').isHidden(), true);
    assert.match(await page.locator('.lan-note').innerText(), /Honor 100 Pro/);
    const beforeQr = await page.locator('#lan-qr').getAttribute('src');
    await page.locator('#lan-refresh').click();
    await page.waitForTimeout(250);
    if (lanState.qrUrl) assert.notEqual(await page.locator('#lan-qr').getAttribute('src'), beforeQr);
    const qr = await page.request.get(base + '/api/lan-qr.svg');
    assert.equal(qr.status(), lanState.qrUrl ? 200 : 404);
    if (lanState.qrUrl) assert.match(qr.headers()['content-type'], /image\/svg\+xml/);
    assert.match(await qr.text(), /<svg/);
    await page.locator('[data-close-lan]').first().click();
    await page.locator('#nav [data-page="accounts"]').click();
    assert.equal(await page.locator('#lan-access-button').isVisible(), false);
    await page.setViewportSize({ width: 375, height: 844 });
    await page.locator('#mobile-nav [data-page="overview"]').click();
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  } finally {
    await page.close();
  }
});

test('账号停用启用行内标签即时变化且无长 ID 结果', async () => {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const base = `http://127.0.0.1:${port}`;
  try {
    await page.request.post(base + '/api/login', { data: { token } });
    const account = await page.request.post(base + '/api/accounts', { data: {} }).then(r => r.json());
    await page.request.patch(base + '/api/accounts/' + account.id, { data: { name: '行内启停测试' } });
    await page.goto(base);
    await page.locator('#nav [data-page="accounts"]').click();
    await page.waitForFunction(id => Boolean(document.querySelector(`[data-account-id="${id}"]`)), account.id);
    await page.locator('#account-search').fill('行内启停测试');
    await page.waitForTimeout(150);
    const row = page.locator(`#account-list .account-row[data-account-id="${account.id}"]`);
    assert.equal(await page.locator('#account-operation-results').count(), 0);
    await row.locator('[data-account-action="toggle"]').click();
    await row.locator('.account-disabled-pill').waitFor();
    assert.equal(await row.getAttribute('data-enabled'), '0');
    assert.equal(await row.locator('[data-account-action="toggle"]').innerText(), '启用');
    await row.locator('[data-account-action="toggle"]').click();
    await page.waitForFunction(id => document.querySelector(`[data-account-id="${id}"]`)?.dataset.enabled === '1', account.id);
    assert.equal(await row.locator('.account-disabled-pill').count(), 0);
    assert.equal(await row.locator('[data-account-action="toggle"]').innerText(), '停用');
  } finally {
    await page.close();
  }
});

test('扫描参数可自定义且超范围用弹窗提示', async () => {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const base = `http://127.0.0.1:${port}`;
  try {
    await page.request.post(base + '/api/login', { data: { token } });
    await page.goto(base);
    await page.waitForTimeout(800);
    await page.locator('.config-tabs [data-pane="advanced"]').click();
    await page.locator('#scan-help-button').click();
    await page.locator('#scan-help-dialog[open]').waitFor();
    assert.match(await page.locator('#scan-help-dialog').innerText(), /3–3600/);
    assert.match(await page.locator('#scan-help-dialog').innerText(), /1–500/);
    await page.locator('[data-close-scan-help]').first().click();
    await page.locator('#refresh-seconds').fill('3');
    await page.locator('#scan-limit').fill('7');
    await page.locator('#refresh-seconds').focus();
    await page.locator('#scan-limit').focus();
    await page.locator('#save-task').click();
    await page.waitForTimeout(250);
    await page.reload();
    await page.waitForTimeout(700);
    await page.locator('.config-tabs [data-pane="advanced"]').click();
    assert.equal(await page.locator('#refresh-seconds').inputValue(), '3');
    assert.equal(await page.locator('#scan-limit').inputValue(), '7');
    await page.locator('#refresh-seconds').fill('2');
    await page.locator('#scan-limit').focus();
    await page.locator('#scan-help-dialog[open]').waitFor();
    assert.match(await page.locator('#scan-help-error').innerText(), /3–3600/);
    assert.equal(await page.locator('#refresh-seconds').inputValue(), '3');
  } finally {
    await page.close();
  }
});

test('账号状态筛选只高亮当前按钮', async () => {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const base = `http://127.0.0.1:${port}`;
  try {
    await page.request.post(base + '/api/login', { data: { token } });
    await page.goto(base);
    await page.waitForTimeout(800);
    await page.locator('#nav [data-page="accounts"]').click();
    for (const [value, label] of [['muted', '禁言'], ['limited', '频繁'], ['invalid', '登录失效'], ['all', '全部']]) {
      await page.locator(`#account-status-chips [data-account-status="${value}"]`).click();
      assert.equal(await page.locator('#account-status-chips .chip.on').count(), 1, label + ' 应只有一个高亮');
      assert.equal(await page.locator('#account-status-chips .chip.on').innerText(), label);
    }
  } finally {
    await page.close();
  }
});

test('文案组默认不勾选，未勾选仍表示全部', async () => {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const base = `http://127.0.0.1:${port}`;
  try {
    await page.request.post(base + '/api/login', { data: { token } });
    const groups = [];
    for (const name of ['v13组一', 'v13组二', 'v13组三']) groups.push(await page.request.post(base + '/api/material-groups', { data: { name, type: 'post' } }).then(r => r.json()));
    await page.request.put(base + '/api/settings/task', { data: { postGroupIds: [], commentGroupIds: [] } });
    await page.goto(base);
    await page.waitForTimeout(800);
    await page.locator('.config-tabs [data-pane="advanced"]').click();
    assert.equal(await page.locator('[data-material-group-pick]:checked').count(), 0, '默认不应勾选任何组');
    const groupText = await page.locator('#material-group-picks').innerText();
    assert.ok(groupText.includes('v13组一') && groupText.includes('v13组二') && groupText.includes('v13组三'));
    assert.equal(groupText.includes('不勾选 = 全部'), false);
    await page.locator(`[data-material-group-pick="postGroupIds"][value="${groups[0].id}"]`).check();
    await page.locator('#save-task').click();
    await page.waitForTimeout(250);
    await page.reload();
    await page.waitForTimeout(700);
    await page.locator('.config-tabs [data-pane="advanced"]').click();
    assert.equal(await page.locator(`[data-material-group-pick="postGroupIds"][value="${groups[0].id}"]`).isChecked(), true);
    assert.equal(await page.locator('[data-material-group-pick="commentGroupIds"]:checked').count(), 0);
    await page.locator(`[data-material-group-pick="postGroupIds"][value="${groups[0].id}"]`).uncheck();
    await page.locator('#save-task').click();
    await page.waitForTimeout(250);
    await page.reload();
    await page.waitForTimeout(700);
    await page.locator('.config-tabs [data-pane="advanced"]').click();
    assert.equal(await page.locator('[data-material-group-pick]:checked').count(), 0);
  } finally {
    await page.close();
  }
});

test('账号页分组胶囊筛选、全选只选可见账号，管理分组打开弹窗', async () => {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const base = `http://127.0.0.1:${port}`;
  try {
    await page.request.post(base + '/api/login', { data: { token } });
    const groupA = await page.request.post(base + '/api/account-groups', { data: { name: 'v14甲组' } }).then(r => r.json());
    const groupB = await page.request.post(base + '/api/account-groups', { data: { name: 'v14乙组' } }).then(r => r.json());
    const accounts = [];
    for (let i = 0; i < 3; i++) accounts.push(await page.request.post(base + '/api/accounts', { data: {} }).then(r => r.json()));
    await page.request.post(base + '/api/accounts/group', { data: { ids: [accounts[0].id, accounts[1].id], groupId: groupA.id } });
    await page.request.post(base + '/api/accounts/group', { data: { ids: [accounts[2].id], groupId: groupB.id } });
    await page.goto(base);
    await page.waitForTimeout(800);
    await page.locator('#nav [data-page="accounts"]').click();
    await page.locator(`[data-account-group-filter="${groupA.id}"]`).waitFor();
    await page.locator(`[data-account-group-filter="${groupA.id}"]`).click();
    assert.equal(await page.locator('#account-status-chips .chip.on').count(), 1);
    assert.equal(await page.locator('#account-list .account-row:not(.hidden)').count(), 2);
    await page.locator('[data-select-accounts="all"]').click();
    assert.equal(await page.locator('#selected-account-count').innerText(), '已选 2 个');
    assert.equal(await page.locator(`#account-list .account-row[data-account-id="${accounts[2].id}"] input[data-select-account]`).isChecked(), false);
    await page.locator('[data-toggle-groups]').click();
    await page.locator('#group-manager-dialog[open]').waitFor();
    assert.equal(await page.locator('#group-manager-dialog').isVisible(), true);
    await page.locator('[data-close-group-manager]').click();
  } finally {
    await page.close();
  }
});

test('状态筛选支持停用账号且只高亮一项', async () => {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const base = `http://127.0.0.1:${port}`;
  try {
    await page.request.post(base + '/api/login', { data: { token } });
    const disabled = await page.request.post(base + '/api/accounts', { data: {} }).then(r => r.json());
    await page.request.post(base + '/api/accounts', { data: {} });
    await page.request.patch(base + '/api/accounts/' + disabled.id, { data: { enabled: false } });
    await page.goto(base);
    await page.waitForTimeout(800);
    await page.locator('#nav [data-page="accounts"]').click();
    await page.locator('#account-status-chips [data-account-status="disabled"]').click();
    assert.equal(await page.locator('#account-status-chips .chip.on').count(), 1);
    assert.equal(await page.locator('#account-status-chips .chip.on').innerText(), '停用');
    assert.equal(await page.locator(`#account-list .account-row[data-account-id="${disabled.id}"]`).isVisible(), true);
    assert.equal(await page.locator(`#account-list .account-row[data-account-id="${disabled.id}"]`).getAttribute('data-enabled'), '0');
  } finally {
    await page.close();
  }
});

test('记录页待核对操作取代账号运行卡片并可复核', async () => {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const stamp = new Date().toISOString();
  let rechecked = false;
  try {
    await page.route('**/api/records*', route => {
      const actions = rechecked ? [] : [{ id: 'u1', job_id: 'job1', kind: 'post', account_name: '待核对账号', state: 'uncertain', error: '已提交，但未取得可核实的微博编号', started_at: stamp, content: '测试文案' }];
      return route.fulfill({ json: {
        date: '2026-10-31', logs: [], actions,
        jobs: [{ id: 'job1', status: 'completed', created_at: stamp, updated_at: stamp, metrics: { success: 0, failed: 0, uncertain: 1, skipped: 0 } }], rounds: [],
        dailySuccess: { date: '2026-10-31', checkin: 0, post: 0, comment: 0 },
        dailyStats: { date: '2026-10-31', counts: { checkin: { succeeded: 0, failed: 0, uncertain: 0, skipped: 0 }, post: { succeeded: 0, failed: 0, uncertain: 1, skipped: 0 }, comment: { succeeded: 0, failed: 0, uncertain: 0, skipped: 0 } }, jobCount: 1, abnormalAccounts: 1, archived: false },
        recordView: { accounts: [], issues: [], counts: {}, jobCounts: {}, details: [], detailTotal: 0, nextCursor: null, snapshot: '', archived: false, abnormalCount: 1 }
      } });
    });
    await page.route('**/api/jobs/job1/actions/u1/recheck', route => { rechecked = true; return route.fulfill({ json: { state: 'succeeded' } }); });
    await page.request.post(`http://127.0.0.1:${port}/api/login`, { data: { token } });
    await page.goto(`http://127.0.0.1:${port}`);
    await page.locator('#nav [data-page="logs"]').click();
    await page.locator('.record-uncertain-row').waitFor();
    assert.equal(await page.locator('#record-accounts .panel-head h2').innerText(), '待核对操作');
    await page.locator('[data-recheck-action="u1"]').click();
    await page.waitForTimeout(300);
    assert.equal(rechecked, true);
    assert.equal(await page.locator('.record-uncertain-row').count(), 0);
    assert.equal(await page.locator('#record-accounts .panel-head h2').innerText(), '账号运行情况');
  } finally { await page.close(); }
});

test('页面故障自动等待与手动暂停提示明确，不显示网络正常或手动继续', async () => {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  try {
    await page.goto(`http://127.0.0.1:${port}`); await page.locator('#token').fill(token);
    const loggedIn = page.waitForResponse(response => response.url().endsWith('/api/login') && response.request().method() === 'POST');
    await page.getByRole('button', { name: '进入工坊' }).click();
    assert.equal((await loggedIn).status(), 200);
    const base = await page.request.get(`http://127.0.0.1:${port}/api/state`).then(r => r.json());
    const stamp = new Date().toISOString(); let manual = false;
    await page.route('**/api/state', route => route.fulfill({ json: { ...base, verification: null, pendingRoundReports: [],
      activeJob: { id: 'navigation-ui-fixture', status: 'paused', pausedByUser: manual, created_at: stamp, metrics: { success: 1, failed: 0 },
        config: { rounds: 1 }, wait_reason: '微博页面暂不可用，任务已暂停，正在自动检查恢复',
        cursor: { networkRecovery: { state: 'online', probeState: 'online' }, navigationRecovery: { state: 'waiting', successes: 0, nextCheckAt: stamp } } } } }));
    await page.addInitScript(() => { window.EventSource = class extends EventTarget { close() {} }; });
    await page.reload();
    await page.waitForFunction(() => document.querySelector('#run-detail')?.textContent.includes('页面暂不可用'));
    assert.match(await page.locator('#run-detail').innerText(), /连续两次页面检查/);
    assert.equal(await page.locator('#run-controls [data-job-action="resume"]').count(), 0);
    assert.match(await page.locator('#run-controls').innerText(), /改为手动暂停/);
    manual = true; await page.reload();
    await page.waitForFunction(() => document.querySelector('#run-detail')?.textContent.includes('页面恢复后不会自动开始'));
  } finally { await page.close(); }
});
