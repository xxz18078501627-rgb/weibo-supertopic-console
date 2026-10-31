import { db, getJob, updateJob, getAccount, listTopics, getStepAction, createActionLog, updateActionLog, recordAccountRestriction, recordComment, recordCheckin, log } from './db.js';
import { shanghaiDate } from './util.js';
import { VerificationError, AuthenticationError, RateLimitError, MutedError } from './weibo-adapter.js';
import { DailyStopError } from './daily-stop.js';
import { startRound, runningRounds, finishRound } from './task-reports.js';
import { notifyVerification, resetVerificationNotifications } from './notifications.js';

db.exec(`CREATE TABLE IF NOT EXISTS task_step_state (
  job_id TEXT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE, step_key TEXT NOT NULL,
  ordinal INTEGER NOT NULL, round_index INTEGER NOT NULL, account_id TEXT NOT NULL, identity TEXT NOT NULL,
  topic_id TEXT NOT NULL, kind TEXT NOT NULL, action_index INTEGER NOT NULL, segment_id TEXT, unit_index INTEGER NOT NULL,
  state TEXT NOT NULL DEFAULT 'pending', outcome TEXT, ever_verification INTEGER NOT NULL DEFAULT 0,
  attempts INTEGER NOT NULL DEFAULT 0, content_parts_json TEXT,
  PRIMARY KEY(job_id,step_key)
);
CREATE INDEX IF NOT EXISTS idx_task_steps_schedule ON task_step_state(job_id,round_index,state,ordinal);
CREATE TABLE IF NOT EXISTS verification_cards (
  job_id TEXT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE, round_index INTEGER NOT NULL, identity TEXT NOT NULL,
  account_id TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending', blocked_kinds_json TEXT NOT NULL DEFAULT '[]',
  reason TEXT, source TEXT NOT NULL DEFAULT 'verification_detected', triggered_at TEXT NOT NULL, updated_at TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY(job_id,round_index,identity)
);`);
try { db.exec('ALTER TABLE task_step_state ADD COLUMN segment_id TEXT'); } catch {}
try { db.exec("ALTER TABLE verification_cards ADD COLUMN source TEXT NOT NULL DEFAULT 'verification_detected'"); } catch {}
for (const sql of [
  "ALTER TABLE verification_cards ADD COLUMN verification_result TEXT NOT NULL DEFAULT 'pending'",
  'ALTER TABLE verification_cards ADD COLUMN verified_at TEXT',
  "ALTER TABLE verification_cards ADD COLUMN checkin_result TEXT NOT NULL DEFAULT 'unknown'"
]) { try { db.exec(sql); } catch {} }

export const stepKey = step => `${step.round}:${step.topicId}:${step.accountId}:${step.segmentId || step.actionIndex}:${step.unitIndex}`;
const stepFrom = row => ({ round: row.round_index, topicId: row.topic_id, accountId: row.account_id, kind: row.kind, actionIndex: row.action_index, segmentId: row.segment_id || null, unitIndex: row.unit_index });
const terminal = state => ['done', 'review', 'cancelled'].includes(state);
const pendingCard = status => ['pending', 'requested', 'validating'].includes(status);
const conflict = message => Object.assign(new Error(message), { statusCode: 409 });

export class VerificationWorkflow {
  constructor(runner, buildSteps) {
    this.runner = runner;
    this.buildSteps = buildSteps;
    this.session = null;
  }

  time() { return new Date(this.runner.now()).toISOString(); }
  enabled(job) { return Number(job?.config?.schedulerVersion || 0) >= 2; }
  busy() { return Boolean(this.session || this.runner.current()?.cursor?.manualVerification); }

  ensureSteps(job) {
    if (db.prepare('SELECT 1 FROM task_step_state WHERE job_id=? LIMIT 1').get(job.id)) return;
    const insert = db.prepare(`INSERT OR IGNORE INTO task_step_state(job_id,step_key,ordinal,round_index,account_id,identity,topic_id,kind,action_index,segment_id,unit_index) VALUES(?,?,?,?,?,?,?,?,?,?,?)`);
    db.exec('BEGIN IMMEDIATE');
    try {
      this.buildSteps(job.config).forEach((step, index) => {
        const uid = job.config.accountIdentities?.[step.accountId]?.uid || getAccount(step.accountId)?.uid;
        insert.run(job.id, stepKey(step), index, step.round, step.accountId, String(uid || `account:${step.accountId}`), step.topicId, step.kind, step.actionIndex, step.segmentId || null, step.unitIndex);
      });
      db.exec('COMMIT');
    } catch (error) { db.exec('ROLLBACK'); throw error; }
  }

  // Rebuild only work that has not reached a durable outcome.  Historical rows
  // stay in place, which keeps receipts, numbering and reports auditable.
  reconcile(job, nextConfig, { emit = true } = {}) {
    this.ensureSteps(job);
    const currentRound = Number(job.cursor.workflowRound || 0);
    const oldPlan = (job.config.actionPlan || []).map((item, index) => ({ ...item, segmentId: item.segmentId || job.config.segmentIds?.[index] || `legacy-${index}` }));
    const plan = (nextConfig.actionPlan || []).map((item, index) => ({ ...item, segmentId: item.segmentId || nextConfig.segmentIds?.[index] || `seg-${index}` }));
    const bySegment = new Map(plan.map((item, index) => [item.segmentId, { ...item, index }]));
    const oldSegment = index => oldPlan[index]?.segmentId || `legacy-${index}`;
    const terminalStates = new Set(['done', 'review', 'cancelled']);
    const rows = db.prepare('SELECT * FROM task_step_state WHERE job_id=?').all(job.id);
    let kept = 0, cancelled = 0, added = 0;
    db.exec('SAVEPOINT reconcile_task_plan');
    try {
      for (const row of rows) {
        const segmentId = row.segment_id || oldSegment(row.action_index);
        const group = bySegment.get(segmentId);
        const stillIncluded = group && group.type === row.kind && nextConfig.accountIds.includes(row.account_id) && nextConfig.topicIds.includes(row.topic_id) && row.unit_index < (row.kind === 'checkin' ? Math.min(1, group.count) : group.count);
        if (stillIncluded) {
          const newKey = stepKey({ round: row.round_index, topicId: row.topic_id, accountId: row.account_id, actionIndex: group.index, segmentId, unitIndex: row.unit_index });
          if (row.step_key !== newKey) {
            db.prepare('UPDATE action_logs SET step_key=? WHERE job_id=? AND step_key=?').run(newKey, job.id, row.step_key);
            db.prepare('UPDATE task_step_state SET step_key=?,action_index=?,segment_id=? WHERE job_id=? AND step_key=?').run(newKey, group.index, segmentId, job.id, row.step_key);
          } else db.prepare('UPDATE task_step_state SET action_index=?,segment_id=? WHERE job_id=? AND step_key=?').run(group.index, segmentId, job.id, row.step_key);
          kept += 1;
          continue;
        }
        if (!terminalStates.has(row.state) && row.round_index >= currentRound) {
          const action = getStepAction(job.id, row.step_key);
          if (['submitted', 'uncertain'].includes(action?.state)) {
            db.prepare("UPDATE task_step_state SET state='review',outcome='uncertain' WHERE job_id=? AND step_key=?").run(job.id, row.step_key);
            continue;
          }
          if (action && !['submitted', 'uncertain'].includes(action.state)) updateActionLog(action.id, { state: 'cancelled', error: '已从暂停后的任务参数中移除' });
          if (!['submitted', 'uncertain'].includes(action?.state)) this.runner.releaseSequence(job.id, stepFrom(row));
          db.prepare("UPDATE task_step_state SET state='cancelled',outcome=NULL WHERE job_id=? AND step_key=?").run(job.id, row.step_key);
          cancelled += 1;
        }
      }
      const present = new Set(db.prepare('SELECT step_key FROM task_step_state WHERE job_id=?').all(job.id).map(row => row.step_key));
      const insert = db.prepare('INSERT OR IGNORE INTO task_step_state(job_id,step_key,ordinal,round_index,account_id,identity,topic_id,kind,action_index,segment_id,unit_index) VALUES(?,?,?,?,?,?,?,?,?,?,?)');
      const max = Number(db.prepare('SELECT COALESCE(MAX(ordinal),-1) n FROM task_step_state WHERE job_id=?').get(job.id).n);
      let ordinal = max + 1;
      for (const step of this.buildSteps(nextConfig)) {
        if (step.round < currentRound || present.has(stepKey(step))) continue;
        const uid = nextConfig.accountIdentities?.[step.accountId]?.uid || getAccount(step.accountId)?.uid;
        insert.run(job.id, stepKey(step), ordinal++, step.round, step.accountId, String(uid || `account:${step.accountId}`), step.topicId, step.kind, step.actionIndex, step.segmentId || null, step.unitIndex);
        added += 1;
      }
      const order = db.prepare('UPDATE task_step_state SET ordinal=? WHERE job_id=? AND step_key=?');
      this.buildSteps(nextConfig).forEach((step, index) => order.run(index, job.id, stepKey(step)));
      db.exec('RELEASE SAVEPOINT reconcile_task_plan');
    } catch (error) { db.exec('ROLLBACK TO SAVEPOINT reconcile_task_plan; RELEASE SAVEPOINT reconcile_task_plan'); throw error; }
    this.updateProgress(job.id, { emit });
    return { kept, cancelled, added };
  }

