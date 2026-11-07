import { db, countActionsByJob } from './db.js';
import { displayStateSql } from './result-state.js';

export const ISSUE_PRIORITY = ['待验证', '待核对', '失败', '禁言', '频繁', '网络异常', '异常'];
const SOURCE_RANK = { system: 0, action: 1, verification: 2, restriction: 3 };
const CLUSTER_WINDOW_MS = 60 * 1000;

// 先判禁言 / 频繁 / 验证，网络放后面：同一条"验证码加载失败"不再算网络异常。
export function problemType(message = '', state = '') {
  if (/禁言/.test(message)) return '禁言';
  if (/频繁|too many|rate.?limit/i.test(message)) return '频繁';
  if (state === 'verification_wait' || /验证码|人工验证|安全验证|验证队列/.test(message)) return '待验证';
  if (/网络|断网|net::|DNS|CDP|connect|offline/i.test(message)) return '网络异常';
  if (['uncertain', 'submitted'].includes(state) || /待核对|结果未确认/.test(message)) return '待核对';
  if (state === 'failed') return '失败';
  return '异常';
}

const KINDS = ['checkin', 'post', 'comment', 'repost', 'like', 'comment_like'];
const counts = () => Object.fromEntries(KINDS.map(kind => [kind, { succeeded: 0, failed: 0, uncertain: 0, skipped: 0 }]));
const stamp = row => row.completed_at || row.created_at || row.started_at || '';
const matchesLevel = (row, level) => level === 'all' || row.level === level;
const levelFor = state => ({ succeeded: 'success', failed: 'error', uncertain: 'warning', submitted: 'warning', verification_wait: 'warning' })[state] || 'info';
const detailKey = (row, at) => (row.id != null && row.id !== '' ? String(row.id) : [row.source, row.identity || '', row.type || '', row.kind || '', at].join(':'));
const cmp = (a, b) => (a === b ? 0 : a < b ? -1 : 1);
const cursorOf = row => row.at + '|' + row.sortId;

function clusterIssues(events) {
  const groups = new Map();
  for (const event of events) {
    const key = (event.identity || 'system') + '|' + event.type;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(event);
  }
  const clusters = [];
  for (const [key, list] of groups) {
    list.sort((a, b) => String(a.at).localeCompare(String(b.at)) || SOURCE_RANK[b.source] - SOURCE_RANK[a.source]);
    let current = null;
    for (const event of list) {
      const time = Date.parse(event.at) || 0;
      if (current && time - current.lastTime <= CLUSTER_WINDOW_MS) {
        current.count += 1;
        current.sources[event.source] = (current.sources[event.source] || 0) + 1;
        current.lastTime = Math.max(current.lastTime, time);
        if (event.kind && !current.kinds.includes(event.kind)) current.kinds.push(event.kind);
        if (SOURCE_RANK[event.source] > SOURCE_RANK[current.source]) current.source = event.source;
        if (String(event.at) > current.latest) current.latest = String(event.at);
        if (String(event.at) < current.first) current.first = String(event.at);
        if (!current.name && event.name) current.name = event.name;
        continue;
      }
      current = { key: key + ':' + event.at, identity: event.identity || '', name: event.name || '系统', uid: event.uid || '', type: event.type, kinds: event.kind ? [event.kind] : [], source: event.source, sources: { [event.source]: 1 }, count: 1, first: String(event.at), latest: String(event.at), lastTime: time };
      clusters.push(current);
    }
  }
  for (const cluster of clusters) {
    const perSource = Object.values(cluster.sources);
    cluster.count = perSource.length > 1 ? Math.max(...perSource) : perSource[0];
  }
  return clusters;
}

