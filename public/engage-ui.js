import { DEFAULT_ENGAGE_INTERVALS, DEFAULT_ENGAGE_COUNTS, normalizeEngageSettings, splitEngageKeywords, engageTemplateConfig } from './defaults.js';

const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const labels = { repost: '转发', comment: '评论', comment_like: '内赞', like: '外赞' };
const stateLabel = value => ({ succeeded: '成功', failed: '失败', uncertain: '待核对', submitted: '待核对', verification_wait: '待验证', skipped: '跳过', prepared: '准备中', cancelled: '取消' }[value] || value || '');
const lightFor = value => ({ succeeded: 'ok', failed: 'bad', uncertain: 'warn', submitted: 'warn', skipped: 'idle', verification_wait: 'warn', cancelled: 'idle' }[value] || 'idle');
const localDate = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai' }).format(new Date());
const time = value => value ? new Date(value).toLocaleTimeString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false }) : '';
const stamp = () => 'seg_' + crypto.randomUUID();
const clamp = (value, min, max, fallback) => Number.isFinite(Number(value)) ? Math.max(min, Math.min(max, Math.trunc(Number(value)))) : fallback;

export function createEngageUI({ getState, request, refresh, toast, openAccounts, start }) {
  const root = document.querySelector('#page-engage');
  const $ = selector => root.querySelector(selector);
  let config = normalizeEngageSettings(), initialized = false, dirty = false, saving = false;
  let editingJob = null, editOriginal = null;
  let pane = 'range', dailyDate = null, dailyValues = null, dailyVersion = 0, submitting = false;
  let drag = null, moved = false, editId = '', groupsType = '', groupsBaseline = '', lastGroups = '';
  const expandedRecent = new Set();
  let selectedTemplate = '', lastTemplates = '', templateBusy = false, blacklistFlight = null, blacklistBaseline = null, blacklistErrors = [];
  // Live updates only paint these status regions. Draft inputs are never rebuilt by SSE.
  const dialog = (id, title, body) => {
    const node = document.createElement('dialog'); node.id = id; node.className = 'engage-dialog';
    node.innerHTML = '<div class="dialog-head"><h2>' + title + '</h2><button type="button" class="text-button" data-engage-close>关闭</button></div>' + body;
    document.body.append(node); node.querySelector('[data-engage-close]').onclick = () => node.close(); return node;
  };
  const addDialog = dialog('engage-add-dialog', '添加操作段', '<div class="engage-add-choices">' + ['repost','comment','comment_like'].map(type => '<button type="button" class="quiet" data-engage-add="' + type + '">' + labels[type] + ' · 默认 ' + DEFAULT_ENGAGE_COUNTS[type] + (type === 'comment_like' ? ' 条' : ' 次') + ' / 3 秒</button>').join('') + '</div>');
  const orderDialog = dialog('engage-order-dialog', '调整操作顺序', '<label>移动到第几段<select id="engage-order-position"></select></label><div class="material-actions"><button type="button" class="primary" id="engage-order-confirm">确定</button></div>');
  const groupDialog = dialog('engage-groups-dialog', '选择文案组', '<div id="engage-group-options" class="engage-group-options"></div><div class="material-actions"><button type="button" class="primary" id="engage-groups-confirm">确定</button></div>');

  function markDirty() { dirty = true; $('#engage-save-status').textContent = '有未保存修改'; renderSummary(); }
  function normalizeDraft(value) {
    const normalized = normalizeEngageSettings(value);
    normalized.actionPlan = normalized.actionPlan.map((item, index) => ({ ...item, segmentId: item.segmentId || normalized.segmentIds?.[index] || stamp() }));
    return normalized;
  }
  function hydrate(next) {
    if (initialized) return;
    config = normalizeDraft(next || {}); initialized = true;
    paintInputs(); renderDraft();
  }
  function paintInputs() {
    $('#engage-links').value = (config.links || []).join('\n');
    $('#engage-rounds').value = config.rounds;
    $('#engage-round-interval').value = config.roundIntervalSeconds;
    $('#engage-inner-keyword').value = config.innerLikeKeyword;
    $('#engage-like-post').checked = config.likePost;
    $('#engage-black-uids').value = config.likeBlacklistProfiles.join('\n');
    blacklistBaseline = config.likeBlacklistProfiles.length ? null : ''; blacklistErrors = []; renderBlacklist();
    $('#engage-black-keywords').value = config.likeBlacklistKeywords.join('\n');
  }
  function validateLinks() {
    const lines = $('#engage-links').value.split(/\r?\n/), links = [], invalid = [];
    lines.forEach((line, index) => {
      const raw = line.trim(); if (!raw) return;
      let url; try { url = new URL(raw); } catch {}
      const host = url?.hostname;
      const path = url?.pathname || '';
      const post = /^(?:\/\d+\/[A-Za-z0-9]+|\/(?:detail|status)\/[A-Za-z0-9]+)$/.test(path);
      const safe = url && ['http:','https:'].includes(url.protocol) && !url.username && !url.password && (!url.port || ['80','443'].includes(url.port)) && ['weibo.com','www.weibo.com','m.weibo.cn','weibo.cn'].includes(host);
      if (!safe || !post) invalid.push({ line: index + 1, raw });
      else { url.hash = ''; url.search = ''; url.protocol = 'https:'; links.push(url.href); }
    });
    return { total: lines.filter(line => line.trim()).length, links: [...new Set(links)], invalid };
  }
  function renderLinks() {
    const { total, links, invalid } = validateLinks();
    $('#engage-links-count').textContent = '共 ' + total + ' 条 · 去重后 ' + links.length + ' 条';
    $('#engage-links-errors').textContent = invalid.length ? '第 ' + invalid.slice(0, 8).map(item => item.line).join('、') + ' 行链接无法识别，请使用完整微博详情链接。' : '';
    $('#engage-links').setAttribute('aria-invalid', String(invalid.length > 0));
  }
  function renderAccounts() {
    const accounts = getState()?.accounts || [];
    $('#engage-pick-accounts').textContent = '已选 ' + config.accountIds.length + ' 个账号 ▾';
    const names = accounts.filter(account => config.accountIds.includes(account.id)).map(account => account.nickname || account.name);
    $('#engage-account-summary').textContent = names.slice(0, 3).join('、') + (names.length > 3 ? ' 等' + names.length + '个账号' : '') || '选择参与本次任务的账号';
  }
  function renderPlan() {
    const rail = $('#engage-action-plan'), scroll = rail.scrollLeft;
    rail.innerHTML = config.actionPlan.map((item, index) => {
      const coupling = item.type === 'repost' ? 'alsoComment' : '';
      const specialOption = coupling
        ? '<label class="check-inline"><input type="checkbox" data-engage-couple="' + index + '"' + (item[coupling] ? ' checked' : '') + '>同时评论</label>'
        : item.type === 'comment_like' ? '<label class="check-inline"><input type="checkbox" data-engage-replies="' + index + '"' + (item.includeVisibleReplies ? ' checked' : '') + '>点可见楼中楼</label>' : '';
      return '<article class="engage-action-card" data-segment="' + esc(item.segmentId) + '"><div class="engage-action-head"><button type="button" class="engage-drag-handle" data-engage-drag="' + index + '" aria-label="拖动第' + (index + 1) + '段，点击可选择位置">⠿</button><label class="engage-kind-field"><span class="sr-only">操作类型</span><select data-engage-type="' + index + '">' + Object.entries(labels).filter(([type]) => type !== 'like').map(([type, text]) => '<option value="' + type + '"' + (item.type === type ? ' selected' : '') + '>' + text + '</option>').join('') + '</select></label><button type="button" class="engage-delete" data-engage-delete="' + index + '" aria-label="删除操作段">×</button></div><div class="engage-action-fields"><label>' + (item.type === 'comment_like' ? '数量（条）' : '次数') + '<input data-engage-count="' + index + '" type="number" min="1" max="100" value="' + item.count + '"></label><label>间隔（秒）<input data-engage-interval="' + index + '" type="number" min="0" max="3600" value="' + item.intervalSeconds + '"></label></div><div class="engage-action-options">' + specialOption + (item.type === 'repost' ? '<label><span class="sr-only">转发方式</span><select data-engage-form="' + index + '"><option value="text"' + (item.repostForm !== 'plain' ? ' selected' : '') + '>带文案</option><option value="plain"' + (item.repostForm === 'plain' ? ' selected' : '') + '>纯转发</option></select></label>' : '') + '</div></article>';
    }).join(''); rail.scrollLeft = scroll;
  }
  function renderDecorations() {
    $('#engage-decorations').innerHTML = ['repost','comment'].map(kind => {
      const d = config[kind + 'Decoration'];
      return '<div class="deco-row"><b class="deco-name">' + labels[kind] + '</b><label>添加方式<select data-engage-deco="mode" data-kind="' + kind + '">' + [['none','不添加'],['emoji','随机表情'],['number','顺序数字'],['emoji-and-number','表情和数字']].map(([mode,name]) => '<option value="' + mode + '"' + (d.mode === mode ? ' selected' : '') + '>' + name + '</option>').join('') + '</select></label>' + ['emojiPosition','numberPosition'].map((field, i) => '<label>' + (i ? '数字位置' : '表情位置') + '<select data-engage-deco="' + field + '" data-kind="' + kind + '"><option value="suffix"' + (d[field] !== 'prefix' ? ' selected' : '') + '>末尾</option><option value="prefix"' + (d[field] === 'prefix' ? ' selected' : '') + '>开头</option></select></label>').join('') + '<label class="deco-emojis">表情列表<input data-engage-deco="emojis" data-kind="' + kind + '" value="' + esc(d.emojis.join(' ')) + '"></label></div>';
    }).join(''); updateDecorationStates();
  }
  function updateDecorationStates() {
    for (const kind of ['repost','comment']) for (const [field, enabledModes] of [['emojiPosition',['emoji','emoji-and-number']],['numberPosition',['number','emoji-and-number']]]) {
      const input = $('[data-kind="' + kind + '"][data-engage-deco="' + field + '"]');
      input.disabled = !enabledModes.includes(config[kind + 'Decoration'].mode);
    }
  }
  function renderGroups() {
    const groups = getState()?.materialGroups || [];
    $('#engage-group-picks').innerHTML = ['repost','comment'].map(type => {
      const selected = config[type + 'GroupIds'];
      const names = groups.filter(group => group.type === type && selected.includes(group.id)).map(group => group.name);
      return '<label>' + labels[type] + '文案<button type="button" class="quiet engage-group-button" data-engage-pick-group="' + type + '"><span>' + esc(names.length ? names.join('、') : '全部' + labels[type] + '文案') + '</span><span>▾</span></button></label>';
    }).join('');
  }
  function renderSummary() {
    const parsed = validateLinks(), n = config.accountIds.length * parsed.links.length * config.rounds;
    const counts = { repost:0,comment:0,comment_like:0,like:config.likePost ? config.accountIds.length * parsed.links.length : 0 };
    for (const segment of config.actionPlan) {
      counts[segment.type] += n * segment.count;
      if (segment.type === 'repost' && segment.alsoComment) counts.comment += n * segment.count;
    }
    $('#engage-summary').textContent = config.accountIds.length + ' 账号 · ' + parsed.links.length + ' 链接 · 预计 ' + Object.entries(counts).map(([kind,count]) => labels[kind] + ' ' + count).join(' · ');
    const errors = [];
    if (!config.accountIds.length) errors.push('至少选择一个启用账号');
    const unavailableAccounts = config.accountIds.filter(id => !(getState()?.accounts || []).some(a => a.id === id && a.enabled));
    if (unavailableAccounts.length) errors.push('已选账号中有 ' + unavailableAccounts.length + ' 个已停用或删除，请重新确认账号选择');
    if (!parsed.links.length) errors.push('至少输入一条有效微博链接');
    if (parsed.invalid.length) errors.push('请修正无法识别的微博链接');
    if (!config.actionPlan.length) errors.push('至少添加一个操作段');
    if (blacklistErrors.length) errors.push('请修正作者主页黑名单中的错误行');
    const unavailable = !(getState()?.features?.engageV2);
    if (unavailable) errors.push('后端尚未更新：请先安全结束或暂停任务、结束验证后更新服务');
    $('#engage-errors').textContent = errors.join('；');
    $('#engage-start').disabled = Boolean(errors.length || submitting);
    return errors;
  }
  function selectPane(next) {
    pane = next;
    root.querySelectorAll('[data-engage-pane]').forEach(node => node.classList.toggle('hidden', node.dataset.engagePane !== next));
    root.querySelectorAll('[data-engage-tab]').forEach(tab => { tab.classList.toggle('on', tab.dataset.engageTab === next); tab.setAttribute('aria-selected', String(tab.dataset.engageTab === next)); });
  }
  function renderDraft() { renderAccounts(); renderPlan(); renderDecorations(); renderGroups(); renderLinks(); renderSummary(); selectPane(pane); }
  function getConfig() { return { ...structuredClone(config), links: validateLinks().links }; }
  async function save() {
    if (saving) return;
    if (editingJob) { await persistEdit({ resume:false }); return; }
    if (validateLinks().invalid.length) { selectPane('range'); $('#engage-links').focus(); toast('请先修正无效链接，再保存配置；不会丢弃错误行'); return; }
    if (!getState()?.features?.engageV2) return toast('当前后端尚未更新，暂时不能保存转赞评配置');
    if (!await resolveAuthors()) { selectPane('advanced'); $('#engage-black-uids').focus(); return; }
    saving = true; const snapshot = getConfig(), baseline = JSON.stringify(config);
    $('#engage-save').disabled = true;
    try {
      await request('/api/settings/engage', { method:'PUT', body:snapshot });
      if (JSON.stringify(config) === baseline) { dirty = false; $('#engage-save-status').textContent = '配置已保存'; }
      toast('转赞评配置已保存');
    } catch(error) { toast(error.message); }
    finally { saving = false; $('#engage-save').disabled = false; }
  }
  function renderRunCard() {
    const job = getState()?.engageJob;
    const states = {running:['运行中','ok'],waiting:['等待中','warn'],paused:['已暂停','warn'],completed:['已完成','ok'],stopped:['已停止','idle']};
    const [name, tone] = states[job?.status] || ['暂无任务','idle'];
    const editing = Boolean(editingJob && job && editingJob.id === job.id);
    $('#engage-run-status').textContent = editing ? '编辑中' : name; $('#engage-run-light').className = 'light ' + (editing ? 'warn' : tone);
    $('#engage-run-headline').textContent = editing ? '正在修改任务参数' : job ? job.status === 'stopped' ? '已手动停止' : job.status === 'completed' ? '本次任务已完成' : job.wait_reason || '转发、评论与点赞任务' : '配置转发、评论与点赞';
    $('#engage-run-tag').classList.toggle('hidden', !job);
    $('#engage-run-tag').textContent = job ? '第 ' + (job.progress?.currentRound || 1) + '/' + (job.config?.rounds || 1) + ' 轮' : '';
    const m = job?.metrics || {};
    $('#engage-run-metrics').innerHTML = [['success','成功'],['uncertain','待核对'],['failed','失败'],['skipped','跳过']].map(([key,label]) => '<span class="task-metric"><i class="light ' + ({success:'ok',uncertain:'warn',failed:'bad',skipped:'idle'}[key]) + '"></i><b>' + Number(m[key] || 0) + '</b>' + label + '</span>').join('');
    const progress = job?.progress || { percent: 0, processed: 0, total: 0 };
    $('#engage-run-progress').hidden = false;
    $('#engage-run-progress').innerHTML = '<div class="engage-progress-labels"><b>' + progress.percent + '%</b><span>已处理 ' + progress.processed + ' / ' + progress.total + ' 项</span></div><div class="engage-progress-track" role="progressbar" aria-label="转赞评任务进度" aria-valuemin="0" aria-valuemax="100" aria-valuenow="' + progress.percent + '"><div style="width:' + progress.percent + '%"></div></div>';
    $('#engage-run-detail').textContent = editing ? '保存后继续执行时，已完成记录会保留，剩余步骤按新参数运行。' : job ? job.wait_reason || job.cursor?.notice || (job.cursor?.current?.accountName ? job.cursor.current.accountName + ' · ' + (labels[job.cursor.current.kind] || '') : '任务记录已保存') : '输入微博链接，配置操作顺序后开始运行。';
    const verify = getState()?.engageVerification;
    const manual = verify?.session || verify?.barrier;
    let controls;
    if (!job || ['stopped','completed'].includes(job.status)) controls = '<button type="button" class="quiet" id="engage-new-task">新建任务</button>';
    else if (editing) controls = '<button type="button" class="quiet" id="engage-edit-save-resume">保存并继续</button><button type="button" class="text-button" id="engage-edit-cancel">取消修改</button><button type="button" class="text-button" data-engage-job="stop">停止</button>';
    else if (manual) controls = '<button type="button" class="text-button" data-engage-job="stop">停止</button>';
    else if (job.status === 'paused') {
      const editable = getState()?.engageEdit;
      const canEdit = editable?.canEdit && editable.jobId === job.id;
      controls = (canEdit ? '<button type="button" class="quiet" id="engage-edit">修改参数</button>' : '') + '<button type="button" class="quiet" data-engage-job="resume">继续</button><button type="button" class="text-button" data-engage-job="stop">停止</button>';
    } else controls = '<button type="button" class="quiet" data-engage-job="pause">暂停</button><button type="button" class="text-button" data-engage-job="stop">停止</button>';
    $('#engage-run-controls').innerHTML = controls;
    paintActionLabels();
  }
  function paintActionLabels() {
    $('#engage-save').textContent = editingJob ? '保存修改' : '设为默认';
    $('#engage-start').textContent = editingJob ? '保存并继续' : '开始运行';
  }
  async function beginEdit() {
    const job = getState()?.engageJob;
    if (!job) return;
    try {
      const result = await request('/api/jobs/' + job.id + '/edit');
      if (!result.canEdit) { toast('当前步骤尚未完全暂停，请等运行状态稳定后再修改'); renderRunCard(); return; }
      editOriginal = structuredClone(config);
      editingJob = { id: job.id, version: result.version };
      config = normalizeDraft(result.config); initialized = true;
      paintInputs(); renderDraft(); selectPane('range'); dirty = false;
      $('#engage-save-status').textContent = '正在修改已暂停任务';
      renderRunCard();
      toast('已载入当前任务参数');
    } catch (error) { toast(error.message); }
  }
  function cancelEdit() {
    if (!editingJob) return;
    config = normalizeDraft(editOriginal || getState()?.engageDefaults); initialized = true;
    editingJob = null; editOriginal = null; dirty = false;
    paintInputs(); renderDraft(); $('#engage-save-status').textContent = '';
    renderRunCard();
  }
  async function persistEdit({ resume }) {
    if (!editingJob || submitting) return false;
    if (validateLinks().invalid.length) { selectPane('range'); $('#engage-links').focus(); toast('请先修正无效链接，再保存任务参数；不会丢弃错误行'); return false; }
    if (!getState()?.features?.engageV2) { toast('当前后端尚未更新，暂时不能修改任务参数'); return false; }
    if (!await resolveAuthors()) { selectPane('advanced'); $('#engage-black-uids').focus(); return false; }
    submitting = true; renderSummary();
    try {
      const result = await request('/api/jobs/' + editingJob.id + '/edit', { method:'POST', body:{ config:getConfig(), version:editingJob.version, resume } });
      const next = result.job?.config || getConfig();
      config = normalizeDraft(next); initialized = true; paintInputs(); renderDraft(); dirty = false;
      if (resume) { editingJob = null; editOriginal = null; toast('任务已保存并按新参数继续运行'); }
      else { editingJob.version = result.version; editOriginal = structuredClone(config); $('#engage-save-status').textContent = '任务参数已保存'; toast('任务参数已保存，任务保持暂停'); }
      await refresh();
      return true;
    } catch (error) { toast(error.message); return false; }
    finally { submitting = false; renderSummary(); renderRunCard(); }
  }
  function renderRecent() {
    const rows = getState()?.engageRecentActions || [], box = $('#engage-recent-actions'), scroll = box.scrollTop;
    box.innerHTML = rows.slice(0, 40).map(item => {
      const shown = item.display_state || item.state, open = expandedRecent.has(item.id);
      const key = String(item.id || (item.started_at || item.created_at || '') + (item.kind || ''));
      const link = /^https?:\/\//.test(item.url || '');
      const detail = open ? "<div class='recent-detail'><div><span class='lbl'>返链</span>" + (link ? " <a href='" + esc(item.url) + "' target='_blank' rel='noreferrer'>" + esc(item.url) + "</a>" : ' 无返链') + "</div>" + (item.receipt_id ? "<div><span class='lbl'>回执</span>" + esc(item.receipt_id) + '</div>' : '') + (item.content ? "<div class='copy'><span class='lbl'>文案</span>" + esc(item.content) + '</div>' : '') + (item.error ? "<div><span class='lbl'>原因</span>" + esc(item.error) + '</div>' : '') + '</div>' : '';
      return "<article class='recent-row " + (open ? 'open' : '') + "' data-engage-recent='" + esc(key) + "' tabindex='0' role='button' aria-expanded='" + open + "'><i class='light " + lightFor(shown) + "'></i><time>" + esc(time(item.started_at || item.created_at)) + "</time><b>" + esc(item.account_name || '系统') + "</b><span class='recent-kind'>" + (labels[item.kind] || esc(item.kind)) + "</span><span class='recent-state " + esc(shown) + "'>" + stateLabel(shown) + "</span><span class='recent-caret'>" + (open ? '收起 ▴' : '展开 ▾') + '</span></article>' + detail;
    }).join('') || '<div class="empty">暂无转赞评记录</div>'; box.scrollTop = scroll;
  }
  function renderDaily() {
    const values = dailyDate && dailyValues ? dailyValues : getState()?.engageDailySuccess || {};
    $('#engage-daily-date-button').textContent = dailyDate && dailyDate !== localDate() ? dailyDate.slice(5).replace('-','/') : '今日';
    $('#engage-daily-stats').innerHTML = ['repost','comment','comment_like','like'].map(kind => '<span class="strip-item">' + labels[kind] + '<b data-engage-daily-kind="' + kind + '">' + Number(values[kind] || 0) + '</b></span>').join('');
    $('#engage-daily-date').max = localDate(); $('#engage-daily-date').value = dailyDate || localDate();
  }
  function renderLive() {
    if (!initialized) hydrate(getState()?.engageDefaults);
    renderRunCard(); renderRecent(); renderDaily(); renderSummary(); renderStatus(); renderTemplates();
    const groups = JSON.stringify(getState()?.materialGroups || []);
    if (groups !== lastGroups) {
      lastGroups = groups;
      for (const type of ['comment','repost']) {
        const ids = config[type + 'GroupIds'], next = ids.filter(id => (getState()?.materialGroups || []).some(group => group.type === type && group.id === id));
        if (next.length !== ids.length) { config[type + 'GroupIds'] = next; markDirty(); }
      }
      renderGroups();
    }
    renderAccounts();
  }

  function renderStatus() {
    const state = getState() || {}, network = state.engageNetwork || {}, browser = state.engageBrowser || {};
    const tone = network.state === 'online' ? 'ok' : network.state === 'offline' ? 'bad' : 'warn';
    const text = network.state === 'online' ? '在线' : network.state === 'offline' ? '离线' : network.lastCheckedAt ? '检测中' : '未检测';
    $('#engage-status-lights').innerHTML = '<span class="light-item" title="' + esc(network.lastCheckedAt ? '最近检测 ' + time(network.lastCheckedAt) : '尚无本页网络检测结果') + '"><i class="light ' + tone + '"></i>网络 ' + text + '</span><span class="light-item"><i class="light ' + (browser.busy ? 'blue' : 'idle') + '"></i>浏览器 ' + (browser.busy ? browser.owner === 'manual' ? '验证中' : '任务中' : '空闲') + '</span>';
  }
  function renderTemplates() {
    const templates = getState()?.engageTemplates || [], signature = JSON.stringify(templates);
    if (signature !== lastTemplates) {
      lastTemplates = signature;
      if (selectedTemplate && !templates.some(t => t.id === selectedTemplate)) selectedTemplate = '';
      $('#engage-template-select').innerHTML = '<option value="">未选择模板</option>' + templates.map(t => '<option value="' + esc(t.id) + '">' + esc(t.name) + '</option>').join('');
      $('#engage-template-select').value = selectedTemplate;
    }
    $('#engage-template-delete').disabled = !selectedTemplate || templateBusy;
    $('#engage-template-save').disabled = templateBusy;
    $('#engage-template-select').disabled = templateBusy;
  }
  function applyTemplate(id) {
    selectedTemplate = id;
    const template = (getState()?.engageTemplates || []).find(t => t.id === id);
    if (template) {
      const links = $('#engage-links').value, accountIds = [...config.accountIds];
      config = normalizeDraft({ ...template.config, accountIds, links: config.links });
      paintInputs(); $('#engage-links').value = links; renderDraft(); markDirty();
    }
    renderTemplates();
  }
  async function saveTemplate() {
    if (templateBusy) return;
    const id = selectedTemplate, template = (getState()?.engageTemplates || []).find(t => t.id === id);
    const name = template?.name || prompt('模板名称'); if (!name?.trim()) return;
    templateBusy = true; renderTemplates();
    try {
      if (!await resolveAuthors()) { selectPane('advanced'); $('#engage-black-uids').focus(); return; }
      const result = await request('/api/engage-templates' + (id ? '/' + encodeURIComponent(id) : ''), { method: id ? 'PUT' : 'POST', body: { name, config: engageTemplateConfig(getConfig()) } });
      selectedTemplate = result.id; await refresh(); $('#engage-template-select').value = selectedTemplate; toast('转赞评模板已保存');
    } catch (error) { toast(error.message); }
    finally { templateBusy = false; renderTemplates(); }
  }
  async function deleteTemplate() {
    if (!selectedTemplate || templateBusy || !confirm('删除此转赞评模板？当前配置不会清空。')) return;
    templateBusy = true; renderTemplates();
    try { await request('/api/engage-templates/' + encodeURIComponent(selectedTemplate), { method: 'DELETE' }); selectedTemplate = ''; await refresh(); toast('模板已删除，当前配置保留'); }
    catch (error) { toast(error.message); }
    finally { templateBusy = false; renderTemplates(); }
  }
  function renderBlacklist() {
    const box = $('#engage-blacklist-results');
    box.textContent = blacklistErrors.length ? blacklistErrors.map(row => '第 ' + row.line + ' 行：' + row.error).join('；') : blacklistBaseline === $('#engage-black-uids').value ? (config.likeBlacklistUids.length ? '已识别 ' + config.likeBlacklistUids.length + ' 位作者' : '') : '输入后自动识别；无法解析时请使用含 UID 的主页链接';
    $('#engage-black-uids').setAttribute('aria-invalid', String(blacklistErrors.length > 0));
  }
  async function resolveAuthors() {
    const raw = $('#engage-black-uids').value;
    if (blacklistBaseline === raw) return !blacklistErrors.length;
    if (blacklistFlight?.raw === raw) return blacklistFlight.promise;
    const flight = { raw }; blacklistFlight = flight;
    $('#engage-blacklist-results').textContent = '正在识别主页作者…';
    flight.promise = (async () => {
      try {
        const result = await request('/api/engage/blacklist/resolve', { method:'POST', body:{ profiles:raw.split(/\r?\n/) } });
        if ($('#engage-black-uids').value !== raw) return false;
        blacklistErrors = result.results.filter(row => row.error); blacklistBaseline = raw;
        if (!blacklistErrors.length) config.likeBlacklistUids = result.uids;
        renderBlacklist(); renderSummary();
        return !blacklistErrors.length;
      } catch (error) {
        if ($('#engage-black-uids').value === raw) { blacklistErrors = [{line:1,error:error.message}]; renderBlacklist(); renderSummary(); }
        toast(error.message); return false;
      } finally { if (blacklistFlight === flight) blacklistFlight = null; }
    })();
    return flight.promise;
  }
  $('#engage-black-uids').addEventListener('blur', () => { void resolveAuthors(); });
  async function run() {
    if (submitting || renderSummary().length) return;
    if (editingJob) { await persistEdit({ resume:true }); return; }
    submitting = true; renderSummary();
    try { if (!await resolveAuthors()) { selectPane('advanced'); $('#engage-black-uids').focus(); return; } await start(getConfig()); } catch(error) { toast(error.message); }
    finally { submitting = false; renderSummary(); }
  }
  function reorder(from, to) {
    const [item] = config.actionPlan.splice(from,1); config.actionPlan.splice(to,0,item); renderPlan(); markDirty();
  }
  root.addEventListener('click', async event => {
    const recent = event.target.closest('[data-engage-recent]');
    if (recent) { const id = recent.dataset.engageRecent; expandedRecent.has(id) ? expandedRecent.delete(id) : expandedRecent.add(id); renderRecent(); return; }
    const button = event.target.closest('button'); if (!button) return;
    if (button.dataset.engageTab) return selectPane(button.dataset.engageTab);
    if (button.id === 'engage-pick-accounts') return openAccounts();
    if (button.id === 'engage-start') return run();
    if (button.id === 'engage-save') return save();
    if (button.id === 'engage-edit') return beginEdit();
    if (button.id === 'engage-edit-cancel') return cancelEdit();
    if (button.id === 'engage-edit-save-resume') return persistEdit({ resume:true });
    if (button.id === 'engage-template-save') return saveTemplate();
    if (button.id === 'engage-template-delete') return deleteTemplate();
    if (button.id === 'engage-new-task') { $('#engage-config-card').scrollIntoView({behavior:'smooth',block:'start'}); selectPane('range'); $('#engage-links').focus({preventScroll:true}); return; }
    if (button.id === 'engage-add-action') return addDialog.showModal();
    if (button.dataset.engageDelete != null) { config.actionPlan.splice(Number(button.dataset.engageDelete),1); renderPlan(); markDirty(); return; }
    if (button.dataset.engageDrag != null && !moved) { editId = config.actionPlan[Number(button.dataset.engageDrag)].segmentId; orderDialog.querySelector('select').innerHTML = config.actionPlan.map((item,index) => '<option value="' + index + '">第 ' + (index+1) + ' 段 · ' + labels[item.type] + '</option>').join(''); orderDialog.querySelector('select').value = button.dataset.engageDrag; orderDialog.showModal(); return; }
    if (button.dataset.engagePickGroup) {
      groupsType = button.dataset.engagePickGroup; groupsBaseline = JSON.stringify(config[groupsType + 'GroupIds']);
      const groups = (getState()?.materialGroups || []).filter(group => group.type === groupsType);
      groupDialog.querySelector('h2').textContent = '选择' + labels[groupsType] + '文案组';
      groupDialog.querySelector('#engage-group-options').innerHTML = '<label class="check-inline"><input type="checkbox" value="__all"' + (!config[groupsType + 'GroupIds'].length ? ' checked' : '') + '>全部' + labels[groupsType] + '文案</label>' + groups.map(group => '<label class="check-inline"><input type="checkbox" value="' + esc(group.id) + '"' + (config[groupsType + 'GroupIds'].includes(group.id) ? ' checked' : '') + '>' + esc(group.name) + '</label>').join('');
      groupDialog.showModal(); return;
    }
    if (button.dataset.engageJob) {
      const job = getState()?.engageJob; if (!job) return;
      try { await request('/api/jobs/' + job.id + '/' + button.dataset.engageJob, { method:'POST' }); await refresh(); } catch(error) { toast(error.message); }
    }
  });
  root.addEventListener('keydown', event => {
    if (event.key !== 'Enter' && event.key !== ' ') return;
    const recent = event.target.closest('[data-engage-recent]');
    if (!recent) return;
    event.preventDefault();
    const id = recent.dataset.engageRecent; expandedRecent.has(id) ? expandedRecent.delete(id) : expandedRecent.add(id); renderRecent();
  });
  addDialog.addEventListener('click', event => {
    const type = event.target.closest('[data-engage-add]')?.dataset.engageAdd; if (!type) return;
    config.actionPlan.push({ type, count:DEFAULT_ENGAGE_COUNTS[type], intervalSeconds:DEFAULT_ENGAGE_INTERVALS[type], segmentId:stamp(), repostForm:config.repostForm, alsoComment:false, alsoRepost:false, includeVisibleReplies:false });
    addDialog.close(); renderPlan(); markDirty();
  });
  orderDialog.querySelector('#engage-order-confirm').onclick = () => { const from = config.actionPlan.findIndex(item => item.segmentId === editId); if (from >= 0) reorder(from, Number(orderDialog.querySelector('select').value)); orderDialog.close(); };
  groupDialog.addEventListener('change', event => {
    const all = groupDialog.querySelector('input[value="__all"]');
    if (event.target === all && all.checked) groupDialog.querySelectorAll('input:not([value="__all"])').forEach(input => { input.checked=false; });
    else if (event.target.checked) all.checked = false;
  });
  groupDialog.querySelector('#engage-groups-confirm').onclick = () => {
    config[groupsType+'GroupIds'] = groupDialog.querySelector('input[value="__all"]').checked ? [] : [...groupDialog.querySelectorAll('input:checked')].map(input=>input.value);
    if (JSON.stringify(config[groupsType+'GroupIds']) !== groupsBaseline) markDirty(); renderGroups(); groupDialog.close();
  };
  root.addEventListener('input', event => {
    const input = event.target;
    if (input.dataset.engageCount != null) config.actionPlan[Number(input.dataset.engageCount)].count = clamp(input.value,1,100,10);
    else if (input.dataset.engageInterval != null) config.actionPlan[Number(input.dataset.engageInterval)].intervalSeconds = clamp(input.value,0,3600,3);
    else if (input.dataset.engageDeco) {
      const value = input.dataset.engageDeco === 'emojis' ? input.value.split(/[\s,，]+/).filter(Boolean) : input.value;
      config[input.dataset.kind + 'Decoration'][input.dataset.engageDeco] = value; updateDecorationStates();
    } else if (input.id === 'engage-links') { config.links = input.value.split(/\r?\n/); renderLinks(); }
    else if (input.id === 'engage-rounds') config.rounds = clamp(input.value,1,100,1);
    else if (input.id === 'engage-round-interval') config.roundIntervalSeconds = clamp(input.value,0,86400,60);
    else if (input.id === 'engage-inner-keyword') { config.innerLikeKeyword = input.value.trim(); config.innerLikeKeywords = splitEngageKeywords(input.value); }
    else if (input.id === 'engage-black-uids') { config.likeBlacklistProfiles = input.value.split(/\r?\n/).map(s=>s.trim()).filter(Boolean); blacklistBaseline = null; blacklistErrors = []; renderBlacklist(); }
    else if (input.id === 'engage-black-keywords') config.likeBlacklistKeywords = input.value.split(/\r?\n/).map(s=>s.trim()).filter(Boolean);
    else return;
    markDirty();
  });
  root.addEventListener('change', event => {
    const input = event.target;
    if (input.id === 'engage-template-select') { applyTemplate(input.value); return; }
    if (input.dataset.engageType != null) { const segment = config.actionPlan[Number(input.dataset.engageType)]; segment.type = input.value; segment.segmentId = stamp(); segment.count = DEFAULT_ENGAGE_COUNTS[input.value]; segment.intervalSeconds = 3; segment.alsoComment = false; segment.alsoRepost = false; segment.includeVisibleReplies = false; renderPlan(); }
    else if (input.dataset.engageCouple != null) { const segment = config.actionPlan[Number(input.dataset.engageCouple)]; if (segment.type === 'repost') segment.alsoComment = input.checked; segment.alsoRepost = false; renderPlan(); }
    else if (input.dataset.engageReplies != null) config.actionPlan[Number(input.dataset.engageReplies)].includeVisibleReplies = input.checked;
    else if (input.dataset.engageForm != null) config.actionPlan[Number(input.dataset.engageForm)].repostForm = input.value;
    else if (input.id === 'engage-like-post') config.likePost = input.checked;
    else if (input.dataset.engageDeco) { config[input.dataset.kind+'Decoration'][input.dataset.engageDeco] = input.value; updateDecorationStates(); }
    else return; markDirty();
  });
  root.addEventListener('pointerdown', event => {
    const handle = event.target.closest('[data-engage-drag]'); if (!handle) return;
    moved = false; drag = { from:Number(handle.dataset.engageDrag), handle, startX:event.clientX, node:handle.closest('.engage-action-card') }; handle.setPointerCapture?.(event.pointerId);
  });
  root.addEventListener('pointermove', event => {
    if (!drag || Math.abs(event.clientX-drag.startX)<5) return;
    moved = true; drag.node.classList.add('dragging'); const rail=$('#engage-action-plan'), bounds=rail.getBoundingClientRect();
    if (event.clientX > bounds.right-30) rail.scrollLeft += 16;
    if (event.clientX < bounds.left+30) rail.scrollLeft -= 16;
  });
  root.addEventListener('pointerup', event => {
    if (!drag) return; const current=drag; drag=null; current.node.classList.remove('dragging');
    if (moved) { const nodes=[...$('#engage-action-plan').children]; let to=current.from, distance=Infinity; nodes.forEach((node,index)=>{const b=node.getBoundingClientRect(),d=Math.abs(event.clientX-b.x-b.width/2);if(d<distance){distance=d;to=index;}}); reorder(current.from,to); setTimeout(()=>{moved=false;},150); }
  });
  root.addEventListener('pointercancel',()=>{drag?.node.classList.remove('dragging');drag=null;moved=false;});
  $('#engage-daily-date-button').onclick = () => $('#engage-date-popover').classList.toggle('hidden');
  $('#engage-today').onclick = () => { dailyVersion++; dailyDate=null; dailyValues=null; $('#engage-date-popover').classList.add('hidden'); renderDaily(); };
  $('#engage-daily-date').onchange = async event => {
    const date=event.target.value, version=++dailyVersion; if (!date) return;
    try { const records=await request('/api/records?date='+encodeURIComponent(date)); if(version!==dailyVersion)return;dailyDate=date;dailyValues=records.engageDailySuccess || {}; renderDaily(); }
    catch(error){toast(error.message);} finally{$('#engage-date-popover').classList.add('hidden');}
  };
  return { hydrate, renderLive, render:renderDraft, getConfig, setAccounts(ids) { config.accountIds=[...new Set(ids)].filter(id => (getState()?.accounts || []).some(a => a.id === id && a.enabled)); renderAccounts(); markDirty(); }, isDirty:()=>dirty };
}
