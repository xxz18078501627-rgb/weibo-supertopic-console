// Shared by the browser and server so defaults cannot drift between them.
export const DEFAULT_EMOJIS = [
  '😀', '😃', '😄', '😁', '😊', '🙂', '😉', '😎',
  '🤗', '🤩', '🥳', '😌', '😍', '🥰', '🤔', '🤝',
  '👍', '👏', '🙌', '💪', '✨', '🌟', '🎉', '❤️'
];
export const LEGACY_EMOJIS = ['🙂', '👏', '✨', '🌟'];
export const DEFAULT_ACTION_INTERVALS = { checkin: 5, post: 10, original: 10, comment: 3 };
export const DEFAULT_ENGAGE_INTERVALS = { repost: 3, comment: 3, comment_like: 3 };
export const DEFAULT_ENGAGE_COUNTS = { repost: 10, comment: 10, comment_like: 20 };
export const ENGAGE_ACTION_TYPES = ['repost', 'comment', 'comment_like'];

export function isWeiboLink(value) {
  const raw = String(value || '').trim();
  if (!raw) return false;
  let url;
  try { url = new URL(raw); } catch { return false; }
  if (!['https:', 'http:'].includes(url.protocol)) return false;
  const host = url.hostname.toLowerCase();
  if (host !== 'weibo.com' && host !== 'm.weibo.cn' && host !== 'weibo.cn' && !host.endsWith('.weibo.com') && !host.endsWith('.weibo.cn')) return false;
  return true;
}

function clampNumber(value, min, max, fallback) {
  const n = Number(value);
  return Number.isFinite(n) ? Math.max(min, Math.min(max, Math.trunc(n))) : fallback;
}

function cleanList(value) {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.map(item => String(item || '').trim()).filter(Boolean))];
}

export function splitEngageKeywords(value) {
  return [...new Set((Array.isArray(value) ? value : String(value || "").split(/[、,，\r\n]+/)).map(item => String(item).trim()).filter(Boolean))];
}

export function engageTemplateConfig(value = {}) {
  const { accountIds, links, ...config } = normalizeEngageSettings(value);
  return config;
}

export function normalizeEngageSettings(value = {}) {
  const actionPlan = Array.isArray(value.actionPlan)
    ? value.actionPlan
    : [{ type: 'repost', count: 10, intervalSeconds: DEFAULT_ENGAGE_INTERVALS.repost }];
  return {
    kind: 'engage',
    rounds: clampNumber(value.rounds, 1, 100, 1),
    roundIntervalSeconds: clampNumber(value.roundIntervalSeconds, 0, 86400, 60),
    accountIds: Array.isArray(value.accountIds) ? [...new Set(value.accountIds.map(String))] : [],
    links: cleanList(value.links),
    likePost: value.likePost === true,
    repostForm: value.repostForm === 'plain' ? 'plain' : 'text',
    innerLikeKeyword: splitEngageKeywords(value.innerLikeKeywords ?? value.innerLikeKeyword).join('、'),
    innerLikeKeywords: splitEngageKeywords(value.innerLikeKeywords ?? value.innerLikeKeyword),
    likeBlacklistProfiles: Array.isArray(value.likeBlacklistProfiles) ? cleanList(value.likeBlacklistProfiles) : cleanList(value.likeBlacklistUids).map(uid => 'https://weibo.com/u/' + uid),
    likeBlacklistUids: cleanList(value.likeBlacklistUids),
    likeBlacklistKeywords: cleanList(value.likeBlacklistKeywords),
    segmentIds: Array.isArray(value.segmentIds) ? value.segmentIds.map(String) : [],
    actionPlan: actionPlan.map(item => ({
      type: String(item.type || 'repost'),
      segmentId: typeof item.segmentId === 'string' ? item.segmentId : undefined,
      repostForm: item.repostForm === 'plain' ? 'plain' : item.repostForm === 'text' ? 'text' : value.repostForm === 'plain' ? 'plain' : 'text',
      count: clampNumber(item.count ?? DEFAULT_ENGAGE_COUNTS[item.type], 1, 100, DEFAULT_ENGAGE_COUNTS[item.type] || 10),
      intervalSeconds: Math.max(0, Math.min(3600, Number(item.intervalSeconds ?? DEFAULT_ENGAGE_INTERVALS[item.type]) || 0)),
      alsoComment: item.alsoComment === true,
      // 已停用：评论无法可靠核对“同时转发”的结果，历史输入统一降级为关闭。
      alsoRepost: false,
      includeVisibleReplies: item.type === 'comment_like' && item.includeVisibleReplies === true
    })),
    repostDecoration: normalizeDecoration(value.repostDecoration),
    commentDecoration: normalizeDecoration(value.commentDecoration || value.decoration),
    repostGroupIds: cleanList(value.repostGroupIds),
    commentGroupIds: cleanList(value.commentGroupIds)
  };
}

export function normalizeActionPlan(plan, settings = {}) {
  return plan.map(item => {
    const fallback = DEFAULT_ACTION_INTERVALS[item.type] ?? 0;
    const raw = item.intervalSeconds ?? settings[`${item.type}IntervalSeconds`] ?? fallback;
    const seconds = Number(raw);
    return { ...item, intervalSeconds: Number.isFinite(seconds) ? Math.max(0, Math.min(3600, Math.trunc(seconds))) : fallback };
  });
}

export function normalizeDecoration(value = {}) {
  const emojis = Array.isArray(value.emojis) ? value.emojis : DEFAULT_EMOJIS;
  const isLegacyDefault = JSON.stringify(emojis) === JSON.stringify(LEGACY_EMOJIS);
  return {
    mode: ['none', 'emoji', 'number', 'emoji-and-number'].includes(value.mode) ? value.mode : 'none',
    emojis: [...new Set((isLegacyDefault ? DEFAULT_EMOJIS : emojis).map(String).map(s => s.trim()).filter(Boolean))],
    emojiPosition: value.emojiPosition === 'prefix' ? 'prefix' : 'suffix',
    numberPosition: value.numberPosition === 'prefix' ? 'prefix' : 'suffix'
  };
}

export function normalizeTaskSettings(value = {}) {
  const { actionIntervalSeconds, checkinIntervalSeconds, postIntervalSeconds, commentIntervalSeconds, ...settings } = value;
  const refresh = Number(value.candidateRefreshSeconds);
  return {
    ...settings,
    ...(Array.isArray(value.actionPlan) ? { actionPlan: normalizeActionPlan(value.actionPlan, value) } : {}),
    syncToHome: value.syncToHome === true,
    commentSection: String(value.commentSection ?? '').trim() || '超like',
    scanLimit: Math.max(1, Math.min(500, Number(value.scanLimit) || 30)),
    candidateRefreshSeconds: !Number.isFinite(refresh) ? 3 : refresh === 0 ? 0 : Math.max(3, Math.min(3600, Math.trunc(refresh))),
    commentMaxCountEnabled: value.commentMaxCountEnabled === true,
    commentMaxCount: 20,
    postDecoration: normalizeDecoration(value.postDecoration),
    commentDecoration: normalizeDecoration(value.commentDecoration || value.decoration)
  };
}
