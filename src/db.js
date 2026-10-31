import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { config, defaultTaskConfig } from './config.js';
import { id, json, now } from './util.js';
import { migrateSharedMaterials, migrateAccountDeletion } from './migrations.js';
import { normalizeTaskSettings } from '../public/defaults.js';

fs.mkdirSync(config.dataDir, { recursive: true, mode: 0o700 });
fs.mkdirSync(path.join(config.dataDir, 'profiles'), { recursive: true, mode: 0o700 });

export const db = new DatabaseSync(path.join(config.dataDir, 'console.sqlite'));
db.exec('PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;');
db.exec(`
CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS accounts (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  nickname TEXT,
  uid TEXT,
  enabled INTEGER NOT NULL DEFAULT 1,
  sort_order INTEGER NOT NULL,
  profile_dir TEXT NOT NULL,
  auth_status TEXT NOT NULL DEFAULT 'unknown',
  last_checked_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS topics (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  url TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  sort_order INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS post_materials (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  text TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS comment_materials (
  id TEXT PRIMARY KEY,
  text TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS jobs (
  id TEXT PRIMARY KEY,
  status TEXT NOT NULL,
  config_json TEXT NOT NULL,
  cursor_json TEXT NOT NULL,
  metrics_json TEXT NOT NULL,
  wait_reason TEXT,
  paused_by_user INTEGER NOT NULL DEFAULT 0,
  stop_requested INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS action_logs (
  id TEXT PRIMARY KEY,
  job_id TEXT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  step_key TEXT NOT NULL,
  kind TEXT NOT NULL,
  account_id TEXT REFERENCES accounts(id),
  topic_id TEXT REFERENCES topics(id),
  target_id TEXT,
  content TEXT,
  state TEXT NOT NULL,
  url TEXT,
  error TEXT,
  started_at TEXT NOT NULL,
  completed_at TEXT,
  receipt_id TEXT,
  receipt_url TEXT,
  UNIQUE(job_id, step_key)
);
CREATE TABLE IF NOT EXISTS comment_history (
  account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  target_id TEXT NOT NULL,
  comment_url TEXT,
  created_at TEXT NOT NULL,
  PRIMARY KEY(account_id, target_id)
);
CREATE TABLE IF NOT EXISTS checkins (
  account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  topic_id TEXT NOT NULL REFERENCES topics(id) ON DELETE CASCADE,
  local_date TEXT NOT NULL,
  status TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY(account_id, topic_id, local_date)
);
CREATE TABLE IF NOT EXISTS account_restrictions (
  account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  type TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT '',
  identity TEXT,
  reason TEXT,
  detected_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  job_id TEXT,
  PRIMARY KEY(account_id, type, kind)
);
CREATE INDEX IF NOT EXISTS idx_account_restrictions_expiry ON account_restrictions(expires_at);
CREATE TABLE IF NOT EXISTS system_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  level TEXT NOT NULL,
  message TEXT NOT NULL,
  account_id TEXT,
  topic_id TEXT,
  url TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_logs_created ON system_logs(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_actions_job ON action_logs(job_id, started_at);
`);

// Keep numbering facts with the action; existing databases are upgraded in place.
for (const sql of [
  'ALTER TABLE action_logs ADD COLUMN sequence_number INTEGER',
  'ALTER TABLE action_logs ADD COLUMN sequence_confirmed INTEGER NOT NULL DEFAULT 0',
  'ALTER TABLE action_logs ADD COLUMN receipt_id TEXT',
  'ALTER TABLE action_logs ADD COLUMN receipt_url TEXT'
]) { try { db.exec(sql); } catch {} }

const settingStmt = db.prepare('SELECT value FROM settings WHERE key = ?');
const upsertSettingStmt = db.prepare(`
  INSERT INTO settings(key, value) VALUES(?, ?)
  ON CONFLICT(key) DO UPDATE SET value = excluded.value
`);

export function getSetting(key, fallback = null) {
  const row = settingStmt.get(key);
  return row ? json(row.value, row.value) : fallback;
}

