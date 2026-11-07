import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import QRCode from 'qrcode';
import { createHash } from 'node:crypto';
import { taskProgress } from './task-progress.js';
import { recordView } from './record-view.js';
import { URL } from 'node:url';
import { config } from './config.js';
import { resolveBlacklist, resolveEngageSettings } from './engage-profile-resolver.js';
import {
  addCommentMaterials, addPostMaterials, addRepostMaterials, clearAccountRestrictions, clearAccountRestrictionsFromOpenJobs, createAccount, createTopic, deleteCommentMaterial, deleteCommentMaterials, deletePostMaterial, deletePostMaterials, deleteRepostMaterial, deleteRepostMaterials,
  deleteTopic, deleteTopics, deleteAccount, getAccount, getActiveJob, getJob, getSetting, listAccounts, listActionLogs, listCommentMaterials, listRepostMaterials, listMaterialGroups, createMaterialGroup, deleteMaterialGroup, renameMaterialGroup, setMaterialsGroup,
  listActiveAccountRestrictions, listJobs, listPostMaterials, listRecordsByShanghaiDate, listSystemLogs, listTopics, log, reorderAccounts, seedAccountRestrictionsFromJobs, setSetting, updateAccount, updateAccountAuth, updateTopic
} from './db.js';
import { BrowserManager, browserManager } from './browser.js';
import { createRunner } from './runner.js';
import { AccountLeases } from './account-leases.js';
import { WeiboAdapter } from './weibo-adapter.js';
import { parseCookies, randomToken, safeEqual, shanghaiDate } from './util.js';
import { LoginService } from './login-service.js';
import { DEFAULT_EMOJIS, normalizeTaskSettings, normalizeEngageSettings, engageTemplateConfig } from '../public/defaults.js';
import { listAccountGroups, saveAccountGroup, deleteAccountGroup, moveAccountsToGroup } from './account-groups.js';
import { dailySuccess, dailyStats, operationCounts, roundsForDate, listRoundReports, pendingRoundReports, acknowledgeRound, unnotifiedRounds } from './task-reports.js';
import { pruneDetailedRecords, isArchivedRecord, RETENTION_DAYS } from './retention.js';
import { FIXED_TOPIC, COMMENT_SECTIONS, isFixedTopic } from '../public/topic-policy.js';
import { currentLanAccess } from './lan-access.js';
import { activate as activateLicense, licenseEnabled, licenseStatus } from './license.js';
import { UpdateManager } from './update-manager.js';

if (config.topicMode === 'fixed') {
  const topic = listTopics().find(isFixedTopic);
  if (!topic) createTopic(FIXED_TOPIC);
  else if (!topic.enabled || topic.name !== FIXED_TOPIC.name || topic.url !== FIXED_TOPIC.url) updateTopic(topic.id, { ...topic, name: FIXED_TOPIC.name, url: FIXED_TOPIC.url, enabled: true });
}

fs.mkdirSync(config.dataDir, { recursive: true, mode: 0o700 });
const tokenPath = path.join(config.dataDir, 'access-token');
if (!licenseEnabled() && !fs.existsSync(tokenPath)) fs.writeFileSync(tokenPath, `${randomToken()}\n`, { mode: 0o600 });
// 激活后口令从激活码写入 data/access-token；按文件 mtime 热加载，无需重启。
let tokenStamp = -1;
let tokenValue = '';
function accessToken() {
  if (process.env.WEIBO_CONSOLE_ACCESS_TOKEN) return process.env.WEIBO_CONSOLE_ACCESS_TOKEN;
  const stat = fs.statSync(tokenPath, { throwIfNoEntry: false });
  if (!stat) { tokenValue = ''; tokenStamp = -1; return ''; }
  if (stat.mtimeMs !== tokenStamp) { tokenValue = fs.readFileSync(tokenPath, 'utf8').trim(); tokenStamp = stat.mtimeMs; }
  return tokenValue;
}
const sessions = new Set();
const sseClients = new Set();
const serviceIdentity = { pid: process.pid, startedAt: new Date().toISOString(), revision: createHash('sha256').update(
  ['server.js','runner.js','weibo-adapter.js','post-receipts.js','post-success-notice.js','db.js','task-reports.js','verification-workflow.js','network-recovery.js','task-progress.js','engage.js','account-leases.js','engage-profile-resolver.js'].map(file => fs.readFileSync(path.join(config.rootDir, 'src', file))).join('\n')
).digest('hex').slice(0, 16) };
const leases = new AccountLeases();
const runner = createRunner(browserManager, { scope: 'workbench', leases });
const engageBrowserManager = new BrowserManager(undefined, { headless: true, name: 'engage', visibleRunner: false });
const engageRunner = createRunner(engageBrowserManager, { scope: 'engage', leases });
const runners = [runner, engageRunner];
const packageVersion = JSON.parse(fs.readFileSync(path.join(config.rootDir, 'package.json'), 'utf8')).version;
const updateManager = new UpdateManager({
  rootDir: config.rootDir,
  dataDir: config.dataDir,
  currentVersion: packageVersion,
  idleCheck: async () => {
    if (loginService.active) return '请先完成或取消扫码登录';
    if (runner.promise || engageRunner.promise || runner.currentExecution || engageRunner.currentExecution) return '当前仍有浏览器操作，请在任务安全暂停后再更新';
    if (runner.workflow.session || engageRunner.workflow.session) return '请先结束当前人工验证会话';
    if (browserManager.status().busy || engageBrowserManager.status().busy) return '任务浏览器仍在使用，请稍后再更新';
    const work = getActiveJob('workbench'), engage = getActiveJob('engage');
    if (work?.status === 'running' || engage?.status === 'running') return '请先暂停工作台和转赞评任务';
    return null;
  }
});
const runnerFor = job => job?.scope === 'engage' || job?.config?.kind === 'engage' || job?.kind === 'engage' ? engageRunner : runner;
// QR login owns a separate visible Chromium manager.  Normal tasks remain
// headless and can keep running while a different account is being added.
const loginBrowserManager = new BrowserManager(undefined, { headless: false, name: 'login' });
const loginService = new LoginService(new WeiboAdapter(loginBrowserManager), loginBrowserManager);
let lastStopState = '';
let verificationVersion = 0;
let stateVersion = 0;
let nextNetworkProbe = 0;
const dailyStopTimer = setInterval(() => {
  try {
    for (const worker of runners) worker.enforceDailyStop();
    if (Date.now() >= nextNetworkProbe) {
      nextNetworkProbe = Date.now() + 5000;
      for (const worker of runners) {
        const current = worker.current();
        void worker.network.monitor(current).catch(error => log('warning', `连通性检查失败：${error.message}`, { jobId: current?.id }));
      }
    }
    const policy = runner.dailyStopStatus();
    const key = `${policy.deadlineAt}:${policy.blocked}`;
    if (key !== lastStopState) { lastStopState = key; broadcast('state', state()); }
  } catch (error) { log('error', `每日停止检查失败：${error.message}`); }
}, 1000);
dailyStopTimer.unref();

