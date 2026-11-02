import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import test, { after, before } from 'node:test';
import { chromium } from 'playwright';
import {
  createCommentSuccessNoticeObserver,
  createPostSuccessNoticeObserver,
} from '../src/post-success-notice.js';

let browser;
before(async () => {
  const chrome = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
  browser = await chromium.launch({ headless: true,
    ...(existsSync(chrome) ? { executablePath: chrome } : {}) });
});
after(async () => { await browser?.close(); });

const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const deferred = () => {
  let resolve;
  const promise = new Promise(yes => { resolve = yes; });
  return { promise, resolve };
};
async function until(check) {
  const deadline = Date.now() + 2500;
  while (!check()) {
    assert.ok(Date.now() < deadline, 'automatic callback did not arrive');
    await pause(20);
  }
}
async function fixture(t, html = '', options = {}) {
  const context = await browser.newContext({ serviceWorkers: 'block', offline: true });
  await context.route('**/*', route => route.abort());
  const page = await context.newPage();
  await page.setContent(`<main id="fixture">${html}</main>`);
  const receipts = [];
  const { kind = 'post', ...observerOptions } = options;
  const create = kind === 'comment' ? createCommentSuccessNoticeObserver : createPostSuccessNoticeObserver;
  const observer = await create(page, {
    attemptId: 'attempt-1', onSuccess: async receipt => { receipts.push(receipt); }, ...observerOptions,
  });
  t.after(async () => { await observer.stop(); await context.close(); });
  return { page, observer, receipts };
}
async function append(page, html) {
  await page.evaluate(html => document.querySelector('#fixture').insertAdjacentHTML('beforeend', html), html);
}
function receipt(attemptId = 'attempt-1') {
  return { state: 'succeeded', successSource: 'page_notice', attemptId,
    receiptId: null, receiptUrl: null, url: null, error: '' };
}

test('installs at creation; begin refreshes the baseline and is idempotent', async t => {
  const f = await fixture(t, '<div role="status">发布成功</div>');
  assert.equal((await f.observer.read()).accepted, false);
  await append(f.page, '<div class="toast">发送成功</div>');
  await f.observer.begin();
  assert.equal((await f.observer.read()).accepted, false);
  await append(f.page, '<div role="alert">发布成功！</div>');
  await f.observer.begin();
  const state = await f.observer.read();
  assert.equal(state.accepted, true);
  assert.equal(state.begun, true);
  assert.equal(state.saveError, null);
  assert.deepEqual(state.receipt, receipt());
  assert.deepEqual(f.receipts, [receipt()]);
});

test('automatically saves a delayed manual-captcha success without read or a live caller', async t => {
  const f = await fixture(t);
  await f.observer.begin();
  await assert.rejects(async () => { throw Object.assign(new Error('captcha handoff'), { code: 'verification' }); });
  await pause(220);
  await append(f.page, '<div class="woo-toast"><span>发送成功。</span></div>');
  await until(() => f.receipts.length === 1);
  assert.deepEqual(f.receipts, [receipt()]);
});

test('matches only complete success phrases in eligible notice regions', async t => {
  const f = await fixture(t);
  await f.observer.begin();
  for (const text of ['未发布成功', '未发送成功', '发布成功了吗', '发布成功，但审核失败',
    '正文包含发送成功', '发送成功率高', '发布成功?', '发送失败', 'not 发布成功', '发布成功取消']) {
    await append(f.page, `<div role="alert">${text}</div>`);
    assert.equal((await f.observer.read()).accepted, false, text);
  }
  await append(f.page, '<div class="ant-message"><span> \n 发送成功 ！ 。 \n </span></div>');
  assert.equal((await f.observer.read()).accepted, true);
});

