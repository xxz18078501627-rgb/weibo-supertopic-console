import {
  DEFAULT_EMOJIS,
  DEFAULT_ACTION_INTERVALS,
  normalizeActionPlan,
  normalizeTaskSettings,
} from "./defaults.js";
import { createGroupUI } from "./group-ui.js";
import { createVerificationUI } from "./verification-ui.js";
import { renderDailyStop } from "./daily-stop-ui.js";
import { createReportUI, renderRecordJobs, localDate } from "./report-ui.js";
import { createRecordUI } from "./record-ui.js";
let verificationUI,
  groupUI,
  reportUI,
  events,
  eventsConnected = false,
  lastEventAt = 0,
  fallbackLoading = false,
  stateRequestVersion = 0,
  recordsVersion = 0;
const $ = (s) => document.querySelector(s),
  $$ = (s) => [...document.querySelectorAll(s)];
const meta = {
  overview: ["超话工作台", "配置下一次任务，或查看正在运行的任务。"],
  accounts: ["账号", "管理登录、启停与执行顺序。"],
  materials: ["文案", "准备发帖和评论内容。"],
  logs: ["记录", "查看任务、结果和待核对项目。"],
};
const defaults = {
  rounds: 1,
  actionPlan: [
    { type: "checkin", count: 1, intervalSeconds: 5 },
    { type: "comment", count: 4, intervalSeconds: 3 },
    { type: "post", count: 10, intervalSeconds: 10 },
  ],
  commentStrategy: "random",
  commentSection: "",
  scanLimit: 30,
  commentMaxCountEnabled: false,
  commentMaxCount: 20,
  candidateRefreshSeconds: 3,
  roundIntervalSeconds: 60,
  ...normalizeTaskSettings(),
};
let state,
  config = structuredClone(defaults),
  page = "overview",
  toastTimer,
  selectedAccounts = new Set(),
  selectedMaterials = { post: new Set(), comment: new Set() },
  selectedTemplate = "",
  editingJob = null,
  editingBaseline = null;
const esc = (v = "") =>
  String(v).replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ],
  );
