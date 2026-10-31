// Explicit maintenance command: copies only the two user-authorized sign-ins.
// The stopped source task and its action records are retained unchanged.
import { db, getJob, createJob, updateJob, getStepAction, createActionLog } from '../src/db.js';
import { buildSteps } from '../src/runner.js';
import { stepKey } from '../src/verification-workflow.js';
import { deadlineFor, dailyStopStatus } from '../src/daily-stop.js';

export function restoreCheckinFollowups(sourceId, identities) {
  const key = `checkin-followup:${sourceId}:${[...identities].sort().join(',')}`;
  const previous = db.prepare('SELECT id,cursor_json FROM jobs').all().find(row => JSON.parse(row.cursor_json).maintenanceKey === key);
  if (previous) return getJob(previous.id);
  if (dailyStopStatus().blocked) throw new Error('已到每日截止时间，不能恢复签到待办');
  if (db.prepare("SELECT 1 FROM jobs WHERE status IN ('running','waiting','paused') LIMIT 1").get()) throw new Error('请等待其他任务结束');
  const source = getJob(sourceId);
  if (source?.status !== 'stopped') throw new Error('原任务必须保持已停止');
  const rows = identities.map(identity => db.prepare("SELECT * FROM task_step_state WHERE job_id=? AND identity=? AND kind='checkin' AND ever_verification=1 ORDER BY ordinal LIMIT 1").get(sourceId, identity));
  if (rows.some(row => !row)) throw new Error('找不到指定签到待办');
  const topicIds = [...new Set(rows.map(row => row.topic_id))];
  if (topicIds.length !== 1) throw new Error('该修复只支持同一超话的两项签到');
  const snapshot = { ...source.config, rounds: 1, schedulerVersion: 3, accountIds: rows.map(row => row.account_id), topicIds,
    actionPlan: [{ type: 'checkin', count: 1, intervalSeconds: 5 }], segmentIds: ['restored-checkin'],
    roundIntervalSeconds: 0 };
  db.exec('BEGIN IMMEDIATE');
  try {
    const job = createJob(snapshot);
    const links = [];
    for (const [ordinal, step] of buildSteps(snapshot).entries()) {
      const original = rows.find(row => row.account_id === step.accountId);
      const newRow = { step_key: stepKey(step) };
      const action = getStepAction(sourceId, original.step_key);
      db.prepare(`INSERT INTO task_step_state(job_id,step_key,ordinal,round_index,account_id,identity,topic_id,kind,action_index,segment_id,unit_index,state,ever_verification)
        VALUES(?,?,?,0,?,?,?,'checkin',0,?,0,'deferred',1)`).run(job.id, newRow.step_key, ordinal, original.account_id, original.identity, original.topic_id, step.segmentId);
      createActionLog({ jobId: job.id, stepKey: newRow.step_key, accountId: step.accountId, topicId: step.topicId,
        kind: 'checkin', state: 'verification_wait', url: action?.url, error: '原任务签到结果未确认，用户授权独立补做' });
      const stamp = new Date().toISOString();
      db.prepare(`INSERT INTO verification_cards(job_id,round_index,identity,account_id,status,blocked_kinds_json,reason,source,triggered_at,updated_at)
        VALUES(?,0,?,?,'pending','["checkin"]',?,'checkin_unconfirmed',?,?)`).run(job.id, original.identity, original.account_id, '原任务签到结果未确认，点击验证此账号可重新尝试', stamp, stamp);
      links.push({ identity: original.identity, sourceJobId: sourceId, sourceStepKey: original.step_key, sourceActionId: action?.id || null, stepKey: newRow.step_key });
    }
    const updated = updateJob(job.id, { status: 'waiting', waitReason: '等待两项历史签到人工验证', cursor: {
      stepIndex: 0, workflowRound: 0, verificationBarrier: true, deadlineAt: new Date(deadlineFor(Date.now())).toISOString(), maintenanceKey: key, sourceCheckins: links
    } });
    db.exec('COMMIT'); return updated;
  } catch (error) { db.exec('ROLLBACK'); throw error; }
}

if (process.argv[1]?.endsWith('restore-checkin-followups.mjs')) {
  const result = restoreCheckinFollowups('job_d1be9bfa-db8e-4c9d-a067-4db41f0de189', ['7916786170', '7941901417']);
  console.log(JSON.stringify({ id: result.id, status: result.status, accountIds: result.config.accountIds }));
}
