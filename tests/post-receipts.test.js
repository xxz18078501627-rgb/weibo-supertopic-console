import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';
import { createPostReceiptCollector } from '../src/post-receipts.js';

const deferred = () => {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};
const flush = () => new Promise(resolve => setImmediate(resolve));
const success = { ok: 1, data: { idstr: '5359413485371450' } };
const failure = { ok: 0, message: 'rejected' };
const classify = (payload, httpOk) => httpOk && payload?.ok === 1
  ? { kind: 'succeeded', id: payload.data?.idstr }
  : payload?.ok === 0 ? { kind: 'failed', reason: payload.message } : { kind: 'unknown' };

function fixture(t, options = {}) {
  const context = new EventEmitter();
  const page = new EventEmitter();
  page.context = () => context;
  const receipts = [], logs = [];
  const collector = createPostReceiptCollector({
    page, attemptId: 'attempt-1', submittedText: 'my post', topicId: 'topic-1',
    classify, readJson: response => response.json(),
    onReceipt: receipt => receipts.push(receipt), log: event => logs.push(event), ...options,
  });
  t.after(() => collector.stop());
  const request = ({ url = 'https://weibo.com/ajax/statuses/update', method = 'POST',
    owner = page, body = JSON.stringify({ status: 'my post', page_id: 'topic-1' }) } = {}) => ({
    url: () => url, method: () => method, frame: () => ({ page: () => owner }),
    postData: () => body,
  });
  const response = (req, payload = success, status = 200) => ({
    request: () => req, url: () => req.url(), ok: () => status >= 200 && status < 300,
    status: () => status, json: () => Promise.resolve(payload),
  });
  const send = (req = request(), payload = success, status = 200) => {
    context.emit('request', req);
    const res = response(req, payload, status);
    context.emit('response', res);
    return res;
  };
  return { collector, context, page, receipts, logs, request, response, send };
}

test('subscribes synchronously, but only a new request after begin belongs to this attempt', async t => {
  const f = fixture(t);
  assert.equal(f.context.listenerCount('request'), 1);
  assert.equal(f.context.listenerCount('response'), 1);
  const previous = f.request();
  f.context.emit('request', previous);
  f.collector.begin();
  f.context.emit('response', f.response(previous));
  // A response from a request that was never observed must not be admitted.
  f.context.emit('response', f.response(f.request()));
  await f.collector.drain();
  assert.equal(f.collector.read(), null);
  assert.equal(f.collector.requestObserved, false);
  const res = f.send();
  assert.equal(f.collector.requestObserved, true);
  const entry = await f.collector.finish();
  assert.equal(entry.response, res);
  assert.equal(entry.payload, success);
  assert.equal(entry.result.kind, 'succeeded');
  assert.deepEqual(f.receipts, [{
    state: 'succeeded', receiptId: success.data.idstr,
    receiptUrl: `https://weibo.com/detail/${success.data.idstr}`,
    url: `https://weibo.com/detail/${success.data.idstr}`, attemptId: 'attempt-1', successSource: 'api_receipt', error: '',
  }]);
});

test('rejects other pages, hosts, methods, paths, texts and conflicting topic fields', async t => {
  const f = fixture(t);
  f.collector.begin();
  for (const options of [
    { owner: new EventEmitter() }, { owner: null },
    { url: 'https://evil.example/ajax/statuses/update' },
    { url: 'https://weibo.com.evil.example/ajax/statuses/update' },
    { url: 'https://www.weibo.com/ajax/statuses/update' },
    { url: 'https://weibo.com/ajax/statuses/update/extra' },
    { url: 'https://weibo.com/ajax/statuses/destroy' }, { url: 'invalid' }, { method: 'GET' },
    { body: JSON.stringify({ text: 'another post' }) },
    { body: JSON.stringify({ status: 'my post', text: 'another post' }) },
    { body: JSON.stringify({ status: 'my post', page_id: 'topic-2' }) },
    { body: JSON.stringify({ status: 'my post', topic_id: 'topic-2' }) },
    { body: JSON.stringify({ status: 'my post', page_id: 'topic-1', topic_id: 'topic-2' }) },
    { body: 'text=my+post&topic_id=topic-1&topic_id=topic-2' },
  ]) f.send(f.request(options));
  await f.collector.drain();
  assert.equal(f.collector.read(), null);
  assert.equal(f.receipts.length, 0);
});

