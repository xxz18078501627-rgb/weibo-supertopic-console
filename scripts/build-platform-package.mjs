#!/usr/bin/env node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const arg = name => { const index = args.indexOf(name); return index >= 0 ? args[index + 1] || '' : ''; };
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const version = pkg.version;
const platformKey = arg('--platform') || (process.platform === 'darwin'
  ? `mac-${process.arch === 'arm64' ? 'arm64' : 'x64'}`
  : process.platform === 'win32' ? 'windows-x64' : '');
if (!['mac-arm64', 'mac-x64', 'windows-x64'].includes(platformKey)) throw new Error('用法：--platform mac-arm64|mac-x64|windows-x64');
if ((platformKey.startsWith('mac-') && process.platform !== 'darwin') || (platformKey === 'windows-x64' && process.platform !== 'win32')) {
  throw new Error(`安装包必须在原生系统构建：${platformKey}`);
}
if ((platformKey === 'mac-arm64' && process.arch !== 'arm64') || ((platformKey === 'mac-x64' || platformKey === 'windows-x64') && process.arch !== 'x64')) {
  throw new Error(`构建机架构与目标不一致：${platformKey} / ${process.arch}`);
}
const dist = path.join(root, 'dist');
const work = path.join(dist, 'platform', platformKey);
const payload = path.join(work, 'payload', `weibo-console-${version}`);
const runtime = path.join(work, 'runtime');
const updateName = `weibo-console-${version}-${platformKey}-update.zip`;
const manifestName = `weibo-console-${version}-${platformKey}.manifest.json`;
const installerName = platformKey === 'windows-x64'
  ? `weibo-console-${version}-${platformKey}.exe`
  : `weibo-console-${version}-${platformKey}.dmg`;
const run = (command, argv, options = {}) => execFileSync(command, argv, { cwd: root, stdio: 'inherit', ...options });
const copy = (from, to) => { fs.mkdirSync(path.dirname(to), { recursive: true }); fs.cpSync(from, to, { recursive: true }); };
const zipFolder = (source, target) => {
  fs.rmSync(target, { force: true });
  if (process.platform === 'win32') run('powershell.exe', ['-NoProfile', '-Command', `Compress-Archive -LiteralPath '${source}' -DestinationPath '${target}' -Force`]);
  else run('/usr/bin/zip', ['-qry', target, path.basename(source)], { cwd: path.dirname(source) });
};

fs.rmSync(work, { recursive: true, force: true });
fs.mkdirSync(work, { recursive: true });
run(process.execPath, [path.join(root, 'scripts', 'build-release.mjs')]);
const base = path.join(dist, `weibo-console-${version}`);
copy(base, payload);
copy(path.join(root, 'node_modules'), path.join(payload, 'node_modules'));

fs.mkdirSync(path.join(runtime, 'node'), { recursive: true });
if (process.platform === 'win32') fs.copyFileSync(process.execPath, path.join(runtime, 'node', 'node.exe'));
else fs.copyFileSync(process.execPath, path.join(runtime, 'node', 'node'));
if (process.platform !== 'win32') fs.chmodSync(path.join(runtime, 'node', 'node'), 0o755);

const require = createRequire(import.meta.url);
const executable = require('playwright').chromium.executablePath();
if (!fs.existsSync(executable)) throw new Error('Playwright Chromium 尚未安装，请先运行 npx playwright install chromium：' + executable);
let cursor = path.dirname(executable), browserRoot = '';
while (cursor && cursor !== path.dirname(cursor)) {
  if (/^chromium(?:[-_]headless[-_]shell)?-\d+$/.test(path.basename(cursor))) { browserRoot = cursor; break; }
  cursor = path.dirname(cursor);
}
if (!browserRoot) throw new Error('无法定位 Playwright Chromium 缓存目录：' + executable);
const browserCache = path.dirname(browserRoot), browserTarget = path.join(runtime, 'ms-playwright');
fs.mkdirSync(browserTarget, { recursive: true });
for (const entry of fs.readdirSync(browserCache)) {
  if (/^chromium(?:[-_]headless[-_]shell)?-\d+$/.test(entry)) copy(path.join(browserCache, entry), path.join(browserTarget, entry));
}
if (!fs.readdirSync(browserTarget).length) throw new Error('Playwright Chromium 缓存目录为空');

zipFolder(payload, path.join(work, updateName));
const updateBytes = fs.readFileSync(path.join(work, updateName));
const sha256 = createHash('sha256').update(updateBytes).digest('hex');

