import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';

const OFFICIAL_HOSTS = new Set(['github.com', 'api.github.com', 'objects.githubusercontent.com', 'release-assets.githubusercontent.com']);
const MAX_UPDATE_BYTES = 2 * 1024 * 1024 * 1024;
const DEFAULT_API = 'https://api.github.com/repos/xxz18078501627-rgb/weibo-supertopic-console/releases?per_page=30';

function versionParts(value) {
  const match = String(value || '').replace(/^v/, '').match(/^(\d+)\.(\d+)\.(\d+)/);
  return match ? match.slice(1).map(Number) : null;
}

export function compareVersions(a, b) {
  const left = versionParts(a), right = versionParts(b);
  if (!left || !right) return 0;
  for (let i = 0; i < 3; i += 1) if (left[i] !== right[i]) return left[i] - right[i];
  return 0;
}

function platformKey(platform, arch) {
  if (platform === 'darwin') return arch === 'x64' ? 'mac-x64' : arch === 'arm64' ? 'mac-arm64' : '';
  if (platform === 'win32') return arch === 'x64' ? 'windows-x64' : '';
  return '';
}

function officialUrl(value) {
  try { const parsed = new URL(value); return parsed.protocol === 'https:' && OFFICIAL_HOSTS.has(parsed.hostname); } catch { return false; }
}

function safeVersion(value) {
  const clean = String(value || '').replace(/^v/, '');
  return /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(clean) ? clean : '';
}

export class UpdateManager {
  constructor({
    rootDir, dataDir, currentVersion, repo = 'xxz18078501627-rgb/weibo-supertopic-console',
    platform = process.platform, arch = process.arch, fetchImpl = fetch, spawnImpl = spawn,
    idleCheck = async () => null, helperPath = path.join(rootDir, 'scripts', 'update-helper.mjs'),
    apiUrl = process.env.WEIBO_CONSOLE_RELEASE_API || DEFAULT_API, now = Date.now,
    installRoot = process.env.WEIBO_CONSOLE_INSTALL_ROOT || ''
  } = {}) {
    this.rootDir = rootDir;
    this.installRoot = installRoot ? path.resolve(installRoot) : '';
    this.commandRoot = this.installRoot || rootDir;
    this.dataDir = dataDir;
    this.currentVersion = safeVersion(currentVersion) || currentVersion;
    this.repo = repo;
    this.platform = platform;
    this.arch = arch;
    this.key = platformKey(platform, arch);
    this.fetch = fetchImpl;
    this.spawn = spawnImpl;
    this.idleCheck = idleCheck;
    this.helperPath = helperPath;
    this.apiUrl = apiUrl;
    this.now = now;
    this.releases = null;
    this.checkedAt = 0;
    this.latest = null;
    this.checking = null;
    this.downloading = null;
    this.downloadProgress = null;
    this.lastError = '';
    this.applyState = null;
  }

  command(restart = true) {
    const version = this.latest?.version || '<最新版本>';
    return `node "${path.join(this.commandRoot, 'bootstrap.mjs')}" update --platform ${this.key || 'unsupported'} --version ${version} ${restart ? '--restart' : '--no-restart'}`;
  }

  snapshot() {
    const activatedVersion = this.activatedVersion();
    const switched = Boolean(activatedVersion && compareVersions(activatedVersion, this.currentVersion) > 0);
    return {
      currentVersion: this.currentVersion,
      activatedVersion,
      switched,
      latestVersion: this.latest?.version || '',
      platform: this.platform,
      arch: this.arch,
      platformKey: this.key,
      available: Boolean(this.latest && compareVersions(this.latest.version, this.currentVersion) > 0),
      checkedAt: this.checkedAt ? new Date(this.checkedAt).toISOString() : null,
      release: this.latest ? {
        version: this.latest.version, tag: this.latest.tag, publishedAt: this.latest.publishedAt,
        notes: this.latest.notes, assetName: this.latest.assetName,
        installerName: this.latest.installerName, size: this.latest.size, sha256: this.latest.sha256
      } : null,
      download: this.downloadProgress,
      downloaded: Boolean(this.latest && this.downloadedPath(this.latest.version)),
      applying: Boolean(this.applyState && !switched),
      lastError: this.lastError,
      command: this.command(true),
      commandNoRestart: this.command(false),
      supported: Boolean(this.key)
    };
  }