export function setSetting(key, value) {
  upsertSettingStmt.run(key, JSON.stringify(value));
}

export function recordAccountRestriction({ accountId, type, kind = '', identity = '', reason = '', detectedAt = now(), expiresAt, jobId = '' }) {
  if (!accountId || !type || !expiresAt) return null;
  db.prepare(`INSERT INTO account_restrictions(account_id,type,kind,identity,reason,detected_at,expires_at,job_id)
    VALUES(?,?,?,?,?,?,?,?)
    ON CONFLICT(account_id,type,kind) DO UPDATE SET identity=excluded.identity,reason=excluded.reason,
      detected_at=excluded.detected_at,
      expires_at=CASE WHEN excluded.expires_at > account_restrictions.expires_at THEN excluded.expires_at ELSE account_restrictions.expires_at END,
      job_id=excluded.job_id`).run(accountId, type, kind || '', identity || '', reason || '', detectedAt, expiresAt, jobId || '');
  return db.prepare('SELECT * FROM account_restrictions WHERE account_id=? AND type=? AND kind=?').get(accountId, type, kind || '');
}

export function listActiveAccountRestrictions(at = now()) {
  return db.prepare('SELECT * FROM account_restrictions WHERE expires_at > ? ORDER BY expires_at, account_id').all(at)
    .map(row => ({ accountId: row.account_id, type: row.type, kind: row.kind || '', identity: row.identity || '', reason: row.reason || '', detectedAt: row.detected_at, expiresAt: row.expires_at, jobId: row.job_id || '' }));
}

export function seedAccountRestrictionsFromJobs({ at = now(), muteMs = 24 * 60 * 60 * 1000, frequentMs = 60 * 60 * 1000 } = {}) {
  const jobs = db.prepare('SELECT id,cursor_json FROM jobs ORDER BY created_at DESC LIMIT 200').all();
  const nowMs = Date.parse(at);
  let inserted = 0;
  for (const job of jobs) {
    let cursor = {};
    try { cursor = JSON.parse(job.cursor_json || '{}'); } catch {}
    const items = [];
    for (const item of cursor.muteLimits || []) items.push({ ...item, type: 'mute', kind: '', duration: muteMs });
    for (const item of cursor.rateLimits || []) items.push({ ...item, type: 'frequent', kind: item.kind || '', duration: frequentMs });
    for (const item of items) {
      const detected = Date.parse(item.at || '');
      if (!item.accountId || !Number.isFinite(detected) || detected + item.duration <= nowMs) continue;
      recordAccountRestriction({ accountId: item.accountId, type: item.type, kind: item.kind, identity: item.identity || '', reason: item.reason || '', detectedAt: item.at, expiresAt: new Date(detected + item.duration).toISOString(), jobId: job.id });
      inserted += 1;
    }
  }
  return inserted;
}

if (getSetting('task_defaults') == null) setSetting('task_defaults', defaultTaskConfig);
export function migrateRefreshDefaults() {
  if (getSetting('refresh_default_v2', false) === true) return false;
  let changed = false;
  const defaults = getSetting('task_defaults', {});
  if (Number(defaults?.candidateRefreshSeconds) === 30) {
    setSetting('task_defaults', { ...defaults, candidateRefreshSeconds: 3 });
    changed = true;
  }
  const templates = getSetting('task_templates', []);
  const nextTemplates = (Array.isArray(templates) ? templates : []).map(template => {
    if (Number(template?.config?.candidateRefreshSeconds) !== 30) return template;
    changed = true;
    return { ...template, config: { ...template.config, candidateRefreshSeconds: 3 } };
  });
  if (nextTemplates.some((template, index) => template !== (Array.isArray(templates) ? templates[index] : null))) setSetting('task_templates', nextTemplates);
  setSetting('refresh_default_v2', true);
  return changed;
}
migrateRefreshDefaults();
// Only editable settings/templates migrate. Job snapshots retain their original timing.
const migratedDefaults = normalizeTaskSettings(getSetting('task_defaults', {}));
if (JSON.stringify(migratedDefaults) !== JSON.stringify(getSetting('task_defaults'))) setSetting('task_defaults', migratedDefaults);
const templates = getSetting('task_templates', []);
const migratedTemplates = templates.map(template => ({ ...template, config: normalizeTaskSettings(template.config || {}) }));
if (JSON.stringify(migratedTemplates) !== JSON.stringify(templates)) setSetting('task_templates', migratedTemplates);
if (getSetting('comment_sequence') == null) setSetting('comment_sequence', 0);
migrateSharedMaterials(db, config.dataDir);
migrateAccountDeletion(db, config.dataDir);
if (getSetting('post_sequence') == null) setSetting('post_sequence', 0);

