import { EventEmitter } from 'node:events';
import { AsyncLocalStorage } from 'node:async_hooks';
import {
  db, beginPostAttempt, createActionLog, createJob, findIncompleteAction, getAccount, getActionLog, getActiveJob, getCheckin, getJob,
  getSetting, getStepAction, hasCommented, listAccounts, listCommentedTargetIdsForIdentity, listCommentMaterials, listJobs, listPostMaterials, listTopics, nextSequence,
  listActiveAccountRestrictions, recordAccountRestriction, recordCheckin, recordComment, setSetting, updateActionLog, updateJob, log
} from './db.js';
import { config as appConfig, defaultTaskConfig } from './config.js';
import { COMMENT_SECTIONS, isFixedTopic } from '../public/topic-policy.js';
import { BrowserBusyError } from './browser.js';
import { AuthenticationError, IdentityMismatchError, MutedError, RateLimitError, UnsupportedPageError, VerificationError, WeiboAdapter, weiboShortIdToNumeric } from './weibo-adapter.js';
import { id, pickRandom, serializeError, shanghaiDate, kindLabel } from './util.js';
import { normalizeTaskSettings, normalizeEngageSettings } from '../public/defaults.js';
import { listAccountGroups } from './account-groups.js';
import { buildEngageSteps, createEngageSnapshot, validateEngageSnapshot, parseWeiboLink, engageStepCoupling } from './engage.js';
import { startRound, finishRound, runningRounds, refreshRoundSummary } from './task-reports.js';
import { DAILY_STOP_REASON, DailyStopError, dailyStopStatus, deadlineFor } from './daily-stop.js';
import { VerificationWorkflow } from './verification-workflow.js';
import { NetworkRecovery, NetworkOfflineError } from './network-recovery.js';
import { taskProgress } from './task-progress.js';
import { NavigationRecovery } from './navigation-recovery.js';
import { isNavigationError } from './navigation.js';

function commentScanStats() {
  return { scanned: 0, self: 0, rejectedAuthor: 0, duplicate: 0, keyword: 0, countLimit: 0, zero: 0, unavailable: 0 };
}
function commentScanSummary(stats) {
  const reasons = [
    ['self', '本人帖子'], ['rejectedAuthor', '本轮发帖人避让'], ['duplicate', '已评论去重'],
    ['keyword', '未含关键词'], ['countLimit', '已达20评'], ['zero', '非零评'], ['unavailable', '评论数复核不可用']
  ].filter(([key]) => stats[key]).map(([key, label]) => `${label} ${stats[key]} 条`);
  return `扫描 ${stats.scanned} 条${reasons.length ? `；${reasons.join('，')}` : '；暂无可用帖子'}`;
}

export function buildSteps(snapshot) {
  if (snapshot.kind === 'engage') return buildEngageSteps(snapshot);
  const steps = [];
  for (let round = 0; round < snapshot.rounds; round += 1) {
    for (const topicId of snapshot.topicIds) {
      if (Number(snapshot.schedulerVersion || 0) >= 2) {
        snapshot.actionPlan.forEach((group, actionIndex) => {
          for (const accountId of snapshot.accountIds) {
            const count = group.type === 'checkin' ? Math.min(1, group.count) : group.count;
            for (let unitIndex = 0; unitIndex < count; unitIndex++) steps.push({ round, topicId, accountId, kind: group.type, actionIndex, segmentId: group.segmentId || snapshot.segmentIds?.[actionIndex] || null, unitIndex });
          }
        });
        continue;
      }
      for (const accountId of snapshot.accountIds) {
        snapshot.actionPlan.forEach((group, actionIndex) => {
          const count = group.type === 'checkin' ? Math.min(1, group.count) : group.count;
          for (let unitIndex = 0; unitIndex < count; unitIndex += 1) {
            steps.push({ round, topicId, accountId, kind: group.type, actionIndex, unitIndex });
          }
        });
      }
    }
  }
  return steps;
}

export function validateSnapshot(snapshot) {
  if (snapshot.kind === 'engage') return validateEngageSnapshot(snapshot);
  const errors = [];
  if (appConfig.topicMode === 'fixed') {
    const topics = listTopics();
    if (snapshot.topicIds?.length !== 1 || !snapshot.topicIds.every(id => isFixedTopic(topics.find(t => t.id === id)))) errors.push('当前仅支持苏新皓超话，请重新选择任务参数');
    if (!COMMENT_SECTIONS.includes(snapshot.commentSection)) errors.push('指定分区无法识别，请从下拉列表重新选择');
  }
  if (!snapshot.accountIds?.length) errors.push('至少选择一个启用账号');
  if (!snapshot.topicIds?.length) errors.push('至少选择一个启用超话');
  if (!snapshot.actionPlan?.length || !snapshot.actionPlan.some(item => item.count > 0)) errors.push('至少配置一个操作');
  if (snapshot.actionPlan?.some(item => !['checkin', 'post', 'comment'].includes(item.type) || item.count < 1)) errors.push('操作计划包含无效项目');
  if (snapshot.actionPlan?.some(item => item.type === 'comment') && new Set((snapshot.materials?.comments || []).map(item => item.text.trim())).size < 2) {
    errors.push('评论任务需要至少两条共享评论文案');
  }
  if (snapshot.actionPlan?.some(item => item.type === 'post')) {
    if (Array.isArray(snapshot.materials?.posts)) {
      if (new Set(snapshot.materials.posts.map(item => String(item.text || '').trim()).filter(Boolean)).size < 2) {
        errors.push('发帖任务需要至少两条共享发帖文案');
      }
    } else for (const accountId of snapshot.accountIds || []) {
      const texts = (snapshot.materials?.posts?.[accountId] || []).map(item => String(item.text ?? item).trim()).filter(Boolean);
      if (new Set(texts).size < 2) errors.push(`账号 ${accountId} 至少需要两条发帖文案`);
    }
  }
  return errors;
}

export function createSnapshot(input, accounts, topics) {
  if (input?.kind === 'engage') return createEngageSnapshot(input, accounts);
  if (appConfig.topicMode === 'fixed') {
    topics = topics.filter(isFixedTopic).slice(0, 1);
    if (input?.topicIds && (input.topicIds.length !== 1 || input.topicIds[0] !== topics[0]?.id)) throw Object.assign(new Error('当前仅支持苏新皓超话'), { statusCode: 400 });
    input = { ...input, topicIds: topics.map(t => t.id) };
  }
  const saved = getSetting('task_defaults', {}) || {};
  const defaults = normalizeTaskSettings({ ...defaultTaskConfig, ...normalizeTaskSettings(saved), ...(input || {}), ...(input?.decoration && !input.commentDecoration ? { commentDecoration: input.decoration } : {}) });
  const accountIds = [...new Set(defaults.accountIds || accounts.filter(item => item.enabled).map(item => item.id))]
    .filter(accountId => accounts.some(item => item.id === accountId && item.enabled));
  const groups = new Map(listAccountGroups().map(group => [group.id, group.name]));
  const topicIds = (defaults.topicIds || topics.filter(item => item.enabled).map(item => item.id))
    .filter(topicId => topics.some(item => item.id === topicId && item.enabled));
  const inGroup = (item, groups) => !groups?.length || groups.includes(item.group_id || '');
  return {
    ...defaults,
    snapshotVersion: 5,
    schedulerVersion: 3,
    rounds: Math.max(1, Math.min(100, Number(defaults.rounds) || 1)),
    accountIds,
    topicIds,
    accountIdentities: Object.fromEntries(accounts.filter(account => accountIds.includes(account.id)).map(account => [account.id, { name: account.nickname || account.name, uid: account.uid || '', groupName: groups.get(account.group_id || '') || '未分组' }])),
    topicIdentities: Object.fromEntries(topics.filter(topic => topicIds.includes(topic.id)).map(topic => [topic.id, { name: topic.name }])),
    // Keep the public actionPlan shape compatible with earlier snapshots;
    // stable IDs live alongside it and are used in persisted step keys.
    segmentIds: defaults.actionPlan.map((item, index) => item.segmentId || defaults.segmentIds?.[index] || id('seg_')),
    actionPlan: defaults.actionPlan.map(item => ({ type: item.type, count: Math.max(1, Math.min(100, Number(item.count) || 1)), intervalSeconds: item.intervalSeconds })),
    materials: {
      comments: listCommentMaterials().filter(item => item.enabled && inGroup(item, defaults.commentGroupIds)).map(({ id, text }) => ({ id, text })),
      posts: listPostMaterials().filter(item => item.enabled && inGroup(item, defaults.postGroupIds)).map(({ id, text }) => ({ id, text }))
    }
  };
}

export function decorateText(raw, decoration = {}, kind = 'comment', sequence = null) {
  const mode = decoration.mode || 'none';
  let result = raw;
  if (mode === 'emoji' || mode === 'emoji-and-number') {
    const emoji = pickRandom((decoration.emojis || []).filter(Boolean)) || '';
    if (emoji) result = decoration.emojiPosition === 'prefix' ? `${emoji}${result}` : `${result}${emoji}`;
  }
  if (mode === 'number' || mode === 'emoji-and-number') {
    const number = String(sequence ?? nextSequence(kind));
    result = decoration.numberPosition === 'prefix' ? `${number}${result}` : `${result}${number}`;
  }
  return result;
}

export class TaskRunner extends EventEmitter {
  constructor(adapter, { now = Date.now, scope = null, leases = null } = {}) {
    super();
    this.adapter = adapter;
    this.scope = scope;
    this.leases = leases;
    this.adapter.log = log;
    this.promise = null;
    this.verificationTimers = new Map();
    this.readbackTimers = new Map();
    this.now = now;
    this.executionStorage = new AsyncLocalStorage();
    this.currentExecution = null;
    this.engageSession = null;
    this.accountRestrictions = [];
    this.accountRestrictionsAt = 0;
    this.workflow = new VerificationWorkflow(this, buildSteps);
    this.network = new NetworkRecovery(this);
    this.navigation = new NavigationRecovery(this);
  }

  activeAccountRestrictions() {
    if (this.now() - this.accountRestrictionsAt > 5000) {
      this.accountRestrictions = listActiveAccountRestrictions(new Date(this.now()).toISOString());
      this.accountRestrictionsAt = this.now();
    }
    return this.accountRestrictions;
  }

  restrictionFor(accountId, kind, identity = '') {
    return listActiveAccountRestrictions(new Date(this.now()).toISOString()).find(item => (item.accountId === accountId || (identity && item.identity === identity)) && ((item.type === 'mute' && ['post','comment','repost'].includes(kind)) || (item.type === 'frequent' && item.kind === kind))) || null;
  }

  dailyStopStatus() { return dailyStopStatus(this.now()); }

  dailyStopEnabled() { return this.scope !== 'engage'; }

  taskDeadline(job) {
    if (job?.scope === 'engage' || this.scope === 'engage') return Infinity;
    if (!job.cursor.deadlineAt) {
      job = updateJob(job.id, { cursor: { ...job.cursor, deadlineAt: new Date(deadlineFor(Date.parse(job.created_at))).toISOString() } });
    }
    return Date.parse(job.cursor.deadlineAt);
  }

  isExpired(jobId) {
    const job = getJob(jobId);
    return Boolean(job && job.scope !== 'engage' && (job.cursor.dailyStop || this.now() >= this.taskDeadline(job)));
  }

  assertExecutionAlive() {
    if (this.executionStorage.getStore()?.cancelled) throw new DailyStopError();
  }

  assertMaySubmit(jobId) {
    this.assertExecutionAlive();
    const job = getJob(jobId);
    if (job && appConfig.topicMode === 'fixed') {
      const errors = validateSnapshot(job.config);
      if (errors.length) throw Object.assign(new UnsupportedPageError(errors.join('；')), { statusCode: 400 });
    }
    if (!job || job.status === 'stopped' || this.isExpired(jobId)) {
      this.enforceDailyStop();
      throw new DailyStopError();
    }
    if (job.cursor.networkRecovery?.state === 'offline') throw new NetworkOfflineError();
    if (this.navigation.waiting(job)) throw Object.assign(new Error('页面恢复等待中，禁止提交'), { code: 'navigation_unavailable', navigationHandled: true });
  }

  activeManualStep(jobId, step) {
    const session = this.workflow.session;
    return Boolean(session && session.jobId === jobId && session.stepKey === stepKeyFor(step)
      && !session.cancelled && !session.windowClosed && !session.page?.isClosed?.());
  }

  markSubmitted(jobId, step, actionId, attemptId = null) {
    this.assertMaySubmit(jobId);
    if (getActionLog(actionId)?.state === 'succeeded') throw new DailyStopError('当前操作已确认成功，禁止再次提交');
    const context = this.executionStorage.getStore();
    if (attemptId && getActionLog(actionId)?.attempt_id !== attemptId) throw new DailyStopError();
    const manual = this.workflow.session;
    if (manual?.jobId === jobId && manual.stepKey === stepKeyFor(step)
      && (manual.cancelled || manual.windowClosed || manual.page?.isClosed?.())) {
      throw new VerificationError('验证窗口已结束，未提交');
    }
    if (context) context.submitted = true;
    updateActionLog(actionId, { state: 'submitted', attemptId, submittedAt: new Date(this.now()).toISOString() });
    if (manual?.jobId === jobId && manual.stepKey === stepKeyFor(step)) {
      manual.submitted = true;
      manual.attemptId = getActionLog(actionId)?.attempt_id;
    }
    this.lastSubmitted = { jobId, stepKey: stepKeyFor(step), at: this.now() };
    this.confirmSequence(jobId, step);
  }

  enforceDailyStop() {
    if (!this.dailyStopEnabled()) return;
    for (const row of db.prepare("SELECT id,scope FROM jobs WHERE status IN ('running','waiting','paused')").all().filter(row => !this.scope || row.scope === this.scope)) {
      let job = getJob(row.id);
      const deadline = this.taskDeadline(job);
      if (!job.cursor.dailyStop && this.now() < deadline) continue;
      this.clearVerificationRecovery(job.id);
      this.navigation.clear(job.id);
      job = getJob(job.id);
      if (!job.cursor.dailyStop) {
        job = updateJob(job.id, { stopRequested: true, pausedByUser: false, waitReason: DAILY_STOP_REASON,
          cursor: { ...job.cursor, verificationRecovery: null, stopReason: DAILY_STOP_REASON,
            dailyStop: { requestedAt: new Date(this.now()).toISOString(), deadlineAt: new Date(deadline).toISOString() } } });
        log('warning', DAILY_STOP_REASON, { jobId: job.id, scope: job.scope });
        this.emitUpdate(job);
      }
      const context = this.currentExecution;
      if (context?.jobId === job.id) {
        const remaining = deadline + 30000 - this.now();
        if (context.submitted && remaining > 0) {
          if (!context.graceTimer) {
            context.graceTimer = setTimeout(() => this.enforceDailyStop(), remaining);
            context.graceTimer.unref?.();
          }
        } else {
          context.cancel();
          this.finalizeDailyStop(job.id, context.step);
        }
      } else this.finalizeDailyStop(job.id);
    }
  }

