import assert from 'node:assert/strict';
import test from 'node:test';

const {
  NavigationUnavailableError, isNavigationError, safeNavigationUrl, gotoChecked
} = await import('../src/navigation.js');
const { WeiboAdapter, VerificationError } = await import('../src/weibo-adapter.js');

const response = status => ({ status: () => status });
const snapshot = (overrides = {}) => ({
  readyState: 'complete',
  title: '微博',
  text: '首页 微博 我的',
  textLength: 8,
  htmlLength: 4096,
  body: true,
  hasConfig: true,
  uid: '1234567890',
  loginForm: false,
  challengeHint: false,
  ...overrides
});

function makePage({ url = 'https://weibo.com/', state = snapshot(), goto, close } = {}) {
  let current = url;
  return {
    closed: false,
    gotos: [],
    closes: 0,
    url: () => current,
    isClosed() { return this.closed; },
    async evaluate() { return state; },
    async goto(target, options) {
      this.gotos.push(target);
      if (goto) return goto(target, options, this);
      current = target;
      return response(200);
    },
    async close() { this.closed = true; this.closes += 1; close?.(); },
    frames: () => []
  };
}

function challengeFrame() {
  const locator = selector => {
    const visible = /geetest_panel|iframe\[src\*="captcha"\]|yidun_modal/.test(selector);
    const handle = {
      filter() { return handle; },
      count: async () => (visible ? 1 : 0),
      nth() { return handle; },
      isVisible: async () => visible
    };
    return handle;
  };
  return {
    locator,
    getByText: () => locator('text'),
    getByRole: () => locator('role')
  };
}

function challengePage() {
  const page = makePage({ state: snapshot({ hasConfig: false, uid: '', challengeHint: true }) });
  page.frames = () => [challengeFrame()];
  page.locator = selector => challengeFrame().locator(selector);
  return page;
}

function contextWith(pages = []) {
  return {
    pages: () => pages,
    newPageCalls: 0,
    closeCalls: 0,
    async newPage() { this.newPageCalls += 1; const page = makePage(); pages.push(page); return page; },
    async close() { this.closeCalls += 1; }
  };
}

function managerFor({ owner = 'runner', context = null, accountId = null, generation = 1 } = {}) {
  return {
    owner,
    context,
    accountId,
    generation,
    opens: [],
    async open(account, requestedOwner) {
      this.opens.push({ accountId: account?.id, owner: requestedOwner });
      this.owner = requestedOwner;
      this.accountId = account?.id ?? null;
      this.generation += 1;
      this.context = contextWith();
      return this.context;
    }
  };
}

test('safeNavigationUrl 只保留 origin+pathname，去掉 query/hash/userinfo', () => {
  assert.equal(safeNavigationUrl('https://weibo.com/p/100808abc?token=secret#frag'), 'https://weibo.com/p/100808abc');
  assert.equal(safeNavigationUrl('https://user:pass@weibo.com/a?b=1'), 'https://weibo.com/a');
  assert.equal(safeNavigationUrl('about:blank'), 'about:blank');
  assert.equal(safeNavigationUrl('not a url'), null);
});

test('gotoChecked 把 HTTP >= 400 转成脱敏的 NavigationUnavailableError', async () => {
  const page = makePage({ goto: async () => response(403) });
  await assert.rejects(
    () => gotoChecked(page, 'https://weibo.com/p/100808abc?token=secret', { stage: 'topic' }),
    error => {
      assert.ok(error instanceof NavigationUnavailableError);
      assert.equal(error.code, 'navigation_unavailable');
      assert.equal(error.stage, 'topic');
      assert.equal(error.httpStatus, 403);
      assert.equal(error.navigationUrl, 'https://weibo.com/p/100808abc');
      assert.ok(!error.message.includes('secret'));
      assert.ok(!error.message.includes('?token'));
      assert.equal(isNavigationError(error), true);
      return true;
    }
  );
});

test('gotoChecked 包装 ERR_FAILED / ERR_INVALID_RESPONSE / ERR_HTTP_RESPONSE_CODE_FAILURE / TimeoutError', async () => {
  for (const [name, message, netCode] of [
    ['Error', 'page.goto: net::ERR_FAILED at https://weibo.com/x?t=1', 'ERR_FAILED'],
    ['Error', 'page.goto: net::ERR_INVALID_RESPONSE at https://weibo.com/x', 'ERR_INVALID_RESPONSE'],
    ['Error', 'page.goto: net::ERR_HTTP_RESPONSE_CODE_FAILURE at https://weibo.com/x', 'ERR_HTTP_RESPONSE_CODE_FAILURE'],
    ['TimeoutError', 'page.goto: Timeout 30000ms exceeded.', 'TimeoutError']
  ]) {
    const error = new Error(message); error.name = name;
    const page = makePage({ goto: async () => { throw error; } });
    await assert.rejects(() => gotoChecked(page, 'https://weibo.com/x?t=1'),
      caught => {
        assert.ok(caught instanceof NavigationUnavailableError);
        assert.equal(caught.netCode, netCode);
        assert.ok(!caught.message.includes('?t=1'));
        return true;
      });
  }
});

