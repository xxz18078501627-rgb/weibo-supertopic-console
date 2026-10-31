// Explicit, live acceptance test. Opens the real workbench and one new local
// account, then tests that same account's native login window three times.
import fs from 'node:fs';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { config } from '../src/config.js';

const base = `http://localhost:${config.port}`;
const browser = await chromium.launch({ headless: true, executablePath: config.chromePath });
let page, accountId;
try {
  const context = await browser.newContext();
  page = await context.newPage();
  const token = fs.readFileSync(`${config.dataDir}/access-token`, 'utf8').trim();
  const login = await context.request.post(`${base}/api/login`, { data: { token } });
  assert.equal(login.status(), 200);
  const state = () => context.request.get(`${base}/api/state`).then(r => r.json());
  const initial = await state();
  assert.equal(Boolean(initial.loginSession?.active || initial.verification?.session), false, '登录或人工验证正在进行');
  const existing = new Set(initial.accounts.map(a => a.id));
  await page.goto(base);
  await page.locator('#nav [data-page="accounts"]').click();
  for (let cycle = 1; cycle <= 3; cycle++) {
    if (cycle === 1) await page.locator('#add-account').click();
    else await page.locator(`[data-account-action="login"][data-id="${accountId}"]`).click();
    let ready;
    const deadline = Date.now() + 60000;
    while (Date.now() < deadline) {
      const s = await state();
      accountId ||= s.accounts.find(a => !existing.has(a.id))?.id;
      if (s.loginSession?.active && s.loginSession.accountId === accountId && s.loginSession.qrShown) { ready = s; break; }
      if (s.loginSession?.accountId === accountId && ['failed','cancelled'].includes(s.loginSession.phase)) throw Error(JSON.stringify(s.loginSession));
      await new Promise(r => setTimeout(r, 1000));
    }
    assert.ok(ready, '二维码未能在60秒内稳定显示');
    const sid = ready.loginSession.sessionId, pid = ready.loginSession.window?.processId;
    assert.ok(pid, '无法确定实际扫码进程');
    assert.equal(ready.loginSession.window?.activated, true, '实际扫码进程未能前置');
    console.log(JSON.stringify({ event: 'qr-ready', cycle, accountId, sessionId: sid, processId: pid, window: ready.loginSession.window }));
    for (let elapsed = 10; elapsed <= 60; elapsed += 10) {
      await new Promise(r => setTimeout(r, 10000));
      const s = await state();
      assert.equal(s.loginSession?.active, true, '窗口自行关闭');
      assert.equal(s.loginSession?.sessionId, sid, '会话被替换');
      assert.equal(s.loginSession?.recoveryAttempts, 0, '稳定期间发生重开');
      assert.equal(s.loginSession?.window?.processId, pid, '进程被替换');
      assert.equal(s.loginSession?.window?.pageClosed, false);
      assert.equal(s.loginSession?.window?.state, 'normal', '窗口不处于正常显示状态');
      console.log(JSON.stringify({ event: 'stable', cycle, seconds: elapsed, processId: pid }));
    }
    await page.locator('#cancel-login').click();
    await page.waitForFunction(() => !document.querySelector('#cancel-login'));
  }
  console.log(JSON.stringify({ event: 'passed', cycles: 3, secondsPerCycle: 60, accountId }));
} finally { await browser.close(); }
