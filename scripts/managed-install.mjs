#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const args = process.argv.slice(2);
const current = value => { const index = args.indexOf(value); return index >= 0 ? args[index + 1] || '' : ''; };
const packageRoot = fs.realpathSync.native(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'));
const requestedInstallRoot = path.resolve(current('--install-root') || path.dirname(packageRoot));
fs.mkdirSync(requestedInstallRoot, { recursive: true, mode: 0o700 });
const installRoot = fs.realpathSync.native(requestedInstallRoot);
const version = JSON.parse(fs.readFileSync(path.join(packageRoot, 'package.json'), 'utf8')).version;
const versions = path.join(installRoot, 'versions');
const dataDir = path.join(installRoot, 'data');
const runtimeDir = path.join(installRoot, 'runtime');
const launcherPath = path.join(installRoot, 'launcher.mjs');
const bootstrapPath = path.join(installRoot, 'bootstrap.mjs');
const servicePath = path.join(installRoot, 'service.mjs');

fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
fs.mkdirSync(runtimeDir, { recursive: true, mode: 0o700 });
const seed = path.join(packageRoot, 'data', 'console.sqlite');
const database = path.join(dataDir, 'console.sqlite');
if (!fs.existsSync(database) && fs.existsSync(seed)) fs.copyFileSync(seed, database);

const launcher = `import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const root = path.dirname(fileURLToPath(import.meta.url));
const state = JSON.parse(fs.readFileSync(path.join(root, 'current.json'), 'utf8'));
const app = path.join(root, 'versions', state.version);
const node = process.execPath;
const child = spawn(node, [path.join(app, 'scripts', 'service-runner.mjs'), process.env.WEIBO_CONSOLE_PORT || '4178', path.join(root, 'data')], {
  cwd: app,
  stdio: 'inherit',
  env: { ...process.env, WEIBO_CONSOLE_INSTALL_ROOT: root, WEIBO_CONSOLE_DATA_DIR: path.join(root, 'data'),
    WEIBO_CONSOLE_MANAGED_LAUNCHER: path.join(root, 'launcher.mjs'),
    PLAYWRIGHT_BROWSERS_PATH: path.join(root, 'runtime', 'ms-playwright') }
});
child.on('exit', code => process.exit(code || 0));
`;
fs.writeFileSync(launcherPath, launcher, { mode: 0o600 });
const bootstrap = `import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const root = path.dirname(fileURLToPath(import.meta.url));
const state = JSON.parse(fs.readFileSync(path.join(root, 'current.json'), 'utf8'));
const app = path.join(root, 'versions', state.version);
const child = spawn(process.execPath, [path.join(app, 'bootstrap.mjs'), ...process.argv.slice(2)], {
  cwd: app,
  stdio: 'inherit',
  env: { ...process.env, WEIBO_CONSOLE_INSTALL_ROOT: root, WEIBO_CONSOLE_DATA_DIR: path.join(root, 'data'),
    WEIBO_CONSOLE_MANAGED_LAUNCHER: path.join(root, 'launcher.mjs'),
    PLAYWRIGHT_BROWSERS_PATH: path.join(root, 'runtime', 'ms-playwright') }
});
child.on('exit', code => process.exit(code || 0));
`;
fs.writeFileSync(bootstrapPath, bootstrap, { mode: 0o600 });
const serviceWrapper = `import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const root = path.dirname(fileURLToPath(import.meta.url));
const state = JSON.parse(fs.readFileSync(path.join(root, 'current.json'), 'utf8'));
const app = path.join(root, 'versions', state.version);
const child = spawn(process.execPath, [path.join(app, 'scripts', 'service.mjs'), ...process.argv.slice(2)], {
  cwd: app,
  stdio: 'inherit',
  env: { ...process.env, WEIBO_CONSOLE_INSTALL_ROOT: root, WEIBO_CONSOLE_DATA_DIR: path.join(root, 'data'),
    WEIBO_CONSOLE_MANAGED_LAUNCHER: path.join(root, 'launcher.mjs'),
    PLAYWRIGHT_BROWSERS_PATH: path.join(root, 'runtime', 'ms-playwright') }
});
child.on('exit', code => process.exit(code || 0));
`;
fs.writeFileSync(servicePath, serviceWrapper, { mode: 0o600 });
fs.writeFileSync(path.join(installRoot, 'current.json'), JSON.stringify({ version, updatedAt: new Date().toISOString() }, null, 2), { mode: 0o600 });
console.log(`已安装程序版本 ${version}，数据目录：${dataDir}`);

if (process.platform === 'win32' && process.env.APPDATA) {
  const shortcut = path.join(process.env.APPDATA, 'Microsoft', 'Windows', 'Start Menu', 'Programs', '制饼工坊.url');
  fs.mkdirSync(path.dirname(shortcut), { recursive: true });
  fs.writeFileSync(shortcut, '[InternetShortcut]\r\nURL=http://localhost:4178\r\n', 'utf8');
}

const service = path.join(packageRoot, 'scripts', 'service.mjs');
if (process.env.WEIBO_CONSOLE_INSTALL_NO_SERVICE === '1') {
  console.log('已跳过登录自启安装（测试模式）。');
  process.exit(0);
}
execFileSync(process.execPath, [service, 'install'], {
  cwd: packageRoot,
  stdio: 'inherit',
  env: { ...process.env, WEIBO_CONSOLE_INSTALL_ROOT: installRoot,
    WEIBO_CONSOLE_DATA_DIR: dataDir, WEIBO_CONSOLE_MANAGED_LAUNCHER: launcherPath }
});