  row(jobId, step) { return db.prepare('SELECT * FROM task_step_state WHERE job_id=? AND step_key=?').get(jobId, stepKey(step)); }
  rows(jobId, round) { return db.prepare('SELECT * FROM task_step_state WHERE job_id=? AND round_index=? ORDER BY ordinal').all(jobId, round); }
  card(jobId, round, identity) { return db.prepare('SELECT * FROM verification_cards WHERE job_id=? AND round_index=? AND identity=?').get(jobId, round, identity); }
  setCursor(jobId, patch) { const job = getJob(jobId); return updateJob(jobId, { cursor: { ...job.cursor, ...patch } }); }

  textParts(jobId, step, create = null) {
    const row = this.row(jobId, step);
    if (row?.content_parts_json) return JSON.parse(row.content_parts_json);
    if (!create) return null;
    const parts = create();
    db.prepare('UPDATE task_step_state SET content_parts_json=? WHERE job_id=? AND step_key=?').run(JSON.stringify(parts), jobId, stepKey(step));
    return parts;
  }

  metrics(jobId) {
    const result = { success: 0, failed: 0, uncertain: 0, skipped: 0 };
    for (const row of db.prepare('SELECT outcome,COUNT(*) n FROM task_step_state WHERE job_id=? AND outcome IS NOT NULL GROUP BY outcome').all(jobId)) {
      const key = row.outcome === 'succeeded' ? 'success' : row.outcome;
      if (key in result) result[key] = Number(row.n);
    }
    return result;
  }

  updateProgress(jobId, { emit = true } = {}) {
    const job = getJob(jobId);
    const n = db.prepare("SELECT COUNT(*) n FROM task_step_state WHERE job_id=? AND state IN ('done','review','cancelled')").get(jobId).n;
    const updated = updateJob(jobId, { metrics: this.metrics(jobId), cursor: { ...job.cursor, stepIndex: Number(n) } });
    if (emit) this.runner.emitUpdate(updated);
    return updated;
  }

  refreshCard(jobId, round, identity) {
    const card = this.card(jobId, round, identity); if (!card) return;
    const remaining = db.prepare("SELECT COUNT(*) n FROM task_step_state WHERE job_id=? AND round_index=? AND identity=? AND state IN ('deferred','running','pending') AND ever_verification=1").get(jobId, round, identity).n;
    const reviews = db.prepare("SELECT COUNT(*) n FROM task_step_state WHERE job_id=? AND round_index=? AND identity=? AND state='review'").get(jobId, round, identity).n;
    const unfinished = db.prepare("SELECT COUNT(*) n FROM task_step_state WHERE job_id=? AND round_index=? AND identity=? AND state IN ('deferred','running','pending','review')").get(jobId, round, identity).n;
    if (!remaining && !reviews && !unfinished) {
      db.prepare("UPDATE verification_cards SET status='resolved',updated_at=? WHERE job_id=? AND round_index=? AND identity=?").run(this.time(), jobId, round, identity);
    } else if (!remaining && !reviews && card.verification_result === 'passed') {
      db.prepare("UPDATE verification_cards SET status='ready',reason='签到已完成，仍有其他操作等待继续运行',updated_at=? WHERE job_id=? AND round_index=? AND identity=?").run(this.time(), jobId, round, identity);
    }
  }

  finishStep(jobId, step, state, reason = null) {
    let job = getJob(jobId); if (job.status === 'stopped') return;
    const row = this.row(jobId, step); if (!row) return;
    if (row.state === 'done' && row.outcome === state) return;
    const action = getStepAction(jobId, stepKey(step));
    if (!action) createActionLog({ jobId, stepKey: stepKey(step), kind: step.kind, accountId: step.accountId, topicId: step.topicId, state, error: reason });
    else if (action.state !== state || reason) updateActionLog(action.id, { state, error: reason || action.error || '' });
    const nextState = state === 'uncertain' && row.ever_verification ? 'review' : 'done';
    db.prepare('UPDATE task_step_state SET state=?,outcome=? WHERE job_id=? AND step_key=?').run(nextState, state, jobId, stepKey(step));
    if (step.kind === 'checkin' && state === 'succeeded' && !this.rows(jobId, step.round).some(item => item.identity === row.identity && item.kind === 'checkin' && item.ever_verification && item.outcome !== 'succeeded')) {
      db.prepare("UPDATE verification_cards SET checkin_result='succeeded' WHERE job_id=? AND round_index=? AND identity=?").run(jobId, step.round, row.identity);
    }
    const fresh = getJob(jobId), zeroOnlyRefreshes = { ...fresh.cursor.zeroOnlyRefreshes }, superlikeSteps = { ...fresh.cursor.superlikeSteps };
    delete zeroOnlyRefreshes[stepKey(step)]; delete superlikeSteps[stepKey(step)];
    this.setCursor(jobId, { zeroOnlyRefreshes, superlikeSteps });
    this.refreshCard(jobId, step.round, row.identity);
    this.updateProgress(jobId);
  }

