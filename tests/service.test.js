import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { spawn } from 'node:child_process';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { listenerPid, waitHealthy, windowsLauncher } from '../scripts/service.mjs';
import { controlService } from '../scripts/service-control.mjs';

test('Windows 查监听 PID：忽略已连接、UDP、相邻端口，兼容 IPv4/IPv6', () => {
  for (const local of ['0.0.0.0:4178', '[::]:4178', '127.0.0.1:4178']) {
    const pid = listenerPid({ platform: 'win32', listenPort: 4178, run(command, args) {
      assert.equal(command, 'netstat.exe');
      assert.deepEqual(args, ['-ano']);
      return `\r\n  Proto Local Address Foreign Address State PID\r\n  TCP 127.0.0.1:4178 127.0.0.1:50000 ESTABLISHED 1\r\n  UDP 0.0.0.0:4178 *:* 2\r\n  TCP 0.0.0.0:14178 0.0.0.0:0 LISTENING 3\r\n  TCP ${local} 0.0.0.0:0 LISTENING 4321\r\n`;
    } });
    assert.equal(pid, 4321);
  }
});

test('macOS 沿用 lsof；查不到监听返回 null', () => {
  assert.equal(listenerPid({ platform: 'darwin', listenPort: 5000, run(command, args) {
    assert.equal(command, '/usr/sbin/lsof');
    assert.ok(args.includes('-tiTCP:5000'));
    return '123\n123\n';
  } }), 123);
  assert.equal(listenerPid({ platform: 'win32', run: () => '' }), null);
  assert.equal(listenerPid({ platform: 'win32', run: () => { throw new Error('unavailable'); } }), null);
});

test('健康检查要求新监听 PID 和 HTTP 成功，不把旧进程当作新版', async () => {
  const pids = [null, 11, 22, 22];
  let requests = 0;
  const pid = await waitHealthy(11, { findPid: () => pids.shift(), interval: 0, attempts: 4,
    request: async (url, options) => {
      assert.match(url, /^http:\/\/127\.0\.0\.1:.*\/api\/health/);
      assert.ok(options.signal instanceof AbortSignal);
      return { ok: ++requests === 2, json: async () => ({ version: '1.2.0' }) };
    }
  });
  assert.equal(pid, 22);
  assert.equal(requests, 2);
  await assert.rejects(waitHealthy(11, { findPid: () => 11, attempts: 1, interval: 0,
    request: () => { throw new Error('不应请求旧进程'); }
  }), /node bootstrap\.mjs start.*service-error\.log/);
  await assert.rejects(waitHealthy(null, { findPid: () => 22, attempts: 1, interval: 0,
    request: async () => { throw new Error('connection refused'); }
  }), /启动健康检查/);
  await assert.rejects(waitHealthy(11, { findPid: () => 23, attempts: 1, interval: 0, expectedVersion: '2.0.0',
    request: async () => ({ ok: true, json: async () => ({ version: '1.0.0' }) })
  }), /启动健康检查/);
});

test('原生端口检测能找到本次测试的监听进程', { skip: !['darwin', 'win32'].includes(process.platform) }, async () => {
  const server = net.createServer();
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  try { assert.equal(listenerPid({ listenPort: server.address().port }), process.pid); }
  finally { await new Promise(resolve => server.close(resolve)); }
});

function fixture() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'weibo-service-'));
  const root = path.join(base, "工作台 user's & (test)");
  const data = path.join(root, 'data');
  fs.mkdirSync(path.join(root, 'src'), { recursive: true });
  fs.mkdirSync(path.join(root, 'scripts'));
  fs.mkdirSync(data);
  fs.writeFileSync(path.join(data, 'preserve.txt'), 'keep');
  fs.copyFileSync(fileURLToPath(new URL('../scripts/service-runner.mjs', import.meta.url)), path.join(root, 'scripts', 'service-runner.mjs'));
  fs.writeFileSync(path.join(root, 'src', 'server.js'), `
console.log(JSON.stringify({ cwd: process.cwd(), port: process.env.WEIBO_CONSOLE_PORT, data: process.env.WEIBO_CONSOLE_DATA_DIR, showToken: process.env.WEIBO_CONSOLE_SHOW_TOKEN }));
console.error('fixture startup error');
process.exitCode = 7;
`);
  return { base, root, data };
}

function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: 'ignore', ...options });
    const timer = setTimeout(() => { child.kill(); reject(new Error('fixture timed out')); }, 15000);
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('exit', code => { clearTimeout(timer); resolve(code); });
  });
}

