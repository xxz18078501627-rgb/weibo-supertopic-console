import { db } from './db.js';

function inPlan(row, config) {
  if (row.round_index >= Number(config.rounds || 1) || !config.accountIds?.includes(row.account_id) || !config.topicIds?.includes(row.topic_id)) return false;
  const index = row.segment_id ? (config.actionPlan || []).findIndex((item, i) => (item.segmentId || config.segmentIds?.[i]) === row.segment_id) : row.action_index;
  const segment = config.actionPlan?.[index];
  return Boolean(segment && segment.type === row.kind && row.unit_index < (row.kind === 'checkin' ? Math.min(1, segment.count) : segment.count));
}

export function taskProgress(job) {
  if (!job) return null;
  const config = job.config || {}, rounds = Math.max(1, Number(config.rounds || 1));
  const rows = db.prepare(`SELECT s.state,s.round_index,s.account_id,s.topic_id,s.action_index,s.segment_id,s.unit_index,s.kind,s.ever_verification,v.status AS verification_status FROM task_step_state s
    LEFT JOIN verification_cards v ON v.job_id=s.job_id AND v.round_index=s.round_index AND v.identity=s.identity
    WHERE s.job_id=?`).all(job.id);
  let total, processed;
  if (rows.length) {
    // Plan edits retract unsubmitted work. Stopping a task does not erase its
    // remaining work from the denominator, so its percentage stays honest.
    const included = rows.filter(row => row.state !== 'cancelled' || inPlan(row, config));
    total = included.length;
    processed = included.filter(row => row.state === 'done' || (row.state === 'review' && !(row.ever_verification && ['pending','requested','validating'].includes(row.verification_status)))).length;
  } else {
    const perAccount = (config.actionPlan || []).reduce((sum, item) => sum + (item.type === 'checkin' ? Math.min(1, Number(item.count) || 0) : Math.max(0, Number(item.count) || 0)), 0);
    total = rounds * (config.accountIds?.length || 0) * (config.topicIds?.length || 0) * perAccount;
    processed = Math.max(0, Math.min(total, Number(job.cursor?.stepIndex || 0)));
  }
  if (job.status === 'completed') processed = total;
  const raw = total ? processed / total * 100 : 0;
  const percent = job.status === 'completed' ? 100 : Math.min(99.9, Math.floor(raw * 10) / 10);
  return { total, processed, remaining: Math.max(0, total - processed), percent,
    currentRound: Math.min(rounds, Math.max(1, Number(job.cursor?.workflowRound ?? job.cursor?.current?.round ?? 0) + 1)),
    rounds, planAdjusted: Number(job.cursor?.configVersion || 0) > 0 };
}