  defer(jobId, step, error, { priority = true } = {}) {
    db.exec('BEGIN IMMEDIATE');
    try {
    const job = getJob(jobId), row = this.row(jobId, step);
    const action = getStepAction(jobId, stepKey(step));
    const submitted = !error.explicitlyUnpublished && (error.submittedUncertain || ['submitted', 'uncertain'].includes(action?.state));
    db.prepare("UPDATE task_step_state SET state='deferred',ever_verification=1 WHERE job_id=? AND round_index=? AND identity=? AND kind=? AND state IN ('pending','running')")
      .run(jobId, step.round, row.identity, step.kind);
    if (submitted) {
      if (action) updateActionLog(action.id, { state: 'uncertain', error: error.message });
      this.runner.confirmSequence(jobId, step);
      db.prepare("UPDATE task_step_state SET state='review',outcome='uncertain' WHERE job_id=? AND step_key=?").run(jobId, stepKey(step));
    } else {
      this.runner.releaseSequence(jobId, step);
      if (action) updateActionLog(action.id, { state: 'verification_wait', sequenceNumber: null, sequenceConfirmed: false, error: error.message });
      db.prepare('UPDATE task_step_state SET outcome=NULL WHERE job_id=? AND step_key=?').run(jobId, stepKey(step));
    }
    const previous = this.card(jobId, step.round, row.identity);
    const blocked = [...new Set([...(previous && pendingCard(previous.status) ? JSON.parse(previous.blocked_kinds_json) : []), step.kind])];
    db.prepare(`INSERT INTO verification_cards(job_id,round_index,identity,account_id,reason,triggered_at,updated_at,blocked_kinds_json)
      VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(job_id,round_index,identity) DO UPDATE SET status='pending',reason=excluded.reason,updated_at=excluded.updated_at,
      blocked_kinds_json=excluded.blocked_kinds_json,attempts=verification_cards.attempts+1`).run(jobId, step.round, row.identity, step.accountId, error.message, this.time(), this.time(), JSON.stringify(blocked));
    if (priority) this.setCursor(jobId, { workflowPriority: { identity: row.identity, topicId: step.topicId }, notice: '已登记待验证账号，继续尝试该账号的其他操作类型' });
    db.exec('COMMIT');
    } catch (failure) { db.exec('ROLLBACK'); throw failure; }
    // Notify only after the card transaction is durable; SSE consumers must
    // never receive a card that a subsequent refresh cannot yet read.
    db.prepare("UPDATE verification_cards SET verification_result='pending',verified_at=NULL WHERE job_id=? AND round_index=? AND identity=?").run(jobId, step.round, this.row(jobId, step).identity);
    this.updateProgress(jobId);
  }

  // A check-in has no receipt ID to reconcile after the click.  If the page
  // does not confirm success, keep the uncertain action as evidence but move
  // the step into the user-facing verification queue instead of silently
  // completing the round as a generic "待核对".
  deferUnconfirmedCheckin(jobId, step, reason) {
    db.exec('BEGIN IMMEDIATE');
    try {
      const job = getJob(jobId), row = this.row(jobId, step);
      if (!row) throw new Error('找不到签到步骤');
      const prior = this.card(jobId, step.round, row.identity);
      const alreadyVerified = prior?.verification_result === 'passed';
      db.prepare("UPDATE task_step_state SET state='deferred',outcome=NULL,ever_verification=1 WHERE job_id=? AND step_key=?").run(jobId, stepKey(step));
      db.prepare(`INSERT INTO verification_cards(job_id,round_index,identity,account_id,status,blocked_kinds_json,reason,source,triggered_at,updated_at)
        VALUES(?,?,?,?,?,?,?,?,?,?) ON CONFLICT(job_id,round_index,identity) DO UPDATE SET status='pending',reason=excluded.reason,source=excluded.source,updated_at=excluded.updated_at,
        blocked_kinds_json=excluded.blocked_kinds_json,attempts=verification_cards.attempts+1`)
        .run(jobId, step.round, row.identity, step.accountId, 'pending', JSON.stringify(['checkin']), reason, 'checkin_unconfirmed', this.time(), this.time());
      this.setCursor(jobId, { workflowPriority: { identity: row.identity, topicId: step.topicId }, notice: '签到结果未确认，已登记为待验证账号' });
      if (alreadyVerified) {
        db.prepare("UPDATE verification_cards SET status='ready',verification_result='passed',verified_at=?,checkin_result='pending',reason=? WHERE job_id=? AND round_index=? AND identity=?").run(prior.verified_at, '安全验证已通过；签到结果尚未确认，可继续补做', jobId, step.round, row.identity);
      } else {
        db.prepare("UPDATE verification_cards SET verification_result='pending',verified_at=NULL,checkin_result='unknown' WHERE job_id=? AND round_index=? AND identity=?").run(jobId, step.round, row.identity);
      }
      db.exec('COMMIT');
    } catch (error) { db.exec('ROLLBACK'); throw error; }
    this.updateProgress(jobId);
  }

  // One-off compatibility repair for the two check-ins that completed before
  // the queue learned to classify an unconfirmed sign-in as verification.
  reopenUnconfirmedCheckins(jobId) {
    const job = getJob(jobId);
    if (!job || job.status !== 'completed' || !this.enabled(job)) return null;
    const rows = db.prepare(`SELECT s.* FROM task_step_state s JOIN action_logs a ON a.job_id=s.job_id AND a.step_key=s.step_key
      WHERE s.job_id=? AND s.kind='checkin' AND s.outcome='uncertain' AND a.state='uncertain'`).all(jobId);
    if (!rows.length) return null;
    db.exec('BEGIN IMMEDIATE');
    try {
      for (const row of rows) {
        db.prepare("UPDATE task_step_state SET state='deferred',outcome=NULL,ever_verification=1 WHERE job_id=? AND step_key=?").run(jobId, row.step_key);
        db.prepare(`INSERT INTO verification_cards(job_id,round_index,identity,account_id,status,blocked_kinds_json,reason,source,triggered_at,updated_at)
          VALUES(?,?,?,?,?,?,?,?,?,?) ON CONFLICT(job_id,round_index,identity) DO UPDATE SET status='pending',reason=excluded.reason,source=excluded.source,updated_at=excluded.updated_at`).run(
          jobId, row.round_index, row.identity, row.account_id, 'pending', JSON.stringify(['checkin']), '历史签到结果未确认，等待人工验证', 'checkin_unconfirmed', this.time(), this.time());
      }
      const round = Math.min(...rows.map(row => Number(row.round_index)));
      updateJob(jobId, { status: 'waiting', pausedByUser: false, waitReason: '等待历史签到人工验证及补做', cursor: { ...getJob(jobId).cursor, workflowRound: round, verificationBarrier: true, verificationNotifiedAt: this.time(), reopenedForCheckinVerification: true } });
      db.exec('COMMIT');
    } catch (error) { db.exec('ROLLBACK'); throw error; }
    return this.updateProgress(jobId);
  }

  restriction(job, row) {
    const active = this.runner.restrictionFor?.(row.account_id, row.kind, row.identity);
    if (active && ['post', 'comment'].includes(row.kind)) return `账号${active.type === 'frequent' ? (row.kind === 'post' ? '发帖' : '评论') + '频繁，1 小时内暂停' : '禁言，暂停发帖/评论'}：${active.reason}`;
    if (job.cursor.skippedAccountIds?.includes(row.account_id)) return job.cursor.skipReasons?.[row.account_id] || '账号已跳过';
    if (['post', 'comment'].includes(row.kind)) {
      const mute = job.cursor.muteLimits?.find(item => item.round === row.round_index && item.identity === row.identity);
      if (mute) return `本轮禁言：${mute.reason}`;
    }
    const rate = job.cursor.rateLimits?.find(item => item.round === row.round_index && item.identity === row.identity && item.kind === row.kind);
    return rate ? `本轮${row.kind === 'post' ? '发帖' : '评论'}频繁：${rate.reason}` : null;
  }

