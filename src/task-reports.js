import { db, getJob, getAccount, listTopics } from './db.js';
import { now, shanghaiDate } from './util.js';
import { isArchivedRecord } from './retention.js';
import { displayStateSql } from './result-state.js';

db.exec(`CREATE TABLE IF NOT EXISTS task_rounds (
  job_id TEXT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  round_index INTEGER NOT NULL,
  started_at TEXT NOT NULL, completed_at TEXT, status TEXT NOT NULL DEFAULT 'running',
  summary_json TEXT, acknowledged_at TEXT, notification_attempted_at TEXT,
  PRIMARY KEY(job_id,round_index)
);
CREATE INDEX IF NOT EXISTS idx_rounds_completed ON task_rounds(completed_at);
CREATE INDEX IF NOT EXISTS idx_actions_completed_state ON action_logs(state,completed_at);`);

const emptyCounts = () => Object.fromEntries(['checkin', 'post', 'original', 'comment', 'repost', 'like', 'comment_like'].map(kind => [kind, { succeeded: 0, failed: 0, uncertain: 0, skipped: 0 }]));

export function dailySuccess(date = shanghaiDate(), scope = null) {
  let values = {};
  if (isArchivedRecord(date)) {
    const scoped = scope && db.prepare('SELECT success_json FROM daily_scope_stats WHERE date=? AND scope=?').get(date, scope);
    if (scoped) values = JSON.parse(scoped.success_json);
    else if (!scope || scope === 'workbench') {
      const row = db.prepare('SELECT counts_json FROM daily_stats WHERE date=?').get(date);
      const counts = row ? JSON.parse(row.counts_json || '{}') : {};
      values = Object.fromEntries(Object.entries(counts).map(([kind, value]) => [kind, Number(value.succeeded || 0)]));
    }
  } else {
    const rows = db.prepare("SELECT kind,COUNT(*) total FROM action_logs WHERE state='succeeded' AND strftime('%Y-%m-%d',COALESCE(completed_at,started_at),'+8 hours')=?" + (scope ? ' AND scope=?' : '') + ' GROUP BY kind').all(...(scope ? [date, scope] : [date]));
    values = Object.fromEntries(rows.map(row => [row.kind, Number(row.total)]));
  }
  const checkin = scope === 'engage' ? 0 : Number(db.prepare("SELECT COUNT(*) total FROM (SELECT COALESCE(NULLIF(a.uid,''),c.account_id),c.topic_id FROM checkins c LEFT JOIN accounts a ON a.id=c.account_id WHERE c.local_date=? AND c.status='succeeded' GROUP BY COALESCE(NULLIF(a.uid,''),c.account_id),c.topic_id)").get(date).total);
  return { date, checkin, post: 0, original: 0, comment: 0, ...(scope === 'engage' ? { repost: 0, comment_like: 0, like: 0 } : {}), ...values, checkin };
}

export function dailyStats(date = shanghaiDate(), scope = null) {
  if (isArchivedRecord(date)) {
    const row = scope ? db.prepare('SELECT counts_json,job_count FROM daily_scope_stats WHERE date=? AND scope=?').get(date, scope) : db.prepare('SELECT * FROM daily_stats WHERE date=?').get(date);
    return { date, counts: row ? JSON.parse(row.counts_json || '{}') : emptyCounts(), jobCount: Number(row?.job_count || 0), abnormalAccounts: Number(row?.abnormal_accounts || 0), archived: true };
  }
  const counts = emptyCounts();
  for (const row of db.prepare('SELECT l.kind,' + displayStateSql(db) + " state,COUNT(*) total FROM action_logs l WHERE strftime('%Y-%m-%d',l.started_at,'+8 hours')=?" + (scope ? ' AND l.scope=?' : '') + ' GROUP BY l.kind,(' + displayStateSql(db) + ')').all(...(scope ? [date, scope] : [date]))) {
    if (counts[row.kind]?.[row.state] != null) counts[row.kind][row.state] = Number(row.total);
  }
  const jobCount = db.prepare("SELECT COUNT(*) c FROM jobs WHERE strftime('%Y-%m-%d',created_at,'+8 hours')=?" + (scope ? ' AND scope=?' : '')).get(...(scope ? [date, scope] : [date])).c;
  return { date, counts, jobCount: Number(jobCount) || 0, abnormalAccounts: null, archived: false };
}

