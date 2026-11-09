import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { execFileSync } from 'node:child_process';

function zipFolder(folder, target) {
  if (process.platform === 'win32') {
    const quote = value => "'" + String(value).replaceAll("'", "''") + "'";
    execFileSync('powershell.exe', ['-NoProfile', '-Command', `Compress-Archive -LiteralPath ${quote(folder)} -DestinationPath ${quote(target)} -Force`]);
  } else {
    execFileSync('/usr/bin/zip', ['-qry', target, path.basename(folder)], { cwd: path.dirname(folder) });
  }
}

test('管理版更新只切换版本指针，保留数据，关闭重启时不动当前服务', () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'weibo-update-helper-'));
  try {
    const installRoot = path.join(base, '中文 安装目录');
    const oldRoot = path.join(installRoot, 'versions', '1.1.0');
    const newPackage = path.join(base, 'weibo-console-1.2.0');
    fs.mkdirSync(path.join(oldRoot, 'src'), { recursive: true });
    fs.mkdirSync(path.join(oldRoot, 'scripts'), { recursive: true });
    fs.writeFileSync(path.join(oldRoot, 'package.json'), JSON.stringify({ version: '1.1.0' }));
    fs.writeFileSync(path.join(oldRoot, 'src', 'server.js'), 'old');
    fs.writeFileSync(path.join(oldRoot, 'scripts', 'service.mjs'), 'throw new Error("must not run");');
    fs.mkdirSync(path.join(installRoot, 'data'), { recursive: true });
    fs.writeFileSync(path.join(installRoot, 'data', 'keep.txt'), '用户数据');
    fs.writeFileSync(path.join(installRoot, 'current.json'), JSON.stringify({ version: '1.1.0' }));

    fs.mkdirSync(path.join(newPackage, 'src'), { recursive: true });
    fs.mkdirSync(path.join(newPackage, 'node_modules', 'playwright'), { recursive: true });
    fs.writeFileSync(path.join(newPackage, 'package.json'), JSON.stringify({ version: '1.2.0' }));
    fs.writeFileSync(path.join(newPackage, 'src', 'server.js'), 'new');
    const archive = path.join(base, 'update.zip');
    zipFolder(newPackage, archive);

    execFileSync(process.execPath, [path.resolve(import.meta.dirname, '..', 'scripts', 'update-helper.mjs'),
      '--package', archive, '--version', '1.2.0', '--root', oldRoot,
      '--data', path.join(installRoot, 'data'), '--install-root', installRoot, '--no-restart'
    ], { stdio: 'pipe' });

    assert.equal(JSON.parse(fs.readFileSync(path.join(installRoot, 'current.json'), 'utf8')).version, '1.2.0');
    assert.equal(fs.readFileSync(path.join(installRoot, 'data', 'keep.txt'), 'utf8'), '用户数据');
    assert.equal(fs.readFileSync(path.join(installRoot, 'versions', '1.2.0', 'src', 'server.js'), 'utf8'), 'new');
    assert.equal(fs.readFileSync(path.join(installRoot, 'versions', '1.1.0', 'src', 'server.js'), 'utf8'), 'old');
    assert.match(fs.readFileSync(path.join(installRoot, 'data', 'updates', 'update.log'), 'utf8'), /当前服务继续运行旧版本/);
  } finally { fs.rmSync(base, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); }
});

