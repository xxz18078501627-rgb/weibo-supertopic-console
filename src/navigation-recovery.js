import { db, getJob, getAccount, getStepAction, createActionLog, updateActionLog, updateJob, listTopics, recordCheckin, log } from './db.js';
import { isNavigationError, safeNavigationUrl } from './navigation.js';
import { VerificationError } from './weibo-adapter.js';
import { shanghaiDate } from './util.js';

const keyFor = step => `${step.round}:${step.topicId}:${step.accountId}:${step.segmentId || step.actionIndex}:${step.unitIndex}`;
const NAV_DELAYS = [5000, 15000, 30000, 60000];
const RATE_DELAYS = [30000, 60000, 180000, 300000, 600000, 1800000];
const RATE_HTTP = new Set([403, 418, 429]);
const PROBE_DEADLINE_MS = 30000;
const TICK_DEADLINE_MS = 90000;
const CLOSE_TIMEOUT_MS = 12000;
const reason = '微博页面暂不可用，任务已暂停，正在自动检查恢复';
const terminal = job => !job || job.stopRequested || ['stopped', 'completed'].includes(job.status);
const jitter = ms => Math.round(ms * (0.8 + Math.random() * 0.4));

function probeRecord(result, now) {
  const status = Number(result?.httpStatus);
  return {
    ready: result?.state === 'ready',
    at: new Date(now).toISOString(),
    netCode: result?.netCode || null,
    httpStatus: Number.isFinite(status) && status > 0 ? status : null
  };
}

function appendRecent(recent, result, now) {
  return [...(Array.isArray(recent) ? recent : []), probeRecord(result, now)].slice(-3);
}