function toast(message) {
  const el = $("#toast");
  el.textContent = message;
  el.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove("show"), 2800);
}
async function request(path, options = {}) {
  const response = await fetch(path, {
    ...options,
    headers: { "Content-Type": "application/json", ...(options.headers || {}) },
    body:
      options.body && typeof options.body !== "string"
        ? JSON.stringify(options.body)
        : options.body,
  });
  const data = await response.json().catch(() => ({}));
  if (response.status === 401) {
    if (data.code === "license_required") return showActivate();
    showLogin();
    throw new Error(data.error || "请重新登录");
  }
  if (!response.ok)
    throw new Error(
      data.error || data.detail || `请求失败（${response.status}）`,
    );
  return data;
}
function showLogin() {
  $("#activate").classList.add("hidden");
  $("#login").classList.remove("hidden");
  $("#app").classList.add("hidden");
}
function showActivate() {
  $("#login").classList.add("hidden");
  $("#app").classList.add("hidden");
  $("#activate").classList.remove("hidden");
  $("#license-code")?.focus();
}
function showApp() {
  $("#activate").classList.add("hidden");
  $("#login").classList.add("hidden");
  $("#app").classList.remove("hidden");
}
function merge(value = {}) {
  return {
    ...structuredClone(defaults),
    ...value,
    actionPlan:
      Array.isArray(value.actionPlan) && value.actionPlan.length
        ? normalizeActionPlan(value.actionPlan, value)
        : structuredClone(defaults.actionPlan),
    ...normalizeTaskSettings(value),
  };
}
async function load({ keep = false } = {}) {
  const version = ++stateRequestVersion;
  const next = await request("/api/state");
  if (version !== stateRequestVersion) return;
  if (!acceptState(next)) return;
  if (!keep) config = merge(state.taskDefaults);
  seedSelections();
  if (!keep) render();
  else {
    renderLive();
    if (!isEditing()) {
      renderAccounts();
      renderSelection();
          renderMaterials();
      renderTemplate();
    }
  }
}
function acceptState(next) {
  const oldService = state?.service?.startedAt, newService = next.service?.startedAt;
  if (oldService && newService && Date.parse(newService) < Date.parse(oldService)) return false;
  const sameService = oldService === newService;
  if (sameService && Number(next.stateVersion || 0) < Number(state?.stateVersion || 0)) return false;
  if (sameService && Number(next.verificationVersion || 0) < Number(state?.verificationVersion || 0)) {
    next.verification = state.verification;
    next.verificationVersion = state.verificationVersion;
  }
  state = next; return true;
}
async function syncLiveState() {
  if (!state || fallbackLoading) return;
  fallbackLoading = true;
  try { await load({ keep: true }); } catch {} finally { fallbackLoading = false; }
}
function seedSelections() {
  if (!config.accountIds)
    config.accountIds = state.accounts
      .filter((x) => x.enabled)
      .map((x) => x.id);
  config.topicIds = state.fixedTopic ? [state.fixedTopic.id] : state.topics.filter((x) => x.enabled).map((x) => x.id);
}
function navigate(next, { scrollTop = true } = {}) {
  page = next;
  $$(".page").forEach((x) =>
    x.classList.toggle("active", x.id === `page-${next}`),
  );
  $$("[data-page]").forEach((x) =>
    x.classList.toggle("active", x.dataset.page === next),
  );
  $("#page-title").textContent = meta[next][0];
  $("#page-subtitle").textContent = meta[next][1];
  $("#page-subtitle").hidden = next !== "overview";
  const brandSub = document.querySelector('.brand-sub');
  if (brandSub) brandSub.hidden = next !== 'overview';
  if (next === "logs") loadRecords(recordDate).catch(() => {});
  if (scrollTop) window.scrollTo({ top: 0, behavior: "smooth" });
}
function taskEditDirty() {
  return Boolean(editingJob && editingBaseline && JSON.stringify(config) !== JSON.stringify(editingBaseline));
}
function revealTaskConfiguration() {
  document.querySelector("#config-card")?.scrollIntoView({ block: "start", behavior: "smooth" });
  setTimeout(() => {
    document.querySelector(
      '#pick-accounts, #add-action, #rounds, #template-select',
    )?.focus({ preventScroll: true });
  }, 350);
}
function render() {
  const subtitle = document.querySelector('.brand-sub');
  if (subtitle) subtitle.hidden = page !== 'overview';
  if (!state) return;
  renderBrowser();
  renderOverview();
  renderAccounts();
  renderMaterials();
  renderLogs();
  reportUI?.render();
  renderDailyStop(state);
  verificationUI?.render();
}
function renderBrowser() {
  const task = state.browser?.busy ? "任务后台运行" : "";
  const login = state.loginBrowser?.busy ? "扫码登录中" : "";
  $("#browser-badge").textContent =
    [task, login].filter(Boolean).join(" · ") || "浏览器空闲";
  renderLanAccess();
}
function renderLanAccess() {
  const lan = state?.lanAccess || {};
  const network = document.querySelector('#lan-network');
  const ipUrl = document.querySelector('#lan-ip-url');
  const hostUrl = document.querySelector('#lan-host-url');
  const extra = document.querySelector('#lan-extra-urls');
  if (network) network.textContent = lan.ip ? (lan.interface || 'LAN') + ' · ' + lan.ip : '未检测到局域网地址，请先确认电脑已连接 Wi-Fi 或 Ethernet。';
  if (ipUrl) ipUrl.textContent = lan.ipUrl || '未检测到';
  if (hostUrl) hostUrl.textContent = lan.hostnameUrl || '未检测到';
  if (extra) {
    const others = (lan.addresses || []).filter(item => item.url !== lan.ipUrl);
    extra.innerHTML = others.map(item => '<div class="lan-url-row"><span>' + esc(item.interface || 'LAN') + '</span><code>' + esc(item.url) + '</code><button type="button" class="text-button" data-copy-lan-url="' + esc(item.url) + '">复制</button></div>').join('');
  }
}
async function refreshLanAccess() {
  const next = await request('/api/state');
  if (next?.lanAccess) state.lanAccess = next.lanAccess;
  renderLanAccess();
  const qr = document.querySelector('#lan-qr');
  if (qr) {
    if (state?.lanAccess?.qrUrl) {
      qr.hidden = false;
      qr.src = '/api/lan-qr.svg?ts=' + Date.now();
    } else {
      qr.hidden = true;
      qr.removeAttribute('src');
    }
  }
}
async function openLanAccessDialog() {
  renderLanAccess();
  const dialog = document.querySelector('#lan-access-dialog');
  if (!dialog) return;
  if (dialog.open) dialog.close();
  dialog.showModal();
  try { await refreshLanAccess(); } catch (error) { toast(error.message); }
}
const status = {
  running: ["运行中", "running"],
  waiting: ["等待中", "waiting"],
  paused: ["已暂停", "waiting"],
  completed: ["已完成", "completed"],
  stopped: ["已停止", "idle"],
  failed: ["失败", "idle"],
};
function lightFor(value) {
  return { succeeded: "ok", failed: "bad", uncertain: "warn", submitted: "warn", skipped: "idle", verification_wait: "warn", cancelled: "idle" }[value] || "idle";
}
function renderLights() {
  const node = $("#status-lights");
  if (!node) return;
  const network = state.network || {}, browser = state.browser || {}, login = state.loginBrowser || {}, stop = state.dailyStop || {};
  const netTone = network.state === "online" ? "ok" : network.state === "offline" ? "bad" : "warn";
  const netText = network.state === "online" ? "在线" : network.state === "offline" ? "离线" : "检测中";
  const netTitle = [network.lastProbe?.latencyMs != null ? "延迟 " + network.lastProbe.latencyMs + "ms" : "", network.lastCheckedAt ? "最近检测 " + time(network.lastCheckedAt, true) : ""].filter(Boolean).join(" · ");
  const browserText = browser.busy ? (browser.owner === "manual" ? "验证中" : "任务中") : login?.busy ? "扫码中" : "空闲";
  const browserTone = browser.busy ? "blue" : login?.busy ? "warn" : "idle";
  const stopText = stop.blocked ? "已过截止" : (stop.time || "23:59") + " 截止";
  node.innerHTML = "<span class='light-item' title='" + esc(netTitle) + "'><i class='light " + netTone + "'></i>网络 " + netText + "</span><span class='light-item'><i class='light " + browserTone + "'></i>浏览器 " + browserText + "</span><span class='light-item'><i class='light " + (stop.blocked ? "bad" : "warn") + "'></i>" + stopText + "</span>";
}
let recentFallback = null, recentFallbackAt = 0, recentLoading = false, expandedRecent = "";
function recentRow(item) {
  const key = String(item.id || (item.started_at || item.created_at || "") + (item.kind || ""));
  const open = key === expandedRecent;
  const link = /^https?:\/\//.test(item.url || "");
  const detail = open ? "<div class='recent-detail'><div><span class='lbl'>返链</span>" + (link ? " <a href='" + esc(item.url) + "' target='_blank' rel='noreferrer'>" + esc(item.url) + "</a>" : " 无返链") + "</div>" + (item.receipt_id ? "<div><span class='lbl'>回执</span>" + esc(item.receipt_id) + "</div>" : "") + (item.content ? "<div class='copy'><span class='lbl'>文案</span>" + esc(item.content) + "</div>" : "") + (item.error ? "<div><span class='lbl'>原因</span>" + esc(item.error) + "</div>" : "") + "</div>" : "";
  return "<article class='recent-row " + (open ? "open" : "") + "' data-recent='" + esc(key) + "' tabindex='0' role='button'><i class='light " + lightFor(item.state) + "'></i><time>" + time(item.started_at || item.created_at) + "</time><b>" + esc(item.account_name || "系统") + "</b><span class='recent-kind'>" + kind(item.kind) + "</span><span class='recent-state " + (item.state || "") + "'>" + (stateName(item.state) || '') + "</span><span class='recent-caret'>" + (open ? "收起 ▴" : "展开 ▾") + "</span></article>" + detail;
}
function recentRows() {
  const live = (state?.recentActions || []).slice(0, 20);
  return live.length ? live : (recentFallback || []).slice(0, 20);
}
async function loadRecentFallback() {
  if (recentLoading || (recentFallback && Date.now() - recentFallbackAt < 15000)) return;
  recentLoading = true;
  try {
    const today = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Shanghai" }).format(new Date());
    const data = await request("/api/records?date=" + today + "&panel=flow&limit=20");
    recentFallback = (data.recordView?.details || []).filter(row => row.source === 'action').map(row => ({ ...row, started_at: row.at || row.created_at }));
    recentFallbackAt = Date.now();
  } catch { recentFallback = recentFallback || []; }
  finally { recentLoading = false; renderRecent(); }
}
function renderRecent() {
  const node = $("#recent-actions");
  if (!node) return;
  const rows = recentRows();
  node.innerHTML = rows.length ? rows.map(recentRow).join("") : "<div class='empty'>暂无运行记录</div>";
  if (!rows.length && !recentLoading) void loadRecentFallback();
}
let configPane = 'range';
function selectConfigPane(name) {
  if (!['range', 'plan', 'advanced'].includes(name)) return;
  configPane = name;
  for (const button of document.querySelectorAll('.config-tabs [data-pane]')) {
    const on = button.dataset.pane === name;
    button.classList.toggle('on', on);
    button.setAttribute('aria-selected', String(on));
  }
  for (const pane of document.querySelectorAll('#config-card .config-body .pane')) pane.classList.toggle('hidden', pane.dataset.pane !== name);
}
document.querySelectorAll('.config-tabs [data-pane]').forEach(button => button.addEventListener('click', () => selectConfigPane(button.dataset.pane)));
document.querySelector('#config-prev')?.addEventListener('click', () => selectConfigPane({ range: 'advanced', plan: 'range', advanced: 'plan' }[configPane]));
document.querySelector('#config-next')?.addEventListener('click', () => selectConfigPane({ range: 'plan', plan: 'advanced', advanced: 'range' }[configPane]));
document.querySelector('#toggle-decorations')?.addEventListener('click', () => document.querySelector('#text-decorations')?.classList.toggle('hidden'));
document.addEventListener('click', event => {
  const row = event.target.closest('[data-recent]');
  if (!row || event.target.closest('a')) return;
  expandedRecent = expandedRecent === row.dataset.recent ? '' : row.dataset.recent;
  renderRecent();
});
document.addEventListener('keydown', event => {
  if (event.key !== 'Enter' && event.key !== ' ') return;
  const row = event.target.closest?.('[data-recent]');
  if (!row) return;
  event.preventDefault();
  expandedRecent = expandedRecent === row.dataset.recent ? '' : row.dataset.recent;
  renderRecent();
});
function renderOverview({ configFields = true } = {}) {
  const job = state.activeJob || state.recentJobs[0], card = $("#run-card");
  renderLights();
  if (!$("#run-progress")) {
    const progress = document.createElement("div");
    progress.id = "run-progress";
    progress.className = "task-progress";
    $("#run-metrics").after(progress);
  }
  const progress = job?.progress;
  $("#run-progress").hidden = !progress;
  if (progress) {
    const percent = Math.max(0, Math.min(100, Number(progress.percent) || 0));
    const note = (progress.rounds > 1 || progress.planAdjusted) ? "<p class='task-progress-note'>" + (progress.rounds > 1 ? "当前第 " + progress.currentRound + " / " + progress.rounds + " 轮" : "") + (progress.planAdjusted ? (progress.rounds > 1 ? " · " : "") + "计划已调整" : "") + "</p>" : "";
    $("#run-progress").innerHTML = "<div class='task-progress-label'><strong>" + percent + "%</strong><span>已处理 " + progress.processed + " / " + progress.total + " 项</span></div><div class='task-progress-track' role='progressbar' aria-label='任务进度' aria-valuemin='0' aria-valuemax='100' aria-valuenow='" + percent + "' aria-valuetext='" + percent + "%，已处理 " + progress.processed + " / " + progress.total + " 项'><div class='task-progress-fill' style='width:" + percent + "%'></div></div>" + note;
  }
  card.className = "run-card task-card " + (status[job?.status]?.[1] || "idle");
  const tone = { running: "ok", waiting: "warn", paused: "warn", completed: "ok", stopped: "idle", failed: "bad" }[job?.status] || "idle";
  if ($("#run-light")) $("#run-light").className = "light " + tone;
  $("#run-status").textContent = job ? status[job.status]?.[0] || job.status : "暂无任务";
  const cur = job?.cursor?.current;
  const tagNode = $("#run-tag");
  if (job) {
    $("#run-headline").textContent = job.status === "completed" ? "任务已完成" : job.cursor?.stopReason || job.wait_reason || (cur ? cur.topicName + " · " + cur.accountName : "正在准备任务");
    const tag = [];
    if (progress) tag.push(progress.rounds > 1 ? "第 " + progress.currentRound + "/" + progress.rounds + " 轮" : "第 1/1 轮");
    if (cur && ["running", "waiting", "paused"].includes(job.status)) tag.push("正在" + kind(cur.kind));
    if (editingJob) tag.push("编辑中");
    if (tagNode) { tagNode.textContent = tag.join(" · "); tagNode.classList.toggle("hidden", !tag.length); }
    $("#run-detail").textContent = job.status === "stopped" ? job.cursor?.stopReason || "任务已停止" : cur ? "第 " + (cur.round + 1) + " 轮，正在执行" + kind(cur.kind) : "创建于 " + time(job.created_at, true);
    const connection = job.cursor?.networkRecovery;
    const active = ["running", "waiting", "paused"].includes(job.status);
    const checked = connection?.lastCheckedAt ? "最近检测 " + time(connection.lastCheckedAt, true) : "等待首次检测";
    if (active && connection?.state === "offline") {
      $("#run-detail").textContent = job.pausedByUser ? "已改为手动暂停，联网后不会自动开始。" : "网络中断，任务已自动暂停。每 5 秒检测网络，连续两次连通后自动继续。" + checked;
    } else if (active && connection) {
      if (connection.probeState === "unknown" || connection.probeState === "offline") $("#run-detail").textContent = "检测暂不可用，尚未确认断网。" + checked;
      else if (connection.restoredAt && Date.now() - Date.parse(connection.restoredAt) < 10000) $("#run-detail").textContent = "网络已恢复，正在接续原任务。";
      else if (cur?.kind === "comment" && job.cursor?.commentScan?.stepKey === cur.round + ":" + cur.topicId + ":" + cur.accountId + ":" + (cur.segmentId || cur.actionIndex) + ":" + cur.unitIndex && job.status === "waiting") $("#run-detail").textContent = "网络正常，正在筛选评论目标。" + checked;
      else $("#run-detail").textContent = "网络正常 · " + checked;
    }
    if (editingJob) {
      $("#run-status").textContent = "编辑中";
      $("#run-headline").textContent = "正在修改任务参数";
      $("#run-detail").textContent = "未保存的修改会在继续运行时生效。";
    }
    const m = job.metrics || {};
    $("#run-metrics").innerHTML = [["success", "成功", "ok"], ["uncertain", "待核对", "warn"], ["failed", "失败", "bad"], ["skipped", "跳过", "idle"]]
      .map(item => "<span class='task-metric'><i class='light " + item[2] + "'></i><b>" + (m[item[0]] || 0) + "</b>" + item[1] + "</span>").join("");
    $("#run-controls").innerHTML = controls(job);
  } else {
    $("#run-headline").textContent = "暂无任务";
    $("#run-detail").textContent = "在下方选账号、超话和操作顺序，然后开始运行。";
    if (tagNode) { tagNode.textContent = ""; tagNode.classList.add("hidden"); }
    $("#run-metrics").innerHTML = "";
    $("#run-controls").innerHTML = "";
  }
  if (configFields) {
    if ($("#save-task")) $("#save-task").textContent = editingJob ? "保存修改" : "设为默认";
    $("#start-task").textContent = editingJob ? "保存并继续运行" : "开始运行";
    renderTemplate();
    renderSelection();
    renderPlan();
    renderSettings();
  }
  renderRecent();
}
function controls(job) {
  if (editingJob)
    return `<button data-edit-action="save-resume" type="button">保存并继续运行</button><button data-edit-action="cancel" type="button">取消修改</button><button data-job-action="stop" data-job="${job.id}" type="button">停止任务</button>`;
  if (job.status === 'paused' && !job.pausedByUser && job.cursor?.networkRecovery?.state === 'offline')
    return `<button data-job-action="pause" data-job="${job.id}">改为手动暂停</button><button data-job-action="stop" data-job="${job.id}">停止</button>`;
  if (
    state.verification?.jobId === job.id &&
    (state.verification.session || state.verification.barrier)
  )
    return `<button data-job-action="stop" data-job="${job.id}">停止任务</button>`;
  if (["running", "waiting"].includes(job.status))
    return `<button data-job-action="pause" data-job="${job.id}">暂停</button><button data-job-action="stop" data-job="${job.id}">停止</button>`;
  if (job.status === "paused")
    return `<button data-job-action="edit" data-job="${job.id}">修改任务参数</button><button data-job-action="resume" data-job="${job.id}">继续</button><button data-job-action="stop" data-job="${job.id}">停止</button>`;
  return '<button data-go="overview">新建任务</button>';
}
function renderTemplate() {
  const templates = state.taskTemplates || [];
  $("#template-select").innerHTML =
    `<option value="">未选择模板</option>${templates.map((t) => `<option value="${t.id}" ${t.id === selectedTemplate ? "selected" : ""}>${esc(t.name)}</option>`).join("")}`;
  $("#delete-template").disabled = !selectedTemplate;
}
function renderSelection() {
  const accounts = state.accounts.filter((x) => x.enabled);
  config.accountIds = (config.accountIds || []).filter((id) => accounts.some((x) => x.id === id));
  config.topicIds = state.fixedTopic ? [state.fixedTopic.id] : state.topics.filter((x) => x.enabled).map((x) => x.id);
  updatePickerButton();
}
function updatePickerButton() {
  const button = document.querySelector('#pick-accounts');
  if (button) button.textContent = '已选 ' + (config.accountIds || []).length + ' 个账号 ▾';
}
let pickerDraft = null;
function pickerAccounts() {
  const query = (document.querySelector('#picker-search')?.value || '').trim().toLocaleLowerCase();
  const groupId = document.querySelector('#picker-group')?.value || '';
  return state.accounts.filter((a) => a.enabled)
    .filter((a) => !groupId || a.group_id === groupId)
    .filter((a) => !query || String(a.nickname || a.name || '').toLocaleLowerCase().includes(query) || String(a.uid || '').includes(query));
}
function renderPickerList() {
  const list = document.querySelector('#picker-list');
  if (!list || !pickerDraft) return;
  const rows = pickerAccounts();
  list.innerHTML = rows.length ? rows.map((a) => '<label class="picker-row"><input type="checkbox" data-picker-account="' + esc(a.id) + '"' + (pickerDraft.has(a.id) ? ' checked' : '') + '><span>' + esc(a.nickname || a.name) + '</span><small>' + (a.uid ? 'UID ' + esc(a.uid) : '未登录') + '</small></label>').join('') : '<div class="empty">没有匹配的账号</div>';
  const count = document.querySelector('#picker-count');
  if (count) count.textContent = '已选 ' + pickerDraft.size + ' / ' + state.accounts.filter((a) => a.enabled).length;
}
function openPicker() {
  pickerDraft = new Set(config.accountIds || []);
  const select = document.querySelector('#picker-group');
  if (select) select.innerHTML = '<option value="">全部分组</option>' + (state.accountGroups || []).map((g) => '<option value="' + esc(g.id) + '">' + esc(g.name) + '</option>').join('');
  const search = document.querySelector('#picker-search');
  if (search) search.value = '';
  renderPickerList();
  document.querySelector('#account-picker')?.showModal();
}
document.addEventListener('click', (event) => {
  if (event.target.closest('#pick-accounts')) { openPicker(); return; }
  if (event.target.closest('#picker-all')) { const next = new Set(pickerDraft || []); for (const account of pickerAccounts()) next.add(account.id); pickerDraft = next; renderPickerList(); return; }
  if (event.target.closest('#picker-none')) { pickerDraft = new Set(); renderPickerList(); return; }
  if (event.target.closest('#picker-confirm')) { config.accountIds = [...(pickerDraft || [])]; updatePickerButton(); renderSummary(); document.querySelector('#account-picker')?.close(); return; }
  if (event.target.closest('#picker-cancel') || event.target.closest('[data-close-picker]')) { document.querySelector('#account-picker')?.close(); }
});
document.addEventListener('input', (event) => { if (event.target.id === 'picker-search') renderPickerList(); });
document.addEventListener('change', (event) => {
  if (event.target.id === 'picker-group') renderPickerList();
  if (event.target.dataset?.pickerAccount && pickerDraft) {
    if (event.target.checked) pickerDraft.add(event.target.dataset.pickerAccount); else pickerDraft.delete(event.target.dataset.pickerAccount);
    const count = document.querySelector('#picker-count');
    if (count) count.textContent = '已选 ' + pickerDraft.size + ' / ' + state.accounts.filter((a) => a.enabled).length;
  }
});
function renderPlan() {
  $("#action-plan").innerHTML = config.actionPlan
    .map((x, i) => {
      return `<article class="action-card" data-index="${i}"><span class="drag-handle" data-drag-action="${i}" title="按住拖动排序">⠿</span><label class="card-field">操作<select data-plan-type="${i}"><option value="checkin" ${x.type === "checkin" ? "selected" : ""}>签到</option><option value="comment" ${x.type === "comment" ? "selected" : ""}>评论</option><option value="post" ${x.type === "post" ? "selected" : ""}>发帖</option></select></label><label class="card-field">次数<input data-plan-count="${i}" type="number" min="1" max="100" value="${x.count}" aria-label="执行次数"></label><label class="card-field">间隔（秒）<input data-plan-interval="${i}" type="number" min="0" max="3600" value="${x.intervalSeconds ?? DEFAULT_ACTION_INTERVALS[x.type]}" aria-label="间隔秒数"></label><button class="card-delete" data-plan-action="delete" data-index="${i}" aria-label="删除">×</button></article>`;
    })
    .join("");
}
let actionDrag = null;
document.addEventListener('pointerdown', event => {
  const handle = event.target.closest('[data-drag-action]');
  if (!handle) return;
  const card = handle.closest('.action-card');
  if (!card) return;
  actionDrag = { index: Number(card.dataset.index), startX: event.clientX, width: card.getBoundingClientRect().width + 10 };
  card.classList.add('dragging');
  handle.setPointerCapture?.(event.pointerId);
});
document.addEventListener('pointermove', event => {
  if (actionDrag) actionDrag.dx = event.clientX - actionDrag.startX;
});
document.addEventListener('pointerup', () => {
  if (!actionDrag) return;
  const { index, dx, width } = actionDrag;
  actionDrag = null;
  const steps = Math.round((dx || 0) / width);
  if (steps) {
    const item = config.actionPlan.splice(index, 1)[0];
    const target = Math.max(0, Math.min(config.actionPlan.length, index + steps));
    config.actionPlan.splice(target, 0, item);
    renderSummary();
  }
  renderPlan();
});
function renderSettings() {
  if (state.fixedTopic) {
    let input = $('#comment-section');
    if (input.tagName !== 'SELECT') {
      const select = document.createElement('select'); select.id = input.id; select.name = input.name; input.replaceWith(select); input = select;
    }
    const sections = state.commentSections || [];
    input.innerHTML = `${sections.includes(config.commentSection) ? '' : `<option value="${esc(config.commentSection)}" disabled>原分区无法识别，请重新选择</option>`}${sections.map(name=>`<option value="${esc(name)}">${esc(name)}</option>`).join('')}`;
  }
  for (const [id, key] of [
    ["rounds", "rounds"],
    ["round-interval", "roundIntervalSeconds"],
    ["comment-section", "commentSection"],
    ["scan-limit", "scanLimit"],
    ["refresh-seconds", "candidateRefreshSeconds"],
  ])
    if ($("#" + id) && $("#" + id) !== document.activeElement) $("#" + id).value = config[key] ?? "";
  $("#comment-strategy").value = config.commentStrategy;
  $("#sync-to-home").checked = config.syncToHome === true;
  $("#comment-max-count-enabled").checked =
    config.commentMaxCountEnabled === true;
  $("#comment-summary").textContent =
    { random: "普通随机", "zero-first": "零评论优先", "zero-only": "仅零评论" }[
      config.commentStrategy
    ] || "";
  $("#text-decorations").innerHTML = ["post", "comment"]
    .map((k) => {
      const d = config[`${k}Decoration`];
      const mode = d.mode;
      const emojiOff = mode === "none" || mode === "number";
      const numberOff = mode === "none" || mode === "emoji";
      return `<div class="deco-row"><b class="deco-name">${k === "post" ? "发帖" : "评论"}</b><label>添加方式<select id="${k}-decoration-mode"><option value="none">不添加</option><option value="emoji">随机表情</option><option value="number">顺序数字</option><option value="emoji-and-number">表情和数字</option></select></label><label class="${emojiOff ? "off" : ""}">表情位置<select id="${k}-emoji-position"><option value="suffix">末尾</option><option value="prefix">开头</option></select></label><label class="${numberOff ? "off" : ""}">数字位置<select id="${k}-number-position"><option value="suffix">末尾</option><option value="prefix">开头</option></select></label><label class="deco-emojis">表情列表<input id="${k}-emoji-list" value="${esc(d.emojis.join(" "))}" placeholder="空格分隔"></label></div>`;
    })
    .join("");
  for (const k of ["post", "comment"]) {
    $(`#${k}-decoration-mode`).value = config[`${k}Decoration`].mode;
    $(`#${k}-emoji-position`).value = config[`${k}Decoration`].emojiPosition;
    $(`#${k}-number-position`).value = config[`${k}Decoration`].numberPosition;
  }
  const picks = document.querySelector('#material-group-picks');
  if (picks) {
    const groups = state.materialGroups || [];
    const ids = groups.map(group => group.id);
    for (const key of ['postGroupIds', 'commentGroupIds']) {
      const selected = (config[key] || []).filter(id => ids.includes(id));
      config[key] = selected.length === ids.length && ids.length && ids.every(id => selected.includes(id)) ? [] : selected;
    }
    const row = (key, label) => '<span class="hint">' + label + '</span>' + (groups.length ? groups.map(group => '<label class="check-inline"><input type="checkbox" data-material-group-pick="' + key + '" value="' + esc(group.id) + '" ' + (config[key].includes(group.id) ? 'checked' : '') + '>' + esc(group.name) + '</label>').join('') : '<span class="hint">没有分组，默认全部</span>');
    picks.innerHTML = '<div class="pick-row">' + row('postGroupIds', '发帖') + '</div><div class="pick-row">' + row('commentGroupIds', '评论') + '</div>';
  }
  renderSummary();
}
function showScanHelp(message = '') {
  const dialog = document.querySelector('#scan-help-dialog');
  const error = document.querySelector('#scan-help-error');
  if (!dialog) return;
  const current = document.querySelector('#scan-help-current');
  if (current) current.textContent = '当前：每次扫描 ' + (document.querySelector('#scan-limit')?.value || config.scanLimit) + ' 条，刷新间隔 ' + (document.querySelector('#refresh-seconds')?.value || config.candidateRefreshSeconds) + ' 秒。';
  if (error) error.textContent = message;
  if (!dialog.open) dialog.showModal();
}
function normalizeScanInput(input) {
  if (!input || !['scan-limit', 'refresh-seconds'].includes(input.id)) return false;
  const isRefresh = input.id === 'refresh-seconds';
  const min = isRefresh ? 3 : 1;
  const max = isRefresh ? 3600 : 500;
  const fallback = isRefresh ? 3 : 30;
  const raw = input.value.trim();
  const parsed = Number.parseInt(raw, 10);
  const normalized = Number.isFinite(parsed) ? Math.max(min, Math.min(max, parsed)) : fallback;
  if (!raw || normalized !== parsed) {
    input.value = String(normalized);
    showScanHelp((isRefresh ? '刷新间隔需在 3–3600 秒' : '每次扫描需在 1–500 条') + '，已调整为 ' + normalized + (isRefresh ? ' 秒。' : ' 条。'));
    return true;
  }
  return false;
}
function normalizeScanFields() {
  let invalid = false;
  for (const id of ['scan-limit', 'refresh-seconds']) if (normalizeScanInput(document.querySelector('#' + id))) invalid = true;
  return invalid;
}
function sync() {
  config.rounds = num("#rounds", 1, 100, 1);
  config.roundIntervalSeconds = num("#round-interval", 0, 86400, 60);
  config.commentStrategy = $("#comment-strategy").value;
  config.commentSection = $("#comment-section").value.trim();
  config.scanLimit = num("#scan-limit", 1, 500, 30);
  config.commentMaxCountEnabled = document.querySelector(
    "#comment-max-count-enabled",
  ).checked;
  config.candidateRefreshSeconds = num("#refresh-seconds", 3, 3600, 3);
  config.syncToHome = $("#sync-to-home").checked;
  const allGroupIds = (state.materialGroups || []).map(group => group.id);
  for (const key of ['postGroupIds', 'commentGroupIds']) {
    const picked = [...document.querySelectorAll('[data-material-group-pick="' + key + '"]:checked')].map(node => node.value);
    config[key] = picked.length && picked.length < allGroupIds.length ? picked : [];
  }
  for (const k of ["post", "comment"])
    config[`${k}Decoration`] = {
      mode: $(`#${k}-decoration-mode`).value,
      emojiPosition: $(`#${k}-emoji-position`).value,
      numberPosition: $(`#${k}-number-position`).value,
      emojis: $(`#${k}-emoji-list`)
        .value.split(/[\s,，]+/)
        .filter(Boolean),
    };
  renderSummary();
}
function selectedMaterialCount(kind) {
  const list = kind === 'post' ? state.posts : state.comments;
  const groupIds = new Set(config[kind === 'post' ? 'postGroupIds' : 'commentGroupIds'] || []);
  const rows = (list || []).filter(item => item.enabled !== false && (!groupIds.size || groupIds.has(item.group_id || '')));
  return new Set(rows.map(item => String(item.text || '').trim()).filter(Boolean)).size;
}
function materialShortages() {
  const shortages = [];
  for (const [kind, label] of [['post', '发帖文案'], ['comment', '评论文案']]) {
    if (!config.actionPlan.some(item => item.type === kind && Number(item.count) > 0)) continue;
    const count = selectedMaterialCount(kind);
    if (count < 2) shortages.push({ kind, label, count });
  }
  return shortages;
}
function showMaterialShortage(shortages) {
  const dialog = document.querySelector('#material-shortage-dialog');
  const body = document.querySelector('#material-shortage-body');
  if (!dialog || !body) return;
  body.innerHTML = shortages.map(item => '<p class="shortage-item"><b>' + item.label + '</b>：所选分组内只有 ' + item.count + ' 条，至少需要 2 条。</p>').join('');
  if (dialog.open) dialog.close();
  dialog.showModal();
}
function renderSummary() {
  const accounts = config.accountIds?.length || 0, topics = config.topicIds?.length || 0;
  const each = config.actionPlan.reduce((n, x) => n + Number(x.count || 0), 0);
  const total = accounts * topics * config.rounds * each;
  document.querySelector('#task-summary').innerHTML = '<b>' + accounts + '</b> 账号 · 预计 <b>' + total + '</b> 项';
  const errors = [];
  if (!accounts) errors.push("至少选择一个登录有效的账号");
  for (const shortage of materialShortages())
    errors.push(shortage.label + "不足：所选分组内只有 " + shortage.count + " 条，至少需要 2 条");
  $("#task-errors").innerHTML = errors.join("<br>");
  return errors;
}
function restrictionBadges(a) {
  const c = state.activeJob?.cursor || {},
    id = String(a.uid || "account:" + a.id),
    labels = [];
  const round = Number(c.workflowRound ?? c.current?.round ?? 0);
  if ((c.muteLimits || []).some((x) => x.identity === id && x.round === round)) labels.push("禁言");
  if ((c.rateLimits || []).some((x) => x.identity === id && x.round === round && x.kind === "post"))
    labels.push("发帖频繁");
  if (
    (c.rateLimits || []).some((x) => x.identity === id && x.round === round && x.kind === "comment")
  )
    labels.push("评论频繁");
  return labels
    .map((x) => '<span class="status-pill warning">' + x + "<\/span>")
    .join("");
}
let accountFilter = { q: '', group: '', status: 'all' };
function renderAccountFilters() {
  const groups = (state.accountGroups || []).filter(group => group.id), accounts = state.accounts || [];
  const ungrouped = accounts.filter(account => !account.group_id).length;
  if (accountFilter.group === '__ungrouped__' && !ungrouped) accountFilter.group = '';
  if (accountFilter.group && accountFilter.group !== '__ungrouped__' && !groups.some(group => group.id === accountFilter.group)) accountFilter.group = '';
  const chips = $('#account-group-chips');
  if (chips) {
    const chip = (value, label, count) => '<button type="button" class="chip ' + (accountFilter.group === value ? 'on' : '') + '" data-account-group-filter="' + esc(value) + '" aria-pressed="' + (accountFilter.group === value) + '">' + esc(label) + ' <b>' + count + '</b></button>';
    chips.innerHTML = chip('', '全部', accounts.length) + groups.map(group => chip(group.id, group.name, accounts.filter(account => (account.group_id || '') === group.id).length)).join('') + (ungrouped ? chip('__ungrouped__', '未分组', ungrouped) : '');
  }
  for (const chip of document.querySelectorAll('#account-status-chips .chip')) chip.classList.toggle('on', chip.dataset.accountStatus === accountFilter.status);
}
function applyAccountFilter() {
  const q = accountFilter.q.trim().toLocaleLowerCase();
  const restrictions = new Map((state.restrictedAccounts || []).map(item => [String(item.identity), item]));
  for (const row of document.querySelectorAll('#account-list .account-row')) {
    const uid = row.dataset.uid || '';
    const restriction = restrictions.get(uid);
    const text = row.textContent.toLocaleLowerCase();
    const matchQ = !q || text.includes(q);
    const group = accountFilter.group === '__ungrouped__' ? '' : accountFilter.group;
    const matchGroup = !accountFilter.group || row.dataset.groupId === group;
    const status = accountFilter.status;
    const matchStatus = status === 'all' || (status === 'muted' && restriction?.type === '禁言') || (status === 'limited' && restriction?.type === '频繁') || (status === 'invalid' && row.dataset.invalid === '1') || (status === 'disabled' && row.dataset.enabled === '0');
    row.classList.toggle('hidden', !(matchQ && matchGroup && matchStatus));
  }
  for (const section of document.querySelectorAll('#account-list .account-group-section')) {
    const visible = [...section.querySelectorAll('.account-row')].some(row => !row.classList.contains('hidden'));
    section.classList.toggle('hidden', !visible);
  }
}
function renderAccounts() {
  const session = state.loginSession;
  $('#login-progress').innerHTML = session ? '<div class="panel"><b>' + esc(session.message) + '</b>' + (session.active ? '<button id="cancel-login" class="quiet" type="button">取消登录</button>' : '') + '</div>' : '';
  for (const id of selectedAccounts) if (!state.accounts.some(x => x.id === id)) selectedAccounts.delete(id);
  $('#selected-account-count').textContent = '已选 ' + selectedAccounts.size + ' 个';
  const groups = new Map((state.accountGroups || []).map(group => [group.id, group.name]));
  const restrictions = new Map((state.restrictedAccounts || []).map(item => [String(item.identity), item]));
  $('#account-list').innerHTML = state.accounts.length ? state.accounts.map((a, i) => {
    const restriction = restrictions.get(String(a.uid || ''));
    const groupName = groups.get(a.group_id || '') || '未分组';
    return '<article class="list-row account-row" data-account-id="' + a.id + '" data-enabled="' + (a.enabled ? '1' : '0') + '" data-group-id="' + esc(a.group_id || '') + '" data-uid="' + esc(a.uid || '') + '" data-invalid="' + (a.auth_status === 'invalid' ? '1' : '0') + '"><span class="drag-handle" data-drag-account="' + a.id + '" title="按住拖动排序">⠿</span><label class="check-inline"><input data-select-account="' + a.id + '" type="checkbox" ' + (selectedAccounts.has(a.id) ? 'checked' : '') + ' aria-label="选择 ' + esc(a.nickname || a.name) + '"></label><span class="ord">' + String(i + 1).padStart(2, '0') + '</span><div class="row-main"><strong>' + esc(a.nickname || a.name || a.uid || '等待扫码') + '</strong><span>' + (a.uid ? 'UID ' + esc(a.uid) : '未识别 UID') + '</span></div><span class="group-cell">' + esc(groupName) + '</span><span class="status-pill ' + a.auth_status + '">' + (a.auth_status === 'valid' ? '已登录' : a.auth_status === 'invalid' ? '需重登' : '未检查') + '</span><span class="row-tags">' + (restriction ? '<span class="result warning">' + esc(restriction.type) + '</span>' : '') + (!a.enabled ? '<span class="status-pill account-disabled-pill">已停用</span>' : '') + '</span><div class="row-actions"><button class="quiet" data-account-action="login" data-id="' + a.id + '">扫码登录</button><button class="' + (a.enabled ? 'danger' : 'quiet') + '" data-account-action="toggle" data-id="' + a.id + '">' + (a.enabled ? '停用' : '启用') + '</button><button class="danger" data-account-action="delete" data-id="' + a.id + '">删除</button></div></article>';
  }).join('') : '<div class="empty">添加一个账号后，在本机 Chrome 窗口扫码登录。</div>';
  groupUI?.renderAccounts();
  renderAccountFilters();
  applyAccountFilter();
}
let materialTab = 'post';
let materialGroupFilter = '';
let materialGroupsOpen = false;
function materialItems() { return materialTab === 'post' ? state.posts : state.comments; }
function renderMaterialGroupOptions() {
  const groups = state.materialGroups || [];
  for (const [id, withAll] of [['#material-group-filter', true], ['#material-add-group', false]]) {
    const select = $(id);
    if (!select) continue;
    const current = select.value;
    select.innerHTML = (withAll ? '<option value="">全部分组</option>' : '<option value="">未分组</option>') + groups.map(group => '<option value="' + esc(group.id) + '">' + esc(group.name) + '</option>').join('');
    select.value = groups.some(group => group.id === current) ? current : '';
  }
  const move = $('#material-move-target');
  if (move) {
    const current = move.value;
    move.innerHTML = '<option value="" disabled>选择分组…</option><option value="__ungrouped__">未分组</option>' + groups.map(group => '<option value="' + esc(group.id) + '">' + esc(group.name) + '</option>').join('');
    move.value = current === '__ungrouped__' || groups.some(group => group.id === current) ? current : '';
  }
}
function renderMaterialGroupsPanel() {
  const foot = $('#material-foot');
  if (!foot) return;
  if (!materialGroupsOpen) { foot.textContent = '共 ' + materialItems().filter(item => !materialGroupFilter || (item.group_id || '') === materialGroupFilter).length + ' 条 · 列表内滚动'; return; }
  const groups = state.materialGroups || [];
  foot.innerHTML = '<span class="hint">分组：</span>' + (groups.map(group => '<span class="group-chip">' + esc(group.name) + '<button type="button" data-delete-material-group="' + esc(group.id) + '">×</button></span>').join('') || '<span class="hint">还没有分组</span>');
}
function updateMaterialSelectionUi() {
  const selected = selectedMaterials[materialTab].size;
  const moveBar = $('#material-move-bar');
  if (moveBar) {
    moveBar.classList.toggle('hidden', selected === 0);
    const label = $('#material-move-label');
    if (label) label.textContent = '已选 ' + selected + ' 条';
    const moveTarget = $('#material-move-target');
    if (moveTarget && selected === 0) moveTarget.value = '';
    const apply = $('#material-move-apply');
    if (apply) apply.disabled = !moveTarget?.value;
  }
  const clearButton = document.querySelector('[data-clear-material-btn]');
  if (clearButton) clearButton.disabled = selected === 0;
  const bulkButton = document.querySelector('[data-bulk-material-btn]');
  if (bulkButton) bulkButton.disabled = selected === 0;
}
function renderMaterials() {
  const subtitle = document.querySelector('.brand-sub');
  if (subtitle) subtitle.hidden = page !== 'overview';
  $('#post-count').textContent = state.posts.length;
  $('#comment-count').textContent = state.comments.length;
  for (const tab of document.querySelectorAll('#material-tabs [data-material-tab]')) tab.classList.toggle('on', tab.dataset.materialTab === materialTab);
  renderMaterialGroupOptions();
  const groups = new Map((state.materialGroups || []).map(group => [group.id, group.name]));
  const items = materialItems().filter(item => !materialGroupFilter || (item.group_id || '') === materialGroupFilter);
  $('#material-list').innerHTML = items.length ? items.map(item => '<div class="material-item material-row"><input data-select-material="' + materialTab + '" data-id="' + item.id + '" type="checkbox" ' + (selectedMaterials[materialTab].has(item.id) ? 'checked' : '') + '><span class="material-text" data-material-id="' + item.id + '" data-material-type="' + materialTab + '" title="点击查看全文">' + esc(item.text) + '</span><span class="material-group">' + esc(groups.get(item.group_id || '') || '未分组') + '</span></div>').join('') : '<div class="empty">还没有文案。</div>';
  updateMaterialSelectionUi();
  renderMaterialGroupsPanel();
}
function addMaterialTexts() {
  const raw = document.querySelector('#material-texts')?.value || '';
  const single = document.querySelector('#material-single')?.checked;
  const texts = single ? [raw.trim()] : raw.split(/\r?\n/).map(text => text.trim()).filter(Boolean);
  if (!texts.length) { toast('请输入文案'); return; }
  const groupId = document.querySelector('#material-add-group')?.value || '';
  request('/api/' + (materialTab === 'post' ? 'post-materials' : 'comment-materials'), { method: 'POST', body: { texts, groupId } })
    .then(() => { document.querySelector('#material-texts').value = ''; return load({ keep: true }); })
    .catch(error => toast(error.message));
}
function moveSelectedMaterials(groupId) {
  const ids = [...selectedMaterials[materialTab]];
  if (!ids.length) { toast('请先选择文案'); return; }
  const targetId = groupId || '';
  const targetName = targetId ? ((state.materialGroups || []).find(group => group.id === targetId)?.name || '目标分组') : '未分组';
  request('/api/materials/group', { method: 'POST', body: { type: materialTab, ids, groupId } })
    .then(() => {
      selectedMaterials[materialTab].clear();
      const moveTarget = $('#material-move-target');
      if (moveTarget) moveTarget.value = '';
      toast('已移动 ' + ids.length + ' 条到' + targetName);
      return load({ keep: true });
    }).catch(error => toast(error.message));
}
document.addEventListener('input', event => {
  if (event.target.id === 'account-search') { accountFilter.q = event.target.value; applyAccountFilter(); }
});
document.addEventListener('change', event => {
  if (event.target.id === 'material-group-filter') { materialGroupFilter = event.target.value; renderMaterials(); }
  if (event.target.id === 'material-move-target') { const apply = $('#material-move-apply'); if (apply) apply.disabled = !event.target.value; }
});
document.addEventListener('click', event => {
  const chip = event.target.closest('[data-account-status]');
  if (chip) { accountFilter.status = chip.dataset.accountStatus; renderAccountFilters(); applyAccountFilter(); return; }
  const groupChip = event.target.closest('[data-account-group-filter]');
  if (groupChip) { accountFilter.group = groupChip.dataset.accountGroupFilter; renderAccountFilters(); applyAccountFilter(); return; }
  if (event.target.closest('[data-toggle-groups]')) { groupUI?.open?.(); return; }
  const tab = event.target.closest('[data-material-tab]');
  if (tab) { materialTab = tab.dataset.materialTab; materialGroupFilter = ''; renderMaterials(); return; }
  if (event.target.closest('#new-material-group')) { const name = prompt('新分组名称'); if (name?.trim()) request('/api/material-groups', { method: 'POST', body: { name } }).then(() => load({ keep: true })).catch(error => toast(error.message)); return; }
  if (event.target.closest('[data-manage-groups]')) { materialGroupsOpen = !materialGroupsOpen; renderMaterialGroupsPanel(); return; }
  const delGroup = event.target.closest('[data-delete-material-group]');
  if (delGroup) { if (confirm('删除该分组？其中文案会回到未分组')) request('/api/material-groups/' + delGroup.dataset.deleteMaterialGroup, { method: 'DELETE' }).then(() => load({ keep: true })).catch(error => toast(error.message)); return; }
  if (event.target.closest('[data-select-all-material-btn]')) { selectedMaterials[materialTab] = new Set(materialItems().filter(item => !materialGroupFilter || (item.group_id || '') === materialGroupFilter).map(item => item.id)); renderMaterials(); return; }
  if (event.target.closest('[data-clear-material-btn]') || event.target.closest('[data-clear-material-selection]')) { selectedMaterials[materialTab].clear(); renderMaterials(); return; }
  if (event.target.closest('#material-move-apply')) {
    const raw = $('#material-move-target')?.value;
    if (!raw) return toast('请选择目标分组');
    moveSelectedMaterials(raw === '__ungrouped__' ? '' : raw);
    return;
  }
  if (event.target.closest('[data-bulk-material-btn]')) {
    const ids = [...selectedMaterials[materialTab]];
    if (!ids.length) { toast('请先选择文案'); return; }
    if (!confirm('删除所选 ' + ids.length + ' 条文案？')) return;
    request('/api/' + (materialTab === 'post' ? 'post-materials' : 'comment-materials') + '/bulk-delete', { method: 'POST', body: { ids } }).then(() => { selectedMaterials[materialTab].clear(); return load({ keep: true }); }).catch(error => toast(error.message));
    return;
  }
  if (event.target.closest('#material-add')) { addMaterialTexts(); return; }
});
let accountDrag = null;
document.addEventListener('pointerdown', event => {
  const handle = event.target.closest('[data-drag-account]');
  if (!handle) return;
  const row = handle.closest('.account-row');
  if (!row) return;
  accountDrag = { row, startY: event.clientY };
  row.classList.add('dragging');
  handle.setPointerCapture?.(event.pointerId);
});
document.addEventListener('pointermove', event => {
  if (!accountDrag) return;
  const row = accountDrag.row, height = row.getBoundingClientRect().height || 44;
  const steps = Math.round((event.clientY - accountDrag.startY) / height);
  if (!steps) return;
  const siblings = [...row.parentElement.children].filter(node => node.classList.contains('account-row') && !node.classList.contains('hidden'));
  const index = siblings.indexOf(row);
  const target = siblings[Math.max(0, Math.min(siblings.length - 1, index + Math.sign(steps)))];
  if (!target || target === row) return;
  if (steps > 0) target.after(row); else target.before(row);
  accountDrag.startY = event.clientY;
});
document.addEventListener('pointerup', () => {
  if (!accountDrag) return;
  accountDrag.row.classList.remove('dragging');
  accountDrag = null;
  const ids = [...document.querySelectorAll('#account-list [data-select-account]')].map(node => node.dataset.selectAccount);
  request('/api/accounts/order', { method: 'POST', body: { ids } }).catch(() => {});
});
function action(x) {
  return `<article class="activity"><time>${time(x.started_at)}</time><div><strong>${esc(x.account_name || "")} · ${esc(x.topic_name || "")}</strong><div>${kind(x.kind)}${x.content ? ` · ${esc(x.content)}` : ""}</div>${x.url ? `<a href="${esc(x.url)}" target="_blank" rel="noreferrer">打开目标帖</a>` : ""}</div><span class="result ${x.state}">${stateName(x.state)}</span></article>`;
}
function kind(x) {
  return { checkin: "签到", post: "发帖", comment: "评论" }[x] || x;
}
function stateName(x) {
  return (
    {
      succeeded: "成功",
      failed: "失败",
      uncertain: "待核对",
      skipped: "跳过",
      submitted: "已提交",
      prepared: "准备中",
      verification_wait: "待验证",
      cancelled: "已取消",
    }[x] || x
  );
}
function level(x) {
  return (
    { success: "成功", warning: "提醒", error: "失败", info: "信息" }[x] || x
  );
}
function time(v, full = false) {
  if (!v || Number.isNaN(Date.parse(v))) return "—";
  return new Intl.DateTimeFormat("zh-CN", {
    timeZone: "Asia/Shanghai",
    month: full ? "numeric" : undefined,
    day: full ? "numeric" : undefined,
    hour: "2-digit",
    minute: "2-digit",
    second: full ? "2-digit" : undefined,
  }).format(new Date(v));
}
function num(s, min, max, fallback) {
  const n = Number.parseInt($(s).value, 10);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback;
}
document.addEventListener("change", (e) => {
  const t = e.target;
  if (t.id === 'scan-limit' || t.id === 'refresh-seconds') normalizeScanInput(t);
  if (t.dataset.materialGroupPick) sync();
  if (t.dataset.selectAccount) {
    t.checked
      ? selectedAccounts.add(t.dataset.selectAccount)
      : selectedAccounts.delete(t.dataset.selectAccount);
    renderAccounts();
  }
  if (t.dataset.selectMaterial) {
    const set = selectedMaterials[t.dataset.selectMaterial];
    t.checked ? set.add(t.dataset.id) : set.delete(t.dataset.id);
    if (t.dataset.selectMaterial === materialTab) updateMaterialSelectionUi();
  }
  if (t.dataset.taskAccount) {
    t.checked
      ? config.accountIds.push(t.dataset.taskAccount)
      : (config.accountIds = config.accountIds.filter(
          (x) => x !== t.dataset.taskAccount,
        ));
    renderSummary();
  }
  if (t.id === "template-select") {
    selectedTemplate = t.value;
    const item = (state.taskTemplates || []).find((x) => x.id === t.value);
    if (item) {
      const keep = { accountIds: [...(config.accountIds || [])], topicIds: [...(config.topicIds || [])] };
      config = merge({ ...item.config, ...keep });
      seedSelections();
      renderOverview();
    }
  }
  if (t.dataset.selectAllMaterial) {
    const type = t.dataset.selectAllMaterial;
    selectedMaterials[type] = t.checked
      ? new Set(
          (type === "post" ? state.posts : state.comments).map((x) => x.id),
        )
      : new Set();
    renderMaterials();
  }
  if (
    [
      "rounds",
      "round-interval",
      "comment-strategy",
      "comment-section",
      "scan-limit",
      "refresh-seconds",
      "sync-to-home",
      "comment-max-count-enabled",
    ].includes(t.id) ||
    t.id.includes("-decoration-") ||
    t.id.includes("-emoji-")
  )
    sync();
});
document.addEventListener("input", (e) => {
  if (e.target.matches("[data-plan-interval]")) {
    config.actionPlan[Number(e.target.dataset.planInterval)].intervalSeconds =
      Math.max(0, Math.min(3600, Math.trunc(Number(e.target.value) || 0)));
  }
  if (e.target.matches("[data-plan-count]")) {
    config.actionPlan[Number(e.target.dataset.planCount)].count = Math.max(
      1,
      Number(e.target.value) || 1,
    );
    renderSummary();
  }
});
async function submitTaskEdit({ resume }) {
  if (!editingJob) return;
  if (resume && normalizeScanFields()) return;
  sync();
  if (resume) {
    const shortages = materialShortages();
    if (shortages.length) { showMaterialShortage(shortages); return; }
    if (renderSummary().length) throw new Error("请先补齐任务设置");
  }
  const result = await request(`/api/jobs/${editingJob.id}/edit`, {
    method: "POST",
    body: { config, version: editingJob.version, resume },
  });
  editingJob = null;
  editingBaseline = null;
  toast(
    resume
      ? `已按新参数继续运行（新增 ${result.change.added} 项）`
      : `修改已保存：撤销 ${result.change.cancelled} 项未提交步骤`,
  );
  await load({ keep: true });
  render();
}

