import { db, getAccount, getJob, listTopics, updateActionLog, updateJob, log } from '../src/db.js';
import { BrowserManager } from '../src/browser.js';
import { WeiboAdapter } from '../src/weibo-adapter.js';
import '../src/verification-workflow.js';

const manager = new BrowserManager(undefined, { headless: true });
const adapter = new WeiboAdapter(manager), results = [];
try {
  for (const id of ['act_a4509df4-6157-4886-b140-abda5e3840de', 'act_172ff0fe-fd6f-4f58-9f38-f867346a9b0b']) {
    const action = db.prepare('SELECT * FROM action_logs WHERE id=?').get(id);
    if (!action || action.state === 'succeeded') continue;
    const job = getJob(action.job_id);
    if (job.status !== 'stopped') throw Error('原任务状态已变化');
    const account = getAccount(action.account_id), topic = listTopics().find(t => t.id === action.topic_id);
    if (account.uid !== '7980323573') throw Error('账号UID不符');
    let result;
    try { result = await adapter.findPublishedPost(account, { content: action.content, topic, startedAt: action.started_at, syncToHome: job.config.syncToHome === true }); }
    catch (error) { result = { state: 'uncertain', reason: `超话只读核对未完成：${error.message}` }; }
    db.exec('BEGIN IMMEDIATE');
    try {
      updateActionLog(id, { state: result.state, url: result.url || action.url, error: result.reason || '' });
      db.prepare("UPDATE task_step_state SET state=?,outcome=? WHERE job_id=? AND step_key=?").run(result.state === 'succeeded' ? 'done' : 'review', result.state, job.id, action.step_key);
      const metrics = { success: 0, failed: 0, uncertain: 0, skipped: 0 };
      for (const row of db.prepare('SELECT outcome,COUNT(*) n FROM task_step_state WHERE job_id=? GROUP BY outcome').all(job.id)) {
        const key = row.outcome === 'succeeded' ? 'success' : row.outcome;
        if (key in metrics) metrics[key] = Number(row.n);
      }
      updateJob(job.id, { metrics });
      log('info', `UID 7980323573 历史验证码误判复核：${id}，原状态 ${action.state}，核对结果 ${result.state}；${result.reason || '超话详情唯一匹配'}`, { accountId: account.id, topicId: topic.id, url: result.url });
      db.exec('COMMIT');
    } catch (error) { db.exec('ROLLBACK'); throw error; }
    results.push({ id, ...result });
  }
} finally { await manager.close(); }
console.log(JSON.stringify(results));
