#!/usr/bin/env node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { fileURLToPath } from 'node:url';
import { execFileSync, spawn } from 'node:child_process';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)));
const dataDir = path.join(root, 'data');
const port = Number(process.env.WEIBO_CONSOLE_PORT || 4178);
const npmBin = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const repoSlug = process.env.WEIBO_CONSOLE_REPO || readRepoSlug();
const releaseApi = process.env.WEIBO_CONSOLE_RELEASE_API || (repoSlug ? `https://api.github.com/repos/${repoSlug}/releases/latest` : '');

const argv = process.argv.slice(2);
const command = argv[0] || 'install';
const flags = new Set(argv.filter(item => item.startsWith('--')));

function readRepoSlug() {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
    const url = typeof pkg.repository === 'string' ? pkg.repository : pkg.repository?.url || '';
    const match = url.match(/github\.com[/:]([^/]+)\/([^/.]+)/);
    return match ? `${match[1]}/${match[2]}` : '';
  } catch { return ''; }
}

function run(cmd, args, options = {}) {
  execFileSync(cmd, args, { cwd: root, stdio: 'inherit', ...options });
}

function hasDeps() {
  return fs.existsSync(path.join(root, 'node_modules', 'playwright')) && fs.existsSync(path.join(root, 'node_modules', 'qrcode'));
}

function chromiumInstalled() {
  const dirs = [process.env.PLAYWRIGHT_BROWSERS_PATH, path.join(os.homedir(), 'Library', 'Caches', 'ms-playwright'), path.join(os.homedir(), '.cache', 'ms-playwright'), path.join(process.env.LOCALAPPDATA || '', 'ms-playwright')].filter(Boolean);
  return dirs.some(dir => {
    try { return fs.readdirSync(dir).some(name => /^chromium-/.test(name)); } catch { return false; }
  });
}

function chromePath() {
  const candidates = process.platform === 'darwin'
    ? ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome']
    : process.platform === 'win32'
      ? [
        path.join(process.env.ProgramFiles || 'C:\\Program Files', 'Google/Chrome/Application/chrome.exe'),
        path.join(process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)', 'Google/Chrome/Application/chrome.exe'),
        path.join(process.env.LOCALAPPDATA || '', 'Google/Chrome/Application/chrome.exe')
      ]
      : ['/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser'];
  return process.env.WEIBO_CONSOLE_CHROME || candidates.find(item => item && fs.existsSync(item)) || '';
}

function portOpen() {
  return new Promise(resolve => {
    const socket = net.connect({ host: '127.0.0.1', port });
    socket.setTimeout(800);
    socket.on('connect', () => { socket.destroy(); resolve(true); });
    socket.on('timeout', () => { socket.destroy(); resolve(false); });
    socket.on('error', () => resolve(false));
  });
}

async function networkOk() {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 5000);
  try {
    const response = await fetch('https://weibo.com/', { method: 'HEAD', signal: controller.signal });
    return response.ok || response.status < 500;
  } catch { return false; } finally { clearTimeout(timer); }
}

function licenseState() {
  try {
    const saved = JSON.parse(fs.readFileSync(path.join(dataDir, 'license.json'), 'utf8'));
    return { activated: Boolean(saved?.code), user: saved?.payload?.user || '' };
  } catch { return { activated: false, user: '' }; }
}

async function doctor() {
  const nodeMajor = Number(process.versions.node.split('.')[0]);
  const checks = [];
  checks.push({ name: 'node', ok: nodeMajor >= 24, detail: process.versions.node });
  checks.push({ name: 'deps', ok: hasDeps(), detail: hasDeps() ? 'ok' : '缺少依赖，运行 npm ci 或 --fix' });
  const chrome = chromePath();
  checks.push({ name: 'browser', ok: Boolean(chrome) || chromiumInstalled(), detail: chrome || (chromiumInstalled() ? 'playwright chromium' : '未找到 Chrome/Chromium') });
  const open = await portOpen();
  checks.push({ name: 'port', ok: true, detail: open ? `${port} 正在被占用（可能是已运行的服务）` : `${port} 空闲` });
  let writable = false;
  try { fs.mkdirSync(dataDir, { recursive: true }); fs.accessSync(dataDir, fs.constants.W_OK); writable = true; } catch {}
  checks.push({ name: 'data', ok: writable, detail: dataDir });
  const online = await networkOk();
  checks.push({ name: 'network', ok: online, detail: online ? 'weibo.com 可达' : '无法连接 weibo.com' });
  const license = licenseState();
  checks.push({ name: 'license', ok: license.activated, detail: license.activated ? '已激活：' + license.user : '未激活' });
  const ok = checks.filter(item => item.name !== 'port' && item.name !== 'license').every(item => item.ok);
  if (flags.has('--fix')) {
    if (!hasDeps()) run(npmBin, ['ci', '--omit=dev']);
    if (!chrome && !chromiumInstalled()) run(npmBin, ['exec', '--yes', 'playwright', 'install', 'chromium']);
  }
  if (flags.has('--json')) console.log(JSON.stringify({ ok, node: process.versions.node, platform: process.platform, arch: process.arch, checks }, null, 2));
  else {
    console.log('运行环境检查：' + (ok ? '正常' : '存在问题'));
    for (const item of checks) console.log((item.ok ? '  ✔ ' : '  ✘ ') + item.name.padEnd(8) + item.detail);
    if (!license.activated) console.log('  提示：打开页面粘贴管理员提供的激活码即可，口令由激活码携带。');
  }
  return ok;
}