async function cancelTaskEdit() {
  if (!editingJob) return;
  sync();
  if (taskEditDirty() && !confirm("当前修改尚未保存，确定取消吗？")) return;
  if (editingBaseline) config = structuredClone(editingBaseline);
  editingJob = null;
  editingBaseline = null;
  renderOverview();
  toast("已取消修改，恢复为当前已保存参数");
}

document.addEventListener('click', event => {
  const target = event.target.closest('[data-material-id]');
  if (!target) return;
  const type = target.dataset.materialType;
  const item = (type === 'post' ? state.posts : state.comments).find(entry => entry.id === target.dataset.materialId);
  if (!item) return;
  const dialog = document.querySelector('#material-dialog');
  if (!dialog) return;
  document.querySelector('#material-dialog-body').textContent = item.text;
  const groups = state.materialGroups || [];
  const group = groups.find(entry => entry.id === item.group_id);
  document.querySelector('#material-dialog-meta').textContent = (group ? group.name : '未分组') + ' · ' + item.text.length + ' 字 · ' + (type === 'post' ? '发帖文案' : '评论文案');
  dialog.dataset.materialId = item.id;
  dialog.dataset.materialType = type;
  dialog.showModal();
});
document.addEventListener('click', async event => {
  if (event.target.closest('[data-close-material]')) { document.querySelector('#material-dialog')?.close(); return; }
  if (event.target.closest('[data-copy-material]')) {
    const dialog = document.querySelector('#material-dialog');
    const type = dialog?.dataset.materialType;
    const item = (type === 'post' ? state.posts : state.comments || []).find(entry => entry.id === dialog?.dataset.materialId);
    if (item) { try { await navigator.clipboard.writeText(item.text); toast('已复制'); } catch { toast('复制失败'); } }
    return;
  }
});
document.addEventListener('click', async event => {
  if (event.target.closest('#lan-access-button')) { await openLanAccessDialog(); return; }
  if (event.target.closest('#lan-refresh')) { try { await refreshLanAccess(); toast('地址已刷新'); } catch (error) { toast(error.message); } return; }
  if (event.target.closest('#scan-help-button')) { showScanHelp(); return; }
  if (event.target.closest('[data-close-scan-help]')) { document.querySelector('#scan-help-dialog')?.close(); return; }
  if (event.target.closest('[data-close-lan]')) { document.querySelector('#lan-access-dialog')?.close(); return; }
  const copy = event.target.closest('[data-copy-lan]');
  if (copy) {
    const lan = state?.lanAccess || {};
    const value = copy.dataset.copyLan === 'host' ? lan.hostnameUrl : lan.ipUrl;
    if (!value) { toast('未检测到可复制的地址'); return; }
    try { await navigator.clipboard.writeText(value); toast('已复制手机访问地址'); } catch { toast('复制失败'); }
    return;
  }
  const copyUrl = event.target.closest('[data-copy-lan-url]');
  if (copyUrl) {
    try { await navigator.clipboard.writeText(copyUrl.dataset.copyLanUrl || ''); toast('已复制手机访问地址'); } catch { toast('复制失败'); }
    return;
  }
  if (event.target.closest('[data-close-shortage]')) { document.querySelector('#material-shortage-dialog')?.close(); return; }
  if (event.target.closest('[data-go-material-groups]')) {
    document.querySelector('#material-shortage-dialog')?.close();
    selectConfigPane('advanced');
    setTimeout(() => document.querySelector('#material-group-picks')?.scrollIntoView({ block: 'center', behavior: 'smooth' }), 50);
    return;
  }
});
document.addEventListener("click", async (e) => {
  const b = e.target.closest("button");
  if (!b) return;
  try {
    if (b.dataset.page) navigate(b.dataset.page);
    if (b.dataset.go) {
      if (b.dataset.go === "overview") {
        if (editingJob && taskEditDirty() && !confirm("当前修改尚未保存，确定进入新建任务配置吗？")) return;
        if (editingJob) {
          editingJob = null;
          editingBaseline = null;
        }
        navigate("overview", { scrollTop: false });
        render();
        revealTaskConfiguration();
      } else navigate(b.dataset.go);
    }
    if (b.id === "refresh") {
      await load({ keep: true });
      await loadRecords(recordDate);
    }
    if (b.id === "add-action") {
      config.actionPlan.push({
        segmentId: `seg_${crypto.randomUUID()}`,
        type: "comment",
        count: 1,
        intervalSeconds: DEFAULT_ACTION_INTERVALS.comment,
      });
      renderPlan();
      renderSummary();
    }
    if (b.dataset.selectAll) {
      const key = b.dataset.selectAll;
      const list =
        key === "accounts"
          ? state.accounts.filter((x) => x.enabled)
          : state.topics.filter((x) => x.enabled);
      const prop = key === "accounts" ? "accountIds" : "topicIds";
      config[prop] =
        config[prop].length === list.length ? [] : list.map((x) => x.id);
      renderSelection();
      renderSummary();
    }
    if (b.dataset.planAction) {
      const i = Number(b.dataset.index),
        a = b.dataset.planAction;
      if (a === "delete") config.actionPlan.splice(i, 1);
      if (a === "up" && i > 0)
        [config.actionPlan[i - 1], config.actionPlan[i]] = [
          config.actionPlan[i],
          config.actionPlan[i - 1],
        ];
      if (a === "down" && i < config.actionPlan.length - 1)
        [config.actionPlan[i + 1], config.actionPlan[i]] = [
          config.actionPlan[i],
          config.actionPlan[i + 1],
        ];
      renderPlan();
      renderSummary();
    }
    if (b.dataset.editAction === "save-resume") {
      await submitTaskEdit({ resume: true });
      return;
    }
    if (b.dataset.editAction === "cancel") {
      await cancelTaskEdit();
      return;
    }
    if (b.dataset.jobAction) {
      if (b.dataset.jobAction === "edit") {
        const editable = await request(`/api/jobs/${b.dataset.job}/edit`);
        if (!editable.canEdit) throw new Error("任务尚未安全暂停，暂时不能修改");
        editingJob = { id: editable.jobId, version: editable.version };
        config = merge(editable.config);
        config.segmentIds = editable.config.segmentIds || config.actionPlan.map((item, index) => item.segmentId || `legacy-${index}`);
        seedSelections();
        editingBaseline = structuredClone(config);
        selectConfigPane('range');
        renderOverview();
        document.querySelector("#config-card").scrollIntoView({ block: "start", behavior: "smooth" });
        toast("正在修改已暂停任务；保存后会保留已完成结果");
        return;
      }
      if (
        b.dataset.jobAction === "stop" &&
        !confirm("确定停止这项任务？未确认的操作会保留待核对。")
      )
        return;
      await request(`/api/jobs/${b.dataset.job}/${b.dataset.jobAction}`, {
        method: "POST",
      });
      await load({ keep: true });
    }
    if (b.id === "save-task") {
      if (editingJob) {
        await submitTaskEdit({ resume: false });
        return;
      }
      if (normalizeScanFields()) return;
      sync();
      await request("/api/settings/task", { method: "PUT", body: config });
      toast("设置已保存");
    }
    if (b.id === "start-task") {
      if (editingJob) {
        await submitTaskEdit({ resume: true });
        return;
      }
      if (normalizeScanFields()) return;
      sync();
      const shortages = materialShortages();
      if (shortages.length) { showMaterialShortage(shortages); return; }
      if (renderSummary().length) throw new Error("请先补齐任务设置");
      await request("/api/jobs", { method: "POST", body: config });
      toast("任务已开始");
      await load({ keep: true });
    }
    if (b.id === "save-template") {
      if (normalizeScanFields()) return;
      sync();
      const current = (state.taskTemplates || []).find(
        (x) => x.id === selectedTemplate,
      );
      const name = prompt("模板名称", current?.name || "");
      if (!name?.trim()) return;
      if (current)
        await request(`/api/task-templates/${current.id}`, {
          method: "PUT",
          body: { name, config },
        });
      else {
        const saved = await request("/api/task-templates", {
          method: "POST",
          body: { name, config },
        });
        selectedTemplate = saved.id;
      }
      await load({ keep: true });
      toast("模板已保存");
    }
    if (b.id === "delete-template") {
      const current = (state.taskTemplates || []).find(
        (x) => x.id === selectedTemplate,
      );
      if (current && confirm(`删除模板“${current.name}”？`)) {
        await request(`/api/task-templates/${current.id}`, {
          method: "DELETE",
        });
        selectedTemplate = "";
        await load({ keep: true });
      }
    }
    if (b.id === "add-account") {
      const account = await request("/api/accounts", { method: "POST" });
      await request(`/api/accounts/${account.id}/login`, { method: "POST" });
      await load({ keep: true });
    }
    if (b.id === "cancel-login") {
      await request("/api/login-session/cancel", { method: "POST" });
      await load({ keep: true });
    }
    if (b.dataset.selectAccounts) {
      selectedAccounts = b.dataset.selectAccounts === "all"
        ? new Set([...document.querySelectorAll('#account-list .account-row:not(.hidden)')].map(row => row.dataset.accountId).filter(Boolean))
        : new Set();
      renderAccounts();
    }
    if (b.dataset.bulkAccounts) {
      if (!selectedAccounts.size) throw new Error("请先选择账号");
      if (
        b.dataset.bulkAccounts === "delete" &&
        !confirm(`确定删除 ${selectedAccounts.size} 个账号及本机登录资料？`)
      )
        return;
      const r = await request("/api/accounts/bulk", {
        method: "POST",
        body: { ids: [...selectedAccounts], action: b.dataset.bulkAccounts },
      });
      const succeeded = r.results.filter((x) => x.ok).length;
      const failed = r.results.length - succeeded;
      const verb = { enable: '启用', disable: '停用', delete: '删除' }[b.dataset.bulkAccounts] || '处理';
      toast('已' + verb + ' ' + succeeded + ' 个账号' + (failed ? '，失败 ' + failed + ' 个' : ''));
      selectedAccounts.clear();
      await load({ keep: true });
    }
    if (b.dataset.accountAction) await accountAction(b);
    if (b.dataset.bulkMaterial) {
      const type = b.dataset.bulkMaterial,
        set = selectedMaterials[type];
      if (!set.size) throw new Error("请先选择文案");
      if (confirm(`删除所选 ${set.size} 条文案？`)) {
        await request(
          `/api/${type === "post" ? "post-materials" : "comment-materials"}/bulk-delete`,
          { method: "POST", body: { ids: [...set] } },
        );
        set.clear();
        await load({ keep: true });
      }
    }
  } catch (err) {
    toast(err.message);
  }
});
async function accountAction(b) {
  const a = state.accounts.find((x) => x.id === b.dataset.id),
    action = b.dataset.accountAction;
  if (action === "delete") {
    if (!confirm(`删除账号“${a.nickname || a.name}”及本机登录资料？`)) return;
    await request(`/api/accounts/${a.id}`, { method: "DELETE" });
  } else if (action === "login")
    await request(`/api/accounts/${a.id}/login`, { method: "POST" });
  else if (action === "toggle") {
    const row = document.querySelector(`#account-list .account-row[data-account-id="${a.id}"]`);
    const previous = a.enabled;
    a.enabled = !previous;
    paintAccountEnabled(row, a.enabled);
    try {
      await request(`/api/accounts/${a.id}`, { method: "PATCH", body: { enabled: a.enabled } });
      toast(a.enabled ? '账号已启用' : '账号已停用');
    } catch (error) {
      a.enabled = previous;
      paintAccountEnabled(row, previous);
      throw error;
    }
    return;
  }
  else {
    const i = state.accounts.findIndex((x) => x.id === a.id),
      other = state.accounts[i + (action === "up" ? -1 : 1)];
    if (other)
      await Promise.all([
        request(`/api/accounts/${a.id}`, {
          method: "PATCH",
          body: { sortOrder: other.sort_order },
        }),
        request(`/api/accounts/${other.id}`, {
          method: "PATCH",
          body: { sortOrder: a.sort_order },
        }),
      ]);
  }
  await load({ keep: true });
}
function paintAccountEnabled(row, enabled) {
  if (!row) return;
  row.dataset.enabled = enabled ? '1' : '0';
  row.classList.toggle('account-disabled', !enabled);
  const tags = row.querySelector('.row-tags');
  if (tags) {
    let pill = tags.querySelector('.account-disabled-pill');
    if (!enabled && !pill) {
      pill = document.createElement('span');
      pill.className = 'status-pill account-disabled-pill';
      pill.textContent = '已停用';
      tags.append(pill);
    } else if (enabled && pill) pill.remove();
  }
  const button = row.querySelector('[data-account-action="toggle"]');
  if (button) {
    button.textContent = enabled ? '停用' : '启用';
    button.className = enabled ? 'danger' : 'quiet';
  }
  applyAccountFilter();
}
const today = () =>
  new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Shanghai" }).format(
    new Date(),
  );
