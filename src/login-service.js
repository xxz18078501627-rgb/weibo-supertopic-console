import { EventEmitter } from 'node:events';
import { getAccount, updateAccountAuth, log } from './db.js';
import { randomUUID } from 'node:crypto';

export class LoginService extends EventEmitter {
  constructor(adapter, browserManager, { intervalMs = 2000 } = {}) {
    super();
    this.adapter = adapter;
    this.browserManager = browserManager;
    this.intervalMs = intervalMs;
    this.active = null;
    this.last = null;
  }

  status() {
    const session = this.active || this.last;
    return session ? {
      accountId: session.accountId, phase: session.phase, message: session.message,
      active: Boolean(this.active), qrShown: Boolean(session.qrShown), recoveryAttempts: Number(session.recoveryAttempts || 0),
      lastUrl: session.lastUrl || '', closeStage: session.closeStage || null, sessionId: session.id,
      stage: session.stage, lastError: session.lastError || '', window: session.window || null
    } : null;
  }

  start(account) {
    if (this.active) {
      if (this.active.accountId === account.id) return this.status();
      throw Object.assign(new Error('请先完成或取消当前账号登录'), { statusCode: 409 });
    }
    const session = {
      id: randomUUID(), accountId: account.id, phase: 'opening', message: '正在打开扫码界面', cancelled: false,
      qrShown: false, recoveryAttempts: 0, maxRecoveryAttempts: 1, lastUrl: '', closeStage: null
    };
    this.active = session;
    this.publish(session, 'opening', session.message);
    session.promise = this.watch(account, session);
    return this.status();
  }

  publish(session, phase, message) {
    session.phase = phase;
    session.message = message;
    this.emit('update', this.status());
  }

  trace(session, stage, detail = '') {
    session.stage = stage;
    // Deliberately exclude QR contents, cookies and URL query parameters.
    log('info', `扫码会话 ${session.id} · ${stage}${detail ? ` · ${detail}` : ''}`, { accountId: session.accountId });
  }

