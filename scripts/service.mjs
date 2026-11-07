#!/usr/bin/env node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { controlService } from './service-control.mjs';

const root = fs.realpathSync.native(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'));
const label = 'com.local.weibo-super-topic-console';
const taskName = process.env.WEIBO_CONSOLE_SERVICE_NAME || 'WeiboSupertopicConsole';
const port = Number(process.env.WEIBO_CONSOLE_PORT || 4178);
const dataDir = process.env.WEIBO_CONSOLE_DATA_DIR || path.join(root, 'data');
const action = process.argv[2] || 'install';
const nodeBin = process.execPath;
const serverEntry = path.join(root, 'src', 'server.js');
const managedLauncher = process.env.WEIBO_CONSOLE_MANAGED_LAUNCHER || '';

export function listenerPid({ platform = process.platform, run = execFileSync, listenPort = port } = {}) {
  try {
    if (platform === 'win32') {
      const output = run('netstat.exe', ['-ano'], { encoding: 'utf8', windowsHide: true, timeout: 5000 });
      for (const line of output.split(/\r?\n/)) {
        const [protocol, local, , state, pid] = line.trim().split(/\s+/);
        if (protocol === 'TCP' && local?.endsWith(`:${listenPort}`) && state === 'LISTENING') return Number(pid) || null;
      }
      return null;
    }
    const output = run('/usr/sbin/lsof', ['-nP', `-tiTCP:${listenPort}`, '-sTCP:LISTEN'], { encoding: 'utf8', timeout: 5000 }).trim();
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
    if (state && (state.loginSession?.active || state.verification?.session || state.engageVerification?.session || state.browser?.busy || state.engageBrowser?.busy || state.activeJob?.status === 'running' || state.engageJob?.status === 'running')) {
      throw new Error('浏览器或任务仍在执行，请在空闲时再重启');
    }
  } catch (error) {
    if (/浏览器或任务仍在执行/.test(String(error.message))) throw error;
  }
  return pid;
}

export async function waitHealthy(previousPid, {
  findPid = listenerPid, request = fetch, attempts = 100, interval = 150,
  expectedVersion = process.env.WEIBO_CONSOLE_EXPECTED_VERSION || ''
} = {}) {
  for (let attempt = 0; attempt < attempts; attempt++) {
    const pid = findPid();
    if (pid && pid !== previousPid) {
      const response = await request(`http://127.0.0.1:${port}/api/health`, { signal: AbortSignal.timeout(1000) }).catch(() => null);
      if (response?.ok) {
        if (!expectedVersion) return pid;
        const health = await response.json().catch(() => null);
        if (health?.version === expectedVersion) return pid;
      }
    }
    await new Promise(resolve => setTimeout(resolve, interval));
  }
  throw new Error(`新版服务未通过启动健康检查。请先运行 node bootstrap.mjs start 查看启动错误；后台日志：${path.join(dataDir, 'service-error.log')} 和 ${path.join(dataDir, 'service.log')}`);
}

function macPlistPath() {
  return path.join(os.homedir(), 'Library', 'LaunchAgents', `${label}.plist`);
}

function startupPath() {
  return path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup', `${taskName}.vbs`);
}

function startMenuShortcutPath() {
  return path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), 'Microsoft', 'Windows', 'Start Menu', 'Programs', '制饼工坊.url');
}

function startWindowsRunner() {
  const args = managedLauncher ? [managedLauncher] : [path.join(root, 'scripts', 'service-runner.mjs'), String(port), dataDir];
  const child = spawn(nodeBin, args, { detached: true, stdio: 'ignore', windowsHide: true });
  child.on('error', error => { console.error('后台启动失败：' + error.message); process.exitCode = 1; });
  child.unref();
}

export function windowsTaskXml(launcher, sid) {
  const esc = value => String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');
  return `<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
<Triggers><LogonTrigger><Enabled>true</Enabled><UserId>${esc(sid)}</UserId></LogonTrigger></Triggers>
<Principals><Principal id="Author"><UserId>${esc(sid)}</UserId><LogonType>InteractiveToken</LogonType><RunLevel>LeastPrivilege</RunLevel></Principal></Principals>
<Settings><MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy><DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries><StopIfGoingOnBatteries>false</StopIfGoingOnBatteries><ExecutionTimeLimit>PT0S</ExecutionTimeLimit></Settings>
<Actions Context="Author"><Exec><Command>${esc(path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'wscript.exe'))}</Command><Arguments>${esc('"' + launcher + '"')}</Arguments><WorkingDirectory>${esc(root)}</WorkingDirectory></Exec></Actions>
</Task>`;
}

async function stopWindows() {
  const previous = listenerPid();
  const stopped = await controlService(dataDir, root, previous);
  if (previous && !stopped) throw new Error(`无法安全控制端口 ${port} 的旧进程（PID ${previous}），未强制终止。请先在页面安全暂停任务并结束会话，再手动关闭旧服务。`);
  if (stopped) {
    for (let attempt = 0; attempt < 100 && listenerPid() === stopped.pid; attempt++) await new Promise(resolve => setTimeout(resolve, 100));
    if (listenerPid() === stopped.pid) throw new Error('旧服务未退出，未强制终止进程');
  }
  try { execFileSync('schtasks.exe', ['/End', '/TN', taskName], { stdio: 'ignore' }); } catch {}
  return previous;
}