  async handleError(jobId, step, error, options = {}) {
    if (error instanceof DailyStopError || this.runner.isExpired(jobId)) { this.runner.enforceDailyStop(); this.finalizeStop(jobId, '每日 23:59 自动停止'); return; }
    if (error instanceof VerificationError) { this.defer(jobId, step, error, options); return 'verification'; }
    const job = getJob(jobId), row = this.row(jobId, step);
    if (error instanceof RateLimitError || error instanceof MutedError) {
      const field = error instanceof MutedError ? 'muteLimits' : 'rateLimits';
      const limits = [...(job.cursor[field] || [])];
      if (!limits.some(item => item.identity === row.identity && item.round === step.round && (field === 'muteLimits' || item.kind === step.kind))) limits.push({ identity: row.identity, round: step.round, accountId: step.accountId, kind: step.kind, reason: error.message, at: this.time() });
      this.setCursor(jobId, { [field]: limits });
      this.finishStep(jobId, step, error.rejected ? (error instanceof RateLimitError ? 'skipped' : 'failed') : 'uncertain', error.message);
      if (error instanceof RateLimitError) {
        recordAccountRestriction({ accountId: step.accountId, identity: row.identity, type: 'frequent', kind: error.kind || step.kind, reason: error.message, detectedAt: this.time(), expiresAt: new Date(this.runner.now() + 60 * 60 * 1000).toISOString(), jobId });
        this.runner.accountRestrictionsAt = 0;
        for (const pending of this.rows(jobId, step.round).filter(item => item.identity === row.identity && item.kind === row.kind && ['pending','deferred'].includes(item.state))) {
          const action = getStepAction(jobId, pending.step_key);
          if (action && ['submitted','uncertain'].includes(action.state)) continue;
          this.runner.releaseSequence(jobId, stepFrom(pending));
          this.finishStep(jobId, stepFrom(pending), 'skipped', `本轮${row.kind === 'post' ? '发帖' : '评论'}频繁：${error.message}`);
        }
      }
    } else if (error instanceof AuthenticationError) {
      this.setCursor(jobId, { skippedAccountIds: [...new Set([...(job.cursor.skippedAccountIds || []), step.accountId])], skipReasons: { ...job.cursor.skipReasons, [step.accountId]: `登录失效或UID不符：${error.message}` } });
      this.finishStep(jobId, step, 'failed', error.message);
    } else this.finishStep(jobId, step, 'failed', error.message || String(error));
    log('warning', error.message || String(error), { accountId: step.accountId, topicId: step.topicId });
  }

  async executeRow(jobId, row, manual = false) {
    const step = stepFrom(row), job = getJob(jobId), account = getAccount(step.accountId), topic = listTopics().find(item => item.id === step.topicId);
    const reason = this.restriction(job, row);
    if (reason || !account || !topic) { this.finishStep(jobId, step, reason ? 'skipped' : 'failed', reason || '账号或超话不存在'); return; }
    db.prepare("UPDATE task_step_state SET state='running',attempts=attempts+1 WHERE job_id=? AND step_key=?").run(jobId, row.step_key);
    this.setCursor(jobId, { current: { ...step, accountName: account.name, topicName: topic.name }, workflowActiveStep: step });
    try {
      const operation = async () => {
        await this.runner.adapter.ensureIdentity(account);
        this.runner.assertMaySubmit(jobId);
        return this.runner.execute(getJob(jobId), step, account, topic, { reuseVisiblePage: manual && step.kind === 'checkin' });
      };
      const result = await this.runner.withDailyDeadline(job, step, () => this.runner.adapter.withChallengeMode ? this.runner.adapter.withChallengeMode(manual ? 'manual' : 'background', operation) : operation());
      if (this.runner.isExpired(jobId)) { this.runner.enforceDailyStop(); this.finalizeStop(jobId, '每日 23:59 自动停止'); return; }
      if (result?.waiting) {
        db.prepare("UPDATE task_step_state SET state=? WHERE job_id=? AND step_key=?").run(manual ? 'deferred' : 'pending', jobId, row.step_key);
        return 'waiting';
      }
      if (result?.state === 'uncertain' && step.kind === 'checkin') {
        this.deferUnconfirmedCheckin(jobId, step, result.reason || '点击签到后未确认结果');
        return 'verification';
      }
      this.finishStep(jobId, step, result?.state || 'succeeded', result?.reason);
      return result?.state || 'succeeded';
    } catch (error) {
      if (step.kind === 'post' && getStepAction(jobId, row.step_key)?.state === 'succeeded' && getJob(jobId)?.status !== 'stopped') {
        this.runner.confirmSequence(jobId, step);
        this.finishStep(jobId, step, 'succeeded');
        return 'succeeded';
      }
      if (await this.runner.network.handle(error, jobId, step)) {
        if (manual) { await this.runner.network.wait(jobId, () => this.session?.cancelled || this.session?.windowClosed); return 'network'; }
        return 'network';
      }
      if (manual && step.kind === 'checkin' && !(error instanceof DailyStopError) && !(error instanceof VerificationError) && !this.runner.isExpired(jobId)) {
        this.deferUnconfirmedCheckin(jobId, step, error.message || '签到未确认成功');
        return 'verification';
      }
      if (manual && this.session?.page?.isClosed?.() && !this.runner.isExpired(jobId)) {
        const closed = new VerificationError('验证窗口已关闭，未完成操作已保留');
        closed.submittedUncertain = ['submitted','uncertain'].includes(getStepAction(jobId, row.step_key)?.state);
        error = closed;
      }
      return this.handleError(jobId, step, error, { priority: !manual });
    }
  }

  async loop(jobId) {
    this.ensureSteps(getJob(jobId));
    while (true) {
      this.runner.enforceDailyStop();
      let job = getJob(jobId);
      if (!job || ['stopped', 'completed'].includes(job.status)) return;
      if (job.stopRequested) { this.finalizeStop(jobId, '已手动停止'); return; }
      if (job.status === 'paused') return;
      if (job.cursor.manualVerification?.phase === 'requested') { this.startManual(jobId, job.cursor.manualVerification.identity); return; }
      if (this.session || job.cursor.verificationBarrier) return;
      const round = Number(job.cursor.workflowRound || 0);
      if (round >= job.config.rounds) { resetVerificationNotifications(jobId); this.runner.emitUpdate(updateJob(jobId, { status: 'completed', waitReason: null })); return; }
      const wait = job.cursor.nextRoundNotBefore;
      if (wait?.round === round) {
        const remaining = Date.parse(wait.at) - this.runner.now();
        if (remaining > 0 && !(await this.runner.interruptibleWait(jobId, remaining, '等待下一轮'))) continue;
        this.setCursor(jobId, { nextRoundNotBefore: null });
      }
      startRound(jobId, round);
      let rows = this.rows(jobId, round);
      for (const row of rows) if (['pending', 'deferred'].includes(row.state)) {
        const reason = this.restriction(getJob(jobId), row);
        if (reason) this.finishStep(jobId, stepFrom(row), 'skipped', reason);
      }
      rows = this.rows(jobId, round);
      const priority = getJob(jobId).cursor.workflowPriority;
      let row = priority ? rows.find(item => item.state === 'pending' && item.identity === priority.identity && item.topic_id === priority.topicId) : null;
      if (!row && priority) this.setCursor(jobId, { workflowPriority: null });
      row ||= rows.find(item => item.state === 'pending');
      if (!row) {
        const cards = db.prepare('SELECT * FROM verification_cards WHERE job_id=? AND round_index=?').all(jobId, round);
        if (rows.some(item => !terminal(item.state)) || cards.some(item => pendingCard(item.status))) {
          const wasBarrier = getJob(jobId).cursor.verificationBarrier === true;
          this.runner.emitUpdate(updateJob(jobId, { status: 'waiting', waitReason: '等待人工验证及补做', cursor: { ...getJob(jobId).cursor, verificationBarrier: true } }));
          if (!wasBarrier) {
            log('info', '进入验证等待：待验证卡 ' + cards.length + ' 个，pending ' + rows.filter(item => item.state === 'pending').length + ' 个', { jobId });
            this.notifyBarrier(jobId, round);
          }
          return;
        }
        this.runner.completeRound(jobId, round);
        if (getJob(jobId).status === 'stopped') return;
        for (const card of cards) this.refreshCard(jobId, round, card.identity);
        this.setCursor(jobId, { workflowRound: round + 1, workflowPriority: null, workflowActiveStep: null });
        continue;
      }
      job = updateJob(jobId, { status: 'running', waitReason: null });
      const outcome = await this.executeRow(jobId, row);
      if (getJob(jobId).status === 'stopped') return;
      if (outcome && !['verification', 'waiting', 'skipped', 'network'].includes(outcome)) {
        const nextPending = this.rows(jobId, round).some(item => item.state === 'pending');
        const seconds = nextPending ? this.runner.intervalFor(job.config, stepFrom(row)) : 0;
        const submitted = this.runner.lastSubmitted;
        const elapsed = row.kind === 'post' && submitted?.jobId === jobId && submitted.stepKey === row.step_key ? Math.max(0, this.runner.now() - submitted.at) : 0;
        if (seconds * 1000 > elapsed) await this.runner.interruptibleWait(jobId, seconds * 1000 - elapsed, '等待下一项操作');
      }
    }
  }