let recordData = { logs: [], actions: [], jobs: [], rounds: [] },
  recordDate = today();
let recordsLoading = false,
  recordsError = "",
  recordRefreshTimer = null;
const recordUI = createRecordUI({ request, reload: () => loadRecords(recordDate), date: () => recordDate, filter: () => $("#log-filter").value, changed: () => { ++recordsVersion; }, toast });
function syncRecordUrl() {
  const params = new URLSearchParams(location.search);
  params.set("recordDate", recordDate);
  params.set("recordFilter", $("#log-filter")?.value || "all");
  history.replaceState(null, "", `?${params}`);
}
$("#login-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  try {
    await request("/api/login", {
      method: "POST",
      body: { token: $("#token").value },
    });
    $("#login-error").textContent = "";
    showApp();
    await load();
    await loadRecords(recordDate);
    connect();
  } catch (err) {
    $("#login-error").textContent = err.message;
  }
});
$("#activate-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  try {
    await request("/api/license/activate", {
      method: "POST",
      body: { code: $("#license-code").value.trim() },
    });
    $("#activate-error").textContent = "";
    $("#license-code").value = "";
    showLogin();
  } catch (err) {
    $("#activate-error").textContent = err.message;
  }
});
document.addEventListener("change", (e) => {
  if (e.target.dataset.planType) {
    const index = Number(e.target.dataset.planType);
    const item = config.actionPlan[index];
    item.type = e.target.value;
    // Replacing a type is a new segment; completed rows from the old segment
    // remain historical while its unsubmitted rows are cancelled on save.
    item.segmentId = `seg_${crypto.randomUUID()}`;
    config.segmentIds = [...(config.segmentIds || [])];
    config.segmentIds[index] = item.segmentId;
    item.intervalSeconds = DEFAULT_ACTION_INTERVALS[item.type];
    renderPlan();
    renderSummary();
  }
});
function isEditing() {
  return ["INPUT", "TEXTAREA", "SELECT"].includes(
    document.activeElement?.tagName,
  );
}
function renderLive() {
  if (!state) return;
  renderBrowser();
  renderOverview({ configFields: false });
  reportUI?.render();
  renderDailyStop(state);
  verificationUI?.render();
}
function connect() {
  events?.close();
  eventsConnected = false;
  const es = (events = new EventSource("/api/events"));
  es.onopen = () => {
    eventsConnected = true;
    lastEventAt = Date.now();
    $("#connection-dot").classList.add("online");
    $("#connection-text").textContent = "实时连接";
    void syncLiveState();
  };
  es.onerror = () => {
    eventsConnected = false;
    $("#connection-dot").classList.remove("online");
    $("#connection-text").textContent = "正在重连";
  };
  es.addEventListener("state", (e) => {
    lastEventAt = Date.now();
    if (!acceptState(JSON.parse(e.data))) return;
    renderLive();
    if (!isEditing()) {
      renderAccounts();
      renderSelection();
      renderTemplate();
    }
  });
  es.addEventListener("job", () => {
    lastEventAt = Date.now();
    load({ keep: true }).catch(() => {});
    scheduleRecordsRefresh();
  });
  es.addEventListener("verification", (e) => {
    lastEventAt = Date.now();
    const update = JSON.parse(e.data);
    if (
      !state ||
      Number(update.version || 0) < Number(state.verificationVersion || 0)
    )
      return;
    state.verificationVersion = update.version;
    state.verification = update.verification;
    verificationUI?.render();
  });
  es.addEventListener("round-completed", () => {
    lastEventAt = Date.now();
    load({ keep: true }).catch(() => {});
    scheduleRecordsRefresh();
  });
}
document.addEventListener('visibilitychange', () => { if (!document.hidden) void syncLiveState(); });
window.addEventListener('focus', () => { void syncLiveState(); });
setInterval(() => { if (!eventsConnected || Date.now() - lastEventAt >= 15000) void syncLiveState(); }, 10000);
async function loadRecords(date = recordDate, { silent = false } = {}) {
  const version = ++recordsVersion;
  recordDate = date;
  recordsLoading = true;
  recordsError = "";
  if (!silent) renderLogs();
  try {
    const next = await request("/api/records?" + new URLSearchParams({date, ...recordUI.params()}));
    if (version !== recordsVersion) return;
    recordData = next;
    syncRecordUrl();
  } catch (error) {
    if (version === recordsVersion)
      recordsError = error.message || "记录加载失败";
  } finally {
    if (version === recordsVersion) {
      recordsLoading = false;
      renderLogs();
    }
  }
}
function scheduleRecordsRefresh() {
  clearTimeout(recordRefreshTimer);
  recordRefreshTimer = setTimeout(
    () => loadRecords(recordDate, { silent: true }).catch(() => {}),
    250,
  );
}
function logEntryLevel(state) {
  return (
    {
      succeeded: "success",
      submitted: "warning",
      uncertain: "warning",
      failed: "error",
      skipped: "info",
      verification_wait: "warning",
      prepared: "info",
      cancelled: "info",
    }[state] || "info"
  );
}

