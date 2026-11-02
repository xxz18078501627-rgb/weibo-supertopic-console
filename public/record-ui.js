import { roundHtml, duration } from "./report-ui.js";

const localTime = value => (value ? new Intl.DateTimeFormat("zh-CN", { timeZone: "Asia/Shanghai", month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" }).format(new Date(value)) : "");

const esc = (x = "") => String(x ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const kind = x => ({ checkin: "签到", post: "发帖", comment: "评论" })[x] || "";
const stateName = x => ({ succeeded: "成功", failed: "失败", uncertain: "待核对", submitted: "待核对", skipped: "跳过", verification_wait: "待验证", prepared: "准备中", cancelled: "取消" })[x] || x || "";
const displayState = action => action.display_state || action.state;
const jobStatus = x => ({ running: "运行中", waiting: "等待中", paused: "已暂停", completed: "已完成", stopped: "已中止", failed: "失败" })[x] || x || "";
const timeOf = x => (x ? new Date(x).toLocaleTimeString("zh-CN", { timeZone: "Asia/Shanghai", hour12: false }) : "");
const PAGE = { issues: 6, accounts: 7, jobs: 5, flow: 7, dialog: 20 };

export function createRecordUI({ request, reload, date, filter, changed, toast = () => {} }) {
  const grid = document.querySelector("#record-grid");
  const archivedBox = document.querySelector("#record-archived");
  const searchInput = document.querySelector("#record-search");
  const abnormalBtn = document.querySelector("#record-abnormal");
  const dialog = document.createElement("dialog");
  dialog.className = "record-detail-dialog";
  dialog.setAttribute("aria-label", "记录详情");
  document.body.append(dialog);

  const params = new URLSearchParams(location.search);
  let query = params.get("recordSearch") || "";
  let abnormal = params.get("recordAbnormal") === "1";
  if (searchInput) searchInput.value = query;
  let timer = null;
  let version = 0;
  let latest = null;
  const pages = { issues: 0, accounts: 0, jobs: 0 };
  const flow = { rows: [], cursor: "", snapshot: "", total: 0, index: 0, cursors: [""], loaded: false, loading: false };
  const detail = { identity: "", rows: [], snapshot: "", total: 0, index: 0, cursors: [""], cache: new Map(), loading: false };

  function url(extra = {}) {
    return "/api/records?" + new URLSearchParams({ date: date(), q: query, abnormal: abnormal ? "1" : "0", level: filter(), ...extra });
  }
  function syncUrl() {
    const p = new URLSearchParams(location.search);
    if (query) p.set("recordSearch", query); else p.delete("recordSearch");
    if (abnormal) p.set("recordAbnormal", "1"); else p.delete("recordAbnormal");
    history.replaceState(null, "", "?" + p);
  }
  function resetPages() {
    pages.issues = 0; pages.accounts = 0; pages.jobs = 0;
    flow.rows = []; flow.cursor = ""; flow.snapshot = ""; flow.total = 0; flow.index = 0; flow.cursors = [""]; flow.loaded = false;
  }
  function refresh() { version++; syncUrl(); resetPages(); changed(); void reload().catch(() => {}); }

  searchInput?.addEventListener("input", event => {
    query = event.target.value.trim();
    clearTimeout(timer);
    timer = setTimeout(refresh, 250);
  });
  document.querySelector("#record-clear")?.addEventListener("click", () => {
    query = ""; if (searchInput) searchInput.value = ""; refresh();
  });
  abnormalBtn?.addEventListener("click", () => { abnormal = !abnormal; refresh(); });

  function pagerHtml(section, index, total) {
    const pages_ = Math.max(1, total);
    return "<footer class='panel-pager'><button type='button' class='quiet' data-pager-prev='" + section + "'" + (index <= 0 ? " disabled" : "") + ">上一页</button><span>" + String(total ? index + 1 : 0) + " / " + String(total) + "</span><button type='button' class='quiet' data-pager-next='" + section + "'" + (index >= pages_ - 1 ? " disabled" : "") + ">下一页</button></footer>";
  }
  function pageOf(list, index, size) { return list.slice(index * size, index * size + size); }
  function pageCount(list, size) { return Math.ceil(list.length / size); }

  function issueRow(issue) {
    const tag = [kind(issue.kinds?.[0] || issue.kind), issue.type].filter(Boolean).map(esc).join(" ");
    return "<article class='record-issue'><div><strong>" + esc(issue.name) + "</strong><span class='result warning'>" + tag + "</span><small>" + String(issue.count) + " 次 · " + esc(timeOf(issue.latest)) + "</small></div>" +
      (issue.identity ? "<button type='button' class='text-button' data-record-account='" + esc(issue.identity) + "'>详情</button>" : "<button type='button' class='text-button' data-record-flow>流水</button>") + "</article>";
  }
  function accountRow(account) {
    const shown = account.tags.slice(0, 2);
    const tags = shown.map(tag => "<span class='result warning'>" + esc(kind(tag.kind)) + " " + esc(tag.type) + "</span>").join(" ") + (account.tags.length > 2 ? "<span class='result'>+" + (account.tags.length - 2) + "</span>" : "");
    const counts = ["checkin", "post", "comment"].map(k => "<span>" + kind(k) + " " + account.counts[k].succeeded + "/" + account.counts[k].failed + "/" + account.counts[k].uncertain + "</span>").join("");
    return "<article class='record-account-row'><div class='record-account-main'><strong title='UID " + esc(account.uid || "—") + "'>" + esc(account.name) + "</strong>" + tags + "</div><div class='record-account-counts'>" + counts + "</div><button type='button' class='quiet' data-record-account='" + esc(account.identity) + "'>详情</button></article>";
  }
  function uncertainRow(action) {
    const target = action.target_id ? '目标 ' + action.target_id : (action.content ? String(action.content).slice(0, 42) : '');
    const reason = action.error || action.reason || '提交结果未确认';
    const shownState = displayState(action);
    return "<article class='record-uncertain-row'><div class='record-uncertain-main'><strong>" + esc(action.account_name || '账号') + "</strong><span class='result " + shownState + "'>" + esc(kind(action.kind) + ' · ' + stateName(shownState)) + "</span><small>" + esc(timeOf(action.started_at)) + " · " + esc(reason) + "</small>" + (target ? "<small class='record-uncertain-target'>" + esc(target) + "</small>" : '') + "</div>" + (['post','comment'].includes(action.kind) ? "<button type='button' class='quiet' data-recheck-action='" + esc(action.id) + "' data-recheck-job='" + esc(action.job_id) + "'>复核</button>" : '') + "</article>";
  }
  function jobRow(job, counts) {
    const c = counts?.[job.id];
    const success = c ? c.succeeded : (job.metrics?.success || 0);
    const failed = c ? c.failed : (job.metrics?.failed || 0);
    const uncertain = c ? c.uncertain : (job.metrics?.uncertain || 0);
    const skipped = c ? c.skipped : (job.metrics?.skipped || 0);
    const spent = Math.max(0, Date.parse(job.updated_at || job.created_at) - Date.parse(job.created_at));
    return "<article class='record-row record-job' data-record-job='" + esc(job.id) + "' tabindex='0' role='button'><strong>" + esc(jobStatus(job.status)) + "</strong><time>" + esc(localTime(job.created_at)) + "</time><span class='record-job-counts'>成功 " + success + " · 失败 " + failed + " · 待核对 " + uncertain + " · 跳过 " + skipped + "</span><em>" + esc(duration(spent)) + "</em></article>";
  }
  function flowRow(row) {
    const label = row.source === "action" ? kind(row.kind) + " · " + stateName(displayState(row)) : esc(row.type || "记录");
    return "<article class='record-row record-flow-row'><time>" + esc(timeOf(row.created_at || row.started_at)) + "</time><strong>" + esc(row.account_name || "系统") + "</strong><span>" + label + "</span></article>";
  }

  function renderIssues() {
    const section = document.querySelector("#key-events");
    const list = document.querySelector("#key-event-list");
    if (!section || !list) return;
    const issues = latest?.recordView?.issues || [];
    const total = pageCount(issues, PAGE.issues);
    section.dataset.pages = String(total);
    list.innerHTML = pageOf(issues, pages.issues, PAGE.issues).map(issueRow).join("") || "<div class='empty'>无异常</div>";
    section.querySelector(".panel-pager")?.remove();
    section.insertAdjacentHTML("beforeend", pagerHtml("issues", pages.issues, total));
    const count = document.querySelector("#record-issue-count");
    if (count) count.textContent = total ? String(issues.length) + " 条" : "";
  }
  function renderAccounts() {
    const section = document.querySelector("#record-accounts");
    const list = document.querySelector("#record-account-list");
    if (!section || !list) return;
    const uncertain = latest?.recordView?.uncertain
      || (latest?.actions || []).filter(action => ['uncertain', 'submitted'].includes(displayState(action)));
    const heading = section.querySelector('.panel-head h2');
    if (uncertain.length) {
      if (heading) heading.textContent = '待核对操作';
      const q = query.toLocaleLowerCase();
      const filtered = uncertain.filter(action => !q || [action.account_name, action.content, action.error, action.target_id].some(value => String(value || '').toLocaleLowerCase().includes(q)));
      const total = pageCount(filtered, PAGE.accounts);
      list.innerHTML = pageOf(filtered, pages.accounts, PAGE.accounts).map(uncertainRow).join('') || "<div class='empty'>无匹配待核对操作</div>";
      section.querySelector('.panel-pager')?.remove();
      section.insertAdjacentHTML('beforeend', pagerHtml('accounts', pages.accounts, total));
      const count = document.querySelector('#record-account-count');
      if (count) count.textContent = String(filtered.length) + ' 条';
      return;
    }
    if (heading) heading.textContent = '账号运行情况';
    const accounts = latest?.recordView?.accounts || [];
    const total = pageCount(accounts, PAGE.accounts);
    list.innerHTML = pageOf(accounts, pages.accounts, PAGE.accounts).map(accountRow).join("") || "<div class='empty'>无匹配账号</div>";
    section.querySelector(".panel-pager")?.remove();
    section.insertAdjacentHTML("beforeend", pagerHtml("accounts", pages.accounts, total));
    const count = document.querySelector("#record-account-count");
    if (count) count.textContent = accounts.length ? String(accounts.length) + " 个" : "";
  }
  function renderJobs() {
    const section = document.querySelector("#record-jobs");
    const list = document.querySelector("#job-list");
    if (!section || !list) return;
    const jobs = latest?.jobs || [];
    const total = pageCount(jobs, PAGE.jobs);
    list.innerHTML = pageOf(jobs, pages.jobs, PAGE.jobs).map(job => jobRow(job, latest?.recordView?.jobCounts)).join("") || "<div class='empty'>当天没有任务记录。</div>";
    section.querySelector(".panel-pager")?.remove();
    section.insertAdjacentHTML("beforeend", pagerHtml("jobs", pages.jobs, total));
    const count = document.querySelector("#record-job-count");
    if (count) count.textContent = jobs.length ? String(jobs.length) + " 个" : "";
  }
  function renderFlow() {
    const section = document.querySelector("#record-flow");
    const list = document.querySelector("#log-list");
    if (!section || !list) return;
    if (flow.loading) { list.innerHTML = "<div class='empty'>正在加载流水…</div>"; return; }
    list.innerHTML = flow.rows.map(flowRow).join("") || "<div class='empty'>没有符合条件的流水。</div>";
    const total = Math.ceil(flow.total / PAGE.flow);
    section.querySelector(".panel-pager")?.remove();
    section.insertAdjacentHTML("beforeend", pagerHtml("flow", flow.index, total));
    const count = document.querySelector("#record-flow-count");
    if (count) count.textContent = flow.total ? String(flow.total) + " 条" : "";
  }
  async function loadFlow(index) {
    if (flow.loading) return;
    const ticket = version;
    flow.loading = true; renderFlow();
    try {
      const cursor = flow.cursors[index] || "";
      const result = await request(url({ panel: "flow", cursor, snapshot: flow.snapshot, limit: String(PAGE.flow) }));
      if (ticket !== version) return;
      const view = result.recordView;
      if (!view) throw new Error("服务更新后可查看流水");
      if (index === 0) flow.snapshot = view.snapshot || "";
      flow.rows = view.details || [];
      flow.total = view.detailTotal || 0;
      flow.index = index;
      flow.cursors[index + 1] = view.nextCursor || "";
      flow.loaded = true;
    } catch (error) {
      if (ticket === version) document.querySelector("#log-list").innerHTML = "<div class='empty'>" + esc(error.message || "流水加载失败") + "</div>";
    } finally {
      if (ticket === version) { flow.loading = false; renderFlow(); }
    }
  }
  function renderArchived() {
    const stats = latest?.dailyStats || {};
    const counts = stats.counts || {};
    const row = k => "<div><span>" + kind(k) + "</span><strong>" + Number(counts[k]?.succeeded || 0) + "</strong><small>失败 " + Number(counts[k]?.failed || 0) + " · 待核对 " + Number(counts[k]?.uncertain || 0) + " · 跳过 " + Number(counts[k]?.skipped || 0) + "</small></div>";
    archivedBox.innerHTML = "<p>该日期详细记录已按 10 天保留清理，以下是当天归档的任务计数。</p><div class='log-summary-grid'>" + ["checkin", "post", "comment"].map(row).join("") + "<div class='log-summary-meta'><span>任务</span><strong>" + Number(stats.jobCount || 0) + "</strong><small>异常账号 " + Number(stats.abnormalAccounts || 0) + " 个</small></div></div>";
  }

  function detailRow(row) {
    const label = row.source === "action" ? kind(row.kind) + " · " + stateName(displayState(row)) : row.type || "记录";
    return "<article class='record-detail-row'><header><b>" + esc(row.account_name || "系统") + "</b><time>" + esc(timeOf(row.created_at || row.started_at)) + "</time><span>" + esc(label) + "</span></header>" + (row.topic_name ? "<small>" + esc(row.topic_name) + "</small>" : "") + (row.message || row.error ? "<p>" + esc(row.message || row.error) + "</p>" : "") + (row.content ? "<details><summary>文案</summary><p>" + esc(row.content) + "</p></details>" : "") + (/^https?:\/\//.test(row.url || "") ? "<a href='" + esc(row.url) + "' target='_blank' rel='noreferrer'>目标帖</a>" : "") + "</article>";
  }
  function paintDialog(title, body, footer) {
    dialog.innerHTML = "<div class='dialog-head'><h2>" + esc(title) + "</h2><button type='button' class='text-button' data-close-record>关闭</button></div><div class='record-detail-body'><div id='record-detail-rows'>" + body + "</div></div>" + (footer || "") + "<p id='record-detail-error' role='alert'></p>";
  }
  async function openAccount(identity, index = 0) {
    const ticket = ++version;
    detail.identity = identity;
    if (index === 0) { detail.cache = new Map(); detail.cursors = [""]; detail.snapshot = ""; }
    const cached = detail.cache.get(index);
    paintDialog("账号详情", cached ? cached.rows.map(detailRow).join("") : "<div class='empty'>正在加载…</div>", "<footer class='panel-pager'><button type='button' class='quiet' data-detail-prev" + (index <= 0 ? " disabled" : "") + ">上一页</button><span>" + String(index + 1) + " / " + String(cached?.pages || Math.max(1, detail.pages || 1)) + "</span><button type='button' class='quiet' data-detail-next" + (cached && !cached.hasMore ? " disabled" : "") + ">下一页</button></footer>");
    if (!dialog.open) dialog.showModal();
    if (cached) { detail.index = index; return; }
    detail.loading = true;
    try {
      const result = await request(url({ panel: "identity", identity, cursor: detail.cursors[index] || "", snapshot: detail.snapshot, limit: String(PAGE.dialog) }));
      if (ticket !== version || !dialog.open) return;
      const view = result.recordView;
      if (!view) throw new Error("服务更新后可查看详情");
      if (index === 0) detail.snapshot = view.snapshot || "";
      detail.pages = Math.max(1, Math.ceil((view.detailTotal || 0) / PAGE.dialog));
      detail.cursors[index + 1] = view.nextCursor || "";
      detail.cache.set(index, { rows: view.details || [], hasMore: Boolean(view.nextCursor), pages: detail.pages });
      detail.index = index;
      paintDialog("账号详情", (view.details || []).map(detailRow).join("") || "<div class='empty'>无记录</div>", "<footer class='panel-pager'><button type='button' class='quiet' data-detail-prev" + (index <= 0 ? " disabled" : "") + ">上一页</button><span>" + String(index + 1) + " / " + String(detail.pages) + "</span><button type='button' class='quiet' data-detail-next" + (view.nextCursor ? "" : " disabled") + ">下一页</button></footer>");
    } catch (error) {
      if (ticket === version) { const node = dialog.querySelector("#record-detail-error"); if (node) node.textContent = error.message || "加载失败"; }
    } finally {
      if (ticket === version) detail.loading = false;
    }
  }
  function openJob(jobId) {
    const job = (latest?.jobs || []).find(item => item.id === jobId);
    if (!job) return false;
    try {
      const rounds = (latest?.rounds || []).filter(report => report.jobId === jobId);
      const body = rounds.length ? rounds.map(roundHtml).join("") : "<p class='empty'>无逐轮计时记录。</p>";
      paintDialog("任务明细 · " + jobStatus(job.status), body);
      if (!dialog.open) dialog.showModal();
      return true;
    } catch (error) {
      return false;
    }
  }

  dialog.addEventListener("click", event => {
    if (event.target.closest("[data-close-record]")) { version++; dialog.close(); return; }
    if (event.target.closest("[data-detail-prev]")) { void openAccount(detail.identity, Math.max(0, detail.index - 1)); return; }
    if (event.target.closest("[data-detail-next]")) { void openAccount(detail.identity, detail.index + 1); return; }
  });
  dialog.addEventListener("cancel", () => { version++; });

  document.addEventListener("click", event => {
    const recheck = event.target.closest('[data-recheck-action]');
    if (recheck) {
      const button = recheck;
      button.disabled = true;
      request('/api/jobs/' + encodeURIComponent(button.dataset.recheckJob) + '/actions/' + encodeURIComponent(button.dataset.recheckAction) + '/recheck', { method: 'POST' })
        .then(result => { toast(result.state === 'succeeded' ? '已复核为成功' : (result.reason || '仍未找到匹配内容')); return reload(); })
        .catch(error => { toast(error.message || '复核失败'); button.disabled = false; });
      return;
    }
    const accountBtn = event.target.closest("[data-record-account]");
    if (accountBtn) { void openAccount(accountBtn.dataset.recordAccount); return; }
    const jobBtn = event.target.closest("[data-record-job]");
    if (jobBtn) { openJob(jobBtn.dataset.recordJob); return; }
    const prev = event.target.closest("[data-pager-prev]");
    if (prev) {
      const section = prev.dataset.pagerPrev;
      if (section === "flow") { if (flow.index > 0) void loadFlow(flow.index - 1); return; }
      pages[section] = Math.max(0, pages[section] - 1);
      if (section === "issues") renderIssues(); else if (section === "accounts") renderAccounts(); else renderJobs();
      return;
    }
    const next = event.target.closest("[data-pager-next]");
    if (next) {
      const section = next.dataset.pagerNext;
      if (section === "flow") { void loadFlow(flow.index + 1); return; }
      pages[section] += 1;
      if (section === "issues") renderIssues(); else if (section === "accounts") renderAccounts(); else renderJobs();
    }
  });

  function render(next) {
    latest = next || null;
    const view = latest?.recordView;
    if (!view) {
      grid?.classList.add("hidden");
      archivedBox?.classList.add("hidden");
      return;
    }
    if (abnormalBtn) { abnormalBtn.setAttribute("aria-pressed", String(abnormal)); abnormalBtn.textContent = "异常 " + Number(view.abnormalCount || 0); }
    const isArchived = Boolean(view.archived);
    grid?.classList.toggle("hidden", isArchived);
    archivedBox?.classList.toggle("hidden", !isArchived);
    if (isArchived) { renderArchived(); return; }
    renderIssues();
    renderAccounts();
    renderJobs();
    if (!flow.loaded) void loadFlow(0); else renderFlow();
  }

  return {
    render,
    params: () => ({ q: query, abnormal: abnormal ? "1" : "0", level: filter() }),
    openFlow: () => { if (!flow.loaded) void loadFlow(0); },
    openJob: (jobId) => openJob(jobId),
    reset: () => { version++; resetPages(); if (dialog.open) dialog.close(); }
  };
}
