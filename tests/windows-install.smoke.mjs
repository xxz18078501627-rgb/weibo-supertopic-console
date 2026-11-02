// Run only in disposable Windows CI, with the real installer and Task Scheduler.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';

if (process.platform !== 'win32') throw new Error('Windows CI only');
const source = path.resolve(import.meta.dirname, '..');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'weibo-install-'));
const root = path.join(temp, "中文 user's workspace", 'weibo-supertopic-console-main');
const env = { ...process.env, WEIBO_CONSOLE_SERVICE_NAME: `WeiboConsoleSmoke-${process.pid}`, WEIBO_CONSOLE_NOTIFY: 'off' };
// Test the shipped defaults: activation must remain enabled.
delete env.WEIBO_CONSOLE_LICENSE;
delete env.WEIBO_CONSOLE_DATA_DIR;
delete env.WEIBO_CONSOLE_ACCESS_TOKEN;
const probe = net.createServer();
await new Promise(resolve => probe.listen(0, '127.0.0.1', resolve));
env.WEIBO_CONSOLE_PORT = String(probe.address().port);
await new Promise(resolve => probe.close(resolve));
const address = `http://127.0.0.1:${env.WEIBO_CONSOLE_PORT}`;
fs.mkdirSync(root, { recursive: true });
for (const entry of ['src', 'public', 'scripts', 'bootstrap.mjs', 'install.ps1', 'package.json', 'package-lock.json']) {
  fs.cpSync(path.join(source, entry), path.join(root, entry), { recursive: true });
}

function run(command, args, { timeout = 180000, allowFailure = false } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: root, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    child.stdout.on('data', chunk => { output += chunk; });
    child.stderr.on('data', chunk => { output += chunk; });
    const timer = setTimeout(() => { child.kill(); reject(new Error(`Timed out: ${command}\n${output}`)); }, timeout);
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('close', code => {
      clearTimeout(timer);
      if (code && !allowFailure) reject(new Error(`Exit ${code}: ${command} ${args.join(' ')}\n${output}`));
      else resolve({ code, output });
    });
  });
}

async function checkPage() {
  const status = await fetch(address + '/api/license/status').then(r => r.json());
  assert.equal(status.enabled, true);
  assert.equal(status.activated, false);
  const response = await fetch(address);
  assert.equal(response.status, 200);
  assert.match(await response.text(), /html/i);
  return status;
}

try {
  console.log('Installing from a clean folder with spaces and Chinese characters');
  const installed = await run('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(root, 'install.ps1')]);
  console.log(installed.output);
  assert.equal(installed.code, 0);
  await checkPage();
  const { chromium } = await import(pathToFileURL(path.join(root, 'node_modules', 'playwright', 'index.mjs')));
  const { config } = await import(pathToFileURL(path.join(root, 'src', 'config.js')));
  const browser = await chromium.launch({ headless: true, executablePath: config.chromePath || undefined });
  try {
    const page = await browser.newPage();
    await page.goto(address);
    await page.locator('#license-code').waitFor({ state: 'visible' });
    assert.equal(await page.locator('#license-code').isVisible(), true);
  } finally { await browser.close(); }
  console.log('Fresh install, scheduled task, HTTP and browser activation page passed');

  // An occupied port must not be killed by a repeated installation.
  const repeated = await run(process.execPath, ['bootstrap.mjs', 'service', 'install'], { allowFailure: true });
  assert.notEqual(repeated.code, 0);
  await checkPage();
  console.log('Repeated install preserved the existing listener');

  await run(process.execPath, ['bootstrap.mjs', 'service', 'restart']);
  await checkPage();
  console.log('Scheduled task restart and health check passed');
} catch (error) {
  for (const name of ['service.log', 'service-error.log']) {
    const file = path.join(root, 'data', name);
    if (fs.existsSync(file)) console.error(name + '\n' + fs.readFileSync(file, 'utf8'));
  }
  throw error;
} finally {
  await run(process.execPath, ['bootstrap.mjs', 'service', 'uninstall'], { allowFailure: true });
  let stopped = false;
  for (let attempt = 0; attempt < 50; attempt++) {
    try { await fetch(address, { signal: AbortSignal.timeout(300) }); }
    catch { stopped = true; break; }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  assert.ok(stopped, 'Uninstall must stop this CI service and its child process');
  fs.rmSync(temp, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
}
