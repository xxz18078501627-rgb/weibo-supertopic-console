import fs from 'node:fs';
import { execFile } from 'node:child_process';
import { chromium } from 'playwright';
import { config } from './config.js';

export class BrowserBusyError extends Error {}

// Persistent Chromium profiles cannot be opened by two Chromium processes at
// once.  The task and QR-login managers are intentionally separate, so keep a
// small process-local lock in addition to Chromium's own profile lock.  It
// gives callers a useful conflict instead of a flaky launch failure.
const profileOwners = new Map();

function activateChrome(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return Promise.resolve();
  if (process.platform === 'win32') {
    const script = `$w = New-Object -ComObject WScript.Shell; [void]$w.AppActivate(${pid})`;
    return new Promise(resolve => execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { timeout: 5000 }, error => resolve(!error)));
  }
  if (process.platform !== 'darwin') return Promise.resolve();
  // Activate the Chromium process that owns this page. `open -a Chrome`
  // activates the user's unrelated default instance and can create a blank
  // window, making a healthy login window appear to flash and disappear.
  const source = `ObjC.import('AppKit'); const app = $.NSRunningApplication.runningApplicationWithProcessIdentifier(${pid}); if (app) { app.activateWithOptions(3); Boolean(app.active); } else { false; }`;
  return new Promise(resolve => execFile('/usr/bin/osascript', ['-l', 'JavaScript', '-e', source], { timeout: 5000 }, (error, stdout) => resolve(!error && stdout.trim() === 'true')));
}

export class BrowserManager {
  constructor(launch = options => chromium.launchPersistentContext(options.profile, options.options), {
    activate = activateChrome, headless = false, name = 'browser', visibleRunner = false
  } = {}) {
    this.context = null;
    this.accountId = null;
    this.owner = null;
    this.launch = launch;
    this.activate = activate;
    this.headless = headless;
    this.visibleRunner = visibleRunner;
    this.name = name;
    this.queue = Promise.resolve();
    this.windowActionOnNextPage = null;
    this.generation = 0;
  }

  status() {
    return { busy: Boolean(this.context), accountId: this.accountId, owner: this.owner, headless: this.context ? this.contextHeadless : this.headless, visible: Boolean(this.context && !this.contextHeadless) };
  }

  isAccountInUse(accountId) { return this.accountId === accountId || [...profileOwners.values()].some(owner => owner.accountId === accountId); }

  closeRunner() {
    const closing = this.queue.then(() => this.owner === 'runner' ? this.closeLocked() : undefined);
    this.queue = closing.catch(() => {});
    return closing;
  }

  closeManual(expected = this.context) {
    const closing = this.queue.then(() => this.owner === 'manual' && this.context === expected ? this.closeLocked() : undefined);
    this.queue = closing.catch(() => {});
    return closing;
  }

  open(account, owner = 'runner') {
    const opening = this.queue.then(() => this.openLocked(account, owner));
    this.queue = opening.catch(() => {});
    return opening;
  }

  async openLocked(account, owner) {
    if (this.context && this.accountId === account.id && this.owner === owner) return this.context;
    this.generation++;
    // A task manager changes from invisible execution to visible manual
    // verification by closing its own context first.  A login manager remains
    // single-session, but never blocks unrelated task profiles.
    if (this.context) await this.closeLocked();
    const occupied = profileOwners.get(account.profile_dir);
    if (occupied && occupied !== this) throw new BrowserBusyError('该账号正在被任务或扫码登录使用，请稍后再试');
    await this.closeLocked();
    fs.mkdirSync(account.profile_dir, { recursive: true, mode: 0o700 });
    const options = {
      headless: this.headless && owner === 'runner' && !this.visibleRunner,
      executablePath: fs.existsSync(config.chromePath) ? config.chromePath : undefined,
      viewport: null,
      args: [this.visibleRunner ? '--start-maximized' : this.headless && owner === 'runner' ? '--disable-blink-features=AutomationControlled' : (owner === 'runner' ? '--start-minimized' : '--start-maximized'), '--disable-blink-features=AutomationControlled'].filter((value, index, list) => list.indexOf(value) === index),
      locale: 'zh-CN',
      timezoneId: config.timezone
    };
    profileOwners.set(account.profile_dir, { accountId: account.id, launching: this });
    try {
      this.context = await this.launch({ profile: account.profile_dir, options });
    } catch (error) {
      if (profileOwners.get(account.profile_dir)?.launching === this) profileOwners.delete(account.profile_dir);
      throw new BrowserBusyError(`Chrome 无法打开：${error.message}`);
    }
    this.accountId = account.id;
    this.contextHeadless = options.headless;
    this.processId = null;
    this.activated = null;
    this.owner = owner;
    profileOwners.set(account.profile_dir, this);
    this.profileDir = account.profile_dir;
    this.windowActionOnNextPage = this.visibleRunner && owner === 'runner' ? 'foreground' : this.headless && owner === 'runner' ? null : (owner === 'runner' ? 'minimize' : null);
    const opened = this.context;
    this.context.on('close', () => {
      if (this.context !== opened) return;
      this.generation++;
      this.context = null;
      this.accountId = null;
      this.owner = null;
      if (profileOwners.get(this.profileDir) === this) profileOwners.delete(this.profileDir);
      this.profileDir = null;
      this.windowActionOnNextPage = null;
    });
    return this.context;
  }

