import { randomUUID } from 'node:crypto';

const owners = new WeakMap();
const STATE_KEY = '__xianZaiPostSuccessNoticeObserver';
const POLL_MS = 100;
const POST_PHRASES = ['发布成功', '发送成功'];
const COMMENT_PHRASES = ['评论成功'];

/**
 * One observer per Page. Await creation before presenting/submitting the form;
 * await begin() immediately before the actual submit. begin() refreshes the
 * baseline once. Automatic polling has no expiry, including during captcha
 * handoff, and never exposes a browser binding/function.
 *
 * read() waits for any admitted persistence and returns
 * { accepted, receipt, saveError: null, begun, stopped }. A failed save retains
 * accepted evidence and throws receipt_persistence_failed (cause, accepted,
 * receipt, needsReadback). Other observation failures throw
 * notice_observation_failed. Neither error is silently lost by the background
 * poll. stop() is terminal/idempotent and waits for a callback already invoked;
 * such a callback cannot be undone. Replacing an attempt fences pending reads
 * and waits for any already invoked old callback before installing the new one.
 */
export async function createPostSuccessNoticeObserver(page, { attemptId, onSuccess }) {
  return createSuccessNoticeObserver(page, {
    attemptId,
    onSuccess,
    phrases: POST_PHRASES,
    persistenceMessage: '发布成功回执保存异常，禁止重新发送',
  });
}

/**
 * Comment equivalent of createPostSuccessNoticeObserver. It only accepts the
 * complete 评论成功 phrase; post notices, comment body text and captcha/verify
 * success messages are not accepted. The receipt keeps the page_notice source
 * and the same shape as a post receipt (receiptId/receiptUrl stay null).
 */
export async function createCommentSuccessNoticeObserver(page, { attemptId, onSuccess }) {
  return createSuccessNoticeObserver(page, {
    attemptId,
    onSuccess,
    phrases: COMMENT_PHRASES,
    persistenceMessage: '评论成功回执保存异常，禁止重新评论',
  });
}

export async function createRepostSuccessNoticeObserver(page, { attemptId, onSuccess }) {
  return createSuccessNoticeObserver(page, { attemptId, onSuccess, phrases: ['转发成功'],
    persistenceMessage: '转发成功提示保存异常，禁止重新转发' });
}