export function listAccounts(enabledOnly = false) {
  const sql = `SELECT * FROM accounts WHERE deleted_at IS NULL ${enabledOnly ? "AND enabled = 1 AND cleanup_state IS NULL" : ''} ORDER BY sort_order, created_at`;
  return db.prepare(sql).all().map(normalizeAccount);
}

export function getAccount(accountId) {
  const row = db.prepare('SELECT * FROM accounts WHERE id = ?').get(accountId);
  return row ? normalizeAccount(row) : null;
}

function normalizeAccount(row) {
  return { ...row, enabled: Boolean(row.enabled), postMaterialCount: Number(row.post_material_count || 0) };
}

export function createAccount(name = '等待扫码') {
  const accountId = id('acct_');
  const profileDir = path.join(config.dataDir, 'profiles', accountId);
  fs.mkdirSync(profileDir, { recursive: true, mode: 0o700 });
  const stamp = now();
  const sortOrder = Number(db.prepare('SELECT COALESCE(MAX(sort_order), -1) + 1 AS n FROM accounts').get().n);
  db.prepare(`INSERT INTO accounts(id,name,sort_order,profile_dir,created_at,updated_at) VALUES(?,?,?,?,?,?)`)
    .run(accountId, name.trim(), sortOrder, profileDir, stamp, stamp);
  return getAccount(accountId);
}

export function updateAccount(accountId, patch) {
  const current = getAccount(accountId);
  if (!current || current.deleted_at || current.cleanup_state) return null;
  db.prepare(`UPDATE accounts SET name=?, enabled=?, sort_order=?, updated_at=? WHERE id=?`).run(
    String(patch.name ?? current.name).trim(), patch.enabled == null ? Number(current.enabled) : Number(Boolean(patch.enabled)),
    Number.isFinite(Number(patch.sortOrder)) ? Number(patch.sortOrder) : current.sort_order, now(), accountId
  );
  return getAccount(accountId);
}

export function reorderAccounts(ids) {
  const update = db.prepare('UPDATE accounts SET sort_order=?, updated_at=? WHERE id=? AND deleted_at IS NULL');
  const stamp = now();
  db.exec('BEGIN');
  try {
    [...new Set(ids)].forEach((accountId, index) => update.run(index, stamp, accountId));
    db.exec('COMMIT');
  } catch (error) { db.exec('ROLLBACK'); throw error; }
  return listAccounts();
}

export function updateAccountAuth(accountId, identity) {
  const current = getAccount(accountId);
  if (!current) throw new Error('账号不存在');
  if (identity.status === 'valid' && current.uid && String(current.uid) !== String(identity.uid)) {
    throw new Error('扫码账号与原账号 UID 不一致，请使用原账号扫码');
  }
  if (identity.status === 'valid' && !current.uid) {
    const duplicate = db.prepare('SELECT id FROM accounts WHERE uid=? AND id<>? AND deleted_at IS NULL').get(String(identity.uid), accountId);
    if (duplicate) throw new Error('这个微博账号已存在，请使用已有账号');
  }
  const nickname = identity.status === 'valid' ? (identity.nickname || current.nickname) : current.nickname;
  const uid = identity.status === 'valid' ? String(identity.uid) : current.uid;
  db.prepare(`UPDATE accounts SET name=?, nickname=?, uid=?, auth_status=?, last_checked_at=?, updated_at=? WHERE id=?`).run(
    nickname || uid || current.name, nickname || null, uid || null, identity.status, now(), now(), accountId
  );
  return getAccount(accountId);
}

