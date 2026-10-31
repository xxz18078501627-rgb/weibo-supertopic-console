#!/usr/bin/env node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { generateKeyPairSync, sign, createPrivateKey, createPublicKey } from 'node:crypto';

const homeDir = path.join(os.homedir(), '.weibo-console');
const keyPath = process.env.WEIBO_CONSOLE_LICENSE_KEY || path.join(homeDir, 'license-key.pem');
const publicPath = path.join(homeDir, 'license-public.pem');

function args() {
  const out = { _: [] };
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i += 1) {
    const item = argv[i];
    if (item.startsWith('--')) {
      const key = item.slice(2);
      const next = argv[i + 1];
      if (!next || next.startsWith('--')) out[key] = true;
      else { out[key] = next; i += 1; }
    } else out._.push(item);
  }
  return out;
}

const options = args();

if (options.init) {
  fs.mkdirSync(homeDir, { recursive: true, mode: 0o700 });
  if (fs.existsSync(keyPath) && !options.force) {
    console.log('私钥已存在：' + keyPath + '（如需重新生成加 --force，会导致所有旧激活码失效）');
    process.exit(0);
  }
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  fs.writeFileSync(keyPath, privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 });
  fs.writeFileSync(publicPath, publicKey.export({ type: 'spki', format: 'pem' }));
  console.log('已生成签名密钥：' + keyPath);
  console.log('把下面的公钥替换到 src/license.js 的 PUBLIC_KEY_PEM：');
  console.log(publicKey.export({ type: 'spki', format: 'pem' }).trim());
  process.exit(0);
}

const user = String(options.user || '').trim();
const token = String(options.token || '').trim();
if (!user || !token) {
  console.error('用法：npm run license -- --user 张三 --token 你的口令 [--repo https://github.com/owner/repo]');
  console.error('      首次使用：npm run license -- --init');
  process.exit(1);
}
if (!fs.existsSync(keyPath)) {
  console.error('找不到私钥：' + keyPath + '，先运行 npm run license -- --init');
  process.exit(1);
}

const payload = { v: 1, user, token, iat: Math.floor(Date.now() / 1000) };
const encoded = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
const key = createPrivateKey(fs.readFileSync(keyPath, 'utf8'));
const signature = sign(null, Buffer.from(encoded, 'base64url'), key).toString('base64url');
const code = 'WBC1.' + encoded + '.' + signature;

// 自检：用公钥验证一遍，避免生成出打不开的码。
const { verify } = await import('node:crypto');
const publicKey = fs.existsSync(publicPath)
  ? fs.readFileSync(publicPath, 'utf8')
  : createPublicKey(key).export({ type: 'spki', format: 'pem' });
if (!verify(null, Buffer.from(encoded, 'base64url'), createPublicKey(publicKey), Buffer.from(signature, 'base64url'))) {
  console.error('生成失败：签名自检未通过');
  process.exit(1);
}

const repo = String(options.repo || 'https://github.com/<owner>/weibo-supertopic-console').replace(/\/+$/, '');
console.log('激活码  ' + code);
console.log('口令    ' + token);
console.log('');
console.log('—— 发给 ' + user + ' 的 agent ——');
console.log('帮我装这个超话工作台：' + repo);
console.log('装好后把访问地址发我，激活码我另外给。');
console.log('');
console.log('—— 发给 ' + user + ' 本人 ——');
console.log('激活码：' + code);
console.log('访问口令：' + token);