async function createSuccessNoticeObserver(page, { attemptId, onSuccess, phrases, persistenceMessage }) {
  if (typeof onSuccess !== 'function') throw new TypeError('onSuccess must be a function');
  const token = randomUUID();
  const previous = owners.get(page);
  let begun = false, stopped = false, accepted = false;
  let receipt = null, saveError = null, observationError = null;
  let timer = null, beginPromise = null, stopPromise = null, inFlight = null, saving = null;
  const api = { begin, stop, read };
  owners.set(page, api);
  page.on('close', onClose);

  const current = () => !stopped && owners.get(page) === api;
  const closed = () => page.isClosed();
  function failedObservation(cause) {
    if (!observationError) observationError = Object.assign(
      new Error('Page success notice observation failed', { cause }),
      { code: 'notice_observation_failed' },
    );
  }
  function onClose() { void stop().catch(failedObservation); }

  async function removeBrowserObserver() {
    if (closed()) return;
    try {
      await page.evaluate(({ key, token }) => {
        const state = window[key];
        if (state?.token !== token) return;
        state.stop();
        delete window[key];
      }, { key: STATE_KEY, token });
    } catch (error) {
      if (!closed()) failedObservation(error);
    }
  }

  function stop() {
    if (stopPromise) return stopPromise;
    stopped = true;
    clearTimeout(timer);
    timer = null;
    page.off('close', onClose);
    stopPromise = (async () => {
      await removeBrowserObserver();
      await saving;
      // Keep this owner discoverable while a save is pending. Even a caller
      // concurrently starting stop() and a replacement must wait for that save.
      if (owners.get(page) === api) owners.delete(page);
    })();
    return stopPromise;
  }

  function schedule() {
    if (!current() || !begun || accepted || timer !== null) return;
    timer = setTimeout(() => {
      timer = null;
      void sample().then(schedule, error => {
        failedObservation(error);
        void stop().catch(failedObservation);
      });
    }, POLL_MS);
    timer.unref?.();
  }

  function sample() {
    if (inFlight) return inFlight;
    if (!current() || !begun || accepted) return Promise.resolve();
    const work = (async () => {
      let state;
      try {
        state = await page.evaluate(({ key, token }) => {
          const state = window[key];
          if (state?.token !== token) throw new Error('Notice observer was replaced or lost');
          return state.read();
        }, { key: STATE_KEY, token });
      } catch (error) {
        if (current() && !closed()) failedObservation(error);
        await stop();
        return;
      }
      // Re-check ownership AFTER the asynchronous browser round trip.
      if (!current() || !state.accepted || accepted) return;
      accepted = true;
      receipt = { state: 'succeeded', successSource: 'page_notice', attemptId,
        receiptId: null, receiptUrl: null, url: null, error: '' };
      saving = (async () => {
        try { await onSuccess({ ...receipt }); }
        catch (cause) {
          saveError = Object.assign(new Error(persistenceMessage, { cause }), {
            code: 'receipt_persistence_failed', accepted: true, receipt: { ...receipt }, needsReadback: true,
          });
        }
      })();
      await saving;
      await stop();
    })();
    inFlight = work;
    // Attach both handlers immediately, including when only the poll is running.
    void work.then(() => { inFlight = null; }, () => { inFlight = null; });
    return work;
  }

  function begin() {
    if (beginPromise) return beginPromise;
    if (!current()) return Promise.resolve();
    beginPromise = (async () => {
      try {
        await page.evaluate(({ key, token }) => {
          const state = window[key];
          if (state?.token !== token) throw new Error('Notice observer was replaced or lost');
          state.begin();
        }, { key: STATE_KEY, token });
        if (!current()) return;
        begun = true;
        schedule();
      } catch (error) {
        if (!current() || closed()) return;
        failedObservation(error);
        await stop();
        throw observationError;
      }
    })();
    return beginPromise;
  }

  async function read() {
    await beginPromise;
    await sample();
    await saving;
    if (saveError) throw saveError;
    if (observationError) throw observationError;
    return { accepted, receipt: receipt && { ...receipt }, saveError: null, begun, stopped };
  }

  try {
    await previous?.stop();
    if (!current()) return api;
    await page.evaluate(({ key, token, phrases }) => {
      window[key]?.stop();
      const selector = '[role="alert"], [role="status"], [class*="toast" i], [class*="message" i], [class*="notice" i]';
      const forbidden = 'article, [role="article"], textarea, input, select, option, '
        + '[role="textbox"], [contenteditable]:not([contenteditable="false"]), '
        + '[class*="editor" i], .post-content, .post-body, .WB_text, [class*="Feed_body"], '
        + '[node-type="feed_list_content"], [data-testid="post-content"], [data-testid="tweetText"], '
        + 'blockquote, script, style, template, noscript';
      const known = new WeakMap();
      const knownText = new WeakMap();
      let active = false, accepted = false, disposed = false, failed = false;

      function eligible(node) {
        if (node.closest(forbidden) || node.querySelector(forbidden)) return false;
        if (!node.closest('.woo-modal-wrap')) return true;
        // A modal's ordinary message/body is not a toast. Explicit live regions
        // and UI toast/message components are still allowed inside the modal.
        return node.matches('[role="alert"], [role="status"]') || [...node.classList].some(name =>
          /^(?:toast(?:[-_].*)?|(?:woo|ant|el|van|ivu|arco)[-_](?:toast|message|notice)(?:[-_].*)?)$/i.test(name));
      }

      function visible(node) {
        for (let parent = node; parent; parent = parent.parentElement) {
          const style = getComputedStyle(parent);
          if (parent.hidden || parent.getAttribute('aria-hidden')?.toLowerCase() === 'true'
            || style.display === 'none' || ['hidden', 'collapse'].includes(style.visibility)
            || style.contentVisibility === 'hidden' || Number(style.opacity) === 0) return false;
        }
        return [...node.getClientRects()].some(rect => rect.width > 0 && rect.height > 0);
      }

      const phrasePattern = new RegExp(
        `^(${phrases.map(value => value.replace(/[\\^$.*+?()[\]{}|]/g, '\\$&')).join('|')})[。.!！]*$`,
        'u',
      );

      function phrase(text) {
        text = text.replace(/\s+/gu, '');
        return phrasePattern.exec(text)?.[1] || null;
      }

      function hiddenBefore(record) {
        if (record.attributeName === 'hidden') return record.oldValue !== null;
        if (record.attributeName === 'aria-hidden') return record.oldValue?.toLowerCase() === 'true';
        if (record.attributeName !== 'style' || !record.oldValue) return false;
        const style = document.createElement('span').style;
        style.cssText = record.oldValue;
        return style.display === 'none' || ['hidden', 'collapse'].includes(style.visibility)
          || style.contentVisibility === 'hidden' || (style.opacity !== '' && Number(style.opacity) === 0);
      }

      function replacedText(root, target, replacement) {
        if (root === target) return replacement;
        if (root.nodeType === Node.TEXT_NODE) return root.data;
        return [...root.childNodes].map(child => replacedText(child, target, replacement)).join('');
      }

      function textNodes(root) {
        const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
        const nodes = [];
        while (walker.nextNode()) {
          if (walker.currentNode.data.replace(/[\s。.!！]/gu, '')) nodes.push(walker.currentNode);
        }
        return nodes;
      }

      function transitions(records) {
        if (!active || !records.length) return;
        const candidates = [...document.querySelectorAll(selector)];
        for (const record of records) {
          // Attribute/characterData old values retain a hide/show or text
          // replacement even when both happened in the same JavaScript task.
          if (record.type === 'attributes' && hiddenBefore(record)) {
            for (const node of candidates) {
              const before = known.get(node);
              if (before && record.target.contains(node)) before.visible = false;
            }
          } else if (record.type === 'characterData' || record.type === 'childList') {
            let oldText;
            if (record.type === 'characterData') oldText = record.oldValue;
            else {
              // Only replay whole-content replacements. Child removal/movement
              // by itself must not invent a new notice.
              const children = [...record.target.childNodes];
              if (!record.removedNodes.length || !record.addedNodes.length
                || children.length !== record.addedNodes.length
                || !children.every((child, index) => child === record.addedNodes[index])) continue;
              oldText = [...record.removedNodes].map(node => node.textContent).join('');
            }
            for (const node of candidates) {
              const before = known.get(node);
              if (before?.phrase && node.contains(record.target)
                && phrase(replacedText(node, record.target, oldText)) !== before.phrase) before.phrase = null;
            }
          }
        }
      }

      function scan() {
        if (disposed || accepted) return;
        for (const node of document.querySelectorAll(selector)) {
          const before = known.get(node);
          const now = { visible: eligible(node) && visible(node), phrase: phrase(node.textContent) };
          const contents = textNodes(node);
          // A new container around the same old successful text is still the
          // old notice. This also covers unwrapping/moving its text children.
          const movedText = !before && contents.length > 0 && contents.every(text => {
            const previous = knownText.get(text);
            return previous?.visible && previous.phrase === now.phrase;
          });
          known.set(node, now);
          if (active && now.visible && now.phrase
            && !movedText && (!before || !before.visible || before.phrase !== now.phrase)) {
            accepted = true;
            observer.disconnect();
            return;
          }
          for (const text of contents) knownText.set(text, now);
        }
        // Keep detached nodes in the WeakMap. Moving/reinserting an existing
        // visible success region must not turn it into a new notice.
      }

      function changed(records) {
        if (disposed || accepted) return;
        try { transitions(records); scan(); }
        catch { failed = true; observer.disconnect(); }
      }
      const observer = new MutationObserver(changed);
      const state = {
        token,
        begin() {
          if (disposed || active) return;
          observer.takeRecords();
          scan(); // Everything currently visible is pre-submit baseline.
          active = true;
        },
        read() {
          changed(observer.takeRecords());
          if (failed) throw new Error('Notice DOM observation failed');
          return { accepted };
        },
        stop() { disposed = true; active = false; observer.disconnect(); observer.takeRecords(); },
      };
      window[key] = state;
      observer.observe(document.documentElement, {
        subtree: true, childList: true, characterData: true, characterDataOldValue: true,
        attributes: true, attributeOldValue: true,
      });
      scan();
    }, { key: STATE_KEY, token, phrases });
    // A close/replacement may have arrived while installation was in flight.
    if (!current()) await removeBrowserObserver();
  } catch (error) {
    await stop();
    throw error;
  }
  return api;
}