  async page(account, owner = 'runner') {
    const context = await this.open(account, owner);
    const page = context.pages()[0] || await context.newPage();
    const action = this.windowActionOnNextPage;
    this.windowActionOnNextPage = null;
    if (action === 'minimize') await this.minimize(page);
    if (action === 'foreground') await this.foreground(page);
    return page;
  }

  async setWindowState(page, state) {
    if (this.contextHeadless ?? this.headless) return false;
    if (!page || page.isClosed?.()) return false;
    let session;
    try {
      session = await page.context().newCDPSession(page);
      const { windowId } = await session.send('Browser.getWindowForTarget');
      await session.send('Browser.setWindowBounds', { windowId, bounds: { windowState: state } });
      return true;
    } catch {
      return false;
    } finally {
      await session?.detach?.().catch(() => {});
    }
  }

  async windowState(page) {
    if (!page || page.isClosed?.()) return null;
    let session;
    try {
      session = await page.context().newCDPSession(page);
      const { windowId } = await session.send('Browser.getWindowForTarget');
      const result = await session.send('Browser.getWindowBounds', { windowId });
      return result?.bounds?.windowState || null;
    } catch {
      return null;
    } finally {
      await session?.detach?.().catch(() => {});
    }
  }

  async isMinimized(page) {
    return (await this.windowState(page)) === 'minimized';
  }

  async minimize(page) {
    if (this.visibleRunner && this.owner === 'runner') return;
    await this.setWindowState(page, 'minimized');
  }

  async foreground(page) {
    if (this.contextHeadless ?? this.headless) return false;
    // Each operation is best effort: losing the ability to control a native
    // window must never change a task's verification or submission outcome.
    await this.setWindowState(page, 'normal');
    await page?.bringToFront?.().catch(() => {});
    let session, pid;
    try {
      session = await page.context().browser()?.newBrowserCDPSession();
      const result = await session?.send('SystemInfo.getProcessInfo');
      pid = Number(result?.processInfo?.find(item => item.type === 'browser')?.id);
    } catch {} finally { await session?.detach?.().catch(() => {}); }
    if (Number.isSafeInteger(pid)) this.processId = pid;
    this.activated = await this.activate(pid).catch(() => false);
  }

  close(expected = this.context) {
    const closing = this.queue.then(() => this.context === expected ? this.closeLocked() : undefined);
    this.queue = closing.catch(() => {});
    return closing;
  }

  async closeLocked() {
    if (!this.context) return;
    this.generation++;
    const context = this.context;
    this.context = null;
    this.accountId = null;
    this.owner = null;
    if (profileOwners.get(this.profileDir) === this) profileOwners.delete(this.profileDir);
    this.profileDir = null;
    this.windowActionOnNextPage = null;
    await context.close().catch(() => {});
  }
}

// Normal automation is deliberately invisible.  Visible Chromium is reserved
// for an explicitly opened verification card or the independent login manager.
export const browserManager = new BrowserManager(undefined, { headless: true, name: 'task' });
