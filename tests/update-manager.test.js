import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { UpdateManager, compareVersions } from '../src/update-manager.js';

const api = 'https://api.github.com/repos/example/project/releases?per_page=30';
const atom = 'https://github.com/xxz18078501627-rgb/weibo-supertopic-console/releases.atom';

function release(version, key, { minVersion = '1.0.0', hash = 'a'.repeat(64), size = 4, notes = '更新说明', host = 'github.com' } = {}) {
  const updateName = `weibo-console-${version}-${key}-update.zip`;
  const installerName = key === 'windows-x64' ? `weibo-console-${version}-${key}.exe` : `weibo-console-${version}-${key}.dmg`;
  const manifestName = `weibo-console-${version}-${key}.manifest.json`;
  const manifest = { version, platformKey: key, minVersion, file: updateName, installerFile: installerName, sha256: hash, size, notes };
  return {
    tag: `v${version}`,
    published_at: `2026-11-0${version.endsWith('0') ? 1 : 2}T00:00:00Z`,
    body: 'release',
    assets: [
      { name: manifestName, browser_download_url: `https://${host}/example/project/releases/download/v${version}/${manifestName}` },
      { name: updateName, browser_download_url: `https://github.com/example/project/releases/download/v${version}/${updateName}`, size },
      { name: installerName, browser_download_url: `https://github.com/example/project/releases/download/v${version}/${installerName}` }
    ],
    manifests: { [manifestName]: manifest }
  };
}

function fakeGithub(releases, payload = Buffer.from('test')) {
  const calls = [];
  const fetchImpl = async (url, options = {}) => {
    calls.push({ url: String(url), options });
    if (String(url) === api) return new Response(JSON.stringify(releases.map(({ manifests, ...item }) => item)));
    const manifest = releases.flatMap(item => Object.entries(item.manifests)).find(([name]) => String(url).endsWith(name))?.[1];
    if (manifest) return new Response(JSON.stringify(manifest));
    return new Response(payload, { status: 200, headers: { 'content-length': String(payload.length) } });
  };
  return { calls, fetchImpl };
}

function manager(dir, fetchImpl, overrides = {}) {
  return new UpdateManager({
    rootDir: dir,
    dataDir: path.join(dir, 'data'),
    currentVersion: '1.1.0',
    apiUrl: api,
    fetchImpl,
    ...overrides
  });
}

test('版本比较按语义版本处理补丁、次版本和主版本', () => {
  assert.ok(compareVersions('1.10.0', '1.9.9') > 0);
  assert.ok(compareVersions('2.0.0', '1.99.99') > 0);
  assert.equal(compareVersions('v1.1.0', '1.1.0'), 0);
});

