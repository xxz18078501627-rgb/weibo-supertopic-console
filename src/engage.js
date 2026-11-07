import { listAccountGroups } from './account-groups.js';
import { id } from './util.js';
import { normalizeEngageSettings } from '../public/defaults.js';
import { listRepostMaterials, listCommentMaterials, getSetting } from './db.js';

// 解析一条微博链接，返回规范链接、帖子 id 与作者 UID；无法解析时给出原因。
export function parseWeiboLink(raw) {
  const value = String(raw || '').trim();
  if (!value) return { ok: false, raw: value, reason: '空链接' };
  let url;
  try { url = new URL(value); } catch { return { ok: false, raw: value, reason: '不是有效链接' }; }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return { ok: false, raw: value, reason: '仅支持 http/https 链接' };
  const host = url.hostname.toLowerCase();
  const isWeibo = ['weibo.com','www.weibo.com','m.weibo.cn','weibo.cn'].includes(host) && !url.username && !url.password && (!url.port || ['80','443'].includes(url.port));
  if (!isWeibo) return { ok: false, raw: value, reason: '不是微博链接' };
  let id = '';
  let authorUid = '';
  let m = url.pathname.match(/^\/(\d+)\/([A-Za-z0-9]+)$/);
  if ((host === 'weibo.com' || host.endsWith('.weibo.com')) && m) { authorUid = m[1]; id = m[2]; }
  if (!id) {
    m = url.pathname.match(/^\/(?:detail|status)\/([A-Za-z0-9]+)$/);
    if (m) id = m[1];
  }
  if (!id) return { ok: false, raw: value, reason: '无法识别微博 id（短链请先展开为完整链接）' };
  const canonicalUrl = authorUid ? 'https://weibo.com/' + authorUid + '/' + id : 'https://' + host + url.pathname;
  return { ok: true, raw: value, canonicalUrl, id, authorUid };
}
export function parseEngageLinks(rawLinks) {
  const inputs = Array.isArray(rawLinks) ? rawLinks : [];
  const parsed = [...new Set(inputs.map(item => String(item || '').trim()).filter(Boolean))].map(parseWeiboLink);
  const links = [...new Set(parsed.filter(item => item.ok).map(item => item.canonicalUrl))];
  const invalidLinks = parsed.filter(item => !item.ok).map(item => item.raw);
  return { links, invalidLinks };
}

export function createEngageSnapshot(input, accounts) {
  const saved = getSetting('engage_defaults', {}) || {};
  const draft = { ...normalizeEngageSettings(saved), ...(input || {}) };
  if (Object.hasOwn(input || {}, 'innerLikeKeyword') && !Object.hasOwn(input, 'innerLikeKeywords')) delete draft.innerLikeKeywords;
  if (Object.hasOwn(input || {}, 'likeBlacklistUids') && !Object.hasOwn(input, 'likeBlacklistProfiles')) delete draft.likeBlacklistProfiles;
  const merged = normalizeEngageSettings(draft);
  const accountIds = [...new Set(merged.accountIds)]
    .filter(accountId => accounts.some(item => item.id === accountId && item.enabled));
  const { links, invalidLinks } = parseEngageLinks(merged.links);
  const groups = new Map(listAccountGroups().map(group => [group.id, group.name]));
  const inGroup = (item, ids) => !ids || !ids.length || ids.includes(item.group_id || '');
  const plan = merged.actionPlan;
  return {
    ...merged,
    kind: 'engage',
    snapshotVersion: 7,
    schedulerVersion: 5,
    accountIds,
    accountIdentities: Object.fromEntries(accounts.filter(account => accountIds.includes(account.id)).map(account => [account.id, { name: account.nickname || account.name, uid: account.uid || '', groupName: groups.get(account.group_id || '') || '未分组' }])),
    links,
    invalidLinks,
    linkIdentities: Object.fromEntries(links.map(url => {
      const parsed = parseWeiboLink(url);
      return [url, { url, name: parsed.ok ? '微博 ' + parsed.id.slice(0, 8) : url.slice(0, 24) }];
    })),
    actionPlan: plan,
    segmentIds: plan.map((item, index) => item.segmentId || merged.segmentIds?.[index] || id('seg_')),
    materials: {
      reposts: listRepostMaterials().filter(item => item.enabled && inGroup(item, merged.repostGroupIds)).map(({ id: mid, text }) => ({ id: mid, text })),
      comments: listCommentMaterials().filter(item => item.enabled && inGroup(item, merged.commentGroupIds)).map(({ id: mid, text }) => ({ id: mid, text }))
    }
  };
}