export function operationCounts(jobId) {
  const counts = emptyCounts();
  for (const row of db.prepare('SELECT l.kind,' + displayStateSql(db) + ' state,COUNT(*) n FROM action_logs l WHERE l.job_id=? GROUP BY l.kind,(' + displayStateSql(db) + ')').all(jobId)) {
    if (counts[row.kind]?.[row.state] != null) counts[row.kind][row.state] = Number(row.n);
  }
  return counts;
}

export function startRound(jobId, round, startedAt = now()) {
  db.prepare('INSERT OR IGNORE INTO task_rounds(job_id,round_index,started_at) VALUES(?,?,?)').run(jobId, round, startedAt);
}

function summaryFor(job, round, { details = false } = {}) {
  const actions = db.prepare(`SELECT l.*,${displayStateSql(db)} display_state FROM action_logs l WHERE l.job_id=? AND l.step_key LIKE ? ORDER BY l.started_at,l.id`).all(job.id, `${round}:%`);
  const counts = emptyCounts();
  const topics = new Map(listTopics().map(topic => [topic.id, topic.name]));
  const accounts = new Map((job.config.accountIds || []).map(accountId => {
    const account = getAccount(accountId);
    const saved = job.config.accountIdentities?.[accountId];
    return [accountId, { id: accountId, name: saved?.name || account?.nickname || account?.name || accountId,
      uid: saved?.uid || account?.uid || '', groupName: saved?.groupName || '未分组', counts: emptyCounts(), anomalies: [], actions: [] }];
  }));
  for (const action of actions) {
    const account = accounts.get(action.account_id);
    if (counts[action.kind]?.[action.display_state] != null) counts[action.kind][action.display_state]++;
    if (!account) continue;
    if (account.counts[action.kind]?.[action.display_state] != null) account.counts[action.kind][action.display_state]++;
    const topicName = job.config.kind === 'engage' ? job.config.linkIdentities?.[action.link]?.name || action.link || action.url || '指定微博' : job.config.topicIdentities?.[action.topic_id]?.name || topics.get(action.topic_id) || action.topic_id;
    if (details) account.actions.push({ ...action, topic_name: topicName });
    if (['failed', 'uncertain', 'submitted'].includes(action.state) || (action.state === 'skipped' && /禁言|频繁|登录失效|UID.*不符|UID.*一致/.test(action.error || ''))) account.anomalies.push({ kind: action.kind, topicId: action.topic_id, topicName, reason: action.error || (action.state === 'failed' ? '操作失败' : '结果待核对'), at: action.completed_at || action.started_at });
  }
  for (const restriction of [...(job.cursor.muteLimits || []).map(x => ({ ...x, label: '禁言' })), ...(job.cursor.rateLimits || []).map(x => ({ ...x, label: x.kind === 'post' ? '发帖频繁' : x.kind === 'original' ? '原创频繁' : '评论频繁' }))]) {
    if (restriction.round !== round) continue;
    for (const account of accounts.values()) if (String(account.uid || `account:${account.id}`) === restriction.identity) {
      account.anomalies.push({ kind: restriction.kind, reason: `${restriction.label}：${restriction.reason}`, at: restriction.at });
    }
  }
  let verification = null;
  if (Number(job.config.schedulerVersion || 0) >= 2) {
    const cards = db.prepare('SELECT * FROM verification_cards WHERE job_id=? AND round_index=?').all(job.id, round);
    const steps = db.prepare(`SELECT s.*,${displayStateSql(db)} display_state FROM task_step_state s
      LEFT JOIN action_logs l ON l.job_id=s.job_id AND l.step_key=s.step_key
      WHERE s.job_id=? AND s.round_index=? AND s.ever_verification=1`).all(job.id, round);
    verification = { accounts: cards.length, triggers: cards.reduce((total, card) => total + card.attempts, 0), checkinUnconfirmed: cards.filter(card => card.source === 'checkin_unconfirmed').length, pending: steps.filter(step => ['pending','running','deferred'].includes(step.state) || step.display_state === 'verification_wait').length, succeeded: steps.filter(step => step.outcome === 'succeeded').length, uncertain: steps.filter(step => step.outcome === 'uncertain' && step.display_state !== 'verification_wait').length, failed: steps.filter(step => step.outcome === 'failed').length };
    for (const card of cards) for (const account of accounts.values()) if (String(account.uid || `account:${account.id}`) === card.identity) {
      account.anomalies.push({ reason: `${card.source === 'checkin_unconfirmed' ? '签到结果未确认，' : ''}本轮触发人工验证 ${card.attempts} 次，${card.status === 'resolved' ? '已处理' : card.status === 'ready' ? '已验证，待补做' : '验证队列中'}`, at: card.updated_at });
    }
  }
  return { resultStateVersion: 1, counts, verification, accountCount: accounts.size, scope: job.scope || 'workbench', topicCount: (job.config.kind === 'engage' ? job.config.links : job.config.topicIds)?.length || 0, accounts: [...accounts.values()], abnormalAccounts: [...accounts.values()].filter(account => account.anomalies.length).map(({ actions, ...account }) => account) };
}