test('accepts role status/alert and toast/message/notice classes independently', async t => {
  for (const attributes of ['role="alert"', 'role="status"', 'class="toast"',
    'class="woo-message"', 'class="Notice_content"']) {
    const f = await fixture(t);
    await f.observer.begin();
    await append(f.page, `<div ${attributes}>发布成功</div>`);
    assert.equal((await f.observer.read()).accepted, true, attributes);
  }
});

test('ignores article, post body, inputs, editors and ordinary modal body', async t => {
  const f = await fixture(t);
  await f.observer.begin();
  for (const html of [
    '<p>发布成功</p>', '<article><div class="toast" role="alert">发布成功</div></article>',
    '<div role="article"><div role="status">发送成功</div></div>',
    '<div class="post-content"><div class="message">发布成功</div></div>',
    '<div node-type="feed_list_content"><span class="notice">发送成功</span></div>',
    '<textarea class="toast">发布成功</textarea>', '<input class="toast" value="发送成功">',
    '<div contenteditable="true"><div role="alert">发布成功</div></div>',
    '<div role="textbox" class="message">发送成功</div>',
    '<div class="rich-editor"><div role="status">发布成功</div></div>',
    '<div role="status"><textarea>发布成功</textarea></div>',
    '<div class="woo-modal-wrap">发布成功</div>',
    '<div class="woo-modal-wrap"><p class="message">发送成功</p></div>',
  ]) {
    await append(f.page, html);
    assert.equal((await f.observer.read()).accepted, false, html);
  }
  await append(f.page, '<div class="woo-modal-wrap"><div role="alert">发布成功！</div></div>');
  assert.equal((await f.observer.read()).accepted, true);
});

test('requires visibility of the region and every ancestor', async t => {
  for (const hidden of ['hidden', 'aria-hidden="true"', 'style="display:none"',
    'style="visibility:hidden"', 'style="opacity:0"', 'style="content-visibility:hidden"']) {
    for (const own of [true, false]) {
      const html = own ? `<div id="hidden" role="alert" ${hidden}>发布成功</div>`
        : `<section id="hidden" ${hidden}><div role="alert" style="visibility:visible">发送成功</div></section>`;
      const f = await fixture(t);
      await f.observer.begin();
      await append(f.page, html);
      assert.equal((await f.observer.read()).accepted, false, `${own}: ${hidden}`);
      await f.page.evaluate(() => {
        const node = document.querySelector('#hidden');
        node.removeAttribute('hidden'); node.removeAttribute('aria-hidden'); node.removeAttribute('style');
      });
      assert.equal((await f.observer.read()).accepted, true, `${own}: ${hidden}`);
    }
  }
});

test('old visible notices are not new when moved or removed and reinserted', async t => {
  const f = await fixture(t, '<div id="old" class="toast">发布成功</div><section id="target"></section>');
  await f.observer.begin();
  await f.page.evaluate(() => document.querySelector('#target').append(document.querySelector('#old')));
  assert.equal((await f.observer.read()).accepted, false);
  await f.page.evaluate(() => { window.detachedNotice = document.querySelector('#old'); window.detachedNotice.remove(); });
  assert.equal((await f.observer.read()).accepted, false);
  await f.page.evaluate(() => document.querySelector('#fixture').append(window.detachedNotice));
  assert.equal((await f.observer.read()).accepted, false);
  await append(f.page, '<div class="toast">发送成功</div>');
  assert.equal((await f.observer.read()).accepted, true);
});

test('wrapping or unwrapping an old notice does not create new successful evidence', async t => {
  const f = await fixture(t, '<div id="old" class="toast"><span>发布成功</span></div>');
  await f.observer.begin();
  await f.page.evaluate(() => {
    const wrapper = document.createElement('div'); wrapper.className = 'notice-container';
    document.body.append(wrapper); wrapper.append(document.querySelector('#old'));
  });
  assert.equal((await f.observer.read()).accepted, false);
  await f.page.evaluate(() => {
    const old = document.querySelector('#old');
    const wrapper = document.createElement('div'); wrapper.setAttribute('role', 'status');
    document.body.append(wrapper); wrapper.append(old.firstChild); old.remove();
  });
  assert.equal((await f.observer.read()).accepted, false);
  await append(f.page, '<div class="toast">发布成功</div>');
  assert.equal((await f.observer.read()).accepted, true);
});