  finalizeDailyStop(jobId, step = null) {
    let job = getJob(jobId);
    if (!job || job.status === 'stopped') return job;
    if (this.workflow.enabled(job)) return this.workflow.finalizeStop(jobId, DAILY_STOP_REASON);
    this.clearVerificationRecovery(jobId);
    step ||= buildSteps(job.config)[Number(job.cursor.stepIndex || 0)];
    let action = step ? getStepAction(jobId, stepKeyFor(step)) : null;
    if (action && !['succeeded', 'failed', 'uncertain', 'skipped'].includes(action.state)) {
      const submitted = action.state === 'submitted' || action.state === 'started';
      action = updateActionLog(action.id, { state: submitted ? 'uncertain' : 'skipped', error: submitted ? `${DAILY_STOP_REASON}，提交结果未能在截止后30秒内确认` : `${DAILY_STOP_REASON}，操作尚未提交` });
    }
    if (action && ['succeeded', 'uncertain'].includes(action.state)) this.confirmSequence(jobId, step);
    else if (step) this.releaseSequence(jobId, step);
    if (action?.kind === 'checkin' && action.state === 'uncertain') recordCheckin(action.account_id, action.topic_id, shanghaiDate(new Date(action.started_at)), 'uncertain');
    job = getJob(jobId);
    const metrics = { ...job.metrics };
    if (action) {
      const key = action.state === 'succeeded' ? 'success' : action.state;
      metrics[key] = Number(metrics[key] || 0) + 1;
    }
    const updated = updateJob(jobId, { status: 'stopped', stopRequested: true, pausedByUser: false, waitReason: null, metrics,
      cursor: { ...job.cursor, verificationRecovery: null, stopReason: DAILY_STOP_REASON,
        dailyStop: { ...job.cursor.dailyStop, stoppedAt: new Date(this.now()).toISOString() },
        stepIndex: Number(job.cursor.stepIndex || 0) + (action ? 1 : 0) } });
    for (const round of runningRounds(jobId)) finishRound(jobId, round, 'stopped');
    this.emitUpdate(updated);
    void Promise.resolve(this.adapter.cancelTask?.()).catch(() => {});
    return updated;
  }

  async withDailyDeadline(job, step, callback) {
    this.assertMaySubmit(job.id);
    const context = { jobId: job.id, step, submitted: false, cancelled: false };
    const cancelled = new Promise((_, reject) => { context.cancel = () => { if (!context.cancelled) { context.cancelled = true; reject(new DailyStopError()); } }; });
    this.currentExecution = context;
    const remaining = this.taskDeadline(getJob(job.id)) - this.now();
    const timer = Number.isFinite(remaining) ? setTimeout(() => this.enforceDailyStop(), Math.max(0, remaining)) : null;
    timer?.unref?.();
    try {
      return await this.executionStorage.run(context, () => Promise.race([Promise.resolve().then(callback), cancelled]));
    } finally {
      if (timer) clearTimeout(timer); clearTimeout(context.graceTimer);
      if (this.currentExecution === context) this.currentExecution = null;
    }
  }

  workbenchVerification(job) {
    return job?.scope === 'workbench' && job?.config?.kind !== 'engage' && this.scope !== 'engage';
  }

  groupedEngage(job) {
    return job?.config?.kind === 'engage' && Number(job.config.schedulerVersion || 0) >= 4;
  }

  async releaseEngageSession() {
    const session = this.engageSession;
    if (!session) return;
    this.engageSession = null;
    try {
      try { await this.adapter.resetEngageSession?.(); }
      finally { await this.adapter.browserManager?.closeRunner?.(); }
    } finally { session.release?.(); }
  }

  async ensureStepIdentity(job, account) {
    const session = this.engageSession;
    const manager = this.adapter.browserManager;
    if (this.groupedEngage(job) && session?.accountId === account.id && session.identified
      && (!manager || manager.generation == null || (manager.accountId === account.id && manager.generation === session.generation))) return;
    await this.adapter.ensureIdentity(account);
    if (this.groupedEngage(job) && this.engageSession === session && session) {
      session.identified = true;
      session.generation = manager?.generation;
    }
  }

  async withAccountLease(job, account, callback, { step, manual = false } = {}) {
    if (this.groupedEngage(job) && step && !manual) {
      const key = JSON.stringify([job.id, step.round, step.topicId, account.id]);
      if (this.engageSession && this.engageSession.key !== key) await this.releaseEngageSession();
      if (!this.engageSession) {
        const release = this.leases?.acquire(account, this.scope || job.scope || job.id);
        this.engageSession = { key, jobId:job.id, round:step.round, link:step.topicId, accountId:account.id, release, identified:false };
      }
      // Keep the account's persistent context alive across recoverable
      // outcomes.  The workflow releases it only when the group is finished or
      // the task is paused/stopped; closing here caused empty verification or
      // rate-limit failures to reopen the same account for the next action.
      return callback();
    }
    if (!this.leases) return callback();
    const release = this.leases.acquire(account, this.scope || job.scope || job.id);
    try { return await callback(); }
    finally { try { await this.adapter.browserManager?.closeRunner?.(); } finally { release(); } }
  }

  async finishEngageGroupIfNeeded(jobId, row, outcome) {
    const session = this.engageSession, job = getJob(jobId);
    if (!session || session.jobId !== jobId) return;
    const next = this.workflow.rows(jobId, row.round_index).find(item => item.state === 'pending');
    if (!job || job.status === 'paused' || job.stopRequested || job.cursor.manualVerification || job.cursor.verificationBarrier
      || !next || next.account_id !== session.accountId
      || next.topic_id !== session.link || next.round_index !== session.round) await this.releaseEngageSession();
  }

  async dismissBackgroundChallenge(error) {
    if (this.scope !== 'engage' || !error?.challengePage) return false;
    try { return await this.adapter.dismissBackgroundChallenge?.(error.challengePage) || false; }
    catch (failure) { log('warning', '关闭后台验证页失败：' + failure.message, { jobId: error.jobId }); return false; }
  }

  current() { return getActiveJob(this.scope); }

  acceptedPost(actionId) {
    const action = getActionLog(actionId);
    return action?.state === 'succeeded' ? { state: 'succeeded', receiptId: action.receipt_id, receiptUrl: action.receipt_url,
      url: action.receipt_url || action.url, successSource: action.success_source } : null;
  }

  settlePostAction(actionId, patch, { emit: allowEmit = true } = {}) {
    let action, emit = false;
    const before = getActionLog(actionId);
    if (patch.attemptId && patch.attemptId !== before?.attempt_id) return before;
    if (before?.kind === 'repost' && patch.receiptId && db.prepare("SELECT 1 FROM action_logs WHERE kind='repost' AND receipt_id=? AND id<>?").get(String(patch.receiptId), actionId)) throw Object.assign(new Error('该转发回执已属于另一条操作'), { code: 'receipt_persistence_failed' });
    db.exec('SAVEPOINT settle_post_action');
    try {
      action = updateActionLog(actionId, patch);
      if (!action || (patch.attemptId && patch.attemptId !== action.attempt_id)) {
        db.exec('RELEASE SAVEPOINT settle_post_action'); return action;
      }
      const row = db.prepare('SELECT * FROM task_step_state WHERE job_id=? AND step_key=?').get(action.job_id, action.step_key);
      if (action.state === 'succeeded') {
        if (action.kind === 'comment' && action.target_id) recordComment(action.account_id, action.target_id, action.receipt_url || action.url);
        if (row) this.confirmSequence(action.job_id, { round: row.round_index, topicId: row.topic_id, accountId: row.account_id,
          kind: action.kind, segmentId: row.segment_id, actionIndex: row.action_index, unitIndex: row.unit_index });
        if (row && ['done', 'review', 'network_review'].includes(row.state)) {
          db.prepare("UPDATE task_step_state SET state='done',outcome='succeeded' WHERE job_id=? AND step_key=?").run(action.job_id, action.step_key);
          this.workflow.refreshCard(action.job_id, row.round_index, row.identity);
          this.workflow.updateProgress(action.job_id, { emit: false }); emit = true;
          refreshRoundSummary(action.job_id, row.round_index);
        }
      }
      db.exec('RELEASE SAVEPOINT settle_post_action');
    } catch (error) {
      db.exec('ROLLBACK TO SAVEPOINT settle_post_action; RELEASE SAVEPOINT settle_post_action'); throw error;
    }
    if (emit && allowEmit) this.emitUpdate(getJob(action.job_id));
    return action;
  }

  repairPostResult(action, result) {
    db.exec('SAVEPOINT repair_post_result');
    let updated;
    try {
      const current = getActionLog(action.id);
      if (!current || current.state === 'succeeded') { db.exec('RELEASE SAVEPOINT repair_post_result'); return current; }
      const state = result.state === 'succeeded' ? 'succeeded' : 'uncertain';
      const receiptId = result.receiptId || result.matchedPostId;
      updated = this.settlePostAction(action.id, { state, receiptId, receiptUrl: result.receiptUrl || result.url,
        url: result.url, sequenceConfirmed: state === 'succeeded' ? true : Boolean(current.sequence_confirmed),
        error: state === 'succeeded' ? '' : result.reason || '历史发帖结果待核对', completedAt: current.completed_at }, { emit: false });
      const row = db.prepare('SELECT * FROM task_step_state WHERE job_id=? AND step_key=?').get(action.job_id, action.step_key);
      if (row) {
        db.prepare('UPDATE task_step_state SET state=?,outcome=? WHERE job_id=? AND step_key=?')
          .run(state === 'uncertain' && row.ever_verification ? 'review' : 'done', state, action.job_id, action.step_key);
        this.workflow.updateProgress(action.job_id, { emit: false });
        this.workflow.refreshCard(action.job_id, row.round_index, row.identity);
        refreshRoundSummary(action.job_id, row.round_index);
      } else {
        const metrics = { ...getJob(action.job_id).metrics };
        if (current.state !== state) {
          const previousKey = current.state === 'succeeded' ? 'success' : current.state;
          const nextKey = state === 'succeeded' ? 'success' : state;
          metrics[previousKey] = Math.max(0, Number(metrics[previousKey] || 0) - 1);
          metrics[nextKey] = Number(metrics[nextKey] || 0) + 1;
        }
        updateJob(action.job_id, { metrics });
        refreshRoundSummary(action.job_id, Number(action.step_key.split(':')[0]), { action: current, nextState: state });
      }
      if (current.state !== state || current.error !== updated.error || receiptId) {
        db.prepare(`INSERT INTO post_result_repairs(action_id,job_id,previous_state,next_state,original_error,receipt_id,receipt_url,reason,repaired_at)
          VALUES(?,?,?,?,?,?,?,?,?)`).run(action.id, action.job_id, current.state, state, current.error, receiptId || null,
          result.receiptUrl || result.url || null, result.reason || '', new Date(this.now()).toISOString());
      }
      if (current.state !== state) {
        const date = shanghaiDate(new Date(current.started_at));
        const archived = db.prepare('SELECT counts_json FROM daily_stats WHERE date=?').get(date);
        if (archived) {
          const counts = JSON.parse(archived.counts_json);
          const post = counts.post || (counts.post = {});
          post[current.state] = Math.max(0, Number(post[current.state] || 0) - 1);
          post[state] = Number(post[state] || 0) + 1;
          db.prepare('UPDATE daily_stats SET counts_json=? WHERE date=?').run(JSON.stringify(counts), date);
        }
        const scope = current.scope || getJob(current.job_id)?.scope || 'workbench';
        const scoped = db.prepare('SELECT counts_json FROM daily_scope_stats WHERE date=? AND scope=?').get(date, scope);
        if (scoped) {
          const counts = JSON.parse(scoped.counts_json || '{}'), post = counts.post || (counts.post = {});
          post[current.state] = Math.max(0, Number(post[current.state] || 0) - 1);
          post[state] = Number(post[state] || 0) + 1;
          db.prepare('UPDATE daily_scope_stats SET counts_json=? WHERE date=? AND scope=?').run(JSON.stringify(counts), date, scope);
        }
        const completedDate = shanghaiDate(new Date(current.completed_at || current.started_at));
        const successful = db.prepare('SELECT success_json FROM daily_scope_stats WHERE date=? AND scope=?').get(completedDate, scope);
        if (successful && (current.state === 'succeeded' || state === 'succeeded')) {
          const values = JSON.parse(successful.success_json || '{}');
          values.post = Math.max(0, Number(values.post || 0) + (state === 'succeeded' ? 1 : -1));
          db.prepare('UPDATE daily_scope_stats SET success_json=? WHERE date=? AND scope=?').run(JSON.stringify(values), completedDate, scope);
        }
      }
      db.exec('RELEASE SAVEPOINT repair_post_result');
    } catch (error) { db.exec('ROLLBACK TO SAVEPOINT repair_post_result; RELEASE SAVEPOINT repair_post_result'); throw error; }
    this.emitUpdate(getJob(action.job_id));
    return updated;
  }

  postClaimIsUnique(action, found) {
    const receiptId = found.receiptId || found.matchedPostId;
    if (!receiptId) return false;
    if (db.prepare("SELECT 1 FROM action_logs WHERE kind='post' AND id<>? AND receipt_id=? LIMIT 1").get(action.id, receiptId)) return false;
    const created = Date.parse(found.createdAt);
    const related = db.prepare(`SELECT l.* FROM action_logs l LEFT JOIN accounts a ON a.id=l.account_id
      WHERE l.kind='post' AND l.id<>? AND l.topic_id=? AND l.content=?
      AND (l.account_id=? OR (a.uid<>'' AND a.uid=(SELECT uid FROM accounts WHERE id=?)))
      AND l.state NOT IN ('prepared','cancelled','verification_wait')`).all(action.id, action.topic_id, action.content, action.account_id, action.account_id);
    return !related.some(other => {
      if (/未发送/.test(other.error || '')) return false;
      const start = Date.parse(other.submitted_at || other.started_at) - 30000;
      const end = other.submitted_at ? Date.parse(other.submitted_at) + 120000 : Date.parse(other.completed_at || other.started_at) + 30000;
      return Number.isFinite(created) ? created >= start && created <= end : true;
    });
  }