  recover(jobId) {
    const job = getJob(jobId); this.ensureSteps(job);
    for (const row of db.prepare("SELECT * FROM task_step_state WHERE job_id=? AND state='running'").all(jobId)) {
      const action = getStepAction(jobId, row.step_key);
      if (['succeeded','failed','skipped'].includes(action?.state)) this.finishStep(jobId, stepFrom(row), action.state, action.error);
      else if (['submitted', 'uncertain'].includes(action?.state)) {
        const error = new VerificationError('中断时提交结果未知，请先只读复核'); error.submittedUncertain = true;
        this.defer(jobId, stepFrom(row), error, { priority: false });
      } else if (action?.state === 'verification_wait') this.defer(jobId, stepFrom(row), new VerificationError(action.error || '需要人工验证'), { priority: false });
      else if (row.ever_verification) {
        this.runner.releaseSequence(jobId, stepFrom(row));
        if (action) updateActionLog(action.id, { state: 'verification_wait', sequenceNumber: null, sequenceConfirmed: false });
        db.prepare("UPDATE task_step_state SET state='deferred' WHERE job_id=? AND step_key=?").run(jobId, row.step_key);
      } else db.prepare("UPDATE task_step_state SET state='pending' WHERE job_id=? AND step_key=?").run(jobId, row.step_key);
    }
    db.prepare("UPDATE verification_cards SET status='pending' WHERE job_id=? AND status IN ('requested','validating')").run(jobId);
    if (job.cursor.manualVerification) this.setCursor(jobId, { manualVerification: null, verificationBarrier: true });
    this.updateProgress(jobId);
  }

  status(job) {
    job = this.recoverOrphanedManual(job);
    if (!this.enabled(job)) return null;
    const round = Math.min(Number(job.cursor.workflowRound || 0), Math.max(0, Number(job.config.rounds || 1) - 1));
    const cards = db.prepare('SELECT * FROM verification_cards WHERE job_id=? AND round_index=? ORDER BY triggered_at').all(job.id, round).map(card => {
      const account = job.config.accountIdentities?.[card.account_id] || getAccount(card.account_id) || {};
      const identityRows = this.rows(job.id, round).filter(row => row.identity === card.identity);
      const steps = identityRows.map(row => {
        const action = getStepAction(job.id, row.step_key);
        return { key: row.step_key, kind: row.kind, topicId: row.topic_id, topicName: job.config.topicIdentities?.[row.topic_id]?.name || listTopics().find(topic => topic.id === row.topic_id)?.name || row.topic_id,
          state: row.state, outcome: row.outcome, actionId: action?.id || null, needsReview: row.state === 'review', reason: action?.error || '' };
      });
      const remainingStepCount = identityRows.filter(row => ['deferred','running','pending','review','network_review'].includes(row.state)).length;
      const remainingCheckins = identityRows.filter(row => row.kind === 'checkin' && row.ever_verification && ['deferred','running','pending','review','network_review'].includes(row.state)).length;
      const visible = !(card.checkin_result === 'succeeded' && remainingStepCount === 0);
      return { identity: card.identity, accountId: card.account_id, name: account.name || account.nickname || card.account_id, uid: account.uid || '', status: card.status, reason: card.reason, source: card.source || 'verification_detected', attempts: card.attempts, verificationResult: card.verification_result, verifiedAt: card.verified_at, checkinResult: card.checkin_result, remainingStepCount, remainingCheckins, visible, steps };
    });
    return { jobId: job.id, round, jobStatus: job.status, cards, session: job.cursor.manualVerification || null, barrier: Boolean(job.cursor.verificationBarrier),
      canContinue: !['completed','stopped'].includes(job.status) && !this.runner.isExpired(job.id) && !this.runner.promise && !this.session && !job.cursor.manualVerification && !cards.some(card => pendingCard(card.status)),
      stepCounts: db.prepare('SELECT state,COUNT(*) count FROM task_step_state WHERE job_id=? GROUP BY state').all(job.id) };
  }

  // A visible Chrome window belongs to the in-memory session. If the process
  // has no such session, a persisted "validating" card cannot be acted on and
  // must become retryable again (for example after Chrome or the service exits).
  recoverOrphanedManual(job) {
    if (!job || this.session || job.cursor?.manualVerification) return job;
    const result = db.prepare(`UPDATE verification_cards
      SET status='pending',reason=?,updated_at=?
      WHERE job_id=? AND status IN ('requested','validating')`).run(
      '验证会话已中断，请重新进入验证', this.time(), job.id
    );
    return result.changes ? getJob(job.id) : job;
  }

  requestManual(jobId, identity) {
    this.runner.assertMaySubmit(jobId);
    const job = getJob(jobId);
    if (!this.enabled(job) || ['completed', 'stopped'].includes(job.status)) throw conflict('当前任务不能进入验证');
    this.ensureSteps(job);
    const card = this.card(jobId, Number(job.cursor.workflowRound || 0), identity);
    if (!card) throw conflict('找不到待验证账号');
    if (this.busy()) throw conflict('请先结束当前账号的验证');
    this.runner.emitUpdate(this.setCursor(jobId, { manualVerification: { identity, phase: 'requested', requestedAt: this.time() } }));
    // `runner.promise` may still be alive while it is only waiting between
    // steps.  Waiting for that promise used to leave a verification card in
    // "等待打开" indefinitely: the workflow loop had already reached its
    // verification barrier and would never get another turn.  Only an actual
    // browser operation is unsafe to interrupt, so start as soon as that has
    // completed.
    if (!this.runner.promise && !this.runner.currentExecution) this.startManual(jobId, identity);
    else this.startManualWhenSafe(jobId, identity);
    return this.status(getJob(jobId));
  }

  startManualWhenSafe(jobId, identity) {
    const start = () => {
      const job = getJob(jobId);
      if (!job || this.session || job.cursor.manualVerification?.identity !== identity || job.cursor.manualVerification?.phase !== 'requested') return;
      if (this.runner.currentExecution) {
        const timer = setTimeout(start, 50);
        timer.unref?.();
        return;
      }
      this.startManual(jobId, identity);
    };
    queueMicrotask(start);
  }

  startManual(jobId, identity) {
    if (this.session) return;
    const session = { jobId, identity, cancelled: false, timer: null, windowClosed: false };
    this.session = session;
    const operation = () => this.manualOperation(session);
    session.promise = Promise.resolve().then(() => this.runner.adapter.withChallengeMode
      ? this.runner.adapter.withChallengeMode('manual', operation) : operation()).catch(error => {
      if (!(error instanceof DailyStopError) && getJob(jobId)?.status !== 'stopped') {
        const job = getJob(jobId);
        const message = `无法打开或保持验证窗口：${error.message}`;
        db.prepare("UPDATE verification_cards SET status='pending',reason=?,updated_at=? WHERE job_id=? AND round_index=? AND identity=?").run(message, this.time(), jobId, job.cursor.workflowRound || 0, identity);
        log('warning', message, { accountId: this.card(jobId, Number(job.cursor.workflowRound || 0), identity)?.account_id });
      }
    }).finally(async () => {
      clearTimeout(session.timer);
      if (this.session !== session) return;
      await Promise.resolve(this.runner.adapter.closeManual?.(session.browserContext)).catch(() => {});
      this.session = null;
      const job = getJob(jobId);
      if (job?.status !== 'stopped') {
        if (session.cancelled) db.prepare("UPDATE verification_cards SET status='pending',reason='验证会话已结束，请再次进入完成验证' WHERE job_id=? AND identity=? AND status='validating'").run(jobId, identity);
        this.runner.emitUpdate(this.setCursor(jobId, { manualVerification: null }));
      }
      // The visible browser belongs exclusively to this manual session.  Do
      // not leave it minimized in the Dock after the user ends verification.
    });
  }