export function deleteAccount(accountId) {
  const account = getAccount(accountId);
  if (!account || account.deleted_at) throw new Error('账号不存在');
  const root = path.resolve(config.dataDir, 'profiles');
  const expected = path.join(root, accountId);
  if (!/^acct_[a-zA-Z0-9-]+$/.test(accountId) || path.resolve(account.profile_dir) !== expected || path.dirname(expected) !== root) throw new Error('登录资料目录不符合预期，无法自动清理');
  db.prepare("UPDATE accounts SET enabled=0, cleanup_state='pending', cleanup_error=NULL, updated_at=? WHERE id=?").run(now(), accountId);
  try {
    if (fs.existsSync(expected) && fs.lstatSync(expected).isSymbolicLink()) throw new Error('登录资料目录是符号链接');
    fs.rmSync(expected, { recursive: true, force: true });
    db.prepare("UPDATE accounts SET deleted_at=?, cleanup_state='complete', updated_at=? WHERE id=?").run(now(), now(), accountId);
  } catch (error) {
    db.prepare('UPDATE accounts SET cleanup_error=?, updated_at=? WHERE id=?').run(String(error.message), now(), accountId);
    throw new Error(`登录资料清理失败，可重试：${error.message}`);
  }
}

export function listTopics(enabledOnly = false) {
  return db.prepare(`SELECT * FROM topics ${enabledOnly ? 'WHERE enabled=1' : ''} ORDER BY sort_order, created_at`).all()
    .map(row => ({ ...row, enabled: Boolean(row.enabled) }));
}

export function createTopic({ name, url }) {
  const stamp = now();
  const topicId = id('topic_');
  const sortOrder = Number(db.prepare('SELECT COALESCE(MAX(sort_order), -1) + 1 AS n FROM topics').get().n);
  db.prepare(`INSERT INTO topics(id,name,url,sort_order,created_at,updated_at) VALUES(?,?,?,?,?,?)`)
    .run(topicId, name.trim(), url.trim(), sortOrder, stamp, stamp);
  return db.prepare('SELECT * FROM topics WHERE id=?').get(topicId);
}

export function updateTopic(topicId, patch) {
  const current = db.prepare('SELECT * FROM topics WHERE id=?').get(topicId);
  if (!current) return null;
  db.prepare(`UPDATE topics SET name=?,url=?,enabled=?,sort_order=?,updated_at=? WHERE id=?`).run(
    String(patch.name ?? current.name).trim(), String(patch.url ?? current.url).trim(),
    patch.enabled == null ? current.enabled : Number(Boolean(patch.enabled)),
    Number.isFinite(Number(patch.sortOrder)) ? Number(patch.sortOrder) : current.sort_order, now(), topicId
  );
  return db.prepare('SELECT * FROM topics WHERE id=?').get(topicId);
}

export function deleteTopic(topicId) {
  return db.prepare('DELETE FROM topics WHERE id=?').run(topicId).changes > 0;
}

export function deleteTopics(topicIds) {
  const remove = db.prepare('DELETE FROM topics WHERE id=?');
  return deleteMany(remove, topicIds);
}

export function listPostMaterials() {
  return db.prepare('SELECT * FROM shared_post_materials ORDER BY created_at,id').all()
    .map(row => ({ ...row, enabled: Boolean(row.enabled) }));
}

try { db.exec("ALTER TABLE post_materials ADD COLUMN group_id TEXT NOT NULL DEFAULT ''"); } catch {}
try { db.exec("ALTER TABLE comment_materials ADD COLUMN group_id TEXT NOT NULL DEFAULT ''"); } catch {}
try { db.exec("ALTER TABLE shared_post_materials ADD COLUMN group_id TEXT NOT NULL DEFAULT ''"); } catch {}

