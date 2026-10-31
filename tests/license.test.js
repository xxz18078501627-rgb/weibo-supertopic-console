import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { generateKeyPairSync, sign } from 'node:crypto';

const { verifyCode, activate, readLicense } = await import('../src/license.js');

function makeCode(payload, key, prefix = 'WBC1') {
  const encoded = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
  const signature = sign(null, Buffer.from(encoded, 'base64url'), key).toString('base64url');
  return `${prefix}.${encoded}.${signature}`;
}

function keys() {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  return { publicKey: publicKey.export({ type: 'spki', format: 'pem' }), privateKey };
}

test('激活码签名校验、篡改与错误密钥都会被拒', () => {
  const { publicKey, privateKey } = keys();
  const payload = { v: 1, user: '张三', token: 'test-token', iat: 1 };
  const code = makeCode(payload, privateKey);
  assert.equal(verifyCode(code, publicKey).payload.token, 'test-token');

  const [prefix, encoded, signature] = code.split('.');
  const tampered = Buffer.from(JSON.stringify({ ...payload, token: 'hacked' }), 'utf8').toString('base64url');
  assert.throws(() => verifyCode([prefix, tampered, signature].join('.'), publicKey), /签名无效/);
  assert.throws(() => verifyCode('WBC2.' + encoded + '.' + signature, publicKey), /格式不正确/);
  assert.throws(() => verifyCode('not-a-code', publicKey), /格式不正确/);
  assert.throws(() => verifyCode(code, keys().publicKey), /签名无效/);
});

test('激活写入 license.json 与口令文件', () => {
  const { publicKey, privateKey } = keys();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'weibo-license-'));
  const code = makeCode({ v: 1, user: '李四', token: 'lisi1234', iat: 2 }, privateKey);
  const payload = activate(code, dir, publicKey);
  assert.equal(payload.user, '李四');
  assert.equal(fs.readFileSync(path.join(dir, 'access-token'), 'utf8').trim(), 'lisi1234');
  assert.equal(readLicense(dir, publicKey).payload.token, 'lisi1234');
  assert.equal(verifyCode(readLicense(dir, publicKey).code, publicKey).payload.user, '李四');
  fs.rmSync(dir, { recursive: true, force: true });
});
