// Stateless, public read-only profile resolution. Never uses an account browser/cookies.
const HOSTS = new Set(['weibo.com', 'www.weibo.com', 'm.weibo.cn', 'weibo.cn', 'www.weibo.cn', 't.cn']);
const UID = /^\d{1,20}$/;
const hint = '无法确认主页作者，请使用含 UID 的完整主页链接（如 https://weibo.com/u/1234567890）';
export function profileUrl(value) {
  const raw = String(value || '').trim();
  // Compatibility with pre-profile-link defaults; never rewrite historical jobs.
  if (UID.test(raw)) return new URL('https://weibo.com/u/' + raw);
  let url; try { url = new URL(raw); } catch { throw new Error('请输入完整的微博作者主页链接'); }
  if (!['http:', 'https:'].includes(url.protocol) || !HOSTS.has(url.hostname.toLowerCase()) || url.username || url.password || url.port) throw new Error('仅支持微博官方主页链接和 t.cn 短链');
  url.hash = ''; url.protocol = 'https:';
  if (url.hostname !== 't.cn' && !/^\/(?:u\/\d{1,20}|profile\/\d{1,20}|\d{1,20}|n\/[^/]+|[A-Za-z][\w-]*)\/?$/.test(url.pathname)) throw new Error('该地址不是作者主页，请勿输入微博正文或评论链接');
  if (/^\/(?:login|signup|detail|status|ajax|api|search|p|s|tv)\/?$/i.test(url.pathname)) throw new Error('该地址不是作者主页');
  return url;
}
export function directProfileUid(value) {
  const url = profileUrl(value instanceof URL ? value.href : value);
  if (url.hostname === 't.cn') return null;
  return url.pathname.match(/^\/(?:(?:u|profile)\/)?(\d{1,20})\/?$/)?.[1] || null;
}
// Find bootstrap assignments only in executable script, not inside a comment/string.
function outsideLiteral(source, end) {
  let quote = '', comment = '';
  for (let i = 0; i < end; i++) {
    const c = source[i], n = source[i + 1];
    if (comment === 'line') { if (c === '\n') comment = ''; continue; }
    if (comment === 'block') { if (c === '*' && n === '/') { comment = ''; i++; } continue; }
    if (quote) { if (c === '\\') i++; else if (c === quote) quote = ''; continue; }
    if (source.startsWith('<!--', i)) { comment = 'line'; i += 3; }
    else if (c === '/' && n === '/') { comment = 'line'; i++; }
    else if (c === '/' && n === '*') { comment = 'block'; i++; }
    else if (c === '/') {
      const prefix = source.slice(0, i).trimEnd();
      if (!prefix || /[=(:,!&|?;{\[]$/.test(prefix) || /\b(return|throw|case|yield)$/.test(prefix)) {
        let inClass = false;
        for (i++; i < end; i++) {
          if (source[i] === '\\') i++;
          else if (source[i] === '[') inClass = true;
          else if (source[i] === ']') inClass = false;
          else if (source[i] === '/' && !inClass) break;
        }
        if (i >= end) return false;
      }
    }
    else if (['"', "'", '`'].includes(c)) quote = c;
  }
  return !quote && !comment;
}
function bootstrapJson(source, start) {
  const opening = source[start]; if (!['{','['].includes(opening)) return null;
  let depth = 0, quoted = false;
  for (let i = start; i < source.length; i++) {
    const c = source[i];
    if (quoted) { if (c === '\\') i++; else if (c === '"') quoted = false; }
    else if (c === '"') quoted = true;
    else if (c === '[' || c === '{') depth++;
    else if (c === ']' || c === '}') { if (--depth === 0) { try { return JSON.parse(source.slice(start, i + 1)); } catch { return null; } } }
  }
  return null;
}
function jsonOwner(root) {
  // Generic userInfo / a first comments-array entry is NOT an owner claim.
  if (!root || Array.isArray(root) || typeof root !== 'object') return null;
  const owner = String(root.oid || root.profile_uid || root.data?.oid || root.data?.profile_uid || '');
  if (!UID.test(owner)) return null;
  const user = root.userInfo || root.data?.userInfo;
  if (user && String(user.idstr || user.id || '') !== owner) return null;
  return owner;
}
export function profileOwnerUid(html) {
  try { const owner = jsonOwner(JSON.parse(html)); if (owner) return owner; } catch {}
  const scripts = [...html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script\s*>/gi)].map(match => match[1]);
  if (!scripts.length && !/<[a-z!/]/i.test(html)) scripts.push(html);
  for (const source of scripts.slice(0, 64)) {
    let inspected = 0;
    // oid is the visited profile owner; uid is the viewer and MUST NOT be used.
    for (const match of source.matchAll(/(?:window\.)?\$CONFIG\s*\[\s*['"]oid['"]\s*\]\s*=\s*['"](\d{1,20})['"]/g)) {
      if (++inspected > 64) break;
      if (/(?:^|[;\n])\s*$/.test(source.slice(0, match.index)) && outsideLiteral(source, match.index)) return match[1];
    }
    for (const match of source.matchAll(/(?:\$render_data|(?:window\.)?__INITIAL_STATE__)\s*=\s*/g)) {
      if (++inspected > 64) break;
      if (!outsideLiteral(source, match.index)) continue;
      const owner = jsonOwner(bootstrapJson(source, match.index + match[0].length)); if (owner) return owner;
    }
    try { const owner = jsonOwner(JSON.parse(source)); if (owner) return owner; } catch {}
  }
  return null;
}
async function boundedText(response, signal, maxBytes) {
  if (Number(response.headers.get('content-length')) > maxBytes) { await response.body?.cancel().catch(() => {}); throw new Error('主页响应过大，请改用含 UID 的主页链接'); }
  const reader = response.body?.getReader(); if (!reader) return '';
  const chunks = []; let bytes = 0;
  try {
    while (true) {
      if (signal.aborted) throw new Error('主页解析超时');
      const { done, value } = await reader.read(); if (done) break;
      bytes += value.byteLength; if (bytes > maxBytes) throw new Error('主页响应过大，请改用含 UID 的主页链接');
      chunks.push(Buffer.from(value));
    }
    return Buffer.concat(chunks).toString('utf8');
  } finally { await reader.cancel().catch(() => {}); }
}
export async function resolveProfile(value, { fetchImpl = fetch, timeoutMs = 4000, maxBytes = 1_000_000 } = {}) {
  const input = String(value || '').trim(); let url = profileUrl(input);
  const direct = directProfileUid(url); if (direct) return { input, uid: direct, url: url.href };
  const controller = new AbortController(); const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    for (let redirects = 0; redirects <= 3; redirects++) {
      const response = await fetchImpl(url.href, { method: 'GET', redirect: 'manual', signal: controller.signal, headers: { 'Accept': 'text/html,application/json', 'User-Agent': 'Mozilla/5.0' } });
      if ([301,302,303,307,308].includes(response.status)) {
        const location = response.headers.get('location'); await response.body?.cancel();
        if (!location || redirects === 3) throw new Error(hint);
        url = profileUrl(new URL(location, url).href);
        const uid = directProfileUid(url); if (uid) return { input, uid, url: url.href };
        continue;
      }
      if (!response.ok || url.hostname === 't.cn') { await response.body?.cancel(); throw new Error(hint); }
      const html = await boundedText(response, controller.signal, maxBytes);
      const uid = profileOwnerUid(html); if (!uid) throw new Error(hint);
      return { input, uid, url: url.href };
    }
    throw new Error(hint);
  } catch (error) { throw new Error(controller.signal.aborted ? '主页解析超时，请使用含 UID 的完整主页链接' : error.message); }
  finally { clearTimeout(timer); }
}
export async function resolveBlacklist(input, options = {}) {
  const lines = Array.isArray(input) ? input : String(input || '').split(/\r?\n/);
  if (lines.length > 100) throw Object.assign(new Error('作者黑名单最多支持 100 行'), { statusCode: 400 });
  const results = new Array(lines.length); let next = 0;
  const until = Date.now() + (options.batchTimeoutMs || 12000);
  await Promise.all(Array.from({ length: Math.min(4, lines.length) }, async () => {
    while (next < lines.length) {
      const index = next++, raw = String(lines[index] || '').trim();
      if (!raw) { results[index] = { line: index + 1, input: raw, empty: true }; continue; }
      try {
        const remaining = until - Date.now(); if (remaining <= 0) throw new Error('批量解析超时，请改用含 UID 的主页链接');
        results[index] = { line: index + 1, ...await resolveProfile(raw, { ...options, timeoutMs: Math.min(options.timeoutMs || 4000, remaining) }) };
      }
      catch (error) { results[index] = { line: index + 1, input: raw, error: error.message }; }
    }
  }));
  return { results, valid: results.every(row => !row.error), uids: [...new Set(results.map(row => row.uid).filter(Boolean))] };
}
export async function resolveEngageSettings(input, options) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw Object.assign(new Error('配置必须是对象'), { statusCode: 400 });
  if (input.likeBlacklistProfiles != null && !Array.isArray(input.likeBlacklistProfiles)) throw Object.assign(new Error('作者主页黑名单必须是链接数组'), { statusCode: 400 });
  const profiles = Array.isArray(input.likeBlacklistProfiles) ? input.likeBlacklistProfiles : input.likeBlacklistUids || [];
  const result = await resolveBlacklist(profiles, options);
  if (!result.valid) throw Object.assign(new Error(result.results.filter(row => row.error).map(row => '黑名单第 ' + row.line + ' 行：' + row.error).join('；')), { statusCode: 400 });
  return { ...input, likeBlacklistProfiles: result.results.filter(row => row.uid).map(row => /^\d+$/.test(row.input) ? 'https://weibo.com/u/' + row.uid : row.input), likeBlacklistUids: result.uids };
}