// Separate from transport connectivity: a reachable robots.txt is not proof that
// the failed business page can load. Every check here is strictly read-only.
export class NavigationRecovery {
  constructor(runner) {
    this.runner = runner;
    this.epoch = 0;
    this.timer = null;
    this.flight = null;
    this.jobId = null;
    this.watchdogTimer = null;
    this.startWatchdog();
  }
  manual(jobId) { return this.runner.workflow.session?.jobId === jobId; }
  waiting(job) { return job?.cursor?.navigationRecovery?.state === 'waiting'; }
  clear(jobId = null) {
    if (jobId && this.jobId !== jobId && this.flight?.jobId !== jobId) return;
    this.epoch++;
    clearTimeout(this.timer); this.timer = null; this.jobId = null;
    try { this.flight?.controller?.abort?.(); } catch {}
  }
  arm(jobId) {
    clearTimeout(this.timer); this.timer = null; this.jobId = jobId;
    const job = getJob(jobId), recovery = job?.cursor?.navigationRecovery;
    if (!this.waiting(job) || terminal(job) || job.pausedByUser) return;
    const next = Date.parse(recovery.nextCheckAt);
    const delay = Number.isFinite(next) ? Math.max(0, next - this.runner.now()) : NAV_DELAYS[0];
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.tick(jobId).catch(() => { try { this.reschedule(jobId); } catch {} });
    }, delay);
    this.timer.unref?.();
  }
  save(jobId, recovery, patch = {}) {
    const job = getJob(jobId);
    const updated = updateJob(jobId, { ...patch, cursor: { ...job.cursor, navigationRecovery: recovery } });
    this.runner.emitUpdate(updated); return updated;
  }
  reschedule(jobId, result = {}) {
    const job = getJob(jobId);
    if (!this.waiting(job) || terminal(job) || job.pausedByUser) return;
    const old = job.cursor.navigationRecovery;
    const now = this.runner.now();
    const status = Number(result.httpStatus);
    const rateLimited = RATE_HTTP.has(status);
    const attempts = Number(old.attempts || 0) + (result.state === 'busy' ? 0 : 1);
    const rateAttempts = rateLimited
      ? Number(old.rateAttempts || 0) + 1
      : (result.state === 'ready' ? 0 : Number(old.rateAttempts || 0));
    const base = rateLimited
      ? RATE_DELAYS[Math.min(Math.max(rateAttempts - 1, 0), RATE_DELAYS.length - 1)]
      : NAV_DELAYS[Math.min(attempts, NAV_DELAYS.length - 1)];
    const delay = rateLimited ? jitter(base) : base;
    const recent = appendRecent(old.recent, result, now);
    const successes = result.state === 'ready' ? Number(old.successes || 0) + 1 : 0;
    const nextCheckAt = new Date(now + delay).toISOString();
    const waitReason = rateLimited
      ? `微博返回 ${status}（访问过于频繁），已放慢自动检查`
      : reason;
    this.save(jobId, { ...old, attempts, rateAttempts, recent, successes, nextDelayMs: delay, nextCheckAt,
      httpStatus: rateLimited ? status : old.httpStatus,
      lastCheckAt: new Date(now).toISOString(),
      lastResult: { state: result.state || 'unavailable', netCode: result.netCode || null, httpStatus: Number.isFinite(status) && status > 0 ? status : null } },
    { waitReason });
    this.arm(jobId);
  }
  async handle(error, jobId, step) {
    if (!isNavigationError(error) && !error?.navigationHandled) return false;
    if (error.navigationHandled) return true;
    this.runner.enforceDailyStop();
    let job = getJob(jobId);
    if (terminal(job)) return true;
    if (!step) return false;
    const action = getStepAction(jobId, keyFor(step));
    if (action?.state === 'succeeded') return false;
    const submitted = Boolean(this.runner.executionStorage.getStore()?.submitted ||
      ['submitted', 'started', 'uncertain'].includes(action?.state) || action?.receipt_id);
    const state = submitted ? 'uncertain' : 'prepared';
    const message = `${reason}（${error.netCode || 'navigation_unavailable'}${error.httpStatus ? ` / HTTP ${error.httpStatus}` : ''}）`;
    if (action) updateActionLog(action.id, { state, error: message });
    else createActionLog({ jobId, stepKey: keyFor(step), kind: step.kind, accountId: step.accountId, topicId: step.topicId, state, error: message });
    // Keep content, target and number reservation unchanged. Unknown submission
    // is never converted back to a retryable prepared action.
    if (this.runner.workflow.enabled(job)) db.prepare('UPDATE task_step_state SET state=?,outcome=NULL WHERE job_id=? AND step_key=?')
      .run(submitted ? 'network_review' : 'pending', jobId, keyFor(step));
    job = getJob(jobId);
    const old = job.cursor.navigationRecovery;
    const candidateUrl = safeNavigationUrl(error.navigationUrl || error.url);
    const usableUrl = candidateUrl && /^https:\/\/(?:[a-z0-9-]+\.)*weibo\.com\//i.test(candidateUrl) ? candidateUrl :
      safeNavigationUrl(listTopics().find(t => t.id === step.topicId)?.url) || 'https://weibo.com/';
    const recovery = this.waiting(job) ? old : {
      state: 'waiting', step, url: usableUrl,
      stage: error.stage || 'navigation', netCode: error.netCode || 'ERR_HTTP_RESPONSE_CODE_FAILURE', httpStatus: error.httpStatus || null,
      since: new Date(this.runner.now()).toISOString(), nextCheckAt: new Date(this.runner.now() + NAV_DELAYS[0]).toISOString(),
      nextDelayMs: NAV_DELAYS[0], successes: 0, attempts: 0, rateAttempts: 0, recent: [],
      submitted, configVersion: Number(job.cursor.configVersion || 0), returnStatus: job.status
    };
    this.runner.network.clear(jobId);
    this.save(jobId, recovery, { status: 'paused', waitReason: reason });
    log('warning', `页面恢复等待：${recovery.stage}，${recovery.netCode}，HTTP ${recovery.httpStatus || '未知'}，${recovery.url}`, { accountId: step.accountId, topicId: step.topicId });
    error.navigationHandled = true;
    this.arm(jobId); return true;
  }
  async tick(jobId) {
    const now = this.runner.now();
    if (this.flight) {
      if (now - Number(this.flight.startedAt || now) < TICK_DEADLINE_MS) return;
      this.epoch++;
      try { this.flight.controller?.abort?.(); } catch {}
      this.flight = null;
      log('warning', '页面恢复检查超时未结束，重新排队', { jobId });
    }
    this.runner.enforceDailyStop();
    let job = getJob(jobId);
    if (!this.waiting(job) || terminal(job) || job.pausedByUser) { this.clear(jobId); return; }
    let recovery = job.cursor.navigationRecovery;
    if (Number(job.cursor.configVersion || 0) !== recovery.configVersion) {
      this.save(jobId, { ...recovery, state: 'cancelled', nextCheckAt: null }, { status: 'paused', pausedByUser: true, waitReason: '任务参数已变化，请确认后继续运行' });
      this.clear(jobId); return;
    }
    if (this.runner.now() < Date.parse(recovery.nextCheckAt)) { this.arm(jobId); return; }
    if (this.runner.currentExecution && !this.manual(jobId)) { this.reschedule(jobId, { state: 'busy' }); return; }
    const epoch = this.epoch, version = Number(job.cursor.configVersion || 0);
    const controller = new AbortController(), flight = { jobId, controller, startedAt: this.runner.now() };
    this.flight = flight;
    const live = () => {
      const fresh = getJob(jobId);
      return !controller.signal.aborted && epoch === this.epoch && !terminal(fresh) && !fresh.pausedByUser &&
        this.waiting(fresh) && fresh.cursor.navigationRecovery.since === recovery.since && Number(fresh.cursor.configVersion || 0) === version;
    };
    let deadlineTimer;
    const deadline = new Promise(resolve => {
      deadlineTimer = setTimeout(() => {
        this.epoch++;
        try { controller.abort(); } catch {}
        if (this.flight === flight) this.flight = null;
        log('warning', '页面恢复检查超过硬截止，已重新排队', { jobId });
        try { this.reschedule(jobId, { state: 'unavailable', netCode: 'TICK_TIMEOUT' }); } catch {}
        resolve();
      }, TICK_DEADLINE_MS);
      deadlineTimer.unref?.();
    });
    const body = async () => {
      let timeout;
      try {
        const account = getAccount(recovery.step.accountId);
        const result = account && this.runner.adapter.probeNavigation ? await Promise.race([
          this.runner.adapter.probeNavigation(account, { url: recovery.url, signal: controller.signal }),
          new Promise(resolve => { timeout = setTimeout(() => { controller.abort(); resolve({ state: 'unavailable', netCode: 'NAVIGATION_PROBE_TIMEOUT' }); }, PROBE_DEADLINE_MS); })
        ]) : { state: 'unavailable', netCode: 'NAVIGATION_PROBE_NOT_READY' };
        // Timeout aborts the temporary page but still needs a new bounded check.
        if (controller.signal.aborted && epoch === this.epoch) {
          job = getJob(jobId);
          if (!terminal(job) && !job.pausedByUser && this.waiting(job)) this.reschedule(jobId, result);
          return;
        }
        if (!live()) return;
        if (['verification', 'authentication'].includes(result.state)) {
          // A loaded challenge/login page is NOT ready. Hand it to the human flow,
          // without clicking, consuming another attempt or claiming login expiry.
          const message = result.state === 'verification' ? '页面已恢复，但需要人工完成微博验证' : '页面已恢复，请人工确认登录状态或账号身份';
          this.save(jobId, { ...recovery, state: 'human_required', lastResult: { state: result.state }, nextCheckAt: null }, { waitReason: message });
          this.clear(jobId);
          if (this.runner.workflow.enabled(job)) {
            const error = new VerificationError(message); error.submittedUncertain = recovery.submitted;
            this.runner.workflow.defer(jobId, recovery.step, error, { priority: false });
            const fresh = getJob(jobId);
            this.runner.emitUpdate(updateJob(jobId, { status: 'waiting', waitReason: message, cursor: { ...fresh.cursor, verificationBarrier: true } }));
          } else {
            this.runner.emitUpdate(updateJob(jobId, { status: 'paused', pausedByUser: true, waitReason: message }));
          }
          return;
        }
        const recent = appendRecent(recovery.recent, result, this.runner.now());
        const readyRecent = recent.filter(item => item.ready).length;
        if (result.state !== 'ready' || readyRecent < 2) { this.reschedule(jobId, result); return; }
        // Never resume a step removed by a paused edit. Its newer config wins.
        if (version !== recovery.configVersion) {
          this.save(jobId, { ...recovery, state: 'cancelled', nextCheckAt: null }, { status: 'paused', pausedByUser: true, waitReason: '任务参数已变化，请确认后继续运行' });
          this.clear(jobId); return;
        }
        // The healthy probe used a temporary tab; do not resume against the old
        // runner error page. Never close a human-owned browser.
        if (!this.manual(jobId) && this.runner.adapter.browserManager?.owner === 'runner') {
          const manager = this.runner.adapter.browserManager;
          const closed = manager.closeRunnerBounded
            ? await manager.closeRunnerBounded(CLOSE_TIMEOUT_MS)
            : await manager.closeRunner?.().then(() => true, () => false);
          if (closed === false) log('warning', '页面恢复关闭旧浏览器超时，已强制结束', { jobId });
          if (!live()) return;
        }
        const step = recovery.step, action = getStepAction(jobId, keyFor(step));
        if (recovery.submitted && !this.manual(jobId) && action?.state !== 'succeeded') {
          try { await this.verifySubmitted(jobId, recovery, { live, job }); }
          catch (error) {
            if (!live()) return;
            if (isNavigationError(error) || await this.runner.network.isNetworkError(error, jobId)) {
              this.reschedule(jobId, { state: 'unavailable', netCode: error.netCode || error.code }); return;
            }
            throw error;
          }
        }
        if (!live()) return;
        if (recovery.submitted && this.manual(jobId) && this.runner.workflow.enabled(getJob(jobId)) &&
            this.runner.workflow.row(jobId, recovery.step)?.state === 'network_review' &&
            getStepAction(jobId, keyFor(recovery.step))?.state !== 'succeeded') {
          // The human-owned session performs its own readback; mark unknown as
          // review now so its outer retry loop can never submit it again.
          this.runner.workflow.finishStep(jobId, recovery.step, 'uncertain', '页面已恢复，保留已提交操作等待人工只读核验');
        }
        job = getJob(jobId);
        if (!live()) return;
        this.clear(jobId);
        const waiting = Boolean(job.cursor.verificationBarrier || job.cursor.manualVerification || this.manual(jobId));
        const networkWaiting = job.cursor.networkRecovery?.state === 'offline';
        const updated = this.save(jobId, { ...recovery, state: 'recovered', successes: 2, recent, nextCheckAt: null, nextDelayMs: null, restoredAt: new Date(this.runner.now()).toISOString() },
          { status: networkWaiting ? 'paused' : waiting ? 'waiting' : 'running', waitReason: networkWaiting ? '等待网络恢复' : waiting ? '等待人工验证及补做' : null });
        log('info', '故障页面最近三次两次只读检查通过，恢复原任务步骤', { jobId });
        if (networkWaiting) this.runner.network.arm(jobId);
        else if (!waiting) void this.runner.run(updated.id);
      } catch {
        if (live()) this.reschedule(jobId);
      } finally {
        clearTimeout(timeout);
      }
    };
    try { await Promise.race([body(), deadline]); }
    finally {
      clearTimeout(deadlineTimer);
      if (this.flight === flight) this.flight = null;
    }
  }
  async verifySubmitted(jobId, recovery, { live = () => true, job = null } = {}) {
    const step = recovery.step, action = getStepAction(jobId, keyFor(step));
    if (!action || action.state === 'succeeded') return { state: 'succeeded' };
    const account = getAccount(step.accountId), topic = listTopics().find(t => t.id === step.topicId);
    let verified = { state: 'uncertain', reason: '页面恢复后只读核验仍不能确认，不自动重发' };
    try {
      await this.runner.adapter.ensureIdentity?.(account);
      if (step.kind === 'post') verified = await this.runner.adapter.verifyPost?.(account, action, { topicName: topic?.name }) || verified;
      if (step.kind === 'original') verified = await this.runner.adapter.verifyOriginal?.(account, action) || verified;
      if (step.kind === 'checkin') verified = await this.runner.adapter.verifyCheckin?.(account, topic) || verified;
      if (step.kind === 'comment' && action?.target_id && action?.url) verified = await this.runner.adapter.verifyComment?.(account, { id: action.target_id, url: action.url.split('?')[0] }, action.content, { delays: [0] }) || verified;
    } catch (error) {
      if (!live()) return verified;
      if (error.code === 'verification_required' || error.code === 'authentication_required') {
        const human = new VerificationError('页面恢复后的只读核验需要人工验证'); human.submittedUncertain = true;
        if (this.runner.workflow.enabled(job)) {
          this.runner.workflow.defer(jobId, step, human, { priority: false });
          const fresh = getJob(jobId);
          this.runner.emitUpdate(updateJob(jobId, { cursor: { ...fresh.cursor, verificationBarrier: true } }));
        }
      } else if (isNavigationError(error) || await this.runner.network.isNetworkError(error, jobId)) {
        throw error;
      }
    }
    if (!live()) return verified;
    const row = this.runner.workflow.enabled(job) ? this.runner.workflow.row(jobId, step) : null;
    if (row?.state !== 'review') {
      const state = verified.state === 'succeeded' ? 'succeeded' : 'uncertain';
      if (state === 'succeeded' && step.kind === 'checkin') recordCheckin(step.accountId, step.topicId, shanghaiDate(new Date(this.runner.now())));
      if (state === 'succeeded') this.runner.confirmSequence(jobId, step);
      await this.runner.finishStep(getJob(jobId), step, state, verified.reason || null);
    }
    return verified;
  }
  startWatchdog() {
    if (this.watchdogTimer) return;
    this.watchdogTimer = setInterval(() => { try { this.checkWatchdog(); } catch {} }, 30000);
    this.watchdogTimer.unref?.();
  }
  checkWatchdog() {
    const scope = this.runner.scope;
    if (!scope) return;
    for (const row of db.prepare("SELECT id FROM jobs WHERE scope=? AND status IN ('running','waiting','paused')").all(scope)) {
      const job = getJob(row.id);
      if (!job || job.pausedByUser) continue;
      const recovery = job.cursor?.navigationRecovery;
      if (!recovery || recovery.state !== 'waiting') continue;
      if (this.flight?.jobId === job.id) {
        if (this.runner.now() - Number(this.flight.startedAt || 0) < TICK_DEADLINE_MS) continue;
        this.epoch++;
        try { this.flight.controller?.abort?.(); } catch {}
        this.flight = null;
      }
      const next = Date.parse(recovery.nextCheckAt || 0);
      const delay = Number(recovery.nextDelayMs || NAV_DELAYS[NAV_DELAYS.length - 1]);
      if (!Number.isFinite(next) || next + Math.max(2 * delay, 120000) <= this.runner.now()) {
        log('warning', '页面恢复检查疑似停摆，重新排队', { jobId: job.id });
        this.arm(job.id);
      }
    }
  }
  async wait(jobId, cancelled = () => false) {
    while (this.waiting(getJob(jobId))) {
      this.runner.enforceDailyStop();
      const job = getJob(jobId);
      if (terminal(job) || job.pausedByUser || cancelled()) throw Object.assign(new Error('页面恢复等待已结束'), { code: 'navigation_wait_cancelled' });
      await new Promise(resolve => setTimeout(resolve, 250));
    }
  }
}
