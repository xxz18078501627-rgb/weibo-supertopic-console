import { db, getJob, updateJob, updateActionLog, log } from '../src/db.js';
const jobId = 'job_adfb233b-b15b-40b2-bbac-817199d08c0e';
const job = getJob(jobId);
if (job?.status !== 'waiting' || job.cursor.manualVerification || job.cursor.diagnosticSource !== 'job_18fcaeb2-5c7d-4f5b-93b6-876a6e5e782b') throw Error('实测任务状态已变化');
const action = db.prepare("SELECT * FROM action_logs WHERE job_id=? AND kind='post'").get(jobId);
if (action?.state !== 'failed' || action.receipt_id) throw Error('只修复旧服务误记失败且没有成功回执的实测步骤');
const stamp = new Date().toISOString();
db.exec('BEGIN IMMEDIATE');
try {
  updateActionLog(action.id, { state: 'verification_wait', sequenceNumber: null, sequenceConfirmed: false, error: '实测已捕获20067安全验证；旧服务误记失败，恢复人工验证入口' });
  db.prepare("UPDATE task_step_state SET state='deferred',outcome=NULL,ever_verification=1 WHERE job_id=? AND step_key=?").run(jobId, action.step_key);
  db.prepare("UPDATE verification_cards SET status='pending',verification_result='pending',verified_at=NULL,reason=?,updated_at=? WHERE job_id=? AND identity='7980323573'").run('实测回执20067要求安全验证，等待在新版可见窗口处理', stamp, jobId);
  const reservations = { ...job.cursor.sequenceReservations }; delete reservations[action.step_key];
  updateJob(jobId, { metrics: { success: 0, failed: 0, uncertain: 0, skipped: 0 }, cursor: { ...job.cursor, stepIndex: 0, sequenceReservations: reservations, verificationBarrier: true } });
  log('info', `恢复单条实测验证卡片：${action.id}；原旧服务结果 failed；实测证据20067；未发布回执`, { accountId: action.account_id, topicId: action.topic_id });
  db.exec('COMMIT');
} catch (error) { db.exec('ROLLBACK'); throw error; }
console.log(JSON.stringify({ jobId, state: 'waiting', card: 'pending' }));