for (const worker of runners) {
worker.on('update', job => {
  broadcast('job', job);
  // A dedicated post-commit event lets the verification queue appear as soon
  // as an action records a challenge, without waiting for the next poll.
  broadcast('verification', { version: ++verificationVersion, scope: job.scope || 'workbench', verification: worker.workflow.status(getJob(job.id) || job) });
});
worker.on('round-completed', report => {
  broadcast('round-completed', report);
});
}
loginService.on('update', () => broadcast('state', state()));

function send(res, status, data, headers = {}) {
  const body = data == null ? '' : JSON.stringify(data);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(body), ...headers });
  res.end(body);
}

function error(res, err) {
  const status = err.statusCode || 500;
  if (status === 500) log('error', `接口处理异常${err.taskId ? `，任务 ${err.taskId}` : ''}：${err.stack || err.message}`);
  send(res, status, { error: status === 500 ? '服务器处理失败' : err.message, detail: status === 500 ? err.message : undefined });
}

function isAuthenticated(req) {
  const cookies = parseCookies(req.headers.cookie || '');
  return Boolean(cookies.wb_session && sessions.has(cookies.wb_session));
}

async function body(req) {
  let raw = '';
  for await (const chunk of req) {
    raw += chunk;
    if (raw.length > 2_000_000) throw Object.assign(new Error('请求内容过大'), { statusCode: 413 });
  }
  if (!raw) return {};
  try { return JSON.parse(raw); } catch { throw Object.assign(new Error('请求内容不是有效 JSON'), { statusCode: 400 }); }
}

function cleanTexts(input) {
  const texts = Array.isArray(input) ? input : [input];
  return [...new Set(texts.map(value => String(value || '').trim()).filter(Boolean))];
}

const TEMPLATE_FIELDS = ['actionPlan', 'segmentIds', 'rounds', 'roundIntervalSeconds', 'syncToHome', 'commentStrategy', 'commentSection', 'scanLimit', 'commentMaxCountEnabled', 'commentMaxCount', 'candidateRefreshSeconds', 'readRetryCount', 'postDecoration', 'commentDecoration', 'postGroupIds', 'commentGroupIds'];
function templateConfig(input = {}) {
  const picked = {};
  for (const key of TEMPLATE_FIELDS) if (input[key] !== undefined) picked[key] = input[key];
  return normalizeTaskSettings(picked);
}
function state() {
  const accounts = listAccounts().map(account => ({
    ...account,
    profile_dir: undefined,
    postMaterialCount: undefined
  }));
  const activeJob = getActiveJob('workbench');
  const engageJob = getActiveJob('engage');
  return {
    stateVersion: ++stateVersion,
    allowCustomTopics: config.topicMode === 'general',
    fixedTopic: config.topicMode === 'fixed' ? listTopics().find(isFixedTopic) : null,
    commentSections: COMMENT_SECTIONS,
    accounts,
    schedulerVersion: 3,
    dailyStop: runner.dailyStopStatus(),
    accountGroups: listAccountGroups(),
    dailySuccess: dailySuccess(undefined, 'workbench'),
    engageDailySuccess: dailySuccess(undefined, 'engage'),
    pendingRoundReports: pendingRoundReports().filter(report => (report.scope || getJob(report.jobId)?.scope || 'workbench') === 'workbench'),
    topics: config.topicMode === 'fixed' ? listTopics().filter(isFixedTopic).slice(0, 1) : listTopics(),
    comments: listCommentMaterials(),
    posts: listPostMaterials(),
    reposts: listRepostMaterials(),
    defaultEmojis: DEFAULT_EMOJIS,
    taskDefaults: normalizeTaskSettings(getSetting('task_defaults', {})),
    engageDefaults: normalizeEngageSettings(getSetting('engage_defaults', {})),
    engageTemplates: getSetting('engage_templates', []),
    engageNetwork: engageRunner.network.status(engageJob),
    materialGroups: listMaterialGroups(),
    lanAccess: currentLanAccess(config.port),
    restrictedAccounts: listActiveAccountRestrictions().map(item => ({
      accountId: item.accountId,
      identity: item.identity,
      type: item.type === 'mute' ? '禁言' : item.type === 'frequent' ? '频繁' : item.type,
      kind: item.kind || '',
      reason: item.reason || '',
      at: item.detectedAt || '',
      expiresAt: item.expiresAt || ''
    })),
    taskTemplates: getSetting('task_templates', []).map(item => ({ ...item, config: templateConfig(item.config || {}) })),
    loginSession: loginService.status(),
    activeJob: activeJob ? { ...activeJob, progress: taskProgress(activeJob) } : null,
    network: runner.network.status(activeJob),
    verification: runner.workflow.status(activeJob || listJobs(1, 'workbench')[0]),
    recentJobs: listJobs(15, 'workbench').map(job => ({ ...job, progress: taskProgress(job) })),
    recentActions: (activeJob || listJobs(1, 'workbench')[0]) ? listActionLogs((activeJob || listJobs(1, 'workbench')[0]).id, 120) : [],
    engageJob: (() => { const job = engageJob || listJobs(1, 'engage')[0]; return job ? { ...job, progress: taskProgress(job), operationCounts: operationCounts(job.id) } : null; })(),
    engageEdit: engageJob ? engageRunner.editableTask(engageJob.id) : null,
    engageVerification: engageRunner.workflow.status(engageJob || listJobs(1, 'engage')[0]),
    engageRecentActions: (engageJob || listJobs(1, 'engage')[0]) ? listActionLogs((engageJob || listJobs(1, 'engage')[0]).id, 120) : [],
    engageBrowser: engageBrowserManager.status(),
    update: updateManager.snapshot(),
    logs: listSystemLogs(150, 'workbench'),
    browser: browserManager.status(),
    loginBrowser: loginBrowserManager.status(),
    verificationVersion,
    features: { engageV2: true, typedMaterialGroups: true, concurrentTasks: true },
    service: serviceIdentity
  };
}