export function recordView(date, { query = '', abnormalOnly = false, identity = '', offset = 0, limit = 20, level = 'all', flow = false, cursor = '', snapshot = '', scope = 'workbench' } = {}) {
  const jobs = db.prepare('SELECT id,config_json,cursor_json,created_at FROM jobs WHERE scope=? ORDER BY created_at DESC').all(scope);
  const jobMap = new Map();
  const identityIndex = new Map();
  for (const job of jobs) {
    const config = JSON.parse(job.config_json || '{}');
    const cursorState = JSON.parse(job.cursor_json || '{}');
    jobMap.set(job.id, { ...job, config, cursor: cursorState });
    for (const [accountId, who] of Object.entries(config.accountIdentities || {})) {
      if (!identityIndex.has(accountId)) identityIndex.set(accountId, who);
    }
  }
  const current = new Map(db.prepare('SELECT id,name,nickname,uid FROM accounts').all().map(account => [account.id, account]));
  const accounts = new Map();
  const issueEvents = [];
  const ensure = (accountId, jobId, supplied) => {
    if (!accountId) return null;
    const saved = jobMap.get(jobId)?.config.accountIdentities?.[accountId] || identityIndex.get(accountId);
    const live = current.get(accountId);
    const who = supplied || saved || live || {};
    const uid = String(who.uid || live?.uid || '');
    const key = uid || 'account:' + accountId;
    if (!accounts.has(key)) {
      const name = who.name || who.nickname || live?.nickname || live?.name || accountId;
      accounts.set(key, { identity: key, name, nameStamp: '', uid, aliases: [], counts: counts(), tags: [], records: [] });
    }
    const account = accounts.get(key);
    for (const alias of [who.name, who.nickname, live?.name, live?.nickname]) if (alias && !account.aliases.includes(alias)) account.aliases.push(alias);
    return account;
  };
  const touchName = (account, name, at) => {
    if (!account || !name) return;
    if (!account.nameStamp || String(at) >= account.nameStamp) { account.name = name; account.nameStamp = String(at); }
  };
  const addIssue = (account, type, kind, row, source) => {
    if (!account && source !== 'system') return;
    issueEvents.push({ identity: account?.identity || '', name: account?.name || '系统', uid: account?.uid || '', type, kind: kind || '', at: stamp(row), source, account });
  };

  const actions = db.prepare(`SELECT l.*,${displayStateSql(db)} display_state,t.name topic_name FROM action_logs l LEFT JOIN topics t ON t.id=l.topic_id WHERE strftime('%Y-%m-%d',l.started_at,'+8 hours')=? AND l.scope=? ORDER BY l.started_at DESC,l.id DESC`).all(date, scope);
  const entries = [];
  for (const action of actions) {
    const account = ensure(action.account_id, action.job_id);
    const at = stamp(action);
    touchName(account, account?.name, at);
    const state = action.display_state;
    const row = { ...action, source: 'action', identity: account?.identity || '', account_name: account?.name || '系统', uid: account?.uid || '', level: levelFor(state), created_at: action.started_at, message: action.error || '', type: state === 'verification_wait' ? '待验证' : ['uncertain','submitted'].includes(state) ? '待核对' : problemType(action.error, state) };
    row.at = at; row.sortId = detailKey(row, at);
    entries.push(row);
    if (account) {
      account.records.push(row);
      if (account.counts[action.kind]?.[state] != null) account.counts[action.kind][state]++;
    }
    if (['failed', 'uncertain', 'submitted', 'verification_wait'].includes(action.state) || (action.state === 'skipped' && /禁言|频繁/.test(action.error || ''))) addIssue(account, row.type, action.kind, row, 'action');
  }

  const logs = db.prepare("SELECT l.*,t.name topic_name FROM system_logs l LEFT JOIN topics t ON t.id=l.topic_id WHERE strftime('%Y-%m-%d',l.created_at,'+8 hours')=? AND l.scope=? ORDER BY l.created_at DESC,l.id DESC").all(date, scope);
  const recoveredAt = logs.find(row => /网络已恢复/.test(row.message))?.created_at || '';
  for (const log of logs) {
    const account = ensure(log.account_id);
    const type = problemType(log.message);
    const kind = /发帖|\bpost\b/.test(log.message) ? 'post' : /评论|\bcomment\b/.test(log.message) ? 'comment' : /签到/.test(log.message) ? 'checkin' : '';
    const at = stamp(log);
    const row = { ...log, source: 'system', identity: account?.identity || '', account_name: account?.name || '系统', uid: account?.uid || '', type, at };
    row.sortId = detailKey(row, at);
    entries.push(row);
    account?.records.push(row);
    const diagnostic = /探测|扫描|回执 #|回执：|异步核验|扫码会话/.test(log.message);
    if (['warning', 'error'].includes(log.level) && !diagnostic && !(type === '网络异常' && log.created_at <= recoveredAt)) addIssue(account, type, kind, row, 'system');
  }

  const cards = db.prepare("SELECT c.* FROM verification_cards c JOIN jobs j ON j.id=c.job_id WHERE j.scope=? AND (strftime('%Y-%m-%d',c.triggered_at,'+8 hours')=? OR strftime('%Y-%m-%d',c.updated_at,'+8 hours')=?)").all(scope, date, date);
  for (const card of cards) {
    if (card.status === 'resolved') continue;
    const account = ensure(card.account_id, card.job_id);
    const at = card.updated_at || card.triggered_at;
    const row = { ...card, source: 'verification', identity: account?.identity || '', account_name: account?.name || '', level: 'warning', state: 'verification_wait', created_at: card.updated_at, message: card.reason, type: '待验证', at };
    row.sortId = ['verification', card.job_id, card.round_index, card.identity, at].join(':');
    addIssue(account, '待验证', '', row, 'verification');
    account?.records.push(row);
    entries.push(row);
  }

  for (const job of jobMap.values()) {
    for (const restriction of [...(job.cursor.muteLimits || []).map(x => ({ ...x, type: '禁言' })), ...(job.cursor.rateLimits || []).map(x => ({ ...x, type: '频繁' }))]) {
      if (!restriction.at || new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai' }).format(new Date(restriction.at)) !== date) continue;
      const saved = Object.entries(job.config.accountIdentities || {}).find(([id, a]) => String(a.uid || 'account:' + id) === restriction.identity);
      const accountId = saved?.[0] || [...current.values()].find(a => String(a.uid || 'account:' + a.id) === restriction.identity)?.id;
      const account = ensure(accountId, job.id, saved?.[1]);
      if (!account) continue;
      const row = { source: 'restriction', identity: account.identity, account_name: account.name, kind: restriction.kind || '', state: 'skipped', level: 'warning', type: restriction.type, message: restriction.reason, created_at: restriction.at, at: restriction.at };
      row.sortId = ['restriction', job.id, restriction.round ?? '', restriction.identity, restriction.kind || '', restriction.at].join(':');
      addIssue(account, restriction.type, restriction.kind || '', row, 'restriction');
      account.records.push(row);
      entries.push(row);
    }
  }

  const clusters = clusterIssues(issueEvents);
  for (const cluster of clusters) {
    if (!cluster.identity) continue;
    const account = accounts.get(cluster.identity);
    if (!account) continue;
    for (const kind of (cluster.kinds.length ? cluster.kinds : [''])) {
      if (!account.tags.some(tag => tag.type === cluster.type && tag.kind === kind)) account.tags.push({ type: cluster.type, kind });
    }
  }

  const q = query.trim().toLocaleLowerCase();
  const selected = [...accounts.values()].filter(a => (!q || [a.name, a.uid, ...a.aliases].some(x => String(x).toLocaleLowerCase().includes(q))) && (!abnormalOnly || a.tags.length));
  selected.sort((a, b) => b.tags.length - a.tags.length || a.name.localeCompare(b.name, 'zh-CN'));
  const keys = new Set(selected.map(a => a.identity));
  const visibleIssues = clusters
    .filter(i => (!i.identity ? !q && !abnormalOnly : keys.has(i.identity)))
    .sort((a, b) => ISSUE_PRIORITY.indexOf(a.type) - ISSUE_PRIORITY.indexOf(b.type) || String(b.latest).localeCompare(String(a.latest)));

  let details = identity ? accounts.get(identity)?.records || [] : flow ? entries.filter(row => (!q && !abnormalOnly) || keys.has(row.identity)) : [];
  details = details.filter(row => matchesLevel(row, level)).sort((a, b) => cmp(String(b.at), String(a.at)) || cmp(String(b.sortId), String(a.sortId)));
  const ceiling = snapshot || (details[0]?.at || '');
  if (ceiling) details = details.filter(row => String(row.at) <= ceiling);
  const total = details.length;
  if (cursor) {
    const split = cursor.indexOf('|');
    const at = split < 0 ? cursor : cursor.slice(0, split);
    const id = split < 0 ? '' : cursor.slice(split + 1);
    details = details.filter(row => cmp(String(row.at), at) < 0 || (String(row.at) === at && cmp(String(row.sortId), id) < 0));
  } else if (offset > 0) details = details.slice(offset);
  const page = details.slice(0, limit);
  const nextCursor = details.length > limit ? cursorOf(page[page.length - 1]) : null;

  const perKind = counts();
  for (const account of accounts.values()) for (const kind of KINDS) for (const state of Object.keys(perKind[kind])) perKind[kind][state] += account.counts[kind][state];

  return {
    accounts: selected.map(({ records, aliases, ...account }) => account),
    issues: visibleIssues.map(({ lastTime, kinds, ...issue }) => ({ ...issue, kind: kinds[0] || '', kinds })),
    uncertain: actions
      .filter(action => ['uncertain', 'submitted'].includes(action.display_state))
      .map(action => ({
        id: action.id,
        state: action.state,
        display_state: action.display_state,
        job_id: action.job_id,
        kind: action.kind,
        account_id: action.account_id,
        account_name: current.get(action.account_id)?.nickname || current.get(action.account_id)?.name || action.account_id,
        uid: current.get(action.account_id)?.uid || '',
        started_at: action.started_at,
        error: action.error || '',
        content: action.content || '',
        target_id: action.target_id || '',
        url: action.url || ''
      })),
    counts: perKind,
    abnormalCount: [...accounts.values()].filter(a => a.tags.length).length,
    jobCounts: countActionsByJob(date, scope),
    details: page,
    detailTotal: total,
    nextCursor,
    snapshot: ceiling
  };
}
