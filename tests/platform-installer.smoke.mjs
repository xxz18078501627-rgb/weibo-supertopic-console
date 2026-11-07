#!/usr/bin/env node
// Native Windows release smoke test. Run only in a disposable CI runner.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { spawn, spawnSync } from 'node:child_process';

if (process.platform !== 'win32') throw new Error('Windows CI only');

const root = path.resolve(import.meta.dirname, '..');
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const version = pkg.version;
const installer = path.join(root, 'dist', 'platform', 'windows-x64', `weibo-console-${version}-windows-x64.exe`);
if (!fs.existsSync(installer)) throw new Error('Windows installer not found: ' + installer);

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'weibo-installer-'));
const installRoot = path.join(temp, '中文 安装目录', 'ZhibingStudio');
const probe = net.createServer();
await new Promise(resolve => probe.listen(0, '127.0.0.1', resolve));
const port = probe.address().port;
await new Promise(resolve => probe.close(resolve));
const serviceName = `WeiboConsoleRelease-${process.pid}`;
const env = { ...process.env, WEIBO_CONSOLE_PORT: String(port), WEIBO_CONSOLE_SERVICE_NAME: serviceName, WEIBO_CONSOLE_NOTIFY: 'off' };
const address = `http://127.0.0.1:${port}`;

function run(command, args, { timeout = 180000, env: childEnv = env } = {}) {
  const result = spawnSync(command, args, { cwd: root, env: childEnv, windowsHide: true, timeout, encoding: 'utf8' });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`Exit ${result.status}: ${command} ${args.join(' ')}\n${result.stdout || ''}\n${result.stderr || ''}`);
  return result;
}

async function waitVersion(expected) {
  let latest = null;
  for (let attempt = 0; attempt < 200; attempt++) {
    try {
      latest = await fetch(address + '/api/health').then(response => response.json());
      if (latest?.version === expected) return latest;
    } catch {}
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error(`Service did not reach ${expected}: ${JSON.stringify(latest)}`);
}

function zip(folder, target) {
  const quote = value => "'" + String(value).replaceAll("'", "''") + "'";
  run('powershell.exe', ['-NoProfile', '-Command', `Compress-Archive -LiteralPath ${quote(folder)} -DestinationPath ${quote(target)} -Force`]);
}

function findShortcuts(parent, output = []) {
  if (!fs.existsSync(parent)) return output;
  for (const entry of fs.readdirSync(parent, { withFileTypes: true })) {
    const target = path.join(parent, entry.name);
    if (entry.isDirectory()) findShortcuts(target, output);
    else if (entry.name.toLowerCase().endsWith('.url')) output.push(target);
  }
  return output;
}

try {
  console.log('Installing native EXE to a Chinese path without admin: ' + installRoot);
  run(installer, ['/VERYSILENT', '/SUPPRESSMSGBOXES', '/NORESTART', '/SP-', `/DIR=${installRoot}`], { timeout: 300000 });
  assert.ok(fs.existsSync(path.join(installRoot, 'current.json')));
  assert.ok(fs.existsSync(path.join(installRoot, 'data', 'console.sqlite')));
  assert.ok(fs.existsSync(path.join(installRoot, 'versions', version, 'src', 'server.js')));
  assert.ok(fs.existsSync(path.join(installRoot, 'runtime', 'node', 'node.exe')));
  const shortcutRoots = [
    path.join(process.env.APPDATA, 'Microsoft', 'Windows', 'Start Menu', 'Programs'),
    path.join(process.env.ProgramData || 'C:\\ProgramData', 'Microsoft', 'Windows', 'Start Menu', 'Programs')
  ];
  const shortcuts = shortcutRoots.flatMap(root => findShortcuts(root));
  const appShortcut = shortcuts.find(file => /制饼工坊\.url$/i.test(file) && /localhost:4178/.test(fs.readFileSync(file, 'utf8')));
  assert.ok(appShortcut, 'Start Menu shortcut must open http://localhost:4178: ' + shortcuts.join(', '));
  const task = spawnSync('schtasks.exe', ['/Query', '/TN', serviceName], { encoding: 'utf8', windowsHide: true, env });
  const startup = path.join(process.env.APPDATA, 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup', `${serviceName}.vbs`);
  assert.ok(task.status === 0 || fs.existsSync(startup), 'login autostart must be installed');
  await waitVersion(version);
  fs.writeFileSync(path.join(installRoot, 'data', 'installer-preserve.txt'), '用户数据必须保留');
  console.log('Native EXE install, shortcut, autostart and health passed');

  const parts = version.split('.').map(Number);
  const nextVersion = `${parts[0]}.${parts[1]}.${parts[2] + 1}`;
  const packageFolder = path.join(temp, 'update', `weibo-console-${nextVersion}`);
  fs.mkdirSync(path.dirname(packageFolder), { recursive: true });
  fs.cpSync(path.join(installRoot, 'versions', version), packageFolder, { recursive: true });
  const nextPackage = JSON.parse(fs.readFileSync(path.join(packageFolder, 'package.json'), 'utf8'));
  nextPackage.version = nextVersion;
  fs.writeFileSync(path.join(packageFolder, 'package.json'), JSON.stringify(nextPackage, null, 2));
  const archive = path.join(temp, 'update', `weibo-console-${nextVersion}-update.zip`);
  zip(packageFolder, archive);
  const node = path.join(installRoot, 'runtime', 'node', 'node.exe');
  run(node, [path.join(installRoot, 'versions', version, 'scripts', 'update-helper.mjs'),
    '--package', archive, '--version', nextVersion, '--root', path.join(installRoot, 'versions', version),
    '--data', path.join(installRoot, 'data'), '--install-root', installRoot, '--restart'], { timeout: 300000 });
  assert.equal(JSON.parse(fs.readFileSync(path.join(installRoot, 'current.json'), 'utf8')).version, nextVersion);
  assert.equal(fs.readFileSync(path.join(installRoot, 'data', 'installer-preserve.txt'), 'utf8'), '用户数据必须保留');
  await waitVersion(nextVersion);
  console.log('Managed update preserved data and health-checked the new version');

  run(node, [path.join(installRoot, 'bootstrap.mjs'), 'rollback'], { timeout: 300000 });
  assert.equal(JSON.parse(fs.readFileSync(path.join(installRoot, 'current.json'), 'utf8')).version, version);
  assert.equal(fs.readFileSync(path.join(installRoot, 'data', 'installer-preserve.txt'), 'utf8'), '用户数据必须保留');
  await waitVersion(version);
  console.log('Managed rollback restored the previous version with data intact');
} finally {
  try { run(path.join(installRoot, 'runtime', 'node', 'node.exe'), [path.join(installRoot, 'service.mjs'), 'uninstall'], { timeout: 60000 }); } catch {}
  const uninstaller = path.join(installRoot, 'unins000.exe');
  if (fs.existsSync(uninstaller)) {
    try { run(uninstaller, ['/VERYSILENT', '/SUPPRESSMSGBOXES', '/NORESTART'], { timeout: 120000 }); } catch {}
  }
  try { fs.rmSync(temp, { recursive: true, force: true, maxRetries: 20, retryDelay: 500 }); }
  catch (error) { console.warn('Cleanup left temporary files: ' + error.message); }
}