test('新版重启健康检查失败时恢复旧版本指针', () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'weibo-update-rollback-'));
  try {
    const installRoot = path.join(base, 'install');
    const oldRoot = path.join(installRoot, 'versions', '1.1.0');
    const newPackage = path.join(base, 'weibo-console-1.2.0');
    fs.mkdirSync(path.join(oldRoot, 'src'), { recursive: true });
    fs.mkdirSync(path.join(oldRoot, 'scripts'), { recursive: true });
    fs.writeFileSync(path.join(oldRoot, 'package.json'), JSON.stringify({ version: '1.1.0' }));
    fs.writeFileSync(path.join(oldRoot, 'src', 'server.js'), 'old');
    fs.writeFileSync(path.join(oldRoot, 'scripts', 'service.mjs'), 'process.exit(1);');
    fs.mkdirSync(path.join(installRoot, 'data'), { recursive: true });
    fs.writeFileSync(path.join(installRoot, 'current.json'), JSON.stringify({ version: '1.1.0' }));

    fs.mkdirSync(path.join(newPackage, 'src'), { recursive: true });
    fs.mkdirSync(path.join(newPackage, 'node_modules', 'playwright'), { recursive: true });
    fs.writeFileSync(path.join(newPackage, 'package.json'), JSON.stringify({ version: '1.2.0' }));
    fs.writeFileSync(path.join(newPackage, 'src', 'server.js'), 'new');
    const archive = path.join(base, 'update.zip');
    zipFolder(newPackage, archive);

    let status = 0;
    try {
      execFileSync(process.execPath, [path.resolve(import.meta.dirname, '..', 'scripts', 'update-helper.mjs'),
        '--package', archive, '--version', '1.2.0', '--root', oldRoot,
        '--data', path.join(installRoot, 'data'), '--install-root', installRoot, '--restart'
      ], { stdio: 'pipe' });
    } catch (error) { status = error.status; }

    assert.notEqual(status, 0);
    assert.equal(JSON.parse(fs.readFileSync(path.join(installRoot, 'current.json'), 'utf8')).version, '1.1.0');
    assert.equal(fs.readFileSync(path.join(installRoot, 'versions', '1.2.0', 'src', 'server.js'), 'utf8'), 'new');
    assert.match(fs.readFileSync(path.join(installRoot, 'data', 'updates', 'update.log'), 'utf8'), /更新失败/);
  } finally { fs.rmSync(base, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); }
});

test('源码目录更新只备份即将替换的文件，不复制 .git 与构建目录', () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'weibo-update-source-'));
  try {
    const root = path.join(base, 'app');
    const data = path.join(root, 'data');
    const newPackage = path.join(base, 'weibo-console-1.2.0');
    fs.mkdirSync(path.join(root, 'src'), { recursive: true });
    fs.mkdirSync(path.join(root, '.git', 'objects'), { recursive: true });
    fs.mkdirSync(path.join(root, 'dist', 'platform'), { recursive: true });
    fs.mkdirSync(data, { recursive: true });
    fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ version: '1.1.0' }));
    fs.writeFileSync(path.join(root, 'src', 'server.js'), 'old');
    fs.writeFileSync(path.join(root, '.git', 'objects', 'keep'), 'git-data');
    fs.writeFileSync(path.join(root, 'dist', 'platform', 'build.bin'), 'build-data');
    fs.writeFileSync(path.join(data, 'keep.txt'), '用户数据');

    fs.mkdirSync(path.join(newPackage, 'src'), { recursive: true });
    fs.mkdirSync(path.join(newPackage, 'node_modules', 'playwright'), { recursive: true });
    fs.writeFileSync(path.join(newPackage, 'package.json'), JSON.stringify({ version: '1.2.0' }));
    fs.writeFileSync(path.join(newPackage, 'src', 'server.js'), 'new');
    const archive = path.join(base, 'update.zip');
    zipFolder(newPackage, archive);

    execFileSync(process.execPath, [path.resolve(import.meta.dirname, '..', 'scripts', 'update-helper.mjs'),
      '--package', archive, '--version', '1.2.0', '--root', root, '--data', data, '--no-restart'
    ], { stdio: 'pipe' });

    assert.equal(fs.readFileSync(path.join(root, 'src', 'server.js'), 'utf8'), 'new');
    assert.equal(fs.readFileSync(path.join(root, '.git', 'objects', 'keep'), 'utf8'), 'git-data');
    assert.equal(fs.readFileSync(path.join(root, 'dist', 'platform', 'build.bin'), 'utf8'), 'build-data');
    assert.equal(fs.readFileSync(path.join(data, 'keep.txt'), 'utf8'), '用户数据');
    const backups = fs.readdirSync(path.join(data, 'updates')).filter(name => name.startsWith('backup-app-'));
    assert.equal(backups.length, 1);
    const backup = path.join(data, 'updates', backups[0]);
    assert.equal(fs.existsSync(path.join(backup, '.git')), false);
    assert.equal(fs.existsSync(path.join(backup, 'dist')), false);
    assert.equal(fs.readFileSync(path.join(backup, 'src', 'server.js'), 'utf8'), 'old');
  } finally { fs.rmSync(base, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); }
});