test('accepts a baseline notice only after hide/show or text changes to success', async t => {
  for (const transition of ['self', 'ancestor', 'text', 'characterData']) {
    const f = await fixture(t, '<section id="parent"><div id="old" class="toast">发布成功</div></section>');
    await f.observer.begin();
    await f.page.evaluate(transition => {
      const node = document.querySelector('#old');
      if (transition === 'self') node.hidden = true;
      else if (transition === 'ancestor') node.parentElement.style.display = 'none';
      else if (transition === 'characterData') node.firstChild.data = '正在发送';
      else node.textContent = '正在发送';
    }, transition);
    assert.equal((await f.observer.read()).accepted, false);
    await f.page.evaluate(transition => {
      const node = document.querySelector('#old');
      if (transition === 'self') node.hidden = false;
      else if (transition === 'ancestor') node.parentElement.style.display = '';
      else if (transition === 'characterData') node.firstChild.data = '发送成功';
      else node.textContent = '发送成功';
    }, transition);
    assert.equal((await f.observer.read()).accepted, true, transition);
  }
});

test('recognizes hide/show and text-to-success transitions batched in one DOM task', async t => {
  for (const transition of ['hidden', 'style', 'ancestor', 'aria-hidden', 'characterData', 'textContent', 'nestedText']) {
    const f = await fixture(t, '<section id="parent"><div id="old" class="toast"><span>发布成功</span></div></section>');
    await f.observer.begin();
    await f.page.evaluate(transition => {
      const node = document.querySelector('#old');
      if (transition === 'hidden') { node.hidden = true; node.hidden = false; }
      else if (transition === 'style') { node.style.opacity = '0'; node.style.opacity = ''; }
      else if (transition === 'ancestor') {
        node.parentElement.style.display = 'none'; node.parentElement.style.display = '';
      } else if (transition === 'aria-hidden') {
        node.setAttribute('aria-hidden', 'true'); node.removeAttribute('aria-hidden');
      } else if (transition === 'characterData') {
        node.firstChild.firstChild.data = '正在发送'; node.firstChild.firstChild.data = '发布成功';
      } else {
        const target = transition === 'nestedText' ? node.firstChild : node;
        target.textContent = '正在发送'; target.textContent = '发布成功';
      }
    }, transition);
    assert.equal((await f.observer.read()).accepted, true, transition);
  }
});

test('punctuation, whitespace and unrelated attribute changes do not refresh a baseline success', async t => {
  const f = await fixture(t, '<div id="old" class="toast"><span>发布成功</span></div>');
  await f.observer.begin();
  await f.page.evaluate(() => {
    const node = document.querySelector('#old');
    node.classList.add('active'); node.style.color = 'red';
    node.firstChild.firstChild.data = ' 发布成功！ ';
    node.firstChild.textContent = '\n发布成功。\n';
  });
  assert.equal((await f.observer.read()).accepted, false);
});

test('latches a short lived notice before the next Node poll', async t => {
  const f = await fixture(t);
  await f.observer.begin();
  await f.page.evaluate(async () => {
    const node = document.createElement('div'); node.className = 'toast'; node.textContent = '发布成功';
    document.body.append(node);
    await new Promise(resolve => setTimeout(resolve, 0));
    node.remove();
  });
  await until(() => f.receipts.length === 1);
});

test('reserves one callback while asynchronous persistence is pending', async t => {
  const saved = deferred(); let calls = 0;
  const f = await fixture(t, '', { onSuccess: async () => { calls++; await saved.promise; } });
  await f.observer.begin();
  await append(f.page, '<div class="toast">发布成功</div>');
  await until(() => calls === 1);
  await append(f.page, '<div class="toast">发送成功</div>');
  const reading = f.observer.read();
  await pause(130);
  assert.equal(calls, 1);
  saved.resolve();
  assert.equal((await reading).accepted, true);
  assert.equal((await f.observer.read()).accepted, true);
  assert.equal(calls, 1);
});