// Scheduler v5 uses Weibo's native "同时评论" toggle on repost.  The linked
// comment row remains in the ledger for progress and reporting, but it is a
// mirrored outcome and must never submit a separate operation.  Comment-side
// "同时转发" is deliberately unsupported because its result cannot be audited.
export function engageStepCoupling(config, step) {
  if (!config || config.kind !== 'engage' || Number(config.schedulerVersion || 0) < 5) return null;
  if (!step || !['repost', 'comment'].includes(step.kind)) return null;
  const actionIndex = Number(step.actionIndex);
  const group = config.actionPlan?.[actionIndex];
  if (!group || !['repost', 'comment'].includes(group.type)) return null;
  const companionKind = group.type === 'repost' && group.alsoComment ? 'comment' : '';
  if (!companionKind) return null;
  const segmentId = String(group.segmentId || config.segmentIds?.[actionIndex] || '');
  if (!segmentId) return null;
  const companionSegmentId = segmentId + '_couple_' + companionKind;
  const rowSegmentId = String(step.segmentId || '');
  const isPrimary = step.kind === group.type && rowSegmentId === segmentId;
  const isCompanion = step.kind === companionKind && rowSegmentId === companionSegmentId;
  if (!isPrimary && !isCompanion) return null;
  return {
    actionIndex,
    group,
    segmentId,
    companionSegmentId,
    companionKind,
    isPrimary,
    isCompanion,
    primaryStep: { ...step, kind: group.type, segmentId },
    companionStep: { ...step, kind: companionKind, segmentId: companionSegmentId }
  };
}

export function buildEngageSteps(snapshot) {
  const steps = [];
  const plan = snapshot.actionPlan || [];
  const push = (round, link, accountId, kind, actionIndex, segmentId, unitIndex) =>
    steps.push({ round, topicId: link, link, accountId, kind, actionIndex, segmentId, unitIndex });
  for (let round = 0; round < snapshot.rounds; round += 1) {
    for (const link of snapshot.links) {
      if (Number(snapshot.schedulerVersion || 0) >= 4) {
        for (const accountId of snapshot.accountIds) {
          if (round === 0 && snapshot.likePost) push(round, link, accountId, 'like', -1, 'like-post', 0);
          plan.forEach((group, actionIndex) => {
            const segmentId = group.segmentId || snapshot.segmentIds?.[actionIndex];
            const count = Math.max(1, Math.min(100, Number(group.count) || 1));
            for (let unitIndex = 0; unitIndex < count; unitIndex += 1) {
              push(round, link, accountId, group.type, actionIndex, segmentId, unitIndex);
              if (group.type === 'repost' && group.alsoComment) push(round, link, accountId, 'comment', actionIndex, segmentId + '_couple_comment', unitIndex);
            }
          });
        }
        continue;
      }
      // Existing snapshots retain their original segment-first ordering.
      if (round === 0 && snapshot.likePost) {
        for (const accountId of snapshot.accountIds) push(round, link, accountId, 'like', -1, 'like-post', 0);
      }
      plan.forEach((group, actionIndex) => {
        const segmentId = group.segmentId || snapshot.segmentIds?.[actionIndex];
        const count = Math.max(1, Math.min(100, Number(group.count) || 1));
        for (const accountId of snapshot.accountIds) {
          for (let unitIndex = 0; unitIndex < count; unitIndex += 1) {
            push(round, link, accountId, group.type, actionIndex, segmentId, unitIndex);
            if (group.type === 'repost' && group.alsoComment) push(round, link, accountId, 'comment', actionIndex, segmentId + '_couple_comment', unitIndex);
          }
        }
      });
    }
  }
  return steps;
}

export function engageExpectedCounts(snapshot) {
  const accounts = snapshot.accountIds?.length || 0;
  const links = snapshot.links?.length || 0;
  const rounds = snapshot.rounds || 1;
  const counts = { repost: 0, comment: 0, comment_like: 0, like: snapshot.likePost ? accounts * links : 0 };
  for (const group of snapshot.actionPlan || []) {
    const base = accounts * links * rounds * Number(group.count || 0);
    counts[group.type] = (counts[group.type] || 0) + base;
    if (group.type === 'repost' && group.alsoComment) counts.comment += base;
  }
  return counts;
}

export function validateEngageSnapshot(snapshot) {
  const errors = [];
  if (!snapshot.accountIds?.length) errors.push('至少选择一个启用账号');
  if (!snapshot.links?.length) errors.push('至少输入一条有效的微博链接');
  if (snapshot.invalidLinks?.length) errors.push('存在无法识别的链接：' + snapshot.invalidLinks.slice(0, 5).join('、') + (snapshot.invalidLinks.length > 5 ? ' 等' : ''));
  const plan = snapshot.actionPlan || [];
  if (!plan.length || !plan.some(item => item.count > 0)) errors.push('至少配置一个操作');
  if (plan.some(item => !['repost', 'comment', 'comment_like'].includes(item.type))) errors.push('操作计划包含无效项目');
  const needsRepost = plan.some(item => item.type === 'repost' && (item.repostForm || snapshot.repostForm) !== 'plain');
  if (needsRepost && new Set((snapshot.materials?.reposts || []).map(item => item.text.trim())).size < 2) {
    errors.push('带文字转发需要至少两条转发文案');
  }
  if (plan.some(item => item.type === 'comment' || (item.type === 'repost' && item.alsoComment)) && new Set((snapshot.materials?.comments || []).map(item => item.text.trim())).size < 2) {
    errors.push('评论需要至少两条评论文案');
  }
  return errors;
}
