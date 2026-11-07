import crypto from 'node:crypto';

export const now = () => new Date().toISOString();

export function shanghaiDate(date = new Date()) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit'
  }).format(date);
}

export function json(value, fallback = null) {
  if (value == null) return fallback;
  try { return JSON.parse(value); } catch { return fallback; }
}

export function id(prefix = '') {
  return `${prefix}${crypto.randomUUID()}`;
}

export function randomToken() {
  return crypto.randomBytes(18).toString('base64url');
}

export function parseCookies(header = '') {
  return Object.fromEntries(header.split(';').map(part => {
    const at = part.indexOf('=');
    if (at < 0) return ['', ''];
    return [part.slice(0, at).trim(), decodeURIComponent(part.slice(at + 1).trim())];
  }).filter(([key]) => key));
}

export function safeEqual(a, b) {
  const left = Buffer.from(String(a || ''));
  const right = Buffer.from(String(b || ''));
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}

export function clampInt(value, min, max, fallback) {
  const number = Number.parseInt(value, 10);
  return Number.isFinite(number) ? Math.min(max, Math.max(min, number)) : fallback;
}

export function pickRandom(items) {
  return items[Math.floor(Math.random() * items.length)];
}

export function serializeError(error) {
  return error instanceof Error ? error.message : String(error);
}

export function kindLabel(kind) {
  return { checkin: '签到', post: '发帖', comment: '评论', repost: '转发', like: '外赞', comment_like: '内赞' }[kind] || String(kind || '');
}