function checkLogs({ root, data }) {
  const result = JSON.parse(fs.readFileSync(path.join(data, 'service.log'), 'utf8').trim());
  assert.equal(fs.realpathSync.native(result.cwd), fs.realpathSync.native(root));
  assert.equal(result.port, '54321');
  assert.equal(result.data, data);
  assert.equal(result.showToken, '0');
  assert.match(fs.readFileSync(path.join(data, 'service-error.log'), 'utf8'), /fixture startup error/);
  assert.equal(fs.readFileSync(path.join(data, 'preserve.txt'), 'utf8'), 'keep');
}

test('后台 runner 保留路径、端口和数据，分别写日志并传递退出码', async () => {
  const item = fixture();
  try {
    assert.equal(await run(process.execPath, [path.join(item.root, 'scripts', 'service-runner.mjs'), '54321', item.data], { cwd: os.tmpdir() }), 7);
    checkLogs(item);
  } finally { fs.rmSync(item.base, { recursive: true, force: true }); }
});

test('Windows 启动器使用 Unicode，等待 runner 退出且不把 shell 重定向传给 Node', () => {
  const item = fixture();
  try {
    const launcher = windowsLauncher({ directory: item.data, projectRoot: item.root, listenPort: 54321 });
    const bytes = fs.readFileSync(launcher);
    assert.equal(bytes.readUInt16LE(0), 0xfeff);
    const script = bytes.toString('utf16le');
    assert.ok(script.includes(item.root));
    assert.ok(script.includes('service-runner.mjs'));
    assert.match(script, /sh\.CurrentDirectory/);
    assert.match(script, /, 0, True\)/);
    assert.equal(script.includes('2>&1'), false);
  } finally { fs.rmSync(item.base, { recursive: true, force: true }); }
});

test('Windows 原生脚本宿主能启动中文与空格目录中的 runner 并写入日志', { skip: process.platform !== 'win32' }, async () => {
  const item = fixture();
  try {
    const launcher = windowsLauncher({ directory: item.data, projectRoot: item.root, listenPort: 54321 });
    assert.equal(await run('cscript.exe', ['//Nologo', launcher], { cwd: os.tmpdir() }), 7);
    checkLogs(item);
  } finally { fs.rmSync(item.base, { recursive: true, force: true }); }
});

test('真实服务通过私有控制通道安全退出，激活保持启用且拒绝伪造凭据', async () => {
  const data = fs.mkdtempSync(path.join(os.tmpdir(), 'weibo-service-control-'));
  const root = fileURLToPath(new URL('../', import.meta.url)).replace(/[\\/]$/, '');
  const probe = net.createServer();
  await new Promise(resolve => probe.listen(0, '127.0.0.1', resolve));
  const port = probe.address().port;
  await new Promise(resolve => probe.close(resolve));
  const child = spawn(process.execPath, [path.join(root, 'scripts', 'service-runner.mjs'), String(port), data], {
    env: { ...process.env, WEIBO_CONSOLE_LICENSE: 'on', WEIBO_CONSOLE_NOTIFY: 'off' }, stdio: 'ignore'
  });
  const exited = new Promise(resolve => child.once('exit', resolve));
  try {
    let status;
    for (let attempt = 0; attempt < 100; attempt++) {
      status = await fetch(`http://127.0.0.1:${port}/api/license/status`).then(r => r.json()).catch(() => null);
      if (status) break;
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    assert.equal(status?.enabled, true);
    assert.equal(status.activated, false);
    const runtime = JSON.parse(fs.readFileSync(path.join(data, 'service-runtime.json'), 'utf8'));
    assert.equal(await controlService(data, root, runtime.childPid + 1), null);
    const refused = await fetch(`http://127.0.0.1:${runtime.controlPort}/stop`, { method: 'POST', headers: { Authorization: 'Bearer wrong' } });
    assert.equal(refused.status, 403);
    const alias = path.join(data, 'project-link');
    fs.symlinkSync(root, alias, process.platform === 'win32' ? 'junction' : 'dir');
    assert.equal((await controlService(data, alias, runtime.childPid)).ok, true);
    assert.equal(await exited, 0);
    assert.equal(fs.existsSync(path.join(data, 'service-runtime.json')), false);
  } finally {
    if (child.exitCode === null) { try { await controlService(data, root); } catch {} }
    await exited;
    fs.rmSync(data, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});