  async manualOperation(session) {
    const { jobId, identity } = session;
    this.runner.assertMaySubmit(jobId);
    let job = getJob(jobId), round = Number(job.cursor.workflowRound || 0);
    const card = this.card(jobId, round, identity);
    db.prepare("UPDATE verification_cards SET status='validating',updated_at=? WHERE job_id=? AND round_index=? AND identity=?").run(this.time(), jobId, round, identity);
    job = updateJob(jobId, { status: 'waiting', waitReason: '正在手动验证账号', cursor: { ...job.cursor, manualVerification: { identity, phase: 'validating' } } });
    this.runner.emitUpdate(job);
    const row = this.rows(jobId, round).find(row => row.identity === identity && row.state === 'review') || this.rows(jobId, round).find(row => row.identity === identity && row.state === 'deferred');
    if (!row) { this.markReady(jobId, round, identity); return; }
    const account = getAccount(row.account_id), topic = listTopics().find(topic => topic.id === row.topic_id);
    const action = getStepAction(jobId, row.step_key);
    session.page = await this.runner.adapter.openVerification?.(account, topic, action);
    session.browserContext = session.page?.context?.();
    session.account = account; session.topic = topic; session.action = action;
    session.step = stepFrom(row);
    session.page?.once?.('close', () => {
      if (this.session !== session) return;
      session.windowClosed = true;
      session.closeReason = '验证窗口已关闭，请重新进入验证';
      session.wake?.();
    });
    await this.assertSession(session);
    let challenge = await this.runner.adapter.hasTaskChallenge?.(account);
    if (!challenge) {
      try { await this.runner.adapter.ensureIdentity(account); }
      catch (error) {
        if (!['network_error', 'identity_pending'].includes(error.code)) throw error;
        challenge = true;
      }
      await this.assertSession(session);
    }
    let checked = false;
    if (!challenge && row.state === 'review') {
      await this.recheckRow(jobId, row);
      checked = true;
    } else if (!challenge && card?.source !== 'checkin_unconfirmed') {
      if (row.kind === 'checkin') {
        const map = session.checkinClicks || (session.checkinClicks = new Map());
        const current = map.get(row.step_key) || { count: 0, at: 0 };
        map.set(row.step_key, { count: current.count + 1, at: this.runner.now() });
      }
      let outcome = await this.executeRow(jobId, row, true);
      while (outcome === 'network' && !['done','review'].includes(this.row(jobId, stepFrom(row))?.state)) {
        await this.assertSession(session);
        outcome = await this.executeRow(jobId, this.row(jobId, stepFrom(row)), true);
      }
      if (getJob(jobId).stopRequested) { this.finalizeStop(jobId, getJob(jobId).cursor.stopReason || '已手动停止'); return; }
      await this.assertSession(session);
      challenge = outcome === 'verification' || Boolean(await this.runner.adapter.hasTaskChallenge?.(account));
      if (outcome === 'waiting') throw new Error('暂未找到合格目标，请稍后再次进入验证');
    }
    while (challenge) {
      await this.waitForManualChallenge(session);
      challenge = !await this.probeManualSession(session);
    }
    await this.assertSession(session);
    if (row.kind === 'post' && !checked && session.page && this.runner.adapter.manualPostReceipt?.page === session.page) {
      // Solving the captcha can submit the existing composer automatically.
      // Never click Send again in this session; only wait for its receipt.
      const posted = () => getStepAction(jobId, row.step_key)?.state === 'succeeded';
      const until = this.runner.now() + 30000;
      while (!posted() && this.runner.now() < until) {
        this.runner.emitUpdate(this.setCursor(jobId, { manualVerification: { identity, phase: 'awaiting_post_receipt' } }));
        await new Promise(resolve => { session.wake = resolve; session.timer = setTimeout(resolve, 500); });
        await this.assertSession(session);
      }
      if (posted()) {
        this.runner.confirmSequence(jobId, stepFrom(row));
        this.finishStep(jobId, stepFrom(row), 'succeeded', '人工验证后已取得发布回执');
      }
    }
    // A solved challenge is not itself a successful sign-in.  Keep this same
    // visible context alive and finish every deferred sign-in for this UID in
    // plan order.  Posts/comments are deliberately left for Continue.
    this.markVerificationPassed(jobId, round, identity);
    if (this.checkinRows(jobId, round, identity).length) await this.completeManualCheckins(session, account, round, identity);
    if (!checked && this.row(jobId, stepFrom(row))?.state === 'review') await this.recheckRow(jobId, row);
    this.markReady(jobId, round, identity);
    this.refreshCard(jobId, round, identity);
    this.updateProgress(jobId);
  }

  async waitForManualChallenge(session) {
    await this.assertSession(session);
    session.challengeSeen = true;
    this.runner.emitUpdate(this.setCursor(session.jobId, { manualVerification: { identity: session.identity, phase: 'challenge' } }));
    await new Promise(resolve => { session.wake = resolve; session.timer = setTimeout(resolve, 2000); });
    session.wake = null; session.timer = null;
    await this.assertSession(session);
  }

  markVerificationPassed(jobId, round, identity) {
    if (this.session && this.session.challengeSeen) this.session.checkinClicks = new Map();
    db.prepare(`UPDATE verification_cards SET status='validating',verification_result='passed',verified_at=?,
      checkin_result=CASE WHEN checkin_result='succeeded' THEN 'succeeded' ELSE 'pending' END,
      reason='验证已通过，正在确认签到结果',updated_at=?
      WHERE job_id=? AND round_index=? AND identity=?`).run(this.time(), this.time(), jobId, round, identity);
    this.runner.emitUpdate(this.setCursor(jobId, { manualVerification: { identity, phase: 'signing_checkin' } }));
  }

  // 页面刚导航完时验证码可能已经重新出现。这里先只读探测一次，命中就把
  // 会话切回 challenge，让界面显示「正在当前窗口手动验证…」，而不是先
  // 报「补做签到」再等 verifyCheckin 抛错才发现。
  async settleChallenge(session, account, jobId, round, identity) {
    if (!await this.runner.adapter.hasTaskChallenge?.(account)) return false;
    await this.waitForManualChallenge(session);
    while (!await this.probeManualSession(session)) await this.waitForManualChallenge(session);
    this.markVerificationPassed(jobId, round, identity);
    return true;
  }

  completeManualCheckin(jobId, row) {
    const step = stepFrom(row), action = getStepAction(jobId, row.step_key), account = getAccount(row.account_id);
    recordCheckin(account.id, row.topic_id, shanghaiDate(new Date(this.runner.now())));
    if (action) updateActionLog(action.id, { state: 'succeeded', error: '' });
    this.finishStep(jobId, step, 'succeeded');
  }

  checkinRows(jobId, round, identity) {
    return this.rows(jobId, round).filter(row => row.identity === identity && row.kind === 'checkin' && row.ever_verification && ['deferred', 'review', 'network_review'].includes(row.state)).sort((a, b) => a.ordinal - b.ordinal);
  }

