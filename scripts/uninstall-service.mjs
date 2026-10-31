import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const label = 'com.local.weibo-super-topic-console';
const plistPath = path.join(os.homedir(), 'Library', 'LaunchAgents', `${label}.plist`);
const domain = `gui/${process.getuid()}`;
try { execFileSync('/bin/launchctl', ['bootout', domain, plistPath], { stdio: 'ignore' }); } catch {}
if (fs.existsSync(plistPath)) {
  const trashDir = path.join(os.homedir(), '.Trash');
  fs.mkdirSync(trashDir, { recursive: true });
  const destination = path.join(trashDir, `${label}-${Date.now()}.plist`);
  fs.renameSync(plistPath, destination);
  console.log(`服务已停止，配置已移到废纸篓：${destination}`);
} else {
  console.log('服务未安装。');
}
