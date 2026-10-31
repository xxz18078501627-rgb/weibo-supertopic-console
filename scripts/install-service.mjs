import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const label = 'com.local.weibo-super-topic-console';
const agentsDir = path.join(os.homedir(), 'Library', 'LaunchAgents');
const plistPath = path.join(agentsDir, `${label}.plist`);
const dataDir = path.join(root, 'data');
const port = Number(process.env.WEIBO_CONSOLE_PORT || 4178);
function listenerPid() {
  try { return Number(execFileSync('/usr/sbin/lsof', ['-nP', `-tiTCP:${port}`, '-sTCP:LISTEN'], { encoding: 'utf8' }).trim().split('\n')[0]) || null; }
  catch { return null; }
}
const oldPid = listenerPid();
if (oldPid) {
  const command = execFileSync('/bin/ps', ['-p', String(oldPid), '-o', 'command='], { encoding: 'utf8' }).trim();
  const cwd = execFileSync('/usr/sbin/lsof', ['-a', '-p', String(oldPid), '-d', 'cwd', '-Fn'], { encoding: 'utf8' }).split('\n').find(line => line.startsWith('n'))?.slice(1);
  if (cwd !== root || !/\bnode\b.*(?:src\/server\.js)/.test(command)) throw Error(`端口 ${port} 被其他程序占用，未关闭该程序`);
  const token = fs.readFileSync(path.join(dataDir, 'access-token'), 'utf8').trim();
  const auth = await fetch(`http://localhost:${port}/api/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ token }) });
  const cookie = auth.headers.get('set-cookie')?.split(';')[0];
  if (!auth.ok || !cookie) throw Error('无法认证当前服务，未重启');
  const response = await fetch(`http://localhost:${port}/api/state`, { headers: { cookie } });
  if (!response.ok) throw Error('无法检查当前服务状态，未重启');
  const state = await response.json();
  if (state.loginSession?.active || state.verification?.session || state.browser?.busy || state.activeJob?.status === 'running') throw Error('浏览器或任务仍在执行，请在空闲时重启');
}
fs.mkdirSync(agentsDir, { recursive: true });
fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });

const esc = value => String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>${label}</string>
  <key>ProgramArguments</key><array>
    <string>/usr/bin/caffeinate</string><string>-dimsu</string><string>${esc(process.execPath)}</string><string>${esc(path.join(root, 'src', 'server.js'))}</string>
  </array>
  <key>WorkingDirectory</key><string>${esc(root)}</string>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict>
  <key>ThrottleInterval</key><integer>10</integer>
  <key>StandardOutPath</key><string>${esc(path.join(dataDir, 'service.log'))}</string>
  <key>StandardErrorPath</key><string>${esc(path.join(dataDir, 'service-error.log'))}</string>
</dict></plist>\n`;
fs.writeFileSync(plistPath, plist, { mode: 0o600 });

const domain = `gui/${process.getuid()}`;
try { execFileSync('/bin/launchctl', ['bootout', domain, plistPath], { stdio: 'ignore' }); } catch {}
if (oldPid && listenerPid() === oldPid) {
  // A manually started server is outside launchd's process tree.  Ask that
  // exact, verified project process to shut down gracefully before bootstrap.
  try { process.kill(oldPid, 'SIGTERM'); } catch (error) { if (error.code !== 'ESRCH') throw error; }
  for (let attempt = 0; attempt < 50 && listenerPid() === oldPid; attempt++) await new Promise(resolve => setTimeout(resolve, 100));
  if (listenerPid() === oldPid) throw Error('旧服务未正常退出，已停止上线；未强制终止进程');
}
execFileSync('/bin/launchctl', ['bootstrap', domain, plistPath]);
execFileSync('/bin/launchctl', ['enable', `${domain}/${label}`]);
let ready = false;
for (let attempt = 0; attempt < 50; attempt++) {
  const pid = listenerPid();
  if (pid && pid !== oldPid) {
    const response = await fetch(`http://localhost:${port}/api/session`).catch(() => null);
    if (response?.ok) { ready = true; console.log(`新服务已接管端口 ${port}，PID ${pid}`); break; }
  }
  await new Promise(resolve => setTimeout(resolve, 100));
}
if (!ready) throw Error('新版服务未通过启动健康检查');
console.log(`已安装登录自启服务：${plistPath}`);
console.log('控制台地址：http://localhost:4178');
console.log('首次启动后用 npm run token 查看访问口令。');
