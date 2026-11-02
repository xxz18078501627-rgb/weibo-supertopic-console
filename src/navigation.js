// Shared navigation guardrails.
//
// Page navigation failures used to surface as raw Playwright errors whose
// message contains the complete target URL (including query strings that may
// carry one-time tokens).  They were also easy to confuse with a signed-out
// account.  This module gives callers one typed error with a sanitized URL, a
// stage and an optional HTTP status; definite network failures stay untouched
// so the existing network recovery path can still recognise them.

const WRAPPED_NET_CODES = new Set([
  'ERR_HTTP_RESPONSE_CODE_FAILURE',
  'ERR_FAILED',
  'ERR_INVALID_RESPONSE'
]);

// A real loss of connectivity (or proxy failure) must keep its original error:
// network-recovery.js matches these codes/messages to pause the job and wait.
const DEFINITE_NETWORK_CODES = new Set([
  'ERR_INTERNET_DISCONNECTED',
  'ERR_NETWORK_CHANGED',
  'ERR_CONNECTION_RESET',
  'ERR_CONNECTION_CLOSED',
  'ERR_CONNECTION_REFUSED',
  'ERR_CONNECTION_ABORTED',
  'ERR_CONNECTION_TIMED_OUT',
  'ERR_NAME_NOT_RESOLVED',
  'ERR_PROXY_CONNECTION_FAILED',
  'ERR_TUNNEL_CONNECTION_FAILED',
  'ERR_TIMED_OUT'
]);

export class NavigationUnavailableError extends Error {
  constructor(message, { navigationUrl = null, stage = 'navigation', httpStatus = null, netCode = null } = {}) {
    super(message);
    this.name = 'NavigationUnavailableError';
    this.code = 'navigation_unavailable';
    this.navigationUrl = safeNavigationUrl(navigationUrl);
    this.stage = stage || 'navigation';
    this.httpStatus = Number.isFinite(Number(httpStatus)) && Number(httpStatus) > 0 ? Number(httpStatus) : null;
    this.netCode = netCode || null;
  }
}

export function isNavigationError(error) {
  return error instanceof NavigationUnavailableError || error?.code === 'navigation_unavailable';
}

// Keep only scheme + origin + pathname.  Credentials, query strings and
// fragments never make it into logs, error messages or persisted state.
export function safeNavigationUrl(value) {
  if (value == null) return null;
  let url;
  try { url = value instanceof URL ? value : new URL(String(value)); } catch { return null; }
  if (url.protocol === 'http:' || url.protocol === 'https:') return `${url.origin}${url.pathname || '/'}`;
  if (url.protocol === 'about:') return `about:${url.pathname || 'blank'}`;
  if (!url.protocol) return null;
  return `${url.protocol}//${url.host}${url.pathname || ''}`;
}

function netCodeOf(error) {
  const message = String(error?.message || '');
  return message.match(/\b(?:net::)?(ERR_[A-Z0-9_]+)\b/)?.[1] || null;
}

function isTimeoutError(error) {
  return error?.name === 'TimeoutError' || /\bTimeout\s+\d+ms\s+exceeded\b/i.test(String(error?.message || ''));
}

function sanitizedMessage({ stage, url, httpStatus, netCode }) {
  const location = safeNavigationUrl(url) || '未知页面';
  const status = httpStatus ? `，HTTP ${httpStatus}` : '';
  const code = netCode ? `，${netCode}` : '';
  return `页面加载失败（${stage}）：${location}${status}${code}`;
}

/**
 * Navigate a page and translate load failures into NavigationUnavailableError.
 *
 * - ERR_HTTP_RESPONSE_CODE_FAILURE / ERR_FAILED / ERR_INVALID_RESPONSE and
 *   Playwright navigation timeouts become NavigationUnavailableError.
 * - A completed navigation whose main response is HTTP >= 400 becomes
 *   NavigationUnavailableError carrying the HTTP status.
 * - Definite network/proxy errors are re-thrown untouched for network.handle()
 * - Every other error is re-thrown untouched (never silently swallowed).
 *
 * Returns the main-frame Response (or null for about:blank/same-document).
 */
export async function gotoChecked(page, url, { stage = 'navigation', ...gotoOptions } = {}) {
  const safeUrl = safeNavigationUrl(url);
  const options = { waitUntil: 'domcontentloaded', timeout: 30000, ...gotoOptions };
  let response, observedStatus = null;
  const onResponse = candidate => {
    try {
      if (candidate.request().isNavigationRequest() && candidate.frame() === page.mainFrame()) observedStatus = candidate.status();
    } catch { /* A detached frame has no usable main-document metadata. */ }
  };
  page.on?.('response', onResponse);
  try {
    response = await page.goto(url, options);
  } catch (error) {
    if (isNavigationError(error)) throw error;
    const netCode = netCodeOf(error);
    if (netCode && DEFINITE_NETWORK_CODES.has(netCode)) throw error;
    const timeout = !netCode && isTimeoutError(error);
    if ((netCode && WRAPPED_NET_CODES.has(netCode)) || timeout) {
      throw new NavigationUnavailableError(sanitizedMessage({
        stage, url: safeUrl, httpStatus: observedStatus, netCode: netCode || 'TimeoutError'
      }), { navigationUrl: safeUrl, stage, httpStatus: observedStatus, netCode: netCode || 'TimeoutError' });
    }
    throw error;
  } finally { page.off?.('response', onResponse); }

  const status = Number(response?.status?.());
  if (Number.isFinite(status) && status >= 400) {
    throw new NavigationUnavailableError(sanitizedMessage({
      stage, url: safeUrl, httpStatus: status, netCode: null
    }), { navigationUrl: safeUrl, stage, httpStatus: status, netCode: null });
  }
  return response;
}