test('gotoChecked 原样上抛断网错误，未知异常也不吞', async () => {
  const offline = new Error('page.goto: net::ERR_INTERNET_DISCONNECTED at https://weibo.com/');
  await assert.rejects(
    () => gotoChecked(makePage({ goto: async () => { throw offline; } }), 'https://weibo.com/'),
    error => error === offline
  );
  const proxy = new Error('page.goto: net::ERR_PROXY_CONNECTION_FAILED at https://weibo.com/');
  await assert.rejects(
    () => gotoChecked(makePage({ goto: async () => { throw proxy; } }), 'https://weibo.com/'),
    error => error === proxy
  );
  const unknown = new Error('some renderer bug');
  await assert.rejects(
    () => gotoChecked(makePage({ goto: async () => { throw unknown; } }), 'https://weibo.com/'),
    error => error === unknown
  );
});

test('gotoChecked 正常 200 返回 response', async () => {
  const page = makePage();
  const result = await gotoChecked(page, 'https://weibo.com/');
  assert.equal(result.status(), 200);
  assert.deepEqual(page.gotos, ['https://weibo.com/']);
});

test('readIdentity 把 about:blank / chrome-error 识别成 NavigationUnavailableError', async () => {
  const adapter = new WeiboAdapter({});
  for (const url of ['about:blank', 'chrome-error://chromewebdata/', '']) {
    await assert.rejects(
      () => adapter.readIdentity({ url: () => url, evaluate: async () => null }),
      error => isNavigationError(error) && error.netCode === 'PAGE_UNLOADED'
    );
  }
});

test('readIdentity 保留 passport 登录跳转为 invalid，验证码不算登出', async () => {
  const adapter = new WeiboAdapter({});
  const passport = { url: () => 'https://passport.weibo.com/sso/signin?entry=miniblog', evaluate: async () => { throw new Error('should not evaluate'); } };
  assert.deepEqual(await adapter.readIdentity(passport), { status: 'invalid' });

  await assert.rejects(
    () => adapter.readIdentity(challengePage()),
    error => error instanceof VerificationError
  );
});

test('readIdentity 正常页面返回有效身份', async () => {
  const adapter = new WeiboAdapter({});
  const page = makePage({ state: snapshot({ uid: '1234', nickname: '昵称' }) });
  const identity = await adapter.readIdentity(page);
  assert.equal(identity.status, 'valid');
  assert.equal(identity.uid, '1234');
  assert.equal(identity.nickname, '昵称');
});

test('readIdentity 不把未识别的 200 业务页当作登出', async () => {
  const adapter = new WeiboAdapter({});
  await assert.rejects(
    () => adapter.readIdentity(makePage({ state: snapshot({ hasConfig: false, uid: '' }) })),
    error => isNavigationError(error) && error.netCode === 'PAGE_NOT_RECOGNIZED'
  );
});

test('probeNavigation 拒绝非 weibo.com 的 https 目标，避免 SSRF', async () => {
  const adapter = new WeiboAdapter(managerFor());
  for (const url of ['http://weibo.com/', 'https://example.com/', 'https://weibo.com.evil.test/', 'https://user:pass@weibo.com/', 'https://weibo.com:8443/']) {
    const result = await adapter.probeNavigation({ id: 'a1', uid: '1234' }, { url });
    assert.equal(result.state, 'unavailable');
    assert.equal(result.netCode, 'PROBE_URL_REJECTED');
  }
});

test('probeNavigation login owner 一律 busy', async () => {
  const adapter = new WeiboAdapter(managerFor({ owner: 'login' }));
  assert.equal((await adapter.probeNavigation({ id: 'a1' }, {})).state, 'busy');
});

test('probeNavigation manual owner 只读检查既有匹配页面，ready 后不导航不关闭', async () => {
  const page = makePage({ state: snapshot({ uid: '1234' }) });
  const context = contextWith([page]);
  const manager = managerFor({ owner: 'manual', context, accountId: 'a1' });
  const adapter = new WeiboAdapter(manager);
  const result = await adapter.probeNavigation({ id: 'a1', uid: '1234' }, { url: 'https://weibo.com/?from=recovery' });
  assert.equal(result.state, 'ready');
  assert.deepEqual(page.gotos, []);
  assert.equal(context.newPageCalls, 0);
  assert.equal(page.closes, 0);
  assert.equal(context.closeCalls, 0);
});