test('automatic persistence rejection is retained and read throws a stable coded error', async t => {
  const cause = new Error('fixture write failed'); let calls = 0;
  const f = await fixture(t, '', { onSuccess: async () => { calls++; throw cause; } });
  await f.observer.begin();
  await append(f.page, '<div role="alert">发送成功</div>');
  await until(() => calls === 1);
  for (let i = 0; i < 2; i++) await assert.rejects(f.observer.read(), error => {
    assert.equal(error.code, 'receipt_persistence_failed');
    assert.equal(error.cause, cause);
    assert.equal(error.accepted, true);
    assert.deepEqual(error.receipt, receipt());
    return true;
  });
  await f.observer.stop();
  await assert.rejects(f.observer.read(), { code: 'receipt_persistence_failed' });
  assert.equal(calls, 1);
});

test('stop is idempotent, removes page state and listeners, and prevents late callbacks', async t => {
  const f = await fixture(t);
  const baseListeners = f.page.listenerCount('close') - 1;
  await f.observer.begin();
  await append(f.page, '<div class="toast">发布成功</div>');
  await Promise.all([f.observer.stop(), f.observer.stop()]);
  await f.observer.begin();
  await append(f.page, '<div class="toast">发送成功</div>');
  await pause(160);
  assert.equal(f.receipts.length, 0);
  assert.equal(f.page.listenerCount('close'), baseListeners);
  assert.equal((await f.observer.read()).stopped, true);
  assert.equal(await f.page.evaluate(() => '__xianZaiPostSuccessNoticeObserver' in window), false);
});

test('page close cleans up without leaking rejected work or calling persistence', async t => {
  const f = await fixture(t);
  await f.observer.begin();
  await f.page.close();
  await f.observer.stop();
  assert.equal((await f.observer.read()).stopped, true);
  assert.equal(f.page.listenerCount('close'), 0);
  assert.equal(f.receipts.length, 0);
});

test('replacement on the same page fences old attempts and old stop cannot disconnect the new observer', async t => {
  const f = await fixture(t);
  await f.observer.begin();
  await append(f.page, '<div class="toast">发布成功</div>');
  const newerReceipts = [];
  const newer = await createPostSuccessNoticeObserver(f.page, {
    attemptId: 'attempt-2', onSuccess: async value => newerReceipts.push(value),
  });
  t.after(() => newer.stop());
  await newer.begin();
  await f.observer.stop();
  assert.equal((await newer.read()).accepted, false);
  await append(f.page, '<div role="status">发送成功</div>');
  await until(() => newerReceipts.length === 1);
  assert.deepEqual(newerReceipts, [receipt('attempt-2')]);
  assert.equal(f.receipts.length, 0);
  assert.equal((await f.observer.read()).stopped, true);
});

test('polling failures are observable through read instead of becoming unhandled rejections', async t => {
  const f = await fixture(t);
  await f.observer.begin();
  await f.page.evaluate(() => {
    window.__xianZaiPostSuccessNoticeObserver.stop();
    delete window.__xianZaiPostSuccessNoticeObserver;
  });
  await pause(220);
  await assert.rejects(f.observer.read(), { code: 'notice_observation_failed' });
  assert.equal(f.receipts.length, 0);
});

