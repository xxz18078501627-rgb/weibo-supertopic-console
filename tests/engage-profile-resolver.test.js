import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveProfile, resolveBlacklist, resolveEngageSettings, profileOwnerUid, directProfileUid } from '../src/engage-profile-resolver.js';
import { normalizeEngageSettings, splitEngageKeywords, engageTemplateConfig } from '../public/defaults.js';

test('常见含UID主页和历史UID本地识别，不联网；拒绝微博正文和非官方地址', async () => {
  for (const url of ['https://weibo.com/u/123456','https://weibo.com/123456','https://m.weibo.cn/profile/123456','https://weibo.cn/u/123456','123456']) {
    assert.equal((await resolveProfile(url,{fetchImpl:()=>{throw Error('不应联网');}})).uid,'123456');
  }
  for (const url of ['https://weibo.com/123/ABC','https://m.weibo.cn/detail/123','https://weibo.com.evil.test/u/123','file:///etc/passwd','https://user:secret@weibo.com/u/123','https://weibo.com:8888/u/123','https://weibo.com/login']) await assert.rejects(resolveProfile(url));
});
test('昵称、个性地址和短链只识别作者oid/userInfo，不把登录用户uid当作者', async () => {
  assert.equal(profileOwnerUid("$CONFIG['uid']='999';$CONFIG['oid']='123';"),'123');
  assert.equal(profileOwnerUid("$CONFIG['uid']='999'; window.user={id:'888'};"),null);
  assert.equal(profileOwnerUid('<script>var comment = "$CONFIG[\'oid\']=\'777\';";</script>'),null);
  assert.equal(profileOwnerUid('<div>$CONFIG[\'oid\']=\'777\';</div>'),null);
  assert.equal(profileOwnerUid('{"oid":"123","viewer":{"id":"999"},"userInfo":{"idstr":"123","screen_name":"作者"}}'),'123');
  for (const raw of ['<script>var r=/$CONFIG[\'oid\']=\'777\'/;</script>', '<script>var r=/;$CONFIG[\'oid\']=\'777\'/;</script>', '<script><!-- $CONFIG[\'oid\']=\'777\';\n</script>', '{"userInfo":{"id":"999","screen_name":"viewer"}}', '[{"userInfo":{"id":"999","screen_name":"commenter"}}]']) assert.equal(profileOwnerUid(raw),null);
  assert.throws(()=>directProfileUid(new URL('https://evil.test/u/123')));
  await assert.rejects(resolveEngageSettings(null),error=>error.statusCode===400);
  const fetchImpl=async url=> url.includes('t.cn') ? new Response(null,{status:302,headers:{location:'https://weibo.com/n/%E7%A4%BA%E4%BE%8B%E4%BD%9C%E8%80%85'}}) : new Response("$CONFIG['uid']='999';$CONFIG['oid']='123';");
  assert.equal((await resolveProfile('https://t.cn/Test',{fetchImpl})).uid,'123');
  assert.equal((await resolveProfile('https://weibo.com/customauthor',{fetchImpl})).uid,'123');
  await assert.rejects(resolveProfile('https://weibo.com/n/test',{fetchImpl:async()=>new Response("$CONFIG['uid']='999';")}),/含 UID/);
});
test('重定向逐跳白名单、次数、超时和响应体大小均有界，错误行不静默忽略', async () => {
  let calls=0;
  await assert.rejects(resolveProfile('https://t.cn/test',{fetchImpl:async()=>{calls++;return new Response(null,{status:302,headers:{location:'http://127.0.0.1/admin'}});}}),/官方/);assert.equal(calls,1);
  calls=0;await assert.rejects(resolveProfile('https://t.cn/test',{fetchImpl:async()=>{calls++;return new Response(null,{status:302,headers:{location:'https://t.cn/again'}});}}));assert.equal(calls,4);
  await assert.rejects(resolveProfile('https://weibo.com/customauthor',{maxBytes:10,fetchImpl:async()=>new Response('x'.repeat(11))}),/过大/);
  await assert.rejects(resolveProfile('https://weibo.com/customauthor',{timeoutMs:10,fetchImpl:async(_url,{signal})=>new Promise((_,reject)=>signal.addEventListener('abort',()=>reject(new Error('aborted'))))}),/超时/);
  const result=await resolveBlacklist(['https://weibo.com/u/123','wrong','https://m.weibo.cn/profile/123']);assert.equal(result.valid,false);assert.equal(result.results[1].line,2);assert.ok(result.results[1].error);assert.deepEqual(result.uids,['123']);
  await assert.rejects(resolveEngageSettings({likeBlacklistProfiles:['wrong'],likeBlacklistUids:['123']}),/第 1 行/);
  assert.deepEqual((await resolveEngageSettings({likeBlacklistUids:['123']})).likeBlacklistProfiles,['https://weibo.com/u/123']);
});
test('多关键词去重、旧字符串兼容；模板只保存配置、不保存账号及微博链接', () => {
  assert.deepEqual(splitEngageKeywords(' 支持、加油、支持、、 '),['支持','加油']);
  assert.deepEqual(normalizeEngageSettings({innerLikeKeyword:'支持、加油'}).innerLikeKeywords,['支持','加油']);
  assert.deepEqual(normalizeEngageSettings({innerLikeKeyword:'旧词',innerLikeKeywords:[]}).innerLikeKeywords,[]);
  const config=engageTemplateConfig({accountIds:['private'],links:['https://weibo.com/1/A'],innerLikeKeyword:'支持、加油',likeBlacklistUids:['123'],rounds:3});
  assert.equal(config.accountIds,undefined);assert.equal(config.links,undefined);assert.equal(config.rounds,3);assert.deepEqual(config.likeBlacklistProfiles,['https://weibo.com/u/123']);
});