function mergedLogEntries(filter) {
  const entries = [
    ...recordData.logs.map((item) => ({
      ...item,
      created_at: item.created_at,
      level: item.level || "info",
      message: item.message || "",
      account_name: item.account_name,
      topic_name: item.topic_name,
      url: item.url,
    })),
    ...recordData.actions.map((item) => ({
      ...item,
      created_at: item.started_at,
      level: logEntryLevel(item.state),
      message:
        kind(item.kind) +
        " · " +
        stateName(item.state) +
        (item.error ? "：" + item.error : ""),
    })),
  ];
  return entries
    .filter((item) => filter === "all" || item.level === filter)
    .sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
}

function logRowHtml(x) {
  const link =
    x.url && String(x.url).indexOf("http") === 0
      ? '<a href="' +
        esc(x.url) +
        '" target="_blank" rel="noreferrer">打开目标帖</a>'
      : "";
  return (
    '<article class="log-row"><time>' +
    time(x.created_at) +
    "</time><div><strong>" +
    esc(x.account_name || "系统") +
    (x.topic_name ? " · " + esc(x.topic_name) : "") +
    "</strong><div>" +
    esc(x.message) +
    "</div>" +
    link +
    '</div><span class="result ' +
    x.level +
    '">' +
    level(x.level) +
    "</span></article>"
  );
}

