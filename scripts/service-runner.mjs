#!/usr/bin/env node
// WScript/launchd starts this process without a shell. It owns a small
// supervision loop so an unexpected server exit is restarted even on Windows,
// where the scheduled task only runs at logon.
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import http from 'node:http';
import { randomBytes, timingSafeEqual } from 'node:crypto';

const root = fs.realpathSync.native(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'));
const dataDir = process.argv[3] || process.env.WEIBO_CONSOLE_DATA_DIR || path.join(root, 'data');
const runtime = path.join(dataDir, 'service-runtime.json');
const errorLog = path.join(dataDir, 'service-error.log');
const supervise = process.env.WEIBO_CONSOLE_SUPERVISE !== '0';
fs.mkdirSync(dataDir, { recursive: true });
const key = randomBytes(32).toString('hex');
const pending = new Map();
let child = null;
let stopping = false;
let restartTimer = null;
let restarts = 0;
let childStartedAt = 0;
let sequence = 0;
let cleaned = false;
let lastChildPid = null;

function logLine(message) {
  try { fs.appendFileSync(errorLog, `${new Date().toISOString()} ${message}\n`); } catch {}
}

function writeRuntime() {
  const runtimeTemp = `${runtime}.${process.pid}.tmp`;
  fs.writeFileSync(runtimeTemp, JSON.stringify({ root, pid: process.pid, childPid: child?.pid || null, controlPort: control.address().port, key }), { mode: 0o600 });
  fs.renameSync(runtimeTemp, runtime);
}

function requestStop() {
  return new Promise((resolve, reject) => {
    if (!child) return resolve({ ok: true, pid: lastChildPid });
    const id = ++sequence;
    const timer = setTimeout(() => { pending.delete(id); reject(new Error('服务未响应停止请求，未强制终止进程')); }, 8000);
    pending.set(id, { resolve, reject, timer });
    child.send({ type: 'weibo-service-stop', id }, error => {
      if (error) { clearTimeout(timer); pending.delete(id); reject(error); }
    });
  });
}

const control = http.createServer(async (req, res) => {
  const provided = Buffer.from(req.headers.authorization || '');
  const expected = Buffer.from(`Bearer ${key}`);
  if (req.method !== 'POST' || provided.length !== expected.length || !timingSafeEqual(provided, expected)) { res.writeHead(403); res.end('{}'); return; }
  const send = (code, value) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(value)); };
  if (req.url !== '/stop') return send(404, { error: 'Unknown command' });
  stopping = true;
  clearTimeout(restartTimer); restartTimer = null;
  try {
    const result = await requestStop();
    send(result.ok ? 200 : 409, { ...result, root, pid: child?.pid || lastChildPid });
    setTimeout(() => { cleanup(); process.exit(0); }, 80).unref?.();
  } catch (error) {
    stopping = false;
    send(500, { error: error.message });
  }
});
await new Promise((resolve, reject) => { control.once('error', reject); control.listen(0, '127.0.0.1', resolve); });

function spawnChild() {
  if (stopping) return;
  childStartedAt = Date.now();
  const stdout = fs.openSync(path.join(dataDir, 'service.log'), 'a');
  const stderr = fs.openSync(errorLog, 'a');
  child = spawn(process.execPath, [path.join(root, 'src', 'server.js')], {
    cwd: root,
    env: { ...process.env, WEIBO_CONSOLE_PORT: process.argv[2] || process.env.WEIBO_CONSOLE_PORT || '4178',
      WEIBO_CONSOLE_DATA_DIR: dataDir, WEIBO_CONSOLE_SHOW_TOKEN: '0', WEIBO_CONSOLE_SUPERVISED: '1' },
    stdio: ['ignore', stdout, stderr, 'ipc'],
    windowsHide: true
  });
  lastChildPid = child.pid || lastChildPid;
  fs.closeSync(stdout);
  fs.closeSync(stderr);
  writeRuntime();
  let exited = false;
  child.on('message', message => {
    const item = pending.get(message?.id);
    if (!item || message.type !== 'weibo-service-stop-result') return;
    clearTimeout(item.timer); pending.delete(message.id); item.resolve(message);
  });
  child.on('error', error => {
    logLine(`服务进程启动/通信失败：${error.message}`);
    if (!exited) { exited = true; scheduleRestart(1); }
  });
  child.on('exit', code => {
    if (exited) return;
    exited = true;
    if (stopping) { cleanup(); process.exitCode = code ?? 0; return; }
    if (!supervise) { cleanup(); process.exitCode = code ?? 1; return; }
    scheduleRestart(code ?? 1);
  });
}

function scheduleRestart(code) {
  if (stopping) return;
  const uptime = Date.now() - childStartedAt;
  if (uptime > 5 * 60 * 1000) restarts = 0;
  restarts += 1;
  const delay = [1000, 5000, 15000, 60000][Math.min(restarts - 1, 3)];
  logLine(`服务进程退出 code=${code}，${delay}ms 后自动重启（第 ${restarts} 次）`);
  child = null;
  clearTimeout(restartTimer);
  restartTimer = setTimeout(spawnChild, delay);
}

function cleanup() {
  if (cleaned) return;
  cleaned = true;
  control.close();
  for (const item of pending.values()) { clearTimeout(item.timer); item.reject(new Error('服务已退出')); }
  pending.clear();
  try { if (JSON.parse(fs.readFileSync(runtime, 'utf8')).pid === process.pid) fs.unlinkSync(runtime); } catch {}
}

for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => {
  stopping = true;
  clearTimeout(restartTimer);
  try { child?.kill(signal); } catch {}
  setTimeout(() => { cleanup(); process.exit(0); }, 500).unref?.();
});

spawnChild();