test('probeNavigation manual owner URL 不匹配返回 busy，UID 不匹配返回 authentication', async () => {
  const otherPage = makePage({ url: 'https://weibo.com/p/100808other' });
  const context = contextWith([otherPage]);
  const manager = managerFor({ owner: 'manual', context, accountId: 'a1' });
  const adapter = new WeiboAdapter(manager);
  assert.equal((await adapter.probeNavigation({ id: 'a1', uid: '1234' }, { url: 'https://weibo.com/' })).state, 'busy');
  assert.deepEqual(otherPage.gotos, []);

  const page = makePage({ state: snapshot({ uid: '9999' }) });
  const context2 = contextWith([page]);
  const manager2 = managerFor({ owner: 'manual', context: context2, accountId: 'a1' });
  const adapter2 = new WeiboAdapter(manager2);
  assert.equal((await adapter2.probeNavigation({ id: 'a1', uid: '1234' }, {})).state, 'authentication');
  assert.deepEqual(page.gotos, []);
});

test('probeNavigation manual owner 的验证码页面返回 verification', async () => {
  const page = challengePage();
  const context = contextWith([page]);
  const adapter = new WeiboAdapter(managerFor({ owner: 'manual', context, accountId: 'a1' }));
  assert.equal((await adapter.probeNavigation({ id: 'a1', uid: '1234' }, {})).state, 'verification');
  assert.equal(context.newPageCalls, 0);
  assert.equal(page.closes, 0);
});

test('probeNavigation runner 无 context 时 open runner、临时 page 只读加载并关闭', async () => {
  const manager = managerFor({ owner: null, context: null, accountId: null });
  const adapter = new WeiboAdapter(manager);
  const result = await adapter.probeNavigation({ id: 'a1', uid: '1234567890' }, {});
  assert.equal(result.state, 'ready');
  assert.deepEqual(manager.opens, [{ accountId: 'a1', owner: 'runner' }]);
  const temp = manager.context.pages()[0];
  assert.deepEqual(temp.gotos, ['https://weibo.com/']);
  assert.equal(temp.closed, true);
  assert.equal(manager.context.closeCalls, 0);
});

test('probeNavigation runner 账号不匹配返回 busy，不新建 page', async () => {
  const context = contextWith([makePage()]);
  const manager = managerFor({ owner: 'runner', context, accountId: 'b2' });
  const adapter = new WeiboAdapter(manager);
  const result = await adapter.probeNavigation({ id: 'a1', uid: '1234' }, {});
  assert.equal(result.state, 'busy');
  assert.equal(context.newPageCalls, 0);
});

test('probeNavigation 把断网识别为 unavailable + netCode，不加 ready', async () => {
  const manager = managerFor({ owner: 'runner', context: contextWith(), accountId: 'a1', generation: 3 });
  manager.context.newPage = async function newPage() {
    this.newPageCalls += 1;
    const page = makePage({ goto: async () => { throw new Error('page.goto: net::ERR_INTERNET_DISCONNECTED at https://weibo.com/'); } });
    return page;
  };
  const adapter = new WeiboAdapter(manager);
  const result = await adapter.probeNavigation({ id: 'a1', uid: '1234' }, {});
  assert.equal(result.state, 'unavailable');
  assert.equal(result.netCode, 'ERR_INTERNET_DISCONNECTED');
});

test('probeNavigation 把 HTTP 403 识别为 unavailable + httpStatus', async () => {
  const context = contextWith();
  context.newPage = async function newPage() {
    this.newPageCalls += 1;
    return makePage({ goto: async () => response(403) });
  };
  const adapter = new WeiboAdapter(managerFor({ owner: 'runner', context, accountId: 'a1' }));
  const result = await adapter.probeNavigation({ id: 'a1', uid: '1234' }, {});
  assert.equal(result.state, 'unavailable');
  assert.equal(result.httpStatus, 403);
});

test('probeNavigation 不把 about:blank / 空 200 页面判 ready', async () => {
  for (const state of [null, snapshot({ body: false }), snapshot({ textLength: 0 }), snapshot({ hasConfig: false, uid: '' })]) {
    const context = contextWith();
    context.newPage = async function newPage() {
      this.newPageCalls += 1;
      return makePage({ state, goto: async () => response(200) });
    };
    const adapter = new WeiboAdapter(managerFor({ owner: 'runner', context, accountId: 'a1' }));
    const result = await adapter.probeNavigation({ id: 'a1', uid: '1234' }, {});
    assert.notEqual(result.state, 'ready');
    assert.equal(result.state, 'unavailable');
  }
});