test('accepts JSON and form fields with trimmed text on every allowed route', async t => {
  for (const family of ['statuses', 'stopic']) for (const action of ['update', 'create', 'add']) {
    for (const field of ['status', 'text', 'content']) {
      const f = fixture(t);
      f.collector.begin();
      f.send(f.request({ url: `https://weibo.com/ajax/${family}/${action}?source=fixture`,
        body: field === 'status' ? JSON.stringify({ [field]: '  my post\n', topic_id: 'topic-1' })
          : new URLSearchParams({ [field]: ' my post ', page_id: 'topic-1' }).toString() }));
      await f.collector.finish();
      assert.equal(f.receipts.length, 1, `${family}/${action}/${field}`);
    }
  }
});

test('accepts the observed 1022 supertopic wrapper but still rejects another topic', async t => {
  const topicId = '10080819a5137ac9109462f670e39aaf64b1a0';
  for (const encoded of [false, true]) {
    const f = fixture(t, { topicId });
    f.collector.begin();
    const body = encoded ? new URLSearchParams({ content: 'my post', topic_id: `1022:${topicId}` }).toString()
      : JSON.stringify({ content: 'my post', topic_id: `1022:${topicId}` });
    f.send(f.request({ body }));
    await f.collector.finish();
    assert.equal(f.receipts.length, 1);
  }
  const f = fixture(t, { topicId }); f.collector.begin();
  for (const topic of ['1022:100808another', `1023:${topicId}`, `prefix:${topicId}`]) {
    f.send(f.request({ body: JSON.stringify({ content: 'my post', topic_id: topic }) }));
  }
  await f.collector.finish(); assert.equal(f.receipts.length, 0);
});

test('missing or unparseable body is unknown, even when response claims success', async t => {
  for (const body of [null, '', '{broken', 'nonsense', 'null', '[]', '{"topic_id":"topic-1"}', '{"text":12}']) {
    const f = fixture(t);
    f.collector.begin();
    f.send(f.request({ body }));
    await f.collector.finish();
    assert.equal(f.collector.accepted, null);
    assert.equal(f.collector.read().result.kind, 'unknown');
    assert.equal(f.receipts.length, 0);
    assert.ok(f.collector.events.some(event => event.kind === 'unknown'));
  }
});

test('request sequence, not asynchronous body or response parsing order, defines latest', async t => {
  const f = fixture(t);
  const olderBody = deferred(), olderPayload = deferred();
  f.collector.begin();
  const older = f.request({ body: olderBody.promise });
  f.context.emit('request', older);
  f.context.emit('response', f.response(older, olderPayload.promise));
  const newer = f.send(f.request(), { ok: 0, message: 'newer' });
  await flush();
  assert.equal(f.collector.latest.response, newer);
  olderBody.resolve('{"text":"my post"}');
  olderPayload.resolve({ ok: 0, message: 'older' });
  await f.collector.finish();
  assert.equal(f.collector.latest.response, newer);
  assert.equal(f.collector.latest.result.reason, 'newer');
});

test('delayed success survives earlier failure and later failures never overwrite accepted', async t => {
  const f = fixture(t), delayed = deferred();
  f.collector.begin();
  const good = f.send(f.request(), delayed.promise);
  const bad = f.send(f.request(), failure);
  await flush();
  assert.equal(f.collector.read().response, bad);
  delayed.resolve(success);
  await f.collector.drain();
  assert.equal(f.collector.read().response, good);
  assert.equal(f.collector.latest.response, bad);
  f.send(f.request(), failure);
  f.send(f.request(), success);
  // The same response/request must not be processed twice.
  f.context.emit('response', good);
  await f.collector.finish();
  assert.equal(f.collector.accepted.response, good);
  assert.equal(f.receipts.length, 1);
});

