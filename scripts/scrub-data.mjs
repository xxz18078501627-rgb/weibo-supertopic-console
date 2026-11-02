#!/usr/bin/env node
// 从本机运行库生成「干净种子库」：保留文案/文案组/超话/默认参数，删除一切账号痕迹。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const source = process.env.WEIBO_SEED_SOURCE || path.join(root, 'data', 'console.sqlite');
const target = process.argv[2] || path.join(root, 'dist', 'seed', 'console.sqlite');

const CLEAR = [
  'accounts', 'account_groups', 'account_restrictions', 'jobs', 'action_logs', 'system_logs',
  'checkins', 'comment_history', 'task_step_state', 'task_rounds', 'verification_cards', 'daily_stats',
  'post_result_repairs'
];
const DROP_SETTINGS = ['account_deletion_v3', 'last_comment_material_id', 'last_comment_text', 'retention_v1'];
const KEEP_TABLES = ['post_materials', 'comment_materials', 'shared_post_materials', 'topics'];

if (!fs.existsSync(source)) {
  console.error('找不到源数据库：' + source);
  process.exit(1);
}

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'weibo-scrub-'));
const snapshot = path.join(temp, 'console.sqlite');
// VACUUM INTO 会在事务里把 WAL 内容一起写出，避免直接拷贝 -wal 拿到半截数据。
{
  const origin = new DatabaseSync(source, { readOnly: true });
  try { origin.exec("VACUUM INTO '" + snapshot.replaceAll("'", "''") + "'"); }
  finally { origin.close(); }
}

const db = new DatabaseSync(snapshot);
const summary = {};
try {
  db.exec('PRAGMA journal_mode=DELETE');
  for (const table of CLEAR) {
    const exists = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(table);
    if (!exists) continue;
    db.exec('PRAGMA foreign_keys=OFF');
    db.exec('DELETE FROM ' + table);
  }
  try { db.exec('DELETE FROM sqlite_sequence'); } catch {}
  for (const key of DROP_SETTINGS) db.prepare('DELETE FROM settings WHERE key=?').run(key);
  db.prepare("UPDATE settings SET value='0' WHERE key IN ('post_sequence','comment_sequence')").run();

  const templates = db.prepare("SELECT value FROM settings WHERE key='task_templates'").get();
  if (templates) {
    const list = JSON.parse(templates.value || '[]');
    for (const item of list) {
      if (!item?.config) continue;
      item.config.accountIds = [];
      delete item.config.accountIdentities;
      item.config.topicIds = Array.isArray(item.config.topicIds) ? item.config.topicIds.slice(0, 1) : [];
    }
    db.prepare("UPDATE settings SET value=? WHERE key='task_templates'").run(JSON.stringify(list));
  }

  db.exec('VACUUM');
  for (const table of [...CLEAR, ...KEEP_TABLES]) {
    try { summary[table] = db.prepare('SELECT COUNT(*) n FROM ' + table).get().n; } catch {}
  }
  for (const table of CLEAR) if (summary[table]) throw new Error('清理未完成：' + table + ' 仍有 ' + summary[table] + ' 行');
} finally {
  db.close();
}

fs.mkdirSync(path.dirname(target), { recursive: true });
fs.copyFileSync(path.join(temp, 'console.sqlite'), target);
fs.rmSync(temp, { recursive: true, force: true });
console.log('已生成干净种子库：' + target);
console.log(JSON.stringify(summary, null, 2));