test('只选择当前平台和架构的最新兼容更新', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'weibo-update-select-'));
  try {
    const releases = [
      release('1.2.0', 'mac-arm64'),
      release('1.3.0', 'mac-x64'),
      release('1.4.0', 'windows-x64'),
      release('2.0.0', 'mac-arm64', { minVersion: '1.5.0' })
    ];
    const { fetchImpl } = fakeGithub(releases);
    const update = manager(dir, fetchImpl, { platform: 'darwin', arch: 'arm64', installRoot: '/tmp/ZhibingStudio' });
    const status = await update.check({ force: true });
    assert.equal(status.latestVersion, '1.2.0');
    assert.equal(status.platformKey, 'mac-arm64');
    assert.equal(status.available, true);
    assert.match(status.command, /ZhibingStudio[\\/]bootstrap\.mjs/);
    assert.match(status.commandNoRestart, /--no-restart$/);
    assert.doesNotMatch(status.commandNoRestart, /--restart$/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('当前已是最新版本时不再提示可更新', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'weibo-update-current-'));
  try {
    const { fetchImpl } = fakeGithub([release('1.1.0', 'windows-x64')]);
    const update = manager(dir, fetchImpl, { platform: 'win32', arch: 'x64' });
    const status = await update.check({ force: true });
    assert.equal(status.latestVersion, '1.1.0');
    assert.equal(status.available, false);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('GitHub API 限流时通过 Releases Atom 获取最新版本', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'weibo-update-atom-'));
  try {
    const latest = release('1.1.2', 'windows-x64');
    const manifestName = Object.keys(latest.manifests)[0];
    const fetchImpl = async url => {
      url = String(url);
      if (url === api) return new Response('rate limited', { status: 403 });
      if (url === atom) return new Response(`<feed><entry><updated>2026-11-09T15:00:00Z</updated><link href="https://github.com/example/project/releases/tag/v1.1.2"/></entry></feed>`);
      if (url.endsWith(manifestName)) return new Response(JSON.stringify(latest.manifests[manifestName]));
      throw new Error('unexpected ' + url);
    };
    const update = manager(dir, fetchImpl, { platform: 'win32', arch: 'x64' });
    const status = await update.check({ force: true });
    assert.equal(status.latestVersion, '1.1.2');
    assert.equal(status.available, true);
    assert.equal(status.release.assetName, 'weibo-console-1.1.2-windows-x64-update.zip');
    assert.equal(status.release.installerName, 'weibo-console-1.1.2-windows-x64.exe');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('GitHub API 与 Releases 页面都无法连接时返回用户可读错误', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'weibo-update-rate-limit-'));
  try {
    const update = manager(dir, async () => { throw new TypeError('fetch failed'); });
    await assert.rejects(update.check({ force: true }), /无法连接 GitHub/);
    assert.match(update.snapshot().lastError, /无法连接 GitHub/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('忽略非官方链接和结构无效的清单，继续使用下一个有效版本', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'weibo-update-invalid-'));
  try {
    const invalidHost = release('2.0.0', 'windows-x64', { host: 'evil.example' });
    const wrongPlatform = release('2.1.0', 'windows-x64');
    wrongPlatform.manifests[Object.keys(wrongPlatform.manifests)[0]].platformKey = 'mac-x64';
    const valid = release('1.5.0', 'windows-x64');
    const { fetchImpl } = fakeGithub([invalidHost, wrongPlatform, valid]);
    const update = manager(dir, fetchImpl, { platform: 'win32', arch: 'x64' });
    const status = await update.check({ force: true });
    assert.equal(status.latestVersion, '1.5.0');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('下载后校验 SHA256，摘要错误时不保留安装包', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'weibo-update-download-'));
  try {
    const bad = release('1.2.0', 'mac-x64', { hash: '0'.repeat(64), size: 4 });
    const { fetchImpl } = fakeGithub([bad], Buffer.from('data'));
    const update = manager(dir, fetchImpl, { platform: 'darwin', arch: 'x64' });
    await update.check({ force: true });
    update.startDownload();
    await assert.rejects(update.downloading, /SHA256/);
    assert.equal(update.snapshot().downloaded, false);
    assert.equal(fs.existsSync(update.downloadPath('1.2.0')), false);
    assert.equal(fs.existsSync(update.downloadPath('1.2.0') + '.part'), false);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('摘要正确时保存更新包，并在空闲检查通过后使用结构化参数启动更新助手', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'weibo-update-apply-'));
  try {
    const payload = Buffer.from('package');
    const hash = createHash('sha256').update(payload).digest('hex');
    const good = release('1.2.0', 'windows-x64', { hash, size: payload.length });
    const { fetchImpl } = fakeGithub([good], payload);
    const spawns = [];
    const installRoot = path.join(dir, 'install root');
    fs.mkdirSync(installRoot, { recursive: true });
    fs.writeFileSync(path.join(installRoot, 'current.json'), JSON.stringify({ version: '1.1.0' }));
    const update = manager(dir, fetchImpl, {
      platform: 'win32', arch: 'x64', installRoot,
      helperPath: path.resolve(import.meta.dirname, '..', 'scripts', 'update-helper.mjs'),
      idleCheck: async () => null,
      spawnImpl: (command, args, options) => { spawns.push({ command, args, options }); return { unref() {} }; }
    });
    await update.check({ force: true });
    update.startDownload();
    await update.downloading;
    assert.equal(update.snapshot().downloaded, true);
    const result = await update.apply({ restart: false });
    assert.equal(result.state, 'applying');
    assert.equal(spawns.length, 1);
    assert.ok(spawns[0].args.includes('--install-root'));
    assert.ok(spawns[0].args.includes(installRoot));
    assert.ok(spawns[0].args.includes('--no-restart'));
    assert.equal(spawns[0].args.some(value => /[;&|]/.test(value)), false);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('任务或验证占用时拒绝应用更新', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'weibo-update-busy-'));
  try {
    const payload = Buffer.from('package');
    const hash = createHash('sha256').update(payload).digest('hex');
    const { fetchImpl } = fakeGithub([release('1.2.0', 'windows-x64', { hash, size: payload.length })], payload);
    const update = manager(dir, fetchImpl, { platform: 'win32', arch: 'x64', idleCheck: async () => '请先暂停任务' });
    await update.check({ force: true });
    update.startDownload();
    await update.downloading;
    await assert.rejects(update.apply({ restart: true }), error => error.statusCode === 409 && /暂停任务/.test(error.message));
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('版本指针已切换但服务尚未重启时明确显示待重启', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'weibo-update-pointer-'));
  try {
    const installRoot = path.join(dir, 'install');
    fs.mkdirSync(installRoot);
    fs.writeFileSync(path.join(installRoot, 'current.json'), JSON.stringify({ version: '1.2.0' }));
    const update = manager(dir, async () => { throw new Error('unused'); }, { installRoot });
    const status = update.snapshot();
    assert.equal(status.currentVersion, '1.1.0');
    assert.equal(status.activatedVersion, '1.2.0');
    assert.equal(status.switched, true);
    assert.equal(status.applying, false);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
