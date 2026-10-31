#!/usr/bin/env node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const label = 'com.local.weibo-super-topic-console';
const taskName = 'WeiboSupertopicConsole';
const port = Number(process.env.WEIBO_CONSOLE_PORT || 4178);
const dataDir = path.join(root, 'data');
const action = process.argv[2] || 'install';
const nodeBin = process.execPath;
const serverEntry = path.join(root, 'src', 'server.js');

function has(cmd) {
  try { execFileSync('/usr/bin/which', [cmd], { stdio: 'ignore' }); return true; } catch { return false; }
}

function listenerPid() {
  try {
    const output = execFileSync('/usr/sbin/lsof', ['-nP', `-tiTCP:${port}`, '-sTCP:LISTEN'], { encoding: 'utf8' }).trim();
    return Number(output.split('\n')[0]) || null;
  } catch { return null; }
}

async function assertIdle() {
  const pid = listenerPid();
  if (!pid) return null;
  let token = '';
  try { token = fs.readFileSync(path.join(dataDir, 'access-token'), 'utf8').trim(); } catch {}
  try {
    const auth = token
      ? await fetch(`http://localhost:${port}/api/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ token }) })
      : null;
    const cookie = auth?.headers.get('set-cookie')?.split(';')[0];
    const response = cookie ? await fetch(`http://localhost:${port}/api/state`, { headers: { cookie } }) : null;
    const state = response?.ok ? await response.json() : null;
    if (state && (state.loginSession?.active || state.verification?.session || state.browser?.busy || state.activeJob?.status === 'running')) {
      throw new Error('浏览器或任务仍在执行，请在空闲时再重启');
    }
  } catch (error) {
    if (/浏览器或任务仍在执行/.test(String(error.message))) throw error;
  }
  return pid;
}

async function waitHealthy(previousPid) {
  for (let attempt = 0; attempt < 100; attempt++) {
    const pid = listenerPid();
    if (pid && pid !== previousPid) {
      const response = await fetch(`http://localhost:${port}/api/license/status`).catch(() => null);
      if (response?.ok) return pid;
    }
    await new Promise(resolve => setTimeout(resolve, 150));
  }
  throw new Error('新版服务未通过启动健康检查');
}

function macPlistPath() {
  return path.join(os.homedir(), 'Library', 'LaunchAgents', `${label}.plist`);
}

function macPlist() {
  const esc = value => String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>${label}</string>
  <key>ProgramArguments</key><array>
    ${process.platform === 'darwin' ? '<string>/usr/bin/caffeinate</string><string>-dimsu</string>' : ''}<string>${esc(nodeBin)}</string><string>${esc(serverEntry)}</string>
  </array>
  <key>WorkingDirectory</key><string>${esc(root)}</string>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict>
  <key>ThrottleInterval</key><integer>10</integer>
  <key>StandardOutPath</key><string>${esc(path.join(dataDir, 'service.log'))}</string>
  <key>StandardErrorPath</key><string>${esc(path.join(dataDir, 'service-error.log'))}</string>
</dict></plist>\n`;
}

function windowsLauncher() {
  const launcher = path.join(dataDir, 'start-console.vbs');
  const log = path.join(dataDir, 'service.log');
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(launcher, [
    'Set sh = CreateObject("WScript.Shell")',
    `sh.Run """${nodeBin}"" ""${serverEntry}"" >> ""${log}"" 2>&1", 0, False`,
    ''
  ].join('\r\n'), { encoding: 'utf8' });
  return launcher;
}

async function install() {
  const previous = await assertIdle();
  if (process.platform === 'win32') {
    const launcher = windowsLauncher();
    execFileSync('schtasks.exe', ['/Create', '/F', '/SC', 'ONLOGON', '/TN', taskName, '/TR', `wscript.exe "${launcher}"`], { stdio: 'inherit' });
    try { execFileSync('schtasks.exe', ['/End', '/TN', taskName], { stdio: 'ignore' }); } catch {}
    execFileSync('schtasks.exe', ['/Run', '/TN', taskName], { stdio: 'inherit' });
    const pid = await waitHealthy(previous);
    console.log(`已安装登录自启任务：${taskName}，PID ${pid}`);
    console.log(`控制台地址：http://localhost:${port}`);
    return;
  }
  if (process.platform !== 'darwin') throw new Error('当前系统暂不支持后台自启，请直接 npm start');
  const plistPath = macPlistPath();
  fs.mkdirSync(path.dirname(plistPath), { recursive: true });
  fs.writeFileSync(plistPath, macPlist(), { mode: 0o600 });
  const domain = `gui/${process.getuid()}`;
  try { execFileSync('/bin/launchctl', ['bootout', domain, plistPath], { stdio: 'ignore' }); } catch {}
  if (previous && listenerPid() === previous) {
    try { process.kill(previous, 'SIGTERM'); } catch (error) { if (error.code !== 'ESRCH') throw error; }
    for (let attempt = 0; attempt < 50 && listenerPid() === previous; attempt++) await new Promise(resolve => setTimeout(resolve, 100));
    if (listenerPid() === previous) throw new Error('旧服务未正常退出，已停止上线；未强制终止进程');
  }
  execFileSync('/bin/launchctl', ['bootstrap', domain, plistPath]);
  execFileSync('/bin/launchctl', ['enable', `${domain}/${label}`]);
  const pid = await waitHealthy(previous);
  console.log(`已安装登录自启服务：${plistPath}，PID ${pid}`);
  console.log(`控制台地址：http://localhost:${port}`);
}

function uninstall() {
  if (process.platform === 'win32') {
    try { execFileSync('schtasks.exe', ['/End', '/TN', taskName], { stdio: 'ignore' }); } catch {}
    try { execFileSync('schtasks.exe', ['/Delete', '/TN', taskName, '/F'], { stdio: 'inherit' }); } catch {}
    console.log('已移除登录自启任务。');
    return;
  }
  const plistPath = macPlistPath();
  const domain = `gui/${process.getuid()}`;
  try { execFileSync('/bin/launchctl', ['bootout', domain, plistPath], { stdio: 'ignore' }); } catch {}
  if (fs.existsSync(plistPath)) {
    const trashDir = path.join(os.homedir(), '.Trash');
    fs.mkdirSync(trashDir, { recursive: true });
    const destination = path.join(trashDir, `${label}-${Date.now()}.plist`);
    fs.renameSync(plistPath, destination);
    console.log(`服务已停止，配置已移到废纸篓：${destination}`);
  } else console.log('服务未安装。');
}

function status() {
  if (process.platform === 'win32') {
    try { execFileSync('schtasks.exe', ['/Query', '/TN', taskName], { stdio: 'inherit' }); } catch { console.log('未安装'); }
    return;
  }
  console.log(fs.existsSync(macPlistPath()) ? '已安装：' + macPlistPath() : '未安装');
}

if (action === 'install') await install();
else if (action === 'uninstall') uninstall();
else if (action === 'status') status();
else if (action === 'restart') { const previous = await assertIdle(); if (process.platform === 'darwin') { const domain = `gui/${process.getuid()}`; try { execFileSync('/bin/launchctl', ['kickstart', '-k', `${domain}/${label}`]); } catch {} } else if (process.platform === 'win32') { try { execFileSync('schtasks.exe', ['/End', '/TN', taskName], { stdio: 'ignore' }); } catch {} execFileSync('schtasks.exe', ['/Run', '/TN', taskName], { stdio: 'inherit' }); } const pid = await waitHealthy(previous); console.log('服务已重启，PID ' + pid); }
else { console.error('用法：node scripts/service.mjs install|uninstall|status|restart'); process.exit(1); }
