#!/usr/bin/env node
// WScript starts this process without a shell. Node handles paths and logs.
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import http from 'node:http';
import { randomBytes, timingSafeEqual } from 'node:crypto';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dataDir = process.argv[3] || process.env.WEIBO_CONSOLE_DATA_DIR || path.join(root, 'data');
const runtime = path.join(dataDir, 'service-runtime.json');
fs.mkdirSync(dataDir, { recursive: true });
const key = randomBytes(32).toString('hex');
const pending = new Map();
let child;
let sequence = 0;
function requestStop() {
  return new Promise((resolve, reject) => {
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
  try {
    const result = await requestStop();
    send(result.ok ? 200 : 409, { ...result, root, pid: child.pid });
  } catch (error) { send(500, { error: error.message }); }
});
await new Promise((resolve, reject) => { control.once('error', reject); control.listen(0, '127.0.0.1', resolve); });
const stdout = fs.openSync(path.join(dataDir, 'service.log'), 'a');
const stderr = fs.openSync(path.join(dataDir, 'service-error.log'), 'a');
child = spawn(process.execPath, [path.join(root, 'src', 'server.js')], {
  cwd: root,
  env: { ...process.env, WEIBO_CONSOLE_PORT: process.argv[2] || process.env.WEIBO_CONSOLE_PORT || '4178', WEIBO_CONSOLE_DATA_DIR: dataDir, WEIBO_CONSOLE_SHOW_TOKEN: '0' },
  stdio: ['ignore', stdout, stderr, 'ipc'],
  windowsHide: true
});
fs.closeSync(stdout);
fs.closeSync(stderr);
fs.writeFileSync(runtime, JSON.stringify({ root, pid: process.pid, childPid: child.pid, controlPort: control.address().port, key }), { mode: 0o600 });
child.on('message', message => {
  const item = pending.get(message?.id);
  if (!item || message.type !== 'weibo-service-stop-result') return;
  clearTimeout(item.timer); pending.delete(message.id); item.resolve(message);
});
function cleanup() {
  control.close();
  for (const item of pending.values()) { clearTimeout(item.timer); item.reject(new Error('服务已退出')); }
  pending.clear();
  try { if (JSON.parse(fs.readFileSync(runtime, 'utf8')).pid === process.pid) fs.unlinkSync(runtime); } catch {}
}
child.on('error', error => {
  fs.appendFileSync(path.join(dataDir, 'service-error.log'), `${new Date().toISOString()} ${error.message}\n`);
  process.exitCode = 1;
  cleanup();
});
child.on('exit', code => { process.exitCode = code ?? 1; cleanup(); });
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => child.kill(signal));
