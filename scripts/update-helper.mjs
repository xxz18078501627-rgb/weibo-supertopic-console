#!/usr/bin/env node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';

const args = process.argv.slice(2);
const value = name => { const index = args.indexOf(name); return index >= 0 ? args[index + 1] || '' : ''; };
const packagePath = value('--package');
const version = value('--version');
const root = fs.realpathSync.native(path.resolve(value('--root')));
const dataDir = path.resolve(value('--data'));
const installRoot = value('--install-root') ? fs.realpathSync.native(path.resolve(value('--install-root'))) : '';
const restart = !args.includes('--no-restart');
const updatesDir = path.join(dataDir, 'updates');
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const logPath = path.join(updatesDir, 'update.log');

fs.mkdirSync(updatesDir, { recursive: true, mode: 0o700 });
const log = message => { try { fs.appendFileSync(logPath, `[${new Date().toISOString()}] ${message}\n`, { mode: 0o600 }); } catch {} };
const run = (command, argv, options = {}) => execFileSync(command, argv, { cwd: root, stdio: 'pipe', windowsHide: true, ...options });
const managedLauncher = installRoot ? path.join(installRoot, 'launcher.mjs') : (process.env.WEIBO_CONSOLE_MANAGED_LAUNCHER || '');
const serviceEnv = {
  ...process.env,
  WEIBO_CONSOLE_DATA_DIR: dataDir,
  ...(managedLauncher ? { WEIBO_CONSOLE_MANAGED_LAUNCHER: managedLauncher } : {}),
  ...(installRoot ? { WEIBO_CONSOLE_INSTALL_ROOT: installRoot, WEIBO_CONSOLE_EXPECTED_VERSION: version } : {})
};

function extract(zip, target) {
  fs.mkdirSync(target, { recursive: true });
  if (process.platform === 'win32') {
    const quote = item => "'" + String(item).replaceAll("'", "''") + "'";
    run('powershell.exe', ['-NoProfile', '-Command', `Expand-Archive -LiteralPath ${quote(zip)} -DestinationPath ${quote(target)} -Force`]);
  } else run('/usr/bin/unzip', ['-q', '-o', zip, '-d', target]);
}

function copyTree(from, to, { skipData = true } = {}) {
  fs.mkdirSync(to, { recursive: true });
  for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
    if (skipData && entry.name === 'data') continue;
    const source = path.join(from, entry.name), destination = path.join(to, entry.name);
    if (entry.isDirectory()) copyTree(source, destination, { skipData });
    else { fs.mkdirSync(path.dirname(destination), { recursive: true }); fs.copyFileSync(source, destination); }
  }
}

function snapshotDatabase() {
  const source = path.join(dataDir, 'console.sqlite');
  if (!fs.existsSync(source)) return '';
  const dir = path.join(dataDir, 'backups');
  fs.mkdirSync(dir, { recursive: true });
  const target = path.join(dir, `before-update-${version}-${stamp}.sqlite`);
  const database = new DatabaseSync(source);
  try { database.exec("VACUUM INTO '" + target.replaceAll("'", "''") + "'"); }
  finally { database.close(); }
  return target;
}

function stopService() {
  try { run(process.execPath, [path.join(root, 'scripts', 'service.mjs'), 'stop'], { env: serviceEnv }); }
  catch (error) {
    log('停止服务失败：' + (error.stderr?.toString() || error.message));
    throw error;
  }
}

function restartService() {
  if (!restart) return;
  run(process.execPath, [path.join(root, 'scripts', 'service.mjs'), 'restart'], { env: serviceEnv });
}

let staging = '';
let backup = '';
let pointerBackup = '';
let serviceNeedsRecovery = false;
try {
  log(`开始更新 ${version}，安装根目录 ${installRoot || root}`);
  if (!fs.existsSync(packagePath)) throw new Error('更新包不存在');
  const dbSnapshot = snapshotDatabase();
  if (dbSnapshot) log('数据库快照：' + dbSnapshot);
  staging = fs.mkdtempSync(path.join(os.tmpdir(), 'weibo-update-'));
  extract(packagePath, staging);
  const folder = fs.readdirSync(staging, { withFileTypes: true }).find(entry => entry.isDirectory() && entry.name.startsWith('weibo-console'));
  if (!folder) throw new Error('更新包缺少程序目录');
  const source = path.join(staging, folder.name);
  if (!fs.existsSync(path.join(source, 'src', 'server.js'))) throw new Error('更新包结构不完整');

  if (installRoot) {
    const versions = path.join(installRoot, 'versions');
    const destination = path.join(versions, version);
    const pointer = path.join(installRoot, 'current.json');
    fs.mkdirSync(versions, { recursive: true });
    const stagedDestination = destination + `.staging-${process.pid}`;
    fs.rmSync(stagedDestination, { recursive: true, force: true });
    copyTree(source, stagedDestination);
    const stagedVersion = JSON.parse(fs.readFileSync(path.join(stagedDestination, 'package.json'), 'utf8')).version;
    if (stagedVersion !== version) throw new Error(`更新包版本不一致：${stagedVersion} / ${version}`);
    if (!fs.existsSync(path.join(stagedDestination, 'node_modules', 'playwright'))) throw new Error('更新包缺少运行依赖');
    if (fs.existsSync(destination)) {
      const previousVersion = path.join(versions, `.previous-${version}-${stamp}`);
      fs.renameSync(destination, previousVersion);
    }
    fs.renameSync(stagedDestination, destination);
    if (fs.existsSync(pointer)) { pointerBackup = pointer + '.previous'; fs.copyFileSync(pointer, pointerBackup); }
    const stagedPointer = pointer + '.staging';
    fs.writeFileSync(stagedPointer, JSON.stringify({ version, updatedAt: new Date().toISOString() }, null, 2), { mode: 0o600 });
    fs.renameSync(stagedPointer, pointer);
    serviceNeedsRecovery = restart;
    restartService();
  } else {
    if (restart) { stopService(); serviceNeedsRecovery = true; }
    backup = path.join(updatesDir, `backup-app-${version}-${stamp}`);
    copyTree(root, backup, { skipData: true });
    for (const entry of fs.readdirSync(source)) {
      if (entry === 'data') continue;
      const target = path.join(root, entry);
      fs.rmSync(target, { recursive: true, force: true });
      const item = fs.statSync(path.join(source, entry));
      if (item.isDirectory()) copyTree(path.join(source, entry), target);
      else fs.copyFileSync(path.join(source, entry), target);
    }
    if (serviceNeedsRecovery) restartService();
  }
  log(`更新 ${version} 完成${restart ? '，服务已重启并通过健康检查' : '，版本指针已切换，当前服务继续运行旧版本'}`);
} catch (error) {
  log('更新失败：' + (error.stderr?.toString() || error.stack || error.message));
  try {
    if (installRoot && pointerBackup && fs.existsSync(pointerBackup)) {
      const previousVersion = JSON.parse(fs.readFileSync(pointerBackup, 'utf8')).version;
      fs.copyFileSync(pointerBackup, path.join(installRoot, 'current.json'));
      if (previousVersion) serviceEnv.WEIBO_CONSOLE_EXPECTED_VERSION = previousVersion;
    }
    if (!installRoot && backup && fs.existsSync(backup)) copyTree(backup, root);
    restartService();
  } catch (rollback) { log('回滚失败：' + rollback.message); }
  process.exitCode = 1;
} finally {
  try { if (staging) fs.rmSync(staging, { recursive: true, force: true }); } catch {}
}
