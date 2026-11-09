import { execFile } from 'node:child_process';
import { claimRoundNotification } from './task-reports.js';
import { log } from './db.js';

let executor = execFile;
export function setNotificationExecutor(fn) { executor = fn || execFile; }

function xmlEscape(value) {
  return String(value).replace(/[&<>]/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[ch]);
}

function windowsToast(title, message) {
  const xml = '<toast><visual><binding template="ToastText02"><text id="1">' + xmlEscape(title) + '</text><text id="2">' + xmlEscape(message) + '</text></binding></visual></toast>';
  const xmlLiteral = "'" + xml.replace(/'/g, "''") + "'";
  return [
    '-NoProfile', '-NonInteractive', '-Command',
    '[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] | Out-Null;' +
    '[Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom, ContentType = WindowsRuntime] | Out-Null;' +
    '$xml = New-Object Windows.Data.Xml.Dom.XmlDocument; $xml.LoadXml(' + xmlLiteral + ');' +
    '$toast = New-Object Windows.UI.Notifications.ToastNotification $xml;' +
    '[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier("Microsoft.Windows.PowerShell").Show($toast)'
  ];
}

function deliver(title, message, execute) {
  const command = process.platform === 'win32' ? 'powershell.exe' : '/usr/bin/osascript';
  const args = process.platform === 'win32'
    ? windowsToast(title, message)
    : ['-e', 'on run argv\ndisplay notification (item 2 of argv) with title (item 1 of argv)\nend run', title, message];
  return new Promise(resolve => {
    execute(command, args, { timeout: 5000 }, error => {
      if (error) log('warning', '系统通知发送失败：' + error.message);
      resolve(!error);
    });
  });
}

// Tests spawn a real server from source; without this guard every barrier/report in
// the suite would pop a real macOS banner on the user's desktop.
export function notificationsDisabled() {
  return process.env.WEIBO_CONSOLE_NOTIFY === 'off';
}

export async function notifyRound(report, execute = executor) {
  if (notificationsDisabled()) return false;
  if (!claimRoundNotification(report.jobId, report.round)) return false;
  const counts = report.counts;
  const message = '第 ' + (report.round + 1) + ' 轮完成：签到 ' + (counts.checkin?.succeeded || 0) + '，发帖 ' + (counts.post?.succeeded || 0)
    + '，原创 ' + (counts.original?.succeeded || 0) + '，评论 ' + (counts.comment?.succeeded || 0) + '；异常账号 ' + report.abnormalAccounts.length + ' 个。详情请查看工作台。';
  return deliver('制饼工坊 · 本轮已完成', message, execute);
}

// 每个任务只提醒一次：同一 job 的换轮次、continue、服务重启都不再重复。
const verificationSent = new Map();
const MAX_ENTRIES = 200;

export function resetVerificationNotifications(jobId) {
  for (const key of [...verificationSent.keys()]) {
    if (!jobId || key === jobId || key.startsWith(jobId + ':')) verificationSent.delete(key);
  }
}

export async function notifyVerification(job, { count = 0, round = 0 } = {}, execute = executor) {
  if (notificationsDisabled()) return false;
  const pending = Number(count) || 0;
  if (!job?.id || pending <= 0) return false;
  const key = job.id;
  if (verificationSent.has(key)) return false;
  verificationSent.set(key, Date.now());
  while (verificationSent.size > MAX_ENTRIES) verificationSent.delete(verificationSent.keys().next().value);
  const message = '还有 ' + pending + ' 个号待验证';
  return deliver('制饼工坊 · 任务需要验证', message, execute);
}