  async completeManualCheckins(session, account, round, identity) {
    const { jobId } = session;
    let lastSubmitAt = 0;
    // 每个签到步骤单独记账：验证码解除后可以重点，但 10 秒内不重复、最多 3 次。
    const clicks = session.checkinClicks || (session.checkinClicks = new Map());
    const pause = ms => new Promise(resolve => {
      const done = () => { if (session.timer) { clearTimeout(session.timer); session.timer = null; } session.wake = null; resolve(); };
      session.wake = done;
      session.timer = setTimeout(done, ms);
    });
    while (true) {
      await this.assertSession(session);
      const rows = this.checkinRows(jobId, round, identity);
      if (!rows.length) return;
      const row = rows[0], topic = listTopics().find(item => item.id === row.topic_id);
      if (!topic) throw new Error('待签到超话已不存在');
      if (session.topic?.id !== topic.id) {
        // openVerification navigates the existing manual page; it does not
        // create a second visible context.  Only changing supertopics needs
        // this navigation.
        session.page = await this.runner.adapter.openVerification?.(account, topic, getStepAction(jobId, row.step_key));
        session.browserContext = session.page?.context?.() || session.browserContext;
        session.topic = topic;
        await this.assertSession(session);
      }
      if (await this.settleChallenge(session, account, jobId, round, identity)) continue;
      const remaining = rows.length;
      db.prepare("UPDATE verification_cards SET status='validating',checkin_result='pending',reason=?,updated_at=? WHERE job_id=? AND round_index=? AND identity=?")
        .run('请在当前 Chrome 窗口完成签到（剩余 ' + remaining + ' 项）', this.time(), jobId, round, identity);
      this.runner.emitUpdate(this.setCursor(jobId, { manualVerification: { identity, phase: 'signing_checkin', topicId: topic.id, remainingCheckins: remaining } }));
      let readback;
      try { readback = await this.runner.adapter.verifyCheckin?.(account, topic); }
      catch (error) {
        if (error instanceof DailyStopError) throw error;
        if (error instanceof VerificationError) {
          // 只读核验又遇到新的验证码：留在原窗口等人工处理，不关闭会话。
          await this.waitForManualChallenge(session);
          while (!await this.probeManualSession(session)) await this.waitForManualChallenge(session);
          this.markVerificationPassed(jobId, round, identity);
          continue;
        }
        if (!await this.runner.network.handle(error, jobId, stepFrom(row))) throw error;
        await this.runner.network.wait(jobId, () => session.cancelled || session.windowClosed);
        continue;
      }
      await this.assertSession(session);
      if (readback?.state === 'succeeded') { this.completeManualCheckin(jobId, row); continue; }
      // A sign-in already clicked once (review) is only re-probed; the visible
      // window stays open so the user can finish it by hand.  A fresh deferred
      // sign-in gets one automatic click in this same window.
      const clickState = clicks.get(row.step_key) || { count: 0, at: 0 };
      if (clickState.count >= 3 || this.runner.now() - Number(clickState.at || 0) < 10000) {
        await pause(2000);
        continue;
      }
      const elapsed = this.runner.now() - lastSubmitAt;
      if (lastSubmitAt && elapsed < 5000) {
        await pause(Math.min(2000, 5000 - elapsed));
        continue;
      }
      // 页面在等待期间可能又弹出验证码：先切回手动验证，别把这次当成签到点击。
      if (await this.settleChallenge(session, account, jobId, round, identity)) continue;
      clicks.set(row.step_key, { count: clickState.count + 1, at: this.runner.now() });
      // 已提交过的签到要先放回可提交状态，否则 runner 会以「可能已经提交」拒绝再点一次。
      const before = getStepAction(jobId, row.step_key);
      if (before && ['submitted', 'uncertain', 'verification_wait'].includes(before.state)) updateActionLog(before.id, { state: 'prepared', error: '人工验证已通过，正在当前窗口补做签到' });
      const outcome = await this.executeRow(jobId, row, true);
      // 仍没确认成功就恢复待核对，计数不会因为这次尝试消失。
      const after = getStepAction(jobId, row.step_key);
      if (after && after.state === 'prepared') updateActionLog(after.id, { state: 'uncertain', error: after.error || '签到结果仍未确认，请在当前窗口完成' });
      log('info', '人工验证后补做签到：' + (outcome === 'succeeded' ? '成功' : '未确认（' + outcome + '）：' + (getStepAction(jobId, row.step_key)?.error || '')), { accountId: account.id, topicId: topic.id });
      lastSubmitAt = this.runner.now();
      await this.assertSession(session);
      if (getJob(jobId).stopRequested) { this.finalizeStop(jobId, getJob(jobId).cursor.stopReason || '已手动停止'); return; }
      if (outcome === 'verification') {
        const challengeAgain = await this.runner.adapter.hasTaskChallenge?.(account);
        if (challengeAgain) {
          await this.waitForManualChallenge(session);
          while (!await this.probeManualSession(session)) await this.waitForManualChallenge(session);
          this.markVerificationPassed(jobId, round, identity);
        }
      }
      await pause(2000);
    }
  }
  notifyBarrier(jobId, round) {
    try {
      const current = getJob(jobId);
      if (!current || current.cursor?.verificationNotifiedAt) return;
      const cards = db.prepare("SELECT * FROM verification_cards WHERE job_id=? AND round_index=? AND status IN ('pending','requested','validating','ready')").all(jobId, round);
      if (!cards.length) return;
      this.setCursor(jobId, { verificationNotifiedAt: this.time() });
      void notifyVerification(current, { count: cards.length, round }).then(sent => {
        if (sent) log('info', '验证提醒已发送：' + cards.length + ' 个待验证账号', { jobId });
      });
    } catch (error) {
      log('warning', '验证提醒准备失败：' + error.message);
    }
  }


  async assertSession(session) {
    if (session.cancelled || this.session !== session) throw new DailyStopError();
    // Closing the visible tab/window is a deliberate end of this attempt.
    // Do not reopen a second tab: the card will immediately become retryable.
    if (session.windowClosed || session.page?.isClosed?.()) throw new Error(session.closeReason || '验证窗口已关闭，请重新进入验证');
    await this.runner.network.wait(session.jobId, () => session.cancelled || session.windowClosed);
    this.runner.assertMaySubmit(session.jobId);
  }

  async probeManualSession(session) {
    if (session.probePromise) return session.probePromise;
    const probe = async () => {
      await this.assertSession(session);
      let resolved = false;
      try {
        resolved = await this.runner.adapter.isVerificationResolved?.(session.account, { assertRunning: () => {
          if (session.cancelled || this.session !== session) throw new DailyStopError();
          this.runner.assertMaySubmit(session.jobId);
        } });
      } catch (error) {
        if (error instanceof DailyStopError) throw error;
        if (await this.runner.network.handle(error, session.jobId, session.step)) await this.runner.network.wait(session.jobId, () => session.cancelled || session.windowClosed);
        session.probeError = error.message;
      }
      await this.assertSession(session);
      return Boolean(resolved);
    };
    session.probePromise = Promise.resolve().then(() => this.runner.adapter.withChallengeMode
      ? this.runner.adapter.withChallengeMode('manual', probe) : probe());
    try { return await session.probePromise; } finally { session.probePromise = null; }
  }

  async recheckManual(jobId) {
    this.runner.assertMaySubmit(jobId);
    const session = this.session;
    if (!session || session.jobId !== jobId || !session.wake) throw conflict('请先打开验证窗口并等待检测');
    const resolved = await this.probeManualSession(session);
    if (resolved) session.wake?.();
    else this.runner.emitUpdate(this.setCursor(jobId, { manualVerification: { identity: session.identity, phase: 'challenge', message: '仍检测到验证或尚未确认身份，请在 Chrome 完成后重新检测' } }));
    return { ...this.status(getJob(jobId)), detectionResolved: resolved };
  }

