#!/usr/bin/env node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { fileURLToPath } from 'node:url';
import { execFileSync, spawn } from 'node:child_process';
import { createRequire } from 'node:module';

const root = fs.realpathSync.native(path.dirname(fileURLToPath(import.meta.url)));
const dataDir = process.env.WEIBO_CONSOLE_DATA_DIR || path.join(root, 'data');
const port = Number(process.env.WEIBO_CONSOLE_PORT || 4178);
const npmBin = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const require = createRequire(import.meta.url);
const repoSlug = process.env.WEIBO_CONSOLE_REPO || readRepoSlug();
const releaseApi = process.env.WEIBO_CONSOLE_RELEASE_API || (repoSlug ? `https://api.github.com/repos/${repoSlug}/releases?per_page=30` : '');

const argv = process.argv.slice(2);
const command = argv[0] || 'install';
const flags = new Set(argv.filter(item => item.startsWith('--')));
const flagValue = name => { const index = argv.indexOf(name); return index >= 0 ? argv[index + 1] || '' : ''; };
const platformKey = flagValue('--platform') || (process.platform === 'darwin'
  ? `mac-${process.arch === 'arm64' ? 'arm64' : 'x64'}` : process.platform === 'win32' ? 'windows-x64' : '');
const nativePlatformKey = process.platform === 'darwin'
  ? `mac-${process.arch === 'arm64' ? 'arm64' : 'x64'}` : process.platform === 'win32' ? 'windows-x64' : '';

function readRepoSlug() {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
    const url = typeof pkg.repository === 'string' ? pkg.repository : pkg.repository?.url || '';
    const match = url.match(/github\.com[/:]([^/]+)\/([^/.]+)/);
    return match ? `${match[1]}/${match[2]}` : '';
  } catch { return ''; }
}

