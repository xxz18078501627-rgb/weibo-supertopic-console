export const FIXED_TOPIC = { name: '苏新皓', pageId: '10080819a5137ac9109462f670e39aaf64b1a0', url: 'https://weibo.com/p/10080819a5137ac9109462f670e39aaf64b1a0' };
export const COMMENT_SECTIONS = ['热门', '最新', '精华', '皓皓长大', '线下互助', '超like', '饭拍图频', '美工产出', '灯灯通知', '创作🫙', '水帖', '同款'];
export function isFixedTopic(topic) {
  try { const url = new URL(topic.url); return url.protocol === 'https:' && url.hostname === 'weibo.com' && (url.pathname === `/p/${FIXED_TOPIC.pageId}` || url.pathname.startsWith(`/p/${FIXED_TOPIC.pageId}/`)); } catch { return false; }
}