  async repairUncertainPosts(jobId, { limit = 4, includeReceiptFailures = false, actionIds = null } = {}) {
    const job = getJob(jobId), active = this.current();
    const conflict = message => Object.assign(new Error(message), { statusCode: 409 });
    if (!job || !['paused', 'completed', 'stopped'].includes(job.status)) throw conflict('请先让任务结束或安全暂停，再核对历史发帖');
    if (this.repairing || this.promise || this.currentExecution || this.workflow.busy() ||
      (active && !(active.status === 'paused' && active.pausedByUser))) throw conflict('请等待所有发布操作和验证会话结束');
    const count = Math.max(1, Math.min(2000, Number(limit) || 4));
    // Freeze IDs before the first await; later requests cannot expand this batch.
    const actions = db.prepare(`SELECT * FROM action_logs WHERE job_id=? AND kind='post'
      AND (state='uncertain' OR (?=1 AND state='failed' AND error='微博回执明确表示发帖未被接受'))
      ORDER BY account_id,started_at,id`).all(jobId, Number(includeReceiptFailures))
      .filter(action => !actionIds || actionIds.includes(action.id)).slice(0, count);
    this.repairing = true;
    const results = [];
    try {
      for (const action of actions) {
        const current = this.current();
        if (current && !(current.status === 'paused' && current.pausedByUser)) throw conflict('有任务开始运行，已停止历史核对');
        const account = getAccount(action.account_id), topic = listTopics().find(item => item.id === action.topic_id);
        let result = { state: 'uncertain', reason: '原账号或超话不可用，无法核对' };
        if (account && topic) {
          const controller = new AbortController(), timer = setTimeout(() => controller.abort(), 30000);
          try {
            result = await this.adapter.findPublishedPost(account, { content: action.content, topic, startedAt: action.started_at,
              submittedAt: action.submitted_at, completedAt: action.completed_at, syncToHome: job.config.syncToHome === true,
              maxBatches: 20, signal: controller.signal, assertRunning: () => {
                const running = this.current();
                if (controller.signal.aborted || (running && !(running.status === 'paused' && running.pausedByUser))) throw conflict('只读核对已超时或被中断');
              } });
            if (result.state === 'succeeded' && !this.postClaimIsUnique(action, result)) result = { state: 'uncertain', reason: '帖子可能属于另一条操作，不能唯一归属' };
          } catch (error) { result = { state: 'uncertain', reason: `历史只读核对未完成：${error.message}` }; }
          finally { clearTimeout(timer); controller.abort(); }
        }
        const updated = this.repairPostResult(action, result);
        results.push({ actionId: action.id, previousState: action.state, state: updated.state,
          receiptId: updated.receipt_id, url: updated.receipt_url, reason: updated.error || '' });
      }
      return { job: getJob(jobId), actionIds: actions.map(action => action.id), results };
    } finally {
      this.repairing = false;
      await this.adapter.cancelTask?.();
    }
  }

  async recheckUncertainAction(jobId, actionId) {
    const job = getJob(jobId);
    const action = getActionLog(actionId);
    if (!job || !action || action.job_id !== jobId) throw Object.assign(new Error('找不到这条待核对操作'), { statusCode: 404 });
    if (!['uncertain', 'submitted'].includes(action.state)) throw Object.assign(new Error('只有待核对操作可以复核'), { statusCode: 400 });
    if (this.repairing || this.promise || this.currentExecution || this.workflow.busy()) throw Object.assign(new Error('请等待当前浏览器操作和验证会话结束'), { statusCode: 409 });
    if (['repost','like','comment_like'].includes(action.kind)) {
      this.repairing = true;
      try {
        const account = getAccount(action.account_id);
        const result = await this.withAccountLease(job, account, async () => {
          await this.adapter.ensureIdentity(account);
          if (action.kind === 'repost') return this.adapter.verifyRepost(account, action);
          if (action.kind === 'like') return this.adapter.verifyLike(account, action.link || action.url);
          return this.adapter.verifyCommentLike(account, action.link || action.url, action.target_id);
        });
        if (result.state === 'succeeded') {
          this.settlePostAction(action.id, { state: 'succeeded', error: '', url: result.url || action.url, receiptId: result.receiptId });
          const row = db.prepare('SELECT * FROM task_step_state WHERE job_id=? AND step_key=?').get(jobId, action.step_key);
          if (row) db.prepare("UPDATE task_step_state SET state='done',outcome='succeeded' WHERE job_id=? AND step_key=?").run(jobId, action.step_key);
          this.workflow.updateProgress(jobId); refreshRoundSummary(jobId, row?.round_index || 0);
        }
        return result;
      } finally { this.repairing = false; }
    }
    if (action.kind === 'comment') {
      const result = await this.withAccountLease(job, getAccount(action.account_id), () => this.recheckCommentAction(jobId, actionId));
      if (result.state === 'succeeded' && this.workflow.enabled(job)) this.workflow.updateProgress(jobId);
      return result;
    }
    if (action.kind !== 'post') throw Object.assign(new Error('当前操作类型不支持复核'), { statusCode: 400 });
    const account = getAccount(action.account_id), topic = listTopics().find(item => item.id === action.topic_id);
    if (!account || !topic) throw Object.assign(new Error('原账号或超话不可用，无法复核'), { statusCode: 400 });
    this.repairing = true;
    try {
      const found = await this.adapter.findPublishedPost(account, { content: action.content, topic, startedAt: action.started_at,
        submittedAt: action.submitted_at, completedAt: action.completed_at, syncToHome: job.config.syncToHome === true });
      if (found.state !== 'succeeded') return { state: 'uncertain', reason: found.reason || '仍未找到唯一匹配内容' };
      if (!this.postClaimIsUnique(action, found)) return { state: 'uncertain', reason: '帖子可能属于另一条操作，不能唯一归属' };
      const result = this.repairPostResult(action, found);
      return { state: result.state, receiptId: result.receipt_id, url: result.receipt_url || result.url };
    } finally { this.repairing = false; }
  }

  scheduleAutoReadbacks(jobId = null) {
    if (this.scope !== 'engage') return;
    const job = jobId ? getJob(jobId) : listJobs(20, 'engage').find(item => ['completed', 'stopped'].includes(item.status));
    if (!job || !['completed', 'stopped'].includes(job.status) || job.scope !== 'engage') return;
    if (this.readbackTimers.has(job.id)) return;
    if (!this.autoReadbackCandidates(job).length) return;
    const timer = setTimeout(() => void this.runAutoReadbacks(job.id), 1000);
    timer.unref?.();
    this.readbackTimers.set(job.id, timer);
  }

  autoReadbackCandidates(job) {
    const ledger = job?.cursor?.autoReadbacks || {};
    return db.prepare(`SELECT * FROM action_logs WHERE job_id=? AND kind IN ('comment','repost')
      AND state='uncertain' AND submitted_at IS NOT NULL AND error LIKE '%频繁%'
      ORDER BY started_at,id`).all(job.id).filter(action => Number(ledger[action.id]?.attempts || 0) < 2);
  }

  async runAutoReadbacks(jobId) {
    this.readbackTimers.delete(jobId);
    let job = getJob(jobId);
    if (!job || job.scope !== 'engage' || !['completed', 'stopped'].includes(job.status)) return;
    if (this.promise || this.currentExecution || this.workflow.busy()) {
      const timer = setTimeout(() => void this.runAutoReadbacks(jobId), 15000);
      timer.unref?.();
      this.readbackTimers.set(jobId, timer);
      return;
    }
    for (const action of this.autoReadbackCandidates(job)) {
      try {
        const result = await this.recheckUncertainAction(jobId, action.id);
        job = getJob(jobId);
        const ledger = { ...(job.cursor?.autoReadbacks || {}) };
        const previous = ledger[action.id] || { attempts: 0 };
        ledger[action.id] = { attempts: Number(previous.attempts || 0) + 1,
          lastCheckedAt: new Date(this.now()).toISOString(), state: result?.state || 'uncertain',
          reason: String(result?.reason || '').slice(0, 240) };
        job = updateJob(jobId, { cursor: { ...job.cursor, autoReadbacks: ledger } });
      } catch (error) {
        if (Number(error?.statusCode) === 409) break;
        job = getJob(jobId);
        if (!job) break;
        const ledger = { ...(job.cursor?.autoReadbacks || {}) };
        const previous = ledger[action.id] || { attempts: 0 };
        ledger[action.id] = { attempts: Number(previous.attempts || 0) + 1,
          lastCheckedAt: new Date(this.now()).toISOString(), state: 'uncertain',
          reason: String(error?.message || '只读复核失败').slice(0, 240) };
        job = updateJob(jobId, { cursor: { ...job.cursor, autoReadbacks: ledger } });
      }
    }
    job = getJob(jobId);
    if (job) this.emitUpdate(job);
    if (job && this.autoReadbackCandidates(job).length) {
      const timer = setTimeout(() => void this.runAutoReadbacks(jobId), 10000);
      timer.unref?.();
      this.readbackTimers.set(jobId, timer);
    }
  }