function renderLogSummary() {
  const node = $("#log-summary");
  if (!node) return;
  const view = recordData.recordView;
  const stats = recordData.dailyStats;
  const daily = recordData.dailySuccess || {};
  const perKind = { checkin: {}, post: {}, comment: {} };
  for (const a of recordData.actions || []) {
    if (!perKind[a.kind]) continue;
    perKind[a.kind][a.state] = (perKind[a.kind][a.state] || 0) + 1;
  }
  const stat = (k, key) => {
    const fromView = view?.counts?.[k]?.[key];
    if (fromView != null) return fromView;
    const fromStats = stats?.counts?.[k]?.[key];
    if (fromStats != null) return fromStats;
    return perKind[k][key] || 0;
  };
  const abnormal = new Map();
  for (const r of recordData.rounds || [])
    for (const acc of r.abnormalAccounts || []) {
      const key = acc.uid || acc.name || acc.id;
      if (key && !abnormal.has(key)) abnormal.set(key, acc);
    }
  const columns = ["checkin", "post", "comment"]
    .map(
      (k) =>
        '<div class="log-summary-kind"><span>' + kind(k) +
        '</span><strong>' + Number(daily[k] || 0) +
        '</strong><small>失败 ' + stat(k, "failed") +
        ' · 待核对 ' + stat(k, "uncertain") +
        ' · 跳过 ' + stat(k, "skipped") +
        "</small></div>",
    )
    .join("");
  node.innerHTML =
    '<header><h2>当日汇总</h2><span>' + (view?.archived ? "归档记录" : "北京时间") + '</span></header><div class="log-summary-grid">' +
    columns +
    '<div class="log-summary-meta"><span>任务</span><strong>' +
    Number(stats?.jobCount ?? recordData.jobs.length ?? 0) +
    '</strong><small>异常账号 ' + Number(view?.abnormalCount ?? stats?.abnormalAccounts ?? abnormal.size) + ' 个</small></div></div>';
}

