// Keep the persisted submission state for duplicate-send protection. Result
// views and counters separately identify actions awaiting an actual captcha.
export function migrateVerificationPending(db) {
  if (db.prepare("SELECT 1 FROM settings WHERE key='verification_pending_v1'").get()) return;
  db.exec('SAVEPOINT verification_pending_migration');
  try {
    // Existing errors are used only for this one-time compatibility migration.
    // New submissions always carry an explicit flag from VerificationError.
    const rows = db.prepare(`SELECT l.id,l.error FROM action_logs l
      WHERE l.state IN ('submitted','uncertain','verification_wait') AND NOT EXISTS (
        SELECT 1 FROM task_step_state s JOIN verification_cards v
          ON v.job_id=s.job_id AND v.round_index=s.round_index AND v.identity=s.identity
        WHERE s.job_id=l.job_id AND s.step_key=l.step_key AND v.verification_result='passed'
      )`).all();
    const mark = db.prepare('UPDATE action_logs SET verification_pending=1 WHERE id=?');
    for (const row of rows) if (/安全验证|验证码|完成验证|验证后|身份验证|captcha|verify (?:your )?account|security verification|security check/i.test(row.error || '')) mark.run(row.id);
    db.prepare("INSERT INTO settings(key,value) VALUES('verification_pending_v1','true')").run();
    db.exec('RELEASE SAVEPOINT verification_pending_migration');
  } catch (error) {
    db.exec('ROLLBACK TO SAVEPOINT verification_pending_migration; RELEASE SAVEPOINT verification_pending_migration');
    throw error;
  }
}

export function displayStateSql(db, action = 'l') {
  return `CASE WHEN ${action}.state='verification_wait' OR (
    ${action}.state IN ('prepared','started','submitted','uncertain') AND ${action}.verification_pending=1
    ) THEN 'verification_wait' ELSE ${action}.state END`;
}

export function resultMetrics(db, jobId, fallback) {
  if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='task_step_state'").get()) return fallback;
  const rows = db.prepare(`SELECT s.outcome,COUNT(*) n FROM task_step_state s
    LEFT JOIN action_logs l ON l.job_id=s.job_id AND l.step_key=s.step_key
    WHERE s.job_id=? AND s.outcome IS NOT NULL
      AND COALESCE((${displayStateSql(db)}),'')<>'verification_wait'
    GROUP BY s.outcome`).all(jobId);
  if (!db.prepare('SELECT 1 FROM task_step_state WHERE job_id=? LIMIT 1').get(jobId)) return fallback;
  const result = { success: 0, failed: 0, uncertain: 0, skipped: 0 };
  for (const row of rows) {
    const key = row.outcome === 'succeeded' ? 'success' : row.outcome;
    if (key in result) result[key] = Number(row.n);
  }
  return result;
}