function broadcast(event, payload) {
  const line = `event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`;
  for (const res of sseClients) res.write(line);
}

async function api(req, res, url) {
  const routedJobId = url.pathname.match(/^\/api\/jobs\/([^/]+)/)?.[1];
  const runner = routedJobId ? runnerFor(getJob(routedJobId)) : runners[0];
  if (url.pathname === '/api/license/status' && req.method === 'GET') return send(res, 200, licenseStatus());
  if (url.pathname === '/api/health' && req.method === 'GET') return send(res, 200, { ok: true, version: packageVersion, service: serviceIdentity });
  if (url.pathname === '/api/license/activate' && req.method === 'POST') {
    const input = await body(req);
    try {
      const payload = activateLicense(String(input.code || ''));
      log('info', '授权激活成功：' + payload.user);
      broadcast('state', state());
      return send(res, 200, { ok: true, user: payload.user });
    } catch (error) {
      return send(res, 400, { error: error.message });
    }
  }
  const license = licenseStatus();
  if (!license.activated) return send(res, 401, { error: '软件尚未激活，请粘贴管理员提供的激活码', code: 'license_required' });
  if (url.pathname === '/api/login' && req.method === 'POST') {
    const input = await body(req);
    if (!accessToken()) return send(res, 401, { error: '软件尚未激活，请先粘贴激活码' });
    if (!safeEqual(input.token, accessToken())) return send(res, 401, { error: '访问口令不正确' });
    const session = randomToken();
    sessions.add(session);
    return send(res, 200, { ok: true }, { 'Set-Cookie': `wb_session=${session}; HttpOnly; SameSite=Strict; Path=/; Max-Age=2592000` });
  }
  if (url.pathname === '/api/session') return send(res, 200, { authenticated: isAuthenticated(req) });
  if (!isAuthenticated(req)) return send(res, 401, { error: '请先输入访问口令' });
  if (runners.some(worker => worker.repairing) && req.method !== 'GET' && !/^\/api\/jobs\/[^/]+\/(pause|stop)$/.test(url.pathname)) {
    return send(res, 409, { error: '正在只读核对历史发帖，请等待核对完成' });
  }
  if (url.pathname === '/api/lan-qr.svg' && req.method === 'GET') {
    const access = currentLanAccess(config.port);
    if (!access.qrUrl) return send(res, 404, { error: '未检测到局域网地址' });
    const svg = await QRCode.toString(access.qrUrl, { type: 'svg', margin: 1, width: 220, errorCorrectionLevel: 'M', color: { dark: '#7d1731ff', light: '#ffffffff' } });
    res.writeHead(200, { 'Content-Type': 'image/svg+xml; charset=utf-8', 'Cache-Control': 'no-cache' });
    return res.end(svg);
  }
  if (config.topicMode === 'fixed' && /^\/api\/topics(?:\/|$)/.test(url.pathname) && req.method !== 'GET') return send(res, 403, { error: '当前为苏新皓专用模式，不开放自定义超话' });
  if (url.pathname === '/api/topics' && req.method === 'GET') return send(res, 200, config.topicMode === 'fixed' ? listTopics().filter(isFixedTopic).slice(0, 1) : listTopics());
  if (url.pathname === '/api/logout' && req.method === 'POST') {
    const session = parseCookies(req.headers.cookie || '').wb_session;
    sessions.delete(session);
    return send(res, 200, { ok: true }, { 'Set-Cookie': 'wb_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0' });
  }
  if (url.pathname === '/api/state' && req.method === 'GET') return send(res, 200, state());
  if (url.pathname === '/api/update/status' && req.method === 'GET') {
    const result = await updateManager.check({ force: url.searchParams.get('refresh') === '1' });
    result.blockedReason = await updateManager.idleCheck();
    return send(res, 200, result);
  }
  if (url.pathname === '/api/update/download' && req.method === 'POST') {
    const result = updateManager.startDownload();
    return send(res, 202, result);
  }
  if (url.pathname === '/api/update/apply' && req.method === 'POST') {
    const input = await body(req);
    const result = await updateManager.apply({ restart: input.restart !== false });
    return send(res, 202, result);
  }
  if (url.pathname === '/api/records' && req.method === 'GET') {
    const date = url.searchParams.get('date') || shanghaiDate();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return send(res, 400, { error: '日期格式应为 YYYY-MM-DD' });
    const scope = ['workbench', 'engage'].includes(url.searchParams.get('scope')) ? url.searchParams.get('scope') : 'workbench';
    const records = listRecordsByShanghaiDate(date, 500, scope);
    const rounds = roundsForDate(date, scope);
    for (const report of rounds) if (!records.jobs.some(job => job.id === report.jobId)) {
      const job = getJob(report.jobId); if (job) records.jobs.push(job);
    }
    const offset = Math.max(0, Math.min(10000000, Number.parseInt(url.searchParams.get('offset') || '0', 10) || 0));
    const limit = Math.max(1, Math.min(100, Number.parseInt(url.searchParams.get('limit') || '20', 10) || 20));
    const panel = url.searchParams.get('panel') || '';
    const archived = isArchivedRecord(date);
    const level = ['success', 'warning', 'error'].includes(url.searchParams.get('level')) ? url.searchParams.get('level') : 'all';
    const view = archived
      ? { accounts: [], issues: [], counts: {}, abnormalCount: 0, jobCounts: {}, details: [], detailTotal: 0, nextCursor: null, snapshot: '', archived: true }
      : recordView(date, {
        query: (url.searchParams.get('q') || '').slice(0, 100),
        abnormalOnly: url.searchParams.get('abnormal') === '1',
        identity: url.searchParams.get('identity') || '',
        flow: panel === 'flow' || url.searchParams.get('flow') === '1',
        offset, limit,
        cursor: (url.searchParams.get('cursor') || '').slice(0, 200),
        snapshot: (url.searchParams.get('snapshot') || '').slice(0, 60),
        level,
        scope
      });
    return send(res, 200, { date, scope, ...records, rounds, dailySuccess: dailySuccess(date, scope), dailyStats: dailyStats(date, scope), workbenchDailySuccess: dailySuccess(date, 'workbench'), engageDailySuccess: dailySuccess(date, 'engage'), recordView: view });
  }
  if (url.pathname === '/api/account-groups' && req.method === 'POST') {
    const group = saveAccountGroup(null, (await body(req)).name);
    broadcast('state', state()); return send(res, 201, group);
  }
  if (url.pathname === '/api/account-groups' && req.method === 'GET') return send(res, 200, listAccountGroups());
  const groupMatch = url.pathname.match(/^\/api\/account-groups\/([^/]+)$/);
  if (groupMatch && req.method === 'PATCH') {
    const group = saveAccountGroup(groupMatch[1], (await body(req)).name);
    broadcast('state', state()); return send(res, 200, group);
  }
  if (groupMatch && req.method === 'PATCH') { const input = await body(req); const group = renameMaterialGroup(groupMatch[1], input.name); broadcast('state', state()); return send(res, 200, group); }
    if (groupMatch && req.method === 'DELETE') {
    deleteAccountGroup(groupMatch[1]); broadcast('state', state()); return send(res, 200, { ok: true });
  }
  if (url.pathname === '/api/accounts/group' && req.method === 'POST') {
    const input = await body(req);
    const results = moveAccountsToGroup(input.ids, input.groupId);
    broadcast('state', state()); return send(res, 200, { results });
  }
  const roundMatch = url.pathname.match(/^\/api\/jobs\/([^/]+)\/rounds(?:\/(\d+)\/ack)?$/);
  if (roundMatch && req.method === 'GET' && roundMatch[2] == null) {
    if (!getJob(roundMatch[1])) return send(res, 404, { error: '任务不存在' });
    return send(res, 200, listRoundReports(roundMatch[1], true));
  }
  if (roundMatch && req.method === 'POST' && roundMatch[2] != null) {
    if (!acknowledgeRound(roundMatch[1], Number(roundMatch[2]))) return send(res, 404, { error: '完成报告不存在' });
    broadcast('state', state()); return send(res, 200, { ok: true });
  }
  if (url.pathname === '/api/events' && req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
    res.write(`event: state\ndata: ${JSON.stringify(state())}\n\n`);
    sseClients.add(res);
    req.on('close', () => sseClients.delete(res));
    return;
  }
  const verificationRoute = url.pathname.match(/^\/api\/jobs\/([^/]+)\/verification\/(open|end|continue|confirm-unpublished|recheck)$/);
  if (verificationRoute && req.method === 'POST') {
    const jobId = verificationRoute[1], action = verificationRoute[2], input = await body(req);
    const job = getJob(jobId);
    if (!job || !runner.workflow.enabled(job)) return send(res, 404, { error: '该任务不支持验证队列' });
    if (loginService.active) return send(res, 409, { error: '请先完成或取消扫码登录' });
    let result;
    if (action === 'open') result = runner.workflow.requestManual(jobId, String(input.identity || ''), String(input.stepKey || ''));
    if (action === 'end') result = await runner.workflow.endManual(jobId);
    if (action === 'recheck') result = await runner.workflow.recheckManual(jobId);
    if (action === 'continue') result = runner.workflow.continue(jobId);
    if (action === 'confirm-unpublished') {
      if (input.confirmed !== true) return send(res, 400, { error: '必须明确确认该操作尚未发布' });
      result = runner.workflow.confirmUnpublished(jobId, String(input.stepKey || ''));
    }
    broadcast('state', state()); return send(res, 200, result);
  }
  const repairPostsRoute = url.pathname.match(/^\/api\/jobs\/([^/]+)\/repair-uncertain-posts$/);
  if (repairPostsRoute && req.method === 'POST') {
    if (loginService.active) return send(res, 409, { error: '请先完成或取消扫码登录' });
    const job = getJob(repairPostsRoute[1]);
    if (!job) return send(res, 404, { error: '任务不存在' });
    const input = await body(req);
    if (input.includeReceiptFailures !== undefined && typeof input.includeReceiptFailures !== 'boolean') return send(res, 400, { error: 'includeReceiptFailures 必须为布尔值' });
    if (input.actionIds !== undefined && (!Array.isArray(input.actionIds) || !input.actionIds.every(value => typeof value === 'string'))) return send(res, 400, { error: 'actionIds 必须为操作 ID 数组' });
    const result = await runner.repairUncertainPosts(job.id, { limit: input.limit ?? 4,
      includeReceiptFailures: input.includeReceiptFailures === true, actionIds: input.actionIds || null });
    broadcast('state', state()); return send(res, 200, result);
  }

  if (url.pathname === '/api/accounts' && req.method === 'POST') {
    const input = await body(req);
    const account = createAccount();
    broadcast('state', state());
    return send(res, 201, { ...account, profile_dir: undefined });
  }
  function accountOperation(id, action) {
    const account = getAccount(id);
    if (!account || account.deleted_at) throw new Error('账号不存在');
    if (action === 'delete') {
      const jobs = ['workbench','engage'].map(scope => getActiveJob(scope));
      if (jobs.some(job => job?.config?.accountIds?.includes(id))) throw new Error('账号被未结束的任务使用，请先停止任务');
      if (loginService.active?.accountId === id) throw new Error('账号正在登录，请先取消登录');
      if (browserManager.isAccountInUse(id) || engageBrowserManager.isAccountInUse(id) || loginBrowserManager.isAccountInUse(id)) throw new Error('账号浏览器窗口仍在使用，请先关闭浏览器窗口');
      deleteAccount(id);
    } else {
      if (!['enable', 'disable'].includes(action)) throw new Error('不支持的操作');
      if (!updateAccount(id, { enabled: action === 'enable' })) throw new Error('账号正在等待清理，请重试删除');
    }
  }
  if (url.pathname === '/api/accounts/bulk' && req.method === 'POST') {
    const input = await body(req);
    if (!Array.isArray(input.ids) || !['enable', 'disable', 'delete'].includes(input.action)) return send(res, 400, { error: '请选择账号和操作' });
    const results = [...new Set(input.ids)].map(id => {
      try { accountOperation(id, input.action); return { id, ok: true }; }
      catch (error) { return { id, ok: false, error: error.message }; }
    });
    broadcast('state', state());
    return send(res, 200, { results });
  }
  let match = url.pathname.match(/^\/api\/accounts\/([^/]+)$/);
  if (match && req.method === 'DELETE') {
    try { accountOperation(match[1], 'delete'); }
    catch (err) { return send(res, 409, { error: err.message }); }
    broadcast('state', state());
    return send(res, 200, { ok: true });
  }
  if (match && req.method === 'PATCH') {
    const account = updateAccount(match[1], await body(req));
    if (!account || account.deleted_at || account.cleanup_state) return send(res, 404, { error: '账号不存在或等待清理' });
    broadcast('state', state());
    return send(res, 200, { ...account, profile_dir: undefined });
  }
  match = url.pathname.match(/^\/api\/accounts\/([^/]+)\/login$/);
  if (match && req.method === 'POST') {
    const account = getAccount(match[1]);
    if (runners.some(worker => worker.workflow.busy())) return send(res, 409, { error: '请先结束账号验证会话' });
    if (!account || account.deleted_at || account.cleanup_state) return send(res, 404, { error: '账号不存在或等待清理' });
    if (browserManager.isAccountInUse(account.id) || engageBrowserManager.isAccountInUse(account.id)) return send(res, 409, { error: '该账号正在被任务使用，不能同时重新扫码登录' });
    const login = loginService.start(account);
    broadcast('state', state());
    return send(res, 202, { ...login, message: '请在 Mac 上扫码，登录后将自动确认身份' });
  }
  match = url.pathname.match(/^\/api\/accounts\/([^/]+)\/verify$/);
  if (match && req.method === 'POST') {
    if (runners.some(worker => worker.workflow.busy())) return send(res, 409, { error: '请先结束账号验证会话' });
    const account = getAccount(match[1]);
    if (!account || account.deleted_at || account.cleanup_state) return send(res, 404, { error: '账号不存在或等待清理' });
    const identity = await loginService.adapter.getIdentity(account, 'login');
    const updated = updateAccountAuth(account.id, identity);
    broadcast('state', state());
    return send(res, identity.status === 'valid' ? 200 : 409, { account: { ...updated, profile_dir: undefined }, identity });
  }
  match = url.pathname.match(/^\/api\/accounts\/([^/]+)\/restrictions$/);
  if (match && req.method === 'DELETE') {
    const account = getAccount(match[1]);
    if (!account || account.deleted_at || account.cleanup_state) return send(res, 404, { error: '账号不存在' });
    const identity = String(account.uid || `account:${account.id}`);
    const cleared = clearAccountRestrictions(account.id);
    const jobs = clearAccountRestrictionsFromOpenJobs({ accountId: account.id, identity });
    for (const worker of runners) worker.accountRestrictionsAt = 0;
    log('info', `手动解除账号限制：${account.nickname || account.name || account.id}`, { accountId: account.id });
    broadcast('state', state());
    return send(res, 200, { ok: true, cleared, jobs });
  }
  if (url.pathname === '/api/browser/close' && req.method === 'POST') {
    if (runners.some(worker => worker.workflow.busy())) return send(res, 409, { error: '请先在待验证账号区结束验证会话' });
    if (runners.some(worker => worker.promise)) return send(res, 409, { error: '请先暂停任务，待当前操作完成' });
    await loginService.cancel();
    await browserManager.close();
    await engageBrowserManager.close();
    await loginBrowserManager.close();
    broadcast('state', state());
    return send(res, 200, { ok: true });
  }

  if (url.pathname === '/api/login-session/cancel' && req.method === 'POST') {
    await loginService.cancel();
    broadcast('state', state());
    return send(res, 200, { ok: true });
  }
  if (url.pathname === '/api/post-materials' && req.method === 'GET') return send(res, 200, listPostMaterials());
  if (url.pathname === '/api/post-materials' && req.method === 'POST') {
    const input = await body(req);
    const texts = cleanTexts(input.texts);
    if (!texts.length) return send(res, 400, { error: '请输入至少一条文案' });
    const materials = addPostMaterials(texts, undefined, String(input.groupId || ''));
    broadcast('state', state());
    return send(res, 201, materials);
  }
  if (url.pathname === '/api/post-materials/bulk-delete' && req.method === 'POST') {
    const input = await body(req);
    if (!Array.isArray(input.ids) || !input.ids.length) return send(res, 400, { error: '请选择要删除的文案' });
    const results = deletePostMaterials(input.ids);
    broadcast('state', state());
    return send(res, 200, { results });
  }

  if (url.pathname === '/api/topics' && req.method === 'POST') {
    const input = await body(req);
    if (!input.name?.trim() || !/^https:\/\//.test(input.url || '')) return send(res, 400, { error: '请输入超话名称和 https 链接' });
    const topic = createTopic(input);
    broadcast('state', state());
    return send(res, 201, topic);
  }
  if (url.pathname === '/api/topics/bulk-delete' && req.method === 'POST') {
    const input = await body(req);
    if (!Array.isArray(input.ids) || !input.ids.length) return send(res, 400, { error: '请选择要删除的超话' });
    const results = deleteTopics(input.ids);
    broadcast('state', state());
    return send(res, 200, { results });
  }
  match = url.pathname.match(/^\/api\/topics\/([^/]+)$/);
  if (match && req.method === 'PATCH') {
    const topic = updateTopic(match[1], await body(req));
    if (!topic) return send(res, 404, { error: '超话不存在' });
    broadcast('state', state());
    return send(res, 200, topic);
  }
  if (match && req.method === 'DELETE') {
    deleteTopic(match[1]);
    broadcast('state', state());
    return send(res, 200, { ok: true });
  }

  match = url.pathname.match(/^\/api\/accounts\/([^/]+)\/materials$/);
  if (match && req.method === 'GET') return send(res, 200, listPostMaterials(match[1]));
  if (match && req.method === 'POST') {
    const input = await body(req);
    const texts = cleanTexts(input.texts);
    if (!texts.length) return send(res, 400, { error: '请输入至少一条文案' });
    const materials = addPostMaterials(match[1], texts);
    broadcast('state', state());
    return send(res, 201, materials);
  }
  match = url.pathname.match(/^\/api\/post-materials\/([^/]+)$/);
  if (match && req.method === 'DELETE') {
    deletePostMaterial(match[1]);
    broadcast('state', state());
    return send(res, 200, { ok: true });
  }
  if (url.pathname === '/api/comment-materials' && req.method === 'GET') return send(res, 200, listCommentMaterials());
  if (url.pathname === '/api/comment-materials' && req.method === 'POST') {
    const input = await body(req);
    const texts = cleanTexts(input.texts);
    if (!texts.length) return send(res, 400, { error: '请输入至少一条评论文案' });
    const materials = addCommentMaterials(texts, String(input.groupId || ''));
    broadcast('state', state());
    return send(res, 201, materials);
  }
  if (url.pathname === '/api/comment-materials/bulk-delete' && req.method === 'POST') {
    const input = await body(req);
    if (!Array.isArray(input.ids) || !input.ids.length) return send(res, 400, { error: '请选择要删除的文案' });
    const results = deleteCommentMaterials(input.ids);
    broadcast('state', state());
    return send(res, 200, { results });
  }
  match = url.pathname.match(/^\/api\/comment-materials\/([^/]+)$/);
  if (match && req.method === 'DELETE') {
    deleteCommentMaterial(match[1]);
    broadcast('state', state());
    return send(res, 200, { ok: true });
  }

  if (url.pathname === '/api/repost-materials' && req.method === 'GET') return send(res, 200, listRepostMaterials());
  if (url.pathname === '/api/repost-materials' && req.method === 'POST') {
    const input = await body(req);
    const texts = cleanTexts(input.texts);
    if (!texts.length) return send(res, 400, { error: '请输入至少一条转发文案' });
    const materials = addRepostMaterials(texts, String(input.groupId || ''));
    broadcast('state', state());
    return send(res, 201, materials);
  }
  if (url.pathname === '/api/repost-materials/bulk-delete' && req.method === 'POST') {
    const input = await body(req);
    if (!Array.isArray(input.ids) || !input.ids.length) return send(res, 400, { error: '请选择要删除的文案' });
    const results = deleteRepostMaterials(input.ids);
    broadcast('state', state());
    return send(res, 200, { results });
  }
  match = url.pathname.match(/^\/api\/repost-materials\/([^/]+)$/);
  if (match && req.method === 'DELETE') {
    deleteRepostMaterial(match[1]);
    broadcast('state', state());
    return send(res, 200, { ok: true });
  }

  if (url.pathname === '/api/material-groups' && req.method === 'GET') return send(res, 200, listMaterialGroups());
  if (url.pathname === '/api/material-groups' && req.method === 'POST') {
    const input = await body(req);
    if (!['post','comment','repost'].includes(input.type)) return send(res, 400, { error: '请选择文案类型' });
    try { const group = createMaterialGroup(input.name, input.type); broadcast('state', state()); return send(res, 201, group); }
    catch (error) { return send(res, 400, { error: error.message }); }
  }
  { const groupMatch = url.pathname.match(/^\/api\/material-groups\/([^/]+)$/);
    if (groupMatch && req.method === 'PATCH') { const input = await body(req); const group = renameMaterialGroup(groupMatch[1], input.name); broadcast('state', state()); return send(res, 200, group); }
    if (groupMatch && req.method === 'DELETE') { deleteMaterialGroup(groupMatch[1]); broadcast('state', state()); return send(res, 200, { ok: true }); } }
  if (url.pathname === '/api/materials/group' && req.method === 'POST') {
    const input = await body(req);
    if (!['post','comment','repost'].includes(input.type) || !Array.isArray(input.ids)) return send(res, 400, { error: '参数不正确' });
    const materials = setMaterialsGroup(input.type, input.ids, String(input.groupId || ''));
    broadcast('state', state()); return send(res, 200, { materials });
  }
  if (url.pathname === '/api/accounts/order' && req.method === 'POST') {
    const input = await body(req);
    if (!Array.isArray(input.ids) || !input.ids.length) return send(res, 400, { error: '缺少账号顺序' });
    reorderAccounts(input.ids.map(String));
    broadcast('state', state()); return send(res, 200, { ok: true });
  }
  if (url.pathname === '/api/settings/task' && req.method === 'PUT') {
    const input = normalizeTaskSettings(await body(req));
    setSetting('task_defaults', input);
    broadcast('state', state());
    return send(res, 200, input);
  }
  if (url.pathname === '/api/settings/engage' && req.method === 'PUT') {
    const input = normalizeEngageSettings(await resolveEngageSettings(await body(req)));
    setSetting('engage_defaults', input);
    broadcast('state', state());
    return send(res, 200, input);
  }
  if (url.pathname === '/api/engage/blacklist/resolve' && req.method === 'POST') {
    const input = await body(req);
    if (!input || typeof input !== 'object' || !Array.isArray(input.profiles)) return send(res, 400, { error: '作者主页黑名单必须是链接数组' });
    return send(res, 200, await resolveBlacklist(input.profiles));
  }
  if (url.pathname === '/api/engage-templates' && req.method === 'POST') {
    const input = await body(req);
    if (!input || typeof input !== 'object' || Array.isArray(input)) return send(res, 400, { error: '模板必须是对象' });
    const name = String(input.name || '').trim().slice(0, 40);
    if (!name) return send(res, 400, { error: '请输入模板名称' });
    const config = engageTemplateConfig(await resolveEngageSettings(input.config || {}));
    const templates = getSetting('engage_templates', []);
    const template = { id: `engtpl_${randomToken().slice(0, 12)}`, name, config, updatedAt: new Date().toISOString() };
    templates.push(template); setSetting('engage_templates', templates); broadcast('state', state());
    return send(res, 201, template);
  }
  match = url.pathname.match(/^\/api\/engage-templates\/([^/]+)$/);
  if (match && ['PUT','DELETE'].includes(req.method)) {
    const templates = getSetting('engage_templates', []), index = templates.findIndex(item => item.id === match[1]);
    if (index < 0) return send(res, 404, { error: '模板不存在' });
    let result = { ok: true };
    if (req.method === 'DELETE') templates.splice(index, 1);
    else {
      const input = await body(req);
      if (!input || typeof input !== 'object' || Array.isArray(input)) return send(res, 400, { error: '模板必须是对象' });
      const name = String(input.name ?? templates[index].name).trim().slice(0, 40);
      if (!name) return send(res, 400, { error: '请输入模板名称' });
      result = templates[index] = { ...templates[index], name, config: engageTemplateConfig(await resolveEngageSettings(input.config || templates[index].config)), updatedAt: new Date().toISOString() };
    }
    setSetting('engage_templates', templates); broadcast('state', state()); return send(res, 200, result);
  }
  if (url.pathname === '/api/task-templates' && req.method === 'POST') {
    const input = await body(req);
    const name = String(input.name || '').trim();
    if (!name) return send(res, 400, { error: '请输入模板名称' });
    const templates = getSetting('task_templates', []);
    const template = { id: `tpl_${randomToken().slice(0, 12)}`, name: name.slice(0, 40), config: templateConfig(input.config || {}), updatedAt: new Date().toISOString() };
    templates.push(template); setSetting('task_templates', templates); broadcast('state', state());
    return send(res, 201, template);
  }
  match = url.pathname.match(/^\/api\/task-templates\/([^/]+)$/);
  if (match && req.method === 'PUT') {
    const input = await body(req); const templates = getSetting('task_templates', []); const index = templates.findIndex(item => item.id === match[1]);
    if (index < 0) return send(res, 404, { error: '模板不存在' });
    templates[index] = { ...templates[index], name: String(input.name ?? templates[index].name).trim().slice(0, 40), config: templateConfig(input.config || templates[index].config), updatedAt: new Date().toISOString() };
    setSetting('task_templates', templates); broadcast('state', state()); return send(res, 200, templates[index]);
  }
  if (match && req.method === 'DELETE') {
    const templates = getSetting('task_templates', []); const next = templates.filter(item => item.id !== match[1]);
    if (next.length === templates.length) return send(res, 404, { error: '模板不存在' });
    setSetting('task_templates', next); broadcast('state', state()); return send(res, 200, { ok: true });
  }
  if (url.pathname === '/api/jobs' && req.method === 'POST') {
    let input = await body(req);
    if (input.kind === 'engage') input = await resolveEngageSettings(input);
    const selectedRunner = runnerFor(input);
    if (selectedRunner.workflow.busy()) return send(res, 409, { error: '请先结束本页账号验证会话' });
    const result = selectedRunner.start(input, listAccounts(), listTopics());
    broadcast('state', state());
    return send(res, result.created ? 201 : 409, result.created ? result : { ...result, error: '已有未结束任务，请先在总览查看、继续或停止该任务' });
  }
  match = url.pathname.match(/^\/api\/jobs\/([^/]+)\/edit$/);
  if (match && req.method === 'GET') {
    const editable = runner.editableTask(match[1]);
    if (!editable) return send(res, 404, { error: '任务不存在' });
    return send(res, 200, editable);
  }
  if (match && req.method === 'POST') {
    const input = await body(req);
    if (runner.scope === 'engage') input.config = await resolveEngageSettings(input.config || {});
    let result;
    try { result = runner.applyTaskEdit(match[1], input.config || {}, input.version, { resume: input.resume === true }); }
    catch (err) { err.taskId = match[1]; throw err; }
    if (!result) return send(res, 404, { error: '任务不存在' });
    broadcast('state', state()); return send(res, 200, result);
  }
  match = url.pathname.match(/^\/api\/jobs\/([^/]+)\/edit-preview$/);
  if (match && req.method === 'POST') {
    const input = await body(req);
    if (runner.scope === 'engage') input.config = await resolveEngageSettings(input.config || {});
    const result = runner.taskEditPreview(match[1], input.config || {}, input.version);
    if (!result) return send(res, 404, { error: '任务不存在' });
    return send(res, 200, result);
  }
  const actionRecheckRoute = url.pathname.match(/^\/api\/jobs\/([^/]+)\/actions\/([^/]+)\/recheck$/);
  if (actionRecheckRoute && req.method === 'POST') {
    if (loginService.active) return send(res, 409, { error: '请先完成或取消扫码登录' });
    const result = await runner.recheckUncertainAction(actionRecheckRoute[1], actionRecheckRoute[2]);
    broadcast('state', state());
    return send(res, 200, result);
  }
  match = url.pathname.match(/^\/api\/jobs\/([^/]+)\/(pause|resume|stop)$/);
  if (match && req.method === 'POST') {
    const job = runner[match[2]](match[1]);
    if (!job) return send(res, 404, { error: '任务不存在' });
    broadcast('state', state());
    return send(res, 200, { ...job, progress: taskProgress(job) });
  }
  match = url.pathname.match(/^\/api\/jobs\/([^/]+)$/);
  if (match && req.method === 'GET') {
    const job = getJob(match[1]);
    if (!job) return send(res, 404, { error: '任务不存在' });
    return send(res, 200, { job: { ...job, progress: taskProgress(job) }, actions: listActionLogs(job.id, 500) });
  }
  return send(res, 404, { error: '接口不存在' });
}

function serveStatic(req, res, url) {
  const relative = url.pathname === '/' ? 'index.html' : url.pathname.replace(/^\/+/, '');
  const file = path.resolve(config.publicDir, relative);
  if (!file.startsWith(`${config.publicDir}${path.sep}`) || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
    return send(res, 404, { error: '页面不存在' });
  }
  const ext = path.extname(file);
  const mime = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.svg': 'image/svg+xml', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png' }[ext] || 'application/octet-stream';
  res.writeHead(200, { 'Content-Type': mime, 'Cache-Control': 'no-cache' });
  fs.createReadStream(file).pipe(res);
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  try {
    if (url.pathname.startsWith('/api/')) await api(req, res, url);
    else serveStatic(req, res, url);
  } catch (err) { error(res, err); }
});