function renderKeyEvents(entries) {
  const list = $("#key-event-list");
  const section = $("#key-events");
  const btn = $("[data-expand-events]");
  if (!list || !section) return;
  const important = entries.filter(
    (x) => x.level === "error" || x.level === "warning",
  );
  const wasExpanded = !section.classList.contains("collapsed");
  list.innerHTML =
    important.map(logRowHtml).join("") ||
    '<div class="empty">今天没有需要关注的事件。</div>';
  const overflow = important.length > 5;
  section.classList.toggle("collapsed", overflow && !wasExpanded);
  if (btn) {
    btn.classList.toggle("hidden", !overflow);
    btn.setAttribute("aria-expanded", String(overflow && wasExpanded));
    btn.textContent = overflow && wasExpanded ? "收起" : "查看全部";
  }
}

function renderFlow(entries) {
  const list = $("#log-list");
  if (!list) return;
  list.innerHTML =
    entries.map(logRowHtml).join("") ||
    (!recordsLoading && !recordsError
      ? '<div class="empty">没有符合条件的记录。</div>'
      : "");
  const toggle = $("#log-flow-toggle");
  if (toggle) {
    if (recordData.recordView) { toggle.textContent = '全部流水'; return; }
    const count = list.querySelectorAll(".log-row").length;
    toggle.textContent =
      (toggle.getAttribute("aria-expanded") === "true"
        ? "收起操作流水"
        : "查看全部操作流水") +
      "（" + count + " 条）";
  }
}

