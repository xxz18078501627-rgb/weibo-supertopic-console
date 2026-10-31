#!/usr/bin/env node
// 发布：可选抬版本 → 打包 → 提交打 tag → 用 gh 创建 Release 并上传 zip。
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const bumpIndex = argv.indexOf('--bump');
const bump = bumpIndex >= 0 ? argv[bumpIndex + 1] : '';
const notesIndex = argv.indexOf('--notes');
const notes = notesIndex >= 0 ? argv[notesIndex + 1] : '';

function run(cmd, args, options = {}) {
  return execFileSync(cmd, args, { cwd: root, stdio: 'inherit', ...options });
}

function hasGh() {
  try { execFileSync('gh', ['--version'], { stdio: 'ignore' }); return true; } catch { return false; }
}

if (bump) run('npm', ['version', bump, '--no-git-tag-version']);
const version = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version;
run(process.execPath, [path.join(root, 'scripts', 'build-release.mjs')]);

if (!hasGh()) {
  console.error('未找到 gh CLI：请先把 gh 安装到 PATH（./tools/gh 或系统安装），并执行 gh auth login。');
  process.exit(1);
}

const zip = path.join(root, 'dist', `weibo-console-${version}.zip`);
if (!fs.existsSync(path.join(root, '.git'))) run('git', ['init', '-b', 'main']);
try { run('git', ['add', '-A']); } catch {}
try { run('git', ['commit', '-m', `release v${version}`]); } catch (error) { console.log('没有新的改动需要提交，继续发布。'); }
try { run('git', ['tag', `v${version}`]); } catch { console.log('tag 已存在，继续。'); }
try { run('git', ['push', 'origin', 'HEAD', '--tags']); } catch { console.log('推送失败（可能还没配置 remote），继续上传 Release。'); }
try { run('gh', ['release', 'view', `v${version}`], { stdio: 'ignore' }); }
catch {
  run('gh', ['release', 'create', `v${version}`, zip, '--title', `v${version}`, '--notes', notes || `超话工作台 v${version}`]);
}
console.log('已发布 v' + version);