function macPlist() {
  const esc = value => String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>${label}</string>
  <key>ProgramArguments</key><array>
    ${process.platform === 'darwin' ? '<string>/usr/bin/caffeinate</string><string>-dimsu</string>' : ''}<string>${esc(nodeBin)}</string><string>${esc(managedLauncher || serverEntry)}</string>
  </array>
  <key>WorkingDirectory</key><string>${esc(root)}</string>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict>
  <key>ThrottleInterval</key><integer>10</integer>
  <key>StandardOutPath</key><string>${esc(path.join(dataDir, 'service.log'))}</string>
  <key>StandardErrorPath</key><string>${esc(path.join(dataDir, 'service-error.log'))}</string>
</dict></plist>\n`;
}

export function windowsLauncher({ directory = dataDir, projectRoot = root, executable = nodeBin, listenPort = port } = {}) {
  const launcher = path.join(directory, 'start-console.vbs');
  const vbString = value => `"${String(value).replaceAll('"', '""')}"`;
  const command = [executable, ...(managedLauncher ? [managedLauncher] : [path.join(projectRoot, 'scripts', 'service-runner.mjs'), String(listenPort), directory])].map(value => `"${value}"`).join(' ');
  fs.mkdirSync(directory, { recursive: true });
  const source = [
    'Set sh = CreateObject("WScript.Shell")',
    `sh.CurrentDirectory = ${vbString(projectRoot)}`,
    `WScript.Quit sh.Run(${vbString(command)}, 0, True)`,
    ''
  ].join('\r\n');
  // WScript reads Unicode scripts with a BOM; UTF-8 breaks Chinese paths.
  fs.writeFileSync(launcher, Buffer.from('\uFEFF' + source, 'utf16le'));
  return launcher;
}

async function install() {
  const previous = process.platform === 'win32' ? listenerPid() : await assertIdle();
  if (process.platform === 'win32') {
    if (previous) throw new Error(`端口 ${port} 已有进程（PID ${previous}），未停止它。请确认并安全停止旧服务后再安装自启。`);
    const launcher = windowsLauncher();
    let scheduled = false;
    if (process.env.WEIBO_CONSOLE_SERVICE_MODE !== 'startup') {
      try {
        const identity = execFileSync('whoami.exe', ['/user', '/fo', 'csv', '/nh'], { encoding: 'utf8' }).match(/S-1-[\d-]+/);
        if (!identity) throw new Error('无法确定当前用户 SID');
        const xmlFile = path.join(dataDir, 'service-task.xml');
        fs.writeFileSync(xmlFile, Buffer.from('\uFEFF' + windowsTaskXml(launcher, identity[0]), 'utf16le'));
        execFileSync('schtasks.exe', ['/Create', '/F', '/TN', taskName, '/XML', xmlFile], { stdio: 'pipe' });
        scheduled = true;
      } catch { console.log('无法创建计划任务，改用当前用户的登录启动文件夹（无需管理员权限）。'); }
    }
    if (scheduled) {
      try { execFileSync('schtasks.exe', ['/End', '/TN', taskName], { stdio: 'ignore' }); } catch {}
      if (fs.existsSync(startupPath())) fs.unlinkSync(startupPath());
    } else {
      fs.mkdirSync(path.dirname(startupPath()), { recursive: true });
      fs.copyFileSync(launcher, startupPath());
    }
    // Start in the installer's user session; ONLOGON handles future logins.
    // A task can be registered even when no interactive logon token is present.
    startWindowsRunner();
    const pid = await waitHealthy(previous);
    console.log(`已安装登录自启${scheduled ? '计划任务' : '启动文件'}：${taskName}，PID ${pid}`);
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

async function stopService() {
  if (process.platform === 'win32') { await stopWindows(); return; }
  if (process.platform !== 'darwin') throw new Error('当前系统暂不支持停止服务');
  await assertIdle();
  const plistPath = macPlistPath();
  const domain = `gui/${process.getuid()}`;
  try { execFileSync('/bin/launchctl', ['bootout', domain, plistPath], { stdio: 'ignore' }); } catch {}
}

async function uninstall() {
  if (process.platform === 'win32') {
    await stopWindows();
    try { execFileSync('schtasks.exe', ['/Delete', '/TN', taskName, '/F'], { stdio: 'inherit' }); } catch {}
    if (fs.existsSync(startupPath())) fs.unlinkSync(startupPath());
    if (fs.existsSync(startMenuShortcutPath())) fs.unlinkSync(startMenuShortcutPath());
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
    if (fs.existsSync(startupPath())) { console.log('已安装当前用户登录自启：' + startupPath()); return; }
    try { execFileSync('schtasks.exe', ['/Query', '/TN', taskName], { stdio: 'inherit' }); } catch { console.log('未安装'); }
    return;
  }
  console.log(fs.existsSync(macPlistPath()) ? '已安装：' + macPlistPath() : '未安装');
}

export async function main() {
  if (action === 'install') await install();
  else if (action === 'uninstall') await uninstall();
  else if (action === 'status') status();
  else if (action === 'preflight') { await assertIdle(); console.log('当前服务空闲，可以安装或更新。'); }
  else if (action === 'stop') await stopService();
  else if (action === 'restart') {
    const previous = process.platform === 'win32' ? await stopWindows() : await assertIdle();
    if (process.platform === 'darwin') {
      const domain = `gui/${process.getuid()}`;
      execFileSync('/bin/launchctl', ['kickstart', '-k', `${domain}/${label}`]);
    } else if (process.platform === 'win32') {
      windowsLauncher();
      startWindowsRunner();
    }
    const pid = await waitHealthy(previous);
    console.log('服务已重启，PID ' + pid);
  }
  else { console.error('用法：node scripts/service.mjs install|uninstall|status|preflight|stop|restart'); process.exit(1); }
}

const isMain = import.meta.main ?? (process.argv[1] && fs.realpathSync.native(process.argv[1]).toLowerCase() === fs.realpathSync.native(fileURLToPath(import.meta.url)).toLowerCase());
if (isMain) await main();
