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

  const target = path.join(dir, 'seed', 'console.sqlite');
  execFileSync(process.execPath, [path.resolve(import.meta.dirname, '..', 'scripts', 'scrub-data.mjs'), target], {
    env: { ...process.env, WEIBO_SEED_SOURCE: path.join(dir, 'console.sqlite') },
    stdio: 'ignore'
  });

  const seed = new DatabaseSync(target);
  try {
    for (const table of ['accounts', 'jobs', 'action_logs', 'system_logs', 'checkins', 'comment_history', 'task_step_state', 'verification_cards']) {
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
  } finally {
    seed.close();
  }
});

test.after(() => fs.rmSync(dir, { recursive: true, force: true }));