test('an old in-flight browser read cannot persist after a new attempt takes ownership', async t => {
  const f = await fixture(t);
  await f.observer.begin();
  const entered = deferred(), release = deferred();
  const evaluate = f.page.evaluate.bind(f.page);
  let block = true;
  f.page.evaluate = async (fn, args) => {
    const value = await evaluate(fn, args);
    if (block && fn.toString().includes('return state.read()')) {
      block = false; entered.resolve(); await release.promise;
    }
    return value;
  };
  t.after(() => release.resolve());
  await append(f.page, '<div class="toast">发布成功</div>');
  const oldRead = f.observer.read();
  await entered.promise;
  const values = [];
  const newer = await createPostSuccessNoticeObserver(f.page, {
    attemptId: 'attempt-2', onSuccess: async value => values.push(value),
  });
  t.after(() => newer.stop());
  await newer.begin();
  release.resolve();
  assert.equal((await oldRead).accepted, false);
  assert.equal(f.receipts.length, 0);
  await append(f.page, '<div class="toast">发送成功</div>');
  await until(() => values.length === 1);
  assert.deepEqual(values, [receipt('attempt-2')]);
});

test('stop waits for an already invoked persistence callback and never invokes another', async t => {
  const entered = deferred(), release = deferred(); let calls = 0;
  const f = await fixture(t, '', { onSuccess: async () => {
    calls++; entered.resolve(); await release.promise;
  } });
  t.after(() => release.resolve());
  await f.observer.begin();
  await append(f.page, '<div class="toast">发布成功</div>');
  await entered.promise;
  let finished = false;
  const stopping = f.observer.stop().then(() => { finished = true; });
  await pause(120);
  assert.equal(finished, false);
  release.resolve();
  await stopping;
  assert.equal((await f.observer.read()).accepted, true);
  assert.equal(calls, 1);
});

test('replacement waits for a previously started stop and persistence to settle', async t => {
  const entered = deferred(), release = deferred();
  const order = [];
  const f = await fixture(t, '', { onSuccess: async () => {
    entered.resolve(); await release.promise; order.push('old-saved');
  } });
  t.after(() => release.resolve());
  await f.observer.begin();
  await append(f.page, '<div class="toast">发布成功</div>');
  await entered.promise;
  const stopping = f.observer.stop();
  let installed = false;
  const replacing = createPostSuccessNoticeObserver(f.page, {
    attemptId: 'attempt-2', onSuccess: async () => { order.push('new-saved'); },
  }).then(value => { installed = true; return value; });
  // Release first even if this assertion fails, so a failed test cannot hang cleanup.
  await pause(120);
  const installedBeforeRelease = installed;
  release.resolve();
  const newer = await replacing;
  t.after(() => newer.stop());
  await stopping;
  assert.equal(installedBeforeRelease, false);
  await newer.begin();
  await append(f.page, '<div class="toast">发送成功</div>');
  await until(() => order.length === 2);
  assert.deepEqual(order, ['old-saved', 'new-saved']);
});

test('uses no exposed binding/function and leaves no polling after stop', async t => {
  const f = await fixture(t);
  f.page.exposeBinding = f.page.exposeFunction = () => { throw new Error('Bindings are forbidden'); };
  let evaluations = 0;
  const evaluate = f.page.evaluate.bind(f.page);
  f.page.evaluate = (...args) => { evaluations++; return evaluate(...args); };
  const values = [];
  const newer = await createPostSuccessNoticeObserver(f.page, {
    attemptId: 'attempt-2', onSuccess: async value => values.push(value),
  });
  t.after(() => newer.stop());
  await newer.begin();
  await append(f.page, '<div class="toast">发送成功</div>');
  await until(() => values.length === 1);
  await newer.stop();
  const baseline = evaluations;
  await pause(220);
  assert.equal(evaluations, baseline);
  assert.equal((await newer.read()).accepted, true);
  assert.equal(await evaluate(() => '__xianZaiPostSuccessNoticeObserver' in window), false);
});

