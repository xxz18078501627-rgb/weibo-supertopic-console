import { db, getAccount, listTopics, updateActionLog, updateJob, log } from '../src/db.js';
import { BrowserManager } from '../src/browser.js';
import { WeiboAdapter } from '../src/weibo-adapter.js';
import '../src/verification-workflow.js';

const ids = ['act_ef0e2f10-4b1a-4cba-b740-04ffe27ab99a','act_698b0ff6-11dd-45c4-93d9-6502cfef3892','act_47af1a95-6b6f-4a3f-bb01-7dcf9d1402d2','act_6b987261-31fc-4ec6-aaa4-8d94a249583b','act_122552c1-8a78-479c-aef8-da0734d45f93'];
if (db.prepare("SELECT 1 FROM jobs WHERE status IN ('running','waiting','paused')").get()) throw new Error('请等待活动任务结束');
const manager = new BrowserManager(undefined, { headless: true });
const adapter = new WeiboAdapter(manager);
const results = [];
try {
  for (const id of ids) {
    const action = db.prepare('SELECT * FROM action_logs WHERE id=?').get(id);
    if (!action || action.state === 'succeeded') { results.push({ id, state: action?.state || 'missing' }); continue; }
    const topic = listTopics().find(item => item.id === action.topic_id);
    let result;
    try { result = await adapter.findUniqueRecentPost(getAccount(action.account_id), { content: action.content, topicName: topic.name }); }
    catch (error) { result = { state: 'uncertain', reason: `只读核对未完成：${error.message}` }; }
    db.exec('BEGIN IMMEDIATE');
    try {
      updateActionLog(id, { state: result.state === 'succeeded' ? 'succeeded' : 'uncertain', url: result.url || action.url,
        receiptId: result.receiptId, receiptUrl: result.receiptUrl, error: result.state === 'succeeded' ? '' : result.reason });
      db.prepare("UPDATE task_step_state SET state=?,outcome=? WHERE job_id=? AND step_key=?").run(result.state === 'succeeded' ? 'done' : 'review', result.state === 'succeeded' ? 'succeeded' : 'uncertain', action.job_id, action.step_key);
      const counts = { success: 0, failed: 0, uncertain: 0, skipped: 0 };
      for (const row of db.prepare('SELECT outcome,COUNT(*) n FROM task_step_state WHERE job_id=? GROUP BY outcome').all(action.job_id)) {
        const key = row.outcome === 'succeeded' ? 'success' : row.outcome;
        if (key in counts) counts[key] = Number(row.n);
      }
      updateJob(action.job_id, { metrics: counts });
      log('info', `修复发帖验证码误记失败：${id} → ${result.state}；原编号保留`, { accountId: action.account_id, topicId: action.topic_id, url: result.url });
      db.exec('COMMIT');
    } catch (error) { db.exec('ROLLBACK'); throw error; }
    results.push({ id, ...result });
  }
} finally { await manager.close(); }
console.log(JSON.stringify(results));
