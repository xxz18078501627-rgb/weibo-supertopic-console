import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { execFileSync } from 'node:child_process';

test('管理版安装生成固定启动、维护和服务入口，并初始化独立数据目录', () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'weibo-managed-install-'));
  try {
    const packageRoot = path.join(base, 'payload', 'weibo-console-1.1.0');
    const installRoot = path.join(base, '中文 安装目录');
    fs.mkdirSync(path.join(packageRoot, 'scripts'), { recursive: true });
    fs.mkdirSync(path.join(packageRoot, 'data'), { recursive: true });
    fs.copyFileSync(path.resolve(import.meta.dirname, '..', 'scripts', 'managed-install.mjs'), path.join(packageRoot, 'scripts', 'managed-install.mjs'));
    fs.writeFileSync(path.join(packageRoot, 'package.json'), JSON.stringify({ version: '1.1.0' }));
    fs.writeFileSync(path.join(packageRoot, 'data', 'console.sqlite'), 'seed');
    fs.writeFileSync(path.join(packageRoot, 'scripts', 'service.mjs'), '');

    execFileSync(process.execPath, [path.join(packageRoot, 'scripts', 'managed-install.mjs'), '--install-root', installRoot], {
      env: { ...process.env, WEIBO_CONSOLE_INSTALL_NO_SERVICE: '1' }, stdio: 'pipe'
    });

    assert.equal(JSON.parse(fs.readFileSync(path.join(installRoot, 'current.json'), 'utf8')).version, '1.1.0');
    assert.equal(fs.readFileSync(path.join(installRoot, 'data', 'console.sqlite'), 'utf8'), 'seed');
    for (const file of ['launcher.mjs', 'bootstrap.mjs', 'service.mjs']) {
      const target = path.join(installRoot, file);
      assert.ok(fs.existsSync(target), file);
      execFileSync(process.execPath, ['--check', target], { stdio: 'pipe' });
    }
    assert.match(fs.readFileSync(path.join(installRoot, 'launcher.mjs'), 'utf8'), /service-runner\.mjs/);
  } finally { fs.rmSync(base, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); }
});