  async recheckCommentAction(jobId, actionId) {
    const action = getActionLog(actionId);
    if (!action || action.job_id !== jobId || action.kind !== 'comment') throw new Error('找不到这条评论操作记录');
    if (action.state === 'succeeded') return { state: 'succeeded', alreadySucceeded: true, url: action.url };
    if (action.state !== 'uncertain') throw new Error('只有待核对的评论记录可以只读复核');
    if (!action.content || !action.target_id || !action.url) throw new Error('记录缺少评论文案或目标微博链接，无法复核');
    if (typeof this.adapter.verifyComment !== 'function') throw new Error('当前微博适配器不支持只读评论复核');
    const account = getAccount(action.account_id);
    if (!account || account.deleted_at) throw new Error('原账号资料不可用，无法复核');
    const job = getJob(jobId);
    const topic = listTopics().find(item => item.id === action.topic_id);
    const targetUrl = action.url.split('?')[0];
    const authorUid = new URL(targetUrl).pathname.match(/^\/(\d+)\//)?.[1] || '';
    const candidate = { id: action.target_id, url: targetUrl, authorUid };
    const result = await this.adapter.verifyComment(account, candidate, action.content, { delays: [0] });
    if (result.state !== 'succeeded') return { state: 'uncertain', reason: result.reason || '倒序列表暂未找到匹配评论' };
    const updated = updateActionLog(actionId, { state: 'succeeded', url: result.url || action.url, error: '' });
    recordComment(action.account_id, action.target_id, result.url || action.url);
    const freshJob = getJob(jobId);
    const metrics = {
      ...freshJob.metrics,
      success: Math.max(0, Number(freshJob.metrics.success || 0)) + 1,
      uncertain: Math.max(0, Number(freshJob.metrics.uncertain || 0) - 1)
    };
    const corrected = updateJob(jobId, { metrics });
    this.emitUpdate(corrected);
    const row = db.prepare('SELECT * FROM task_step_state WHERE job_id=? AND step_key=?').get(jobId, action.step_key);
    if (row) db.prepare("UPDATE task_step_state SET state='done',outcome='succeeded' WHERE job_id=? AND step_key=?").run(jobId, action.step_key);
    if (topic) log('success', '待核对评论已通过倒序昵称和完整文案复核', { accountId: account.id, topicId: topic?.id, url: updated.url });
    return { state: 'succeeded', url: updated.url, metrics };
  }

  start(input, accounts, topics) {
    this.enforceDailyStop();
    if (this.dailyStopEnabled() && this.dailyStopStatus().blocked) throw new DailyStopError('每日23:59停止任务，00:00后可开始新任务');
    const existing = getActiveJob(input?.kind === 'engage' ? 'engage' : 'workbench');
    if (this.scope && this.scope !== (input?.kind === 'engage' ? 'engage' : 'workbench')) throw Object.assign(new Error('任务类型不匹配'), { statusCode: 400 });
    if (existing) return { job: existing, created: false };
    const snapshot = createSnapshot(input, accounts, topics);
    const errors = validateSnapshot(snapshot);
    if (errors.length) {
      const error = new Error(errors.join('；'));
      error.statusCode = 400;
      throw error;
    }
    let job = createJob(snapshot);
    if (this.dailyStopEnabled()) job = updateJob(job.id, { cursor: { ...job.cursor, deadlineAt: new Date(deadlineFor(this.now())).toISOString() } });
    this.workflow.ensureSteps(job);
    if (snapshot.kind === 'engage') setSetting('engage_defaults', normalizeEngageSettings(input));
    else setSetting('task_defaults', { ...input, accountIds: undefined, topicIds: undefined });
    this.emitUpdate(job);
    this.run(job.id);
    return { job, created: true };
  }

  run(jobId) {
    if (this.promise) return this.runningJobId === jobId ? this.promise : this.promise.then(() => this.run(jobId));
    this.runningJobId = jobId;
    this.promise = (async () => {
      const job = getJob(jobId);
      if (this.navigation.waiting(job) && !job.stopRequested && !job.pausedByUser) { this.navigation.arm(jobId); return; }
      if (job && !job.stopRequested && !['stopped','completed'].includes(job.status) && !job.pausedByUser && !await this.network.probe(job)) { this.network.pause(jobId); return; }
      return this.loop(jobId);
    })().finally(async () => {
      try { await this.releaseEngageSession(); }
      finally {
        this.promise = null; this.runningJobId = null;
        // Pause and edit availability are derived from both the persisted job
        // and live runner state. Publish one final snapshot after the current
        // browser operation has actually released its safe point.
        const settled = getJob(jobId);
        if (settled && (this.scope === 'engage' || settled.config?.kind === 'engage')) {
          this.emitUpdate(settled);
          if (['completed', 'stopped'].includes(settled.status)) this.scheduleAutoReadbacks(jobId);
        }
      }
    });
    return this.promise;
  }

  async recover() {
    this.enforceDailyStop();
    const job = this.current();
    if (!job) return job;
    if (appConfig.topicMode === 'fixed' && validateSnapshot(job.config).length) {
      const paused = updateJob(job.id, { status: 'paused', pausedByUser: true, waitReason: validateSnapshot(job.config).join('；') });
      this.emitUpdate(paused); return paused;
    }
    if (this.navigation.waiting(job) && !job.pausedByUser) {
      if (this.workflow.enabled(job)) this.workflow.recover(job.id);
      this.navigation.arm(job.id); return getJob(job.id);
    }
    if (job.cursor.networkRecovery?.state === 'offline' && !job.pausedByUser) { this.network.arm(job.id); return job; }
    if (this.workflow.enabled(job)) {
      this.workflow.recover(job.id);
      this.workflow.restoreRejectedWorkbenchPosts(job.id);
      if (!job.pausedByUser && job.status !== 'paused' && !getJob(job.id).cursor.verificationBarrier) this.run(job.id);
      return getJob(job.id);
    }
    if (job.pausedByUser || job.status === 'paused') return job;
    const incomplete = findIncompleteAction(job.id);
    if (incomplete) {
      updateActionLog(incomplete.id, { state: 'uncertain', error: '程序中断时操作结果未知，需要人工核对' });
      if (incomplete.kind === 'checkin' && incomplete.account_id && incomplete.topic_id) {
        recordCheckin(incomplete.account_id, incomplete.topic_id, shanghaiDate(), 'uncertain');
      }
      const metrics = { ...job.metrics, uncertain: Number(job.metrics.uncertain || 0) + 1 };
      const cursor = { ...job.cursor, stepIndex: Number(job.cursor.stepIndex || 0) + 1, notice: '上次中断的操作已转为待核对，任务继续执行' };
      const resumed = updateJob(job.id, { status: 'running', waitReason: null, metrics, cursor });
      this.emitUpdate(resumed);
      this.run(job.id);
      return resumed;
    }
    this.run(job.id);
    return job;
  }

  pause(jobId) {
    const job = getJob(jobId);
    if (!job || !['running', 'waiting', 'paused'].includes(job.status)) return job;
    this.network.clear();
    this.navigation.clear(jobId);
    this.clearVerificationRecovery(jobId);
    const updated = updateJob(jobId, { status: 'paused', pausedByUser: true, waitReason: '已手动暂停' });
    this.emitUpdate(updated);
    return updated;
  }

  resume(jobId) {
    this.enforceDailyStop();
    if ((this.dailyStopEnabled() && this.dailyStopStatus().blocked) || this.isExpired(jobId)) throw new DailyStopError('任务已到每日截止时间，00:00后请新建任务');
    const job = getJob(jobId);
    if (job && appConfig.topicMode === 'fixed' && validateSnapshot(job.config).length) throw Object.assign(new Error(validateSnapshot(job.config).join('；')), { statusCode: 400 });
    if (!job || job.status !== 'paused') return job;
    if (this.workflow.enabled(job) && (job.cursor.verificationBarrier || job.cursor.manualVerification)) throw Object.assign(new Error('请在待验证账号区完成验证后点击“继续运行”'), { statusCode: 409 });
    this.clearVerificationRecovery(jobId);
    const prepared = this.prepareVerificationRetry(job);
    const updated = updateJob(jobId, { status: 'running', pausedByUser: false, stopRequested: false, waitReason: null, cursor: prepared.cursor });
    this.emitUpdate(updated);
    if (this.navigation.waiting(updated)) { this.emitUpdate(updateJob(jobId, { status: 'paused', waitReason: '微博页面暂不可用，正在自动检查恢复' })); this.navigation.arm(jobId); }
    else if (prepared.cursor.networkRecovery?.state === 'offline') this.network.pause(jobId, prepared.cursor.networkRecovery.step);
    else this.run(jobId);
    return getJob(jobId);
  }

  editableTask(jobId) {
    const job = getJob(jobId);
    if (!job) return null;
    return { jobId: job.id, version: Number(job.cursor.configVersion || 0), config: job.config, status: job.status, canEdit: job.status === 'paused' && job.pausedByUser && !this.promise && !this.workflow.busy() && !this.isExpired(jobId) };
  }

  taskEditPreview(jobId, input, version) {
    const job = getJob(jobId);
    if (!job) return null;
    this.assertEditable(job, version);
    const legacySegmentIds = (job.config.actionPlan || []).map((item, index) => item.segmentId || job.config.segmentIds?.[index] || `legacy-${index}`);
    const candidate = createSnapshot({ ...job.config, segmentIds: legacySegmentIds, ...(input || {}), materials: undefined }, listAccounts(), listTopics());
    if (job.config.kind === 'engage') { candidate.schedulerVersion = job.config.schedulerVersion; candidate.snapshotVersion = job.config.snapshotVersion; }
    const originalTypes = new Map(legacySegmentIds.map((segmentId, index) => [segmentId, job.config.actionPlan[index].type]));
    candidate.segmentIds = candidate.segmentIds.map((segmentId, index) => originalTypes.has(segmentId) && originalTypes.get(segmentId) !== candidate.actionPlan[index].type ? id('seg_') : segmentId);
    if (new Set(candidate.segmentIds).size !== candidate.segmentIds.length) throw Object.assign(new Error('操作段标识重复，请刷新后重新修改'), { statusCode: 400 });
    const currentRound = Number(job.cursor.workflowRound || 0);
    if (candidate.rounds < currentRound + 1) throw Object.assign(new Error('循环轮数不能小于已经开始的轮次'), { statusCode: 400 });
    const errors = validateSnapshot(candidate);
    if (errors.length) throw Object.assign(new Error(errors.join('；')), { statusCode: 400 });
    const existing = this.workflow.rows(job.id, currentRound);
    const active = existing.filter(row => !['done', 'review', 'cancelled'].includes(row.state)).length;
    const wanted = buildSteps(candidate).filter(step => step.round >= currentRound).length;
    return { version: Number(job.cursor.configVersion || 0), currentRound, summary: { existingRemaining: active, plannedRemaining: wanted, addedOrRetained: wanted, note: '已完成、已提交和待核对记录会保留；只撤销未提交的已移除步骤。' }, config: candidate };
  }

  applyTaskEdit(jobId, input, version, { resume = false } = {}) {
    this.enforceDailyStop();
    const job = getJob(jobId);
    if (!job) return null;
    const preview = this.taskEditPreview(jobId, input, version);
    const previous = job.config;
    this.workflow.ensureSteps(job);
    db.exec('BEGIN IMMEDIATE');
    let change, updated;
    try {
    change = this.workflow.reconcile(job, preview.config, { emit: false });
    const fresh = getJob(jobId);
    const history = [...(fresh.cursor.configurationChanges || []), { at: new Date(this.now()).toISOString(), fromVersion: Number(fresh.cursor.configVersion || 0), summary: change, previous, next: preview.config }].slice(-20);
    updated = updateJob(jobId, { config: preview.config, cursor: { ...fresh.cursor, configVersion: Number(fresh.cursor.configVersion || 0) + 1, configurationChanges: history, notice: `任务参数已修改：新增或保留 ${change.kept + change.added} 项，撤销 ${change.cancelled} 项` } });
    db.exec('COMMIT');
    } catch (error) { db.exec('ROLLBACK'); throw error; }
    if (resume) {
      updated = updateJob(jobId, { status: 'running', pausedByUser: false, stopRequested: false, waitReason: null, cursor: updated.cursor });
      if (this.navigation.waiting(updated)) { updated = updateJob(jobId, { status: 'paused', waitReason: '微博页面暂不可用，正在自动检查恢复' }); this.emitUpdate(updated); this.navigation.arm(jobId); }
      else if (updated.cursor.networkRecovery?.state === 'offline') updated = this.network.pause(jobId, updated.cursor.networkRecovery.step);
      else { this.emitUpdate(updated); this.run(jobId); }
    } else this.emitUpdate(updated);
    return { job: updated, change, version: Number(updated.cursor.configVersion || 0) };
  }

  assertEditable(job, version) {
    if ((this.dailyStopEnabled() && this.dailyStopStatus().blocked) || this.isExpired(job.id)) throw new DailyStopError('已到每日截止时间，不能修改或继续任务');
    if (job.status !== 'paused' || !job.pausedByUser) throw Object.assign(new Error('任务必须手动暂停且当前步骤结束后才能修改'), { statusCode: 409 });
    if (this.promise || this.workflow.busy() || job.cursor.manualVerification) throw Object.assign(new Error('请等待当前操作和人工验证结束后再修改'), { statusCode: 409 });
    if (version != null && Number(version) !== Number(job.cursor.configVersion || 0)) throw Object.assign(new Error('任务参数已在其他页面更新，请刷新后重新修改'), { statusCode: 409 });
  }

  clearVerificationRecovery(jobId) {
    const timer = this.verificationTimers.get(jobId);
    if (timer) clearTimeout(timer);
    this.verificationTimers.delete(jobId);
  }

  prepareVerificationRetry(job) {
    const recovery = job.cursor?.verificationRecovery;
    if (!recovery) return job;
    const stepKey = stepKeyFor(recovery.step);
    const action = getStepAction(job.id, stepKey);
    if (action && action.state !== 'succeeded') {
      updateActionLog(action.id, {
        state: 'prepared',
        error: `人工验证已完成，自动重试第 ${Number(recovery.retryCount || 0) + 1} 次`
      });
    }
    return updateJob(job.id, {
      cursor: { ...job.cursor, verificationRecovery: null, notice: '微博验证已解除，正在重试刚才的操作' }
    });
  }

  scheduleVerificationRecovery(jobId) {
    this.clearVerificationRecovery(jobId);
    const check = async () => {
      this.enforceDailyStop();
      const job = getJob(jobId);
      const recovery = job?.cursor?.verificationRecovery;
      if (!job || !recovery || job.status !== 'paused' || job.pausedByUser || job.stopRequested) return this.clearVerificationRecovery(jobId);
      const account = getAccount(recovery.step.accountId);
      let resolved = false;
      try { resolved = Boolean(account && await this.adapter.isVerificationResolved?.(account, { assertRunning: () => this.assertMaySubmit(jobId) })); } catch { resolved = false; }
      this.enforceDailyStop();
      if (getJob(jobId)?.stopRequested || getJob(jobId)?.status === 'stopped') return this.clearVerificationRecovery(jobId);
      if (!resolved) {
        const timer = setTimeout(check, 3000);
        timer.unref?.();
        this.verificationTimers.set(jobId, timer);
        return;
      }
      this.clearVerificationRecovery(jobId);
      const retried = this.prepareVerificationRetry(job);
      const updated = updateJob(jobId, { status: 'running', pausedByUser: false, waitReason: null, cursor: retried.cursor });
      this.emitUpdate(updated);
      this.run(jobId);
    };
    const timer = setTimeout(check, 3000);
    timer.unref?.();
    this.verificationTimers.set(jobId, timer);
  }

  stop(jobId) {
    const job = getJob(jobId);
    if (!job || !['running', 'waiting', 'paused'].includes(job.status)) return job;
    this.network.clear(jobId);
    this.navigation.clear(jobId);
    this.clearVerificationRecovery(jobId);
    const updated = updateJob(jobId, { stopRequested: true, pausedByUser: false, waitReason: '正在安全停止' });
    this.emitUpdate(updated);
    if (this.workflow.enabled(job) && this.workflow.session && this.currentExecution?.jobId === jobId) return updated;
    if (!this.promise) this.run(jobId);
    return updated;
  }

  async loop(jobId) {
    if (this.workflow.enabled(getJob(jobId))) return this.workflow.loop(jobId);
    while (true) {
      this.enforceDailyStop();
      let job = getJob(jobId);
      if (!job) return;
      if (job.status === 'stopped') return;
      if (job.stopRequested) {
        for (const round of runningRounds(jobId)) finishRound(jobId, round, 'stopped');
        job = updateJob(jobId, { status: 'stopped', waitReason: null });
        this.emitUpdate(job);
        return;
      }
      if (job.status === 'paused') return;
      const steps = buildSteps(job.config);
      const index = Number(job.cursor.stepIndex || 0);
      // Reconcile the small crash window between persisting a cursor and finishing a round.
      for (const round of runningRounds(jobId)) {
        if (!steps.slice(index).some(step => step.round === round)) this.completeRound(jobId, round);
      }
      job = getJob(jobId);
      if (index >= steps.length) {
        job = updateJob(jobId, { status: 'completed', waitReason: null });
        this.emitUpdate(job);
        return;
      }
      const step = steps[index];
      const notBefore = job.cursor.nextRoundNotBefore;
      if (notBefore && step.round === notBefore.round) {
        const remaining = Date.parse(notBefore.at) - Date.now();
        if (remaining > 0 && !(await this.interruptibleWait(jobId, remaining, '等待下一轮'))) return;
        const fresh = getJob(jobId);
        job = updateJob(jobId, { cursor: { ...fresh.cursor, nextRoundNotBefore: null } });
      }
      startRound(jobId, step.round);
      if (job.cursor?.skippedAccountIds?.includes(step.accountId)) {
        await this.finishStep(job, step, 'skipped', job.cursor.skipReasons?.[step.accountId] || '账号已跳过');
        continue;
      }
      const account = getAccount(step.accountId);
      const isEngage = job.config.kind === 'engage';
      const topic = isEngage ? { id: null, url: linkForStep(job, step), name: '指定微博' } : listTopics().find(item => item.id === step.topicId);
      const link = isEngage ? String(step.topicId || '') : null;
      if (!account || (!isEngage && !topic)) {
        await this.finishStep(job, step, 'failed', isEngage ? '账号或链接已不存在' : '账号或超话已不存在');
        continue;
      }
      const identity = String(account.uid || `account:${account.id}`);
      const muted = (job.cursor?.muteLimits || []).find(item => item.round === step.round && item.identity === identity);
      if (muted && ['post', 'comment', 'repost'].includes(step.kind)) {
        await this.finishStep(job, step, 'skipped', `本轮账号已禁言，跳过${kindLabel(step.kind)}；${muted.reason}`);
        continue;
      }
      const kindLimit = (job.cursor?.rateLimits || []).find(item => item.round === step.round && item.identity === identity && item.kind === step.kind);
      if (kindLimit) {
        await this.finishStep(job, step, 'skipped', `本轮${kindLabel(step.kind)}频繁，跳过此操作；${kindLimit.reason}`);
        continue;
      }
      const nextStep = steps[index + 1];
      const cursor = { ...job.cursor, current: { ...step, accountName: account.name, topicName: topic?.name || link || '' } };
      job = updateJob(jobId, { status: 'running', cursor, waitReason: null });
      this.emitUpdate(job);
      let skipped = false;
      try {
        const result = await this.withDailyDeadline(job, step, async () => {
          await this.adapter.ensureIdentity(account);
          this.assertMaySubmit(jobId);
          return this.execute(job, step, account, topic);
        });
        if (this.isExpired(jobId)) { this.enforceDailyStop(); this.finalizeDailyStop(jobId, step); return; }
        if (result?.waiting) continue;
        skipped = result?.state === 'skipped';
        job = getJob(jobId);
        if (result?.state === 'uncertain') {
          await this.advance(jobId, step, 'uncertain', `待核对，继续执行：${result.reason || '结果无法确认'}`);
        } else {
          await this.advance(jobId, step, result?.state || 'succeeded');
        }
      } catch (error) {
        if (await this.navigation.handle(error, jobId, step)) return;
        if (await this.network.handle(error, jobId, step)) return;
        if (error instanceof DailyStopError || this.isExpired(jobId)) {
          this.enforceDailyStop(); this.finalizeDailyStop(jobId, step); return;
        }
        if (error instanceof RateLimitError) {
          const reason = error.message || '微博提示操作频繁';
          const state = error.rejected ? 'skipped' : 'uncertain';
          const identity = String(account.uid || `account:${account.id}`);
          const restrictedKind = error.kind || step.kind;
          const action = getStepAction(jobId, stepKeyFor(step));
          const submitted = Boolean(action?.submitted_at) || ['submitted', 'uncertain'].includes(action?.state);
          recordAccountRestriction({ accountId: account.id, identity, type: 'frequent', kind: restrictedKind, reason, detectedAt: new Date(this.now()).toISOString(), expiresAt: new Date(this.now() + 60 * 60 * 1000).toISOString(), jobId });
          this.accountRestrictionsAt = 0;
          const current = getJob(jobId);
          const rateLimits = [...(current.cursor?.rateLimits || [])];
          if (!rateLimits.some(item => item.round === step.round && item.identity === identity && item.kind === restrictedKind)) {
            rateLimits.push({ round: step.round, identity, accountId: account.id, kind: restrictedKind, at: new Date().toISOString(), reason });
          }
          const label = kindLabel(restrictedKind);
          updateJob(jobId, { cursor: { ...current.cursor, rateLimits, notice: `本轮${label}频繁，仅跳过后续${label}：${reason}` } });
          log('warning', `本轮${label}频繁，仅跳过后续${label}：${reason}`, { accountId: account.id, topicId: topic?.id, jobId });
          if (restrictedKind !== step.kind && !submitted) {
            if (action && !['succeeded','submitted','uncertain'].includes(action.state)) updateActionLog(action.id, { state: 'prepared', error: '' });
            await this.interruptibleWait(jobId, 1000, `本轮${label}频繁，继续执行${kindLabel(step.kind)}`);
            continue;
          }
          await this.advance(jobId, step, submitted ? 'uncertain' : state, `本轮${label}频繁，跳过后续${label}`);
          continue;
        }
        if (error instanceof MutedError) {
          const reason = error.message || '微博提示账号已被禁言';
          const current = getJob(jobId);
          const muteLimits = [...(current.cursor?.muteLimits || [])];
          if (!muteLimits.some(item => item.round === step.round && item.identity === identity)) {
            muteLimits.push({ round: step.round, identity, accountId: account.id, at: new Date().toISOString(), reason });
          }
          updateJob(jobId, { cursor: { ...current.cursor, muteLimits, notice: `本轮账号禁言，后续发帖和评论已跳过：${reason}` } });
          recordAccountRestriction({ accountId: account.id, identity, type: 'mute', reason, detectedAt: new Date(this.now()).toISOString(), expiresAt: new Date(this.now() + 24 * 60 * 60 * 1000).toISOString(), jobId });
          this.accountRestrictionsAt = 0;
          log('warning', `本轮账号禁言，后续发帖和评论跳过：${reason}`, { accountId: account.id, topicId: topic?.id, jobId });
          await this.advance(jobId, step, error.rejected ? 'failed' : 'uncertain', '本轮账号禁言，后续发帖和评论已跳过');
          continue;
        }
        if (error instanceof VerificationError) {
          log('warning', error.message, { accountId: account.id, topicId: topic?.id, jobId });
          const action = getStepAction(jobId, stepKeyFor(step));
          const current = getJob(jobId);
          const verificationRecovery = {
            step,
            accountId: account.id,
            actionId: action?.id || null,
            phase: action?.state === 'submitted' || error.submittedUncertain ? 'submitted_or_unknown' : 'not_submitted',
            startedAt: current?.cursor?.verificationRecovery?.startedAt || new Date().toISOString(),
            retryCount: Number(current?.cursor?.verificationRecovery?.retryCount || 0) + 1
          };
          job = updateJob(jobId, {
            status: 'paused', pausedByUser: false,
            waitReason: '等待完成微博验证，验证通过后将自动重试当前动作',
            cursor: { ...current.cursor, verificationRecovery, notice: '请在微博窗口完成验证；通过后会自动重试当前动作' }
          });
          this.emitUpdate(job);
          this.scheduleVerificationRecovery(jobId);
          return;
        }
        if (error instanceof BrowserBusyError) {
          const reason = 'Chrome 正在用于账号登录，任务等待浏览器空闲';
          job = updateJob(jobId, { status: 'waiting', waitReason: reason });
          this.emitUpdate(job);
          if (!(await this.interruptibleWait(jobId, 1000, reason))) return;
          updateJob(jobId, { status: 'running', waitReason: null });
          continue;
        }
        if (error instanceof AuthenticationError) {
          const reason = error instanceof IdentityMismatchError ? `UID 不符，账号已跳过：${error.message}` : `登录失效，账号已跳过：${account.name}`;
          log('error', reason, { accountId: account.id, topicId: topic?.id, jobId });
          await this.skipAccount(jobId, step, reason);
          continue;
        }
        log('error', serializeError(error), { accountId: account.id, topicId: topic?.id, jobId });
        await this.finishStep(getJob(jobId), step, 'failed', serializeError(error));
      }
      job = getJob(jobId);
      if (job?.status === 'running') {
        const isRoundBoundary = nextStep && nextStep.round !== step.round;
        const seconds = !nextStep || isRoundBoundary ? 0 : skipped ? 0 : this.intervalFor(job.config, step);
        const submitted = this.lastSubmitted;
        const elapsed = step.kind === 'post' && submitted?.jobId === jobId && submitted.stepKey === stepKeyFor(step) ? Math.max(0, this.now() - submitted.at) : 0;
        if (seconds * 1000 > elapsed && !(await this.interruptibleWait(jobId, seconds * 1000 - elapsed, isRoundBoundary ? '等待下一轮' : '等待下一项操作'))) return;
      }
    }
  }

  async execute(job, step, account, topic, { reuseVisiblePage = false } = {}) {
    if (job.config.kind === 'engage') return this.executeEngage(job, step, account, topic, { reuseVisiblePage });
    if (step.kind === 'checkin') {
      const localDate = shanghaiDate();
      const previous = getCheckin(account.id, topic.id, localDate);
      if (previous?.status === 'succeeded') {
        log('info', '今天已经签到，跳过', { accountId: account.id, topicId: topic?.id });
        return { state: 'skipped' };
      }
      return this.loggedAction(job, step, account, topic, null, null, async actionId => {
        const result = await this.adapter.checkin(account, topic, { verifyOnly: previous?.status === 'uncertain' && !reuseVisiblePage, reusePage: reuseVisiblePage, deadlineAt: this.taskDeadline(getJob(job.id)), onSubmit: () => this.markSubmitted(job.id, step, actionId) });
        this.assertExecutionAlive();
        if (result.state === 'uncertain' && !await this.network.probe(getJob(job.id))) throw new NetworkOfflineError('签到提交后网络不可用，等待只读核验');
        updateActionLog(actionId, { state: result.state, url: result.url, error: result.reason });
        if (result.state === 'succeeded') recordCheckin(account.id, topic.id, localDate);
        if (result.state === 'uncertain') recordCheckin(account.id, topic.id, localDate, 'uncertain');
        return result;
      });
    }
    const manual = this.workbenchVerification(job) && this.workflow.session?.jobId === job.id
      && this.workflow.session.stepKey === stepKeyFor(step);
    if (step.kind === 'post') {
      const existing = getStepAction(job.id, stepKeyFor(step));
      if (existing?.sequence_number != null) this.restoreSequence(job.id, step, 'post', existing.sequence_number, Boolean(existing.sequence_confirmed));
      const materials = Array.isArray(job.config.materials.posts) ? job.config.materials.posts : (job.config.materials.posts[account.id] || []);
      const material = pickRandom(materials);
      if (!material) throw new UnsupportedPageError(`账号“${account.name}”没有可用发帖文案`);
      const content = (manual && existing?.submitted_at && existing.content) || this.actionContent(job, step, 'post', job.config.postDecoration, () => material.text);
      return this.loggedAction(job, step, account, topic, null, content, async actionId => {
        const attemptId = getActionLog(actionId).attempt_id;
        let result = await this.adapter.post(account, topic, content, { attemptId, actionId, workbenchVerification: this.workbenchVerification(job), syncToHome: job.config.syncToHome === true, deadlineAt: this.taskDeadline(getJob(job.id)), onReceipt: receipt => {
          // Saving evidence is allowed after Stop; scheduling more work is not.
          this.settlePostAction(actionId, { ...receipt, state: 'succeeded', attemptId });
        }, onSubmit: () => this.markSubmitted(job.id, step, actionId, attemptId) });
        const accepted = this.acceptedPost(actionId);
        if (accepted) return accepted;
        this.assertExecutionAlive();
        if (result.state === 'uncertain' && !await this.network.probe(getJob(job.id))) throw new NetworkOfflineError('发帖提交后网络不可用，等待只读核验');
        this.settlePostAction(actionId, { state: result.state, url: result.url, receiptId: result.receiptId, receiptUrl: result.receiptUrl,
          successSource: result.successSource, error: result.reason, attemptId });
        return this.acceptedPost(actionId) || result;
      });
    }
    if (manual) {
      const original = getStepAction(job.id, stepKeyFor(step));
      if (original?.target_id && original.url && original.content) {
        const candidate = { id: original.target_id, url: original.url.split('?')[0] };
        if (original.sequence_number != null) this.restoreSequence(job.id, step, 'comment', original.sequence_number, Boolean(original.sequence_confirmed));
        const content = original.submitted_at ? original.content : this.actionContent(job, step, 'comment',
          job.config.commentDecoration || job.config.decoration, () => original.content);
        return this.loggedAction(job, step, account, topic, candidate.id, content, async actionId => {
          const options = this.commentSubmitOptions(job, step, actionId);
          const result = await this.adapter.comment(account, candidate, content, options);
          this.assertExecutionAlive();
          const state = result.retryElsewhere ? 'failed' : result.state;
          this.settlePostAction(actionId, { state, url: result.url, error: result.reason, attemptId: options.attemptId });
          return { ...result, state, retryElsewhere: false };
        });
      }
      if (original?.submitted_at) return { state: 'uncertain', reason: '原评论缺少目标或文案，不能在验证窗口更换目标' };
    }
    return this.executeComment(job, step, account, topic);
  }

  async assertEngageConnectivity(job, step, { forceNetwork = false } = {}) {
    if (!await this.network.probe(getJob(job.id), { force: forceNetwork })) {
      this.network.pause(job.id, step);
      throw new NetworkOfflineError('提交前检测到网络断开');
    }
    const current=getJob(job.id);
    const manual = this.groupedEngage(job) && this.activeManualStep(job.id, step);
    // Grouped engage intentionally pauses the mainline while a verification
    // window is active.  The selected manual step is the only operation that
    // may continue through that pause.
    if(this.groupedEngage(job) && !manual && (current.pausedByUser || current.stopRequested || current.status==='paused')) {
      throw Object.assign(new Error('转赞评已暂停或停止，未提交新操作'),{code:'engage_interrupted',unsubmitted:true});
    }
    if (this.groupedEngage(job) && current.cursor.manualVerification && !manual)
      throw Object.assign(new Error('当前步骤不属于已打开的人工验证会话'),{code:'engage_interrupted',unsubmitted:true});
    this.assertMaySubmit(job.id);
  }

  engageSubmitOptions(job, step, actionId) {
    const attemptId = getActionLog(actionId)?.attempt_id;
    return { attemptId, actionId, beforeSubmit: () => this.assertEngageConnectivity(job, step, { forceNetwork: true }), deadlineAt: this.taskDeadline(getJob(job.id)), onSubmit: () => this.markSubmitted(job.id, step, actionId, attemptId) };
  }

  engageCouplingFor(job, step) {
    const coupling = engageStepCoupling(job.config, step);
    if (!coupling?.isPrimary) return { coupling: null, enabled: false, companionKind: '' };
    const disabled = job.cursor?.disabledCouplings?.[stepKeyFor(step)] === coupling.companionKind;
    return { coupling, enabled: !disabled, companionKind: coupling.companionKind };
  }

  pickSnapshotRepost(job) {
    const materials = job.config.materials.reposts || [];
    const lastText = getSetting('last_repost_text', '') || materials.find(item => item.id === getSetting('last_repost_material_id', ''))?.text?.trim();
    const choices = materials.filter(item => item.text.trim() !== lastText);
    if (!choices.length) throw new UnsupportedPageError('没有与上次不同的转发原文，请补充文案');
    const selected = pickRandom(choices);
    setSetting('last_repost_material_id', selected.id);
    setSetting('last_repost_text', selected.text.trim());
    return selected;
  }

  async executeEngage(job, step, account, topic, { reuseVisiblePage = false } = {}) {
    const link = String(step.topicId || step.link || '');
    if (step.kind === 'repost') return this.executeRepost(job, step, account, link);
    if (step.kind === 'comment') return this.executeEngageComment(job, step, account, link);
    if (step.kind === 'like') return this.executeLikePost(job, step, account, link);
    if (step.kind === 'comment_like') return this.executeInnerLike(job, step, account, link);
    return { state: 'failed', reason: '未知的转赞评操作' };
  }

  async executeRepost(job, step, account, link) {
    const existing = getStepAction(job.id, stepKeyFor(step));
    if (existing?.sequence_number != null) this.restoreSequence(job.id, step, 'repost', existing.sequence_number, Boolean(existing.sequence_confirmed));
    const withText = (job.config.actionPlan[step.actionIndex]?.repostForm || job.config.repostForm) !== 'plain';
    const content = withText ? this.actionContent(job, step, 'repost', job.config.repostDecoration, () => this.pickSnapshotRepost(job).text) : '';
    const coupling = this.engageCouplingFor(job, step);
    return this.loggedAction(job, step, account, { id: null, url: link }, null, content || null, async actionId => {
      const attemptId = getActionLog(actionId).attempt_id;
      const result = await this.adapter.repostWeibo(account, link, content, { attemptId, actionId, beforeSubmit: () => this.assertEngageConnectivity(job, step, { forceNetwork: true }), onSubmit: () => this.markSubmitted(job.id, step, actionId, attemptId), deadlineAt: this.taskDeadline(getJob(job.id)), onReceipt: receipt => this.settlePostAction(actionId, { ...receipt, state: 'succeeded', attemptId }), alsoComment: coupling.enabled });
      this.assertExecutionAlive();
      if (result.state === 'uncertain' && !await this.network.probe(getJob(job.id))) throw new NetworkOfflineError('转发提交后网络不可用，等待只读核验');
      updateActionLog(actionId, { state: result.state, url: result.url || link, error: result.reason, successSource:result.successSource });
      return result;
    });
  }

  async executeEngageComment(job, step, account, link) {
    const existing = getStepAction(job.id, stepKeyFor(step));
    if (existing?.sequence_number != null) this.restoreSequence(job.id, step, 'comment', existing.sequence_number, Boolean(existing.sequence_confirmed));
    const parsed = parseWeiboLink(link);
    const candidate = { id: parsed.id, url: parsed.authorUid ? link : 'https://weibo.com/detail/' + parsed.id, authorUid: parsed.authorUid };
    const decoration = job.config.commentDecoration || job.config.decoration;
    const content = this.actionContent(job, step, 'comment', decoration, () => this.pickSnapshotComment(job).text);
    return this.loggedAction(job, step, account, { id: null, url: link }, candidate.id, content, async actionId => {
      updateActionLog(actionId, { url: link, targetId: candidate.id });
      const result = await this.adapter.comment(account, candidate, content, { ...this.commentSubmitOptions(job, step, actionId), engage:true, beforeSubmit: () => this.assertEngageConnectivity(job, step, { forceNetwork: true }) });
      if (result.state === 'uncertain' && !await this.network.probe(getJob(job.id))) throw new NetworkOfflineError('评论提交后网络不可用，等待只读核验');
      this.assertExecutionAlive();
      updateActionLog(actionId, { state: result.state, url: result.url || link, error: result.reason, targetId: candidate.id });
      if (result.state === 'succeeded') recordComment(account.id, candidate.id, result.url || link);
      return result;
    });
  }

  async executeLikePost(job, step, account, link) {
    return this.loggedAction(job, step, account, { id: null, url: link }, null, null, async actionId => {
      const result = await this.adapter.likeWeibo(account, link, { ...this.engageSubmitOptions(job, step, actionId), blacklistUids: job.config.likeBlacklistUids, blacklistKeywords: job.config.likeBlacklistKeywords });
      this.assertExecutionAlive();
      if (result.state === 'uncertain' && !await this.network.probe(getJob(job.id))) throw new NetworkOfflineError('点赞提交后网络不可用，等待只读核验');
      updateActionLog(actionId, { state: result.state, url: result.url || link, error: result.reason, successSource:result.successSource });
      return result;
    });
  }

  async executeInnerLike(job, step, account, link) {
    if (this.groupedEngage(job) && this.adapter.likeNextComment) return this.executeStreamingInnerLike(job, step, account, link);
    return this.loggedAction(job, step, account, { id: null, url: link }, null, null, async actionId => {
      const existing = getActionLog(actionId);
      let commentId = existing?.target_id, result;
      // Already-liked targets never consume a requested new like. Only replace
      // a target when the adapter explicitly confirms no click was submitted.
      for(let skipped=0;skipped<500;skipped++) {
        this.assertMaySubmit(job.id);
        if(!commentId) commentId=await this.innerLikeTarget(getJob(job.id),step,account,link);
        if(!commentId) return {state:'skipped',reason:'没有更多符合条件的未赞评论'};
        updateActionLog(actionId,{targetId:commentId,url:link});
        result=await this.adapter.likeComment(account,link,commentId,this.engageSubmitOptions(job,step,actionId));
        if(result.alreadyDone === true && !getActionLog(actionId)?.submitted_at) {commentId=null;continue;}
        break;
      }
      if(!result || result.alreadyDone) return {state:'skipped',reason:'没有更多未赞评论'};
      this.assertExecutionAlive();
      if (result.state === 'uncertain' && !await this.network.probe(getJob(job.id))) throw new NetworkOfflineError('点赞提交后网络不可用，等待只读核验');
      updateActionLog(actionId, { state: result.state, url: result.url || link, error: result.reason, successSource:result.successSource });
      return result;
    });
  }

  async executeStreamingInnerLike(job, step, account, link) {
    return this.loggedAction(job, step, account, {id:null,url:link}, null, null, async actionId => {
      const fresh = getJob(job.id);
      const usedKey = JSON.stringify([step.round,link,account.id]);
      const used = fresh.cursor.engageInnerSeen?.[usedKey] || [];
      const action = getActionLog(actionId);
      const assertRunning = () => {
        this.assertMaySubmit(job.id);
        const current = getJob(job.id);
        const manual = this.activeManualStep(job.id, step);
        if (!manual && (current.pausedByUser || current.status === 'paused' || current.stopRequested)) {
          throw Object.assign(new Error('任务已暂停或停止，内赞扫描已中断'), {code:'engage_interrupted',unsubmitted:true});
        }
        if (current.cursor.manualVerification && !manual)
          throw Object.assign(new Error('当前内赞不属于已打开的人工验证会话'),{code:'engage_interrupted',unsubmitted:true});
      };
      const result = await this.adapter.likeNextComment(account, link, {
        ...this.engageSubmitOptions(job,step,actionId), assertRunning, excludedKeys:used,
        includeVisibleReplies: job.config.actionPlan?.[step.actionIndex]?.includeVisibleReplies === true,
        keyword:job.config.innerLikeKeyword, keywords:job.config.innerLikeKeywords,
        blacklistKeywords:job.config.likeBlacklistKeywords, blacklistUids:job.config.likeBlacklistUids,
        target:action.target_id ? {id:action.target_id,key:action.target_id} : null,
        onTarget:target => {
          assertRunning();
          updateActionLog(actionId,{targetId:target.key || target.id,url:link});
          const current = getJob(job.id), seen = current.cursor.engageInnerSeen || {};
          updateJob(job.id,{cursor:{...current.cursor,engageInnerSeen:{...seen,[usedKey]:[...new Set([...(seen[usedKey] || []),target.key || target.id])]}}});
        }
      });
      if (result.state === 'uncertain' && !await this.network.probe(getJob(job.id))) throw new NetworkOfflineError('点赞提交后网络不可用，等待只读核验');
      this.assertExecutionAlive();
      updateActionLog(actionId,{state:result.state,url:result.url || link,error:result.reason,successSource:result.successSource});
      return result;
    });
  }

  async innerLikeTarget(job, step, account, link) {
    const poolKey = 'innerLike:' + step.round + ':' + link + ':' + account.id;
    const fresh = getJob(job.id);
    const pools = { ...(fresh.cursor?.engageInnerPools || {}) };
    let pool = pools[poolKey];
    if (!Array.isArray(pool) || !pool.some(idValue => !((fresh.cursor?.engageInnerUsed || {})['innerLikeUsed:' + step.round + ':' + link + ':' + account.id] || []).includes(idValue))) {
      const matched = await this.adapter.scanComments(account, link, {
        keyword: job.config.innerLikeKeyword, keywords: job.config.innerLikeKeywords,
        blacklistKeywords: job.config.likeBlacklistKeywords,
        blacklistUids: job.config.likeBlacklistUids,
        limit: Math.min(500, Math.max(20, Number(job.config.actionPlan[step.actionIndex]?.count || 1) + ((fresh.cursor?.engageInnerUsed || {})['innerLikeUsed:' + step.round + ':' + link + ':' + account.id] || []).length + 10)), assertRunning:()=>this.assertMaySubmit(job.id)
      });
      pool = (matched || []).map(item => String(item.id));
      pools[poolKey] = pool;
      updateJob(job.id, { cursor: { ...getJob(job.id).cursor, engageInnerPools: pools } });
    }
    const usedKey = 'innerLikeUsed:' + step.round + ':' + link + ':' + account.id;
    const used = new Set((fresh.cursor?.engageInnerUsed || {})[usedKey] || []);
    const target = pool.find(idValue => !used.has(idValue));
    if (!target) return null;
    used.add(target);
    updateJob(job.id, { cursor: { ...getJob(job.id).cursor, engageInnerUsed: { ...(getJob(job.id).cursor?.engageInnerUsed || {}), [usedKey]: [...used] } } });
    return target;
  }

  commentSubmitOptions(job, step, actionId) {
    const attemptId = getActionLog(actionId)?.attempt_id;
    return { attemptId, actionId, workbenchVerification: this.workbenchVerification(job), deadlineAt: this.taskDeadline(getJob(job.id)),
      onSubmit: () => this.markSubmitted(job.id, step, actionId, attemptId),
      onReceipt: receipt => this.settlePostAction(actionId, { ...receipt, state: 'succeeded', attemptId }) };
  }

  async executeComment(job, step, account, topic) {
    if (String(job.config.commentSection || '').trim().toLowerCase() === '超like') return this.executeSuperlikeComment(job, step, account, topic);
    const existing = getStepAction(job.id, stepKeyFor(step));
    if (job.config.commentStrategy === 'random' && !(existing?.state === 'prepared' && existing.target_id && existing.url)) {
      return this.executeRandomCommentFirst(job, step, account, topic);
    }
    if (existing?.sequence_number != null) this.restoreSequence(job.id, step, 'comment', existing.sequence_number, Boolean(existing.sequence_confirmed));
    const zeroRefreshes = Number(job.cursor?.zeroOnlyRefreshes?.[stepKeyFor(step)] || 0);
    const zeroFallback = job.config.commentStrategy === 'zero-only' && zeroRefreshes >= 3;
    const options = { section: job.config.commentSection || '最新', limit: job.config.scanLimit, assertRunning: () => this.assertMaySubmit(job.id) };
    let candidates;
    try {
      candidates = await this.readWithRetry(() => this.adapter.collectCandidates(account, topic, options), job.config.readRetryCount);
    } catch (error) { throw error; }
    // Persisted ids can be either mblogids or numeric mids. Compare their
    // canonical numeric form and include prior incarnations of this Weibo UID.
    const canonicalTargetId = value => {
      const raw = String(value || '').trim();
      if (!raw) return '';
      if (/^\d+$/.test(raw)) return raw;
      try { return weiboShortIdToNumeric(raw); } catch { return raw; }
    };
    const commentedTargets = new Set(listCommentedTargetIdsForIdentity(account).map(canonicalTargetId));
    const rejectedAuthors = this.rejectedCommentAuthors(job, step);
    const stats = commentScanStats();
    stats.scanned = candidates.length;
    candidates = candidates.filter(item => {
      if (rejectedAuthors.has(String(item.authorUid || ''))) { stats.rejectedAuthor++; return false; }
      if (commentedTargets.has(canonicalTargetId(item.id)) || hasCommented(account.id, item.id)) { stats.duplicate++; return false; }
      return true;
    });
    if (job.config.commentMaxCountEnabled) {
      candidates = candidates.filter(item => {
        if (item.commentCount != null && item.commentCount !== '' && Number.isFinite(Number(item.commentCount)) && Number(item.commentCount) >= 20) { stats.countLimit++; return false; }
        return true; // Unknown list counters must reach the authoritative API read.
      });
    }
    const zero = candidates.filter(item => item.commentCount === 0);
    let pool = candidates;
    if (job.config.commentStrategy === 'zero-only' && !zeroFallback) pool = candidates.filter(item => {
      const unknown = item.commentCount == null || item.commentCount === '' || !Number.isFinite(Number(item.commentCount));
      if (!unknown && Number(item.commentCount) !== 0) { stats.zero++; return false; }
      return true;
    });
    if (job.config.commentStrategy === 'zero-first') pool = zero.length ? zero : candidates;
    // Verification recovery must retry the same target even when it has moved
    // below the newly scanned page. The submission-time inspection below still
    // enforces the current zero/threshold rules before sending again.
    if (existing?.state === 'prepared' && existing?.target_id && existing.url && !pool.some(item => canonicalTargetId(item.id) === canonicalTargetId(existing.target_id))) {
      const retryUrl = existing.url.split('?')[0];
      const authorUid = new URL(retryUrl).pathname.match(/^\/(\d+)\//)?.[1] || '';
      if (!rejectedAuthors.has(String(authorUid))) pool = [{ id: existing.target_id, url: retryUrl, authorUid, commentCount: null }, ...pool];
    }
    if (!pool.length) {
      const reason = `${job.config.commentStrategy === 'zero-only' && !zeroFallback ? '等待出现零评论帖子' : '等待刷新可评论帖子'}（${commentScanSummary(stats)}）`;
      this.recordCommentScan(job.id, step, stats);
      this.noteZeroOnlyRefresh(job.id, step, zeroFallback);
      updateJob(job.id, { status: 'waiting', waitReason: reason });
      this.emitUpdate(getJob(job.id));
      const continued = await this.interruptibleWait(job.id, job.config.candidateRefreshSeconds * 1000, reason);
      if (continued) updateJob(job.id, { status: 'running', waitReason: null });
      return { waiting: true };
    }
    // collectCandidates preserves the page order. Zero-only must therefore take
    // the first verified zero-comment post instead of adding randomness.
    const orderedPool = existing?.state === 'prepared' && existing?.target_id
      ? pool.filter(item => canonicalTargetId(item.id) === canonicalTargetId(existing.target_id))
      : (job.config.commentStrategy === 'zero-only' && !zeroFallback ? pool : [...pool].sort(() => Math.random() - 0.5));
    let candidate = null;
    for (const item of orderedPool) {
      if (commentedTargets.has(canonicalTargetId(item.id))) continue;
      const inspected = this.adapter.inspectCandidate
        ? await this.readWithRetry(() => this.adapter.inspectCandidate(account, item), job.config.readRetryCount)
        : item;
      if (!inspected || canonicalTargetId(inspected.id || item.id) !== canonicalTargetId(item.id)) { stats.unavailable++; continue; }
      const currentCount = inspected.commentCount;
      if (currentCount == null || currentCount === '' || !Number.isFinite(Number(currentCount))) { stats.unavailable++; continue; }
      if (job.config.commentStrategy === 'zero-only' && !zeroFallback && Number(currentCount) !== 0) { stats.zero++; continue; }
      if (job.config.commentMaxCountEnabled && Number(currentCount) >= 20) { stats.countLimit++; continue; }
      candidate = { ...item, ...inspected, id: item.id, url: item.url };
      break;
    }
    if (!candidate) {
      const reason = `发送前复核后等待刷新（${commentScanSummary(stats)}）`;
      this.recordCommentScan(job.id, step, stats);
      this.noteZeroOnlyRefresh(job.id, step, zeroFallback);
      updateJob(job.id, { status: 'waiting', waitReason: reason });
      this.emitUpdate(getJob(job.id));
      const continued = await this.interruptibleWait(job.id, job.config.candidateRefreshSeconds * 1000, reason);
      if (continued) updateJob(job.id, { status: 'running', waitReason: null });
      return { waiting: true };
    }
    const decoration = job.config.commentDecoration || job.config.decoration;
    const content = this.actionContent(job, step, 'comment', decoration, () => this.pickSnapshotComment(job).text);
    const result = await this.loggedAction(job, step, account, topic, candidate.id, content, async actionId => {
      updateActionLog(actionId, { url: candidate.url, targetId: candidate.id });
      let result = await this.adapter.comment(account, candidate, content, this.commentSubmitOptions(job, step, actionId));
      if (result.state === 'uncertain' && typeof this.adapter.verifyComment === 'function') {
        try {
          const reread = await this.adapter.verifyComment(account, candidate, content, { delays: [0] });
          if (reread.state === 'succeeded') result = { ...result, state: 'succeeded', url: reread.url || candidate.url, reason: '' };
        } catch {}
      }
      if (result.state === 'uncertain' && !await this.network.probe(getJob(job.id))) throw new NetworkOfflineError('评论提交后网络不可用，等待只读核验');
      this.assertExecutionAlive();
      updateActionLog(actionId, { state: result.state, url: result.url, error: result.reason, targetId: candidate.id });
      if (result.state === 'succeeded') recordComment(account.id, candidate.id, result.url);
      return result;
    });
    if (result?.retryElsewhere) {
      this.avoidRejectedCommentAuthor(job.id, step, candidate, result.reason);
      if (this.workflow.session?.jobId === job.id && this.workflow.session.submitted) return { ...result, state: 'failed', retryElsewhere: false };
      // The receipt explicitly rejected this comment, so it must not consume
      // either a task step or a visible number. Re-enter selection with the
      // author filter now persisted for every account in this round.
      return this.executeComment(getJob(job.id), step, account, topic);
    }
    return result;
  }

  async executeRandomCommentFirst(job, step, account, topic) {
    const stats = commentScanStats();
    const canonical = value => {
      const raw = String(value || '').trim();
      if (!raw) return '';
      if (/^\d+$/.test(raw)) return raw;
      try { return weiboShortIdToNumeric(raw); } catch { return raw; }
    };
    const commented = new Set(listCommentedTargetIdsForIdentity(account).map(canonical));
    const rejectedAuthors = this.rejectedCommentAuthors(job, step);
    const inspect = async (item, inFeed) => {
      stats.scanned += 1;
      if (rejectedAuthors.has(String(item.authorUid || ''))) { stats.rejectedAuthor++; return null; }
      if (commented.has(canonical(item.id)) || hasCommented(account.id, item.id)) { stats.duplicate++; return null; }
      if (job.config.commentMaxCountEnabled && item.commentCount != null && item.commentCount !== '' && Number.isFinite(Number(item.commentCount)) && Number(item.commentCount) >= 20) {
        stats.countLimit++; return null;
      }
      const checked = this.adapter.inspectCandidate
        ? await this.readWithRetry(() => this.adapter.inspectCandidate(account, item, { inFeed }), job.config.readRetryCount)
        : item;
      if (!checked || canonical(checked.id || item.id) !== canonical(item.id)) { stats.unavailable++; return null; }
      const count = checked.commentCount;
      if (count == null || count === '' || !Number.isFinite(Number(count))) { stats.unavailable++; return null; }
      if (job.config.commentMaxCountEnabled && Number(count) >= 20) { stats.countLimit++; return null; }
      return { ...item, ...checked, id: item.id, url: item.url, commentCount: Number(count) };
    };
    let selected = null, streamed = false;
    const rows = await this.readWithRetry(() => this.adapter.collectCandidates(account, topic, {
      section: job.config.commentSection || '最新', limit: job.config.scanLimit,
      assertRunning: () => this.assertMaySubmit(job.id),
      onBatch: async batch => {
        streamed = true;
        for (const item of batch) {
          selected = await inspect(item, true);
          if (selected) return true;
        }
        return false;
      }
    }), job.config.readRetryCount);
    if (!streamed) for (const item of rows) {
      selected = await inspect(item, true);
      if (selected) break;
    }
    if (!selected) {
      const reason = `发送前复核后等待刷新（${commentScanSummary(stats)}）`;
      this.recordCommentScan(job.id, step, stats);
      updateJob(job.id, { status: 'waiting', waitReason: reason });
      this.emitUpdate(getJob(job.id));
      const continued = await this.interruptibleWait(job.id, job.config.candidateRefreshSeconds * 1000, reason);
      if (continued) updateJob(job.id, { status: 'running', waitReason: null });
      return { waiting: true };
    }
    this.recordCommentScan(job.id, step, stats);
    const decoration = job.config.commentDecoration || job.config.decoration;
    const content = this.actionContent(job, step, 'comment', decoration, () => this.pickSnapshotComment(job).text);
    const result = await this.loggedAction(job, step, account, topic, selected.id, content, async actionId => {
      updateActionLog(actionId, { url: selected.url, targetId: selected.id });
      const outcome = await this.adapter.comment(account, selected, content, this.commentSubmitOptions(job, step, actionId));
      if (outcome.state === 'uncertain' && !await this.network.probe(getJob(job.id))) throw new NetworkOfflineError('评论提交后网络不可用，等待只读核验');
      this.assertExecutionAlive();
      updateActionLog(actionId, { state: outcome.state, url: outcome.url, error: outcome.reason, targetId: selected.id });
      if (outcome.state === 'succeeded') recordComment(account.id, selected.id, outcome.url);
      return outcome;
    });
    if (result?.retryElsewhere) {
      this.avoidRejectedCommentAuthor(job.id, step, selected, result.reason);
      if (this.workflow.session?.jobId === job.id && this.workflow.session.submitted) return { ...result, state: 'failed', retryElsewhere: false };
      return this.executeRandomCommentFirst(getJob(job.id), step, account, topic);
    }
    return result;
  }

  noteZeroOnlyRefresh(jobId, step, alreadyFallback) {
    const job = getJob(jobId);
    if (!job || job.config.commentStrategy !== 'zero-only' || alreadyFallback) return;
    const key = stepKeyFor(step);
    const zeroOnlyRefreshes = { ...(job.cursor?.zeroOnlyRefreshes || {}), [key]: Number(job.cursor?.zeroOnlyRefreshes?.[key] || 0) + 1 };
    updateJob(jobId, { cursor: { ...job.cursor, zeroOnlyRefreshes } });
  }

  recordCommentScan(jobId, step, stats) {
    const current = getJob(jobId);
    updateJob(jobId, { cursor: { ...current.cursor, commentScan: { ...stats, stepKey: stepKeyFor(step), at: new Date(this.now()).toISOString() } } });
  }

  async executeSuperlikeComment(job, step, account, topic) {
    const key = stepKeyFor(step);
    const progress = job.cursor.superlikeSteps?.[key] || { refreshes: 0 };
    const fallback = Number(progress.refreshes) >= 2;
    const existing = getStepAction(job.id, key);
    const canonical = value => {
      const raw = String(value || '');
      if (/^\d+$/.test(raw)) return raw;
      try { return weiboShortIdToNumeric(raw); } catch { return raw; }
    };
    const commented = new Set(listCommentedTargetIdsForIdentity(account).map(canonical));
    const rejectedAuthors = this.rejectedCommentAuthors(job, step);
    const stats = commentScanStats();
    let selected = null;
    const eligible = async (rows, retry = false) => {
      stats.scanned += rows.length;
      let pool = rows.filter(item => {
        if (item.authorUid === String(account.uid || '')) { stats.self++; return false; }
        if (rejectedAuthors.has(String(item.authorUid || ''))) { stats.rejectedAuthor++; return false; }
        if (!retry && (commented.has(canonical(item.id)) || hasCommented(account.id, item.id))) { stats.duplicate++; return false; }
        return true;
      });
      const match = item => /[差捞稳]/.test(item.text || '');
      if (!fallback && !retry) pool = pool.filter(item => { if (match(item)) return true; stats.keyword++; return false; });
      if (fallback && !retry) pool = [...pool.filter(match), ...pool.filter(item => !match(item))];
      if (!fallback && job.config.commentStrategy === 'zero-first') pool = [...pool.filter(item => Number(item.commentCount) === 0), ...pool.filter(item => Number(item.commentCount) !== 0)];
      for (const item of pool) {
        const inspected = this.adapter.inspectCandidate
          ? await this.readWithRetry(() => this.adapter.inspectCandidate(account, item, { inFeed: !retry }), job.config.readRetryCount)
          : item;
        if (!inspected || canonical(inspected.id || item.id) !== canonical(item.id)) { stats.unavailable++; continue; }
        const count = inspected.commentCount;
        if (count == null || count === '' || !Number.isFinite(Number(count))) { stats.unavailable++; continue; }
        if ((fallback || job.config.commentMaxCountEnabled) && Number(count) >= 20) { stats.countLimit++; continue; }
        if (!fallback && job.config.commentStrategy === 'zero-only' && Number(count) !== 0) { stats.zero++; continue; }
        selected = { ...item, ...inspected, id: item.id, url: item.url };
        return true;
      }
      return false;
    };
    if (existing?.target_id && existing.url && existing.state === 'prepared') {
      await eligible([{ id: existing.target_id, url: existing.url.split('?')[0] }], true);
    } else {
      let streamed = false;
      const rows = await this.readWithRetry(() => this.adapter.collectCandidates(account, topic, {
        section: job.config.commentSection, limit: job.config.scanLimit,
        assertRunning: () => this.assertMaySubmit(job.id),
        onBatch: async batch => { this.assertMaySubmit(job.id); streamed = true; return eligible(batch); }
      }), job.config.readRetryCount);
      if (!streamed) await eligible(rows);
    }
    if (!selected) {
      const current = getJob(job.id);
      const refreshes = Math.min(2, Number(progress.refreshes) + 1);
      const reason = `${fallback ? '超like等待刷新可评论帖子' : `超like等待第 ${refreshes} 次刷新关键词帖子`}（${commentScanSummary(stats)}）`;
      updateJob(job.id, { status: 'waiting', waitReason: reason, cursor: { ...current.cursor, commentScan: { ...stats, stepKey: key, at: new Date(this.now()).toISOString() }, superlikeSteps: { ...(current.cursor.superlikeSteps || {}), [key]: { refreshes } } } });
      this.emitUpdate(getJob(job.id));
      if (await this.interruptibleWait(job.id, job.config.candidateRefreshSeconds * 1000, reason)) updateJob(job.id, { status: 'running', waitReason: null });
      return { waiting: true };
    }
    if (existing?.sequence_number != null) this.restoreSequence(job.id, step, 'comment', existing.sequence_number, Boolean(existing.sequence_confirmed));
    const decoration = job.config.commentDecoration || job.config.decoration;
    const content = this.actionContent(job, step, 'comment', decoration, () => this.pickSnapshotComment(job).text);
    const result = await this.loggedAction(job, step, account, topic, selected.id, content, async actionId => {
      // Preserve the exact target for verification recovery before the click.
      updateActionLog(actionId, { url: selected.url, targetId: selected.id });
      const result = await this.adapter.comment(account, selected, content, this.commentSubmitOptions(job, step, actionId));
      if (result.state === 'uncertain' && !await this.network.probe(getJob(job.id))) throw new NetworkOfflineError('评论提交后网络不可用，等待只读核验');
      this.assertExecutionAlive();
      updateActionLog(actionId, { state: result.state, url: result.url, error: result.reason });
      if (result.state === 'succeeded') recordComment(account.id, selected.id, result.url);
      return result;
    });
    if (result?.retryElsewhere) {
      this.avoidRejectedCommentAuthor(job.id, step, selected, result.reason);
      if (this.workflow.session?.jobId === job.id && this.workflow.session.submitted) return { ...result, state: 'failed', retryElsewhere: false };
      return this.executeSuperlikeComment(getJob(job.id), step, account, topic);
    }
    return result;
  }

  rejectedCommentAuthors(job, step) {
    return new Set((job.cursor?.commentRejectedAuthors || [])
      .filter(item => Number(item.round) === Number(step.round))
      .map(item => String(item.authorUid || ''))
      .filter(Boolean));
  }

  avoidRejectedCommentAuthor(jobId, step, candidate, reason) {
    const authorUid = String(candidate.authorUid || new URL(candidate.url).pathname.match(/^\/(\d+)\//)?.[1] || '');
    if (!authorUid) return;
    const job = getJob(jobId);
    const entries = [...(job.cursor?.commentRejectedAuthors || [])];
    if (!entries.some(item => Number(item.round) === Number(step.round) && String(item.authorUid) === authorUid)) {
      entries.push({ round: step.round, authorUid, topicId: step.topicId, at: new Date(this.now()).toISOString(), reason: reason || '微博回执明确表示评论未被接受' });
    }
    updateJob(jobId, { cursor: { ...job.cursor, commentRejectedAuthors: entries, notice: `本轮已避开评论回执拒绝的发帖人 ${authorUid}，正在改选其他帖子` } });
    log('warning', `评论回执拒绝，已避开本轮该发帖人的全部帖子并重新选择：${reason || ''}`, { topicId: step.topicId, url: candidate.url });
  }

  pickSnapshotComment(job) {
    const materials = job.config.materials.comments;
    const lastText = getSetting('last_comment_text', '') || materials.find(item => item.id === getSetting('last_comment_material_id', ''))?.text?.trim();
    const choices = materials.filter(item => item.text.trim() !== lastText);
    if (!choices.length) throw new UnsupportedPageError('没有与上次不同的评论原文，请补充文案');
    const selected = pickRandom(choices);
    setSetting('last_comment_material_id', selected.id);
    setSetting('last_comment_text', selected.text.trim());
    return selected;
  }

  intervalFor(config, step) {
    const kind = step.kind;
    const field = `${kind}IntervalSeconds`;
    const value = config.actionPlan?.[step.actionIndex]?.intervalSeconds ?? config[field] ?? config.actionIntervalSeconds ?? 0;
    return Math.max(0, Math.min(3600, Number(value) || 0));
  }

  actionContent(job, step, kind, decoration = {}, raw) {
    const existing = getStepAction(job.id, stepKeyFor(step));
    if (!this.workflow.enabled(job)) return existing?.content ?? decorateText(raw(), decoration, kind, this.sequenceForStep(job.id, step, kind, decoration));
    this.workflow.ensureSteps(job);
    const parts = this.workflow.textParts(job.id, step, () => ({ raw: raw(), emoji: ['emoji','emoji-and-number'].includes(decoration.mode) ? pickRandom((decoration.emojis || []).filter(Boolean)) || '' : '', emojiPosition: decoration.emojiPosition, numberPosition: decoration.numberPosition, numbered: ['number','emoji-and-number'].includes(decoration.mode) }));
    let content = parts.emojiPosition === 'prefix' ? parts.emoji + parts.raw : parts.raw + parts.emoji;
    if (parts.numbered) {
      const number = existing?.sequence_confirmed && existing.sequence_number != null ? existing.sequence_number : this.sequenceForStep(job.id, step, kind, { mode: 'number' });
      content = parts.numberPosition === 'prefix' ? `${number}${content}` : `${content}${number}`;
    }
    return content;
  }

  sequenceForStep(jobId, step, kind, decoration) {
    if (!['number', 'emoji-and-number'].includes(decoration?.mode)) return null;
    const job = getJob(jobId);
    const stepKey = stepKeyFor(step);
    const reservations = { ...(job.cursor?.sequenceReservations || {}) };
    if (reservations[stepKey]) return reservations[stepKey].number;
    const sequences = { ...(job.cursor?.sequences || {}) };
    const current = sequences[kind] || { round: step.round, next: 1 };
    const sequence = current.round === step.round ? current.next : 1;
    reservations[stepKey] = { kind, round: step.round, number: sequence, confirmed: false };
    updateJob(jobId, { cursor: { ...job.cursor, sequenceReservations: reservations } });
    return sequence;
  }

  restoreSequence(jobId, step, kind, number, confirmed = false) {
    const job = getJob(jobId); if (!job) return;
    const stepKey = stepKeyFor(step);
    if (job.cursor?.sequenceReservations?.[stepKey]) return;
    updateJob(jobId, { cursor: { ...job.cursor, sequenceReservations: { ...(job.cursor?.sequenceReservations || {}), [stepKey]: { kind, round: step.round, number: Number(number), confirmed } } } });
  }

  confirmSequence(jobId, step) {
    const job = getJob(jobId); if (!job) return null;
    const stepKey = stepKeyFor(step);
    const reservation = job.cursor?.sequenceReservations?.[stepKey];
    if (!reservation || reservation.confirmed) return reservation?.number ?? null;
    const sequences = { ...(job.cursor?.sequences || {}) };
    const current = sequences[reservation.kind] || { round: reservation.round, next: 1 };
    sequences[reservation.kind] = {
      round: reservation.round,
      next: current.round === reservation.round ? Math.max(Number(current.next || 1), Number(reservation.number) + 1) : Number(reservation.number) + 1
    };
    const reservations = { ...(job.cursor?.sequenceReservations || {}), [stepKey]: { ...reservation, confirmed: true } };
    updateJob(jobId, { cursor: { ...job.cursor, sequences, sequenceReservations: reservations } });
    const action = getStepAction(jobId, stepKey);
    if (action) updateActionLog(action.id, { sequenceNumber: reservation.number, sequenceConfirmed: true });
    return reservation.number;
  }

  releaseSequence(jobId, step) {
    const job = getJob(jobId); if (!job) return;
    const stepKey = stepKeyFor(step);
    if (['post','comment','repost','like','comment_like'].includes(step.kind) && getStepAction(jobId, stepKey)?.state === 'succeeded') return;
    const reservation = job.cursor?.sequenceReservations?.[stepKey];
    if (!reservation) return;
    const reservations = { ...(job.cursor?.sequenceReservations || {}) };
    delete reservations[stepKey];
    const sequences = { ...(job.cursor?.sequences || {}) };
    const current = sequences[reservation.kind];
    if (reservation.confirmed && current?.round === reservation.round && Number(current.next) === Number(reservation.number) + 1) {
      sequences[reservation.kind] = { ...current, next: reservation.number };
    }
    const action = getStepAction(jobId, stepKey);
    if (action) updateActionLog(action.id, { sequenceConfirmed: false });
    updateJob(jobId, { cursor: { ...job.cursor, sequences, sequenceReservations: reservations } });
  }

  async loggedAction(job, step, account, topic, targetId, content, callback) {
    this.assertMaySubmit(job.id);
    const stepKey = stepKeyFor(step);
    const existing = getStepAction(job.id, stepKey);
    if (existing && ['submitted', 'started', 'uncertain'].includes(existing.state)) {
      return { state: 'uncertain', reason: '这一步可能已经提交，请先核对结果' };
    }
    if (existing?.state === 'succeeded') return { state: 'succeeded', url: existing.url };
    const reservation = getJob(job.id)?.cursor?.sequenceReservations?.[stepKey];
    const actionId = existing?.id || createActionLog({ jobId: job.id, stepKey, kind: step.kind, accountId: account.id, topicId: topic?.id, link: job.config.kind === 'engage' ? linkForStep(job, step) : null, targetId, content, state: 'prepared', sequenceNumber: reservation?.number, sequenceConfirmed: reservation?.confirmed });
    if (job.config.kind === 'engage') updateActionLog(actionId, { url: linkForStep(job, step) });
    if (['post','comment','repost','like','comment_like'].includes(step.kind)) beginPostAttempt(actionId, id('attempt_'));
    if (existing && this.workflow.enabled(job)) updateActionLog(actionId, { content, sequenceNumber: reservation?.number ?? existing.sequence_number, sequenceConfirmed: reservation?.confirmed ?? Boolean(existing.sequence_confirmed) });
    try {
      const result = await callback(actionId);
      if (['succeeded', 'uncertain'].includes(result?.state)) this.confirmSequence(job.id, step);
      else if (['failed', 'cancelled'].includes(result?.state)) this.releaseSequence(job.id, step);
      log(result.state === 'succeeded' ? 'success' : 'warning', `${step.kind}：${result.state}`, { accountId: account.id, topicId: topic?.id, url: result.url });
      return result;
    } catch (error) {
      const accepted = getActionLog(actionId);
      if (['post','comment','repost','like','comment_like'].includes(step.kind) && accepted?.state === 'succeeded') {
        this.confirmSequence(job.id, step);
        return { state: 'succeeded', url: accepted.receipt_url || accepted.url, receiptId: accepted.receipt_id, receiptUrl: accepted.receipt_url };
      }
      if (['post','comment','repost','like','comment_like'].includes(step.kind) && error.code === 'receipt_persistence_failed') {
        updateActionLog(actionId, { state: 'uncertain', error: error.message, verificationPending: false });
        this.confirmSequence(job.id, step);
        this.emitUpdate(updateJob(job.id, { status: 'paused', pausedByUser: true, waitReason: error.message }));
        return { state: 'uncertain', reason: error.message };
      }
      if (await this.navigation.handle(error, job.id, step)) throw error;
      if (await this.network.handle(error, job.id, step)) throw error;
      if (error.code === 'engage_interrupted' && this.groupedEngage(job) && !getActionLog(actionId)?.submitted_at) {
        updateActionLog(actionId,{state:'prepared'});
        throw error;
      }
      if (error instanceof DailyStopError && error.unsubmitted) {
        const context = this.executionStorage.getStore();
        if (context) context.submitted = false;
        updateActionLog(actionId, { state: 'prepared' });
        this.releaseSequence(job.id, step);
        throw error;
      }
      if (error instanceof DailyStopError || this.executionStorage.getStore()?.cancelled) throw new DailyStopError();
      if (error instanceof VerificationError && this.workflow.enabled(job)) {
        const submitted = !error.explicitlyUnpublished && ['submitted','uncertain'].includes(getStepAction(job.id, stepKey)?.state);
        updateActionLog(actionId, { state: submitted ? 'uncertain' : 'verification_wait', error: error.message });
        error.submittedUncertain = submitted;
        throw error;
      }
      if (error instanceof RateLimitError || error instanceof MutedError) {
        updateActionLog(actionId, { state: error.rejected ? (error instanceof RateLimitError ? 'skipped' : 'failed') : 'uncertain', error: serializeError(error) });
        if (error.rejected) this.releaseSequence(job.id, step); else this.confirmSequence(job.id, step);
        throw error;
      }
      if (getStepAction(job.id, stepKey)?.state === 'submitted') {
        updateActionLog(actionId, { state: 'uncertain', error: serializeError(error) });
        if (error instanceof VerificationError) { error.submittedUncertain = true; throw error; }
        return { state: 'uncertain', reason: '提交后结果无法确认，请核对后继续' };
      }
      if (error instanceof VerificationError) {
        if (step.kind === 'checkin') {
          updateActionLog(actionId, { state: 'uncertain', error: serializeError(error) });
          error.submittedUncertain = true;
        } else updateActionLog(actionId, { state: 'prepared', error: serializeError(error) });
        throw error;
      }
      if (error instanceof AuthenticationError) {
        updateActionLog(actionId, { state: 'prepared', error: serializeError(error) });
        this.releaseSequence(job.id, step);
        throw error;
      }
      updateActionLog(actionId, { state: 'failed', error: serializeError(error) });
      this.releaseSequence(job.id, step);
      throw error;
    }
  }

  async advance(jobId, step, state, notice = null) {
    if (this.workflow.enabled(getJob(jobId))) return this.workflow.finishStep(jobId, step, state, notice);
    if (getJob(jobId)?.status === 'stopped') return;
    if (!getStepAction(jobId, stepKeyFor(step))) {
      createActionLog({ jobId, stepKey: stepKeyFor(step), kind: step.kind, accountId: step.accountId, topicId: step.topicId, state, error: notice });
    }
    const job = getJob(jobId);
    const metricKey = state === 'succeeded' ? 'success' : state;
    const metrics = { ...job.metrics, [metricKey]: Number(job.metrics[metricKey] || 0) + 1 };
    const zeroOnlyRefreshes = { ...(job.cursor?.zeroOnlyRefreshes || {}) };
    delete zeroOnlyRefreshes[stepKeyFor(step)];
    const superlikeSteps = { ...(job.cursor?.superlikeSteps || {}) };
    delete superlikeSteps[stepKeyFor(step)];
    const cursor = { ...job.cursor, zeroOnlyRefreshes, superlikeSteps, stepIndex: Number(job.cursor.stepIndex || 0) + 1, ...(notice ? { notice } : {}) };
    const updated = updateJob(jobId, { cursor, metrics, status: job.status === 'paused' ? 'paused' : 'running', waitReason: job.status === 'paused' ? job.wait_reason : null });
    this.emitUpdate(updated);
    const steps = buildSteps(updated.config);
    const nextStep = steps[updated.cursor.stepIndex];
    if (!nextStep || nextStep.round !== step.round) this.completeRound(jobId, step.round);
  }

  completeRound(jobId, round) {
    if (this.isExpired(jobId)) { this.enforceDailyStop(); return; }
    const report = finishRound(jobId, round);
    if (!report) return;
    const job = getJob(jobId);
    if (round + 1 < job.config.rounds) {
      updateJob(jobId, { cursor: { ...job.cursor, nextRoundNotBefore: { round: round + 1, at: new Date(Date.parse(report.completedAt) + (Number(job.config.roundIntervalSeconds) || 0) * 1000).toISOString() } } });
    }
    this.emit('round-completed', report);
  }

  async skipAccount(jobId, step, reason) {
    const job = getJob(jobId);
    const existing = getStepAction(jobId, stepKeyFor(step));
    if (existing && !['succeeded', 'failed', 'uncertain', 'skipped'].includes(existing.state)) updateActionLog(existing.id, { state: 'failed', error: reason });
    const skippedAccountIds = [...new Set([...(job.cursor.skippedAccountIds || []), step.accountId])];
    const cursor = { ...job.cursor, skippedAccountIds, skipReasons: { ...(job.cursor.skipReasons || {}), [step.accountId]: reason }, notice: reason };
    updateJob(jobId, { cursor });
    await this.finishStep(getJob(jobId), step, 'failed', reason);
  }

  async finishStep(job, step, state, message) {
    const stepKey = `${step.round}:${step.topicId}:${step.accountId}:${step.actionIndex}:${step.unitIndex}`;
    const existing = getStepAction(job.id, stepKey);
    if (existing) {
      if (!['succeeded', 'failed', 'uncertain', 'skipped'].includes(existing.state)) updateActionLog(existing.id, { state, error: message });
    } else {
      try { createActionLog({ jobId: job.id, stepKey, kind: step.kind, accountId: step.accountId, topicId: step.topicId, state, error: message }); } catch {}
    }
    if (['failed', 'skipped'].includes(state)) this.releaseSequence(job.id, step);
    await this.advance(job.id, step, state);
  }

  async readWithRetry(fn, retries = 2) {
    let last;
    for (let attempt = 0; attempt <= retries; attempt += 1) {
      this.assertExecutionAlive();
      const context = this.executionStorage.getStore();
      if (context && !context.submitted) this.assertMaySubmit(context.jobId);
      try { const result = await fn(); this.assertExecutionAlive(); return result; } catch (error) {
        last = error;
        if (isNavigationError(error)) throw error;
        if (context && await this.network.isNetworkError(error, context.jobId)) throw error;
        if (error instanceof AuthenticationError || error instanceof VerificationError || error instanceof DailyStopError) throw error;
        if (attempt < retries) await new Promise(resolve => setTimeout(resolve, 800 * (attempt + 1)));
      }
    }
    throw last;
  }

  async interruptibleWait(jobId, milliseconds, reason) {
    this.enforceDailyStop();
    this.assertExecutionAlive();
    if (getJob(jobId)?.status === 'stopped' || this.isExpired(jobId)) return false;
    const until = Date.now() + milliseconds;
    while (Date.now() < until) {
      this.enforceDailyStop();
      this.assertExecutionAlive();
      const job = getJob(jobId);
      if (!job || job.stopRequested) return false;
      if (job.status === 'paused') return false;
      if (this.workflow.enabled(job) && job.cursor.manualVerification?.phase === 'requested') return false;
      const remainingSeconds = Math.ceil((until - Date.now()) / 1000);
      updateJob(jobId, { waitReason: `${reason}（${remainingSeconds} 秒）` });
      this.emitUpdate(getJob(jobId));
      await new Promise(resolve => setTimeout(resolve, Math.min(500, Math.max(1, until - Date.now()))));
    }
    this.enforceDailyStop();
    this.assertExecutionAlive();
    return !this.isExpired(jobId) && getJob(jobId)?.status !== 'stopped';
  }

  emitUpdate(job) { this.emit('update', job ? { ...job, progress: taskProgress(job) } : job); }
}

export function createRunner(browserManager, options = {}) {
  return new TaskRunner(new WeiboAdapter(browserManager), options);
}

function linkForStep(job, step) { return step.link || job.config.linkIdentities?.[step.topicId]?.url || step.topicId; }

function stepKeyFor(step) {
  return `${step.round}:${step.topicId}:${step.accountId}:${step.segmentId || step.actionIndex}:${step.unitIndex}`;
}