function run(cmd, args, options = {}) {
  if (process.platform === 'win32' && cmd === npmBin) {
    const npmCli = path.join(path.dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js');
    if (!fs.existsSync(npmCli)) throw new Error('当前 Node 缺少 npm，请重新运行 install.ps1 安装完整 Node');
    execFileSync(process.execPath, [npmCli, ...args], { cwd: root, stdio: 'inherit', ...options });
    return;
  }
  execFileSync(cmd, args, { cwd: root, stdio: 'inherit', ...options });
}

function hasDeps() {
  return fs.existsSync(path.join(root, 'node_modules', 'playwright')) && fs.existsSync(path.join(root, 'node_modules', 'qrcode'));
}

function chromiumInstalled() {
  try { return fs.existsSync(require('playwright').chromium.executablePath()); }
  catch { return false; }
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

async function rollback() {
  const installRoot = process.env.WEIBO_CONSOLE_INSTALL_ROOT || process.env.WEIBO_CONSOLE_DATA_DIR && path.dirname(process.env.WEIBO_CONSOLE_DATA_DIR);
  if (!installRoot) throw new Error('仅管理版安装支持版本回滚；开发目录请使用 git 或原程序备份恢复');
  const pointerPath = path.join(installRoot, 'current.json');
  const current = JSON.parse(fs.readFileSync(pointerPath, 'utf8')).version;
  const versions = fs.readdirSync(path.join(installRoot, 'versions'), { withFileTypes: true })
    .filter(entry => entry.isDirectory() && /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(entry.name)
      && fs.existsSync(path.join(installRoot, 'versions', entry.name, 'src', 'server.js')))
    .map(entry => entry.name).sort((a, b) => compareVersion(b, a));
  const target = versions.find(version => compareVersion(version, current) < 0);
  if (!target) throw new Error(`没有可回滚到 ${current} 之前的已安装版本`);
  console.log(`当前版本 ${current}，可回滚到 ${target}`);
  if (flags.has('--check')) return;
  const backup = pointerPath + '.before-rollback';
  fs.copyFileSync(pointerPath, backup);
  const staged = pointerPath + '.staging';
  fs.writeFileSync(staged, JSON.stringify({ version: target, updatedAt: new Date().toISOString(), rollbackFrom: current }, null, 2), { mode: 0o600 });
  fs.renameSync(staged, pointerPath);
  if (flags.has('--no-restart')) { console.log(`已切换到 ${target}；当前服务未重启。`); return; }
  process.env.WEIBO_CONSOLE_EXPECTED_VERSION = target;
  try { service('restart'); }
  catch (error) {
    fs.copyFileSync(backup, pointerPath);
    process.env.WEIBO_CONSOLE_EXPECTED_VERSION = current;
    try { service('restart'); } catch {}
    throw error;
  } finally { delete process.env.WEIBO_CONSOLE_EXPECTED_VERSION; }
  console.log(`已回滚到 ${target}，用户数据未改动。`);
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

function compareVersion(a, b) {
  const left = String(a || '').replace(/^v/, '').split('.').map(Number);
  const right = String(b || '').replace(/^v/, '').split('.').map(Number);
  for (let i = 0; i < 3; i += 1) if ((left[i] || 0) !== (right[i] || 0)) return (left[i] || 0) - (right[i] || 0);
  return 0;
}

async function latestRelease() {
  if (!['mac-arm64', 'mac-x64', 'windows-x64'].includes(platformKey) || platformKey !== nativePlatformKey) {
    throw new Error(`更新包平台与当前电脑不一致：${platformKey || 'unsupported'} / ${nativePlatformKey || process.platform + '-' + process.arch}`);
  }
  if (!releaseApi) throw new Error('未配置 GitHub 仓库，无法更新（package.json repository 或 WEIBO_CONSOLE_REPO）');
  const response = await fetch(releaseApi, { headers: { 'User-Agent': 'weibo-console', Accept: 'application/vnd.github+json' }, signal: AbortSignal.timeout(15000) });
  if (!response.ok) throw new Error('获取最新版本失败：HTTP ' + response.status);
  const payload = await response.json();
  const releases = Array.isArray(payload) ? payload : [payload];
  const candidates = [];
  for (const release of releases) {
    const manifestAsset = (release.assets || []).find(asset => asset.name === `weibo-console-${String(release.tag_name || '').replace(/^v/, '')}-${platformKey}.manifest.json`)
      || (release.assets || []).find(asset => asset.name.endsWith(`-${platformKey}.manifest.json`));
    if (!manifestAsset) continue;
    const manifestResponse = await fetch(manifestAsset.browser_download_url, { headers: { 'User-Agent': 'weibo-console' }, signal: AbortSignal.timeout(15000) });
    if (!manifestResponse.ok) continue;
    const manifest = await manifestResponse.json();
    if (manifest.platformKey !== platformKey) continue;
    if (manifest.minVersion && compareVersion(JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version, manifest.minVersion) < 0) continue;
    const asset = (release.assets || []).find(item => item.name === manifest.file);
    if (asset && /^https:\/\/(github\.com|api\.github\.com|objects\.githubusercontent\.com|release-assets\.githubusercontent\.com)\//.test(String(asset.browser_download_url || ''))
      && /^[a-f0-9]{64}$/i.test(String(manifest.sha256 || ''))) candidates.push({ release, manifest, asset });
  }
  candidates.sort((a, b) => compareVersion(b.manifest.version, a.manifest.version));
  return candidates[0] || null;
}

function extract(zipPath, target) {
  fs.mkdirSync(target, { recursive: true });
  if (process.platform === 'win32') {
    const quote = value => "'" + value.replaceAll("'", "''") + "'";
    run('powershell.exe', ['-NoProfile', '-Command', `Expand-Archive -LiteralPath ${quote(zipPath)} -DestinationPath ${quote(target)} -Force`]);
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
  const selected = await latestRelease();
  const current = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version;
  if (!selected && flags.has('--check')) { console.log(`当前版本 ${current}：该平台没有兼容的 GitHub 更新`); return; }
  const tag = selected?.manifest?.version || flagValue('--version');
  console.log(`当前版本 ${current}，最新版本 ${tag || '未知'}（${platformKey}）`);
  if (flags.has('--check')) return;
  if (tag && tag === current && !flags.has('--force')) { console.log('已经是最新版本。同版本修复包可运行 node bootstrap.mjs update --force 重新安装。'); return; }
  if (!selected) throw new Error(`Release 中没有 ${platformKey} 的更新包`);
  if (flagValue('--version') && compareVersion(flagValue('--version'), selected.manifest.version) !== 0) throw new Error('目标版本与最新 Release 不一致，请重新检查更新');
  const { asset, manifest } = selected;
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'weibo-update-'));
  const zipPath = path.join(temp, asset.name);
  const download = await fetch(asset.browser_download_url, { headers: { 'User-Agent': 'weibo-console' }, signal: AbortSignal.timeout(5 * 60 * 1000) });
  if (!download.ok) throw new Error('下载失败：HTTP ' + download.status);
  if (download.url && !/^https:\/\/(github\.com|api\.github\.com|objects\.githubusercontent\.com|release-assets\.githubusercontent\.com)\//.test(download.url)) throw new Error('更新下载被重定向到非官方域名');
  if (Number(download.headers.get('content-length') || manifest.size || 0) > 2 * 1024 * 1024 * 1024) throw new Error('更新包超过允许的大小');
  fs.writeFileSync(zipPath, Buffer.from(await download.arrayBuffer()));
  const { createHash } = await import('node:crypto');
  const digest = createHash('sha256').update(fs.readFileSync(zipPath)).digest('hex');
  if (digest !== String(manifest.sha256 || '').toLowerCase()) throw new Error('安装包校验失败，已中止');
  const installRoot = process.env.WEIBO_CONSOLE_INSTALL_ROOT || '';
  const helperArgs = [path.join(root, 'scripts', 'update-helper.mjs'), '--package', zipPath,
    '--version', tag, '--root', root, '--data', dataDir, '--install-root', installRoot,
    flags.has('--no-restart') ? '--no-restart' : '--restart'];
  try { run(process.execPath, helperArgs); }
  finally { try { fs.rmSync(temp, { recursive: true, force: true }); } catch {} }
  console.log('程序文件已更新，data 与登录状态保持不变。更新日志：' + path.join(dataDir, 'updates', 'update.log'));
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
else if (command === 'rollback') await rollback();
else if (command === 'token') token();
else { console.error('用法：node bootstrap.mjs install|start|doctor|service|update|token'); process.exit(1); }
