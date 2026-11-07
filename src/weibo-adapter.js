import { serializeError } from './util.js';
import { DailyStopError } from './daily-stop.js';
import { gotoChecked, isNavigationError, safeNavigationUrl, NavigationUnavailableError } from './navigation.js';
import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import { createPostReceiptCollector } from './post-receipts.js';
import { createPostSuccessNoticeObserver, createCommentSuccessNoticeObserver, createRepostSuccessNoticeObserver } from './post-success-notice.js';
import { markEngagePost, engageControl, visibleLikeState, markEngageComments, readStreamingComments, scrollStreamingComments, waitForStreamingCommentSettle } from './engage-dom.js';
const challengeMode = new AsyncLocalStorage();

async function submitBeforeDeadline(button, onSubmit, deadlineAt) {
  const deadline = Number(deadlineAt);
  if (!Number.isFinite(deadline)) { await onSubmit(); await button.click(); return; }
  // Playwright may wait for actionability after a click request. A capture-phase
  // fence also checks the clock at the actual browser event, not only in Node.
  await button.click({ trial: true });
  const handle = await button.elementHandle();
  if (!handle) throw new Error('提交按钮已不可用');
  await handle.evaluate((element, until) => {
    const guard = { blocked: false };
    guard.listener = event => {
      if ((event.target === element || element.contains(event.target)) && Date.now() >= until) {
        guard.blocked = true; event.preventDefault(); event.stopImmediatePropagation();
      }
    };
    element.__workbenchSubmitGuard = guard;
    for (const type of ['pointerdown', 'mousedown', 'mouseup', 'click']) document.addEventListener(type, guard.listener, true);
  }, deadline);
  try {
    await onSubmit();
    await button.click({ timeout: Math.max(1, Math.min(5000, deadline - Date.now())) });
    if (await handle.evaluate(element => element.__workbenchSubmitGuard?.blocked).catch(() => false)) {
      const error = new DailyStopError(); error.unsubmitted = true; throw error;
    }
  } finally {
    await handle.evaluate(element => {
      const guard = element.__workbenchSubmitGuard;
      if (guard) for (const type of ['pointerdown', 'mousedown', 'mouseup', 'click']) document.removeEventListener(type, guard.listener, true);
      delete element.__workbenchSubmitGuard;
    }).catch(() => {});
    if (!button.keepHandle) await handle.dispose().catch(() => {});
  }
}

export class AdapterError extends Error {
  constructor(message, code = 'adapter_error', options = {}) {
    super(message, options);
    this.code = code;
  }
}
export class AuthenticationError extends AdapterError {
  constructor(message = '微博登录已失效，请在 Mac 上重新登录') { super(message, 'authentication_required'); }
}
export class IdentityMismatchError extends AuthenticationError {
  constructor(message) { super(message); this.code = 'uid_mismatch'; }
}
export class VerificationError extends AdapterError {
  constructor(message) { super(message, 'verification_required'); }
}
export class RateLimitError extends AdapterError {
  constructor(message, kind, rejected = false) {
    super(message || '微博提示操作频繁', 'rate_limited');
    this.kind = kind;
    this.rejected = rejected;
  }
}
export class MutedError extends AdapterError {
  constructor(message, kind, rejected = false) {
    super(message || '微博提示账号已被禁言', 'muted');
    this.kind = kind;
    this.rejected = rejected;
  }
}
export class UnsupportedPageError extends AdapterError {
  constructor(message) { super(message, 'page_not_recognized'); }
}
export class EngagePageClosedError extends AdapterError {
  constructor(message = '内赞页面已关闭，正在重新打开当前微博') { super(message, 'engage_page_closed'); this.unsubmitted = true; }
}

function isDetachedDomError(error) {
  return /(?:element is not attached|not attached to the DOM|detached from the DOM|element is no longer attached)/i.test(String(error?.message || error || ''));
}

function isClosedPageError(error) {
  return /(?:target page, context or browser has been closed|page has been closed|browser has been closed|context has been closed)/i.test(String(error?.message || error || ''));
}

const visible = locator => locator.filter({ visible: true });

async function firstVisible(locators) {
  for (const locator of locators) {
    const count = await locator.count().catch(() => 0);
    for (let i = 0; i < count; i += 1) {
      const item = locator.nth(i);
      if (await item.isVisible().catch(() => false)) return item;
    }
  }
  return null;
}

async function setVisibleCheckboxState(checkbox, desired, page) {
  const target = Boolean(desired);
  if (await checkbox.isChecked().catch(() => false) === target) return;
  // Weibo renders the native input beneath a visible text/icon layer. Clicking
  // the input directly is blocked by that layer, so operate through its label.
  const label = checkbox.locator('xpath=ancestor::label[1]');
  if (await label.count().catch(() => 0) && await label.first().isVisible().catch(() => false)) {
    await label.first().click({ timeout: 1000 }).catch(() => {});
  }
  if (await checkbox.isChecked().catch(() => false) !== target) {
    await checkbox.evaluate(element => element.click()).catch(() => {});
  }
  await page.waitForTimeout(50).catch(() => {});
  if (await checkbox.isChecked().catch(() => false) !== target) {
    await checkbox.check({ force: true, timeout: 800 }).catch(() => {});
    if (await checkbox.isChecked().catch(() => false) !== target) {
      await checkbox.uncheck({ force: true }).catch(() => {});
    }
  }
}