if (platformKey.startsWith('mac-')) {
  const dmgRoot = path.join(work, 'dmg', '制饼工坊');
  copy(path.join(work, 'payload'), path.join(dmgRoot, 'payload'));
  copy(runtime, path.join(dmgRoot, 'runtime'));
  fs.mkdirSync(path.join(dmgRoot, 'docs'), { recursive: true });
  for (const doc of ['手动安装与更新-Mac.md', '手动安装与更新-Windows.md']) {
    const source = path.join(root, 'docs', doc);
    if (fs.existsSync(source)) fs.copyFileSync(source, path.join(dmgRoot, 'docs', doc));
  }
  const command = `#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"
DEST="$HOME/Library/Application Support/ZhibingStudio"
VERSION="${version}"
mkdir -p "$DEST/versions" "$DEST/runtime" "$DEST/data"
if [ -x "$DEST/runtime/node/node" ] && [ -f "$DEST/service.mjs" ]; then
  "$DEST/runtime/node/node" "$DEST/service.mjs" preflight
fi
rm -rf "$DEST/versions/$VERSION"
cp -R "payload/weibo-console-$VERSION" "$DEST/versions/$VERSION"
cp -R runtime/. "$DEST/runtime/"
chmod +x "$DEST/runtime/node/node"
cd "$DEST/versions/$VERSION"
"$DEST/runtime/node/node" scripts/managed-install.mjs --install-root "$DEST"
for _ in {1..100}; do
  if curl -fsS "http://127.0.0.1:4178/api/health" >/dev/null 2>&1; then
    open "http://localhost:4178"
    exit 0
  fi
  sleep 0.15
done
echo "安装完成，但本地服务未在 15 秒内通过健康检查。请查看 $DEST/data/service-error.log" >&2
exit 1
`;
  fs.writeFileSync(path.join(dmgRoot, '一键安装.command'), command, { mode: 0o755 });
  fs.writeFileSync(path.join(dmgRoot, '安装说明.txt'), '双击“一键安装.command”。若 macOS 阻止打开，请右键该文件选择“打开”，再到“系统设置 → 隐私与安全性 → 仍要打开”。\n');
  const dmgPath = path.join(work, installerName);
  run('/usr/bin/hdiutil', ['create', '-volname', `制饼工坊 ${version}`, '-srcfolder', path.join(work, 'dmg'), '-ov', '-format', 'UDZO', dmgPath]);
} else {
  const inno = path.join(work, 'installer.iss');
  const appId = '{{7BC8F25C-6E39-4EC9-A1B0-0A67AB3A5D8C}';
  const escapedRoot = path.join(work, 'payload', `weibo-console-${version}`).replaceAll('"', '""');
  const runtimeRoot = runtime.replaceAll('"', '""');
  fs.writeFileSync(inno, '\uFEFF' + `#define AppVersion "${version}"
[Setup]
AppId=${appId}
AppName=制饼工坊
AppVersion={#AppVersion}
DefaultDirName={localappdata}\\ZhibingStudio
PrivilegesRequired=lowest
OutputDir=${work.replaceAll('"', '""')}
OutputBaseFilename=weibo-console-${version}-windows-x64
Compression=lzma2
SolidCompression=yes
WizardStyle=modern
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
[Files]
Source: "${escapedRoot}\\*\"; DestDir: "{app}\\versions\\{#AppVersion}"; Flags: ignoreversion recursesubdirs createallsubdirs
Source: "${runtimeRoot}\\node\\node.exe"; DestDir: "{app}\\runtime\\node"; Flags: ignoreversion
Source: "${runtimeRoot}\\ms-playwright\\*"; DestDir: "{app}\\runtime\\ms-playwright"; Flags: ignoreversion recursesubdirs createallsubdirs skipifsourcedoesntexist
Source: "${path.join(root, 'docs', '手动安装与更新-Windows.md').replaceAll('"', '""')}"; DestDir: "{app}\\docs"; Flags: ignoreversion skipifsourcedoesntexist
[INI]
Filename: "{app}\\制饼工坊.url"; Section: "InternetShortcut"; Key: "URL"; String: "http://localhost:4178"
[Icons]
Name: "{autoprograms}\\制饼工坊"; Filename: "{app}\\制饼工坊.url"; WorkingDir: "{app}"
[Run]
Filename: "{app}\\runtime\\node\\node.exe"; Parameters: "scripts\\managed-install.mjs --install-root ""{app}"""; WorkingDir: "{app}\\versions\\{#AppVersion}"; StatusMsg: "正在安装本地服务…"; Flags: runhidden waituntilterminated
Filename: "http://localhost:4178"; Description: "打开制饼工坊"; Flags: postinstall shellexec nowait
[UninstallRun]
Filename: "{app}\\runtime\\node\\node.exe"; Parameters: "service.mjs uninstall"; WorkingDir: "{app}"; RunOnceId: "StopConsoleService"; Flags: runhidden waituntilterminated
`);
  const isccCandidates = [
    process.env.INNO_SETUP_COMPILER,
    'C:\\Program Files (x86)\\Inno Setup 6\\ISCC.exe',
    'C:\\Program Files\\Inno Setup 6\\ISCC.exe',
    'ISCC.exe'
  ].filter(Boolean);
  const iscc = isccCandidates.find(candidate => candidate === 'ISCC.exe'
    || fs.existsSync(candidate)
    || (() => { try { run('where', [candidate], { stdio:'ignore' }); return true; } catch { return false; } })());
  if (!iscc) throw new Error('未找到 Inno Setup 编译器，请运行 choco install innosetup --yes --no-progress');
  run(iscc, [inno]);
}

const installerPath = path.join(work, installerName);
if (!fs.existsSync(installerPath)) throw new Error('安装包未生成：' + installerPath);
const notes = (() => {
  try {
    const text = fs.readFileSync(path.join(root, 'RELEASE_NOTES.md'), 'utf8').trim();
    return text ? text.slice(0, 6000) : `制饼工坊 v${version}`;
  } catch { return `制饼工坊 v${version}`; }
})();
const installerBytes = fs.readFileSync(installerPath);
const installerSha256 = createHash('sha256').update(installerBytes).digest('hex');
const manifest = { version, platformKey, minVersion: '1.0.1', file: updateName, installerFile: installerName,
  sha256, size: updateBytes.length, installerSha256, installerSize: installerBytes.length,
  notes, builtAt: new Date().toISOString() };
fs.writeFileSync(path.join(work, manifestName), JSON.stringify(manifest, null, 2));
console.log(JSON.stringify({ platformKey, update: path.join(work, updateName), installer: installerPath,
  manifest: path.join(work, manifestName) }, null, 2));
