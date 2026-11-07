import { db, getJob, updateJob, getAccount, listTopics, getStepAction, createActionLog, updateActionLog, recordAccountRestriction, recordComment, recordCheckin, log } from './db.js';
import { shanghaiDate, kindLabel } from './util.js';
import { VerificationError, AuthenticationError, RateLimitError, MutedError, UnsupportedPageError } from './weibo-adapter.js';
import { AccountBusyError } from './account-leases.js';
import { DailyStopError } from './daily-stop.js';
import { NetworkOfflineError } from './network-recovery.js';
import { startRound, runningRounds, finishRound } from './task-reports.js';
import { notifyVerification, resetVerificationNotifications } from './notifications.js';
import { resultMetrics, migrateVerificationPending } from './result-state.js';
import { engageStepCoupling } from './engage.js';

const MANUAL_RECEIPT_TIMEOUT_MS = 30_000;

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
migrateVerificationPending(db);

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
    const engageSteps = nextConfig.kind === 'engage' ? new Map(this.buildSteps(nextConfig).map(step => [stepKey(step), step])) : null;
    const oldSegment = index => oldPlan[index]?.segmentId || `legacy-${index}`;
    const terminalStates = new Set(['done', 'review', 'cancelled']);
    const rows = db.prepare('SELECT * FROM task_step_state WHERE job_id=?').all(job.id);
    let kept = 0, cancelled = 0, added = 0;
    db.exec('SAVEPOINT reconcile_task_plan');
    try {
      for (const row of rows) {
        const segmentId = row.segment_id || oldSegment(row.action_index);
        const proposed = engageSteps?.get(row.step_key);
        const group = engageSteps ? proposed && { type: proposed.kind, count: Infinity, index: proposed.actionIndex } : bySegment.get(segmentId);
        const stillIncluded = group && group.type === row.kind && nextConfig.accountIds.includes(row.account_id) && (nextConfig.kind === 'engage' ? nextConfig.links : nextConfig.topicIds)?.includes(row.topic_id) && row.unit_index < (row.kind === 'checkin' ? Math.min(1, group.count) : group.count);
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
  coupling(job, step) { return engageStepCoupling(job?.config, step); }
  isCompanionRow(job, row) { return Boolean(this.coupling(job, stepFrom(row))?.isCompanion); }
  shouldSkipCompanionOnSchedule(jobId, job, row) {
    const coupling = this.coupling(job, stepFrom(row));
    if (!coupling?.isCompanion) return false;
    const primary = this.row(jobId, coupling.primaryStep);
    return !primary || !['done', 'review'].includes(primary.state);
  }

  mirrorCoupledStep(jobId, step, state, reason) {
    const job = getJob(jobId), coupling = this.coupling(job, step);
    if (!coupling?.isPrimary) return;
    const companion = coupling.companionStep;
    const companionRow = this.row(jobId, companion);
    if (!companionRow || !['pending','deferred','running'].includes(companionRow.state)) return;
    if (companionRow.ever_verification) return;
    const primaryAction = getStepAction(jobId, stepKey(step));
    let companionAction = getStepAction(jobId, stepKey(companion));
    if (!companionAction) {
      createActionLog({
        jobId, stepKey: stepKey(companion), kind: companion.kind, accountId: step.accountId,
        topicId: step.topicId, targetId: primaryAction?.target_id || null, content: primaryAction?.content || null,
        state: 'prepared', url: primaryAction?.url || step.topicId
      });
      companionAction = getStepAction(jobId, stepKey(companion));
    }
    this.finishStep(jobId, companion, state, reason, { mirror: false });
    if (primaryAction && companionAction) updateActionLog(companionAction.id, {
      targetId: primaryAction.target_id, content: primaryAction.content, url: primaryAction.url || step.topicId,
      receiptId: primaryAction.receipt_id, receiptUrl: primaryAction.receipt_url, successSource: primaryAction.success_source
    });
  }

  reconcileCoupledMirrors(jobId, round) {
    const job = getJob(jobId);
    for (const item of this.rows(jobId, round)) {
      if (!item.outcome || !['done','review'].includes(item.state)) continue;
      const coupling = this.coupling(job, stepFrom(item));
      if (coupling?.isPrimary) this.mirrorCoupledStep(jobId, stepFrom(item), item.outcome, getStepAction(jobId, item.step_key)?.error || null);
    }
  }

  textParts(jobId, step, create = null) {
    const row = this.row(jobId, step);
    if (row?.content_parts_json) return JSON.parse(row.content_parts_json);
    if (!create) return null;
    const parts = create();
    db.prepare('UPDATE task_step_state SET content_parts_json=? WHERE job_id=? AND step_key=?').run(JSON.stringify(parts), jobId, stepKey(step));
    return parts;
  }

  metrics(jobId) {
    return resultMetrics(db, jobId, { success: 0, failed: 0, uncertain: 0, skipped: 0 });
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
      db.prepare("UPDATE verification_cards SET status='ready',reason='当前操作已处理，其余操作等待继续运行',updated_at=? WHERE job_id=? AND round_index=? AND identity=?").run(this.time(), jobId, round, identity);
    }
  }

  finishStep(jobId, step, state, reason = null, { mirror = true } = {}) {
    let job = getJob(jobId); if (job.status === 'stopped') return;
    const row = this.row(jobId, step); if (!row) return;
    if (row.state === 'done' && row.outcome === state) {
      if (mirror) this.mirrorCoupledStep(jobId, step, state, reason);
      return;
    }
    const action = getStepAction(jobId, stepKey(step));
    if (['post','comment','repost','like','comment_like'].includes(step.kind) && action?.state === 'succeeded') { state = 'succeeded'; reason = null; }
    if (!action) createActionLog({ jobId, stepKey: stepKey(step), kind: step.kind, accountId: step.accountId, topicId: step.topicId, state, error: reason });
    else if (action.state !== state || reason) updateActionLog(action.id, { state, error: reason || action.error || '' });
    const nextState = state === 'uncertain' && row.ever_verification ? 'review' : 'done';
    db.prepare('UPDATE task_step_state SET state=?,outcome=? WHERE job_id=? AND step_key=?').run(nextState, state, jobId, stepKey(step));
    if (step.kind === 'checkin' && state === 'succeeded' && !this.rows(jobId, step.round).some(item => item.identity === row.identity && item.kind === 'checkin' && item.ever_verification && item.outcome !== 'succeeded')) {
      db.prepare("UPDATE verification_cards SET checkin_result='succeeded' WHERE job_id=? AND round_index=? AND identity=?").run(jobId, step.round, row.identity);
    }
    const fresh = getJob(jobId), zeroOnlyRefreshes = { ...fresh.cursor.zeroOnlyRefreshes }, superlikeSteps = { ...fresh.cursor.superlikeSteps };
    const retryCounters = { ...(fresh.cursor.rateMismatchRetries || {}) };
    if (state === 'succeeded') delete retryCounters[stepKey(step)];
    delete zeroOnlyRefreshes[stepKey(step)]; delete superlikeSteps[stepKey(step)];
    this.setCursor(jobId, { zeroOnlyRefreshes, superlikeSteps, rateMismatchRetries: retryCounters });
    this.refreshCard(jobId, step.round, row.identity);
    this.updateProgress(jobId);
    if (mirror) this.mirrorCoupledStep(jobId, step, state, reason);
  }

  defer(jobId, step, error, { priority = true } = {}) {
    db.exec('BEGIN IMMEDIATE');
    try {
    const job = getJob(jobId), row = this.row(jobId, step);
    const action = getStepAction(jobId, stepKey(step));
    if (['post','comment','repost','like','comment_like'].includes(step.kind) && action?.state === 'succeeded') {
      db.prepare("UPDATE task_step_state SET state='done',outcome='succeeded' WHERE job_id=? AND step_key=?").run(jobId, stepKey(step));
      this.runner.confirmSequence(jobId, step);
      this.refreshCard(jobId, step.round, row.identity);
      this.updateProgress(jobId, { emit: false });
      this.mirrorCoupledStep(jobId, step, 'succeeded', null);
      db.exec('COMMIT');
      this.runner.emitUpdate(getJob(jobId));
      return;
    }
    if (step.kind === 'checkin' && !this.session && error.verificationRequired !== false) this.observeCheckinChallenge(jobId, stepKey(step));
    const submitted = !error.explicitlyUnpublished && (error.submittedUncertain || ['submitted', 'uncertain'].includes(action?.state));
    db.prepare("UPDATE task_step_state SET state='deferred',ever_verification=1 WHERE job_id=? AND round_index=? AND identity=? AND kind=? AND state IN ('pending','running')")
      .run(jobId, step.round, row.identity, step.kind);
    if (submitted) {
      if (action) updateActionLog(action.id, { state: 'uncertain', error: error.message, verificationPending: error.verificationRequired !== false });
      this.runner.confirmSequence(jobId, step);
      db.prepare("UPDATE task_step_state SET state='review',outcome='uncertain' WHERE job_id=? AND step_key=?").run(jobId, stepKey(step));
    } else {
      const preserve = this.runner.workbenchVerification(job) && ['post','comment'].includes(step.kind)
        && action?.submitted_at && action.sequence_number != null;
      if (!preserve) this.runner.releaseSequence(jobId, step);
      else this.runner.confirmSequence(jobId, step);
      if (action) updateActionLog(action.id, { state: 'verification_wait', ...(preserve ? {} : { sequenceNumber: null, sequenceConfirmed: false }), error: error.message, verificationPending: true });
      db.prepare('UPDATE task_step_state SET outcome=NULL WHERE job_id=? AND step_key=?').run(jobId, stepKey(step));
    }
    const coupling = this.coupling(job, step);
    if (coupling?.isPrimary) {
      const companion = coupling.companionStep, companionKey = stepKey(companion);
      let companionAction = getStepAction(jobId, companionKey);
      if (!companionAction) {
        createActionLog({ jobId, stepKey: companionKey, kind: companion.kind, accountId: step.accountId,
          topicId: step.topicId, targetId: action?.target_id || null, content: action?.content || null,
          state: 'prepared', url: action?.url || step.topicId });
        companionAction = getStepAction(jobId, companionKey);
      }
      db.prepare("UPDATE task_step_state SET state='deferred',ever_verification=1,outcome=NULL WHERE job_id=? AND step_key=?")
        .run(jobId, companionKey);
      if (submitted) {
        if (companionAction) updateActionLog(companionAction.id, { state: 'uncertain', error: error.message, verificationPending: error.verificationRequired !== false });
        db.prepare("UPDATE task_step_state SET state='review',outcome='uncertain' WHERE job_id=? AND step_key=?")
          .run(jobId, companionKey);
      } else if (companionAction) {
        updateActionLog(companionAction.id, { state: 'verification_wait', error: error.message, verificationPending: true });
      }
    }
    const previous = this.card(jobId, step.round, row.identity);
    const blocked = [...new Set([...(previous && (this.runner.workbenchVerification(job) || pendingCard(previous.status)) ? JSON.parse(previous.blocked_kinds_json) : []), step.kind, ...(coupling?.isPrimary ? [coupling.companionKind] : [])])];
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
      const blocked = [...new Set([...(this.runner.workbenchVerification(job) && prior ? JSON.parse(prior.blocked_kinds_json) : []), 'checkin'])];
      db.prepare("UPDATE task_step_state SET state='deferred',outcome=NULL,ever_verification=1 WHERE job_id=? AND step_key=?").run(jobId, stepKey(step));
      db.prepare(`INSERT INTO verification_cards(job_id,round_index,identity,account_id,status,blocked_kinds_json,reason,source,triggered_at,updated_at)
        VALUES(?,?,?,?,?,?,?,?,?,?) ON CONFLICT(job_id,round_index,identity) DO UPDATE SET status='pending',reason=excluded.reason,source=excluded.source,updated_at=excluded.updated_at,
        blocked_kinds_json=excluded.blocked_kinds_json,attempts=verification_cards.attempts+1`)
        .run(jobId, step.round, row.identity, step.accountId, 'pending', JSON.stringify(blocked), reason, 'checkin_unconfirmed', this.time(), this.time());
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
    const speaks = ['post', 'comment', 'repost'].includes(row.kind);
    if (active) {
      if (active.type === 'mute') {
        if (speaks) return '账号禁言，暂停发帖/评论/转发：' + active.reason;
      } else if (active.type === 'frequent') {
        return '账号' + kindLabel(row.kind) + '频繁，1 小时内暂停：' + active.reason;
      }
    }
    if (job.cursor.skippedAccountIds?.includes(row.account_id)) return job.cursor.skipReasons?.[row.account_id] || '账号已跳过';
    if (speaks) {
      const mute = job.cursor.muteLimits?.find(item => item.round === row.round_index && item.identity === row.identity);
      if (mute) return '本轮禁言：' + mute.reason;
    }
    const rate = job.cursor.rateLimits?.find(item => item.round === row.round_index && item.identity === row.identity && item.kind === row.kind);
    return rate ? '本轮' + kindLabel(row.kind) + '频繁：' + rate.reason : null;
  }

  disableRestrictedCoupling(jobId, row, step, job) {
    const coupling = this.coupling(job, step);
    if (!coupling?.isPrimary) return false;
    const limited = job.cursor.rateLimits?.find(item => item.round === step.round
      && item.identity === row.identity && item.kind === coupling.companionKind);
    const accountLimit = this.runner.restrictionFor?.(row.account_id, coupling.companionKind, row.identity);
    const card = this.card(jobId, step.round, row.identity);
    const blockedKinds = card && pendingCard(card.status) ? JSON.parse(card.blocked_kinds_json || '[]') : [];
    const verificationBlocked = blockedKinds.includes(coupling.companionKind);
    const rateReason = limited?.reason || (accountLimit?.type === 'frequent' ? accountLimit.reason : '');
    const reason = rateReason || (verificationBlocked ? card.reason || '账号验证待处理' : '');
    if (!reason) return false;
    const fresh = getJob(jobId);
    const disabledCouplings = { ...(fresh.cursor?.disabledCouplings || {}), [stepKey(step)]: coupling.companionKind };
    this.setCursor(jobId, { disabledCouplings });
    const companionRow = this.row(jobId, coupling.companionStep);
    if (companionRow && ['pending','deferred','running'].includes(companionRow.state)) {
      if (rateReason) {
        this.runner.releaseSequence(jobId, coupling.companionStep);
        this.finishStep(jobId, coupling.companionStep, 'skipped', `本轮${kindLabel(coupling.companionKind)}频繁，未执行联动：${reason}`);
      } else {
        db.prepare("UPDATE task_step_state SET state='deferred',ever_verification=1,outcome=NULL WHERE job_id=? AND step_key=?")
          .run(jobId, stepKey(coupling.companionStep));
        const companionAction = getStepAction(jobId, stepKey(coupling.companionStep));
        if (companionAction && !['succeeded','failed','skipped','submitted','uncertain'].includes(companionAction.state)) {
          updateActionLog(companionAction.id, { state: 'verification_wait', error: reason, verificationPending: true });
        }
      }
    }
    return true;
  }

  async handleError(jobId, step, error, options = {}) {
    if (['post','comment','repost','like','comment_like'].includes(step.kind) && getStepAction(jobId, stepKey(step))?.state === 'succeeded') {
      this.finishStep(jobId, step, 'succeeded'); return 'succeeded';
    }
    if (error instanceof DailyStopError || this.runner.isExpired(jobId)) { this.runner.enforceDailyStop(); this.finalizeStop(jobId, '每日 23:59 自动停止'); return; }
    if (error instanceof VerificationError) {
      this.defer(jobId, step, error, options);
      error.jobId = jobId;
      if (!this.session) await this.runner.dismissBackgroundChallenge(error);
      return 'verification';
    }
    const job = getJob(jobId), row = this.row(jobId, step);
    if (error instanceof RateLimitError) {
      const limitedKind = error.kind || step.kind;
      const label = kindLabel(limitedKind);
      const coupling = this.coupling(job, step);
      const currentAction = getStepAction(jobId, stepKey(step));
      const submitted = Boolean(currentAction?.submitted_at) || ['submitted', 'uncertain'].includes(currentAction?.state);
      const currentAffected = limitedKind === step.kind;
      const companionAffected = Boolean(coupling?.isPrimary && limitedKind === coupling.companionKind);
      const limits = [...(job.cursor.rateLimits || [])];
      if (!limits.some(item => item.identity === row.identity && item.round === step.round && item.kind === limitedKind)) {
        limits.push({ identity: row.identity, round: step.round, accountId: step.accountId, kind: limitedKind, reason: error.message, at: this.time() });
      }
      this.setCursor(jobId, { rateLimits: limits, notice: `本轮${label}频繁，仅跳过后续${label}：${error.message}` });
      recordAccountRestriction({ accountId: step.accountId, identity: row.identity, type: 'frequent', kind: limitedKind, reason: error.message, detectedAt: this.time(), expiresAt: new Date(this.runner.now() + 60 * 60 * 1000).toISOString(), jobId });
      this.runner.accountRestrictionsAt = 0;
      for (const pending of this.rows(jobId, step.round).filter(item => item.identity === row.identity && item.kind === limitedKind && ['pending','deferred'].includes(item.state))) {
        if (pending.step_key === stepKey(step)) continue;
        const action = getStepAction(jobId, pending.step_key);
        if (action && ['submitted','uncertain'].includes(action.state)) continue;
        this.runner.releaseSequence(jobId, stepFrom(pending));
        this.finishStep(jobId, stepFrom(pending), 'skipped', `本轮${label}频繁：${error.message}`);
      }
      if (!currentAffected && !submitted) {
        const freshJob = getJob(jobId);
        const retries = { ...(freshJob.cursor?.rateMismatchRetries || {}) };
        const retryKey = stepKey(step);
        if (Number(retries[retryKey] || 0) >= 1) {
          this.finishStep(jobId, step, 'skipped', `频繁提示为${label}，当前${kindLabel(step.kind)}未提交，已跳过当前步骤：${error.message}`);
          return 'skipped';
        }
        retries[retryKey] = Number(retries[retryKey] || 0) + 1;
        if (currentAction && !['succeeded','submitted','uncertain'].includes(currentAction.state)) {
          updateActionLog(currentAction.id, { state: 'prepared', error: '', verificationPending: 0 });
        }
        db.prepare("UPDATE task_step_state SET state='pending',outcome=NULL WHERE job_id=? AND step_key=?").run(jobId, stepKey(step));
        const cursorPatch = { rateMismatchRetries: retries };
        if (companionAffected && coupling?.isPrimary && error.rejected) {
          cursorPatch.disabledCouplings = { ...(freshJob.cursor?.disabledCouplings || {}), [retryKey]: limitedKind };
        }
        this.setCursor(jobId, cursorPatch);
        log('warning', `本轮${label}频繁，继续执行${kindLabel(step.kind)}：${error.message}`, { accountId: step.accountId, topicId: step.topicId, jobId });
        return 'retry';
      }
      const outcome = submitted ? 'uncertain' : error.rejected ? 'skipped' : 'uncertain';
      this.finishStep(jobId, step, outcome, error.message);
      log('warning', `本轮${label}频繁，仅跳过后续${label}：${error.message}`, { accountId: step.accountId, topicId: step.topicId, jobId });
      return outcome;
    }
    if (error instanceof MutedError) {
      const limits = [...(job.cursor.muteLimits || [])];
      if (!limits.some(item => item.identity === row.identity && item.round === step.round)) limits.push({ identity: row.identity, round: step.round, accountId: step.accountId, kind: step.kind, reason: error.message, at: this.time() });
      this.setCursor(jobId, { muteLimits: limits });
      if (this.runner.scope) recordAccountRestriction({ accountId: step.accountId, identity: row.identity, type: 'mute', reason: error.message, detectedAt: this.time(), expiresAt: new Date(this.runner.now() + 24 * 3600000).toISOString(), jobId });
      this.finishStep(jobId, step, error.rejected ? 'failed' : 'uncertain', error.message);
    } else if (error instanceof AuthenticationError) {
      this.setCursor(jobId, { skippedAccountIds: [...new Set([...(job.cursor.skippedAccountIds || []), step.accountId])], skipReasons: { ...job.cursor.skipReasons, [step.accountId]: `登录失效或UID不符：${error.message}` } });
      this.finishStep(jobId, step, 'failed', error.message);
    } else this.finishStep(jobId, step, 'failed', error.message || String(error));
    log('warning', error.message || String(error), { accountId: step.accountId, topicId: step.topicId });
  }

  async executeRow(jobId, row, manual = false) {
    if (manual && this.session?.jobId === jobId) this.session.step = stepFrom(row);
    const step = stepFrom(row), job = getJob(jobId), account = getAccount(step.accountId);
    const isEngage = job.config.kind === 'engage';
    const topic = isEngage ? { id: null, url: step.topicId, name: '指定微博' } : listTopics().find(item => item.id === step.topicId);
    const reason = this.restriction(job, row);
    if (reason || !account || (!isEngage && !topic)) { this.finishStep(jobId, step, reason ? 'skipped' : 'failed', reason || (isEngage ? '账号或链接已不存在' : '账号或超话不存在')); return; }
    if (isEngage) this.disableRestrictedCoupling(jobId, row, step, job);
    db.prepare("UPDATE task_step_state SET state='running',attempts=attempts+1 WHERE job_id=? AND step_key=?").run(jobId, row.step_key);
    this.setCursor(jobId, { current: { ...step, accountName: account.name, topicName: topic?.name || (isEngage ? step.topicId : '') }, workflowActiveStep: step });
    try {
      const operation = async () => {
        if (isEngage && !await this.runner.network.probe(getJob(jobId))) { this.runner.network.pause(jobId, step); throw new NetworkOfflineError(); }
        await this.runner.ensureStepIdentity(job, account);
        this.runner.assertMaySubmit(jobId);
        return this.runner.execute(getJob(jobId), step, account, topic, { reuseVisiblePage: manual && step.kind === 'checkin' });
      };
      const result = await this.runner.withAccountLease(job, account, () => this.runner.withDailyDeadline(job, step, () => this.runner.adapter.withChallengeMode ? this.runner.adapter.withChallengeMode(manual ? 'manual' : 'background', operation) : operation()), {step,manual});
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
      if (error.code === 'engage_interrupted' && this.runner.groupedEngage(job) && !getStepAction(jobId,row.step_key)?.submitted_at) {
        db.prepare("UPDATE task_step_state SET state='pending',outcome=NULL WHERE job_id=? AND step_key=?").run(jobId,row.step_key);
        return 'waiting';
      }
      if (error instanceof AccountBusyError || error?.code === 'account_busy' || (this.runner.leases && error?.constructor?.name === 'BrowserBusyError')) {
        db.prepare("UPDATE task_step_state SET state='pending',outcome=NULL,attempts=MAX(0,attempts-1) WHERE job_id=? AND step_key=?").run(jobId, row.step_key);
        const current = getJob(jobId);
        const postponedAccounts = { ...(current.cursor?.postponedAccounts || {}) };
        postponedAccounts[row.identity] = {
          until: new Date(this.runner.now() + 5000).toISOString(),
          reason: '较早触发的任务正在使用该账号',
          accountId: row.account_id
        };
        this.setCursor(jobId, { postponedAccounts,
          notice: '该账号由较早任务使用，已临时跳过，稍后自动补做' });
        log('info', '同账号操作冲突：保留较早任务，当前账号临时推迟', {
          jobId, accountId: row.account_id, topicId: row.topic_id });
        return 'postponed';
      }
      if (['post','comment','repost','like','comment_like'].includes(step.kind) && getStepAction(jobId, row.step_key)?.state === 'succeeded' && getJob(jobId)?.status !== 'stopped') {
        this.runner.confirmSequence(jobId, step);
        this.finishStep(jobId, step, 'succeeded');
        return 'succeeded';
      }
      if (await this.runner.navigation.handle(error, jobId, step)) {
        if (manual) {
          await this.runner.navigation.wait(jobId, () => this.session?.cancelled || this.session?.windowClosed);
          if (getJob(jobId).cursor.navigationRecovery?.state === 'human_required') return 'verification';
        }
        return 'navigation';
      }
      if (await this.runner.network.handle(error, jobId, step)) {
        if (manual) { await this.runner.network.wait(jobId, () => this.session?.cancelled || this.session?.windowClosed); return 'network'; }
        return 'network';
      }
      if (manual && step.kind === 'post' && error instanceof UnsupportedPageError
        && !getStepAction(jobId, row.step_key)?.submitted_at) {
        const action = getStepAction(jobId, row.step_key);
        const reason = `人工验证已通过，但发帖未发送，可安全重试：${error.message}`;
        if (action) updateActionLog(action.id, { state: 'verification_wait', verificationPending: true, error: reason });
        db.prepare("UPDATE task_step_state SET state='deferred',outcome=NULL WHERE job_id=? AND step_key=?").run(jobId, row.step_key);
        this.setCursor(jobId, { notice: reason });
        return 'manual_retry_needed';
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
      this.reconcileCoupledMirrors(jobId, round);
      const blockedIdentities = this.blockingIdentitySet(jobId, round);
      const scheduleJob = getJob(jobId), postponedAccounts = scheduleJob.cursor.postponedAccounts || {};
      const postponedIdentities = new Set(Object.entries(postponedAccounts)
        .filter(([, value]) => Date.parse(value?.until) > this.runner.now())
        .map(([identity]) => identity));
      let rows = this.rows(jobId, round);
      for (const row of rows) if (!blockedIdentities.has(row.identity) && ['pending', 'deferred'].includes(row.state)) {
        const reason = this.restriction(getJob(jobId), row);
        if (reason) this.finishStep(jobId, stepFrom(row), 'skipped', reason);
      }
      rows = this.rows(jobId, round);
      const priorityJob = getJob(jobId), priorityIdentities = [...(priorityJob.cursor.workflowPriorityIdentities || [])];
      const priorityIdentity = priorityJob.cursor.workflowPriorityIdentity;
      const priority = priorityJob.cursor.workflowPriority;
      let row = null;
      while (!row && priorityIdentities.length) {
        const identity = priorityIdentities[0];
        row = !blockedIdentities.has(identity) && !postponedIdentities.has(identity) ? rows.find(item => item.state === 'pending' && item.identity === identity
          && !this.shouldSkipCompanionOnSchedule(jobId, priorityJob, item)) : null;
        if (row || !rows.some(item => item.identity === identity && item.state === 'pending')) {
          priorityIdentities.shift();
          this.setCursor(jobId, { workflowPriorityIdentities: [...priorityIdentities] });
        } else break;
      }
      row ||= priorityIdentity ? rows.find(item => item.state === 'pending' && item.identity === priorityIdentity
        && !blockedIdentities.has(item.identity) && !postponedIdentities.has(item.identity)
        && !this.shouldSkipCompanionOnSchedule(jobId, priorityJob, item)) : null;
      if (!row && priorityIdentity && !rows.some(item => item.identity === priorityIdentity && item.state === 'pending')) {
        this.setCursor(jobId, { workflowPriorityIdentity: null });
      }
      row ||= priority ? rows.find(item => item.state === 'pending' && item.identity === priority.identity
        && item.topic_id === priority.topicId && !this.shouldSkipCompanionOnSchedule(jobId, getJob(jobId), item)) : null;
      if (!row && priority) this.setCursor(jobId, { workflowPriority: null });
      row ||= rows.find(item => item.state === 'pending' && !blockedIdentities.has(item.identity)
        && !postponedIdentities.has(item.identity)
        && !this.shouldSkipCompanionOnSchedule(jobId, getJob(jobId), item));
      if (!row) {
        const postponedRows = rows.filter(item => item.state === 'pending' && postponedIdentities.has(item.identity));
        if (postponedRows.length) {
          const nextCheck = Math.min(...postponedRows.map(item => {
            const at = Date.parse(postponedAccounts[item.identity]?.until);
            return Number.isFinite(at) ? at : this.runner.now() + 5000;
          }));
          const accountName = getAccount(postponedRows[0].account_id)?.name || postponedRows[0].identity;
          updateJob(jobId, { status: 'waiting', waitReason: `等待较早任务释放账号 ${accountName}` });
          this.runner.emitUpdate(getJob(jobId));
          if (!await this.runner.interruptibleWait(jobId, Math.max(250, nextCheck - this.runner.now()), `等待较早任务释放账号 ${accountName}`)) continue;
          const fresh = getJob(jobId), still = { ...(fresh.cursor.postponedAccounts || {}) };
          for (const [identity, value] of Object.entries(still)) {
            if (Date.parse(value?.until) <= this.runner.now()) delete still[identity];
          }
          this.setCursor(jobId, { postponedAccounts: still });
          updateJob(jobId, { status: 'running', waitReason: null });
          continue;
        }
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
      await this.runner.finishEngageGroupIfNeeded(jobId, row, outcome);
      if (getJob(jobId).status === 'stopped') return;
      if (outcome && !['verification', 'waiting', 'postponed', 'skipped', 'network', 'navigation'].includes(outcome)) {
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
    this.reconcileCoupledMirrors(jobId, Math.min(Number(job.cursor.workflowRound || 0), Math.max(0, Number(job.config.rounds || 1) - 1)));
    for (const row of db.prepare("SELECT * FROM task_step_state WHERE job_id=? AND state='running'").all(jobId)) {
      const action = getStepAction(jobId, row.step_key);
      if (['succeeded','failed','skipped'].includes(action?.state)) this.finishStep(jobId, stepFrom(row), action.state, action.error);
      else if (['submitted', 'uncertain'].includes(action?.state)) {
        const error = new VerificationError('中断时提交结果未知，请先只读复核'); error.submittedUncertain = true;
        error.verificationRequired = Boolean(action.verification_pending);
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

  restoreRejectedWorkbenchPosts(jobId) {
    const job = getJob(jobId);
    if (!this.runner.workbenchVerification(job) || !['waiting','paused'].includes(job.status)
      || !job.cursor.verificationBarrier || job.cursor.manualVerification || this.session || this.runner.promise
      || this.runner.isExpired(jobId) || job.stopRequested) return 0;
    const round = Number(job.cursor.workflowRound || 0);
    const candidates = db.prepare(`SELECT s.identity, s.step_key, a.id, a.attempt_id, a.submitted_at
      FROM task_step_state s JOIN action_logs a ON a.job_id=s.job_id AND a.step_key=s.step_key
      JOIN verification_cards v ON v.job_id=s.job_id AND v.round_index=s.round_index AND v.identity=s.identity
      WHERE s.job_id=? AND s.round_index=? AND s.kind='post' AND s.state='review' AND s.attempts=1
        AND a.state='uncertain' AND a.submitted_at IS NOT NULL AND a.attempt_id IS NOT NULL
        AND a.receipt_id IS NULL AND a.receipt_url IS NULL AND a.success_source IS NULL
        AND v.status IN ('pending','ready')`).all(jobId, round);
    if (!candidates.length) return 0;
    const byAttempt = new Map(candidates.map(row => [row.attempt_id, { row, events: [] }]));
    const since = candidates.map(row => row.submitted_at).sort()[0];
    for (const entry of db.prepare("SELECT message,created_at FROM system_logs WHERE created_at>=? AND message LIKE '发帖回执：{%'").iterate(since)) {
      let event;
      try { event = JSON.parse(entry.message.slice('发帖回执：'.length)); } catch { continue; }
      const match = byAttempt.get(event?.attemptId);
      if (match && entry.created_at >= match.row.submitted_at) match.events.push(event);
    }
    let restored = 0;
    db.exec('BEGIN IMMEDIATE');
    try {
      for (const { row, events } of byAttempt.values()) {
        if (events.length !== 1) continue;
        const [event] = events;
        if (event.actionId !== row.id || event.path !== '/ajax/statuses/update' || event.httpStatus !== 400
          || event.code !== '20067' || event.kind !== 'verification' || event.message !== 'Response classified') continue;
        const reason = '已确认原发帖被安全验证拦截，请点击验证触发原动作';
        const card = this.card(jobId, round, row.identity);
        const blocked = [...new Set([...JSON.parse(card.blocked_kinds_json), 'post'])];
        updateActionLog(row.id, { state: 'verification_wait', verificationPending: true, error: reason });
        db.prepare("UPDATE task_step_state SET state='deferred',outcome=NULL WHERE job_id=? AND step_key=?").run(jobId, row.step_key);
        db.prepare("UPDATE verification_cards SET status='pending',verification_result='pending',verified_at=NULL,blocked_kinds_json=?,reason=?,updated_at=? WHERE job_id=? AND round_index=? AND identity=?")
          .run(JSON.stringify(blocked), reason, this.time(), jobId, round, row.identity);
        restored++;
      }
      if (restored) {
        log('info', '工作台已恢复有明确验证拦截回执的发帖卡片 ' + restored + ' 项');
        this.updateProgress(jobId, { emit: false });
      }
      db.exec('COMMIT');
    } catch (error) { db.exec('ROLLBACK'); throw error; }
    if (restored) this.runner.emitUpdate(getJob(jobId));
    return restored;
  }

  status(job) {
    job = this.recoverOrphanedManual(job);
    if (!this.enabled(job)) return null;
    job = this.repairMisclassifiedManualPosts(job);
    job = this.repairTransientPostSetupFailures(job);
    const round = Math.min(Number(job.cursor.workflowRound || 0), Math.max(0, Number(job.config.rounds || 1) - 1));
    const cards = db.prepare('SELECT * FROM verification_cards WHERE job_id=? AND round_index=? ORDER BY triggered_at').all(job.id, round).map(card => {
      const account = job.config.accountIdentities?.[card.account_id] || getAccount(card.account_id) || {};
      const allIdentityRows = this.rows(job.id, round).filter(row => row.identity === card.identity);
      const identityRows = allIdentityRows.filter(row => !this.isCompanionRow(job, row));
      const steps = identityRows.map(row => {
        const action = getStepAction(job.id, row.step_key);
        return { key: row.step_key, kind: row.kind, topicId: row.topic_id, topicName: job.config.topicIdentities?.[row.topic_id]?.name || listTopics().find(topic => topic.id === row.topic_id)?.name || row.topic_id,
          state: row.state, outcome: row.outcome, actionId: action?.id || null, needsReview: row.state === 'review',
          verificationPending: Boolean(action?.verification_pending), reason: action?.error || '' };
      });
      const remainingStepCount = allIdentityRows.filter(row => ['deferred','running','pending','review','network_review'].includes(row.state)).length;
      const remainingCheckins = identityRows.filter(row => row.kind === 'checkin' && row.ever_verification && ['deferred','running','pending','review','network_review'].includes(row.state)).length;
      const visible = card.status !== 'resolved' && !(card.checkin_result === 'succeeded' && remainingStepCount === 0);
      const currentStep = this.manualRow(job.id, round, card.identity);
      const currentActionable = Boolean(currentStep && (getStepAction(job.id, currentStep.step_key)?.verification_pending || ['review','network_review'].includes(currentStep.state) || getStepAction(job.id, currentStep.step_key)?.error === '用户确认未发布，允许补做'));
      // A grouped engage card may be opened while the mainline is running.
      // requestManual first moves the mainline to a safe paused state, so the
      // old "barrier only" gate would make mid-run verification impossible.
      const manualAvailable = !this.session && !job.cursor.manualVerification;
      return { currentActionable, canOpen: currentActionable && manualAvailable, currentStepKey: currentStep?.step_key || null, currentKind: currentStep?.kind || null, identity: card.identity, accountId: card.account_id, name: account.name || account.nickname || card.account_id, uid: account.uid || '', status: card.status, reason: card.reason, source: card.source || 'verification_detected', attempts: card.attempts, verificationResult: card.verification_result, verifiedAt: card.verified_at, triggeredAt: card.triggered_at, checkinResult: card.checkin_result, remainingStepCount, remainingCheckins, visible, steps };
    });
    return { jobId: job.id, round, jobStatus: job.status, cards, session: job.cursor.manualVerification || null, barrier: Boolean(job.cursor.verificationBarrier),
      mainlineBusy: Boolean(this.runner.promise || this.runner.currentExecution),
      canContinue: !['completed','stopped'].includes(job.status) && !this.runner.isExpired(job.id) && !this.runner.promise && job.cursor.networkRecovery?.state !== 'offline' && !this.session && !job.cursor.manualVerification,
      stepCounts: db.prepare('SELECT state,COUNT(*) count FROM task_step_state WHERE job_id=? GROUP BY state').all(job.id) };
  }

  blockingIdentitySet(jobId, round) {
    return new Set(db.prepare(`SELECT identity FROM verification_cards
      WHERE job_id=? AND round_index=?
        AND (verification_result<>'passed' OR status IN ('pending','requested','validating'))`)
      .all(jobId, round).map(card => card.identity));
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

  repairMisclassifiedManualPosts(job) {
    if (!this.runner.workbenchVerification(job) || this.session || job.cursor?.manualVerification
      || this.runner.promise || this.runner.currentExecution || job.stopRequested) return job;
    const round = Number(job.cursor.workflowRound || 0);
    const rows = db.prepare(`SELECT vc.identity, vc.account_id, vc.round_index, s.step_key, a.id action_id, a.error
      FROM verification_cards vc
      JOIN task_step_state s ON s.job_id=vc.job_id AND s.round_index=vc.round_index
        AND s.identity=vc.identity AND s.kind='post' AND s.ever_verification=1
      JOIN action_logs a ON a.job_id=s.job_id AND a.step_key=s.step_key
      WHERE vc.job_id=? AND vc.round_index=? AND vc.status='ready' AND vc.verification_result='passed'
        AND a.state='failed' AND a.submitted_at IS NULL`).all(job.id, round);
    if (!rows.length) return job;
    const marker = '人工验证已通过，但发帖未发送，允许安全重试';
    let repaired = 0;
    db.exec('BEGIN IMMEDIATE');
    try {
      for (const row of rows) {
        const reason = `${marker}：${row.error || '发帖准备失败'}`;
        updateActionLog(row.action_id, { state: 'verification_wait', verificationPending: true,
          completedAt: null, error: reason });
        db.prepare("UPDATE task_step_state SET state='deferred',outcome=NULL WHERE job_id=? AND step_key=?").run(job.id, row.step_key);
        db.prepare("UPDATE verification_cards SET reason=?,updated_at=? WHERE job_id=? AND round_index=? AND identity=?")
          .run(reason, this.time(), job.id, row.round_index, row.identity);
        repaired += 1;
      }
      const fresh = getJob(job.id);
      updateJob(job.id, { metrics: { ...fresh.metrics,
        failed: Math.max(0, Number(fresh.metrics.failed || 0) - repaired) } });
      db.exec('COMMIT');
    } catch (error) { db.exec('ROLLBACK'); throw error; }
    log('info', `已恢复 ${repaired} 条人工验证后未发送的安全可重试发帖`, { jobId: job.id });
    return getJob(job.id);
  }

  repairTransientPostSetupFailures(job) {
    if (!this.runner.workbenchVerification(job) || this.session || job.cursor?.manualVerification
      || this.runner.promise || this.runner.currentExecution || job.stopRequested) return job;
    const rows = db.prepare(`SELECT s.step_key,a.id action_id,a.error
      FROM action_logs a JOIN task_step_state s ON s.job_id=a.job_id AND s.step_key=a.step_key
      WHERE a.job_id=? AND a.kind='post' AND a.state='failed' AND a.submitted_at IS NULL
        AND (a.error LIKE '%同步到微博%' OR a.error LIKE '无法确认主页同步设置，未发送%')`).all(job.id);
    if (!rows.length) return job;
    let repaired = 0;
    db.exec('BEGIN IMMEDIATE');
    try {
      for (const row of rows) {
        updateActionLog(row.action_id, { state: 'prepared', verificationPending: false,
          completedAt: null, error: '同步到微博选项临时失败，已按安全点击逻辑恢复待执行' });
        db.prepare("UPDATE task_step_state SET state='pending',outcome=NULL WHERE job_id=? AND step_key=?").run(job.id, row.step_key);
        repaired += 1;
      }
      const fresh = getJob(job.id);
      updateJob(job.id, { metrics: { ...fresh.metrics,
        failed: Math.max(0, Number(fresh.metrics.failed || 0) - repaired) } });
      db.exec('COMMIT');
    } catch (error) { db.exec('ROLLBACK'); throw error; }
    log('info', `已恢复 ${repaired} 条同步选项临时失败的安全待执行发帖`, { jobId: job.id });
    return getJob(job.id);
  }

  requestManual(jobId, identity, requestedStepKey = '') {
    this.runner.assertMaySubmit(jobId);
    const job = getJob(jobId);
    if (!this.enabled(job) || ['completed', 'stopped'].includes(job.status)) throw conflict('当前任务不能进入验证');
    this.ensureSteps(job);
    const card = this.card(jobId, Number(job.cursor.workflowRound || 0), identity);
    if (!card) throw conflict('找不到待验证账号');
    if (this.busy()) throw conflict('请先结束当前账号的验证');
    const row = this.manualRow(jobId, Number(job.cursor.workflowRound || 0), identity, requestedStepKey);
    if (!row) throw conflict('该账号没有可验证的当前操作');
    const action = getStepAction(jobId, row.step_key);
    if (card.status === 'ready' && card.verification_result === 'passed'
      && !action?.verification_pending && row.state !== 'review' && row.state !== 'network_review' && action?.error !== '用户确认未发布，允许补做') throw conflict('本次验证已完成，其余操作请点击继续运行');
    if (this.runner.leases) {
      try { this.manualRelease = this.runner.leases.acquire(getAccount(row.account_id), this.runner.scope || jobId); }
      catch { throw conflict('该账号正在另一任务中操作，请稍后进入验证'); }
    }
    // Opening a verification card always pauses this page's mainline first.
    // The selected account may then perform exactly the challenged operation,
    // while other accounts and operation types wait for an explicit continue.
    const autoPause = !job.pausedByUser;
    const cursor = { ...job.cursor,
      manualVerification: { identity, stepKey: row.step_key, kind: row.kind, phase: 'requested', requestedAt: this.time() },
      verificationAutoPaused: autoPause,
      verificationPauseReason: autoPause ? 'manual_from_card' : null
    };
    const patch = { cursor };
    if (autoPause) Object.assign(patch, { status: 'paused', pausedByUser: false, waitReason: '已暂停主线，等待手动验证' });
    this.runner.emitUpdate(updateJob(jobId, patch));
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
      if (this.runner.currentExecution || (this.runner.groupedEngage(job) && this.runner.promise)) {
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
    const selected = getJob(jobId).cursor.manualVerification;
    const session = { jobId, identity, stepKey: selected?.stepKey, cancelled: false, submitted: false, timer: null, windowClosed: false };
    this.session = session;
    const operation = async () => {
      if (this.runner.groupedEngage(getJob(jobId))) await this.runner.releaseEngageSession();
      return this.manualOperation(session);
    };
    session.promise = Promise.resolve().then(() => this.runner.adapter.withChallengeMode
      ? this.runner.adapter.withChallengeMode('manual', operation) : operation()).catch(error => {
      if (!(error instanceof DailyStopError) && getJob(jobId)?.status !== 'stopped') {
        if (error.code === 'receipt_persistence_failed') {
          const action = getStepAction(jobId, session.stepKey);
          if (action?.state !== 'succeeded') {
            if (action) updateActionLog(action.id, { state: 'uncertain', verificationPending: false, error: error.message });
            db.prepare("UPDATE task_step_state SET state='review',outcome='uncertain' WHERE job_id=? AND step_key=?").run(jobId, session.stepKey);
          }
          db.prepare("UPDATE verification_cards SET status='ready',verification_result='passed',reason=?,updated_at=? WHERE job_id=? AND identity=? AND round_index=?")
            .run('已经观察到成功提示，保存异常，已暂停且禁止重发', this.time(), jobId, identity, getJob(jobId).cursor.workflowRound || 0);
          updateJob(jobId, { status: 'paused', pausedByUser: true, waitReason: error.message });
          this.updateProgress(jobId);
          return;
        }
        const job = getJob(jobId);
        const message = `无法打开或保持验证窗口：${error.message}`;
        session.closeReason = message;
        db.prepare("UPDATE verification_cards SET status='pending',reason=?,updated_at=? WHERE job_id=? AND round_index=? AND identity=?").run(message, this.time(), jobId, job.cursor.workflowRound || 0, identity);
        log('warning', message, { accountId: this.card(jobId, Number(job.cursor.workflowRound || 0), identity)?.account_id });
      }
    }).finally(async () => {
      clearTimeout(session.timer);
      if (this.session !== session) return;
      const closeReason = session.closeReason || (session.cancelled ? '用户结束验证' : '当前验证步骤已收尾');
      log('info', `人工验证窗口关闭：${closeReason}`, { jobId, accountId: session.account?.id, topicId: session.topic?.id });
      await Promise.resolve(this.runner.adapter.closeManual?.(session.browserContext)).catch(() => {});
      this.session = null;
      this.manualRelease?.(); this.manualRelease = null;
      const job = getJob(jobId);
      if (job?.status !== 'stopped') {
        if (session.cancelled) db.prepare("UPDATE verification_cards SET status='pending',reason='验证会话已结束，请再次进入完成验证' WHERE job_id=? AND identity=? AND status='validating'").run(jobId, identity);
        const cursor = { ...getJob(jobId).cursor, manualVerification: null,
          verificationAutoPaused: false, verificationPauseReason: null,
          verificationBarrier: true };
        const updated = job.pausedByUser
          ? updateJob(jobId, { waitReason: '验证已结束，请点击继续运行', cursor })
          : updateJob(jobId, { status: 'waiting', pausedByUser: false,
              waitReason: '验证已结束，请点击继续运行', cursor });
        this.runner.emitUpdate(updated);
      }
      // The visible browser belongs exclusively to this manual session.  Do
      // not leave it minimized in the Dock after the user ends verification.
    });
  }

  manualRow(jobId, round, identity, requestedStepKey = '') {
    const job = getJob(jobId);
    const candidates = this.rows(jobId, round).filter(row => row.identity === identity && !this.isCompanionRow(job, row)
      && row.ever_verification && ['deferred','review','network_review'].includes(row.state));
    // Prefer an actually challenged operation over unattempted remaining counts.
    const awaiting = candidates.filter(row => getStepAction(jobId, row.step_key)?.verification_pending);
    const actionable = candidates.filter(row => getStepAction(jobId, row.step_key));
    if (this.runner.workbenchVerification(getJob(jobId))) {
      const eligible = actionable.filter(row => {
        const action = getStepAction(jobId, row.step_key);
        return (row.kind === 'checkin' && action.state === 'uncertain') || action.verification_pending || ['review','network_review'].includes(row.state)
          || action.error === '用户确认未发布，允许补做';
      });
      return requestedStepKey ? eligible.find(row => row.step_key === requestedStepKey) : awaiting[0] || eligible[0];
    }
    return requestedStepKey ? candidates.find(row => row.step_key === requestedStepKey) : awaiting[0] || actionable[0] || candidates[0];
  }

  manualPhase(session, phase, extra = {}) {
    if (session.lastLoggedPhase !== phase) {
      session.lastLoggedPhase = phase;
      log('info', `人工验证阶段：${phase}`, { jobId: session.jobId, accountId: session.account?.id, topicId: session.topic?.id });
    }
    this.runner.emitUpdate(this.setCursor(session.jobId, { manualVerification: {
      identity: session.identity, stepKey: session.stepKey, kind: session.step?.kind, phase, ...extra } }));
  }

  async manualOperation(session) {
    const { jobId, identity } = session;
    this.runner.assertMaySubmit(jobId);
    let job = getJob(jobId), round = Number(job.cursor.workflowRound || 0);
    let row = this.manualRow(jobId, round, identity, session.stepKey);
    if (!row) throw conflict('选中的待验证操作已发生变化');
    session.stepKey = row.step_key; session.step = stepFrom(row);
    db.prepare("UPDATE verification_cards SET status='validating',updated_at=? WHERE job_id=? AND round_index=? AND identity=?").run(this.time(), jobId, round, identity);
    updateJob(jobId, { status: 'waiting', waitReason: '正在手动验证当前' + kindLabel(row.kind) });
    this.manualPhase(session, 'validating');
    const account = getAccount(row.account_id), topic = job.config.kind === 'engage' ? { url: row.topic_id, name: '指定微博' } : listTopics().find(topic => topic.id === row.topic_id);
    let action = getStepAction(jobId, row.step_key);
    session.page = await this.runner.adapter.openVerification?.(account, topic, action);
    session.browserContext = session.page?.context?.();
    session.account = account; session.topic = topic; session.action = action;
    session.page?.once?.('close', () => {
      if (this.session !== session) return;
      session.windowClosed = true; session.closeReason = '验证窗口已关闭，请重新进入验证'; session.wake?.();
    });
    await this.assertSession(session);
    const continuation = this.runner.adapter.currentSubmission?.(action);
    if (continuation && continuation.page === session.page && action?.submitted_at) {
      session.submitted = true; session.attemptId = action.attempt_id;
    }
    // A cleared captcha is not proof that a submitted operation failed.
    // Only an unsubmitted verification_wait action may be prepared here.
    if (['post','comment','repost','like','comment_like'].includes(row.kind) && !session.submitted && action?.state === 'verification_wait') {
      updateActionLog(action.id, { state: 'prepared' });
    }
    let challenge = Boolean(await this.runner.adapter.hasTaskChallenge?.(account));
    while (challenge) {
      await this.waitForManualChallenge(session);
      challenge = !await this.probeManualSession(session);
    }
    await this.assertSession(session);
    if (row.kind === 'checkin') {
      this.markVerificationPassed(jobId, round, identity);
      await this.completeManualCheckins(session, account, round, identity);
    } else if (['review','network_review'].includes(row.state) && !session.submitted) {
      const rechecked = await this.recheckRow(jobId, row);
      if (row.kind === 'comment_like' && rechecked?.notLiked && !session.submitted) {
        const action = getStepAction(jobId, row.step_key);
        if (action) updateActionLog(action.id, { state: 'prepared', submittedAt: null,
          verificationPending: false, completedAt: null, error: '人工验证后确认原评论未赞，补点同一目标一次' });
        db.prepare("UPDATE task_step_state SET state='deferred',outcome=NULL WHERE job_id=? AND step_key=?").run(jobId, row.step_key);
        const outcome = await this.executeRow(jobId, this.row(jobId, session.step), true);
        await this.assertSession(session);
        if (outcome === 'verification') {
          do { await this.waitForManualChallenge(session); } while (!await this.probeManualSession(session));
        }
        const fresh = getStepAction(jobId, row.step_key);
        if (fresh?.state === 'succeeded') this.finishStep(jobId, session.step, 'succeeded');
        else if (session.submitted && !['failed','skipped','cancelled'].includes(fresh?.state)) await this.waitForManualSubmission(session, row);
      }
    } else {
      while (!session.submitted) {
        await this.assertSession(session);
        this.manualPhase(session, 'submitting_' + row.kind);
        const outcome = await this.executeRow(jobId, this.row(jobId, session.step), true);
        await this.assertSession(session);
        const fresh = getStepAction(jobId, row.step_key);
        if (outcome === 'manual_retry_needed') {
          session.closeReason = fresh?.error || '验证已通过，但发帖未发送，可重新处理当前发帖';
          this.markReady(jobId, round, identity);
          if (fresh) updateActionLog(fresh.id, { state: 'verification_wait', verificationPending: true, error: fresh.error });
          db.prepare("UPDATE verification_cards SET reason=?,updated_at=? WHERE job_id=? AND round_index=? AND identity=?")
            .run(fresh?.error || '验证已通过，但发帖未发送，可重新处理当前发帖', this.time(), jobId, round, identity);
          this.refreshCard(jobId, round, identity);
          this.updateProgress(jobId);
          return;
        }
        if (outcome === 'waiting' && this.runner.workbenchVerification(job) && !session.submitted) {
          throw conflict('原操作尚未触发，请重新进入验证');
        }
        if (['succeeded','failed','skipped','cancelled'].includes(fresh?.state) || outcome === 'waiting') break;
        if (session.submitted) break;
        if (outcome !== 'verification' && !['network','navigation'].includes(outcome)) break;
        if (outcome === 'verification') {
          do { await this.waitForManualChallenge(session); } while (!await this.probeManualSession(session));
        }
      }
      const fresh = getStepAction(jobId, row.step_key);
      if (fresh?.state === 'succeeded') this.finishStep(jobId, session.step, 'succeeded');
      else if (session.submitted && !['failed','skipped','cancelled'].includes(fresh?.state)) await this.waitForManualSubmission(session, row);
      this.markVerificationPassed(jobId, round, identity);
    }
    await this.assertSession(session);
    this.markReady(jobId, round, identity);
    this.refreshCard(jobId, round, identity);
    this.updateProgress(jobId);
  }

  async waitForManualSubmission(session, row) {
    const { jobId } = session;
    let until = this.runner.now() + MANUAL_RECEIPT_TIMEOUT_MS;
    while (this.runner.now() < until) {
      await this.assertSession(session);
      let action = getStepAction(jobId, row.step_key);
      if (action?.state === 'succeeded') { this.finishStep(jobId, session.step, 'succeeded'); return; }
      const handle = this.runner.adapter.currentSubmission?.(action)
        || (this.runner.workbenchVerification(getJob(jobId)) && this.runner.adapter.currentSubmission ? null : row.kind === 'post' ? this.runner.adapter.manualPostReceipt : row.kind === 'comment' ? this.runner.adapter.manualCommentReceipt : null);
      if (handle && (!handle.actionId || handle.actionId === action?.id)
        && (!handle.attemptId || handle.attemptId === action?.attempt_id) && handle.page === session.page) await handle.read?.();
      if (['like','comment_like'].includes(row.kind) && !await this.runner.adapter.hasTaskChallenge?.(session.account)) await this.recheckRow(jobId, row);
      action = getStepAction(jobId, row.step_key);
      if (action?.state === 'succeeded') { this.finishStep(jobId, session.step, 'succeeded'); return; }
      if (await this.runner.adapter.hasTaskChallenge?.(session.account)) {
        do { await this.waitForManualChallenge(session); } while (!await this.probeManualSession(session));
        this.markVerificationPassed(jobId, row.round_index, session.identity);
        until = this.runner.now() + MANUAL_RECEIPT_TIMEOUT_MS;
        continue;
      }
      this.manualPhase(session, 'awaiting_' + row.kind + '_receipt');
      await new Promise(resolve => {
        session.wake = resolve; session.timer = setTimeout(resolve, 200);
      });
      session.wake = null; session.timer = null;
    }
    await this.assertSession(session);
    let action = getStepAction(jobId, row.step_key);
    if (action?.state !== 'succeeded') {
      try { await this.recheckRow(jobId, row); } catch { /* keep the committed submission uncertain */ }
      action = getStepAction(jobId, row.step_key);
    }
    if (action?.state === 'succeeded') this.finishStep(jobId, session.step, 'succeeded');
    else this.finishStep(jobId, session.step, 'uncertain', '人工验证后仍未观察到本次操作的成功提示，保留核对且不重复发送');
  }

  async waitForManualChallenge(session) {
    await this.assertSession(session);
    session.challengeSeen = true;
    if (session.step?.kind === 'checkin') this.observeCheckinChallenge(session.jobId, session.stepKey);
    this.manualPhase(session, 'challenge');
    await new Promise(resolve => { session.wake = resolve; session.timer = setTimeout(resolve, 2000); });
    session.wake = null; session.timer = null;
    await this.assertSession(session);
  }

  observeCheckinChallenge(jobId, key) {
    const job = getJob(jobId), budgets = job.cursor.checkinVerificationCycles || {};
    const old = budgets[key] || { cycle: 0, usedCycle: 0 };
    if (!old.challengeSeen) this.setCursor(jobId, { checkinVerificationCycles: { ...budgets, [key]: { ...old, challengeSeen: true } } });
  }

  markVerificationPassed(jobId, round, identity) {
    const session = this.session;
    if (session?.jobId === jobId && session.step?.kind === 'checkin') {
      const budgets = getJob(jobId).cursor.checkinVerificationCycles || {}, old = budgets[session.stepKey];
      if (old?.challengeSeen) this.setCursor(jobId, { checkinVerificationCycles: { ...budgets, [session.stepKey]: { ...old, cycle: old.cycle + 1, challengeSeen: false } } });
      else if (!old) {
        const action = getStepAction(jobId, session.stepKey);
        // Legacy unsubmitted captcha rows have no cycle ledger yet. They may
        // receive one initial credit; submitted unknown legacy rows may not.
        if (action?.state === 'verification_wait' && action.verification_pending) this.setCursor(jobId, {
          checkinVerificationCycles: { ...budgets, [session.stepKey]: { cycle: 1, usedCycle: 0, challengeSeen: false } }
        });
      }
    }
    if (session) session.challengeSeen = false;
    db.prepare(`UPDATE verification_cards SET status='validating',verification_result='passed',verified_at=?,
      checkin_result=CASE WHEN checkin_result='succeeded' THEN 'succeeded' ELSE 'pending' END,
      reason=?,updated_at=?
      WHERE job_id=? AND round_index=? AND identity=?`).run(this.time(), '验证已通过，正在确认' + kindLabel(this.session?.step?.kind || 'checkin') + '结果', this.time(), jobId, round, identity);
    if (this.session?.jobId === jobId) {
      const phase = { checkin: 'signing_checkin', post: 'awaiting_post_receipt', comment: 'awaiting_comment_receipt',
        repost: 'awaiting_repost_receipt', like: 'awaiting_like_receipt', comment_like: 'awaiting_comment_like_receipt' }[this.session.step?.kind]
        || 'awaiting_post_receipt';
      this.manualPhase(this.session, phase);
    }
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
    // 仅处理选中的签到；每次验证码解除后最多追加一次点击，随后只读等待。
    // Durable per-step budget survives polling, reopening and process recovery.
    // A new credit is granted only after an observed challenge is cleared.
    const pause = ms => new Promise(resolve => {
      const done = () => { if (session.timer) { clearTimeout(session.timer); session.timer = null; } session.wake = null; resolve(); };
      session.wake = done;
      session.timer = setTimeout(done, ms);
    });
    while (true) {
      await this.assertSession(session);
      const rows = this.checkinRows(jobId, round, identity).filter(row => row.step_key === session.stepKey);
      if (!rows.length) return;
      const row = rows[0];
      session.step = stepFrom(row);
      const topic = listTopics().find(item => item.id === row.topic_id);
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
        if (await this.runner.navigation.handle(error, jobId, stepFrom(row))) {
          await this.runner.navigation.wait(jobId, () => session.cancelled || session.windowClosed);
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
      const budgets = getJob(jobId).cursor.checkinVerificationCycles || {};
      const clickState = budgets[row.step_key] || { cycle: 0, usedCycle: 0 };
      if (clickState.usedCycle >= clickState.cycle) {
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
      this.setCursor(jobId, { checkinVerificationCycles: { ...getJob(jobId).cursor.checkinVerificationCycles, [row.step_key]: { ...clickState, usedCycle: clickState.cycle, at: this.runner.now() } } });
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
    if (getJob(session.jobId)?.stopRequested) {
      this.finalizeStop(session.jobId, '已手动停止');
      throw new DailyStopError('已手动停止');
    }
    // Closing the visible tab/window is a deliberate end of this attempt.
    // Do not reopen a second tab: the card will immediately become retryable.
    if (session.windowClosed || session.page?.isClosed?.()) throw new Error(session.closeReason || '验证窗口已关闭，请重新进入验证');
    await this.runner.network.wait(session.jobId, () => session.cancelled || session.windowClosed);
    await this.runner.navigation.wait(session.jobId, () => session.cancelled || session.windowClosed);
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
        if (await this.runner.navigation.handle(error, session.jobId, session.step)) await this.runner.navigation.wait(session.jobId, () => session.cancelled || session.windowClosed);
        else if (await this.runner.network.handle(error, session.jobId, session.step)) await this.runner.network.wait(session.jobId, () => session.cancelled || session.windowClosed);
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
    const selectedKind = this.session?.step?.kind;
    const selected = this.session?.stepKey && getStepAction(jobId, this.session.stepKey);
    const label = selectedKind ? kindLabel(selectedKind) : '';
    const reason = label ? `${label}${selected?.state === 'succeeded' ? '已完成' : selected?.state === 'uncertain' ? '结果待核对，不会自动重发' : '验证已通过'}${remaining ? '，其余操作请点击继续运行' : ''}`
      : done ? '验证与签到已完成' : checkinResult === 'pending' ? '安全验证已通过，签到待补做' : '安全验证已通过';
    db.prepare("UPDATE verification_cards SET status=?,verification_result='passed',verified_at=COALESCE(verified_at,?),checkin_result=?,reason=?,updated_at=? WHERE job_id=? AND round_index=? AND identity=?")
      .run(done ? 'resolved' : 'ready', this.time(), checkinResult, reason, this.time(), jobId, round, identity);
    this.clearVerificationPending(jobId, round, identity, this.session?.stepKey);
    if (this.runner.workbenchVerification(getJob(jobId)) && this.rows(jobId, round).some(row => row.identity === identity
      && ['deferred','review','network_review'].includes(row.state) && getStepAction(jobId, row.step_key)?.verification_pending)) {
      db.prepare("UPDATE verification_cards SET status='pending',verification_result='pending',verified_at=NULL,reason='该账号还有其他操作待验证',updated_at=? WHERE job_id=? AND round_index=? AND identity=?")
        .run(this.time(), jobId, round, identity);
    }
    this.refreshCard(jobId, round, identity);
    this.updateProgress(jobId);
  }

  clearVerificationPending(jobId, round, identity, selectedKey = null) {
    db.prepare(`UPDATE action_logs SET verification_pending=0 WHERE job_id=? AND step_key IN (
      SELECT step_key FROM task_step_state WHERE job_id=? AND round_index=? AND identity=? AND (? IS NULL OR step_key=?))`).run(jobId, jobId, round, identity, selectedKey, selectedKey);
  }

  async recheckRow(jobId, row) {
    const action = getStepAction(jobId, row.step_key); if (!action) return;
    const account = getAccount(row.account_id);
    let result = { state: 'uncertain' };
    if (row.kind === 'comment' && action.url && action.target_id) result = await this.runner.adapter.verifyComment?.(account, { id: action.target_id, url: action.url.split('?')[0] }, action.content, { delays: [0] }) || result;
    else if (row.kind === 'post') {
      const topic = listTopics().find(topic => topic.id === row.topic_id);
      result = await this.runner.adapter.verifyPost?.(account, action, { topicName: topic?.name }) || result;
      if (result.state !== 'succeeded' && !action.receipt_id && topic && this.runner.adapter.findPublishedPost) {
        result = await this.runner.adapter.findPublishedPost(account, { content: action.content, topic,
          startedAt: action.started_at, submittedAt: action.submitted_at, completedAt: action.completed_at,
          syncToHome: getJob(jobId).config.syncToHome === true });
        if (result.state === 'succeeded' && !this.runner.postClaimIsUnique(action, result)) result = { state: 'uncertain' };
      }
    }
    else if (row.kind === 'checkin') result = await this.runner.adapter.verifyCheckin?.(account, listTopics().find(topic => topic.id === row.topic_id)) || result;
    else if (row.kind === 'repost') result = await this.runner.adapter.verifyRepost?.(account, action) || result;
    else if (row.kind === 'like') result = await this.runner.adapter.verifyLike?.(account, action.url || row.topic_id) || result;
    else if (row.kind === 'comment_like') result = await this.runner.adapter.verifyCommentLike?.(account, action.url || row.topic_id, action.target_id) || result;
    this.runner.assertExecutionAlive();
    this.runner.assertMaySubmit(jobId);
    if (result.state === 'succeeded') {
      if (row.kind === 'post') this.runner.settlePostAction(action.id, { state: 'succeeded', receiptId: result.receiptId,
        receiptUrl: result.receiptUrl, url: result.url || action.url, error: '', attemptId: action.attempt_id });
      else updateActionLog(action.id, { state: 'succeeded', url: result.url || action.url, error: '' });
      if (row.kind === 'comment') recordComment(row.account_id, action.target_id, result.url || action.url);
      this.finishStep(jobId, stepFrom(row), 'succeeded');
    }
    return result;
  }

  async endManual(jobId) {
    const session = this.session;
    if (session?.jobId === jobId) {
      session.cancelled = true; clearTimeout(session.timer); session.wake?.();
      await this.runner.adapter.cancelTask?.();
      await session.promise;
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
    if (!status?.canContinue) throw conflict('请等待当前浏览器操作或验证会话结束');
    const round = Number(job.cursor.workflowRound || 0);
    // Submitted unknown results remain read-only reviews until confirmed.
    for (const row of this.rows(jobId, round).filter(item => item.kind === 'checkin' && item.state === 'deferred')) {
      const action = getStepAction(jobId, row.step_key);
      if (this.card(jobId, round, row.identity)?.verification_result === 'passed' && ['uncertain','verification_wait'].includes(action?.state)) {
        updateActionLog(action.id, { state: 'prepared', error: '用户点击继续运行，先读取签到状态后补做' });
      }
    }
    const cards = db.prepare('SELECT identity,blocked_kinds_json,status,verification_result,verified_at FROM verification_cards WHERE job_id=? AND round_index=?').all(jobId, round);
    const blockedIdentities = this.blockingIdentitySet(jobId, round);
    const verifiedIdentities = cards.filter(card => card.verification_result === 'passed')
      .sort((a, b) => (Date.parse(a.verified_at) || 0) - (Date.parse(b.verified_at) || 0))
      .map(card => card.identity);
    const resume = db.prepare("UPDATE task_step_state SET state='pending' WHERE job_id=? AND step_key=?");
    // Unverified accounts stay deferred as a complete account scope. Verified
    // and card-free accounts may proceed; only unsubmitted rows are restored.
    for (const row of db.prepare("SELECT step_key,identity,kind FROM task_step_state WHERE job_id=? AND round_index=? AND state='deferred'").all(jobId, round)) {
      if (blockedIdentities.has(row.identity)) continue;
      const action = getStepAction(jobId, row.step_key);
      if ((action?.submitted_at && action?.error !== '用户确认未发布，允许补做')
        || ['submitted','uncertain'].includes(action?.state)) continue;
      resume.run(jobId, row.step_key);
    }
    const defer = db.prepare("UPDATE task_step_state SET state='deferred' WHERE job_id=? AND step_key=?");
    for (const row of db.prepare("SELECT step_key,identity FROM task_step_state WHERE job_id=? AND round_index=? AND state='pending'").all(jobId, round)) {
      if (blockedIdentities.has(row.identity)) defer.run(jobId, row.step_key);
    }
    db.prepare("UPDATE verification_cards SET status='retrying',blocked_kinds_json='[]' WHERE job_id=? AND round_index=? AND status='ready' AND verification_result='passed'").run(jobId, round);
    const updated = updateJob(jobId, { status: 'running', pausedByUser: false, waitReason: null, cursor: { ...job.cursor,
      verificationBarrier: false, workflowPriority: null, verificationAutoPaused: false,
      verificationPauseReason: null, workflowPriorityIdentity: null,
      workflowPriorityIdentities: verifiedIdentities } });
    this.runner.emitUpdate(updated); this.runner.run(jobId);
    return updated;
  }

  finalizeStop(jobId, reason) {
    this.runner.navigation.clear(jobId);
    resetVerificationNotifications(jobId);
    let job = getJob(jobId); if (!job || job.status === 'stopped') return job;
    this.ensureSteps(job);
    if (!this.session) { this.manualRelease?.(); this.manualRelease = null; }
    if (this.session?.jobId === jobId) { this.session.cancelled = true; clearTimeout(this.session.timer); this.session.wake?.(); }
    for (const row of db.prepare("SELECT * FROM task_step_state WHERE job_id=? AND state IN ('pending','running','deferred','network_review')").all(jobId)) {
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