// Response bodies need a separate CDP round-trip (Network.getResponseBody).
// Weibo occasionally leaves one pending for good - a request cancelled by a
// navigation, or a long-poll stream - and Playwright does not time that call
// out, so every body read carries its own ceiling.
export const BODY_READ_TIMEOUT_MS = 2000;
export async function readJsonBounded(response, milliseconds = BODY_READ_TIMEOUT_MS) {
  if (!response) return null;
  let timer;
  const limit = Math.max(1, Number(milliseconds) || BODY_READ_TIMEOUT_MS);
  const timeout = new Promise(resolve => { timer = setTimeout(() => resolve(null), limit); });
  try {
    const read = Promise.resolve().then(() => response.json()).catch(() => null);
    return await Promise.race([read, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

// Wait for a batch of background body reads, but never longer than the
// ceiling: one stuck response must not park the caller forever.
export async function settleBounded(pending, milliseconds = 3000) {
  if (!pending || !pending.size) return false;
  let timer;
  const limit = Math.max(1, Number(milliseconds) || 3000);
  const all = Promise.allSettled([...pending]);
  const timeout = new Promise(resolve => { timer = setTimeout(() => resolve('timeout'), limit); });
  try {
    return await Promise.race([all, timeout]) === 'timeout';
  } finally {
    clearTimeout(timer);
  }
}

async function hasVerificationChallenge(page) {
  const frames = page.frames?.() || [page];
  for (const frame of frames) {
    // A successful widget may leave its outer panel on screen. Only its
    // interactive challenge (or a prompt without a success result) blocks us.
    const success = await firstVisible([
      frame.locator('[class*="geetest_success"], [class*="geetest_result"]').filter({ hasText: /验证成功|验证通过/ }),
      frame.getByText(/^(验证成功|验证通过|安全验证已通过)$/)
    ]);
    const interactive = await firstVisible([
      frame.locator('[class*="geetest_slider_button"], [class*="geetest_item_img"], [class*="geetest_commit_tip"], .yidun_modal__wrap, .yidun_popup, .yidun_control')
    ]);
    if (interactive && !success) return true;
    if (!success && await firstVisible([
      frame.locator('[class*="geetest_panel"]'),
      frame.getByRole('dialog').filter({ hasText: /请完成安全验证|请完成验证|账号存在风险/ }),
      frame.getByText(/^(请完成安全验证|请完成验证|账号存在风险)$/)
    ])) return true;
    // Opaque challenge frames remain a challenge until their own visible
    // content reports success, disappears or navigates away.
    if (!success) {
      const iframe = await firstVisible([frame.locator('iframe[src*="captcha"]')]);
      if (iframe) {
        const child = await iframe.contentFrame?.();
        const passed = child && await firstVisible([child.getByText(/^(验证成功|验证通过|安全验证已通过)$/)]);
        if (!passed) return true;
      }
    }
  }
  return false;
}

async function detectChallenge(page, browserManager) {
  const pages = browserManager?.context?.pages?.() || [page];
  let challengePage = null;
  for (const candidate of new Set([page, ...pages])) {
    if (!candidate.isClosed?.() && await hasVerificationChallenge(candidate)) { challengePage = candidate; break; }
  }
  if (challengePage) {
    // Background work records the challenge and yields to the verification
    // queue.  It must never flash a native Chrome window in front of the user.
    if (challengeMode.getStore() === 'manual') await browserManager?.foreground?.(challengePage);
    const error = new VerificationError('微博要求进行安全验证，请在打开的 Chrome 窗口中完成验证');
    error.challengePage = challengePage;
    throw error;
  }
}

const UNLOADED_URL = /^(?:about:(?:blank|srcdoc)|chrome-error:|chrome:)/i;
const ERROR_PAGE_TEXT = /(?:ERR_(?:INTERNET_DISCONNECTED|NAME_NOT_RESOLVED|CONNECTION_[A-Z_]+|PROXY_[A-Z_]+|TUNNEL_[A-Z_]+|CERT_[A-Z_]+)|This site can.t be reached|网页无法打开|无法访问此网站|未连接到互联网|网络连接错误|页面不存在|出错了)/i;

function parsePageUrl(value) {
  try { return new URL(String(value || '')); } catch { return null; }
}

function isUnloadedPageUrl(value) {
  const raw = String(value || '').trim();
  if (!raw) return true;
  if (UNLOADED_URL.test(raw)) return true;
  return !parsePageUrl(raw);
}

async function pageHasVisibleChallenge(page) {
  // Test doubles and lightweight adapters may not expose locator APIs. Treat
  // that as "cannot confirm a challenge" rather than crashing the caller.
  if (typeof page?.frames !== 'function' || typeof page?.locator !== 'function') return false;
  return hasVerificationChallenge(page).catch(() => false);
}

// Read-only description of what the browser is currently showing.  A 200
// response alone is not proof that a usable Weibo page was painted: Chrome
// error documents, blank tabs and empty shells all need to be rejected.
async function inspectPageHealth(page) {
  const url = String(page?.url?.() || '');
  if (isUnloadedPageUrl(url)) return { ok: false, unloaded: true, url };
  let snapshot;
  try {
    snapshot = await page.evaluate(() => {
      const bodyText = String(document.body?.innerText || '').replace(/\s+/g, ' ').trim();
      return {
        readyState: document.readyState,
        title: String(document.title || ''),
        text: bodyText.slice(0, 400),
        textLength: bodyText.length,
        htmlLength: Number((document.documentElement?.innerHTML || '').length),
        body: Boolean(document.body),
        hasConfig: Boolean(window.$CONFIG),
        uid: String(window.$CONFIG?.uid || window.$CONFIG?.user?.idstr || window.$CONFIG?.user?.id || ''),
        loginForm: Boolean(document.querySelector('form[action*="login" i], input[name="username" i], [node-type="loginName"], [class*="loginForm" i], [class*="login-form" i]')),
        challengeHint: /安全验证|请完成验证|验证码|账号存在风险/.test(bodyText)
          || Boolean(document.querySelector('iframe[src*="captcha"], [class*="geetest_panel"], .yidun_modal__wrap'))
      };
    });
  } catch (error) {
    return { ok: false, unreadable: true, error, url };
  }
  if (!snapshot || !snapshot.body || snapshot.readyState === 'loading' || snapshot.htmlLength < 50 || snapshot.textLength < 2) {
    return { ok: false, empty: true, snapshot, url };
  }
  // Body text only counts for a short error document; a normal feed post may
  // legitimately contain words such as "页面不存在".
  if (ERROR_PAGE_TEXT.test(snapshot.title)
    || (snapshot.textLength < 200 && ERROR_PAGE_TEXT.test(snapshot.text))) {
    return { ok: false, errorPage: true, snapshot, url };
  }
  return { ok: true, snapshot, url };
}

function trustedWeiboNavigationUrl(value) {
  const url = parsePageUrl(value);
  if (!url || url.protocol !== 'https:') return null;
  if (url.username || url.password) return null;
  if (url.hostname !== 'weibo.com' && !url.hostname.endsWith('.weibo.com')) return null;
  if (url.port && url.port !== '443') return null;
  return url;
}

const BASE62 = '0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ';
export function weiboShortIdToNumeric(shortId) {
  const input = String(shortId || '');
  const firstSize = input.length % 4 || Math.min(4, input.length);
  const parts = input ? [input.slice(0, firstSize), ...(input.slice(firstSize).match(/.{4}/g) || [])] : [];
  return parts.map((part, index) => {
    let value = 0n;
    for (const char of part) {
      const digit = BASE62.indexOf(char);
      if (digit < 0) throw new Error('微博短编号包含无效字符');
      value = value * 62n + BigInt(digit);
    }
    return index === 0 ? value.toString() : value.toString().padStart(7, '0');
  }).join('');
}

export function weiboLinkStatusId(link) {
  try {
    const url = new URL(String(link || ''));
    let m = url.pathname.match(/^\/(\d+)\/([A-Za-z0-9]+)$/);
    if (m) return m[2];
    m = url.pathname.match(/^\/(?:detail|status)\/([A-Za-z0-9]+)$/);
    if (m) return m[1];
    return url.pathname.split('/').filter(Boolean).pop() || '';
  } catch { return ''; }
}

export function weiboLinkAuthorUid(link) {
  try {
    const url = new URL(String(link || ''));
    const m = url.pathname.match(/^\/(\d+)\/([A-Za-z0-9]+)$/);
    return m ? m[1] : '';
  } catch { return ''; }
}

function commentLikeState(rows, commentId) {
  const row = (rows || []).find(item => String(item.idstr || item.id) === String(commentId));
  if (!row) return null;
  if (row.like_status != null) return row.like_status === 1 || row.like_status === '1' || row.like_status === true;
  if (typeof row.liked === 'boolean') return row.liked;
  return null;
}

export function normalizeWeiboText(value) {
  return String(value || '')
    .replace(/<br\s*\/?\s*>/gi, '\n')
    .replace(/<img\b[^>]*\balt=(['"])(.*?)\1[^>]*>/gi, '$2')
    .replace(/<img\b[^>]*\btitle=(['"])(.*?)\1[^>]*>/gi, '$2')
    .replace(/<[^>]*>/g, '')
    .replace(/&nbsp;|&#160;/gi, ' ')
    .replace(/&amp;/gi, '&').replace(/&lt;/gi, '<').replace(/&gt;/gi, '>')
    .replace(/&#39;|&apos;/gi, "'").replace(/&quot;/gi, '"')
    .replace(/[\u200B-\u200D\uFEFF]/g, '')
    .replace(/\s+/g, '')
    .normalize('NFC');
}

export function normalizeWeiboNickname(value) {
  return String(value || '').normalize('NFC').replace(/[\s\u200B-\u200D\uFEFF]/g, '');
}

export function commentRowMatches(row, { nickname, content, commentId, uid }) {
  const expectedText = normalizeWeiboText(content);
  const rowText = normalizeWeiboText(row?.text_raw || row?.text || '');
  if (!expectedText || rowText !== expectedText) return false;
  const rowNickname = normalizeWeiboNickname(row?.user?.screen_name || row?.screen_name || '');
  const nicknameMatches = Boolean(rowNickname && rowNickname === normalizeWeiboNickname(nickname));
  const rowId = String(row?.idstr || row?.id || '');
  const rowUid = String(row?.user?.idstr || row?.user?.id || '');
  const receiptMatches = Boolean(commentId && uid && rowId === String(commentId) && rowUid === String(uid));
  return nicknameMatches || receiptMatches;
}

export function visibleCommentMatches(html, { nickname, content }) {
  const expectedNickname = normalizeWeiboNickname(nickname);
  const expectedContent = normalizeWeiboText(content);
  const source = String(html || '')
    .replace(/<img\b[^>]*\balt=(['"])(.*?)\1[^>]*>/gi, '$2')
    .replace(/<img\b[^>]*\btitle=(['"])(.*?)\1[^>]*>/gi, '$2')
    .replace(/<[^>]*>/g, '\n');
  const parts = source.split(/\n+/).map(normalizeWeiboText).filter(Boolean);
  const normalizedRow = normalizeWeiboNickname(source);
  return Boolean(expectedNickname && expectedContent && normalizedRow.includes(expectedNickname) && parts.includes(expectedContent));
}

// A status detail response is not guaranteed to echo its internal super-topic
// page id.  The publish receipt gives us the status to read back, so verify the
// returned status, author, and complete text instead of depending on that
// optional metadata field.
export function postReadbackMatches(post, { receiptId, uid, content, topicName }) {
  const receipt = String(receiptId || '');
  const postIds = [post?.idstr, post?.id].filter(value => value !== undefined && value !== null).map(String);
  if (!receipt || !postIds.includes(receipt)) return false;
  return postContentTopicMatches(post, { uid, content, topicName });
}

function postTextForComparison(post, content) {
  const clean = value => String(value || '').replace(/&amp;/gi, '&').replace(/[\u200B-\u200D\uFEFF]/g, '');
  const urls = /https?:\/\/[^\s<>"'，。！？、）】]+/g;
  const expected = new Set(clean(content).match(urls) || []);
  const mappings = new Map();
  for (const link of Array.isArray(post?.url_struct) ? post.url_struct : []) {
    const short = clean(link?.short_url), long = clean(link?.long_url);
    try { if (!/^https?:$/.test(new URL(short).protocol) || new URL(short).hostname !== 't.cn' || !long) continue; } catch { continue; }
    if (!mappings.has(short)) mappings.set(short, new Set());
    mappings.get(short).add(long);
  }
  const restore = url => {
    const values = mappings.get(url);
    if (values?.size !== 1) return url;
    const long = [...values][0];
    return expected.has(long) ? long : url;
  };
  let raw = clean(post?.text_raw || post?.text);
  // HTML detail fallbacks may show a title instead of the short URL itself.
  if (!post?.text_raw) raw = raw.replace(/<a\b[^>]*\bhref=(["'])(https?:\/\/[^"']+)\1[^>]*>[\s\S]*?<\/a>/gi,
    (tag, _quote, href) => restore(href) !== href ? restore(href) : tag);
  return normalizeWeiboText(raw.replace(urls, restore));
}

function postContentTopicMatches(post, { uid, content, topicName }) {
  if (String(post?.user?.idstr || post?.user?.id || '') !== String(uid || '')) return false;
  const raw = postTextForComparison(post, content);
  const expectedContent = normalizeWeiboText(content);
  const topicTitle = String(topicName || '').replace(/超话$/, '').trim();
  const marker = normalizeWeiboText(`${topicTitle}超话`);
  const bracketMarker = normalizeWeiboText(`${topicTitle}[超话]`);
  // Detail responses do not always put the super-topic marker in text_raw.
  // Keep the check strict, but accept the structured topic data returned by
  // Weibo as the same marker instead of falsely calling a published post
  // uncertain.
  const topicData = normalizeWeiboText(JSON.stringify({
    topic_struct: post?.topic_struct, page_info: post?.page_info,
    page_id: post?.page_id, page: post?.page, annotations: post?.annotations
  }));
  const hasTopic = Boolean(marker && (raw.includes(marker) || raw.includes(bracketMarker) || topicData.includes(marker) || topicData.includes(bracketMarker)));
  // The composer prepends exactly one topic marker. Keep user-authored
  // markers in the body, and never match a different post by a substring.
  const bodies = [raw];
  for (const prefix of [`#${bracketMarker}#`, bracketMarker, `#${marker}#`, marker]) {
    if (prefix && raw.startsWith(prefix)) bodies.push(raw.slice(prefix.length));
  }
  return Boolean(expectedContent && hasTopic && bodies.includes(expectedContent));
}

function superTopicTitle(topic) {
  return String(topic?.name || '').replace(/超话$/, '').trim();
}

function topicPageId(value) {
  return String(value ?? '').trim();
}

function matchingTopicItems(data, title, target) {
  const items = Array.isArray(data?.data) ? data.data : Array.isArray(data?.list) ? data.list : [];
  return items.filter(item => String(item?.title || '').trim() === title
    && topicPageId(item?.page_id) === target);
}

async function waitForTopicSearchResult(page, search, topic, target) {
  const title = superTopicTitle(topic);
  if (!title || !target) throw new UnsupportedPageError('超话名称或目标标识缺失，未发送');
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const pending = new Set(), responses = [];
    let lastResponseAt = 0;
    const listener = response => {
      try {
        const url = new URL(response.url());
        if (url.hostname !== 'weibo.com' || url.pathname !== '/ajax/stopic/list'
          || response.request().method() !== 'GET') return;
      } catch { return; }
      lastResponseAt = Date.now();
      const work = response.json().then(data => { responses.push(data); }, () => {});
      pending.add(work);
      void work.finally(() => pending.delete(work));
    };
    page.on('response', listener);
    try {
      // Clear first so a repeated value still triggers the platform search.
      await search.fill('');
      await search.fill(title);
      const deadline = Date.now() + 8000;
      while (Date.now() < deadline) {
        for (const data of responses) {
          if (matchingTopicItems(data, title, target).length === 1) return data;
        }
        if (responses.length && Date.now() - lastResponseAt >= 700) break;
        await page.waitForTimeout(100).catch(() => {});
      }
    } finally {
      page.off('response', listener);
      await Promise.allSettled([...pending]);
    }
  }
  throw new UnsupportedPageError('不能唯一核对所选超话的标识，未发送');
}

const receiptUrl = id => `https://weibo.com/detail/${id}`;

async function boundedRead(operation, signal, timeoutMs = 3000) {
  if (signal?.aborted) return null;
  let timer, abort;
  const cancelled = new Promise(resolve => {
    timer = setTimeout(() => resolve(null), timeoutMs);
    abort = () => resolve(null);
    signal?.addEventListener('abort', abort, { once: true });
  });
  try { return await Promise.race([Promise.resolve().then(operation).catch(() => null), cancelled]); }
  finally { clearTimeout(timer); signal?.removeEventListener('abort', abort); }
}

export function postTimeWindow({ submittedAt, startedAt, completedAt } = {}) {
  const submitted = Date.parse(submittedAt), started = Date.parse(startedAt), completed = Date.parse(completedAt);
  // A timestamp earlier than this attempt is never evidence of its success.
  // Server timestamps with insufficient precision remain uncertain instead of
  // expanding the window backwards and claiming a pre-existing identical post.
  return { from: Number.isFinite(submitted) ? submitted : started,
    to: Number.isFinite(submitted) ? submitted + 120000 : (Number.isFinite(completed) ? completed : started) + 30000 };
}
const withinPostWindow = (post, window) => {
  const created = Date.parse(post?.created_at);
  return Number.isFinite(created) && Number.isFinite(window.from) && Number.isFinite(window.to) && created >= window.from && created <= window.to;
};

async function readPost(page, id, { signal } = {}) {
  const payload = await boundedRead(() => page.evaluate(async receiptId => {
    const controller = new AbortController(), timer = setTimeout(() => controller.abort(), 2500);
    try {
      const response = await fetch(`/ajax/statuses/show?id=${encodeURIComponent(receiptId)}`, { credentials: 'include', signal: controller.signal });
      return response.ok ? await response.json() : null;
    } finally { clearTimeout(timer); }
  }, String(id)), signal);
  return payload?.data || payload || null;
}

export async function verifyPublishedPost(page, browserManager, values, { attempts = 1, intervalMs = 0, background = false } = {}) {
  let found = false;
  const context = page.context?.();
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (background && (page.isClosed?.() || browserManager.context !== context)) break;
    if (!background) await detectChallenge(page, browserManager);
    const post = background ? await context.request.get(`https://weibo.com/ajax/statuses/show?id=${encodeURIComponent(values.receiptId)}`, { timeout: 2000 }).then(async response => {
      const payload = response.ok() ? await readJsonBounded(response) : null;
      return payload?.data || payload;
    }).catch(() => null) : await readPost(page, values.receiptId);
    if (post) {
      found = true;
      if (postReadbackMatches(post, values)) return { state: 'succeeded', post };
    }
    if (attempt + 1 < attempts) await page.waitForTimeout(intervalMs);
  }
  return { state: 'uncertain', reason: found ? '回执详情内容与作者、正文或超话标识不匹配' : '回执详情同步超时' };
}

async function selectDescendingComments(page) {
  const tabLocator = page.locator('div.item').filter({ hasText: /^按倒序$/ });
  await tabLocator.first().waitFor({ state: 'visible', timeout: 10000 }).catch(() => {});
  if (!await tabLocator.count().catch(() => 0)) return false;
  const sortChoice = tabLocator.first();
  const isSelected = () => sortChoice.evaluate(el => el.classList.contains('curr')).catch(() => false);
  if (!await isSelected()) await sortChoice.click();
  for (let attempt = 0; attempt < 20; attempt += 1) {
    if (await isSelected()) return true;
    await page.waitForTimeout(100);
  }
  return false;
}

async function visibleDescendingCommentMatches(page, { nickname, content }) {
  const cards = await page.evaluate(({ expectedNickname, expectedContent }) => {
    const normalize = value => String(value || '').replace(/[\u200B-\u200D\uFEFF]/g, '').replace(/\s+/g, '').normalize('NFC');
    const visible = element => {
      const rect = element.getBoundingClientRect();
      const style = getComputedStyle(element);
      return rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden';
    };
    const expected = normalize(expectedContent);
    const maxRowLength = Math.max(300, normalize(expectedNickname).length + expected.length + 250);
    const candidates = [...document.querySelectorAll('li, article, [class*="comment"], [node-type*="comment"], div')].filter(visible);
    return candidates.some(card => {
      const cardText = normalize(card.innerText || '');
      if (!cardText.includes(normalize(expectedNickname)) || cardText.length > maxRowLength) return false;
      return [...card.querySelectorAll('*')].some(node => {
        const text = normalize(node.innerText || node.textContent || '');
        if (text === expected) return true;
        const imageText = [...node.querySelectorAll('img')].map(image => image.getAttribute('alt') || image.getAttribute('title') || '').join('');
        return normalize((node.textContent || '') + imageText) === expected;
      });
    });
  }, { expectedNickname: nickname, expectedContent: content }).catch(() => false);
  return cards;
}

export function isRateLimitMessage(value) {
  return /操作(?:过于)?频繁|发(?:送|布)?过于频繁|评论(?:过于)?频繁|发得太频繁|评论太频繁|发布频繁|发(?:的|得|送|布)?太多|休息一下再来|请稍后再试.{0,8}(?:频繁|操作)/i.test(String(value || ''));
}
export function isMutedMessage(value) {
  return /(?:被)?禁言|禁(?:止|言).*(?:发言|评论|发布)|发言(?:已)?受限|限制(?:发布|评论|发言)/i.test(String(value || ''));
}

function receiptMessage(payload, predicate) {
  const values = [];
  const visit = (value, key = '', depth = 0) => {
    if (depth > 3 || value == null) return;
    if (typeof value === 'string' && /^(msg|message|error|errmsg|tip|提示|reason)$/i.test(key)) values.push(value);
    else if (Array.isArray(value)) value.forEach(item => visit(item, key, depth + 1));
    else if (typeof value === 'object') for (const [childKey, child] of Object.entries(value)) visit(child, childKey, depth + 1);
  };
  visit(payload);
  return values.find(predicate) || '';
}

function rateMessageFromReceipt(payload) { return receiptMessage(payload, isRateLimitMessage); }
function mutedMessageFromReceipt(payload) { return receiptMessage(payload, isMutedMessage); }

export function verificationMessageFromReceipt(payload) {
  // Observed on /ajax/statuses/update: HTTP 400, error_code 20067,
  // English message and validate.{exception_key,challenge,alitest}.
  // Only inspect structural evidence; never persist the challenge values.
  const code = String(payload?.error_code ?? payload?.data?.error_code ?? '');
  const validation = payload?.validate || payload?.data?.validate;
  const message = receiptMessage(payload, value => /安全验证|验证码|完成验证|验证后|身份验证|captcha|verify (?:your )?account|security verification|security check/i.test(value));
  return message || (code === '20067' || (validation && typeof validation === 'object' && ['exception_key','challenge','alitest'].some(key => key in validation)) ? '微博要求安全验证（回执验证字段）' : '');
}

function classifyReceiptWithId(payload, httpOk = true) {
  const item = payload?.data || payload;
  const id = String(item?.idstr || item?.mid || item?.id || '');
  const denied = payload?.success === false || payload?.ok === false || payload?.ok === 0 || payload?.data?.ok === 0;
  if (httpOk && !denied && /^\d{10,}$/.test(id)) return { kind: 'succeeded', id };
  const verification = verificationMessageFromReceipt(payload);
  if (verification) return { kind: 'verification', reason: verification, explicitlyUnpublished: denied };
  const muted = mutedMessageFromReceipt(payload);
  if (muted) return { kind: 'muted', reason: muted };
  const frequent = rateMessageFromReceipt(payload);
  if (frequent) return { kind: 'frequent', reason: frequent };
  const message = receiptMessage(payload, value => Boolean(value.trim()));
  if (denied && message) return { kind: 'failed', reason: message };
  return { kind: 'unknown' };
}

export function classifyPostReceipt(payload, httpOk = true) {
  // A contradictory envelope (e.g. success=true plus captcha/ok=0) cannot
  // acknowledge this post. Keep comment's existing classifier independent.
  const verification = verificationMessageFromReceipt(payload);
  if (verification) return { kind: 'verification', reason: verification,
    explicitlyUnpublished: payload?.success === false || payload?.ok === false || payload?.ok === 0 || payload?.data?.ok === 0 };
  const muted = mutedMessageFromReceipt(payload);
  if (muted) return { kind: 'muted', reason: muted };
  const frequent = rateMessageFromReceipt(payload);
  if (frequent) return { kind: 'frequent', reason: frequent };
  const denied = [payload, payload?.data].some(item => item?.success === false || item?.ok === false || item?.ok === 0 || item?.ok === '0');
  if (denied) {
    const reason = receiptMessage(payload, value => Boolean(value.trim()));
    return reason ? { kind: 'failed', reason } : { kind: 'unknown' };
  }
  const result = classifyReceiptWithId(payload, httpOk);
  if (result.kind !== 'unknown') return result;
  const explicitSuccess = [payload, payload?.data].some(item => item?.ok === 1 || item?.ok === '1' || item?.success === true)
    || String(payload?.code || '') === '100000';
  return httpOk && !denied && explicitSuccess ? { kind: 'succeeded', id: null, explicitSuccess: true } : result;
}

// A matched business rejection is safe to replay only from the background
// workbench. In a manual composer Weibo may still auto-submit after solving.
function workbenchRejectedByVerification(observation) {
  if (observation?.result?.kind !== 'verification') return false;
  const { payload, response, result } = observation;
  if (result.explicitlyUnpublished) return true;
  const code = String(payload?.error_code ?? payload?.code ?? payload?.data?.error_code ?? '');
  return response?.status() === 400 && code === '20067';
}

export function classifyCommentReceipt(payload, httpOk = true) {
  // Comment and post endpoints use the same security envelope. In particular,
  // ok=0 / HTTP 400 can mean captcha or an account-wide restriction, not that
  // this post's author must be avoided by every account in the round.
  return classifyReceiptWithId(payload, httpOk);
}

async function visibleRestrictionMessage(page, predicate) {
  const el = await firstVisible([
    page.getByRole('alert'),
    page.locator('[class*="toast" i], [class*="notice" i], [class*="tip" i], [class*="error" i]')
  ]);
  const message = el ? (await el.innerText().catch(() => '')).trim() : '';
  return predicate(message) ? message : '';
}
async function visibleRateMessage(page) { return visibleRestrictionMessage(page, isRateLimitMessage); }
async function visibleMutedMessage(page) { return visibleRestrictionMessage(page, isMutedMessage); }

async function waitForReceiptOrRateLimit(page, receipt) {
  let done = false;
  const monitor = (async () => {
    const until = Date.now() + 15000;
    while (!done && Date.now() < until) {
      const message = await visibleRestrictionMessage(page, value => isRateLimitMessage(value) || isMutedMessage(value));
      if (message) return { restrictionMessage: message };
      await page.waitForTimeout(200);
    }
    return { response: null };
  })();
  const response = receipt.then(value => { done = true; return { response: value }; });
  const result = await Promise.race([monitor, response]);
  done = true;
  return result;
}

export class WeiboAdapter {
  constructor(browserManager) {
    this.browserManager = browserManager;
    this.log = () => {};
    this.engageCatalogs = new Map();
  }

  async cancelTask() { await this.browserManager.closeRunner?.(); }
  async probeConnectivity(account, { force = false, url = 'https://weibo.com/robots.txt', signal } = {}) {
    const started = Date.now(), manager = this.browserManager, sessions = new Set();
    const controller = new AbortController();
    const abort = () => controller.abort();
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
    const timer = setTimeout(abort, 2850);
    const result = (state, code = null, httpStatus = null) => ({ state, code, httpStatus, latencyMs: Date.now() - started, checkedAt: new Date().toISOString(), contextGeneration: manager.generation || 0 });
    const errorCode = error => String(error?.message || error || '').match(/(?:net::)?(ERR_[A-Z_]+)/)?.[1] || 'PROBE_CONTEXT_UNAVAILABLE';
    const networkError = code => /^ERR_(INTERNET_DISCONNECTED|NETWORK_CHANGED|CONNECTION_(RESET|CLOSED|REFUSED|ABORTED|TIMED_OUT)|NAME_NOT_RESOLVED|PROXY_CONNECTION_FAILED|TUNNEL_CONNECTION_FAILED|TIMED_OUT)$/.test(code);
    const aborted = new Promise(resolve => controller.signal.addEventListener('abort', () => {
      for (const session of sessions) void session.detach().catch(() => {});
      resolve(result('unknown', signal?.aborted ? 'PROBE_CANCELLED' : 'PROBE_TIMEOUT'));
    }, { once: true }));
    const work = async () => {
      let context = manager.context;
      if (!context && force && account && !controller.signal.aborted) context = await manager.open(account, 'runner');
      if (!context || controller.signal.aborted) return result('unknown', 'PROBE_CONTEXT_UNAVAILABLE');
      const generation = manager.generation || 0;
      const valid = () => !controller.signal.aborted && manager.context === context && (manager.generation || 0) === generation;
      const page = context.pages().find(item => !item.isClosed());
      if (!page) return result('unknown', 'PROBE_PAGE_UNAVAILABLE');
      const online = await page.evaluate(() => navigator.onLine).catch(() => null);
      if (!valid()) return result('unknown', 'PROBE_CONTEXT_CHANGED');
      if (online === false) return result('offline', 'ERR_INTERNET_DISCONNECTED');
      // Prefer a normal Chrome request. Creating/detaching a CDP network
      // session can itself reset target-level offline emulation in Chrome.
      // no-cors permits a read-only reachability probe even on about:blank or
      // a login redirect; no credentials or account data are sent.
      const fetchProbe = await page.evaluate(async target => {
        const aborter = new AbortController(), timer = setTimeout(() => aborter.abort(), 1000);
        try {
          const response = await fetch(target, { mode: 'no-cors', credentials: 'omit', cache: 'no-store', signal: aborter.signal });
          return { state: navigator.onLine === false ? 'offline' : 'online', httpStatus: response.status || null };
        } catch { return { state: navigator.onLine === false ? 'offline' : 'unknown' }; }
        finally { clearTimeout(timer); }
      }, url).catch(() => null);
      if (!valid()) return result('unknown', 'PROBE_CONTEXT_CHANGED');
      if (fetchProbe?.state === 'online') return result('online', null, fetchProbe.httpStatus);
      if (fetchProbe?.state === 'offline') return result('offline', 'ERR_INTERNET_DISCONNECTED');
      // Both addresses use Chrome's network stack and system proxy. A status
      // such as 401/403/429 still proves reachability; it is not a disconnection.
      const fallback = new URL('/favicon.ico', url).href;
      const outcomes = [];
      for (const target of new Set([url, fallback])) {
        if (!valid()) return result('unknown', 'PROBE_CONTEXT_CHANGED');
        let session, timeout;
        try {
          session = await context.newCDPSession(page); sessions.add(session);
          if (!valid()) return result('unknown', 'PROBE_CONTEXT_CHANGED');
          const attempt = (async () => {
            const { frameTree } = await session.send('Page.getFrameTree');
            const { resource } = await session.send('Network.loadNetworkResource', { frameId: frameTree.frame.id, url: target, options: { disableCache: true, includeCredentials: false } });
            if (resource.stream) void session.send('IO.close', { handle: resource.stream }).catch(() => {});
            return resource;
          })();
          const resource = await Promise.race([attempt, new Promise(resolve => { timeout = setTimeout(() => resolve(null), 1250); })]);
          if (!valid()) return result('unknown', 'PROBE_CONTEXT_CHANGED');
          if (Number(resource?.httpStatusCode) > 0) {
            // Chrome's online/offline event may settle after setOffline or a
            // network switch. CDP resource reads can still return a response
            // while the target page has already become explicitly offline.
            const stillOnline = await page.evaluate(() => navigator.onLine).catch(() => null);
            if (!valid()) return result('unknown', 'PROBE_CONTEXT_CHANGED');
            return stillOnline === false ? result('offline', 'ERR_INTERNET_DISCONNECTED') : result('online', null, Number(resource.httpStatusCode));
          }
          const code = resource ? errorCode(resource.netErrorName) : 'PROBE_TIMEOUT';
          outcomes.push(result(networkError(code) ? 'offline' : 'unknown', code));
        } catch (error) {
          const code = errorCode(error);
          outcomes.push(result(networkError(code) ? 'offline' : 'unknown', code));
        } finally {
          clearTimeout(timeout);
          if (session) { sessions.delete(session); void session.detach().catch(() => {}); }
        }
      }
      if (!valid()) return result('unknown', 'PROBE_CONTEXT_CHANGED');
      return outcomes.length && outcomes.every(item => item.state === 'offline') ? result('offline', outcomes.at(-1).code) : result('unknown', outcomes.find(item => item.state === 'unknown')?.code || 'PROBE_UNAVAILABLE');
    };
    try { return await Promise.race([work().catch(error => result('unknown', errorCode(error))), aborted]); }
    finally {
      clearTimeout(timer); signal?.removeEventListener('abort', abort);
      for (const session of sessions) void session.detach().catch(() => {});
    }
  }
  // Read-only navigation probe used by recovery.  It never clicks, submits or
  // creates a manual page, and it never closes a manual/login page or context.
  // A manual owner may already show a repaired page: inspect that page in place
  // so a human fix can turn into `ready` without a busy deadlock.
  async probeNavigation(account, { url = 'https://weibo.com/', signal } = {}) {
    const started = Date.now(), manager = this.browserManager;
    const target = trustedWeiboNavigationUrl(url);
    const targetKey = safeNavigationUrl(target?.href || url);
    const result = (state, extra = {}) => {
      const status = Number(extra.httpStatus);
      return {
        state,
        netCode: extra.netCode || null,
        httpStatus: Number.isFinite(status) && status > 0 ? status : null,
        url: targetKey,
        checkedAt: new Date().toISOString(),
        latencyMs: Date.now() - started
      };
    };
    if (!target) return result('unavailable', { netCode: 'PROBE_URL_REJECTED' });
    if (signal?.aborted) return result('unavailable', { netCode: 'PROBE_CANCELLED' });
    if (manager.owner === 'login') return result('busy');

    const classify = async page => {
      const health = await inspectPageHealth(page);
      if (!health.ok) {
        if (health.snapshot?.challengeHint && await pageHasVisibleChallenge(page)) return result('verification');
        return result('unavailable', {
          netCode: health.errorPage ? 'PROBE_ERROR_PAGE' : health.unloaded ? 'PROBE_PAGE_UNLOADED' : 'PROBE_PAGE_EMPTY'
        });
      }
      const current = parsePageUrl(page.url?.());
      const host = current?.hostname || '';
      if (health.snapshot.challengeHint && await pageHasVisibleChallenge(page)) return result('verification');
      if (host !== 'weibo.com') {
        if (host === 'passport.weibo.com' || /signin|login|sso/i.test(current?.pathname || '')) return result('authentication');
        return result('unavailable', { netCode: 'PROBE_UNEXPECTED_HOST' });
      }
      if (health.snapshot.loginForm) return result('authentication');
      if (safeNavigationUrl(current?.href) !== targetKey) return result('unavailable', { netCode: 'PROBE_UNEXPECTED_REDIRECT' });
      if (!health.snapshot.hasConfig) return result('unavailable', { netCode: 'PROBE_PAGE_NOT_RECOGNIZED' });
      const uid = String(health.snapshot.uid || '');
      if (!/^\d+$/.test(uid) || uid === '0') return result('authentication');
      if (account?.uid && String(account.uid) !== uid) return result('authentication');
      return result('ready');
    };

    if (manager.owner === 'manual') {
      const context = manager.context, generation = manager.generation || 0;
      if (!context || String(manager.accountId) !== String(account?.id)) return result('busy');
      const pages = context.pages?.() || [];
      const page = pages.find(item => !item.isClosed?.() && safeNavigationUrl(item.url?.()) === targetKey);
      if (!page) return result('busy');
      let manualTimer;
      let state;
      try {
        state = await Promise.race([
          classify(page).catch(() => result('busy')),
          new Promise(resolve => { manualTimer = setTimeout(() => resolve(result('busy')), 10000); })
        ]);
      } finally { clearTimeout(manualTimer); }
      if (manager.context !== context || manager.owner !== 'manual' || (manager.generation || 0) !== generation) return result('busy');
      // A manual page that is merely still loading stays busy; only terminal
      // classifications (or a healthy ready page) are meaningful to recovery.
      return ['ready', 'verification', 'authentication'].includes(state.state) ? state : result('busy');
    }
    if (manager.owner && manager.owner !== 'runner') return result('busy');
    if (manager.context && manager.owner !== 'runner') return result('busy');
    if (manager.context && manager.accountId && account?.id && String(manager.accountId) !== String(account.id)) return result('busy');

    const controller = new AbortController();
    const abort = () => controller.abort();
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
    let timer, tempPage = null;
    const aborted = () => result('unavailable', { netCode: signal?.aborted ? 'PROBE_CANCELLED' : 'PROBE_TIMEOUT' });
    const abortPromise = new Promise(resolve => {
      const onAbort = () => { void tempPage?.close?.().catch(() => {}); resolve(aborted()); };
      if (controller.signal.aborted) onAbort();
      else controller.signal.addEventListener('abort', onAbort, { once: true });
    });
    timer = setTimeout(() => controller.abort(), 10000);
    try {
      let context = manager.context;
      if (!context) {
        if (!account?.id) return result('unavailable', { netCode: 'PROBE_ACCOUNT_UNAVAILABLE' });
        const picked = await Promise.race([
          manager.open(account, 'runner').then(opened => ({ opened }), error => ({ error })),
          abortPromise
        ]);
        if (picked.state) return picked;
        if (picked.error) {
          return /busy|正在被.*使用/i.test(String(picked.error?.message || ''))
            ? result('busy') : result('unavailable', { netCode: 'PROBE_CONTEXT_UNAVAILABLE' });
        }
        context = picked.opened;
        if (!context) return result('unavailable', { netCode: 'PROBE_CONTEXT_UNAVAILABLE' });
      }
      const generation = manager.generation || 0, contextRef = context;
      const contextValid = () => manager.context === contextRef
        && (manager.generation || 0) === generation
        && manager.owner === 'runner'
        && (!account?.id || String(manager.accountId) === String(account.id));
      const work = async () => {
        if (controller.signal.aborted) return aborted();
        if (!contextValid()) return result('busy');
        try { tempPage = await contextRef.newPage(); }
        catch { return result('unavailable', { netCode: 'PROBE_PAGE_UNAVAILABLE' }); }
        if (controller.signal.aborted || !contextValid()) {
          await tempPage.close?.().catch(() => {});
          return controller.signal.aborted ? aborted() : result('busy');
        }
        try {
          // Never just hit robots.txt: this must load the real document so the
          // page classification below can reject blank/error/non-business pages.
          await gotoChecked(tempPage, target.href, { stage: 'probe', timeout: 9000 });
        } catch (error) {
          if (!contextValid()) return result('busy');
          if (isNavigationError(error)) return result('unavailable', { netCode: error.netCode, httpStatus: error.httpStatus });
          const netCode = String(error?.message || '').match(/\b(?:net::)?(ERR_[A-Z0-9_]+)\b/)?.[1] || 'PROBE_NAVIGATION_FAILED';
          return result('unavailable', { netCode });
        }
        if (controller.signal.aborted) return aborted();
        if (!contextValid()) return result('busy');
        try {
          const classified = await classify(tempPage);
          return contextValid() ? classified : result('busy');
        }
        catch { return result('unavailable', { netCode: 'PROBE_PAGE_UNREADABLE' }); }
      };
      return await Promise.race([
        work().catch(() => result('unavailable', { netCode: 'PROBE_EXCEPTION' })),
        abortPromise
      ]);
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      if (tempPage && !tempPage.isClosed?.()) await tempPage.close?.().catch(() => {});
    }
  }
  withChallengeMode(mode, callback) { return challengeMode.run(mode, callback); }
  taskOwner() { return challengeMode.getStore() === 'manual' ? 'manual' : 'runner'; }
  async dismissBackgroundChallenge(challengePage) {
    if (challengeMode.getStore() === 'manual' || !challengePage || challengePage.isClosed?.()) return false;
    const context = this.browserManager?.context;
    if (!context) return false;
    const pages = context.pages().filter(page => page && !page.isClosed?.());
    // A challenge that opened its own tab can be closed without touching the
    // account's task page or its persistent browser context.
    if (pages.length > 1 && pages.includes(challengePage)) {
      await challengePage.close().catch(() => {});
      return true;
    }
    for (const frame of challengePage.frames?.() || [challengePage]) {
      const close = await firstVisible([
        frame.getByRole('button', { name: /^(关闭|关闭验证|close)$/i }),
        frame.locator('[aria-label*="关闭"], [title*="关闭"], [class*="geetest_close"], .yidun_popup__close').first()
      ]);
      if (close) { await close.click().catch(() => {}); break; }
    }
    await challengePage.keyboard?.press?.('Escape').catch(() => {});
    if (!await hasVerificationChallenge(challengePage).catch(() => false)) return true;
    // Some layouts have no explicit close control. Keep the same tab and
    // context; the next engage operation will deliberately reload its target.
    this.forceNextEngageNavigation = true;
    return false;
  }
  async minimizeTask() {
    const manager = this.browserManager;
    if (manager.owner === 'runner') for (const page of manager.context?.pages() || []) await manager.minimize?.(page);
  }

  async openVerification(account, topic, action) {
    // The workflow has already finished the background step before calling
    // this.  Opening a manual context is the only path that may be visible.
    const pending = this.currentSubmission(action);
    const page = await this.browserManager.page(account, 'manual');
    if (pending?.page === page && !page.isClosed?.()) {
      await this.browserManager.foreground?.(page);
      return page;
    }
    const url = action?.url && /^https:\/\/weibo\.com\//.test(action.url) ? action.url : topic.url;
    await gotoChecked(page, url, { stage: 'verification-open' });
    await this.browserManager.foreground?.(page);
    return page;
  }

  async hasTaskChallenge(account) {
    const page = await this.browserManager.page(account, this.browserManager.owner === 'manual' ? 'manual' : 'runner');
    for (const candidate of this.browserManager.context?.pages?.() || [page]) {
      if (!candidate.isClosed?.() && await hasVerificationChallenge(candidate)) return true;
    }
    return false;
  }

  async verifyPost(account, action, { topicName } = {}) {
    const path = action.receipt_url ? new URL(action.receipt_url).pathname : (action.url ? new URL(action.url).pathname : '');
    const match = path.match(/^\/detail\/(\d+)$/) || path.match(/^\/\d+\/([A-Za-z0-9]+)$/);
    const storedId = String(action.receipt_id || '');
    if (!storedId && !match) return { state: 'uncertain', reason: '未取得微博回执编号，请人工核对后确认是否需要补发' };
    const receiptId = storedId || (/^\d+$/.test(match[1]) ? match[1] : weiboShortIdToNumeric(match[1]));
    const page = await this.browserManager.page(account, this.browserManager.owner === 'manual' ? 'manual' : 'runner');
    const result = await verifyPublishedPost(page, this.browserManager, { receiptId, uid: account.uid, content: action.content, topicName });
    return result.state === 'succeeded' ? { state: 'succeeded', url: action.receipt_url || receiptUrl(receiptId) } : { state: 'uncertain', reason: result.reason };
  }

  async findUniqueRecentPost(account, { content, topicName, pages = 3, startedAt, submittedAt, completedAt, signal, assertRunning = () => {} } = {}) {
    assertRunning();
    await this.ensureIdentity(account);
    const page = await this.browserManager.page(account, this.taskOwner());
    const matches = new Map();
    const window = postTimeWindow({ startedAt, submittedAt, completedAt });
    for (let index = 1; index <= pages; index += 1) {
      assertRunning(); if (signal?.aborted) break;
      const payload = await boundedRead(() => page.evaluate(async ({ uid, page: pageNo }) => {
        const controller = new AbortController(), timer = setTimeout(() => controller.abort(), 2500);
        try {
          const response = await fetch(`/ajax/statuses/mymblog?uid=${encodeURIComponent(uid)}&page=${pageNo}&feature=0`, { credentials: 'include', signal: controller.signal });
          return response.ok ? await response.json() : null;
        } finally { clearTimeout(timer); }
      }, { uid: account.uid, page: index }), signal);
      const data = payload?.data || payload || {};
      const posts = data.list || data.statuses || data.data || [];
      for (const post of posts) {
        if (!withinPostWindow(post, window) || !postContentTopicMatches(post, { uid: account.uid, content, topicName })) continue;
        const id = String(post.idstr || post.id || '');
        if (id) matches.set(id, post);
      }
    }
    if (matches.size !== 1) return { state: 'uncertain', reason: matches.size ? '近期微博存在多个相同正文候选，保留待核对' : '近期微博未找到唯一匹配候选，保留待核对' };
    const [receiptId, post] = matches.entries().next().value;
    assertRunning();
    return { state: 'succeeded', receiptId, receiptUrl: receiptUrl(receiptId), createdAt: post.created_at, url: post.mblogid ? `https://weibo.com/${account.uid}/${post.mblogid}` : receiptUrl(receiptId) };
  }

  async findPublishedPost(account, { content, topic, startedAt, submittedAt, completedAt, syncToHome = false, signal,
    assertRunning = () => {}, maxBatches = 3 } = {}) {
    assertRunning();
    await this.ensureIdentity(account);
    assertRunning();
    const page = await this.browserManager.page(account, this.taskOwner());
    const window = postTimeWindow({ startedAt, submittedAt, completedAt });
    const candidates = new Map(), matches = new Map();
    const collect = value => {
      if (!value || typeof value !== 'object') return;
      if (String(value.user?.idstr || value.user?.id || '') === String(account.uid) && (value.text_raw || value.text)) {
        const id = String(value.idstr || value.id || '');
        if (/^\d{10,}$/.test(id) && withinPostWindow(value, window)) candidates.set(id, value);
        return;
      }
      if (Array.isArray(value)) value.forEach(collect);
      else for (const [key, child] of Object.entries(value)) if (key !== 'retweeted_status') collect(child);
    };
    const pending = new Set();
    const listener = response => {
      if (signal?.aborted) return;
      try {
        const url = new URL(response.url());
        if (url.origin !== 'https://weibo.com' || !/^(?:\/ajax\/|\/ajax_proxy\/chaohua\/|\/p\/aj\/)/.test(url.pathname)) return;
      } catch { return; }
      const read = readJsonBounded(response).then(collect).catch(() => {});
      pending.add(read); read.finally(() => pending.delete(read));
    };
    page.on('response', listener);
    try {
      await gotoChecked(page, topic.url, { stage: 'topic-page', timeout: 10000 });
      assertRunning();
      await detectChallenge(page, this.browserManager);
      const latestLocator = page.getByText('最新', { exact: true });
      // The /p/ document loads its tabs asynchronously after domcontentloaded.
      // Starting the scan before that leaves the page on the popular feed.
      if (latestLocator.first) await latestLocator.first().waitFor({ state: 'visible', timeout: 5000 }).catch(() => {});
      assertRunning();
      const latest = await firstVisible([latestLocator]);
      if (latest) await latest.click();
      if (page.mouse.move) {
        const size = page.viewportSize?.() || await page.evaluate(() => ({ width: innerWidth, height: innerHeight }));
        if (size) await page.mouse.move(Math.round(size.width * 0.55), Math.round(size.height * 0.65));
      }
      for (let batch = 0; batch < maxBatches; batch++) {
        assertRunning(); if (signal?.aborted) break;
        await page.waitForTimeout(700);
        await settleBounded(pending, 3000);
        const links = await page.evaluate(uid => [...document.querySelectorAll('a[href]')].map(a => {
          try { const match = new URL(a.href).pathname.match(/^\/(\d+)\/([A-Za-z0-9]+)$/); return match?.[1] === uid ? match[2] : null; } catch { return null; }
        }).filter(Boolean), String(account.uid));
        for (const id of links || []) { const numeric = weiboShortIdToNumeric(id); if (!candidates.has(numeric)) candidates.set(numeric, null); }
        if (batch < maxBatches - 1) await page.mouse.wheel(0, 1400);
      }
    } finally { page.off('response', listener); }
    for (const [id, cached] of [...candidates].slice(0, 150)) {
      assertRunning(); if (signal?.aborted) break;
      const post = cached && !cached.isLongText ? cached : await readPost(page, id, { signal });
      if (!withinPostWindow(post, window)) continue;
      if (postReadbackMatches(post, { receiptId: id, uid: account.uid, content, topicName: topic.name })) matches.set(id, post);
    }
    assertRunning();
    this.log('info', `发帖只读核对：候选 ${candidates.size}，唯一匹配 ${matches.size}`, { accountId: account.id, topicId: topic.id });
    if (signal?.aborted) return { state: 'uncertain', reason: '只读核对超时或已取消' };
    if (!matches.size && syncToHome) return this.findUniqueRecentPost(account, { content, topicName: topic.name,
      startedAt, submittedAt, completedAt, signal, assertRunning, pages: Math.min(20, maxBatches) });
    if (matches.size !== 1) return { state: 'uncertain', reason: matches.size ? '超话内有多个相同文案候选，保留待核对' : '超话内未找到唯一匹配，不能据此确认未发布' };
    const [id] = matches.keys();
    return { state: 'succeeded', url: receiptUrl(id), receiptUrl: receiptUrl(id), receiptId: id, matchedPostId: id,
      createdAt: matches.get(id).created_at, source: 'topic_unique_match' };
  }

  async verifyCheckin(account, topic) {
    const page = this.taskOwner() === 'manual'
      ? await this.browserManager.page(account, 'manual') : await this.pageFor(account, topic);
    await detectChallenge(page, this.browserManager);
    const button = await firstVisible([page.locator('[class*="signBtn"]').filter({ hasText: /^(签到|已签到|今日已签到)$/ })]);
    return button && /已签到/.test(await button.innerText()) ? { state: 'succeeded', url: page.url() } : { state: 'uncertain', reason: '未能只读确认已签到状态' };
  }

  async openLogin(account, { onPage = () => {}, onStage = () => {} } = {}) {
    const page = await this.browserManager.page(account, 'login');
    onPage(page);
    onStage('navigate-home');
    // Reuse an existing login before asking the user to scan again.
    await gotoChecked(page, 'https://weibo.com/', { stage: 'login-home' });
    await page.waitForFunction(() => Boolean(window.$CONFIG), null, { timeout: 4000 }).catch(() => {});
    const identity = await this.readIdentity(page).catch(() => ({ status: 'invalid' }));
    if (identity.status === 'valid') {
      await this.browserManager.foreground?.(page);
      return { page };
    }
    onStage('navigate-qr');
    await gotoChecked(page, 'https://passport.weibo.com/sso/signin?entry=miniblog&source=miniblog&url=https%3A%2F%2Fweibo.com%2F', { stage: 'login-qr' });
    onStage('qr-page-ready');
    // The initial window activation happens before navigation. Restore it again
    // after the actual QR login page has loaded so it does not recede behind the
    // app that initiated the login.
    await this.browserManager.foreground?.(page);
    return { page };
  }

  async ensureQrVisible(page) {
    // The login UI may be embedded in an iframe, so inspect each frame.
    for (const frame of page.frames()) {
      const qrLocators = [
        frame.locator('img[src*="qr.weibo.cn"], img[src*="qrcode"], img[src*="qrimage"], img[alt*="二维码"], [class*="qrcode"] img, [class*="qr-code"] img, [node-type="qrcode"] img'),
        frame.locator('[class*="qrcode"] canvas, [class*="qr-code"] canvas')
      ];
      const existing = await firstVisible(qrLocators);
      if (existing) {
        if (await existing.evaluate(el => el.tagName !== 'IMG' || (el.complete && el.naturalWidth > 0))) return true;
        continue;
      }
      const tab = await firstVisible([
        frame.getByText(/^(扫码登录|二维码登录)$/),
        frame.locator('[node-type="qrcode_tab"], [class*="qrcode_tab"], [class*="qrcode-switch"]')
      ]);
      if (tab) await tab.click({ timeout: 2500 });
      const qr = await firstVisible(qrLocators);
      if (qr && await qr.evaluate(el => el.tagName !== 'IMG' || (el.complete && el.naturalWidth > 0))) return true;
    }
    return false;
  }

  async readIdentity(page) {
    // The server-rendered desktop config identifies the logged-in viewer, not the
    // author of a visited profile. Waiting on the passport page never navigates it.
    const currentUrl = String(page.url?.() || '');
    const parsed = parsePageUrl(currentUrl);
    if (!parsed || isUnloadedPageUrl(currentUrl)) {
      throw new NavigationUnavailableError('微博页面未能加载，无法读取登录身份', {
        navigationUrl: currentUrl, stage: 'identity', netCode: 'PAGE_UNLOADED'
      });
    }
    // A real passport/login redirect is a signed-out state, not a broken page.
    if (parsed.hostname !== 'weibo.com') {
      if (parsed.hostname === 'passport.weibo.com' || parsed.hostname === 'passport.weibo.cn') return { status: 'invalid' };
      throw new NavigationUnavailableError('微博页面跳转至非登录业务页，身份暂不可读', { navigationUrl: 'https://weibo.com/', stage: 'identity', netCode: 'PAGE_UNEXPECTED_HOST' });
    }
    let viewer;
    try {
      viewer = await page.evaluate(() => {
        const config = window.$CONFIG;
        const bodyText = String(document.body?.innerText || '').replace(/\s+/g, ' ').trim();
        return {
          uid: String(config?.uid || config?.user?.idstr || config?.user?.id || ''),
          nickname: config?.user?.screen_name || '',
          hasConfig: Boolean(config),
          readyState: document.readyState,
          body: Boolean(document.body),
          title: String(document.title || ''),
          textLength: bodyText.length,
          htmlLength: Number((document.documentElement?.innerHTML || '').length),
          loginForm: Boolean(document.querySelector('form[action*="login" i], input[name="username" i], [node-type="loginName"], [class*="loginForm" i], [class*="login-form" i]')),
          challengeHint: /安全验证|请完成验证|验证码|账号存在风险/.test(bodyText)
            || Boolean(document.querySelector('iframe[src*="captcha"], [class*="geetest_panel"], .yidun_modal__wrap'))
        };
      });
    } catch (error) {
      if (/Execution context was destroyed|Cannot find context|Target closed|Navigation failed/i.test(String(error?.message || ''))) {
        throw new NavigationUnavailableError('微博页面在读取身份时发生跳转或关闭', {
          navigationUrl: currentUrl, stage: 'identity', netCode: 'PAGE_UNLOADED'
        });
      }
      throw error;
    }
    // Fields are absent on lightweight test doubles; only reject when the real
    // document reports an unloaded or error state.
    if (viewer && (viewer.body === false || viewer.readyState === 'loading' || (viewer.htmlLength != null && viewer.htmlLength < 50))) {
      throw new NavigationUnavailableError('微博页面尚未完整加载，无法读取登录身份', {
        navigationUrl: currentUrl, stage: 'identity', netCode: 'PAGE_EMPTY'
      });
    }
    if (viewer && ERROR_PAGE_TEXT.test(String(viewer.title || ''))) {
      throw new NavigationUnavailableError('微博返回了错误页，无法读取登录身份', {
        navigationUrl: currentUrl, stage: 'identity', netCode: 'PAGE_ERROR'
      });
    }
    // A visible captcha is a verification state, never a logout.  Hidden
    // template text alone must not trigger it, so confirm with the same widget
    // detector used by the rest of the adapter.
    if (viewer?.challengeHint && await pageHasVisibleChallenge(page)) {
      throw new VerificationError('微博要求进行安全验证，请完成验证后重试');
    }
    if (!viewer || (!viewer.hasConfig && !viewer.uid)) {
      if (viewer?.loginForm) return { status: 'invalid' };
      throw new NavigationUnavailableError('微博页面尚未加载登录信息', {
        navigationUrl: currentUrl, stage: 'identity', netCode: 'PAGE_NOT_RECOGNIZED'
      });
    }
    const uid = viewer.uid;
    if (!uid || !/^\d+$/.test(uid) || uid === '0') return { status: 'invalid' };
    let nickname = viewer.nickname;
    if (!nickname) {
      const profile = await page.evaluate(async viewerUid => {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 8000);
        try {
          const response = await fetch(`/ajax/profile/info?uid=${encodeURIComponent(viewerUid)}`, { credentials: 'include', signal: controller.signal });
          if (!response.ok) return null;
          return await response.json();
        } finally { clearTimeout(timer); }
      }, uid);
      nickname = profile?.data?.user?.screen_name || '';
    }
    if (!nickname) throw new AdapterError('已识别登录，正在读取微博昵称', 'identity_pending');
    return { status: 'valid', uid, nickname };
  }

  async loginChallenge(page) {
    // Only visible verification widgets count; hidden template text must not block login.
    for (const frame of page.frames()) {
      if (await firstVisible([
        frame.locator('iframe[src*="captcha"], [class*="geetest_panel"]'),
        frame.getByRole('dialog').filter({ hasText: /安全验证|验证码|异常访问/ }),
        frame.getByText(/^(请完成安全验证|请完成验证|账号存在风险)$/)
      ])) return true;
    }
    return false;
  }

  async getIdentity(account, owner = 'login') {
    const page = await this.browserManager.page(account, owner);
    if (owner === 'runner' && parsePageUrl(page.url?.())?.hostname !== 'weibo.com') {
      await gotoChecked(page, 'https://weibo.com/', { stage: 'identity-home' });
    }
    return this.readIdentity(page);
  }

  async ensureIdentity(account) {
    const identity = await this.getIdentity(account, this.taskOwner());
    if (identity.status !== 'valid') throw new AuthenticationError();
    if (account.uid && String(account.uid) !== String(identity.uid)) {
      throw new IdentityMismatchError(`当前登录 UID ${identity.uid} 与账号记录 ${account.uid} 不一致`);
    }
    return identity;
  }

  // Read-only probe used while a task is paused for human verification.
  async isVerificationResolved(account, { assertRunning = () => {} } = {}) {
    assertRunning();
    const owner = this.browserManager.owner === 'manual' ? 'manual' : 'runner';
    const page = await this.browserManager.page(account, owner);
    if (await this.hasTaskChallenge(account)) return false;
    assertRunning();
    const identity = await this.getIdentity(account, owner);
    assertRunning();
    const resolved = identity.status === 'valid' && (!account.uid || String(account.uid) === String(identity.uid));
    return resolved;
  }

  async closeManual(context) {
    try {
      for (const handle of [this.manualPostReceipt, this.manualCommentReceipt, this.manualRepostReceipt]) {
        if (!context || handle?.page?.context?.() === context) await handle?.stop?.();
      }
    } finally {
      await this.browserManager.closeManual?.(context);
    }
  }

  currentSubmission(action) {
    const handle = action?.kind === 'comment' ? this.manualCommentReceipt : action?.kind === 'repost' ? this.manualRepostReceipt : action?.kind === 'post' ? this.manualPostReceipt : null;
    return handle && handle.actionId === action?.id && handle.attemptId === action?.attempt_id
      && !handle.page?.isClosed?.() ? handle : null;
  }

  async pageFor(account, topic) {
    const page = await this.browserManager.page(account, this.taskOwner());
    await gotoChecked(page, topic.url, { stage: 'topic-page' });
    await detectChallenge(page, this.browserManager);
    return page;
  }

  async checkin(account, topic, { verifyOnly = false, reusePage = false, onSubmit = () => {}, deadlineAt } = {}) {
    // A manual verification session deliberately keeps its visible page open.
    // Retrying the same topic must not navigate it away (which can dismiss a
    // just-completed challenge), while a different topic still needs a normal
    // navigation.
    let page = reusePage
      ? await this.browserManager.page(account, this.taskOwner())
      : await this.pageFor(account, topic);
    if (reusePage && page.url() !== topic.url) {
      await gotoChecked(page, topic.url, { stage: 'topic-page' });
    }
    await detectChallenge(page, this.browserManager);
    await page.locator('[class*="signBtn"]').first().waitFor({ state: 'visible', timeout: 10000 }).catch(() => {});
    const button = await firstVisible([
      page.locator('[class*="signBtn"]').filter({ hasText: /^(签到|已签到|今日已签到)$/ })
    ]);
    if (!button) throw new UnsupportedPageError('没有识别到超话签到入口；请确认超话链接可访问');
    if (/已签到/.test(await button.innerText())) return { state: 'succeeded', url: page.url(), alreadyDone: true, reason: '今日已签到' };
    if (verifyOnly) return { state: 'uncertain', url: page.url(), reason: '尚未签到' };
    await submitBeforeDeadline(button, onSubmit, deadlineAt);
    // Some verification overlays flash in and out before the ordinary sign-in
    // label changes.  Sample the short post-click window rather than checking
    // only once, so the workflow can register a card without foregrounding
    // the background browser.
    for (const delay of [250, 450, 700]) {
      await page.waitForTimeout(delay);
      await detectChallenge(page, this.browserManager);
      const after = await button.innerText().catch(() => '');
      if (/^(已签到|今日已签到)$/.test(after.trim())) return { state: 'succeeded', url: page.url(), alreadyDone: false };
    }
    return { state: 'uncertain', url: page.url(), reason: '点击签到后未验收到“已签到”状态' };
  }

  async preparePostComposer(account, topic, text, syncToHome) {
    const startedAt = Date.now();
    const mark = stage => this.log('info', `发帖准备阶段：${stage}（${Date.now() - startedAt}ms）`, {
      accountId: account.id, topicId: topic.id });
    await this.ensureIdentity(account);
    const page = await this.browserManager.page(account, this.taskOwner());
    await gotoChecked(page, 'https://weibo.com/', { stage: 'post-home' });
    mark('首页已加载');
    await detectChallenge(page, this.browserManager);
    const target = topic.url.match(/\/p\/(100808\w+)/)?.[1];
    if (!target) throw new UnsupportedPageError('超话链接缺少可核对的目标标识');
    await page.getByText('更多', { exact: true }).first().waitFor({ state: 'visible', timeout: 10000 }).catch(() => {});
    const more = await firstVisible([page.getByText('更多', { exact: true })]);
    if (!more) throw new UnsupportedPageError('首页没有识别到发博入口');
    await more.click();
    const superEntry = await firstVisible([page.getByText('超话', { exact: true })]);
    if (!superEntry) throw new UnsupportedPageError('没有识别到首页发博的超话入口');
    await superEntry.click();
    const dialog = page.locator('.woo-modal-wrap').filter({ has: page.locator('textarea[placeholder="掐指一算，此贴必火"]') }).first();
    await dialog.waitFor({ state: 'visible', timeout: 10000 }).catch(() => {});
    if (!await dialog.isVisible().catch(() => false)) throw new UnsupportedPageError('没有识别到超话发博窗口');
    mark('发博窗口已打开');
    await dialog.getByText('选择超话', { exact: true }).click();
    const search = dialog.getByPlaceholder('搜索超话');
    await waitForTopicSearchResult(page, search, topic, target);
    mark('超话搜索已确认');
    const title = superTopicTitle(topic);
    const results = dialog.locator('[class*="_h3_"]').filter({ hasText: new RegExp(`^${title.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`) });
    const count = await results.count().catch(() => 0);
    let selected = count === 1 ? results.first() : null;
    if (count > 1) {
      const matchingIndexes = await results.evaluateAll((nodes, pageId) => nodes.map((node, index) => {
        const card = node.closest('[data-pageid], [data-page-id], [data-id]') || node.parentElement || node;
        return String(card?.outerHTML || '').includes(String(pageId)) ? index : -1;
      }).filter(index => index >= 0), target);
      if (matchingIndexes.length === 1) selected = results.nth(matchingIndexes[0]);
    }
    if (!selected) throw new UnsupportedPageError('不能唯一识别超话搜索结果，未发送');
    await selected.click();
    const editor = dialog.locator('textarea[placeholder="掐指一算，此贴必火"]');
    await page.waitForFunction(name => document.querySelector('textarea[placeholder="掐指一算，此贴必火"]')?.value.includes(`${name}[超话]`), title, { timeout: 5000 }).catch(() => {});
    const prefix = await editor.inputValue();
    if (!prefix.includes(`${title}[超话]`)) throw new UnsupportedPageError('无法确认已关联目标超话，未发送');
    await editor.fill(`${prefix}${text}`);
    mark('正文已填充');
    const sync = dialog.getByRole('checkbox', { name: /同步到微博/ });
    if (await sync.count() !== 1) throw new UnsupportedPageError('没有识别到主页同步选项，未发送');
    await setVisibleCheckboxState(sync.first(), syncToHome, page);
    for (let attempt = 0; attempt < 10 && (await sync.isChecked()) !== syncToHome; attempt += 1) {
      await page.waitForTimeout(50);
    }
    if ((await sync.isChecked()) !== syncToHome) throw new UnsupportedPageError('无法确认主页同步设置，未发送');
    mark('同步选项已确认');
    const publish = dialog.getByRole('button', { name: /^(发送|发布)$/ });
    if (await publish.count() !== 1 || !await publish.isEnabled()) throw new UnsupportedPageError('发博窗口的发送按钮不可用，未发送');
    return { page, dialog, editor, publish, target };
  }

  async post(account, topic, text, { onSubmit = () => {}, onReceipt = () => {}, syncToHome = false, deadlineAt,
    attemptId = randomUUID(), actionId = null, receiptTimeoutMs = 30000, signal, workbenchVerification = false } = {}) {
    await this.manualPostReceipt?.stop();
    let prepared = null, lastSetupError = null;
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      try {
        prepared = await this.preparePostComposer(account, topic, text, syncToHome);
        this.log('info', `发帖准备完成（第 ${attempt}/3 次）`, { accountId: account.id, topicId: topic.id });
        break;
      } catch (error) {
        if (!(error instanceof UnsupportedPageError) || signal?.aborted) throw error;
        lastSetupError = error;
        this.log('warning', `发帖准备失败（第 ${attempt}/3 次）：${error.message}`, { accountId: account.id, topicId: topic.id });
        if (attempt < 3) await new Promise(resolve => setTimeout(resolve, 800 * attempt));
      }
    }
    if (!prepared) throw lastSetupError || new UnsupportedPageError('发帖准备失败，未发送');
    const { page, editor, publish, target } = prepared;
    let savedSuccess = null, savingSuccess = null;
    const saveSuccess = receipt => {
      if (savingSuccess) return savingSuccess;
      savedSuccess = receipt;
      savingSuccess = Promise.resolve().then(() => onReceipt(receipt));
      // Both observers may discover the same success concurrently. Persist it
      // once, and let their read/drain methods report a persistence failure.
      return savingSuccess;
    };
    const notice = await createPostSuccessNoticeObserver(page, { attemptId, onSuccess: saveSuccess });
    const collector = createPostReceiptCollector({
      page, attemptId, submittedText: await editor.inputValue(), topicId: target,
      onReceipt: saveSuccess, classify: classifyPostReceipt, readJson: readJsonBounded, receiptTimeoutMs, signal,
      log: event => this.log('info', `发帖回执：${JSON.stringify({ actionId, ...event })}`, { accountId: account.id, topicId: topic.id })
    });
    this.manualPostReceipt = { kind: 'post', actionId, page, attemptId, stop: async () => { collector.stop(); await notice.stop(); },
      read: async () => { await acceptedResult(); return collector.read(); }, events: collector.events };
    let handedOff = false;
    const acceptedResult = async () => {
      await notice.read();
      if (!savedSuccess && !collector.accepted) return null;
      try { await savingSuccess; }
      catch (cause) { throw Object.assign(new Error('发布成功回执保存异常，禁止重新发送', { cause }), { code: 'receipt_persistence_failed' }); }
      if (collector.saveError) throw Object.assign(new Error('发布成功回执保存异常，禁止重新发送'), { code: 'receipt_persistence_failed', needsReadback: true });
      return { state: 'succeeded', receiptId: savedSuccess?.receiptId || null,
        receiptUrl: savedSuccess?.receiptUrl || null, url: savedSuccess?.url || null,
        successSource: savedSuccess?.successSource || 'api_receipt' };
    };
    try {
      await submitBeforeDeadline(publish, async () => {
        await notice.begin(); await onSubmit(); collector.begin();
        this.log('info', '发帖已点击提交', { accountId: account.id, topicId: topic.id });
      }, deadlineAt);
      while (!collector.expired && !signal?.aborted) {
        if (await acceptedResult()) break;
        try { await detectChallenge(page, this.browserManager); }
        catch (error) { if (await acceptedResult()) break; throw error; }
        if (await acceptedResult()) break;
        const result = collector.read()?.result;
        if (result?.kind === 'verification') throw new VerificationError(result.reason);
        if (['muted', 'frequent'].includes(result?.kind)) break;
        if (collector.expired) break;
        await page.waitForTimeout(100);
      }
      await collector.drain();
      const success = await acceptedResult();
      if (success) return success;
      const latest = collector.read(), classification = latest?.result;
      const denied = latest?.payload?.success === false || latest?.payload?.ok === false || latest?.payload?.ok === 0 || latest?.payload?.data?.ok === 0;
      if (classification?.kind === 'verification') throw new VerificationError(classification.reason);
      if (classification?.kind === 'muted') throw new MutedError(classification.reason, 'post', denied);
      if (classification?.kind === 'frequent') throw new RateLimitError(classification.reason, 'post', denied);
      if (classification?.kind === 'failed') return { state: 'failed', url: null, reason: classification.reason || '微博明确拒绝发布' };
      const muted = await visibleMutedMessage(page);
      if (muted) throw new MutedError(muted, 'post', false);
      const frequent = await visibleRateMessage(page);
      if (frequent) throw new RateLimitError(frequent, 'post', false);
      return { state: 'uncertain', url: null,
        reason: '已提交，但未收到明确成功或失败提示，请人工核对' };
    } catch (error) {
      // The page probe can fail while a receipt's body is still being read.
      await collector.drain();
      const success = await acceptedResult();
      if (success) return success;
      if (error instanceof VerificationError) {
        // Only an owned, definitive background rejection can be replayed.
        // Keep the manual composer alive for Weibo's own automatic submit.
        const rejected = workbenchVerification && this.taskOwner() !== 'manual'
          && workbenchRejectedByVerification(collector.soleResponse);
        if (rejected) error.explicitlyUnpublished = true;
        else { collector.handoff(); handedOff = true; error.submittedUncertain = true; }
      }
      throw error;
    } finally {
      if (!handedOff) { await collector.finish(); await notice.stop(); }
    }
  }

  async collectCandidates(account, topic, { section = '最新', limit = 50, onBatch = null, assertRunning = () => {} } = {}) {
    assertRunning();
    const page = await this.pageFor(account, topic);
    if (section) {
      const tabs = page.locator('.chaohua-tab-wrap').first();
      if (/^https:\/\/weibo\.com\/p\//.test(page.url())) await tabs.waitFor({ state: 'visible', timeout: 10000 }).catch(() => {});
      const scoped = await tabs.count() ? tabs : page;
      if (!await scoped.getByText(section, { exact: true }).first().isVisible().catch(() => false)) {
        const more = await firstVisible([scoped.locator('[title="更多"]')]);
        if (more) await more.click();
      }
      await scoped.getByText(section, { exact: true }).first().waitFor({ state: 'visible', timeout: 10000 }).catch(() => {});
      const sectionLink = await firstVisible([scoped.getByText(section, { exact: true })]);
      if (!sectionLink) throw new UnsupportedPageError(`没有找到分区“${section}”`);
      await sectionLink.click();
      if (scoped !== page) {
        const selected = tabs.locator('.woo-box-item-inlineBlock.cur').filter({ hasText: section });
        await selected.first().waitFor({ state: 'visible', timeout: 5000 }).catch(() => {});
        if (!await selected.count()) throw new UnsupportedPageError(`无法确认已切换到分区“${section}”`);
      }
      if (section.toLowerCase() === '超like') {
        await page.getByText('最新发帖', { exact: true }).first().waitFor({ state: 'visible', timeout: 10000 }).catch(() => {});
        const latest = await firstVisible([page.getByText('最新发帖', { exact: true })]);
        if (!latest) throw new UnsupportedPageError('已进入超like，但没有找到“最新发帖”排序');
        await latest.click();
        await page.waitForFunction(target => {
          const topicLinks = [...document.querySelectorAll(`a[href*="${target}"]`)];
          return topicLinks.some(link => {
            let node = link;
            for (let i = 0; node && i < 8; i += 1, node = node.parentElement) {
              if ([...node.querySelectorAll('footer,[class*="toolbar" i],[class*="action" i]')].some(row => /\S/.test(row.innerText || ''))) return true;
            }
            return false;
          });
        }, topic.url.match(/\/p\/(100808\w+)/)?.[1] || '', { timeout: 10000 }).catch(() => {});
        if (!await page.getByText('最新发帖', { exact: true }).first().isVisible().catch(() => false)) {
          throw new UnsupportedPageError('无法确认超like的“最新发帖”排序');
        }
      }
    }
    const target = topic.url.match(/\/p\/(100808\w+)/)?.[1] || '';
    const scanVisible = () => page.evaluate(targetId => {
      const anchors = [...document.querySelectorAll('a[href]')].filter(anchor => /^\/\d+\/[A-Za-z0-9]+$/.test(new URL(anchor.href, location.href).pathname));
      const rows = [];
      const seen = new Set();
      for (const anchor of anchors) {
        const href = new URL(anchor.href, location.href).href;
        const match = new URL(href).pathname.match(/^\/(\d+)\/([A-Za-z0-9]+)$/);
        if (!match || seen.has(match[2])) continue;
        // Prefer the individual feed card. The old climb-until-regex approach
        // could capture a nested repost or recommended card's action bar.
        let container = anchor.closest('article,[role="article"]');
        if (!container) {
          let node = anchor;
          for (let i = 0; node && i < 9; i += 1, node = node.parentElement) {
            const ids = [...node.querySelectorAll('a[href]')].map(a => new URL(a.href, location.href).pathname.match(/^\/\d+\/([A-Za-z0-9]+)$/)?.[1]).filter(Boolean);
            const hasAction = [...node.querySelectorAll('footer,[class*="toolbar" i],[class*="action" i]')]
              .some(el => /\S/.test(el.innerText || ''));
            if (hasAction && new Set(ids).size === 1) { container = node; break; }
          }
        }
        if (!container || !container.querySelector(`a[href*="${targetId}"]`)) continue;
        const cardPostIds = [...container.querySelectorAll('a[href]')]
          .map(a => new URL(a.href, location.href).pathname.match(/^\/\d+\/([A-Za-z0-9]+)$/)?.[1]).filter(Boolean);
        const actionRows = [...container.querySelectorAll('footer,[class*="toolbar" i],[class*="action" i], [class*="func" i]')]
          .filter(el => !el.closest('[class*="repost" i], [class*="retweet" i], [class*="comment" i], blockquote') && (!el.closest('article,[role="article"]') || el.closest('article,[role="article"]') === container));
        const actionTexts = actionRows
          .map(el => el.innerText || '');
        if (!actionTexts.length && new Set(cardPostIds).size === 1) actionTexts.push(container.innerText || '');
        // Each counter replaces its label when nonzero: "2 / 3 / 4" is the
        // same row as "转发 / 评论 / 赞". Never require a literal 转发 label.
        const number = '\\d[\\d,]*(?:\\.\\d+)?[万亿]?\\+?';
        const rowPattern = new RegExp(`^(?:转发|${number})\\s+(评论|${number})\\s+(?:赞|${number})$`);
        const actionMatch = actionTexts.map(text => text.trim().match(rowPattern)).find(Boolean);
        // A count is trusted only if it comes from this card's own action row.
        // An unreadable counter remains unknown and is checked through the
        // status API; discarding the card here would prevent that read entirely.
        if (!actionMatch && !actionRows.some(el => /\S/.test(el.innerText || ''))) continue;
        const countText = actionMatch?.[1];
        const multiplier = countText?.includes('亿') ? 1e8 : countText?.includes('万') ? 1e4 : 1;
        const commentCount = !countText ? null : countText === '评论' ? 0 : Number(countText.replace(/[,万亿+]/g, '')) * multiplier;
        seen.add(match[2]);
        // Extract the original post body only. Nicknames, toolbars and nested
        // repost/comment cards must never make a keyword candidate qualify.
        const bodyNodes = [...container.querySelectorAll('[class*="detail_wbtext"], [class*="wbtext"], [node-type="feed_list_content"], p')]
          .filter(node => !node.closest('[class*="repost" i], [class*="retweet" i], [class*="comment" i], [class*="author" i], [class*="nickname" i], [class*="notice" i], blockquote, header, footer'));
        const body = bodyNodes.filter(node => !bodyNodes.some(parent => parent !== node && parent.contains(node))).map(node => {
          const copy = node.cloneNode(true);
          for (const nested of copy.querySelectorAll('[class*="repost" i], [class*="retweet" i], [class*="comment" i], blockquote, footer')) nested.remove();
          return copy.textContent || '';
        }).join('\n');
        rows.push({ id: match[2], url: href, text: body, commentCount, authorUid: match[1], createdAt: anchor.getAttribute('title') || anchor.getAttribute('aria-label') || anchor.innerText.trim() });
      }
      return rows;
    }, target);
    const collected = new Map();
    let stagnant = 0;
    for (let i = 0; i < 24 && collected.size < limit && stagnant < 5; i += 1) {
      assertRunning();
      const before = collected.size;
      const batch = (await scanVisible()).filter(item => !collected.has(item.id) && (!account.uid || item.authorUid !== String(account.uid))).slice(0, limit - collected.size);
      for (const item of batch) collected.set(item.id, item);
      if (onBatch && batch.length && await onBatch(batch)) break;
      stagnant = collected.size === before ? stagnant + 1 : 0;
      if (collected.size >= limit) break;
      assertRunning();
      await page.mouse.wheel(0, 1400);
      await page.waitForTimeout(500);
    }
    return [...collected.values()].filter(item => !account.uid || item.authorUid !== String(account.uid)).slice(0, limit);
  }

  // A last read from the original status endpoint immediately before filling the
  // editor. It avoids treating an unavailable value as zero and protects against
  // a comment arriving between the list scan and submission.
  async inspectCandidate(account, candidate, { inFeed = false } = {}) {
    const page = await this.browserManager.page(account, this.taskOwner());
    if (!inFeed) await gotoChecked(page, candidate.url, { stage: 'candidate-page' });
    await detectChallenge(page, this.browserManager);
    const expectedId = String(candidate.id || '');
    const statusId = /^\d+$/.test(expectedId) ? expectedId : weiboShortIdToNumeric(expectedId);
    const status = await page.evaluate(async id => {
      const response = await fetch(`/ajax/statuses/show?id=${encodeURIComponent(id)}`, { credentials: 'include' });
      return response.ok ? response.json() : null;
    }, statusId).catch(() => null);
    const post = status?.data || status;
    const returnedId = String(post?.mblogid || post?.idstr || post?.mid || '');
    const returnedNumericId = String(post?.id || post?.mid || '');
    if (!post || (returnedId !== expectedId && returnedNumericId !== statusId)) return null;
    const count = post?.comments_count;
    if (count == null || count === '' || !Number.isFinite(Number(count))) return null;
    return { id: expectedId, commentCount: Number(count), url: candidate.url };
  }

  async verifyComment(account, candidate, content, { commentId = null, uid = account.uid, delays = [1000, 3000, 8000], identity: knownIdentity = null } = {}) {
    const identity = knownIdentity || await this.ensureIdentity(account);
    const page = await this.browserManager.page(account, this.taskOwner());
    if (new URL(page.url()).href !== new URL(candidate.url).href) {
      await gotoChecked(page, candidate.url, { stage: 'comment-page' });
    }
    await detectChallenge(page, this.browserManager);
    const authorUid = candidate.authorUid || new URL(candidate.url).pathname.match(/^\/(\d+)\//)?.[1] || '';
    const rawStatusId = String(candidate.id || new URL(candidate.url).pathname.split('/').pop());
    const statusId = /^\d+$/.test(rawStatusId) ? rawStatusId : weiboShortIdToNumeric(rawStatusId);
    const findMatch = async (delay, verificationMethod) => {
      if (delay > 0) await page.waitForTimeout(delay);
      const readback = await page.evaluate(async ({ id, authorUid: postAuthorUid }) => {
        const params = new URLSearchParams({
          is_reload: '1', id, is_show_bulletin: '3', is_mix: '0', count: '50',
          uid: String(postAuthorUid || ''), fetch_level: '0', locale: 'zh-CN'
        });
        const response = await fetch(`/ajax/statuses/buildComments?${params}`, { credentials: 'include' });
        return response.ok ? response.json() : null;
      }, { id: statusId, authorUid }).catch(() => null);
      const rows = Array.isArray(readback?.data) ? readback.data : [];
      const match = rows.find(row => commentRowMatches(row, {
        nickname: identity.nickname || account.nickname, content, commentId, uid
      }));
      if (match) {
        const matchedId = match.idstr || match.id || commentId;
        const url = matchedId ? `${candidate.url}${candidate.url.includes('?') ? '&' : '?'}comment_id=${encodeURIComponent(matchedId)}` : candidate.url;
        return { state: 'succeeded', url, verificationMethod };
      }
      if (await visibleDescendingCommentMatches(page, { nickname: identity.nickname || account.nickname, content })) {
        return { state: 'succeeded', url: commentId ? `${candidate.url}${candidate.url.includes('?') ? '&' : '?'}comment_id=${encodeURIComponent(commentId)}` : candidate.url, verificationMethod };
      }
      return null;
    };
    // A normal, visible comment or the default comment readback is enough proof
    // of success. Do this before touching the sort control: newer Weibo layouts
    // can accept a comment while omitting the old “按倒序” tab.
    const initial = await findMatch(0, 'default_comment_readback');
    if (initial) return initial;
    if (!await selectDescendingComments(page)) {
      return { state: 'uncertain', url: candidate.url, reason: '默认评论列表未识别到评论，且未能确认“按倒序”入口' };
    }
    for (const delay of delays) {
      const result = await findMatch(delay, 'descending_nickname_text');
      if (result) return result;
    }
    return { state: 'uncertain', url: candidate.url, reason: '按倒序查看最新 50 条评论，仍未找到昵称和完整文案均匹配的评论' };
  }

  async comment(account, candidate, content, { beforeSubmit, onSubmit = () => {}, onReceipt = () => {}, attemptId = randomUUID(), actionId = null, deadlineAt, engage = false, workbenchVerification = false } = {}) {
    await this.manualCommentReceipt?.stop?.();
    const page = await this.browserManager.page(account, this.taskOwner());
    let editor, submit;
    if (engage) {
      await this.openWeibo(account, candidate.url);
      ({editor,submit} = await this.engageComposer(page,candidate.url,'comment'));
      await editor.fill(content);
    } else {
    await gotoChecked(page, candidate.url, { stage: 'comment-page' });
    await detectChallenge(page, this.browserManager);
    await page.locator('textarea[placeholder*="评论"]').first().waitFor({ state: 'visible', timeout: 10000 }).catch(() => {});
    editor = await firstVisible([
      page.locator('textarea[placeholder*="评论"]'), page.locator('textarea'),
      page.locator('[contenteditable="true"][role="textbox"]'), page.locator('[contenteditable="true"]')
    ]);
    if (!editor) throw new UnsupportedPageError('没有识别到评论输入框');
    await editor.fill(content);
    const region = editor.locator('xpath=../../..');
    submit = await firstVisible([region.getByRole('button', { name: /^(评论|发送)$/ }), region.getByText(/^(评论|发送)$/, { exact: true })]);
    if (!submit) throw new UnsupportedPageError('已经填写评论，但没有识别到评论按钮');
    if (!await submit.isEnabled()) throw new UnsupportedPageError('评论按钮不可点击，未发送');
    }
    let saved = null, saving = null, submitted = false, handedOff = false, signalNotice;
    const noticeSignal = new Promise(resolve => { signalNotice = resolve; });
    const saveComment = receipt => {
      if (saving) return saving;
      saved = { ...receipt, url: receipt.url || candidate.url };
      saving = Promise.resolve().then(() => onReceipt(saved));
      void saving.then(() => signalNotice({}), () => signalNotice({}));
      return saving;
    };
    const notice = await createCommentSuccessNoticeObserver(page, { attemptId, onSuccess: saveComment });
    const acceptedResult = async () => {
      await notice.read();
      if (!saved) return null;
      try { await saving; }
      catch (cause) { throw Object.assign(new Error('评论成功回执保存异常，禁止重新评论', { cause }), { code: 'receipt_persistence_failed' }); }
      return { ...saved, state: 'succeeded' };
    };
    const rawTarget = String(candidate.id || '');
    const commentTarget = /^\d+$/.test(rawTarget) ? rawTarget : /^[A-Za-z0-9]+$/.test(rawTarget) ? weiboShortIdToNumeric(rawTarget) : '';
    const collector = workbenchVerification && !engage && commentTarget ? createPostReceiptCollector({
      operation: 'comment', targetId: commentTarget, page, attemptId, submittedText: content,
      classify: classifyCommentReceipt, readJson: readJsonBounded,
      onReceipt: receipt => saveComment({ ...receipt, url: candidate.url + (candidate.url.includes('?') ? '&' : '?') + 'comment_id=' + encodeURIComponent(receipt.receiptId) })
    }) : null;
    this.manualCommentReceipt = { kind: 'comment', actionId, attemptId, page,
      read: collector ? acceptedResult : () => notice.read(),
      stop: async () => { collector?.stop(); await notice.stop(); } };
    try {
    const receipt = page.waitForResponse(r => r.request().method() === 'POST' && /^\/ajax\/comments\/(create|reply|add)$/.test(new URL(r.url()).pathname), { timeout: 15000 }).catch(() => null);
    await submitBeforeDeadline(submit, async () => { if (beforeSubmit) await beforeSubmit(); await notice.begin(); await onSubmit(); submitted = true; collector?.begin(); }, deadlineAt);
    await page.waitForTimeout(300);
    if (await acceptedResult()) return acceptedResult();
    await detectChallenge(page, this.browserManager);
    const outcome = await Promise.race([waitForReceiptOrRateLimit(page, receipt), noticeSignal]);
    if (await acceptedResult()) return acceptedResult();
    if (outcome.restrictionMessage && isMutedMessage(outcome.restrictionMessage)) throw new MutedError(outcome.restrictionMessage, 'comment', Boolean(outcome.response));
    if (outcome.restrictionMessage && isRateLimitMessage(outcome.restrictionMessage)) throw new RateLimitError(outcome.restrictionMessage, 'comment', Boolean(outcome.response));
    const response = outcome.response;
    const payload = await readJsonBounded(response);
    if (await acceptedResult()) return acceptedResult();
    await collector?.drain();
    if (await acceptedResult()) return acceptedResult();
    const classification = classifyCommentReceipt(payload, Boolean(response?.ok()));
    if (response) {
      const code = String(payload?.error_code ?? payload?.code ?? payload?.data?.error_code ?? '无').replace(/[^\w-]/g, '').slice(0, 40);
      const reason = String(classification.reason || '').replace(/https?:\/\/\S+/g, '[链接]').slice(0, 200);
      this.log('info', `评论回执：HTTP ${response.status()}，业务码 ${code}，分类 ${classification.kind}${reason ? `，原因 ${reason}` : ''}`, { accountId: account.id, url: candidate.url });
    }
    if (classification.kind === 'verification') {
      const error = new VerificationError(classification.reason);
      error.explicitlyUnpublished = !workbenchVerification && classification.explicitlyUnpublished;
      throw error;
    }
    const mutedMessage = mutedMessageFromReceipt(payload) || await visibleMutedMessage(page);
    if (mutedMessage) throw new MutedError(mutedMessage, 'comment', Boolean(response));
    const rateMessage = rateMessageFromReceipt(payload) || await visibleRateMessage(page);
    if (isRateLimitMessage(rateMessage)) throw new RateLimitError(rateMessage, 'comment', Boolean(response));
    const created = payload?.data || payload;
    const commentId = created?.idstr || created?.id;
    const rejected = classification.kind === 'failed';
    // This is a confirmed non-submission, unlike a timeout or an unreadable
    // receipt.  Tell the scheduler which post author must be avoided for the
    // rest of this round; it can safely release the reserved comment number
    // and choose another post.
    if (rejected) return {
      state: 'cancelled', retryElsewhere: true, authorUid: String(candidate.authorUid || ''),
      url: page.url(), reason: `微博回执明确表示评论未被接受：${classification.reason}`
    };
    if (classification.kind !== 'succeeded' && response && !response.ok()) return { state: 'uncertain', url: page.url(), reason: '评论接口异常，无法确认是否接受；不据此避让发帖人' };
    const result = await this.verifyComment(account, candidate, content, {
      commentId, uid: account.uid, identity: { uid: account.uid, nickname: account.nickname }
    });
    if (result.state === 'succeeded' && !result.url.includes('comment_id=') && commentId) {
      result.url = `${candidate.url}${candidate.url.includes('?') ? '&' : '?'}comment_id=${encodeURIComponent(commentId)}`;
    }
    return await acceptedResult() || result;
    } catch (error) {
      const success = await acceptedResult();
      if (success) return success;
      if (error instanceof VerificationError && submitted) {
        await collector?.drain();
        const confirmed = await acceptedResult();
        if (confirmed) return confirmed;
        if (collector && this.taskOwner() !== 'manual' && workbenchRejectedByVerification(collector.soleResponse)) {
          error.explicitlyUnpublished = true;
        } else {
          collector?.handoff();
          handedOff = true;
          error.submittedUncertain = true;
        }
      }
      throw error;
    } finally {
      if (!handedOff) { await collector?.finish(); await notice.stop(); }
    }
  }

  async engageRestrictions(page, kind) {
    await detectChallenge(page,this.browserManager);
    if (['repost','comment'].includes(kind)) {
      const muted=await visibleMutedMessage(page); if(muted) throw new MutedError(muted,kind);
    }
    const rate=await visibleRateMessage(page); if(rate) throw new RateLimitError(rate,kind);
  }

  async engageComposer(page, link, kind, { coupled = false } = {}) {
    const card=await this.engagePostCard(page,weiboLinkStatusId(link));
    if(!card) throw new UnsupportedPageError('无法唯一识别目标微博卡片');
    const control=await engageControl(page,card.locator('[data-engage-toolbar]').first(),kind);
    if(!control) throw new UnsupportedPageError('没有识别到'+(kind==='repost'?'转发':'评论')+'入口');
    await control.click();
    const placeholder=kind==='repost'?'分享心得':'评论';
    const inline=page.locator('textarea[placeholder*="'+placeholder+'"]');
    await inline.first().waitFor({state:'visible',timeout:8000}).catch(()=>{});
    let editor=await firstVisible([inline, page.locator('.woo-modal-wrap textarea'),page.locator('.woo-modal-wrap [contenteditable="true"]')]);
    if(!editor) throw new UnsupportedPageError('没有识别到'+(kind==='repost'?'转发':'评论')+'输入框');
    // Find the smallest composer ancestor owning its submit, not a whole page.
    await editor.evaluate((e,kind)=>{
      document.querySelectorAll('[data-engage-composer]').forEach(n=>n.removeAttribute('data-engage-composer'));
      const label=kind==='repost'?'转发':'评论';
      for(let root=e.parentElement,n=0;root && n<7;root=root.parentElement,n++) {
        if([...root.querySelectorAll('button,[role="button"]')].some(b=>b.textContent.trim()===label)) {root.setAttribute('data-engage-composer',kind);break;}
      }
    },kind);
    let region=page.locator('[data-engage-composer="'+kind+'"]');
    const label=kind==='repost'?'转发':'评论';
    const submit=await firstVisible([region.getByRole('button',{name:label,exact:true}),region.getByText(label,{exact:true})]);
    if(!submit) throw new UnsupportedPageError('没有识别到'+label+'提交按钮');
    if (kind !== 'repost') return {editor,submit};
    const coupleLabel='同时评论';
    let couple=await firstVisible([
      region.getByRole('checkbox',{name:coupleLabel,exact:true}),
      region.locator('label').filter({hasText:coupleLabel}).locator('input[type="checkbox"]').first()
    ]);
    if(!couple) couple=await firstVisible([page.getByRole('checkbox',{name:coupleLabel,exact:true})]);
    if(!couple){
      const text=await firstVisible([region.getByText(coupleLabel,{exact:true})]);
      couple=text ? text.locator('xpath=ancestor::label[1]//input[@type="checkbox"]').first() : null;
    }
    if(coupled && !couple) throw new UnsupportedPageError('没有识别到“'+coupleLabel+'”选项，未提交');
    if(couple){
      await setVisibleCheckboxState(couple,coupled,page);
      if(await couple.isChecked().catch(()=>false)!==Boolean(coupled)) throw new UnsupportedPageError('“'+coupleLabel+'”选项状态未生效，未提交');
    }
    return {editor,submit};
  }

  async openWeibo(account, link) {
    const page = await this.browserManager.page(account, this.taskOwner());
    const statusId = weiboLinkStatusId(link);
    const target = new URL(link).hostname === 'weibo.com' || new URL(link).hostname === 'www.weibo.com' ? link : 'https://weibo.com/detail/' + statusId;
    const force = this.forceNextEngageNavigation === true;
    this.forceNextEngageNavigation = false;
    if (force || safeNavigationUrl(page.url()) !== safeNavigationUrl(target)) await gotoChecked(page, target, { stage: 'engage-link' });
    await detectChallenge(page, this.browserManager);
    return page;
  }

  async readEngagePost(page, id) {
    const statusId = /^\d+$/.test(id) ? id : weiboShortIdToNumeric(id);
    return page.evaluate(async sid => {
      const response = await fetch('/ajax/statuses/show?id=' + encodeURIComponent(sid), { credentials: 'include' });
      if (!response.ok) return null;
      const payload = await response.json();
      const post = payload?.data || payload;
      return String(post?.idstr || post?.id || '') === sid ? post : null;
    }, statusId).catch(() => null);
  }

  async readLikeState(page, id) {
    const post = await this.readEngagePost(page, id);
    return typeof post?.liked === 'boolean' ? post.liked : null;
  }

  async commentRows(page, id, authorUid) {
    const statusId = /^\d+$/.test(id) ? id : weiboShortIdToNumeric(id);
    const payload = await page.evaluate(async ({ sid, uid }) => {
      const params = new URLSearchParams({ is_reload: '1', id: sid, is_show_bulletin: '3', is_mix: '0', count: '100', uid: String(uid || ''), fetch_level: '0', locale: 'zh-CN' });
      const response = await fetch('/ajax/statuses/buildComments?' + params.toString(), { credentials: 'include' });
      return response.ok ? response.json() : null;
    }, { sid: statusId, uid: authorUid || '' }).catch(() => null);
    return Array.isArray(payload?.data) ? payload.data : [];
  }

  async engagePostCard(page, id) {
    const numeric = /^\d+$/.test(id) ? id : weiboShortIdToNumeric(id);
    await page.locator('a[href*="'+id+'"], [data-mid="'+numeric+'"]').first().waitFor({state:'visible',timeout:10000}).catch(()=>{});
    // Scope every toolbar to the exact detail card. A recommended post or a
    // nested retweet's toolbar is never a substitute for the requested post.
    const marked = await markEngagePost(page, id, numeric);
    return marked ? page.locator('[data-engage-target="true"]') : null;
  }

  async repostWeibo(account, link, text, { beforeSubmit, onSubmit = () => {}, deadlineAt, attemptId = randomUUID(), actionId = null, onReceipt = () => {}, receiptTimeoutMs = 15000, alsoComment = false } = {}) {
    await this.manualRepostReceipt?.stop?.();
    const page = await this.openWeibo(account, link);
    const { editor, submit } = await this.engageComposer(page, link, 'repost', { coupled: alsoComment });
    if (text) await editor.fill(text);
    const rawId = weiboLinkStatusId(link), targetId = /^\d+$/.test(rawId) ? rawId : weiboShortIdToNumeric(rawId);
    const collector = createPostReceiptCollector({ page, attemptId, submittedText: text || '', operation: 'repost', targetId,
      onReceipt, classify: classifyCommentReceipt, readJson: readJsonBounded, receiptTimeoutMs });
    let handedOff = false, savedNotice = null;
    const notice = await createRepostSuccessNoticeObserver(page, { attemptId, onSuccess: async receipt => {
      savedNotice = { ...receipt, url:link }; await onReceipt(savedNotice);
    } });
    const readSuccess = async () => {
      await notice.read(); await collector.drain();
      if (collector.saveError) throw Object.assign(new Error('转发回执保存失败，禁止重发'), {code:'receipt_persistence_failed'});
      if (savedNotice) return { ...savedNotice, state:'succeeded' };
      const receipt = collector.accepted?.result;
      return receipt?.kind === 'succeeded' ? { state:'succeeded', receiptId:receipt.id, url:receipt.id ? 'https://weibo.com/detail/'+receipt.id : link } : null;
    };
    this.manualRepostReceipt = { kind:'repost', actionId, attemptId, page,
      stop:async()=>{ collector.stop(); await notice.stop(); }, read:readSuccess };
    try {
      await submitBeforeDeadline(submit, async () => { if (beforeSubmit) await beforeSubmit(); await notice.begin(); await onSubmit(); collector.begin(); }, deadlineAt);
      while (!collector.expired) {
        const success = await readSuccess(); if (success) return success;
        const result = collector.read()?.result;
        if (result?.kind === 'verification') throw new VerificationError(result.reason);
        if (result?.kind === 'muted') throw new MutedError(result.reason, 'repost', true);
        if (result?.kind === 'frequent') throw new RateLimitError(result.reason, 'repost', true);
        if (result?.kind === 'failed') return { state:'failed',url:link,reason:result.reason || '微博明确拒绝转发' };
        await this.engageRestrictions(page, 'repost');
        await page.waitForTimeout(100);
      }
      return await readSuccess() || { state:'uncertain',url:link,reason:'转发已提交但未观察到成功提示或回执，不自动重试' };
    } catch (error) {
      const success = await readSuccess(); if (success) return success;
      if (error instanceof VerificationError) { handedOff=true; collector.handoff(); error.submittedUncertain=true; }
      throw error;
    } finally { if (!handedOff) { collector.stop(); await notice.stop(); } }
  }

  async verifyRepost(account, action) {
    if (action.success_source === 'page_notice' && action.state === 'succeeded') return {state:'succeeded',url:action.url || action.link,successSource:'page_notice'};
    const page = await this.openWeibo(account, action.link || action.url);
    if (!action.receipt_id) {
      const originalId = weiboLinkStatusId(action.link || action.url);
      const expectedId = /^\d+$/.test(originalId) ? originalId : weiboShortIdToNumeric(originalId);
      const matches = new Map(), window = postTimeWindow({ startedAt: action.started_at,
        submittedAt: action.submitted_at, completedAt: action.completed_at });
      for (let pageNo = 1; pageNo <= 2; pageNo += 1) {
        const payload = await boundedRead(() => page.evaluate(async ({ uid, page: currentPage }) => {
          const controller = new AbortController(), timer = setTimeout(() => controller.abort(), 3000);
          try {
            const response = await fetch(`/ajax/statuses/mymblog?uid=${encodeURIComponent(uid)}&page=${currentPage}&feature=0`, { credentials: 'include', signal: controller.signal });
            return response.ok ? await response.json() : null;
          } finally { clearTimeout(timer); }
        }, { uid: account.uid, page: pageNo }));
        const data = payload?.data || payload || {}, posts = data.list || data.statuses || data.data || [];
        for (const post of posts) {
          if (!withinPostWindow(post, window)) continue;
          if (String(post?.user?.idstr || post?.user?.id || '') !== String(account.uid)) continue;
          const retweeted = String(post?.retweeted_status?.idstr || post?.retweeted_status?.id || '');
          if (retweeted !== expectedId) continue;
          if (action.content && normalizeWeiboText(post.text_raw || post.text) !== normalizeWeiboText(action.content)) continue;
          const id = String(post.idstr || post.id || '');
          if (id) matches.set(id, post);
        }
      }
      if (matches.size !== 1) return { state: 'uncertain', reason: matches.size
        ? '近期微博存在多个相符转发，不能唯一归属' : '未取得回执且近期微博未找到唯一相符转发' };
      const [receiptId, post] = matches.entries().next().value;
      return { state: 'succeeded', receiptId, createdAt: post.created_at,
        url: post.mblogid ? `https://weibo.com/${account.uid}/${post.mblogid}` : receiptUrl(receiptId), successSource: 'recent_repost_match' };
    }
    const post = await this.readEngagePost(page, String(action.receipt_id));
    const originalId = weiboLinkStatusId(action.link || action.url);
    const expectedId = /^\d+$/.test(originalId) ? originalId : weiboShortIdToNumeric(originalId);
    const belongs = post && String(post.user?.idstr || post.user?.id || '') === String(account.uid)
      && String(post.retweeted_status?.idstr || post.retweeted_status?.id || '') === expectedId
      && (!action.content || normalizeWeiboText(post.text_raw || post.text) === normalizeWeiboText(action.content));
    return belongs ? { state: 'succeeded', receiptId: action.receipt_id, url: 'https://weibo.com/detail/' + action.receipt_id } : { state: 'uncertain', reason: '未能核对到本账号的该条转发' };
  }

  async engageLikeButton(page, button, kind, link, {beforeSubmit,onSubmit=()=>{},deadlineAt}={}) {
    const before=await visibleLikeState(button);
    if(before) return {state:'skipped',alreadyDone:true,url:link,reason:'已经点过赞，跳过'};
    await this.engageRestrictions(page,kind);
    await submitBeforeDeadline(button,async()=>{if(beforeSubmit)await beforeSubmit();await onSubmit();},deadlineAt);
    for(let n=0;n<30;n++) {
      if(await visibleLikeState(button)) return {state:'succeeded',url:link,alreadyDone:false,successSource:'page_color'};
      await this.engageRestrictions(page,kind);
      await page.waitForTimeout(100);
    }
    return {state:'uncertain',url:link,reason:'点击后未观察到点赞由灰变橙，不自动重试'};
  }

  async likeWeibo(account, link, options = {}) {
    const {blacklistUids=[],blacklistKeywords=[]}=options;
    const page=await this.openWeibo(account,link),id=weiboLinkStatusId(link);
    const post=await this.readEngagePost(page,id);
    if(!post || typeof post.liked !== 'boolean') throw new UnsupportedPageError('外赞的已赞状态无法确认，未点击');
    if ((blacklistUids.length && !post?.user?.idstr && !post?.user?.id) || (blacklistKeywords.length && post?.text_raw == null && post?.text == null)) return {state:'skipped',url:link,reason:'无法完整核对点赞黑名单，未执行点击'};
    if(blacklistUids.map(String).includes(String(post?.user?.idstr || post?.user?.id || '')) || blacklistKeywords.some(word=>normalizeWeiboText(post?.text_raw || post?.text).includes(normalizeWeiboText(word)))) return {state:'skipped',url:link,reason:'命中点赞黑名单'};
    const card=await this.engagePostCard(page,id);
    if(!card) throw new UnsupportedPageError('无法唯一识别目标微博卡片');
    const button=await engageControl(page,card.locator('[data-engage-toolbar]').first(),'like');
    if(!button) throw new UnsupportedPageError('没有识别到点赞入口');
    if(post?.liked === true) return {state:'skipped',alreadyDone:true,url:link,reason:'已经点过赞，跳过'};
    return this.engageLikeButton(page,button,'like',link,options);
  }

  async resetEngageSession() {
    this.engageScan = null;
    this.forceNextEngageNavigation = false;
  }

  engageCatalog(link) {
    const entry = this.engageCatalogs.get(link);
    if (!entry || Date.now() - entry.updatedAt > 5 * 60 * 1000) {
      this.engageCatalogs.delete(link);
      return [];
    }
    return [...entry.keys];
  }

  rememberEngageCatalog(link, rows, scan) {
    const entry = this.engageCatalogs.get(link);
    const keys = entry && Date.now() - entry.updatedAt <= 5 * 60 * 1000 ? [...entry.keys] : [];
    const known = new Set(keys);
    for (const row of rows) if (row?.key && !known.has(row.key)) { known.add(row.key); keys.push(row.key); }
    this.engageCatalogs.set(link, { keys, updatedAt: Date.now() });
    scan.catalog = keys;
  }

  async streamingCommentSession(account, link, options = {}) {
    const page = await this.openWeibo(account, link);
    if (this.engageScan?.page?.isClosed?.()) this.engageScan = null;
    if (this.engageScan?.page === page && this.engageScan.accountId === account.id && this.engageScan.link === link) return this.engageScan;
    options.assertRunning?.();
    if (!await page.locator('textarea[placeholder*="评论"]').first().isVisible().catch(()=>false)) {
      await this.engageComposer(page,link,'comment');
    }
    const editor=page.locator('textarea[placeholder*="评论"]').first();
    await editor.waitFor({state:'visible',timeout:8000});
    await editor.scrollIntoViewIfNeeded();
    // The editor and the comment list are rendered in separate requests. A
    // fast shell can expose the editor while the list is still empty; do not
    // let the first scan conclude that there are no comments.
    for(let attempt=0;attempt<32;attempt++) {
      const rows=await readStreamingComments(page,{viewportOnly:false});
      if(rows.length)break;
      await page.waitForTimeout(250);
    }
    this.engageScan={page,accountId:account.id,link,seen:new Set(),idle:0,scrolls:0,lastHeight:0,
      catalog:this.engageCatalog(link)};
    return this.engageScan;
  }

  async findStreamingComment(page, target) {
    const rows=await readStreamingComments(page,{viewportOnly:false});
    const key = target.key || target.id;
    return rows.find(row=>row.key===key || row.id===target.id) || null;
  }

  async clickStreamingComment(page, link, target, options) {
    let pinned,submitted=false, fresh;
    try {
      options.assertRunning?.();
      await this.engageRestrictions(page,'comment_like');
      if(options.beforeSubmit)await options.beforeSubmit();
      options.assertRunning?.();
      // Network probes and Vue rendering may replace the row. Re-resolve the
      // same identity, then pin its exact node for the one permitted click.
      for(let attempt=0;attempt<4 && !pinned;attempt++) {
        fresh=await this.findStreamingComment(page,target);
        if(!fresh)return {state:'skipped',missing:true,url:link,reason:'原评论身份已不可唯一定位，未提交点击'};
        if(fresh.isReply && options.includeVisibleReplies !== true)return {state:'skipped',alreadyDone:true,url:link,reason:'未启用楼中楼点赞'};
        if(fresh.liked)return {state:'skipped',alreadyDone:true,url:link};
        const button=page.locator(fresh.selector);
        let candidate;
        try {
          candidate=await button.elementHandle();
          if(!candidate || !await candidate.evaluate(element=>element.isConnected)) { await candidate?.dispose?.().catch(()=>{}); continue; }
          await candidate.scrollIntoViewIfNeeded();
          if(!await candidate.evaluate(element=>element.isConnected)) { await candidate.dispose().catch(()=>{}); continue; }
          pinned=candidate;
        } catch(error) {
          await candidate?.dispose?.().catch(()=>{});
          if(isClosedPageError(error)) throw new EngagePageClosedError();
          if(isDetachedDomError(error)) continue;
          throw error;
        }
      }
      if(!pinned)return {state:'skipped',missing:true,url:link};
      const exact={keepHandle:true,click:args=>pinned.click(args),elementHandle:async()=>pinned};
      await submitBeforeDeadline(exact,async()=>{
        options.assertRunning?.();
        if(!await pinned.evaluate(e=>e.isConnected))throw Object.assign(new Error('评论节点在点击前重绘'),{code:'engage_target_changed'});
        const identity=await readStreamingComments(page,{viewportOnly:false,targetElement:pinned});
        const pinnedRow=identity.find(row=>row.pinned);
        if(!pinnedRow || (pinnedRow.key!==fresh.key && pinnedRow.id!==fresh.id))
          throw Object.assign(new Error('点赞按钮已不属于原评论'),{code:'engage_target_changed'});
        if(await visibleLikeState(pinned))throw Object.assign(new Error('评论已点赞'),{code:'engage_already_liked'});
        await options.onTarget?.(fresh);
        await options.onSubmit?.();submitted=true;
      },options.deadlineAt);
      for(let n=0;n<60;n++) {
        if(await pinned.evaluate(e=>e.isConnected).catch(()=>false)) {
          if(await visibleLikeState(pinned))return {state:'succeeded',targetId:fresh.id,url:link,successSource:'page_color'};
        } else {
          const readback=await this.findStreamingComment(page,fresh);
          if(readback?.liked)return {state:'succeeded',targetId:fresh.id,url:link,successSource:'page_color'};
        }
        if(n===0 || n%5===0) await this.engageRestrictions(page,'comment_like');
        await page.waitForTimeout(50);
      }
      return {state:'uncertain',url:link,reason:'内赞点击后未确认灰变橙，不自动重试'};
    } catch(error) {
      if(!submitted && isClosedPageError(error)) throw new EngagePageClosedError();
      if(!submitted && isDetachedDomError(error))return {state:'skipped',missing:true,url:link,reason:'点赞按钮在点击预检前重绘，未提交点击'};
      if(!submitted && error.code==='engage_already_liked')return {state:'skipped',alreadyDone:true,url:link,reason:error.message};
      if(!submitted && error.code==='engage_target_changed')return {state:'skipped',missing:true,url:link,reason:error.message};
      if(submitted && ![VerificationError,RateLimitError,MutedError,DailyStopError].some(Type=>error instanceof Type)
        && !/ERR_|network|网络|断网/i.test(error.message || ''))return {state:'uncertain',url:link,reason:'内赞点击后页面变化，结果未知，不自动重试'};
      throw error;
    } finally {await pinned?.dispose?.().catch(()=>{});}
  }

  async likeNextComment(account,link,options={}) {
    const scanStartedAt = Date.now();
    let scan=await this.streamingCommentSession(account,link,options);
    const excluded=new Set(options.excludedKeys || []);
    const keywords=(options.keywords || String(options.keyword || '').split(/[、,，\r\n]+/)).map(normalizeWeiboText).filter(Boolean);
    const blackUid=new Set((options.blacklistUids || []).map(String));
    const blackKw=(options.blacklistKeywords || []).map(normalizeWeiboText).filter(Boolean);
    let redraws=0, pageResets=0;
    for(let turn=0;turn<1000;turn++) {
      options.assertRunning?.();
      if(scan.page?.isClosed?.()) {
        if(++pageResets>3) throw new UnsupportedPageError('内赞页面连续关闭，未提交点击；请核对当前浏览器状态');
        this.engageScan=null;
        scan=await this.streamingCommentSession(account,link,options);
        continue;
      }
      const page=scan.page;
      try { await this.engageRestrictions(page,'comment_like'); } catch(error) {
        if(!isClosedPageError(error)) throw error;
        this.engageScan=null;
        if(++pageResets>3) throw new UnsupportedPageError('内赞页面连续关闭，未提交点击；请核对当前浏览器状态');
        scan=await this.streamingCommentSession(account,link,options);
        continue;
      }
      let rows;
      try { rows=await readStreamingComments(page); } catch(error) {
        if(!isClosedPageError(error)) throw error;
        this.engageScan=null;
        if(++pageResets>3) throw new UnsupportedPageError('内赞页面连续关闭，未提交点击；请核对当前浏览器状态');
        scan=await this.streamingCommentSession(account,link,options);
        continue;
      }
      pageResets=0;
      this.rememberEngageCatalog(link,rows,scan);
      const rank=new Map((scan.catalog||[]).map((key,index)=>[key,index]));
      rows.sort((a,b)=>(rank.get(a.key) ?? 1e9)-(rank.get(b.key) ?? 1e9) || a.top-b.top);
      const target=rows.find(row=>!scan.seen.has(row.key) && (!excluded.has(row.key) || options.target?.id===row.key)
        && (options.includeVisibleReplies === true || !row.isReply)
        && (!options.target || row.id===options.target.id || row.key===options.target.key));
      if(target) {
        this.log('info', `内赞目标已定位（${Date.now() - scanStartedAt}ms，滚动 ${scan.scrolls} 次）`, { accountId: account.id, url: link });
        if(target.liked || blackUid.has(target.authorUid) || (keywords.length && !keywords.some(word=>normalizeWeiboText(target.text).includes(word)))
          || blackKw.some(word=>normalizeWeiboText(target.text).includes(word))) {scan.seen.add(target.key);continue;}
        let result;
        try { result=await this.clickStreamingComment(page,link,target,options); } catch(error) {
          if(!(error instanceof EngagePageClosedError)) throw error;
          this.engageScan=null;
          if(++pageResets>3) throw new UnsupportedPageError('内赞页面连续关闭，未提交点击；请核对当前浏览器状态');
          scan=await this.streamingCommentSession(account,link,options);
          continue;
        }
        if(result.missing) {
          if(++redraws<4)continue;
          this.engageCatalogs.delete(link);
          throw new UnsupportedPageError('内赞目标无法稳定确认：'+(result.reason || '评论身份或节点已变化')+'；未提交点击，请核对当前页面');
        }
        scan.seen.add(target.key);scan.idle=0;
        if(result.alreadyDone)continue;
        return result;
      }
      let position;
      try { position=await scrollStreamingComments(page); } catch(error) {
        if(!isClosedPageError(error)) throw error;
        this.engageScan=null;
        if(++pageResets>3) throw new UnsupportedPageError('内赞页面连续关闭，未提交点击；请核对当前浏览器状态');
        scan=await this.streamingCommentSession(account,link,options);
        continue;
      }
      scan.scrolls++;
      await waitForStreamingCommentSettle(page);
      let next;
      try { next=await readStreamingComments(page); } catch(error) {
        if(!isClosedPageError(error)) throw error;
        this.engageScan=null;
        if(++pageResets>3) throw new UnsupportedPageError('内赞页面连续关闭，未提交点击；请核对当前浏览器状态');
        scan=await this.streamingCommentSession(account,link,options);
        continue;
      }
      this.rememberEngageCatalog(link,next,scan);
      const newRows=next.some(row=>!scan.seen.has(row.key) && !excluded.has(row.key) && (options.includeVisibleReplies === true || !row.isReply)
        && (!options.target || row.id===options.target.id || row.key===options.target.key));
      if(newRows) {scan.idle=0;continue;}
      scan.idle=position.bottom && !position.moved && position.height===scan.lastHeight ? scan.idle+1 : 0;
      scan.lastHeight=position.height;
      if(scan.idle>=3) {
        this.log('info', `内赞扫描到达末尾（${Date.now() - scanStartedAt}ms，滚动 ${scan.scrolls} 次）`, { accountId: account.id, url: link });
        return {state:'skipped',exhausted:true,url:link,reason:'已从上到下扫描至评论区末尾，没有更多符合条件的未赞评论，内赞数量不足'};
      }
      if(scan.scrolls>=100)throw new UnsupportedPageError('评论区连续加载达到安全上限，不能确认已经到底；请核对，未把加载失败记作数量不足');
    }
    throw new UnsupportedPageError('评论扫描达到安全上限，未继续点击');
  }

  async engageCommentRows(account,link,{limit=100,assertRunning=()=>{}}={}) {
    const page=await this.openWeibo(account,link);
    const card=await this.engagePostCard(page,weiboLinkStatusId(link));
    if(!card) throw new UnsupportedPageError('无法唯一识别目标微博卡片');
    const control=await engageControl(page,card.locator('[data-engage-toolbar]').first(),'comment');
    if(control && !await page.locator('textarea[placeholder*="评论"]').first().isVisible().catch(()=>false)) await control.click();
    await page.locator('textarea[placeholder*="评论"], [data-commentid], [data-comment-id]').first().waitFor({state:'visible',timeout:8000}).catch(()=>{});
    const found=new Map(); let stable=0;
    for(let turn=0;turn<25;turn++) {
      assertRunning(); await this.engageRestrictions(page,'comment_like');
      const rows=await this.commentRows(page,weiboLinkStatusId(link),weiboLinkAuthorUid(link));
      rows.forEach(row=>found.set(String(row.idstr || row.id),row));
      const marked=await markEngageComments(page,[...found.values()]);
      if(marked.length>=limit || stable>=3) return {page,rows:[...found.values()],marked};
      const before=found.size;
      await page.evaluate(()=>window.scrollBy(0,Math.round(innerHeight*.7)));
      await page.waitForTimeout(400);
      const next=await this.commentRows(page,weiboLinkStatusId(link),weiboLinkAuthorUid(link));
      next.forEach(row=>found.set(String(row.idstr || row.id),row));
      stable=before===found.size ? stable+1 : 0;
    }
    return {page,rows:[...found.values()],marked:await markEngageComments(page,[...found.values()])};
  }

  async scanComments(account,link,{keyword='',keywords,blacklistKeywords=[],blacklistUids=[],limit=100,assertRunning}={}) {
    const {page,rows,marked}=await this.engageCommentRows(account,link,{limit,assertRunning});
    const kw=(Array.isArray(keywords)?keywords:String(keyword||'').split(/[、,，\r\n]+/)).map(normalizeWeiboText).filter(Boolean);
    const blackUid=new Set(blacklistUids.map(String)); const result=[];
    for(const row of marked) {
      const text=normalizeWeiboText(row.text);
      if(blackUid.has(row.authorUid) || (kw.length && !kw.some(word=>text.includes(word))) || blacklistKeywords.some(word=>text.includes(normalizeWeiboText(word)))) continue;
      const apiState=commentLikeState(rows,row.id); if(apiState===null || apiState) continue;
      const button=page.locator('[data-engage-comment-like="'+row.id+'"]');
      if(await visibleLikeState(button)) continue;
      result.push({...row,text,liked:false}); if(result.length>=limit)break;
    }
    return result;
  }

  async likeComment(account,link,commentId,options={}) {
    const page=await this.openWeibo(account,link);
    const state=commentLikeState(await this.commentRows(page,weiboLinkStatusId(link),weiboLinkAuthorUid(link)),commentId);
    if(state===null) throw new UnsupportedPageError('目标评论的已赞状态无法确认，未点击');
    if(state) return {state:'skipped',alreadyDone:true,url:link,reason:'已经点过赞，跳过'};
    let button=page.locator('[data-engage-comment-like="'+commentId+'"]');
    if(!await button.count()) {
      await this.engageCommentRows(account,link,{limit:100});
      button=page.locator('[data-engage-comment-like="'+commentId+'"]');
    }
    if(!await button.count()) throw new UnsupportedPageError('没有识别到目标评论点赞入口，未借用其他评论按钮');
    return this.engageLikeButton(page,button,'comment_like',link,options);
  }

  async verifyLike(account,link) {
    const page=await this.openWeibo(account,link),card=await this.engagePostCard(page,weiboLinkStatusId(link));
    const button=card && await engageControl(page,card.locator('[data-engage-toolbar]').first(),'like');
    return button && await visibleLikeState(button) ? {state:'succeeded',url:link} : {state:'uncertain',url:link,reason:'未观察到已赞橙色状态'};
  }

  async verifyCommentLike(account,link,commentId) {
    const page=await this.openWeibo(account,link);
    if (/^(dom:|cid:)/.test(String(commentId || ''))) {
      await this.streamingCommentSession(account,link);
      const target=await this.findStreamingComment(page,{id:commentId});
      if (target?.liked) return {state:'succeeded',url:link,successSource:'page_color',found:true};
      return {state:'uncertain',url:link,found:Boolean(target),notLiked:Boolean(target),
        reason:target ? '原评论明确未赞，等待人工验证后补点' : '未找到原评论，不能更换目标' };
    }
    let button=page.locator('[data-engage-comment-like="'+commentId+'"]');
    if(!await button.count()) {await this.engageCommentRows(account,link,{limit:100});button=page.locator('[data-engage-comment-like="'+commentId+'"]');}
    if(await button.count() && await visibleLikeState(button)) return {state:'succeeded',url:link,found:true};
    return {state:'uncertain',url:link,found:Boolean(await button.count()),notLiked:Boolean(await button.count()),
      reason:await button.count() ? '原评论明确未赞，等待人工验证后补点' : '未找到原评论，不能更换目标'};
  }

  static describeError(error) {
    return { code: error?.code || 'unknown', message: serializeError(error) };
  }
}
