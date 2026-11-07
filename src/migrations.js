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

// 文案分组按类型拆分：旧版发帖和评论共用一套组名。迁移时把每个旧组复制为
// post 版（沿用原 id）和 comment 版（新 id），并把评论文案、默认配置、模板里的
// commentGroupIds 重指到 comment 版，做到零数据丢失、类型完全隔离。
export function migrateMaterialGroupsV2(db, dataDir) {
  if (db.prepare("SELECT value FROM settings WHERE key='material_groups_v2'").get()) return null;
  const backupDir = path.join(dataDir, 'backups');
  fs.mkdirSync(backupDir, { recursive: true, mode: 0o700 });
  const backupPath = path.join(backupDir, 'before-material-groups-v2-' + Date.now() + '.sqlite');
  db.exec("VACUUM INTO '" + backupPath.replaceAll("'", "''") + "'");
  fs.chmodSync(backupPath, 0o600);
  const read = key => {
    const row = db.prepare('SELECT value FROM settings WHERE key=?').get(key);
    if (!row) return null;
    try { return JSON.parse(row.value); } catch { return null; }
  };
  const write = (key, value) => db.prepare('INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(key, JSON.stringify(value));
  db.exec('BEGIN IMMEDIATE');
  try {
    const groups = Array.isArray(read('material_groups')) ? read('material_groups') : [];
    const remap = {};
    const nextGroups = [];
    for (const group of groups) {
      if (!group || typeof group.id !== 'string') continue;
      if (group.type === 'comment' || group.type === 'repost') { nextGroups.push({ ...group, type: group.type }); continue; }
      const commentId = group.id + '_comment';
      remap[group.id] = commentId;
      nextGroups.push({ id: group.id, name: String(group.name || '').slice(0, 20), type: 'post' });
      nextGroups.push({ id: commentId, name: String(group.name || '').slice(0, 20), type: 'comment' });
    }
    write('material_groups', nextGroups);
    const remapIds = list => Array.isArray(list) ? [...new Set(list.map(id => remap[id] || id))] : list;
    const defaults = read('task_defaults');
    if (defaults && (Array.isArray(defaults.commentGroupIds) || Array.isArray(defaults.postGroupIds))) {
      write('task_defaults', { ...defaults, commentGroupIds: remapIds(defaults.commentGroupIds), postGroupIds: Array.isArray(defaults.postGroupIds) ? defaults.postGroupIds : [], repostGroupIds: Array.isArray(defaults.repostGroupIds) ? defaults.repostGroupIds : [] });
    }
    const engageDefaults = read('engage_defaults');
    if (engageDefaults) write('engage_defaults', { ...engageDefaults, commentGroupIds: remapIds(engageDefaults.commentGroupIds) });
    const templates = read('task_templates');
    if (Array.isArray(templates)) {
      write('task_templates', templates.map(template => {
        const config = template?.config || {};
        if (!Array.isArray(config.commentGroupIds) && !Array.isArray(config.postGroupIds)) return template;
        return { ...template, config: { ...config, commentGroupIds: remapIds(config.commentGroupIds), postGroupIds: Array.isArray(config.postGroupIds) ? config.postGroupIds : [], repostGroupIds: Array.isArray(config.repostGroupIds) ? config.repostGroupIds : [] } };
      }));
    }
    const engageTemplates = read('engage_templates');
    if (Array.isArray(engageTemplates)) write('engage_templates', engageTemplates.map(template => ({ ...template, config: {
      ...template.config, commentGroupIds: remapIds(template.config?.commentGroupIds)
    } })));
    for (const [oldId, newId] of Object.entries(remap)) {
      db.prepare('UPDATE comment_materials SET group_id=? WHERE group_id=?').run(newId, oldId);
    }
    write('material_groups_v2', { backupPath });
    db.exec('COMMIT');
    return backupPath;
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

// Repair groups created by the old running backend after v2 had already run.
// Never drop a material: clone a foreign group into the material's own type.
export function migrateMaterialGroupIntegrity(db, dataDir) {
  if (db.prepare("SELECT 1 FROM settings WHERE key='material_groups_integrity_v3'").get()) return;
  const read = key => { const row = db.prepare('SELECT value FROM settings WHERE key=?').get(key); return row ? JSON.parse(row.value) : null; };
  const write = (key, value) => db.prepare('INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(key,JSON.stringify(value));
  const backupDir = path.join(dataDir,'backups'); fs.mkdirSync(backupDir,{recursive:true,mode:0o700});
  const backupPath = path.join(backupDir,'before-material-groups-integrity-' + Date.now() + '.sqlite');
  db.exec("VACUUM INTO '" + backupPath.replaceAll("'","''") + "'"); fs.chmodSync(backupPath,0o600);
  db.exec('BEGIN IMMEDIATE');
  try {
    const original = read('material_groups') || [];
    const groups = original.map(group => ({...group,type:['post','comment','repost'].includes(group.type) ? group.type : 'post'}));
    const mapping = {post:{},comment:{},repost:{}};
    const configKeys = {post:'postGroupIds',comment:'commentGroupIds',repost:'repostGroupIds'};
    const defaults = ['task_defaults','engage_defaults'].map(key=>[key,read(key)]);
    const templates = read('task_templates') || [];
    const engageTemplates = read('engage_templates') || [];
    const configs = [...defaults.map(([,value])=>value),...templates.map(t=>t.config),...engageTemplates.map(t=>t.config)].filter(Boolean);
    const tables = {post:'shared_post_materials',comment:'comment_materials',repost:'repost_materials'};
    for (const type of Object.keys(tables)) {
      const referenced = new Set(db.prepare('SELECT DISTINCT group_id FROM ' + tables[type] + " WHERE group_id IS NOT NULL AND group_id<>''").all().map(row=>row.group_id));
      for (const cfg of configs) for (const groupId of cfg[configKeys[type]] || []) referenced.add(groupId);
      // Untyped legacy groups were shared, even when currently empty.
      for (const group of original) if (!group.type && type === 'comment') referenced.add(group.id);
      for (const oldId of referenced) {
        const source = groups.find(group=>group.id===oldId);
        if (source?.type===type) continue;
        let newId = oldId + '_' + type;
        let suffix=1;
        while (groups.some(group=>group.id===newId && group.type!==type)) newId=oldId+'_'+type+'_'+suffix++;
        if (!groups.some(group=>group.id===newId)) groups.push({id:newId,name:source?.name || '恢复分组',type});
        mapping[type][oldId]=newId;
        db.prepare('UPDATE ' + tables[type] + ' SET group_id=? WHERE group_id=?').run(newId,oldId);
      }
    }
    const remap = value => { if (!value) return value; const next={...value}; for (const type of Object.keys(configKeys)) { const key=configKeys[type]; if (Array.isArray(next[key])) next[key]=[...new Set(next[key].map(id=>mapping[type][id] || id))]; } return next; };
    write('material_groups',groups);
    for (const [key,value] of defaults) if (value) write(key,remap(value));
    write('task_templates',templates.map(t=>({...t,config:remap(t.config)})));
    if (engageTemplates.length) write('engage_templates',engageTemplates.map(t=>({...t,config:remap(t.config)})));
    write('material_groups_integrity_v3',{backupPath});db.exec('COMMIT');
  } catch(error) { db.exec('ROLLBACK');throw error; }
}