  downloadsDir() { return path.join(this.dataDir, 'updates'); }
  activatedVersion() {
    if (!this.installRoot) return this.currentVersion;
    try { return safeVersion(JSON.parse(fs.readFileSync(path.join(this.installRoot, 'current.json'), 'utf8')).version) || this.currentVersion; }
    catch { return this.currentVersion; }
  }
  downloadPath(version) { return path.join(this.downloadsDir(), `weibo-console-${version}-${this.key}-update.zip`); }
  downloadedPath(version) {
    const target = this.downloadPath(version);
    try { return fs.existsSync(target) && fs.statSync(target).size > 0 ? target : ''; } catch { return ''; }
  }

  async check({ force = false } = {}) {
    if (!this.key) throw Object.assign(new Error(`当前平台暂不支持自动更新：${this.platform}/${this.arch}`), { statusCode: 400 });
    if (!force && this.checkedAt && this.now() - this.checkedAt < 10 * 60 * 1000) return this.snapshot();
    if (this.checking) return this.checking;
    this.checking = this.#check().finally(() => { this.checking = null; });
    return this.checking;
  }

  async #check() {
    try {
      const response = await this.fetch(this.apiUrl, { headers: { 'User-Agent': 'weibo-console', Accept: 'application/vnd.github+json' }, signal: AbortSignal.timeout(15000) });
      if (!response.ok) throw new Error(`获取 GitHub 更新失败：HTTP ${response.status}`);
      const releases = await response.json();
      if (!Array.isArray(releases)) throw new Error('GitHub 更新响应格式不正确');
      const manifests = [];
      for (const release of releases) {
        const assets = Array.isArray(release.assets) ? release.assets : [];
        const manifestAsset = assets.find(asset => {
          const match = String(asset.name || '').match(/^weibo-console-(.+)-(mac-arm64|mac-x64|windows-x64)\.manifest\.json$/);
          return match && match[2] === this.key;
        });
        if (manifestAsset && officialUrl(manifestAsset.browser_download_url)) manifests.push({ release, asset: manifestAsset });
      }
      manifests.sort((a, b) => String(b.release.published_at || '').localeCompare(String(a.release.published_at || '')));
      let selected = null;
      for (const candidate of manifests) {
        const response = await this.fetch(candidate.asset.browser_download_url, { headers: { 'User-Agent': 'weibo-console' }, signal: AbortSignal.timeout(15000) });
        if (!response.ok) continue;
        const manifest = await response.json();
        if (manifest.platformKey !== this.key || !safeVersion(manifest.version)) continue;
        const minimum = safeVersion(manifest.minVersion);
        if (minimum && compareVersions(this.currentVersion, minimum) < 0) continue;
        const payload = (candidate.release.assets || []).find(asset => asset.name === manifest.file);
        const installer = (candidate.release.assets || []).find(asset => asset.name === manifest.installerFile);
        if (!payload || !officialUrl(payload.browser_download_url) || !/^[a-f0-9]{64}$/i.test(String(manifest.sha256 || ''))) continue;
        const size = Number(manifest.size || payload.size || 0);
        if (size <= 0 || size > MAX_UPDATE_BYTES) continue;
        if (!selected || compareVersions(manifest.version, selected.version) > 0) selected = {
          version: safeVersion(manifest.version), tag: String(candidate.release.tag_name || ''),
          publishedAt: candidate.release.published_at || '', notes: manifest.notes || candidate.release.body || '',
          minVersion: manifest.minVersion || '', platformKey: this.key,
          assetName: payload.name, assetUrl: payload.browser_download_url,
          installerName: installer?.name || manifest.installerFile || '',
          size, sha256: String(manifest.sha256).toLowerCase()
        };
      }
      this.latest = selected;
      this.checkedAt = this.now();
      this.lastError = '';
      return this.snapshot();
    } catch (error) {
      this.lastError = error.message;
      this.checkedAt = this.now();
      throw error;
    }
  }

  startDownload() {
    if (this.downloading) return this.snapshot();
    const release = this.latest;
    if (!release) throw Object.assign(new Error('请先检查更新'), { statusCode: 409 });
    this.downloadProgress = { state: 'downloading', percent: 0, received: 0, total: release.size, error: '' };
    this.downloading = this.#download(release).finally(() => { this.downloading = null; });
    return this.snapshot();
  }

  async #download(release) {
    const target = this.downloadPath(release.version), part = target + '.part';
    fs.mkdirSync(this.downloadsDir(), { recursive: true, mode: 0o700 });
    try {
      if (this.downloadedPath(release.version)) {
        this.downloadProgress = { state: 'downloaded', percent: 100, received: release.size, total: release.size, error: '' };
        return target;
      }
      if (!officialUrl(release.assetUrl)) throw new Error('更新下载地址不是官方 GitHub 域名');
      const response = await this.fetch(release.assetUrl, { headers: { 'User-Agent': 'weibo-console' }, redirect: 'follow', signal: AbortSignal.timeout(5 * 60 * 1000) });
      if (!response.ok) throw new Error(`下载更新失败：HTTP ${response.status}`);
      if (response.url && !officialUrl(response.url)) throw new Error('更新下载被重定向到非官方域名');
      const declaredSize = Number(response.headers?.get?.('content-length') || release.size || 0);
      if (declaredSize > MAX_UPDATE_BYTES) throw new Error('更新包超过允许的大小');
      const reader = response.body?.getReader();
      if (!reader) throw new Error('更新下载响应不可读取');
      const handle = fs.openSync(part, 'w', 0o600);
      let received = 0;
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          if (received + value.byteLength > MAX_UPDATE_BYTES) throw new Error('更新包超过允许的大小');
          fs.writeSync(handle, value);
          received += value.byteLength;
          const total = Number(release.size || 0);
          this.downloadProgress = { state: 'downloading', percent: total ? Math.min(99, Math.floor(received * 100 / total)) : 0,
            received, total, error: '' };
        }
      } finally { fs.closeSync(handle); }
      const digest = createHash('sha256').update(fs.readFileSync(part)).digest('hex');
      if (digest !== release.sha256) throw new Error('更新包 SHA256 校验失败，已删除下载');
      fs.renameSync(part, target);
      this.downloadProgress = { state: 'downloaded', percent: 100, received, total: release.size, error: '' };
      return target;
    } catch (error) {
      try { fs.rmSync(part, { force: true }); } catch {}
      this.downloadProgress = { state: 'error', percent: 0, received: 0, total: release.size, error: error.message };
      throw error;
    }
  }

  async apply({ restart = true } = {}) {
    const block = await this.idleCheck();
    if (block) throw Object.assign(new Error(block), { statusCode: 409 });
    if (!this.latest) await this.check({ force: true });
    if (!this.latest || compareVersions(this.latest.version, this.currentVersion) <= 0) throw Object.assign(new Error('当前已经是最新版本'), { statusCode: 409 });
    const packagePath = this.downloadedPath(this.latest.version);
    if (!packagePath) throw Object.assign(new Error('更新包尚未下载完成'), { statusCode: 409 });
    if (!fs.existsSync(this.helperPath)) throw Object.assign(new Error('更新助手缺失'), { statusCode: 500 });
    this.applyState = { version: this.latest.version, restart, startedAt: new Date(this.now()).toISOString() };
    const child = this.spawn(process.execPath, [this.helperPath,
      '--package', packagePath, '--version', this.latest.version, '--root', this.rootDir,
      '--data', this.dataDir, '--install-root', this.installRoot,
      restart ? '--restart' : '--no-restart'
    ], { cwd: this.dataDir, detached: true, stdio: 'ignore', windowsHide: true });
    child.unref?.();
    return { state: 'applying', version: this.latest.version, restart };
  }
}
