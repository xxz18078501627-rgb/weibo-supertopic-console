import { db, getJob, getAccount, getStepAction, createActionLog, updateActionLog, updateJob, listTopics, recordCheckin, log } from './db.js';
import { isNavigationError, safeNavigationUrl } from './navigation.js';
import { VerificationError } from './weibo-adapter.js';
import { shanghaiDate } from './util.js';

const keyFor = step => `${step.round}:${step.topicId}:${step.accountId}:${step.segmentId || step.actionIndex}:${step.unitIndex}`;
const delays = [5000, 15000, 30000, 60000];
const reason = '微博页面暂不可用，任务已暂停，正在自动检查恢复';
const terminal = job => !job || job.stopRequested || ['stopped', 'completed'].includes(job.status);

// Separate from transport connectivity: a reachable robots.txt is not proof that
// the failed business page can load. Every check here is strictly read-only.
export class NavigationRecovery {
  constructor(runner) { this.runner = runner; this.epoch = 0; this.timer = null; this.flight = null; }
  manual(jobId) { return this.runner.workflow.session?.jobId === jobId; }
  waiting(job) { return job?.cursor?.navigationRecovery?.state === 'waiting'; }
  clear(jobId = null) {
    if (jobId && this.jobId !== jobId && this.flight?.jobId !== jobId) return;
    this.epoch++;
    clearTimeout(this.timer); this.timer = null; this.jobId = null;
    this.flight?.controller.abort();
  }
  arm(jobId) {
    clearTimeout(this.timer); this.timer = null; this.jobId = jobId;
    const job = getJob(jobId), recovery = job?.cursor?.navigationRecovery;
    if (!this.waiting(job) || terminal(job) || job.pausedByUser) return;
    this.timer = setTimeout(() => { this.timer = null; void this.tick(jobId).catch(() => this.reschedule(jobId)); },
      Math.max(0, (Date.parse(recovery.nextCheckAt) || this.runner.now() + delays[0]) - this.runner.now()));
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
    const attempts = old.attempts + (result.state === 'busy' ? 0 : 1);
    const successes = result.state === 'ready' ? old.successes + 1 : 0;
    this.save(jobId, { ...old, attempts, successes,
      nextCheckAt: new Date(this.runner.now() + delays[Math.min(attempts, delays.length - 1)]).toISOString(),
      lastCheckAt: new Date(this.runner.now()).toISOString(),
      lastResult: { state: result.state || 'unavailable', netCode: result.netCode || null, httpStatus: result.httpStatus || null } });
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
      since: new Date(this.runner.now()).toISOString(), nextCheckAt: new Date(this.runner.now() + delays[0]).toISOString(),
      successes: 0, attempts: 0, submitted, configVersion: Number(job.cursor.configVersion || 0), returnStatus: job.status
    };
    this.runner.network.clear(jobId);
    this.save(jobId, recovery, { status: 'paused', waitReason: reason });
    log('warning', `页面恢复等待：${recovery.stage}，${recovery.netCode}，HTTP ${recovery.httpStatus || '未知'}，${recovery.url}`, { accountId: step.accountId, topicId: step.topicId });
    error.navigationHandled = true;
    this.arm(jobId); return true;
  }
  async tick(jobId) {
    if (this.flight) return;
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
    const controller = new AbortController(), flight = { jobId, controller };
    this.flight = flight;
    const live = () => {
      const fresh = getJob(jobId);
      return !controller.signal.aborted && epoch === this.epoch && !terminal(fresh) && !fresh.pausedByUser &&
        this.waiting(fresh) && fresh.cursor.navigationRecovery.since === recovery.since && Number(fresh.cursor.configVersion || 0) === version;
    };
    let timeout;
    try {
      const account = getAccount(recovery.step.accountId);
      const result = account && this.runner.adapter.probeNavigation ? await Promise.race([
        this.runner.adapter.probeNavigation(account, { url: recovery.url, signal: controller.signal }),
        new Promise(resolve => { timeout = setTimeout(() => { controller.abort(); resolve({ state: 'unavailable', netCode: 'NAVIGATION_PROBE_TIMEOUT' }); }, 12000); })
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
      if (result.state !== 'ready' || recovery.successes < 1) { this.reschedule(jobId, result); return; }
      // Never resume a step removed by a paused edit. Its newer config wins.
      if (version !== recovery.configVersion) {
        this.save(jobId, { ...recovery, state: 'cancelled', nextCheckAt: null }, { status: 'paused', pausedByUser: true, waitReason: '任务参数已变化，请确认后继续运行' });
        this.clear(jobId); return;
      }
      // The healthy probe used a temporary tab; do not resume against the old
      // runner error page. Never close a human-owned browser.
      if (!this.manual(jobId) && this.runner.adapter.browserManager?.owner === 'runner') {
        await this.runner.adapter.browserManager.closeRunner?.();
        if (!live()) return;
      }
      const step = recovery.step, action = getStepAction(jobId, keyFor(step));
      if (recovery.submitted && !this.manual(jobId) && action?.state !== 'succeeded') {
        let verified = { state: 'uncertain', reason: '页面恢复后只读核验仍不能确认，不自动重发' };
        const topic = listTopics().find(t => t.id === step.topicId);
        try {
          await this.runner.adapter.ensureIdentity?.(account);
          if (step.kind === 'post') verified = await this.runner.adapter.verifyPost?.(account, action, { topicName: topic?.name }) || verified;
          if (step.kind === 'checkin') verified = await this.runner.adapter.verifyCheckin?.(account, topic) || verified;
          if (step.kind === 'comment' && action?.target_id && action?.url) verified = await this.runner.adapter.verifyComment?.(account, { id: action.target_id, url: action.url.split('?')[0] }, action.content, { delays: [0] }) || verified;
        } catch (error) {
          if (!live()) return;
          if (error.code === 'verification_required' || error.code === 'authentication_required') {
            const human = new VerificationError('页面恢复后的只读核验需要人工验证'); human.submittedUncertain = true;
            if (this.runner.workflow.enabled(job)) {
              this.runner.workflow.defer(jobId, step, human, { priority: false });
              const fresh = getJob(jobId);
              this.runner.emitUpdate(updateJob(jobId, { cursor: { ...fresh.cursor, verificationBarrier: true } }));
            }
          } else if (isNavigationError(error) || await this.runner.network.isNetworkError(error, jobId)) {
            this.reschedule(jobId, { state: 'unavailable', netCode: error.netCode || error.code }); return;
          }
        }
        if (!live()) return;
        const row = this.runner.workflow.enabled(job) ? this.runner.workflow.row(jobId, step) : null;
        if (row?.state !== 'review') {
          const state = verified.state === 'succeeded' ? 'succeeded' : 'uncertain';
          if (state === 'succeeded' && step.kind === 'checkin') recordCheckin(step.accountId, step.topicId, shanghaiDate(new Date(this.runner.now())));
          if (state === 'succeeded') this.runner.confirmSequence(jobId, step);
          await this.runner.finishStep(getJob(jobId), step, state, verified.reason || null);
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
      this.clear(jobId);
      const waiting = Boolean(job.cursor.verificationBarrier || job.cursor.manualVerification || this.manual(jobId));
      const networkWaiting = job.cursor.networkRecovery?.state === 'offline';
      const updated = this.save(jobId, { ...recovery, state: 'recovered', successes: 2, nextCheckAt: null, restoredAt: new Date(this.runner.now()).toISOString() },
        { status: networkWaiting ? 'paused' : waiting ? 'waiting' : 'running', waitReason: networkWaiting ? '等待网络恢复' : waiting ? '等待人工验证及补做' : null });
      log('info', '故障页面连续两次只读检查通过，恢复原任务步骤', { jobId });
      if (networkWaiting) this.runner.network.arm(jobId);
      else if (!waiting) void this.runner.run(updated.id);
    } catch {
      if (live()) this.reschedule(jobId);
    } finally {
      clearTimeout(timeout);
      if (this.flight === flight) this.flight = null;
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