test('zero unrelated posting interval has no effect; begin has an independent 15 second deadline', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const f = fixture(t, { intervalSeconds: 0 });
  t.mock.timers.tick(60_000);
  assert.equal(f.collector.expired, false); // Construction does not start the clock.
  f.collector.begin();
  t.mock.timers.tick(14_999);
  f.collector.begin(); // Idempotent; cannot reset the deadline.
  assert.equal(f.collector.isOpen, true);
  t.mock.timers.tick(1);
  assert.equal(f.collector.expired, true);
  assert.equal(f.collector.isOpen, false);
  f.send();
  await f.collector.drain();
  assert.equal(f.receipts.length, 0);
});

test('expiry detaches new events but lets an admitted pending response save', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const f = fixture(t, { receiptTimeoutMs: 20 }), body = deferred();
  f.collector.begin();
  f.send(f.request(), body.promise);
  t.mock.timers.tick(20);
  assert.equal(f.collector.expired, true);
  assert.equal(f.context.listenerCount('request'), 0);
  assert.equal(f.context.listenerCount('response'), 0);
  body.resolve(success);
  await f.collector.drain();
  assert.equal(f.receipts.length, 1);
  assert.ok(f.collector.accepted);
});

test('finish stops new events and waits for pending parsing and asynchronous persistence', async t => {
  const body = deferred(), saved = deferred();
  let callbackCount = 0;
  const f = fixture(t, { onReceipt: async () => { callbackCount++; await saved.promise; } });
  f.collector.begin();
  f.send(f.request(), body.promise);
  const finishing = f.collector.finish();
  let finished = false;
  void finishing.then(() => { finished = true; });
  assert.equal(f.collector.isOpen, false);
  f.send();
  body.resolve(success);
  await flush();
  assert.equal(callbackCount, 1);
  assert.equal(finished, false);
  saved.resolve();
  const entry = await finishing;
  assert.equal(entry.result.kind, 'succeeded');
  assert.equal(await f.collector.finish(), entry);
  assert.equal(f.page.listenerCount('close'), 0);
  assert.equal(f.context.listenerCount('close'), 0);
});

test('stop cancels pending work, removes every listener, and cannot be reopened', async t => {
  const body = deferred(), controller = new AbortController();
  let abortAdds = 0, abortRemoves = 0;
  const signal = {
    get aborted() { return controller.signal.aborted; },
    addEventListener(...args) { abortAdds++; controller.signal.addEventListener(...args); },
    removeEventListener(...args) { abortRemoves++; controller.signal.removeEventListener(...args); },
  };
  const f = fixture(t, { signal });
  f.collector.begin();
  f.send(f.request(), body.promise);
  f.collector.stop();
  f.collector.stop();
  f.collector.begin();
  f.collector.handoff();
  body.resolve(success);
  await flush();
  assert.equal(f.collector.isOpen, false);
  assert.equal(f.collector.accepted, null);
  assert.equal(f.receipts.length, 0);
  assert.equal(f.collector.events.length, 0);
  for (const event of ['request', 'response', 'close']) assert.equal(f.context.listenerCount(event), 0);
  assert.equal(f.page.listenerCount('close'), 0);
  assert.equal(abortAdds, 1);
  assert.equal(abortRemoves, 1);
});