server.listen(config.port, config.host, async () => {
  const access = currentLanAccess(config.port);
  console.log(`电脑本机：http://localhost:${config.port}`);
  for (const address of access.urls) console.log(`手机访问：${address}`);
  if (!access.urls.length) console.log('手机访问：未检测到 Wi-Fi/Ethernet 地址');
  const license = licenseStatus();
  if (!license.activated) console.log('尚未激活：打开页面粘贴管理员提供的激活码即可，口令由激活码携带。');
  else if (license.user && license.user !== 'dev') console.log(`已激活：${license.user}`);
  if ((process.stdout.isTTY || process.env.WEIBO_CONSOLE_SHOW_TOKEN === '1') && accessToken()) console.log(`访问口令：${accessToken()}`);
  const seededRestrictions = seedAccountRestrictionsFromJobs();
  if (seededRestrictions) log('info', '已回填账号限制 ' + seededRestrictions + ' 条');
  for (const worker of runners) await worker.recover();
  try {
    const pruned = pruneDetailedRecords({ days: RETENTION_DAYS });
    if (pruned.deleted.actions || pruned.deleted.logs || pruned.deleted.cards || pruned.deleted.steps) {
      console.log('已清理 ' + RETENTION_DAYS + ' 天前详细记录：动作 ' + pruned.deleted.actions + '、日志 ' + pruned.deleted.logs + '、验证卡 ' + pruned.deleted.cards + '、步骤 ' + pruned.deleted.steps);
    }
  } catch (error) {
    log('warning', '详细记录清理失败：' + error.message);
  }
  // Upgrade the just-finished run that exposed the sign-in classification
  // issue.  The workflow method is idempotent and only reopens uncertain
  // check-ins from a completed, verification-capable task.
  const latest = listJobs(1, 'workbench')[0];
  if (latest) runner.workflow.reopenUnconfirmedCheckins(latest.id);
  engageRunner.scheduleAutoReadbacks();
});

let stopping = false;
async function shutdown() {
    if (stopping) return;
    stopping = true;
    clearInterval(dailyStopTimer);
    for (const worker of runners) { worker.network.clear(); worker.navigation.clear(); }
    await loginService.cancel();
    await browserManager.close();
    await engageBrowserManager.close();
    await loginBrowserManager.close();
    for (const client of sseClients) client.end();
    server.close(() => process.exit(0));
}
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, shutdown);
// Only the private parent/child IPC channel can request service shutdown.
process.on('message', message => {
  if (message?.type !== 'weibo-service-stop' || !process.send) return;
  const busy = loginService.active || loginBrowserManager.status().busy || runners.some(worker => worker.adapter.browserManager.status().busy || worker.workflow.busy() || worker.current()?.status === 'running' || worker.repairing);
  process.send({ type: 'weibo-service-stop-result', id: message.id, ok: !busy, error: busy ? '浏览器或任务仍在执行，请先安全暂停任务并结束会话' : undefined }, () => { if (!busy) void shutdown(); });
});
