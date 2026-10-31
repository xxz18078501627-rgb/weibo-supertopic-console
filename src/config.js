import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { normalizeDecoration } from '../public/defaults.js';

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function resolveChromePath() {
  if (process.env.WEIBO_CONSOLE_CHROME) return process.env.WEIBO_CONSOLE_CHROME;
  const candidates = process.platform === 'darwin'
    ? ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/Applications/Chromium.app/Contents/MacOS/Chromium']
    : process.platform === 'win32'
      ? [
        path.join(process.env.ProgramFiles || 'C:\\Program Files', 'Google/Chrome/Application/chrome.exe'),
        path.join(process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)', 'Google/Chrome/Application/chrome.exe'),
        path.join(process.env.LOCALAPPDATA || '', 'Google/Chrome/Application/chrome.exe')
      ]
      : ['/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser', '/snap/bin/chromium'];
  return candidates.find(candidate => candidate && fs.existsSync(candidate)) || '';
}

export const config = {
  topicMode: process.env.WEIBO_CONSOLE_TOPIC_MODE === 'general' ? 'general' : 'fixed',
  rootDir,
  publicDir: path.join(rootDir, 'public'),
  dataDir: process.env.WEIBO_CONSOLE_DATA_DIR || path.join(rootDir, 'data'),
  host: process.env.WEIBO_CONSOLE_HOST || '0.0.0.0',
  port: Number(process.env.WEIBO_CONSOLE_PORT || 4178),
  timezone: 'Asia/Shanghai',
  // 空字符串表示回落到 Playwright 自带的 Chromium（跨平台兜底）。
  chromePath: resolveChromePath()
};

export const defaultTaskConfig = {
  syncToHome: false,
  rounds: 1,
  actionPlan: [
    { type: 'checkin', count: 1, intervalSeconds: 5 },
    { type: 'comment', count: 4, intervalSeconds: 3 },
    { type: 'post', count: 10, intervalSeconds: 10 }
  ],
  commentStrategy: 'random',
  commentSection: config.topicMode === 'general' ? '最新' : '超like',
  scanLimit: 30,
  commentMaxCountEnabled: false,
  commentMaxCount: 20,
  candidateRefreshSeconds: 3,
  roundIntervalSeconds: 60,
  readRetryCount: 2,
  postDecoration: normalizeDecoration(),
  commentDecoration: normalizeDecoration()
};
