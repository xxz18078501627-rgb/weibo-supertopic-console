import { db, getJob, getAccount, getStepAction, updateActionLog, updateJob, listTopics, log, recordCheckin } from './db.js';
import { shanghaiDate } from './util.js';

export class NetworkOfflineError extends Error {
  constructor(message = '网络中断，正在等待恢复') { super(message); this.code = 'network_offline'; this.statusCode = 409; }
}
export function definiteNetworkError(error) {
  return error?.code === 'network_offline' || /ERR_(INTERNET_DISCONNECTED|NETWORK_CHANGED|CONNECTION_(RESET|CLOSED|REFUSED|ABORTED)|NAME_NOT_RESOLVED|PROXY_CONNECTION_FAILED|TUNNEL_CONNECTION_FAILED)|\b(ENETUNREACH|EHOSTUNREACH|ENOTFOUND|EAI_AGAIN|ECONNRESET)\b/.test(error?.message || '');
}
const keyFor = step => `${step.round}:${step.topicId}:${step.accountId}:${step.segmentId || step.actionIndex}:${step.unitIndex}`;

export class NetworkRecovery {
  constructor(runner) { this.runner = runner; this.timer = null; this.checking = false; this.probeSerial = 0; this.probeRun = `${process.pid}-${Date.now()}-${Math.random()}`; this.epoch = 0; }
  status(job) { return job?.cursor?.networkRecovery || { state: 'online', pauseSource: null }; }
  async check(job) {
    const manager = this.runner.adapter.browserManager;
    const generation = manager?.generation || 0;
    const episode = job.cursor?.networkRecovery?.since;
    if (this.flight?.jobId === job.id && this.flight.generation === generation && this.flight.episode === episode) return this.flight.promise;
    const account = getAccount(job.cursor?.networkRecovery?.step?.accountId || job.cursor?.current?.accountId || job.config.accountIds?.[0]);
    const epoch = this.epoch, serial = `${this.probeRun}:${++this.probeSerial}`, started = Date.now();
    const controller = new AbortController();
    const flight = { jobId: job.id, generation, episode, controller };
    this.flight?.controller.abort(); this.flight = flight;
    flight.promise = (async () => {
      let timer;
      try {
        const raw = !account || !this.runner.adapter.probeConnectivity ? { state: 'unknown', code: 'PROBE_NOT_READY' } : await Promise.race([
          this.runner.adapter.probeConnectivity(account, { force: job.cursor.networkRecovery?.state === 'offline', signal: controller.signal }),
          new Promise(resolve => { timer = setTimeout(() => { controller.abort(); resolve({ state: 'unknown', code: 'PROBE_TIMEOUT' }); }, 3000); })
        ]);
        // Boolean adapters are supported for older integrations and fixtures;
        // false there was an explicit offline signal, not a swallowed error.
        const value = typeof raw === 'boolean' ? { state: raw ? 'online' : 'offline', definitive: !raw } : raw;
        const current = getJob(job.id);
        const stale = this.epoch !== epoch || !current || current.stopRequested || current.pausedByUser || ['stopped','completed'].includes(current.status)
          || current.cursor?.networkRecovery?.since !== episode || Number(current.cursor?.configVersion || 0) !== Number(job.cursor?.configVersion || 0)
          || (manager && (manager.generation || 0) !== (value?.contextGeneration ?? generation));
        return { ...value, state: stale ? 'unknown' : ['online','offline','unknown'].includes(value?.state) ? value.state : 'unknown',
          code: stale ? 'PROBE_STALE' : value?.code || null, stale, serial, checkedAt: new Date(this.runner.now()).toISOString(), latencyMs: value?.latencyMs ?? Date.now() - started };
      } catch { return { state: 'unknown', code: 'PROBE_EXCEPTION', stale: true, serial, checkedAt: new Date(this.runner.now()).toISOString(), latencyMs: Date.now() - started }; }
      finally { clearTimeout(timer); if (this.flight === flight) this.flight = null; }
    })();
    return flight.promise;
  }
  recordProbe(jobId, result) {
    const job = getJob(jobId);
    if (!job || result.stale || job.stopRequested || job.pausedByUser || ['stopped','completed'].includes(job.status)) return null;
    const old = job.cursor.networkRecovery || {};
    if (old.probeSerial === result.serial) return old;
    const info = { ...old, state: old.state || 'online', pauseSource: old.pauseSource || null,
      probeState: result.state, lastCheckedAt: result.checkedAt, probeSerial: result.serial,
      failures: result.state === 'offline' ? Number(old.failures || 0) + 1 : 0,
      successes: result.state === 'online' ? Math.min(2, Number(old.successes || 0) + 1) : 0,
      lastProbe: { state: result.state, code: result.code, httpStatus: result.httpStatus || null, latencyMs: result.latencyMs, checkedAt: result.checkedAt } };
    if (result.state === 'online' && info.state !== 'offline') { info.reason = null; info.step = null; info.since = null; }
    if (result.state !== 'online' && (old.lastProbe?.state !== result.state || old.lastProbe?.code !== result.code)) {
      log('warning', `网络探测${result.state === 'unknown' ? '暂不可用' : '不可达'}：${result.code || '无错误码'}，耗时 ${result.latencyMs}ms，HTTP ${result.httpStatus || '无响应'}`);
    }
    this.runner.emitUpdate(updateJob(jobId, { cursor: { ...job.cursor, networkRecovery: info } }));
    return info;
  }
  async probe(job) {
    const result = await this.check(job);
    const info = this.recordProbe(job.id, result);
    return result.stale || !info || (info.state !== 'offline' && (result.state !== 'offline' || (!result.definitive && info.failures < 2)));
  }
  async monitor(job) {
    if (!job || !['running','waiting'].includes(job.status) || this.checking || job.cursor.networkRecovery?.state === 'offline') return;
    this.checking = true;
    try {
      if (!await this.probe(job)) {
        const fresh = getJob(job.id);
        if (fresh && !fresh.pausedByUser && ['running','waiting'].includes(fresh.status)) this.pause(job.id, this.runner.currentExecution?.step || null);
      }
    } finally { this.checking = false; }
  }
  async isNetworkError(error, jobId) {
    if (definiteNetworkError(error) || error?.networkHandled) return true;
    if (!/timeout|timed out|network_error|fetch failed|Failed to fetch/i.test(`${error?.code || ''} ${error?.message || ''}`)) return false;
    const job = getJob(jobId); return Boolean(job && !await this.probe(job));
  }
  pause(jobId, step = null, reason = '检测到网络断开') {
    const job = getJob(jobId); if (!job || job.stopRequested || ['stopped','completed'].includes(job.status)) return;
    if (job.pausedByUser) return job;
    const previous = job.cursor.networkRecovery;
    if (previous?.state === 'offline') {
      this.arm(jobId);
      const updated = updateJob(jobId, { status: 'paused', waitReason: '网络中断，任务已自动暂停，正在检测恢复' });
      this.runner.emitUpdate(updated); return updated;
    }
    const since = new Date(this.runner.now()).toISOString();
    const networkRecovery = { ...previous, state: 'offline', pauseSource: 'network', since,
      reason, successes: 0, step, returnStatus: job.status };
    log('warning', `任务网络暂停：${reason.replace(/https?:\/\/\S+/g, '[链接]').slice(0, 200)}；探测码 ${previous?.lastProbe?.code || '操作返回网络错误'}`);
    const updated = updateJob(jobId, { status: 'paused', waitReason: '网络中断，任务已自动暂停，正在检测恢复', cursor: { ...job.cursor, networkRecovery, verificationBarrier: job.cursor.verificationBarrier || Boolean(job.cursor.manualVerification) } });
    this.runner.emitUpdate(updated); this.arm(jobId); return updated;
  }
  async handle(error, jobId, step) {
    if (!await this.isNetworkError(error, jobId)) return false;
    if (!error.networkHandled) {
      const action = step && getStepAction(jobId, keyFor(step));
      const submitted = action && ['submitted','uncertain'].includes(action.state);
      if (action && action.state !== 'succeeded') updateActionLog(action.id, { state: submitted ? 'uncertain' : 'network_wait', error: '网络中断，等待联网后只读核验或继续原步骤' });
      if (step && action?.state !== 'succeeded') {
        db.prepare("UPDATE task_step_state SET state=?,outcome=NULL WHERE job_id=? AND step_key=?").run(submitted ? 'network_review' : 'pending', jobId, keyFor(step));
      }
      this.pause(jobId, step, error.message);
      error.networkHandled = true;
    }
    return true;
  }
  arm(jobId) {
    if (this.timer && this.jobId === jobId) return;
    this.clear(); this.jobId = jobId;
    this.timer = setInterval(() => { void this.tick(jobId).catch(error => log('warning', `网络恢复检测异常：${error.message}`)); }, 5000);
    this.timer.unref?.();
  }
  clear(jobId = null) {
    if (jobId && this.jobId !== jobId && this.flight?.jobId !== jobId) return;
    this.epoch++; this.flight?.controller.abort();
    clearInterval(this.timer); this.timer = null; this.jobId = null;
  }
  async tick(jobId) {
    if (this.checking) return;
    this.checking = true;
    try {
      this.runner.enforceDailyStop();
      let job = getJob(jobId);
      if (!job || job.stopRequested || ['stopped','completed'].includes(job.status) || job.pausedByUser || job.cursor.networkRecovery?.state !== 'offline') { this.clear(jobId); return; }
      const result = await this.check(job);
      job = getJob(jobId);
      if (!job || job.stopRequested || job.pausedByUser || ['stopped','completed'].includes(job.status)) { this.clear(jobId); return; }
      const info = this.recordProbe(jobId, result);
      if (!info || info.successes < 2 || this.runner.currentExecution) return;
      this.clear(jobId);
      job = getJob(jobId);
      const restoredAt = new Date(this.runner.now()).toISOString();
      job = updateJob(jobId, { cursor: { ...job.cursor, networkRecovery: { ...info, state: 'online', pauseSource: null, since: null, reason: null, step: null, failures: 0, restoredAt,
        lastOutage: { since: info.since, reason: info.reason, restoredAt } } } });
      log('info', `任务网络已恢复，开始只读核验及接续；本次中断始于 ${info.since}`);
      const step = info.step;
      if (step && !this.runner.workflow.session) {
        const action = getStepAction(jobId, keyFor(step));
        if (action && ['submitted','uncertain'].includes(action.state)) {
          const account = getAccount(step.accountId), topic = listTopics().find(t => t.id === step.topicId);
          let result = { state: 'uncertain' };
          try {
            if (step.kind === 'post') result = await this.runner.adapter.verifyPost?.(account, action, { topicName: topic?.name }) || result;
            if (step.kind === 'checkin') result = await this.runner.adapter.verifyCheckin?.(account, topic) || result;
            if (step.kind === 'comment' && action.target_id && action.url) result = await this.runner.adapter.verifyComment?.(account, { id: action.target_id, url: action.url.split('?')[0] }, action.content, { delays: [0] }) || result;
          } catch (error) {
            if (await this.isNetworkError(error, jobId)) { this.pause(jobId, step, error.message); return; }
            if (error.code === 'verification_required' && this.runner.workflow.enabled(job)) { this.runner.workflow.defer(jobId, step, Object.assign(error, { submittedUncertain: true })); result = null; }
          }
          if (getJob(jobId).status === 'stopped') return;
          if (result) {
            if (step.kind === 'checkin' && result.state === 'succeeded') recordCheckin(step.accountId, step.topicId, shanghaiDate(new Date(this.runner.now())));
            if (this.runner.workflow.enabled(job)) this.runner.workflow.finishStep(jobId, step, result.state === 'succeeded' ? 'succeeded' : 'uncertain', result.reason || (result.state === 'succeeded' ? '' : '联网后只读复核仍无法确认，保留待核对'));
            else await this.runner.finishStep(getJob(jobId), step, result.state === 'succeeded' ? 'succeeded' : 'uncertain', result.reason);
          }
        }
      }
      job = getJob(jobId);
      if (job.pausedByUser || job.stopRequested || this.runner.isExpired(jobId)) return;
      const waiting = Boolean(job.cursor.verificationBarrier || this.runner.workflow.session);
      const updated = updateJob(jobId, { status: waiting ? 'waiting' : 'running', waitReason: waiting ? '等待人工验证及补做' : null, cursor: { ...job.cursor, notice: '网络已恢复，继续任务' } });
      this.runner.emitUpdate(updated);
      if (!waiting) this.runner.run(jobId);
    } finally { this.checking = false; }
  }
  async wait(jobId, cancelled = () => false) {
    while (getJob(jobId)?.cursor.networkRecovery?.state === 'offline') {
      const job = getJob(jobId);
      this.runner.enforceDailyStop();
      if (cancelled() || job.stopRequested || job.status === 'stopped' || job.pausedByUser) throw new NetworkOfflineError('网络等待已结束');
      await new Promise(resolve => setTimeout(resolve, 500));
    }
  }
}