  async watch(account, session) {
    let page = null;
    const bindPage = opened => {
      page = opened; session.page = opened; session.context = opened?.context?.() || this.browserManager.context;
      if (session.boundPage === opened) return;
      session.boundPage = opened;
      opened?.once?.('close', () => {
        this.trace(session, 'page-closed', session.cleanupReason || 'browser-or-user');
        if (!session.cancelled && session.page === opened) { session.pageClosed = true; session.wake?.(); }
      });
      if (session.boundContext !== session.context) {
        session.boundContext = session.context;
        session.context?.once?.('close', () => this.trace(session, 'context-closed', session.cleanupReason || 'browser-or-user'));
      }
    };
    const openPage = async (recover = false) => {
      this.publish(session, recover ? 'recovering' : 'opening', recover ? '扫码页面意外关闭，正在恢复一次…' : '正在打开扫码界面');
      this.trace(session, recover ? 'recovering' : 'opening');
      const opened = await this.adapter.openLogin(account, { onPage: bindPage, onStage: stage => this.trace(session, stage) });
      bindPage(opened.page);
      session.lastUrl = page?.url?.() || '';
      if (!session.cancelled) await this.browserManager.foreground?.(page);
      return page;
    };
    const recoverPage = async () => {
      session.closeStage = session.qrShown ? 'qr-visible' : 'before-qr';
      if (session.cancelled || session.qrShown || session.recoveryAttempts >= session.maxRecoveryAttempts) return false;
      session.recoveryAttempts += 1;
      session.pageClosed = false;
      try {
        // Navigation errors are recoverable in the same live window. Only a
        // closed page/context needs a replacement; never close a healthy QR.
        const livePages = session.context?.pages?.().filter(candidate => !candidate.isClosed()) || [];
        if (page?.isClosed?.() && session.context && !livePages.length) {
          session.cleanupReason = 'replace-closed-page';
          await this.browserManager.close(session.context);
          session.cleanupReason = null;
        }
        await openPage(true); return true;
      }
      catch (error) {
        session.openError = error;
        session.lastError = error.message;
        this.trace(session, 'recovery-error', error.message);
        return false;
      }
    };
    try {
      try { await openPage(); }
      catch (error) {
        session.context ||= this.browserManager.context;
        session.openError = error;
        session.lastError = error.message;
        this.trace(session, 'opening-error', error.message);
        if (!await recoverPage()) throw error;
      }
      if (session.cancelled) return;
      while (!session.cancelled) {
        if (!page || page.isClosed?.() || session.pageClosed) {
          if (await recoverPage()) continue;
          const message = session.qrShown
            ? '扫码窗口已关闭，可再次点击扫码登录'
            : session.recoveryAttempts ? '扫码窗口未能保持打开，请再次点击扫码登录'
            : '扫码窗口已关闭，可再次点击扫码登录';
          this.publish(session, session.qrShown ? 'cancelled' : 'failed', message);
          return;
        }
        try {
          if (await this.browserManager.isMinimized?.(page)) await this.browserManager.foreground?.(page);
          const qrVisible = await this.adapter.ensureQrVisible(page);
          session.lastUrl = page.url?.() || session.lastUrl;
          if (qrVisible && !session.qrShown) { session.qrShown = true; this.trace(session, 'qr-visible'); }
          session.window = { processId: this.browserManager.processId || null, activated: this.browserManager.activated, state: await this.browserManager.windowState?.(page), pageClosed: Boolean(page.isClosed?.()) };
          const identity = await this.adapter.readIdentity(page);
          if (session.cancelled) break;
          if (page.isClosed?.() || session.pageClosed) continue;
          if (identity.status === 'valid') {
            // Verify identity before any update to the existing account record.
            const current = getAccount(account.id);
            updateAccountAuth(current.id, identity);
            this.publish(session, 'success', `已登录：${identity.nickname}`);
            return;
          }
          if (getAccount(account.id)?.auth_status !== 'invalid') updateAccountAuth(account.id, { status: 'invalid' });
          if (await this.adapter.loginChallenge(page)) {
            await this.browserManager.foreground?.(page);
            this.publish(session, 'verification', '请在 Mac 窗口完成微博验证');
          }
          else if (qrVisible) this.publish(session, 'waiting', '等待扫码，登录后会自动确认');
          else this.publish(session, 'checking', '正在识别扫码界面或确认登录，请查看 Mac 窗口');
        } catch (error) {
          if (session.cancelled) break;
          if (page?.isClosed?.() || session.pageClosed) continue;
          if (/UID 不一致|已存在/.test(error.message)) {
            this.publish(session, 'failed', error.message);
            return;
          }
          this.publish(session, error.code === 'identity_pending' ? 'checking' : 'network_error', error.code === 'identity_pending' ? error.message : '暂时无法检查登录，正在重试；请检查 Mac 窗口和网络');
          if (session.lastError !== error.message) this.trace(session, 'poll-error', error.message);
          session.lastError = error.message;
        }
        await new Promise(resolve => {
          session.wake = resolve;
          session.timer = setTimeout(resolve, this.intervalMs);
        });
        clearTimeout(session.timer);
        session.wake = null;
      }
      if (session.phase !== 'success' && session.phase !== 'failed') this.publish(session, 'cancelled', '扫码登录已取消，可再次登录');
    } catch (error) {
      session.lastError = error.message;
      this.trace(session, 'failed', error.message);
      this.publish(session, session.cancelled ? 'cancelled' : 'failed', session.cancelled ? '扫码登录已取消' : '扫码页面未能打开或恢复，请再次点击扫码登录');
    } finally {
      clearTimeout(session.timer);
      session.cleanupReason = session.cancelled ? 'explicit-cancel' : session.phase;
      this.trace(session, 'cleanup', session.cleanupReason);
      if (this.browserManager.accountId === account.id && this.browserManager.owner === 'login') await this.browserManager.close(session.context);
      if (this.active === session) {
        this.last = session;
        this.active = null;
        this.emit('update', this.status());
      }
    }
  }

  async cancel() {
    const session = this.active;
    if (!session) return;
    session.cancelled = true;
    clearTimeout(session.timer);
    session.wake?.();
    await session.promise;
  }

}
