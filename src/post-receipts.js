const POST_PATH = /^\/ajax\/(?:(statuses|stopic)\/(update|create|add)|statuses\/normal\/create)$/;
const TEXT_FIELDS = ['status', 'text', 'content'];
const TOPIC_FIELDS = ['page_id', 'topic_id'];
const DRAIN_TIMEOUT_MS = 3_000;

function safeHint(payload, submittedText, fallback) {
  if (payload?.validate || payload?.data?.validate) return fallback;
  const hint = payload?.message ?? payload?.msg ?? payload?.error ?? payload?.data?.message ?? payload?.data?.msg;
  if (typeof hint !== 'string') return fallback;
  let text = hint.split(/[:：\n]/, 1)[0];
  const body = submittedText.replace(/^#?[^#\n]*?\[超话\]#?\s*/, '');
  for (const value of [submittedText, body]) if (value) text = text.replaceAll(value, '[正文]');
  // Drop free-form identifiers and any text referring to credentials or a
  // challenge; retain short platform hints such as “内容重复，请稍后再试”.
  if (/cookie|token|authorization|challenge|exception_key|alitest|https?:|[a-z0-9_=-]{12,}/i.test(text)) return fallback;
  return text.trim().slice(0, 160) || fallback;
}

function inspectBody(raw, submittedText, topicId, commentTarget = null, requireTopic = true) {
  if (typeof raw !== 'string' || !raw.trim()) return { owned: true, trusted: false };
  let fields;
  try {
    if (/^--[^\r\n]+\r?\nContent-Disposition:/i.test(raw)) {
      const boundary = raw.split(/\r?\n/, 1)[0];
      const parts = new Map();
      for (const part of raw.split(boundary).slice(1)) {
        const match = part.match(/^\r?\nContent-Disposition:\s*form-data;\s*name="([^"]+)"[^\r\n]*\r?\n(?:[^\r\n]+\r?\n)*?\r?\n([\s\S]*?)\r?\n$/i);
        if (match && !/;\s*filename=/i.test(part.split(/\r?\n/)[1] || '')) {
          const values = parts.get(match[1]) || []; values.push(match[2]); parts.set(match[1], values);
        }
      }
      fields = name => parts.get(name) || [];
    } else {
    const body = JSON.parse(raw);
    if (!body || typeof body !== 'object' || Array.isArray(body)) return { owned: true, trusted: false };
    fields = name => Object.hasOwn(body, name) ? [body[name]] : [];
    }
  } catch {
    // URLSearchParams accepts arbitrary strings; require an actual form body.
    if (!raw.includes('=') || /^[\s]*[\[{]/.test(raw)) return { owned: true, trusted: false };
    const body = new URLSearchParams(raw);
    fields = name => body.getAll(name);
  }
  const topics = commentTarget === null && requireTopic ? TOPIC_FIELDS.flatMap(fields) : [];
  if (commentTarget !== null) {
    const targets = ['id', 'mid', 'status_id'].flatMap(fields);
    if (!targets.length) return { owned: true, trusted: false };
    if (targets.some(value => String(value) !== String(commentTarget))) return { owned: false };
  }
  // The live stopic publisher sends the public page ID as 1022:100808… .
  // Accept only this observed wrapper, retaining exact target identity.
  const sameTopic = value => value != null && (String(value) === String(topicId)
    || (/^100808[a-z0-9]+$/i.test(String(topicId)) && String(value) === `1022:${topicId}`));
  if (topics.some(value => !sameTopic(value))) return { owned: false };
  const texts = (commentTarget === null ? TEXT_FIELDS : [...TEXT_FIELDS, 'comment']).flatMap(fields);
  if (!texts.length || texts.some(value => typeof value !== 'string')) return { owned: true, trusted: false };
  if (texts.some(value => value.trim() !== submittedText.trim())) return { owned: false };
  return { owned: true, trusted: true };
}

/**
 * Observe one page/attempt. Call begin immediately before submitting. log receives
 * an object containing only safe metadata, never the response or request body.
 * isOpen means new network events can be admitted. Expiry/finish detach ingress;
 * stop also cancels continuations. A callback already invoked cannot be undone.
 * drain/finish include async persistence, with a 3s total wait bound. Check
 * saveError even when read() contains successful evidence.
 */
export function createPostReceiptCollector({
  page, attemptId, submittedText, topicId, onReceipt, classify, readJson, operation = 'post', targetId = null,
  requireTopic = true, log = () => {}, receiptTimeoutMs = 15_000, signal,
}) {
  const context = page.context();
  const requests = new Map();
  const pending = new Set();
  const drainDeadlines = new Set();
  const events = [];
  let begun = false, open = true, cancelled = false, expired = false, manual = false;
  let accepted = null, latest = null, saveError = null;
  let sequence = 0, latestSequence = -1, timer = null, finishing = null;
  let releaseCancellation;
  const cancellation = new Promise(resolve => { releaseCancellation = resolve; });

  function clearDeadline() {
    if (timer !== null) clearTimeout(timer);
    timer = null;
  }

  function detachIngress() {
    open = false;
    clearDeadline();
    context.off('request', onRequest);
    context.off('response', onResponse);
    requests.clear();
  }

  function stop() {
    if (cancelled) return;
    cancelled = true;
    detachIngress();
    page.off('close', stop);
    context.off('close', stop);
    signal?.removeEventListener('abort', stop);
    for (const deadline of drainDeadlines) clearTimeout(deadline);
    drainDeadlines.clear();
    pending.clear();
    releaseCancellation();
  }

  function record(path, httpStatus, payload, kind, message) {
    if (cancelled) return;
    const rawCode = payload?.error_code ?? payload?.code ?? payload?.data?.error_code;
    // Only numeric business codes are safe to log. Free-form server values and
    // exception/classifier messages may echo text, cookies or captcha fields.
    const code = /^(?:\d{1,20})$/.test(String(rawCode ?? '')) ? String(rawCode) : null;
    const event = { attemptId, path, httpStatus, code, kind, message: message.slice(0, 160) };
    events.push(event);
    try { log({ ...event }); } catch { /* Logging must not discard receipt evidence. */ }
  }

  function onRequest(request) {
    if (!open || !begun || cancelled) return;
    let path;
    try {
      const url = new URL(request.url());
      if (url.hostname !== 'weibo.com' || request.method() !== 'POST') return;
      if (request.frame().page() !== page) return;
      path = url.pathname;
      if (!(operation === 'repost' ? path === '/ajax/statuses/repost' : operation === 'comment' ? /^\/ajax\/comments\/(create|add)$/.test(path) : POST_PATH.test(path))) {
        // A route change must be diagnosable without storing bodies/queries.
        // Never accept an unfamiliar POST as proof of publishing.
        if (/publish|create|update|stopic|statuses/.test(path)) record(path.replace(/[a-z0-9_-]{25,}/ig, '[id]'), null, null, 'unknown', 'Unrecognized publish-like request path');
        return;
      }
    } catch { return; }
    if (requests.has(request)) return;
    // Reserve order synchronously, before reading any possibly async body.
    const entry = { sequence: ++sequence, path, responded: false, body: null };
    requests.set(request, entry);
    let body;
    try { body = request.postData(); } catch { body = null; }
    entry.body = Promise.resolve(body)
      .then(raw => {
        let ownership;
        if (operation === 'repost') {
          let fields; try { const json = JSON.parse(raw); fields = key => json?.[key]; }
          catch { const form = new URLSearchParams(raw || ''); fields = key => form.get(key); }
          const text = fields('status') ?? fields('text');
          const sameText = submittedText ? text === submittedText : ['', '转发微博', undefined, null].includes(text);
          const sameTarget = String(fields('id') || '') === String(targetId);
          ownership = { owned: sameTarget && sameText, trusted: sameTarget && sameText };
        } else ownership = inspectBody(raw, submittedText, topicId, operation === 'comment' ? String(targetId) : null, requireTopic);
        if (!ownership.trusted) record(path, null, null, 'unknown', ownership.owned ? 'Request fields unavailable' : 'Request body does not match current composer');
        return ownership;
      })
      .catch(() => ({ owned: true, trusted: false }));
  }

  async function collect(response, entry) {
    const ownership = await entry.body;
    if (cancelled || !ownership.owned) return;
    let payload = null, result = { kind: 'unknown' }, httpStatus = null;
    let diagnostic = ownership.trusted ? 'Response classified' : 'Request body could not be verified';
    try { httpStatus = response.status(); } catch { /* Keep unknown HTTP status. */ }
    try {
      payload = await readJson(response);
      if (cancelled) return;
      if (ownership.trusted) {
        result = await classify(payload, response.ok());
        if (!result || typeof result !== 'object' || typeof result.kind !== 'string') result = { kind: 'unknown' };
        if (result.kind === 'succeeded') {
          const id = result.id == null ? '' : String(result.id).trim();
          result = id || result.explicitSuccess ? { ...result, id: id || null } : { kind: 'unknown' };
        }
      }
    } catch {
      result = { kind: 'unknown' };
      diagnostic = 'Response could not be read or classified';
    }
    if (cancelled) return;
    const observed = { response, payload, result };
    if (entry.sequence >= latestSequence) {
      latestSequence = entry.sequence;
      latest = observed;
    }
    // kind is supplied by an injected classifier: don't log arbitrary strings.
    const kind = ['succeeded', 'failed', 'unknown', 'verification', 'muted', 'frequent'].includes(result.kind)
      ? result.kind : 'unknown';
    record(entry.path, httpStatus, payload, kind, safeHint(payload, submittedText, diagnostic));
    if (result.kind !== 'succeeded' || accepted || cancelled) return;
    // Preserve the proof before awaiting persistence and reserve the callback
    // exactly once, even when a second success arrives during the save.
    accepted = observed;
    const receiptUrl = result.id && operation !== 'comment' ? `https://weibo.com/detail/${encodeURIComponent(result.id)}` : null;
    try {
      await onReceipt({ state: 'succeeded', receiptId: result.id || null, receiptUrl,
        url: receiptUrl, attemptId, successSource: 'api_receipt', error: '' });
    } catch (error) {
      saveError = error;
      record(entry.path, httpStatus, payload, 'succeeded', 'Receipt persistence failed');
    }
  }

  function onResponse(response) {
    if (!open || cancelled) return;
    let request;
    try { request = response.request(); } catch { return; }
    const entry = requests.get(request);
    if (!entry || entry.responded) return;
    entry.responded = true;
    const work = collect(response, entry);
    pending.add(work);
    // Both handlers avoid an unhandled rejection even for malformed fake/API
    // objects. Successful receipt persistence has its own saveError handling.
    void work.then(() => pending.delete(work), () => pending.delete(work));
  }

  function begin() {
    if (begun || !open || cancelled) return;
    begun = true;
    if (manual) return;
    const duration = Number(receiptTimeoutMs);
    timer = setTimeout(() => {
      expired = true;
      // Pending reads retain their entry and can still commit a receipt.
      detachIngress();
    }, Number.isFinite(duration) ? Math.max(0, duration) : 15_000);
    timer.unref?.();
  }

  const read = () => accepted || latest;

  async function drain() {
    const current = [...pending];
    if (!current.length || cancelled) return read();
    let deadline;
    try {
      await Promise.race([
        Promise.allSettled(current), cancellation,
        new Promise(resolve => {
          deadline = setTimeout(resolve, DRAIN_TIMEOUT_MS);
          drainDeadlines.add(deadline);
        }),
      ]);
    } finally {
      clearTimeout(deadline);
      drainDeadlines.delete(deadline);
    }
    return read();
  }

  function finish() {
    if (!finishing) {
      detachIngress();
      finishing = (async () => {
        try { return await drain(); }
        finally { stop(); }
      })();
    }
    return finishing;
  }

  function handoff() {
    if (cancelled) return;
    manual = true;
    clearDeadline();
    // A captcha body may finish parsing just after the automatic deadline.
    // Explicit manual ownership can reopen ingress for its automatic retry;
    // stop()/finish() remain terminal and cannot be reopened.
    if (!open) {
      open = true; expired = false;
      context.on('request', onRequest);
      context.on('response', onResponse);
    }
  }

  // Install synchronously: begin gates request admission, not subscription.
  context.on('request', onRequest);
  context.on('response', onResponse);
  page.on('close', stop);
  context.on('close', stop);
  signal?.addEventListener('abort', stop, { once: true });
  if (signal?.aborted) stop();

  return {
    begin, read, events, drain, finish, stop, handoff,
    // Replay eligibility is stricter than recognizing a challenge: a later
    // or unreadable submit must not inherit the earlier rejection.
    get soleResponse() { return sequence === 1 && !pending.size && latestSequence === 1 ? latest : null; },
    get accepted() { return accepted; },
    get latest() { return latest; },
    get saveError() { return saveError; },
    get expired() { return expired; },
    get isOpen() { return open; },
    get requestObserved() { return sequence > 0; },
  };
}