test('comment: accepts a new complete 评论成功 toast and saves the page_notice receipt', async t => {
  const f = await fixture(t, '', { kind: 'comment' });
  await f.observer.begin();
  await append(f.page, '<div class="woo-toast"><span>评论成功。</span></div>');
  const state = await f.observer.read();
  assert.equal(state.accepted, true);
  assert.deepEqual(state.receipt, receipt());
  assert.equal(state.receipt.successSource, 'page_notice');
  assert.equal(state.receipt.receiptId, null);
  assert.equal(state.receipt.receiptUrl, null);
  assert.deepEqual(f.receipts, [receipt()]);
});

test('comment: a residual 评论成功 notice present before begin is not new evidence', async t => {
  const f = await fixture(t, '<div class="toast">评论成功</div>', { kind: 'comment' });
  await f.observer.begin();
  assert.equal((await f.observer.read()).accepted, false);
  await f.page.evaluate(() => document.querySelector('.toast').remove());
  assert.equal((await f.observer.read()).accepted, false);
  await append(f.page, '<div role="alert">评论成功</div>');
  assert.equal((await f.observer.read()).accepted, true);
});

test('comment: body/editor text containing 评论成功 is not a success notice', async t => {
  const f = await fixture(t, '', { kind: 'comment' });
  await f.observer.begin();
  for (const html of [
    '<p>评论成功</p>',
    '<article><div class="message">评论成功</div></article>',
    '<div class="post-content"><div class="toast">评论成功</div></div>',
    '<div class="WB_text">评论成功</div>',
    '<textarea class="toast">评论成功</textarea>',
    '<div contenteditable="true"><div role="alert">评论成功</div></div>',
  ]) {
    await append(f.page, html);
    assert.equal((await f.observer.read()).accepted, false, html);
  }
  await append(f.page, '<div class="ant-message">评论成功</div>');
  assert.equal((await f.observer.read()).accepted, true);
});

test('comment: post success toasts do not satisfy a comment attempt', async t => {
  const f = await fixture(t, '', { kind: 'comment' });
  await f.observer.begin();
  for (const text of ['发布成功', '发送成功', '发布成功！', '发送成功。']) {
    await append(f.page, `<div class="toast">${text}</div>`);
    assert.equal((await f.observer.read()).accepted, false, text);
  }
  await append(f.page, '<div class="toast">评论成功</div>');
  assert.equal((await f.observer.read()).accepted, true);
});

test('comment: captcha/verification success messages are not comment success', async t => {
  const f = await fixture(t, '', { kind: 'comment' });
  await f.observer.begin();
  for (const text of ['验证成功', '验证码校验成功', '短信验证码发送成功', '验证码已发送成功']) {
    await append(f.page, `<div role="status">${text}</div>`);
    assert.equal((await f.observer.read()).accepted, false, text);
  }
  await append(f.page, '<div role="status">评论成功</div>');
  assert.equal((await f.observer.read()).accepted, true);
});

test('comment: repeated toasts after acceptance invoke the persistence callback once', async t => {
  let calls = 0;
  const f = await fixture(t, '', { kind: 'comment', onSuccess: async () => { calls++; } });
  await f.observer.begin();
  await append(f.page, '<div class="toast">评论成功</div>');
  await until(() => calls === 1);
  await append(f.page, '<div class="toast">评论成功</div>');
  await append(f.page, '<div class="toast">发布成功</div>');
  await pause(180);
  assert.equal(calls, 1);
  assert.equal((await f.observer.read()).accepted, true);
});

test('comment: persistence failure uses comment copy and stays coded', async t => {
  const cause = new Error('fixture write failed');
  const f = await fixture(t, '', { kind: 'comment', onSuccess: async () => { throw cause; } });
  await f.observer.begin();
  await append(f.page, '<div class="toast">评论成功</div>');
  await assert.rejects(f.observer.read(), error => {
    assert.equal(error.code, 'receipt_persistence_failed');
    assert.equal(error.message, '评论成功回执保存异常，禁止重新评论');
    assert.equal(error.cause, cause);
    assert.equal(error.accepted, true);
    assert.deepEqual(error.receipt, receipt());
    return true;
  });
});