test('probeNavigation 识别登录页 authentication 与挑战页 verification', async () => {
  const authPage = makePage({ state: snapshot({ hasConfig: false, uid: '', loginForm: true }) });
  const authContext = contextWith();
  authContext.newPage = async function newPage() { this.newPageCalls += 1; return authPage; };
  const adapter = new WeiboAdapter(managerFor({ owner: 'runner', context: authContext, accountId: 'a1' }));
  assert.equal((await adapter.probeNavigation({ id: 'a1', uid: '1234' }, {})).state, 'authentication');

  const verifyPage = challengePage();
  const verifyContext = contextWith();
  verifyContext.newPage = async function newPage() { this.newPageCalls += 1; return verifyPage; };
  const adapter2 = new WeiboAdapter(managerFor({ owner: 'runner', context: verifyContext, accountId: 'a1' }));
  assert.equal((await adapter2.probeNavigation({ id: 'a1', uid: '1234' }, {})).state, 'verification');
});

test('probeNavigation AbortSignal 关闭临时 page 但不关 context', async () => {
  const context = contextWith();
  let temp;
  context.newPage = async function newPage() {
    this.newPageCalls += 1;
    temp = makePage({ goto: () => new Promise(() => {}) });
    return temp;
  };
  const adapter = new WeiboAdapter(managerFor({ owner: 'runner', context, accountId: 'a1' }));
  const controller = new AbortController();
  const pending = adapter.probeNavigation({ id: 'a1', uid: '1234' }, { signal: controller.signal });
  while (!temp) await new Promise(resolve => setTimeout(resolve, 5));
  controller.abort();
  const result = await pending;
  assert.equal(result.state, 'unavailable');
  assert.equal(result.netCode, 'PROBE_CANCELLED');
  assert.equal(temp.closed, true);
  assert.equal(context.closeCalls, 0);
});

test('probeNavigation 不把重定向到健康首页当作故障超话已恢复', async () => {
  const p = makePage();
  p.goto = async () => response(200); // URL stays home while probing a topic.
  const context = contextWith([p]); context.newPage = async () => p;
  const adapter = new WeiboAdapter(managerFor({ context, accountId: 'a1' }));
  const result = await adapter.probeNavigation({ id: 'a1', uid: '1234567890' }, { url: 'https://weibo.com/p/missing' });
  assert.equal(result.state, 'unavailable'); assert.equal(result.netCode, 'PROBE_UNEXPECTED_REDIRECT');
});

test('gotoChecked 抛错仍保留可观察主文档状态，不记录子资源状态或敏感URL', async () => {
  let listener, detached = false;
  const main = {};
  const page = { mainFrame: () => main, on: (_event, fn) => { listener = fn; }, off: (_event, fn) => { detached = fn === listener; },
    goto: async () => {
      listener({ request: () => ({ isNavigationRequest: () => true }), frame: () => main, status: () => 503 });
      throw new Error('net::ERR_HTTP_RESPONSE_CODE_FAILURE https://weibo.com/?token=secret');
    } };
  await assert.rejects(() => gotoChecked(page, 'https://weibo.com/?token=secret'), error => error.httpStatus === 503 && !error.message.includes('secret'));
  assert.equal(detached, true);
});

test('probeNavigation 在 DOMContentLoaded 未完成但 $CONFIG 可用时判 ready', async () => {
  const page = makePage({ state: snapshot({ readyState: 'loading', hasConfig: true, uid: '1234' }) });
  const context = { pages: () => [page], newPageCalls: 0, async newPage() { this.newPageCalls += 1; return page; }, async close() {} };
  const manager = managerFor({ owner: null, context: null, accountId: null });
  manager.open = async () => { manager.owner = 'runner'; manager.accountId = 'a1'; manager.generation += 1; manager.context = context; return context; };
  const adapter = new WeiboAdapter(manager);
  const result = await adapter.probeNavigation({ id: 'a1', uid: '1234' }, {});
  assert.equal(result.state, 'ready');
});

test('probeNavigation 把 HTTP 418 作为限流状态返回', async () => {
  const page = makePage({ goto: async () => response(418) });
  const context = { pages: () => [page], newPageCalls: 0, async newPage() { this.newPageCalls += 1; return page; }, async close() {} };
  const manager = managerFor({ owner: null, context: null, accountId: null });
  manager.open = async () => { manager.owner = 'runner'; manager.accountId = 'a1'; manager.generation += 1; manager.context = context; return context; };
  const adapter = new WeiboAdapter(manager);
  const result = await adapter.probeNavigation({ id: 'a1', uid: '1234' }, {});
  assert.equal(result.state, 'unavailable');
  assert.equal(result.httpStatus, 418);
});
