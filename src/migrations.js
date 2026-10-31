import fs from 'node:fs';
import path from 'node:path';
import { normalizeTaskSettings } from '../public/defaults.js';

// VACUUM INTO captures WAL-backed data too; copying the main file alone does not.
export function migrateSharedMaterials(db, dataDir) {
  const version = db.prepare("SELECT value FROM settings WHERE key='shared_materials_v2'").get();
  if (version) return null;
  const backupDir = path.join(dataDir, 'backups');
  fs.mkdirSync(backupDir, { recursive: true, mode: 0o700 });
  const backupPath = path.join(backupDir, `before-shared-materials-${Date.now()}.sqlite`);
  db.exec(`VACUUM INTO '${backupPath.replaceAll("'", "''")}'`);
  fs.chmodSync(backupPath, 0o600);
  db.exec('BEGIN IMMEDIATE');
  try {
    db.exec(`CREATE TABLE IF NOT EXISTS shared_post_materials (
      id TEXT PRIMARY KEY, text TEXT NOT NULL UNIQUE,
      enabled INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL
    )`);
    const rows = db.prepare('SELECT * FROM post_materials ORDER BY created_at,id').all();
    const insert = db.prepare(`INSERT INTO shared_post_materials(id,text,enabled,created_at) VALUES(?,?,?,?)
      ON CONFLICT(text) DO UPDATE SET enabled=MAX(shared_post_materials.enabled,excluded.enabled)`);
    for (const row of rows) if (row.text.trim()) insert.run(row.id, row.text.trim(), row.enabled, row.created_at);
    const oldSettings = db.prepare("SELECT value FROM settings WHERE key='task_defaults'").get();
    if (oldSettings) {
      const upgraded = normalizeTaskSettings(JSON.parse(oldSettings.value));
      db.prepare("UPDATE settings SET value=? WHERE key='task_defaults'").run(JSON.stringify(upgraded));
    }
    db.prepare("INSERT INTO settings(key,value) VALUES('shared_materials_v2',?)").run(JSON.stringify({ backupPath }));
    db.exec('COMMIT');
    return backupPath;
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

export function migrateAccountDeletion(db, dataDir) {
  if (db.prepare("SELECT value FROM settings WHERE key='account_deletion_v3'").get()) return;
  const dir = path.join(dataDir, 'backups');
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const backup = path.join(dir, `before-account-deletion-${Date.now()}.sqlite`);
  db.exec(`VACUUM INTO '${backup.replaceAll("'", "''")}'`);
  fs.chmodSync(backup, 0o600);
  db.exec('BEGIN IMMEDIATE');
  try {
    const columns = db.prepare('PRAGMA table_info(accounts)').all().map(row => row.name);
    for (const [name, type] of [['deleted_at', 'TEXT'], ['cleanup_state', 'TEXT'], ['cleanup_error', 'TEXT']]) {
      if (!columns.includes(name)) db.exec(`ALTER TABLE accounts ADD COLUMN ${name} ${type}`);
    }
    db.prepare("INSERT INTO settings(key,value) VALUES('account_deletion_v3',?)").run(JSON.stringify({ backup }));
    db.exec('COMMIT');
  } catch (error) { db.exec('ROLLBACK'); throw error; }
}
