import fs from 'node:fs';
import path from 'node:path';
import { createPublicKey, verify } from 'node:crypto';
import { config } from './config.js';

// 公钥随代码发布；私钥只在管理员本机（~/.weibo-console/license-key.pem）。
const PUBLIC_KEY_PEM = `-----BEGIN PUBLIC KEY-----
MCowBQYDK2VwAyEAbJVISecDMxzmGgixeFFloyULwBZAdm8zcxSLu3NQ1F4=
-----END PUBLIC KEY-----
`;

export const LICENSE_PREFIX = 'WBC1';

// 开发/测试可整体关闭授权校验（WEIBO_CONSOLE_LICENSE=off）。
export function licenseEnabled() {
  return process.env.WEIBO_CONSOLE_LICENSE !== 'off';
}

export function licensePath(dataDir = config.dataDir) {
  return path.join(dataDir, 'license.json');
}

export function verifyCode(code, publicKeyPem = PUBLIC_KEY_PEM) {
  const raw = String(code || '').replace(/\s+/g, '');
  const parts = raw.split('.');
  if (parts.length !== 3 || parts[0] !== LICENSE_PREFIX) throw new Error('激活码格式不正确');
  let payload;
  try {
    payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
  } catch {
    throw new Error('激活码内容无法解析');
  }
  if (payload.v !== 1 || !payload.user || !payload.token) throw new Error('激活码内容不完整');
  const ok = verify(null, Buffer.from(parts[1], 'base64url'), createPublicKey(publicKeyPem), Buffer.from(parts[2], 'base64url'));
  if (!ok) throw new Error('激活码签名无效');
  return { code: raw, payload };
}

export function readLicense(dataDir = config.dataDir, publicKeyPem = PUBLIC_KEY_PEM) {
  try {
    const saved = JSON.parse(fs.readFileSync(licensePath(dataDir), 'utf8'));
    const { payload } = verifyCode(saved.code, publicKeyPem);
    return { ...saved, payload };
  } catch {
    return null;
  }
}

export function activate(code, dataDir = config.dataDir, publicKeyPem = PUBLIC_KEY_PEM) {
  const info = verifyCode(code, publicKeyPem);
  fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  fs.writeFileSync(licensePath(dataDir), JSON.stringify({
    code: info.code,
    payload: info.payload,
    activatedAt: new Date().toISOString()
  }, null, 2), { mode: 0o600 });
  fs.writeFileSync(path.join(dataDir, 'access-token'), info.payload.token + '\n', { mode: 0o600 });
  return info.payload;
}

export function licenseStatus(dataDir = config.dataDir) {
  if (!licenseEnabled()) return { enabled: false, activated: true, user: 'dev' };
  const saved = readLicense(dataDir);
  return { enabled: true, activated: Boolean(saved), user: saved?.payload?.user || '' };
}
