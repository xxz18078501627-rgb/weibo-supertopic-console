import assert from 'node:assert/strict';import fs from 'node:fs';import os from 'node:os';import path from 'node:path';import test from 'node:test';import { DatabaseSync } from 'node:sqlite';
import { migrateMaterialGroupsV2, migrateMaterialGroupIntegrity } from '../src/migrations.js';
function fixture(){const db=new DatabaseSync(':memory:');const dir=fs.mkdtempSync(path.join(os.tmpdir(),'material-migration-'));db.exec('CREATE TABLE settings(key TEXT PRIMARY KEY,value TEXT); CREATE TABLE shared_post_materials(id TEXT PRIMARY KEY,text TEXT,group_id TEXT); CREATE TABLE comment_materials(id TEXT PRIMARY KEY,text TEXT,group_id TEXT); CREATE TABLE repost_materials(id TEXT PRIMARY KEY,text TEXT,group_id TEXT)');return{db,dir,read:key=>JSON.parse(db.prepare('SELECT value FROM settings WHERE key=?').get(key)?.value||'null'),write:(key,value)=>db.prepare('INSERT OR REPLACE INTO settings VALUES(?,?)').run(key,JSON.stringify(value)),close:()=>{db.close();fs.rmSync(dir,{recursive:true,force:true});}};}

test('旧共享组迁移不丢文案，默认和模板重映射；转发类型与已选组保留，重启幂等',()=>{
 const f=fixture();try{
 f.write('material_groups',[{id:'old',name:'原组'},{id:'repost',name:'转发独立组',type:'repost'}]);
 f.db.prepare('INSERT INTO shared_post_materials VALUES(?,?,?)').run('p','发帖原文','old');f.db.prepare('INSERT INTO comment_materials VALUES(?,?,?)').run('c','评论原文','old');f.db.prepare('INSERT INTO repost_materials VALUES(?,?,?)').run('r','转发原文','repost');
 f.write('task_defaults',{postGroupIds:['old'],commentGroupIds:['old'],repostGroupIds:['repost']});f.write('engage_defaults',{commentGroupIds:['old'],repostGroupIds:['repost']});f.write('task_templates',[{id:'t',config:{postGroupIds:['old'],commentGroupIds:['old'],repostGroupIds:['repost']}}]);
 f.write('engage_templates',[{id:'eng-template',config:{commentGroupIds:['old'],repostGroupIds:['repost']}}]);
 const backup=migrateMaterialGroupsV2(f.db,f.dir);assert.ok(fs.existsSync(backup));migrateMaterialGroupIntegrity(f.db,f.dir);
 const groups=f.read('material_groups');assert.equal(groups.length,3);assert.equal(groups.find(g=>g.id==='old').type,'post');assert.equal(groups.find(g=>g.id==='old_comment').type,'comment');
 assert.equal(f.db.prepare('SELECT group_id FROM shared_post_materials').get().group_id,'old');assert.equal(f.db.prepare('SELECT group_id FROM comment_materials').get().group_id,'old_comment');assert.equal(f.db.prepare('SELECT group_id FROM repost_materials').get().group_id,'repost');
 assert.deepEqual(f.read('engage_templates')[0].config.commentGroupIds,['old_comment']);assert.deepEqual(f.read('engage_templates')[0].config.repostGroupIds,['repost']);assert.deepEqual(f.read('task_defaults').commentGroupIds,['old_comment']);assert.deepEqual(f.read('task_templates')[0].config.commentGroupIds,['old_comment']);assert.deepEqual(f.read('engage_defaults').commentGroupIds,['old_comment']);assert.deepEqual(f.read('task_defaults').repostGroupIds,['repost']);
 migrateMaterialGroupsV2(f.db,f.dir);migrateMaterialGroupIntegrity(f.db,f.dir);assert.deepEqual(f.read('material_groups'),groups);
 }finally{f.close();}
});

test('修复旧后台在v2迁移后新建的无类型/错类型组，分别复制且保留全部数据',()=>{
 const f=fixture();try{
 f.write('material_groups_v2',{done:true});f.write('material_groups',[{id:'untyped',name:'无类型旧组'},{id:'wrong',name:'旧后台错组',type:'post'},{id:'right',name:'评论正常组',type:'comment'}]);
 for(const [table,id,group] of [['shared_post_materials','p','wrong'],['comment_materials','c','wrong'],['repost_materials','r','wrong'],['comment_materials','c2','right']])f.db.prepare('INSERT INTO '+table+' VALUES(?,?,?)').run(id,id+'原文',group);
 f.write('engage_defaults',{commentGroupIds:['wrong'],repostGroupIds:['wrong']});
 f.write('engage_templates',[{id:'eng',config:{commentGroupIds:['wrong'],repostGroupIds:['wrong']}}]);
 migrateMaterialGroupIntegrity(f.db,f.dir);const groups=f.read('material_groups');
 assert.deepEqual(f.read('engage_templates')[0].config.commentGroupIds,['wrong_comment']);assert.deepEqual(f.read('engage_templates')[0].config.repostGroupIds,['wrong_repost']);
 for(const [table,type]of [['shared_post_materials','post'],['comment_materials','comment'],['repost_materials','repost']]) for(const row of f.db.prepare('SELECT * FROM '+table).all())assert.equal(groups.find(g=>g.id===row.group_id).type,type);
 assert.deepEqual(f.read('engage_defaults').commentGroupIds,['wrong_comment']);assert.deepEqual(f.read('engage_defaults').repostGroupIds,['wrong_repost']);assert.equal(f.db.prepare('SELECT COUNT(*) n FROM comment_materials').get().n,2);assert.equal(groups.find(g=>g.id==='right').name,'评论正常组');
 }finally{f.close();}
});
