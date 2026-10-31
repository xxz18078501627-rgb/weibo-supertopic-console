import fs from 'node:fs';
import path from 'node:path';
import { db } from './db.js';
import { config } from './config.js';
import { now, shanghaiDate } from './util.js';
import { recordView } from './record-view.js';

export const RETENTION_DAYS = Math.max(1, Number(process.env.WEIBO_CONSOLE_RETENTION_DAYS) || 10);

db.exec("CREATE TABLE IF NOT EXISTS daily_stats (date TEXT PRIMARY KEY, counts_json TEXT NOT NULL DEFAULT '{}', job_count INTEGER NOT NULL DEFAULT 0, abnormal_accounts INTEGER NOT NULL DEFAULT 0, captured_at TEXT NOT NULL)");

export function shiftDate(date, days) {
  const base = new Date(String(date) + 'T00:00:00Z');
  base.setUTCDate(base.getUTCDate() + days);
  return base.toISOString().slice(0, 10);
}

export function retentionCutoff(days = RETENTION_DAYS) {
  return shiftDate(shanghaiDate(), -days);
}

export function isArchivedDate(date, days = RETENTION_DAYS) {
  return String(date) < retentionCutoff(days);
}

export function hasDetailedRecords(date) {
  if (db.prepare("SELECT 1 FROM action_logs WHERE strftime('%Y-%m-%d',started_at,'+8 hours')=? LIMIT 1").get(date)) return true;
  return Boolean(db.prepare("SELECT 1 FROM system_logs WHERE strftime('%Y-%m-%d',created_at,'+8 hours')=? LIMIT 1").get(date));
}

// 已归档 = 过了保留期，并且要么已经写过每日统计，要么明细确实已经被清空。
// 只按"还有没有明细行"判断会误判：未确认动作会刻意保留，不能因此把当天当成还有完整明细。
export function isArchivedRecord(date) {
  if (!isArchivedDate(date)) return false;
  if (db.prepare('SELECT 1 FROM daily_stats WHERE date=?').get(date)) return true;
  return !hasDetailedRecords(date);
}

function captureDailyStats(date) {
  if (db.prepare('SELECT 1 FROM daily_stats WHERE date=?').get(date)) return;
  if (!hasDetailedRecords(date)) return;
  const view = recordView(date, {});
  const jobCount = db.prepare("SELECT COUNT(*) c FROM jobs WHERE strftime('%Y-%m-%d',created_at,'+8 hours')=?").get(date).c;
  db.prepare('INSERT OR IGNORE INTO daily_stats(date,counts_json,job_count,abnormal_accounts,captured_at) VALUES(?,?,?,?,?)')
    .run(date, JSON.stringify(view.counts), Number(jobCount) || 0, Number(view.abnormalCount) || 0, now());
}

function backupOnce() {
  if (db.prepare("SELECT 1 FROM settings WHERE key='retention_v1'").get()) return null;
  const dir = path.join(config.dataDir, 'backups');
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const target = path.join(dir, 'before-retention-' + Date.now() + '.sqlite');
  db.exec("VACUUM INTO '" + target.replaceAll("'", "''") + "'");
  fs.chmodSync(target, 0o600);
  return target;
}

function markRetention() {
  db.prepare("INSERT INTO settings(key,value) VALUES('retention_v1',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(JSON.stringify({ days: RETENTION_DAYS, at: now() }));
}

const activeJobIds = () => db.prepare("SELECT id FROM jobs WHERE status IN ('running','paused','waiting')").all().map(row => String(row.id));
const placeholders = list => list.map(() => '?').join(',');

export function pruneDetailedRecords({ days = RETENTION_DAYS } = {}) {
  const cutoff = retentionCutoff(days);
  const active = activeJobIds();
  const activeSet = new Set(active);
  const allDates = new Set();
  for (const row of db.prepare("SELECT DISTINCT strftime('%Y-%m-%d',started_at,'+8 hours') d FROM action_logs").all()) if (row.d && row.d < cutoff) allDates.add(row.d);
  for (const row of db.prepare("SELECT DISTINCT strftime('%Y-%m-%d',created_at,'+8 hours') d FROM system_logs").all()) if (row.d && row.d < cutoff) allDates.add(row.d);
  for (const row of db.prepare("SELECT DISTINCT strftime('%Y-%m-%d',triggered_at,'+8 hours') d FROM verification_cards").all()) if (row.d && row.d < cutoff) allDates.add(row.d);
  // 活跃任务还在用的日期先不动：明细和未完成计数都保留到任务结束后的下一次启动。
  const busyDates = new Set();
  if (active.length) {
    for (const row of db.prepare("SELECT DISTINCT strftime('%Y-%m-%d',started_at,'+8 hours') d FROM action_logs WHERE job_id IN (" + placeholders(active) + ")").all(...active)) if (row.d && row.d < cutoff) busyDates.add(row.d);
  }
  const dates = [...allDates].filter(date => !busyDates.has(date)).sort();
  const overflowDates = new Set();
  for (const row of db.prepare("SELECT DISTINCT strftime('%Y-%m-%d',completed_at,'+8 hours') d FROM action_logs WHERE completed_at IS NOT NULL AND strftime('%Y-%m-%d',completed_at,'+8 hours') <> strftime('%Y-%m-%d',started_at,'+8 hours')").all()) {
    if (row.d && row.d < cutoff && !busyDates.has(row.d) && !allDates.has(row.d)) overflowDates.add(row.d);
  }

  const backup = backupOnce();
  const deleted = { actions: 0, logs: 0, cards: 0, steps: 0 };
  if (dates.length || backup) {
    db.exec('BEGIN IMMEDIATE');
    try {
      for (const date of dates) captureDailyStats(date);
      for (const date of overflowDates) captureDailyStats(date);
      const marks = placeholders(dates);
      if (dates.length) {
        deleted.actions = db.prepare("DELETE FROM action_logs WHERE strftime('%Y-%m-%d',started_at,'+8 hours') IN (" + marks + ") AND state NOT IN ('submitted','uncertain')").run(...dates).changes;
        deleted.logs = db.prepare("DELETE FROM system_logs WHERE strftime('%Y-%m-%d',created_at,'+8 hours') IN (" + marks + ")").run(...dates).changes;
        deleted.cards = db.prepare("DELETE FROM verification_cards WHERE status='resolved' AND strftime('%Y-%m-%d',COALESCE(updated_at,triggered_at),'+8 hours') IN (" + marks + ")").run(...dates).changes;
      }
      deleted.steps = db.prepare("DELETE FROM task_step_state WHERE job_id IN (SELECT id FROM jobs WHERE strftime('%Y-%m-%d',created_at,'+8 hours') < ? AND status NOT IN ('running','paused','waiting'))").run(cutoff).changes;
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
    markRetention();
    if (deleted.actions || deleted.logs || deleted.cards || deleted.steps) {
      db.prepare("INSERT INTO system_logs(level,message,account_id,topic_id,url,created_at) VALUES('info',?,NULL,NULL,NULL,?)")
        .run('清理 ' + days + ' 天前详细记录：动作 ' + deleted.actions + ' 条、日志 ' + deleted.logs + ' 条、验证卡 ' + deleted.cards + ' 张、步骤 ' + deleted.steps + ' 条；每日计数已归档', now());
    }
  }
  return { cutoff, dates, deleted, backup, active, busyDates: [...busyDates] };
}
