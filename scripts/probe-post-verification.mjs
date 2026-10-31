import fs from 'node:fs';
import path from 'node:path';
import { db, getJob, getAccount, createJob, updateJob, listActionLogs } from '../src/db.js';
import { BrowserManager } from '../src/browser.js';
import { WeiboAdapter } from '../src/weibo-adapter.js';
import { TaskRunner } from '../src/runner.js';

if (db.prepare("SELECT 1 FROM jobs WHERE status IN ('running','waiting','paused')").get()) throw Error('活动任务尚未结束');
const account = db.prepare("SELECT * FROM accounts WHERE uid='7980323573' AND deleted_at IS NULL").get();
const source = getJob('job_18fcaeb2-5c7d-4f5b-93b6-876a6e5e782b');
const out = path.resolve('work/post-probe-7980323573'); fs.mkdirSync(out, { recursive: true, mode: 0o700 });
const events = [];
const safeUrl = value => { try { const url = new URL(value); return url.origin + url.pathname; } catch { return ''; } };
function summary(value, depth = 0) {
  if (!value || typeof value !== 'object' || depth > 4) return undefined;
  const result = {};
  for (const [key, item] of Object.entries(value)) {
    if (/^(ok|success|code|errno|error_code|id|idstr|mid)$/i.test(key)) result[key] = typeof item === 'object' ? summary(item, depth + 1) : item;
    else if (/^(msg|message|error|errmsg|tip|reason)$/i.test(key) && typeof item === 'string') result[key] = item.replace(/https?:\/\/[^\s"'<>]+/g, safeUrl);
    else if (/url|captcha|verify|redirect/i.test(key)) result[key] = typeof item === 'string' ? safeUrl(item) || '[present]' : summary(item, depth + 1);
    else if (item && typeof item === 'object' && !Array.isArray(item)) result[key] = summary(item, depth + 1);
  }
  return { keys: Object.keys(value), ...result };
}
const manager = new BrowserManager(undefined, { headless: true });
const originalOpen = manager.openLocked.bind(manager);
manager.openLocked = async (...args) => {
  const context = await originalOpen(...args);
  if (!context.__probe) {
    context.__probe = true;
    context.on('response', async response => {
      const url = safeUrl(response.url());
      if (response.request().method() === 'POST' && /weibo|captcha|verify|geetest/.test(url)) {
        const payload = await response.json().catch(() => null);
        events.push({ at: new Date().toISOString(), type: 'response', url, status: response.status(), payload: summary(payload) });
      }
    });
    context.on('page', page => events.push({ at: new Date().toISOString(), type: 'new-page', url: safeUrl(page.url()) }));
  }
  return context;
};
const adapter = new WeiboAdapter(manager);
let submits = 0;
const originalPost = adapter.post.bind(adapter);
adapter.post = (a, t, text, options) => originalPost(a, t, text, { ...options, onSubmit: () => {
  if (++submits > 1) throw Error('单次实测提交保护');
  events.push({ at: new Date().toISOString(), type: 'submit' }); options.onSubmit();
} });
const config = { ...source.config, accountIds: [account.id], rounds: 1, schedulerVersion: 3,
  actionPlan: [{ type: 'post', count: 1, intervalSeconds: source.config.actionPlan.find(x => x.type === 'post').intervalSeconds }], segmentIds: ['probe-post'], roundIntervalSeconds: 0 };
const job = createJob(config);
updateJob(job.id, { cursor: { stepIndex: 0, diagnosticSource: source.id } });
fs.writeFileSync(path.join(out, 'job.json'), JSON.stringify({ jobId: job.id, uid: account.uid }));
try {
  const runner = new TaskRunner(adapter); await runner.run(job.id);
  for (const [index, page] of (manager.context?.pages() || []).entries()) {
    events.push({ type: 'page-state', url: safeUrl(page.url()), frames: page.frames().map(frame => safeUrl(frame.url())),
      evidence: await page.evaluate(() => [...document.querySelectorAll('iframe,[class*="captcha"],[class*="verify"],[class*="geetest"],[class*="modal"]')].map(e => ({ tag: e.tagName, class: e.className, visible: !!(e.getBoundingClientRect().width && e.getBoundingClientRect().height), text: (e.innerText || '').slice(0, 300) })).slice(0, 30)).catch(() => []) });
    await page.screenshot({ path: path.join(out, `page-${index}.png`) }).catch(() => {});
  }
  events.push({ type: 'result', jobId: job.id, status: getJob(job.id).status, actions: listActionLogs(job.id).map(a => ({ id: a.id, state: a.state, error: a.error })) });
} finally {
  await manager.close(); fs.writeFileSync(path.join(out, 'events.json'), JSON.stringify(events, null, 2), { mode: 0o600 });
}
console.log(JSON.stringify({ jobId: job.id, submits, out, events }));