export function roundReport(row, { details = false } = {}) {
  const job = getJob(row.job_id);
  const stored = row.summary_json ? JSON.parse(row.summary_json) : {};
  const base = { counts: emptyCounts(), verification: null, accountCount: 0, topicCount: 0, accounts: [], abnormalAccounts: [] };
  let summary;
  if (row.summary_json && ['completed', 'stopped'].includes(row.status)) {
    summary = { ...base, ...stored };
    // Upgrade the view of retained reports without reopening the round or
    // moving its timestamps. Archived reports keep their original snapshot.
    const retained = job && db.prepare('SELECT 1 FROM task_step_state WHERE job_id=? AND round_index=? LIMIT 1').get(row.job_id, row.round_index);
    if (retained && stored.resultStateVersion !== 1) summary = { ...summary, ...summaryFor(job, row.round_index, { details }) };
    if (details && job) {
      const live = summaryFor(job, row.round_index, { details: true });
      const hasSteps = db.prepare('SELECT 1 FROM task_step_state WHERE job_id=? AND round_index=? LIMIT 1').get(row.job_id, row.round_index);
      if (hasSteps && live.accounts.some(account => (account.actions || []).length)) summary.accounts = live.accounts;
      else summary.accounts = summary.accounts.map(account => ({ ...account,
        actions: live.accounts.find(item => item.id === account.id)?.actions || [] }));
    }
  } else if (job) {
    summary = summaryFor(job, row.round_index, { details });
  } else {
    summary = { ...base, ...stored };
  }
  if (!details) summary.accounts = summary.accounts?.map(({ actions, ...account }) => account);
  return { jobId: row.job_id, round: row.round_index, startedAt: row.started_at, completedAt: row.completed_at,
    status: row.status, durationMs: Math.max(0, Date.parse(row.completed_at || now()) - Date.parse(row.started_at)),
    acknowledgedAt: row.acknowledged_at, stopReason: row.status === 'stopped' ? job?.cursor?.stopReason || '任务已中止' : null, ...summary };
}

export function finishRound(jobId, round, status = 'completed') {
  const row = db.prepare('SELECT * FROM task_rounds WHERE job_id=? AND round_index=?').get(jobId, round);
  if (!row || row.status !== 'running') return null;
  const summary = summaryFor(getJob(jobId), round);
  db.prepare('UPDATE task_rounds SET completed_at=?,status=?,summary_json=? WHERE job_id=? AND round_index=? AND status=?')
    .run(now(), status, JSON.stringify(summary), jobId, round, 'running');
  return roundReport(db.prepare('SELECT * FROM task_rounds WHERE job_id=? AND round_index=?').get(jobId, round));
}

