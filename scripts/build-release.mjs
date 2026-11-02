#!/usr/bin/env node
// 生成可直接分发的 zip：程序 + 干净种子库（不含账号、登录目录、日志）。
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const version = pkg.version;
const dist = path.join(root, 'dist');
const staging = path.join(dist, `weibo-console-${version}`);
const include = ['src', 'public', 'scripts', 'tests', 'bootstrap.mjs', 'install.sh', 'install.ps1', 'package.json', 'package-lock.json', 'README.md', 'INSTALL.md', 'AGENTS.md', 'CHANGELOG.md', 'LICENSE'];

fs.rmSync(staging, { recursive: true, force: true });
fs.mkdirSync(path.join(staging, 'data'), { recursive: true });

for (const entry of include) {
  const source = path.join(root, entry);
  if (!fs.existsSync(source)) continue;
  const destination = path.join(staging, entry);
  const stat = fs.statSync(source);
  if (stat.isDirectory()) fs.cpSync(source, destination, { recursive: true });
  else fs.copyFileSync(source, destination);
}

const seed = path.join(dist, 'seed', 'console.sqlite');
execFileSync(process.execPath, [path.join(root, 'scripts', 'scrub-data.mjs'), seed], { stdio: 'inherit', cwd: root });
fs.copyFileSync(seed, path.join(staging, 'data', 'console.sqlite'));
fs.chmodSync(path.join(staging, 'install.sh'), 0o755);

const zipPath = path.join(dist, `weibo-console-${version}.zip`);
fs.rmSync(zipPath, { force: true });
if (process.platform === 'win32') {
  execFileSync('powershell.exe', ['-NoProfile', '-Command', `Compress-Archive -LiteralPath '${staging}' -DestinationPath '${zipPath}' -Force`], { stdio: 'inherit' });
} else {
  execFileSync('/usr/bin/zip', ['-qr', zipPath, path.basename(staging)], { cwd: dist, stdio: 'inherit' });
}
const sha256 = createHash('sha256').update(fs.readFileSync(zipPath)).digest('hex');
const revision = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
const manifest = { version, revision, file: path.basename(zipPath), sha256, size: fs.statSync(zipPath).size, builtAt: new Date().toISOString() };
fs.writeFileSync(path.join(dist, `weibo-console-${version}.manifest.json`), JSON.stringify(manifest, null, 2));
console.log('打包完成：' + zipPath);
console.log('sha256: ' + sha256);