test('abort, page close and context close cancel late callbacks', async t => {
  for (const reason of ['abort', 'page', 'context', 'already-aborted']) {
    const controller = new AbortController(), body = deferred();
    if (reason === 'already-aborted') controller.abort();
    const f = fixture(t, { signal: controller.signal });
    f.collector.begin();
    f.send(f.request(), body.promise);
    if (reason === 'abort') controller.abort();
    if (reason === 'page') f.page.emit('close');
    if (reason === 'context') f.context.emit('close');
    body.resolve(success);
    await flush();
    assert.equal(f.receipts.length, 0, reason);
    assert.equal(f.collector.isOpen, false, reason);
    assert.equal(f.context.listenerCount('response'), 0, reason);
  }
});

test('handoff keeps the same attempt alive past the automatic deadline until stop', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const f = fixture(t, { receiptTimeoutMs: 10 });
  f.collector.begin();
  f.collector.handoff();
  f.collector.handoff();
  t.mock.timers.tick(60_000);
  assert.equal(f.collector.isOpen, true);
  assert.equal(f.collector.expired, false);
  f.send();
  await f.collector.drain();
  assert.equal(f.receipts[0].attemptId, 'attempt-1');
  f.collector.stop();
  assert.equal(f.collector.isOpen, false);
});

test('handoff before begin preserves the request gate and disables the future deadline', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const f = fixture(t, { receiptTimeoutMs: 10 });
  f.collector.handoff();
  const previous = f.request();
  f.context.emit('request', previous);
  f.collector.begin();
  f.context.emit('response', f.response(previous));
  t.mock.timers.tick(60_000);
  await f.collector.drain();
  assert.equal(f.collector.read(), null);
  assert.equal(f.collector.isOpen, true);
  f.send();
  await f.collector.finish();
  assert.equal(f.receipts.length, 1);
});

test('stop also cancels asynchronous request ownership and classification continuations', async t => {
  for (const stage of ['body', 'classify']) {
    const delayed = deferred();
    const f = fixture(t, stage === 'classify' ? { classify: () => delayed.promise } : {});
    f.collector.begin();
    f.send(f.request(stage === 'body' ? { body: delayed.promise } : {}));
    await flush();
    f.collector.stop();
    delayed.resolve(stage === 'body' ? '{"text":"my post"}' : { kind: 'succeeded', id: success.data.idstr });
    await flush();
    assert.equal(f.collector.accepted, null, stage);
    assert.equal(f.receipts.length, 0, stage);
    assert.equal(f.collector.events.length, 0, stage);
  }
});

test('stop after expiry cancels admitted pending work and wakes an active drain', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const f = fixture(t, { receiptTimeoutMs: 10 }), body = deferred();
  f.collector.begin();
  f.send(f.request(), body.promise);
  const draining = f.collector.drain();
  t.mock.timers.tick(10);
  assert.equal(f.collector.expired, true);
  f.collector.stop();
  await draining;
  body.resolve(success);
  await flush();
  assert.equal(f.receipts.length, 0);
  assert.equal(f.collector.accepted, null);
});

test('drain has a total 3 second bound even if a reader never settles', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const f = fixture(t), stuck = deferred();
  f.collector.begin();
  f.send(f.request(), stuck.promise);
  let settled = false;
  const draining = f.collector.drain().then(() => { settled = true; });
  t.mock.timers.tick(2_999);
  await flush();
  assert.equal(settled, false);
  t.mock.timers.tick(1);
  await draining;
  assert.equal(settled, true);
  // A drain timeout alone does not cancel a response; finish closes the attempt.
  const finishing = f.collector.finish();
  t.mock.timers.tick(3_000);
  await finishing;
  stuck.resolve(success);
  await flush();
  assert.equal(f.receipts.length, 0);
});

test('async or synchronous persistence errors retain accepted evidence and surface saveError', async t => {
  for (const asynchronous of [true, false]) {
    const error = new Error('database unavailable');
    let calls = 0;
    const f = fixture(t, { onReceipt: () => {
      calls++;
      if (asynchronous) return Promise.reject(error);
      throw error;
    } });
    f.collector.begin();
    f.send();
    f.send();
    const entry = await f.collector.finish();
    assert.equal(entry.result.kind, 'succeeded');
    assert.equal(f.collector.accepted, entry);
    assert.equal(f.collector.saveError, error);
    assert.equal(calls, 1);
  }
});