export function listMaterialGroups() { return getSetting('material_groups', []); }
export function createMaterialGroup(name) { const groups = listMaterialGroups(); const group = { id: id('mg_'), name: String(name || '').trim().slice(0, 20) }; if (!group.name) throw new Error('请输入分组名称'); groups.push(group); setSetting('material_groups', groups); return group; }
export function deleteMaterialGroup(groupId) {
  setSetting('material_groups', listMaterialGroups().filter(group => group.id !== groupId));
  for (const table of ['post_materials', 'comment_materials', 'shared_post_materials']) db.prepare('UPDATE ' + table + " SET group_id='' WHERE group_id=?").run(groupId);
  const clean = list => Array.isArray(list) ? list.filter(idValue => idValue !== groupId) : list;
  const defaults = getSetting('task_defaults', {});
  if (Array.isArray(defaults.postGroupIds) || Array.isArray(defaults.commentGroupIds))
    setSetting('task_defaults', { ...defaults, postGroupIds: clean(defaults.postGroupIds), commentGroupIds: clean(defaults.commentGroupIds) });
  const templates = getSetting('task_templates', []);
  let changed = false;
  const nextTemplates = templates.map(template => {
    const configValue = template.config || {};
    if (!Array.isArray(configValue.postGroupIds) && !Array.isArray(configValue.commentGroupIds)) return template;
    changed = true;
    return { ...template, config: { ...configValue, postGroupIds: clean(configValue.postGroupIds), commentGroupIds: clean(configValue.commentGroupIds) } };
  });
  if (changed) setSetting('task_templates', nextTemplates);
}
export function setMaterialsGroup(type, ids, groupId) { const table = type === 'post' ? 'shared_post_materials' : 'comment_materials'; const update = db.prepare('UPDATE ' + table + ' SET group_id=? WHERE id=?'); db.exec('BEGIN'); try { for (const materialId of ids) update.run(groupId || '', materialId); db.exec('COMMIT'); } catch (error) { db.exec('ROLLBACK'); throw error; } return type === 'post' ? listPostMaterials() : listCommentMaterials(); }

export function addPostMaterials(accountOrTexts, legacyTexts, groupId = '') {
  const texts = legacyTexts || accountOrTexts;
  const insert = db.prepare('INSERT OR IGNORE INTO shared_post_materials(id,text,group_id,created_at) VALUES(?,?,?,?)');
  db.exec('BEGIN');
  try {
    for (const text of texts) if (String(text).trim()) insert.run(id('post_'), String(text).trim(), groupId || '', now());
    db.exec('COMMIT');
  } catch (error) { db.exec('ROLLBACK'); throw error; }
  return listPostMaterials();
}

export function deletePostMaterial(materialId) {
  return db.prepare('DELETE FROM shared_post_materials WHERE id=?').run(materialId).changes > 0;
}

export function deletePostMaterials(materialIds) {
  return deleteMany(db.prepare('DELETE FROM shared_post_materials WHERE id=?'), materialIds);
}

export function listCommentMaterials() {
  return db.prepare('SELECT * FROM comment_materials ORDER BY created_at').all()
    .map(row => ({ ...row, enabled: Boolean(row.enabled) }));
}

export function addCommentMaterials(texts, groupId = '') {
  const insert = db.prepare('INSERT INTO comment_materials(id,text,group_id,created_at) VALUES(?,?,?,?)');
  db.exec('BEGIN');
  try {
    for (const text of texts) {
      const raw = String(text).trim();
      if (raw && !db.prepare('SELECT 1 FROM comment_materials WHERE TRIM(text)=?').get(raw)) insert.run(id('comment_'), raw, groupId || '', now());
    }
    db.exec('COMMIT');
  } catch (error) { db.exec('ROLLBACK'); throw error; }
  return listCommentMaterials();
}

export function deleteCommentMaterial(materialId) {
  return db.prepare('DELETE FROM comment_materials WHERE id=?').run(materialId).changes > 0;
}

export function deleteCommentMaterials(materialIds) {
  return deleteMany(db.prepare('DELETE FROM comment_materials WHERE id=?'), materialIds);
}

