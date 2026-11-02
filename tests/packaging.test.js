import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { execFileSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'weibo-package-'));
process.env.WEIBO_CONSOLE_DATA_DIR = dir;
process.env.WEIBO_CONSOLE_LICENSE = 'off';

const db = await import('../src/db.js');

test('打包剥离后只保留文案与配置', () => {
  const account = db.createAccount('测试账号');
  db.updateAccountAuth(account.id, { status: 'valid', uid: '9999999', nickname: '测试昵称' });
  db.createTopic({ name: '苏新皓', url: 'https://weibo.com/p/100808test' });
  db.addPostMaterials(['保留的发帖文案一', '保留的发帖文案二']);
  db.addCommentMaterials(['保留的评论文案一', '保留的评论文案二']);
  db.log('info', '这条日志不应出现在安装包里');
  db.db.prepare(`INSERT INTO post_result_repairs
    (action_id,job_id,previous_state,next_state,original_error,receipt_id,receipt_url,reason,repaired_at)
    VALUES(?,?,?,?,?,?,?,?,?)`).run('private-action', 'private-job', 'uncertain', 'succeeded',
      '测试昵称的历史异常', '9999999', 'https://weibo.com/detail/9999999', '个人发帖核对记录', new Date().toISOString());

  const target = path.join(dir, 'seed', 'console.sqlite');
  execFileSync(process.execPath, [path.resolve(import.meta.dirname, '..', 'scripts', 'scrub-data.mjs'), target], {
    env: { ...process.env, WEIBO_SEED_SOURCE: path.join(dir, 'console.sqlite') },
    stdio: 'ignore'
  });

  const seed = new DatabaseSync(target);
  try {
    for (const table of ['accounts', 'account_groups', 'account_restrictions', 'jobs', 'action_logs', 'system_logs', 'checkins', 'comment_history', 'task_step_state', 'task_rounds', 'verification_cards', 'daily_stats', 'post_result_repairs']) {
      const exists = seed.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(table);
      if (!exists) continue;
      assert.equal(seed.prepare('SELECT COUNT(*) n FROM ' + table).get().n, 0, table + ' 应为空');
    }
    assert.ok(seed.prepare('SELECT COUNT(*) n FROM shared_post_materials').get().n >= 2);
    assert.ok(seed.prepare('SELECT COUNT(*) n FROM comment_materials').get().n >= 2);
    assert.equal(seed.prepare('SELECT COUNT(*) n FROM topics').get().n, 1);
    const dump = seed.prepare('SELECT value FROM settings').all().map(row => row.value).join('\n');
    assert.equal(dump.includes('测试昵称'), false);
    assert.equal(dump.includes('9999999'), false);
    const templates = seed.prepare("SELECT value FROM settings WHERE key='task_templates'").get();
    if (templates) assert.equal(JSON.parse(templates.value).every(item => (item.config?.accountIds || []).length === 0), true);
    assert.equal(db.db.prepare('SELECT COUNT(*) n FROM post_result_repairs').get().n, 1, '源库的修复记录不应被修改');
    const bytes = fs.readFileSync(target);
    for (const marker of ['private-action', 'private-job', '测试昵称', '个人发帖核对记录']) {
      assert.equal(bytes.includes(Buffer.from(marker)), false, marker + ' 不应残留在种子库文件中');
    }
  } finally {
    seed.close();
  }
});

test.after(async () => {
  await new Promise(resolve => setTimeout(resolve, 200));
  try { db.db.close(); } catch {}
  try { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); } catch {}
});