test('reader/classifier errors and success without an id remain unknown', async t => {
  for (const options of [
    { readJson: async () => { throw new Error('private body'); } },
    { classify: () => { throw new Error('private body'); } },
    { classify: () => ({ kind: 'succeeded' }) },
  ]) {
    const f = fixture(t, options);
    f.collector.begin();
    f.send();
    await f.collector.finish();
    assert.equal(f.collector.read().result.kind, 'unknown');
    assert.equal(f.collector.accepted, null);
    assert.equal(f.receipts.length, 0);
  }
});

test('passes actual HTTP success to classify and logs only safe bounded metadata', async t => {
  const secret = 'body-secret cookie-secret challenge-secret';
  const f = fixture(t, {
    submittedText: secret,
    classify: (payload, httpOk) => { assert.equal(httpOk, false); return { kind: 'failed', reason: secret.repeat(30) }; },
  });
  f.collector.begin();
  f.send(f.request({ url: 'https://weibo.com/ajax/statuses/update?cookie=cookie-secret',
    body: JSON.stringify({ status: secret }) }),
  { ok: 0, code: 'body-secret', message: secret, validate: { challenge: secret } }, 400);
  await f.collector.finish();
  assert.ok(f.logs.length);
  const safeKeys = ['attemptId', 'path', 'httpStatus', 'code', 'kind', 'message'];
  for (const entry of f.logs) {
    assert.ok(Object.keys(entry).every(key => safeKeys.includes(key)));
    assert.ok((entry.message?.length || 0) <= 160);
    assert.equal(entry.attemptId, 'attempt-1');
    assert.equal(entry.path, '/ajax/statuses/update');
  }
  assert.doesNotMatch(JSON.stringify(f.logs), /body-secret|cookie-secret|challenge-secret/);
});

test('keeps short platform error hints without persisting an echoed post body', async t => {
  const f = fixture(t, { submittedText: '苏新皓[超话]我的原文', classify: () => ({ kind: 'failed' }) });
  f.collector.begin();
  f.send(f.request({ body: JSON.stringify({ status: '苏新皓[超话]我的原文' }) }), { ok: 0, msg: '内容重复，请稍后再试：我的原文' }, 400);
  await f.collector.finish();
  assert.equal(f.logs[0].message, '内容重复，请稍后再试');
  assert.doesNotMatch(JSON.stringify(f.logs), /我的原文/);
});

test('accepts a publish-specific explicit success without inventing a detail URL', async t => {
  const f = fixture(t, { classify: () => ({ kind: 'succeeded', id: null, explicitSuccess: true }) });
  f.collector.begin(); f.send(); await f.collector.finish();
  assert.equal(f.receipts.length, 1);
  assert.equal(f.receipts[0].receiptId, null); assert.equal(f.receipts[0].receiptUrl, null);
  assert.equal(f.receipts[0].successSource, 'api_receipt');
});

test('normal/create publish route supports multipart with matching content and rejects another body', async t => {
  const f = fixture(t);
  f.collector.begin();
  const multipart = content => `--fixture-boundary\r\nContent-Disposition: form-data; name="content"\r\n\r\n${content}\r\n--fixture-boundary\r\nContent-Disposition: form-data; name="page_id"\r\n\r\ntopic-1\r\n--fixture-boundary--\r\n`;
  f.send(f.request({ url: 'https://weibo.com/ajax/statuses/normal/create', body: multipart('another post') }));
  await f.collector.drain(); assert.equal(f.receipts.length, 0);
  f.send(f.request({ url: 'https://weibo.com/ajax/statuses/normal/create', body: multipart('my post') }));
  await f.collector.finish(); assert.equal(f.receipts.length, 1);
});