// Reconciliation changes counts, not the historical lifecycle or notification
// acknowledgement. Completed reports otherwise keep their original snapshot.
export function refreshRoundSummary(jobId, round, { action = null, nextState = null } = {}) {
  const job = getJob(jobId);
  if (!job) return;
  const row = db.prepare('SELECT * FROM task_rounds WHERE job_id=? AND round_index=?').get(jobId, round);
  if (!row) return;
  const hasSteps = db.prepare('SELECT 1 FROM task_step_state WHERE job_id=? AND round_index=? LIMIT 1').get(jobId, round);
  if (!hasSteps && row.summary_json && action && nextState) {
    const summary = JSON.parse(row.summary_json);
    const adjust = counts => {
      if (!counts || action.state === nextState) return;
      counts[action.state] = Math.max(0, Number(counts[action.state] || 0) - 1);
      counts[nextState] = Number(counts[nextState] || 0) + 1;
    };
    adjust(summary.counts?.post);
    for (const account of summary.accounts || []) {
      if (account.id !== action.account_id) continue;
      adjust(account.counts?.post);
      if (nextState === 'succeeded') account.anomalies = (account.anomalies || []).filter(item =>
        !(['post','original'].includes(item.kind) && item.reason === action.error && item.at === (action.completed_at || action.started_at)));
    }
    summary.abnormalAccounts = (summary.accounts || []).filter(account => account.anomalies?.length).map(({ actions, ...account }) => account);
    db.prepare('UPDATE task_rounds SET summary_json=? WHERE job_id=? AND round_index=?').run(JSON.stringify(summary), jobId, round);
    return;
  }
  db.prepare('UPDATE task_rounds SET summary_json=? WHERE job_id=? AND round_index=?')
    .run(JSON.stringify(summaryFor(job, round)), jobId, round);
}

export function listRoundReports(jobId, details = false) {
  return db.prepare('SELECT * FROM task_rounds WHERE job_id=? ORDER BY round_index').all(jobId).map(row => roundReport(row, { details }));
}

export function runningRounds(jobId) {
  return db.prepare("SELECT round_index FROM task_rounds WHERE job_id=? AND status='running'").all(jobId).map(row => row.round_index);
}

export function roundsForDate(date, scope = null) {
  const rows = db.prepare(`SELECT r.* FROM task_rounds r JOIN jobs j ON j.id=r.job_id WHERE (strftime('%Y-%m-%d',r.started_at,'+8 hours')=?
    OR strftime('%Y-%m-%d',r.completed_at,'+8 hours')=?)${scope ? ' AND j.scope=?' : ''} ORDER BY r.started_at DESC`).all(...(scope ? [date, date, scope] : [date, date]));
  return rows.map(row => roundReport(row, { details: true }));
}

export function pendingRoundReports() {
  return db.prepare("SELECT * FROM task_rounds WHERE status='completed' AND acknowledged_at IS NULL ORDER BY completed_at,job_id,round_index").all().map(row => roundReport(row));
}

export function acknowledgeRound(jobId, round) {
  return Boolean(db.prepare("UPDATE task_rounds SET acknowledged_at=COALESCE(acknowledged_at,?) WHERE job_id=? AND round_index=? AND status='completed'").run(now(), jobId, round).changes);
}

export function claimRoundNotification(jobId, round) {
  return Boolean(db.prepare("UPDATE task_rounds SET notification_attempted_at=? WHERE job_id=? AND round_index=? AND status='completed' AND notification_attempted_at IS NULL").run(now(), jobId, round).changes);
}

export function unnotifiedRounds() {
  return db.prepare("SELECT * FROM task_rounds WHERE status='completed' AND notification_attempted_at IS NULL ORDER BY completed_at").all().map(row => roundReport(row));
}