  markReady(jobId, round, identity) {
    const card = this.card(jobId, round, identity);
    if (!card) return;
    const signins = this.rows(jobId, round).filter(row => row.identity === identity && row.kind === 'checkin' && row.ever_verification);
    const checkinResult = signins.length ? (signins.every(row => row.outcome === 'succeeded') ? 'succeeded' : 'pending') : 'unknown';
    const remaining = db.prepare("SELECT COUNT(*) n FROM task_step_state WHERE job_id=? AND round_index=? AND identity=? AND state IN ('deferred','running','pending','review','network_review')").get(jobId, round, identity).n;
    const done = checkinResult === 'succeeded' && remaining === 0;
    const reason = done ? '验证与签到已完成' : checkinResult === 'pending' ? '安全验证已通过，签到待补做' : '安全验证已通过';
    db.prepare("UPDATE verification_cards SET status=?,verification_result='passed',verified_at=COALESCE(verified_at,?),checkin_result=?,reason=?,updated_at=? WHERE job_id=? AND round_index=? AND identity=?")
      .run(done ? 'resolved' : 'ready', this.time(), checkinResult, reason, this.time(), jobId, round, identity);
    this.refreshCard(jobId, round, identity);
    this.updateProgress(jobId);
  }

  async recheckRow(jobId, row) {
    const action = getStepAction(jobId, row.step_key); if (!action) return;
    const account = getAccount(row.account_id);
    let result = { state: 'uncertain' };
    if (row.kind === 'comment' && action.url && action.target_id) result = await this.runner.adapter.verifyComment?.(account, { id: action.target_id, url: action.url.split('?')[0] }, action.content, { delays: [0] }) || result;
    else if (row.kind === 'post') result = await this.runner.adapter.verifyPost?.(account, action, { topicName: listTopics().find(topic => topic.id === row.topic_id)?.name }) || result;
    else if (row.kind === 'checkin') result = await this.runner.adapter.verifyCheckin?.(account, listTopics().find(topic => topic.id === row.topic_id)) || result;
    this.runner.assertExecutionAlive();
    this.runner.assertMaySubmit(jobId);
    if (result.state === 'succeeded') {
      updateActionLog(action.id, { state: 'succeeded', url: result.url || action.url, error: '' });
      if (row.kind === 'comment') recordComment(row.account_id, action.target_id, result.url || action.url);
      this.finishStep(jobId, stepFrom(row), 'succeeded');
    }
  }

  async endManual(jobId) {
    const session = this.session;
    if (session?.jobId === jobId) {
      session.cancelled = true; clearTimeout(session.timer); session.wake?.();
      await session.promise;
      await this.runner.adapter.cancelTask?.();
    }
    const job = getJob(jobId);
    if (job?.cursor.manualVerification) this.setCursor(jobId, { manualVerification: null });
    return this.status(getJob(jobId));
  }

  confirmUnpublished(jobId, key) {
    this.runner.assertMaySubmit(jobId);
    if (this.busy() || this.runner.promise) throw conflict('请在任务等待时确认补做');
    const row = db.prepare("SELECT * FROM task_step_state WHERE job_id=? AND step_key=? AND state='review'").get(jobId, key);
    if (!row) throw conflict('该步骤不属于待核对操作');
    const job = getJob(jobId);
    if (['completed', 'stopped'].includes(job.status) || row.round_index !== Number(job.cursor.workflowRound || 0)) throw conflict('只能补做当前未结束轮次的操作');
    const action = getStepAction(jobId, key);
    db.exec('BEGIN IMMEDIATE');
    try {
      updateActionLog(action.id, { state: 'prepared', error: '用户确认未发布，允许补做' });
      db.prepare("UPDATE task_step_state SET state='deferred',outcome=NULL WHERE job_id=? AND step_key=?").run(jobId, key);
      db.prepare("UPDATE verification_cards SET status='ready' WHERE job_id=? AND round_index=? AND identity=? AND status='resolved'").run(jobId, row.round_index, row.identity);
      db.exec('COMMIT');
    } catch (error) { db.exec('ROLLBACK'); throw error; }
    this.updateProgress(jobId);
    return this.status(getJob(jobId));
  }

  continue(jobId) {
    this.runner.assertMaySubmit(jobId);
    const job = getJob(jobId), status = this.status(job);
    if (!status?.canContinue) throw conflict('请先完成全部账号的验证并结束验证会话');
    const round = Number(job.cursor.workflowRound || 0);
    for (const row of this.rows(jobId, round).filter(item => item.kind === 'checkin' && item.state === 'deferred')) {
      const action = getStepAction(jobId, row.step_key);
      if (this.card(jobId, round, row.identity)?.verification_result === 'passed' && ['uncertain','verification_wait'].includes(action?.state)) {
        updateActionLog(action.id, { state: 'prepared', error: '用户点击继续运行，先读取签到状态后补做' });
      }
    }
    const cards = db.prepare('SELECT identity,blocked_kinds_json FROM verification_cards WHERE job_id=? AND round_index=?').all(jobId, round);
    const blocked = new Set();
    for (const card of cards) {
      let kinds = [];
      try { kinds = JSON.parse(card.blocked_kinds_json || '[]'); } catch {}
      for (const kind of kinds) blocked.add(card.identity + '|' + kind);
    }
    const resume = db.prepare("UPDATE task_step_state SET state='pending' WHERE job_id=? AND step_key=?");
    for (const row of db.prepare("SELECT step_key,identity,kind FROM task_step_state WHERE job_id=? AND round_index=? AND state='deferred'").all(jobId, round)) {
      if (blocked.has(row.identity + '|' + row.kind)) resume.run(jobId, row.step_key);
    }
    db.prepare("UPDATE verification_cards SET status='retrying',blocked_kinds_json='[]' WHERE job_id=? AND round_index=? AND status='ready'").run(jobId, round);
    const updated = updateJob(jobId, { status: 'running', pausedByUser: false, waitReason: null, cursor: { ...job.cursor, verificationBarrier: false, workflowPriority: null } });
    this.runner.emitUpdate(updated); this.runner.run(jobId);
    return updated;
  }

  finalizeStop(jobId, reason) {
    resetVerificationNotifications(jobId);
    let job = getJob(jobId); if (!job || job.status === 'stopped') return job;
    this.ensureSteps(job);
    if (this.session?.jobId === jobId) { this.session.cancelled = true; clearTimeout(this.session.timer); this.session.wake?.(); }
    for (const row of db.prepare("SELECT * FROM task_step_state WHERE job_id=? AND state IN ('pending','running','deferred')").all(jobId)) {
      const action = getStepAction(jobId, row.step_key);
      if (['succeeded','failed','skipped'].includes(action?.state)) {
        db.prepare("UPDATE task_step_state SET state='done',outcome=? WHERE job_id=? AND step_key=?").run(action.state, jobId, row.step_key);
      } else if (['submitted','uncertain'].includes(action?.state)) {
        updateActionLog(action.id, { state: 'uncertain', error: `${reason}，提交结果待核对` });
        db.prepare("UPDATE task_step_state SET state='review',outcome='uncertain' WHERE job_id=? AND step_key=?").run(jobId, row.step_key);
        this.runner.confirmSequence(jobId, stepFrom(row));
      } else {
        if (action && !['succeeded','failed','skipped'].includes(action.state)) updateActionLog(action.id, { state: 'cancelled', error: reason });
        this.runner.releaseSequence(jobId, stepFrom(row));
        db.prepare("UPDATE task_step_state SET state='cancelled',outcome=NULL WHERE job_id=? AND step_key=?").run(jobId, row.step_key);
      }
    }
    job = getJob(jobId);
    const updated = updateJob(jobId, { status: 'stopped', stopRequested: true, pausedByUser: false, waitReason: null, metrics: this.metrics(jobId), cursor: { ...job.cursor, stopReason: reason, manualVerification: null, verificationBarrier: false, ...(job.cursor.dailyStop ? { dailyStop: { ...job.cursor.dailyStop, stoppedAt: this.time() } } : {}) } });
    for (const round of runningRounds(jobId)) finishRound(jobId, round, 'stopped');
    this.runner.emitUpdate(updated); void Promise.resolve(this.runner.adapter.cancelTask?.()).catch(() => {});
    return updated;
  }
}