function renderLogs() {
  const date = $("#record-date");
  if (!date) return;
  date.value = recordDate;
  const filter = $("#log-filter").value;
  const statusNode = $("#record-status");
  if (statusNode)
    statusNode.innerHTML = recordsLoading
      ? '<div class="empty">正在加载记录…</div>'
      : recordsError
        ? '<div class="empty">记录加载失败：' +
          esc(recordsError) +
          ' <button class="quiet" data-retry-records type="button">重试</button></div>'
        : "";
  renderLogSummary();
  if (recordData.recordView) {
    recordUI.render(recordData);
    return;
  }
  if (recordsLoading || recordsError) return;
  const entries = mergedLogEntries(filter);
  renderKeyEvents(entries);
  renderRecordJobs(recordData, $("#job-list"));
  if (!recordData.jobs.length)
    $("#job-list").innerHTML = '<div class="empty">当天没有任务记录。</div>';
  renderFlow(entries);
}
$("#record-date").addEventListener("change", (e) => {
  recordUI.reset();
  loadRecords(e.target.value).catch(() => {});
});
$("#log-filter").addEventListener("change", () => {
  syncRecordUrl();
  loadRecords(recordDate).catch(() => {});
});
document.addEventListener("click", (e) => {
  if (e.target.closest("[data-retry-records]")) {
    loadRecords(recordDate).catch(() => {});
    return;
  }
  if (e.target.closest("[data-expand-events]")) {
    const section = $("#key-events");
    const btn = $("[data-expand-events]");
    const expanded = !section.classList.contains("collapsed");
    section.classList.toggle("collapsed", expanded);
    if (btn) {
      btn.textContent = expanded ? "查看全部" : "收起";
      btn.setAttribute("aria-expanded", String(!expanded));
    }
    return;
  }
  if (e.target.closest("#log-flow-toggle")) {
    if (recordData.recordView) { void recordUI.openFlow(); return; }
    const list = $("#log-list");
    const toggle = $("#log-flow-toggle");
    const expanded = toggle.getAttribute("aria-expanded") === "true";
    list.classList.toggle("hidden", expanded);
    toggle.setAttribute("aria-expanded", String(!expanded));
    const count = list.querySelectorAll(".log-row").length;
    toggle.textContent = expanded
      ? "查看全部操作流水（" + count + " 条）"
      : "收起操作流水（" + count + " 条）";
    return;
  }
});
verificationUI = createVerificationUI({
  getState: () => state,
  request,
  refresh: () => load({ keep: true }),
  toast,
});
groupUI = createGroupUI({
  getState: () => state,
  getConfig: () => config,
  getSelected: () => selectedAccounts,
  request,
  refresh: async () => {
    await load({ keep: true });
    renderAccounts();
    renderSelection();
  },
  updateSummary: renderSummary,
  toast,
});
reportUI = createReportUI({
  request,
  getState: () => state,
  toast,
  loadDailySuccess: async (date) => {
    const records = await request(
      "/api/records?date=" + encodeURIComponent(date),
    );
    return records.dailySuccess;
  },
  viewReport: async (report) => {
    navigate("logs");
    await loadRecords(localDate(report.completedAt));
    for (let attempt = 0; attempt < 15; attempt++) {
      if (recordUI.openJob(report.jobId)) return;
      await new Promise(resolve => setTimeout(resolve, 120));
    }
  },
});
setInterval(() => {
  if (state && state.dailySuccess?.date !== localDate())
    load({ keep: true }).catch(() => {});
}, 30000);
async function boot() {
  const license = await fetch("/api/license/status").then((r) => r.json());
  if (!license.activated) return showActivate();
  const r = await fetch("/api/session"),
    s = await r.json();
  const params = new URLSearchParams(location.search);
  recordDate = params.get("recordDate") || today();
  const savedFilter = params.get("recordFilter");
  if (
    savedFilter &&
    $("#log-filter").querySelector(`option[value="${savedFilter}"]`)
  )
    $("#log-filter").value = savedFilter;
  if (!s.authenticated) return showLogin();
  showApp();
  await load();
  await loadRecords(recordDate);
  connect();
}
boot().catch((e) => {
  showLogin();
  $("#login-error").textContent = e.message;
});