function start() {
  console.log(`控制台地址：http://localhost:${port}`);
  const license = licenseState();
  console.log(license.activated ? `已激活：${license.user}（口令请向管理员获取）` : '尚未激活：打开页面粘贴管理员提供的激活码');
  const child = spawn(process.execPath, [path.join(root, 'src', 'server.js')], { cwd: root, stdio: 'inherit' });
  child.on('exit', code => process.exit(code || 0));
}

function service(action = 'install') {
  run(process.execPath, [path.join(root, 'scripts', 'service.mjs'), action]);
}

async function install() {
  const nodeMajor = Number(process.versions.node.split('.')[0]);
  if (nodeMajor < 24) throw new Error('需要 Node 24 及以上，请先运行 install.sh / install.ps1');
  if (!hasDeps()) run(npmBin, ['ci', '--omit=dev']);
  if (!chromePath() && !chromiumInstalled()) run(npmBin, ['exec', '--yes', 'playwright', 'install', 'chromium']);
  fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  await doctor();
  if (flags.has('--no-service')) { start(); return; }
  service('install');
  console.log('安装完成。打开页面后粘贴管理员提供的激活码即可。');
}

async function latestRelease() {
  if (!releaseApi) throw new Error('未配置 GitHub 仓库，无法更新（package.json repository 或 WEIBO_CONSOLE_REPO）');
  const response = await fetch(releaseApi, { headers: { 'User-Agent': 'weibo-console', Accept: 'application/vnd.github+json' } });
  if (!response.ok) throw new Error('获取最新版本失败：HTTP ' + response.status);
  return response.json();
}

function extract(zipPath, target) {
  fs.mkdirSync(target, { recursive: true });
  if (process.platform === 'win32') {
    run('powershell.exe', ['-NoProfile', '-Command', `Expand-Archive -LiteralPath '${zipPath}' -DestinationPath '${target}' -Force`]);
  } else {
    run('/usr/bin/unzip', ['-q', '-o', zipPath, '-d', target]);
  }
}

function copyTree(from, to) {
  for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
    if (['data', 'node_modules', '.runtime', '.git', 'dist'].includes(entry.name)) continue;
    const source = path.join(from, entry.name);
    const destination = path.join(to, entry.name);
    if (entry.isDirectory()) { fs.mkdirSync(destination, { recursive: true }); copyTree(source, destination); }
    else fs.copyFileSync(source, destination);
  }
}

async function update() {
  const release = await latestRelease();
  const current = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version;
  const tag = String(release.tag_name || '').replace(/^v/, '');
  console.log(`当前版本 ${current}，最新版本 ${tag || release.name}`);
  if (flags.has('--check')) return;
  if (tag && tag === current) { console.log('已经是最新版本。'); return; }
  const asset = (release.assets || []).find(item => /^weibo-console-.*\.zip$/.test(item.name));
  if (!asset) throw new Error('Release 中没有找到安装包');
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'weibo-update-'));
  const zipPath = path.join(temp, asset.name);
  const download = await fetch(asset.browser_download_url, { headers: { 'User-Agent': 'weibo-console' } });
  if (!download.ok) throw new Error('下载失败：HTTP ' + download.status);
  fs.writeFileSync(zipPath, Buffer.from(await download.arrayBuffer()));
  if (asset.digest?.startsWith('sha256:')) {
    const { createHash } = await import('node:crypto');
    const digest = createHash('sha256').update(fs.readFileSync(zipPath)).digest('hex');
    if (digest !== asset.digest.slice(7)) throw new Error('安装包校验失败，已中止');
  }
  extract(zipPath, temp);
  const folder = fs.readdirSync(temp, { withFileTypes: true }).find(item => item.isDirectory() && item.name.startsWith('weibo-console'));
  if (!folder) throw new Error('安装包结构不正确');
  copyTree(path.join(temp, folder.name), root);
  run(npmBin, ['ci', '--omit=dev']);
  console.log('程序文件已更新，data 与登录状态保持不变。');
  try { service('restart'); } catch (error) { console.log('服务未自动重启：' + error.message); }
}

function token() {
  try {
    const value = fs.readFileSync(path.join(dataDir, 'access-token'), 'utf8').trim();
    if (!value) throw new Error('empty');
    console.log(value);
  } catch { console.error('尚未激活或口令尚未生成，请先在页面完成激活。'); process.exit(1); }
}

if (command === 'doctor') { await doctor(); }
else if (command === 'start') start();
else if (command === 'install') await install();
else if (command === 'service') service(argv[1] || 'install');
else if (command === 'update') await update();
else if (command === 'token') token();
else { console.error('用法：node bootstrap.mjs install|start|doctor|service|update|token'); process.exit(1); }
