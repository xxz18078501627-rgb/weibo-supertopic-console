import { db, getAccount } from './db.js';
import { id, now } from './util.js';

db.exec(`CREATE TABLE IF NOT EXISTS account_groups (
  id TEXT PRIMARY KEY, name TEXT NOT NULL UNIQUE, created_at TEXT NOT NULL
)`);
if (!db.prepare('PRAGMA table_info(accounts)').all().some(column => column.name === 'group_id')) {
  db.exec('ALTER TABLE accounts ADD COLUMN group_id TEXT');
}

export function listAccountGroups() {
  return [{ id: '', name: '未分组' }, ...db.prepare('SELECT * FROM account_groups ORDER BY created_at,id').all()];
}

function groupName(value) {
  const name = String(value || '').trim();
  if (!name || name.length > 40 || name === '未分组') throw Object.assign(new Error('分组名称须为 1–40 字，且不能使用“未分组”'), { statusCode: 400 });
  return name;
}

export function saveAccountGroup(groupId, name) {
  name = groupName(name);
  if (db.prepare('SELECT id FROM account_groups WHERE name=? AND id<>?').get(name, groupId || '')) throw Object.assign(new Error('分组名称已存在'), { statusCode: 409 });
  if (groupId) {
    if (!db.prepare('UPDATE account_groups SET name=? WHERE id=?').run(name, groupId).changes) throw Object.assign(new Error('分组不存在'), { statusCode: 404 });
  } else {
    groupId = id('group_');
    db.prepare('INSERT INTO account_groups(id,name,created_at) VALUES(?,?,?)').run(groupId, name, now());
  }
  return db.prepare('SELECT * FROM account_groups WHERE id=?').get(groupId);
}

export function deleteAccountGroup(groupId) {
  if (!groupId || !db.prepare('SELECT id FROM account_groups WHERE id=?').get(groupId)) throw Object.assign(new Error('分组不存在'), { statusCode: 404 });
  db.exec('BEGIN IMMEDIATE');
  try {
    db.prepare('UPDATE accounts SET group_id=NULL WHERE group_id=?').run(groupId);
    db.prepare('DELETE FROM account_groups WHERE id=?').run(groupId);
    db.exec('COMMIT');
  } catch (error) { db.exec('ROLLBACK'); throw error; }
}

export function moveAccountsToGroup(accountIds, groupId) {
  if (!Array.isArray(accountIds) || !accountIds.length) throw Object.assign(new Error('请选择账号'), { statusCode: 400 });
  if (groupId && !db.prepare('SELECT id FROM account_groups WHERE id=?').get(groupId)) throw Object.assign(new Error('分组不存在'), { statusCode: 404 });
  return [...new Set(accountIds)].map(accountId => {
    const account = getAccount(accountId);
    if (!account || account.deleted_at) return { id: accountId, ok: false, error: '账号不存在' };
    db.prepare('UPDATE accounts SET group_id=?,updated_at=? WHERE id=?').run(groupId || null, now(), accountId);
    return { id: accountId, ok: true };
  });
}