function deleteMany(statement, ids) {
  const results = [];
  db.exec('BEGIN');
  try {
    for (const itemId of [...new Set(ids)]) results.push({ id: itemId, ok: statement.run(itemId).changes > 0 });
    db.exec('COMMIT');
  } catch (error) { db.exec('ROLLBACK'); throw error; }
  return results;
}

export function pickPostMaterial(accountId) {
  const rows = listPostMaterials().filter(item => item.enabled);
  return rows.length ? rows[Math.floor(Math.random() * rows.length)] : null;
}

export function pickCommentMaterial() {
  const rows = db.prepare('SELECT * FROM comment_materials WHERE enabled=1').all();
  if (!rows.length) return null;
  const lastText = getSetting('last_comment_text', '') || rows.find(item => item.id === getSetting('last_comment_material_id', ''))?.text?.trim();
  const choices = rows.filter(item => item.text.trim() !== lastText);
  if (!choices.length) throw new Error('没有与上次不同的评论原文，请补充文案');
  const selected = choices[Math.floor(Math.random() * choices.length)];
  setSetting('last_comment_material_id', selected.id);
  setSetting('last_comment_text', selected.text.trim());
  return selected;
}

export function nextCommentSequence() {
  return nextSequence('comment');
}

export function nextSequence(kind) {
  const key = kind === 'post' ? 'post_sequence' : 'comment_sequence';
  db.exec('BEGIN IMMEDIATE');
  try {
    const next = Number(getSetting(key, 0)) + 1;
    setSetting(key, next);
    db.exec('COMMIT');
    return next;
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

export function createJob(snapshot) {
  const jobId = id('job_');
  const stamp = now();
  db.prepare(`INSERT INTO jobs(id,status,config_json,cursor_json,metrics_json,created_at,updated_at) VALUES(?,?,?,?,?,?,?)`).run(
    jobId, 'running', JSON.stringify(snapshot), JSON.stringify({ stepIndex: 0 }),
    JSON.stringify({ success: 0, failed: 0, uncertain: 0, skipped: 0 }), stamp, stamp
  );
  return getJob(jobId);
}

export function getJob(jobId) {
  const row = db.prepare('SELECT * FROM jobs WHERE id=?').get(jobId);
  return row ? normalizeJob(row) : null;
}

export function getActiveJob() {
  const row = db.prepare(`SELECT * FROM jobs WHERE status IN ('running','paused','waiting') ORDER BY created_at DESC LIMIT 1`).get();
  return row ? normalizeJob(row) : null;
}

export function listJobs(limit = 20) {
  return db.prepare('SELECT * FROM jobs ORDER BY created_at DESC LIMIT ?').all(limit).map(normalizeJob);
}

function normalizeJob(row) {
  return {
    ...row,
    config: json(row.config_json, {}), cursor: json(row.cursor_json, { stepIndex: 0 }),
    metrics: json(row.metrics_json, {}), pausedByUser: Boolean(row.paused_by_user), stopRequested: Boolean(row.stop_requested)
  };
}

export function updateJob(jobId, patch) {
  const job = getJob(jobId);
  if (!job) return null;
  db.prepare(`UPDATE jobs SET status=?,config_json=?,cursor_json=?,metrics_json=?,wait_reason=?,paused_by_user=?,stop_requested=?,updated_at=? WHERE id=?`).run(
    patch.status ?? job.status, JSON.stringify(patch.config ?? job.config), JSON.stringify(patch.cursor ?? job.cursor), JSON.stringify(patch.metrics ?? job.metrics),
    patch.waitReason === undefined ? job.wait_reason : patch.waitReason,
    patch.pausedByUser === undefined ? Number(job.pausedByUser) : Number(Boolean(patch.pausedByUser)),
    patch.stopRequested === undefined ? Number(job.stopRequested) : Number(Boolean(patch.stopRequested)), now(), jobId
  );
  return getJob(jobId);
}

export function createActionLog(data) {
  const actionId = id('act_');
  db.prepare(`INSERT INTO action_logs(id,job_id,step_key,kind,account_id,topic_id,target_id,content,state,url,error,sequence_number,sequence_confirmed,receipt_id,receipt_url,started_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run(actionId, data.jobId, data.stepKey, data.kind, data.accountId, data.topicId, data.targetId || null,
      data.content || null, data.state || 'started', data.url || null, data.error || null,
      data.sequenceNumber ?? null, Number(Boolean(data.sequenceConfirmed)), data.receiptId || null, data.receiptUrl || null, now());
  return actionId;
}

export function updateActionLog(actionId, patch) {
  const row = db.prepare('SELECT * FROM action_logs WHERE id=?').get(actionId);
  if (!row) return null;
  const state = patch.state ?? row.state;
  db.prepare(`UPDATE action_logs SET state=?,target_id=?,content=?,url=?,error=?,sequence_number=?,sequence_confirmed=?,receipt_id=?,receipt_url=?,completed_at=? WHERE id=?`).run(
    state, patch.targetId ?? row.target_id, patch.content ?? row.content, patch.url ?? row.url,
    patch.error ?? row.error, 'sequenceNumber' in patch ? patch.sequenceNumber : row.sequence_number,
    patch.sequenceConfirmed == null ? row.sequence_confirmed : Number(Boolean(patch.sequenceConfirmed)),
    patch.receiptId ?? row.receipt_id, patch.receiptUrl ?? row.receipt_url,
    ['succeeded','failed','uncertain','skipped','cancelled'].includes(state) ? now() : row.completed_at, actionId
  );
  return db.prepare('SELECT * FROM action_logs WHERE id=?').get(actionId);
}

export function listActionLogs(jobId, limit = 200) {
  return db.prepare(`SELECT l.*,a.name account_name,t.name topic_name FROM action_logs l
    LEFT JOIN accounts a ON a.id=l.account_id LEFT JOIN topics t ON t.id=l.topic_id
    WHERE l.job_id=? ORDER BY l.started_at DESC LIMIT ?`).all(jobId, limit);
}

export function findIncompleteAction(jobId) {
  return db.prepare(`SELECT * FROM action_logs WHERE job_id=? AND state IN ('started','submitted') ORDER BY started_at DESC LIMIT 1`).get(jobId);
}

export function getStepAction(jobId, stepKey) {
  return db.prepare('SELECT * FROM action_logs WHERE job_id=? AND step_key=?').get(jobId, stepKey);
}

export function getActionLog(actionId) {
  return db.prepare('SELECT * FROM action_logs WHERE id=?').get(actionId);
}

export function hasCommented(accountId, targetId) {
  return Boolean(db.prepare(`SELECT 1 FROM comment_history WHERE account_id=? AND target_id=?
    UNION ALL SELECT 1 FROM action_logs WHERE account_id=? AND target_id=? AND kind='comment' AND state IN ('submitted','uncertain') LIMIT 1`)
    .get(accountId, targetId, accountId, targetId));
}

// Return every persisted comment target for the same Weibo identity.  Account ids
// are intentionally not enough here: deleting then re-adding an account creates a
// new local id but it is still the same Weibo user and must not comment again.
export function listCommentedTargetIdsForIdentity(account) {
  const uid = String(account?.uid || '').trim();
  const rows = uid
    ? db.prepare(`SELECT h.target_id FROM comment_history h JOIN accounts a ON a.id=h.account_id
        WHERE a.uid=? AND h.target_id IS NOT NULL
      UNION
      SELECT l.target_id FROM action_logs l JOIN accounts a ON a.id=l.account_id
        WHERE a.uid=? AND l.kind='comment' AND l.target_id IS NOT NULL
          AND l.state IN ('submitted','uncertain','succeeded')`).all(uid, uid)
    : db.prepare(`SELECT target_id FROM comment_history WHERE account_id=? AND target_id IS NOT NULL
      UNION
      SELECT target_id FROM action_logs WHERE account_id=? AND kind='comment' AND target_id IS NOT NULL
        AND state IN ('submitted','uncertain','succeeded')`).all(account?.id || '', account?.id || '');
  return rows.map(row => String(row.target_id));
}

export function recordComment(accountId, targetId, url) {
  db.prepare(`INSERT OR IGNORE INTO comment_history(account_id,target_id,comment_url,created_at) VALUES(?,?,?,?)`).run(accountId, targetId, url || null, now());
}

export function getCheckin(accountId, topicId, localDate) {
  return db.prepare('SELECT * FROM checkins WHERE account_id=? AND topic_id=? AND local_date=?').get(accountId, topicId, localDate);
}

export function recordCheckin(accountId, topicId, localDate, status = 'succeeded') {
  db.prepare(`INSERT INTO checkins(account_id,topic_id,local_date,status,created_at) VALUES(?,?,?,?,?)
    ON CONFLICT(account_id,topic_id,local_date) DO UPDATE SET status=CASE WHEN checkins.status='succeeded' THEN 'succeeded' ELSE excluded.status END,created_at=CASE WHEN checkins.status='succeeded' THEN checkins.created_at ELSE excluded.created_at END`)
    .run(accountId, topicId, localDate, status, now());
}

export function log(level, message, extra = {}) {
  db.prepare('INSERT INTO system_logs(level,message,account_id,topic_id,url,created_at) VALUES(?,?,?,?,?,?)')
    .run(level, message, extra.accountId || null, extra.topicId || null, extra.url || null, now());
}

export function listSystemLogs(limit = 200) {
  return db.prepare(`SELECT l.*,a.name account_name,t.name topic_name FROM system_logs l
    LEFT JOIN accounts a ON a.id=l.account_id LEFT JOIN topics t ON t.id=l.topic_id
    ORDER BY l.created_at DESC LIMIT ?`).all(limit);
}

export function listRecordsByShanghaiDate(date, limit = 500) {
  const logs = db.prepare(`SELECT l.*,a.name account_name,t.name topic_name FROM system_logs l LEFT JOIN accounts a ON a.id=l.account_id LEFT JOIN topics t ON t.id=l.topic_id WHERE strftime('%Y-%m-%d', l.created_at, '+8 hours')=? ORDER BY l.created_at DESC LIMIT ?`).all(date, limit);
  const actions = db.prepare(`SELECT l.*,a.name account_name,t.name topic_name FROM action_logs l LEFT JOIN accounts a ON a.id=l.account_id LEFT JOIN topics t ON t.id=l.topic_id WHERE strftime('%Y-%m-%d', l.started_at, '+8 hours')=? ORDER BY l.started_at DESC LIMIT ?`).all(date, limit);
  const jobs = db.prepare(`SELECT * FROM jobs WHERE strftime('%Y-%m-%d', created_at, '+8 hours')=? ORDER BY created_at DESC LIMIT ?`).all(date, limit).map(normalizeJob);
  return { logs, actions, jobs };
}

// 全天按任务聚合，绕开 listRecordsByShanghaiDate 的 500 条窗口。
export function countActionsByJob(date) {
  const rows = db.prepare("SELECT job_id,state,COUNT(*) total FROM action_logs WHERE strftime('%Y-%m-%d',started_at,'+8 hours')=? GROUP BY job_id,state").all(date);
  const map = {};
  for (const row of rows) {
    const bucket = map[row.job_id] || (map[row.job_id] = { succeeded: 0, failed: 0, uncertain: 0, skipped: 0 });
    if (bucket[row.state] != null) bucket[row.state] += Number(row.total);
  }
  return map;
}

export function clearAllDataForTests() {
  db.exec('DELETE FROM action_logs; DELETE FROM jobs; DELETE FROM checkins; DELETE FROM comment_history; DELETE FROM post_materials; DELETE FROM shared_post_materials; DELETE FROM comment_materials; DELETE FROM topics; DELETE FROM accounts; DELETE FROM account_restrictions; DELETE FROM system_logs;');
  setSetting('last_comment_material_id', '');
  setSetting('comment_sequence', 0);
  setSetting('post_sequence', 0);
  setSetting('last_comment_text', '');
}
