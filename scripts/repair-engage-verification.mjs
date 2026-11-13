import { db, getAccount, getJob, updateActionLog, updateJob, log } from '../src/db.js';
import { BrowserManager } from '../src/browser.js';
import { WeiboAdapter, isRateLimitMessage } from '../src/weibo-adapter.js';
import { refreshRoundSummary } from '../src/task-reports.js';

const jobId = process.env.WEIBO_REPAIR_JOB_ID || '';
const accountUid = process.env.WEIBO_REPAIR_ACCOUNT_UID || '';
const requestedSequences = new Set(String(process.env.WEIBO_REPAIR_SEQUENCES || '')
  .split(',').map(value => Number(value.trim())).filter(Number.isFinite));

if (!jobId || !accountUid || !requestedSequences.size) {
  throw new Error('请通过 WEIBO_REPAIR_JOB_ID、WEIBO_REPAIR_ACCOUNT_UID、WEIBO_REPAIR_SEQUENCES 指定待修正任务、账号和转发序号');
}

const job = getJob(jobId);
if (!job || job.scope !== 'engage') throw new Error('转赞评任务不存在');
if (!['waiting', 'paused'].includes(job.status)) throw new Error('只允许修正等待或暂停中的转赞评任务');

const account = db.prepare('SELECT * FROM accounts WHERE uid=?').get(accountUid);
if (!account) throw new Error('修正账号不存在');
const actions = db.prepare(`SELECT * FROM action_logs
  WHERE job_id=? AND account_id=? AND kind='repost' AND sequence_number IN (${[...requestedSequences].map(() => '?').join(',')})
  ORDER BY sequence_number`).all(jobId, account.id, ...requestedSequences);
if (actions.length !== requestedSequences.size) throw new Error('部分待修正转发记录不存在');

const manager = new BrowserManager(undefined, { headless: true, name: 'engage-repair' });
const adapter = new WeiboAdapter(manager);
const results = [];
try {
  for (const action of actions) {
    if (action.state === 'succeeded') {
      results.push({ sequence: action.sequence_number, state: 'succeeded', unchanged: true });
      continue;
    }
    if (action.state === 'skipped' && isRateLimitMessage(action.error)) {
      results.push({ sequence: action.sequence_number, state: 'skipped', unchanged: true });
      continue;
    }
    if (action.state !== 'uncertain') throw new Error(`序号 ${action.sequence_number} 当前状态为 ${action.state}，拒绝自动修正`);

    let next;
    if (isRateLimitMessage(action.error)) {
      next = { state: 'skipped', reason: action.error };
    } else if (/转发已提交但未观察到成功提示或回执/.test(action.error || '')) {
      next = await adapter.verifyRepost(getAccount(action.account_id), action);
    } else {
      throw new Error(`序号 ${action.sequence_number} 的原因不在允许修正范围：${action.error}`);
    }
    if (!['succeeded', 'skipped'].includes(next.state)) {
      results.push({ sequence: action.sequence_number, state: action.state, reason: next.reason || '仍无法唯一确认' });
      continue;
    }

    db.exec('BEGIN IMMEDIATE');
    let round = 0;
    try {
      round = Number(db.prepare('SELECT round_index FROM task_step_state WHERE job_id=? AND step_key=?').get(jobId, action.step_key)?.round_index || 0);
      updateActionLog(action.id, {
        state: next.state,
        error: next.state === 'succeeded' ? '' : (next.reason || action.error),
        url: next.url || action.url,
        receiptId: next.receiptId || action.receipt_id,
        receiptUrl: next.receiptId ? `https://weibo.com/detail/${next.receiptId}` : action.receipt_url,
        successSource: next.state === 'succeeded' ? (next.successSource || 'recent_repost_match') : action.success_source,
      });
      db.prepare('UPDATE task_step_state SET state=?,outcome=? WHERE job_id=? AND step_key=?')
        .run('done', next.state, jobId, action.step_key);
      const metrics = { success: 0, failed: 0, uncertain: 0, skipped: 0 };
      for (const row of db.prepare('SELECT outcome,COUNT(*) n FROM task_step_state WHERE job_id=? GROUP BY outcome').all(jobId)) {
        const key = row.outcome === 'succeeded' ? 'success' : row.outcome;
        if (key in metrics) metrics[key] = Number(row.n);
      }
      updateJob(jobId, { metrics });
      log(next.state === 'succeeded' ? 'info' : 'warning',
        `转赞评当前轮修正：序号 ${action.sequence_number} ${action.state} → ${next.state}；${next.reason || '近期转发唯一匹配'}`,
        { jobId, accountId: account.id, topicId: action.topic_id, url: next.url || action.url });
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
    refreshRoundSummary(jobId, round);
    results.push({ sequence: action.sequence_number, state: next.state, receiptId: next.receiptId || null, reason: next.reason || null });
  }
} finally {
  await manager.close();
}

console.log(JSON.stringify({ jobId, accountUid, results }, null, 2));
