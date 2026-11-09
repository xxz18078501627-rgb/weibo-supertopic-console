const escapeHtml = (value = '') => String(value).replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
const kindName = kind => ({ checkin: '签到', post: '发帖', original: '原创', comment: '评论', repost: '转发', like: '外赞', comment_like: '内赞' })[kind] || kind;
const stateName = state => ({ succeeded: '成功', failed: '失败', uncertain: '待核对', skipped: '跳过', submitted: '已提交', prepared: '准备中', verification_wait: '待验证', cancelled: '已取消' })[state] || state;
const displayState = action => action.display_state || action.state;
const statusName = status => ({ running: '运行中', waiting: '等待中', paused: '已暂停', completed: '已完成', stopped: '已中止', failed: '失败' })[status] || status;
export const localDate = value => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai' }).format(new Date(value || Date.now()));
const localTime = value => value ? new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai', month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit' }).format(new Date(value)) : '进行中';

export function duration(milliseconds) {
  const seconds = Math.max(0, Math.floor(Number(milliseconds || 0) / 1000));
  const hours = Math.floor(seconds / 3600), minutes = Math.floor(seconds % 3600 / 60);
  return `${hours ? `${hours}小时 ` : ''}${minutes ? `${minutes}分 ` : ''}${seconds % 60}秒`;
}

function countTable(counts = {}) {
  return `<div class="report-table-wrap"><table class="report-counts"><thead><tr><th>操作</th><th>成功</th><th>失败</th><th>待核对</th><th>跳过</th></tr></thead><tbody>${['checkin', 'post', 'original', 'comment', ...['repost','comment_like','like'].filter(kind => Object.values(counts[kind] || {}).some(Number))].map(kind => `<tr><th>${kindName(kind)}</th>${['succeeded', 'failed', 'uncertain', 'skipped'].map(state => `<td>${Number(counts[kind]?.[state] || 0)}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`;
}

function anomalies(accounts = []) {
  if (!accounts.length) return '<p class="report-good">本轮没有异常账号。</p>';
  return `<div class="report-anomalies"><h3>异常账号 ${accounts.length} 个</h3>${accounts.map(account => `<section><strong>${escapeHtml(account.name)}${account.uid ? ` · UID ${escapeHtml(account.uid)}` : ''}</strong><ul>${account.anomalies.map(item => `<li>${item.kind ? `${kindName(item.kind)} · ` : ''}${escapeHtml(item.topicName || '')} ${escapeHtml(item.reason)}${item.at ? ` <time>${localTime(item.at)}</time>` : ''}</li>`).join('')}</ul></section>`).join('')}</div>`;
}

function accountDetails(accounts = []) {
  return accounts.map(account => `<details class="report-account"><summary>${escapeHtml(account.name)} <small>${escapeHtml(account.groupName || '未分组')}${account.uid ? ` · UID ${escapeHtml(account.uid)}` : ''}</small>${account.anomalies.length ? '<span class="result warning">异常</span>' : ''}</summary>${countTable(account.counts)}<div class="report-actions">${(account.actions || []).map(action => `<article><div><b>${kindName(action.kind)} · ${escapeHtml(action.topic_name || '')}</b><span class="result ${displayState(action)}">${stateName(displayState(action))}</span></div><time>${localTime(action.started_at)}</time>${action.error ? `<p>${escapeHtml(action.error)}</p>` : ''}${action.content ? `<details><summary>查看文案</summary><p>${escapeHtml(action.content)}</p></details>` : ''}${action.url && /^https?:\/\//.test(action.url) ? `<a href="${escapeHtml(action.url)}" target="_blank" rel="noreferrer">打开目标帖</a>` : ''}</article>`).join('') || '<p>该账号没有操作记录。</p>'}</div></details>`).join('');
}

export function roundHtml(report) {
  return `<details class="round-report" data-report-key="${escapeHtml(report.jobId)}:${report.round}"><summary><b>第 ${report.round + 1} 轮 · ${statusName(report.status)}</b><span>耗时 ${duration(report.durationMs)}</span><small>${(report.abnormalAccounts || []).length ? `异常账号 ${(report.abnormalAccounts || []).length} 个` : '无异常账号'}</small></summary><div class="round-report-body"><p class="report-period">${localTime(report.startedAt)} — ${localTime(report.completedAt)} · ${report.accountCount} 个账号 / ${report.topicCount} 个${report.scope === 'engage' ? '微博链接' : '超话'}</p>${report.stopReason ? `<p class="report-stop-reason">${escapeHtml(report.stopReason)}</p>` : ''}${countTable(report.counts)}${anomalies(report.abnormalAccounts)}${report.verification?.accounts ? `<p class="report-period">验证账号 ${report.verification.accounts} 个 · 触发 ${report.verification.triggers} 次 · 补做成功 ${report.verification.succeeded} 项 · 待补 ${report.verification.pending} 项 · 待核对 ${report.verification.uncertain} 项</p>` : ''}${accountDetails(report.accounts)}</div></details>`;
}

function jobCounts(records) {
  const map = {};
  for (const action of records.actions || []) {
    if (!action.job_id) continue;
    const bucket = map[action.job_id] || (map[action.job_id] = { succeeded: 0, failed: 0, uncertain: 0, skipped: 0 });
    const shown = displayState(action);
    if (bucket[shown] != null) bucket[shown]++;
  }
  return map;
}

export function renderRecordJobs(records, element) {
  const opened = new Set([...element.querySelectorAll('details[open]')].map(node => node.dataset.reportKey || node.dataset.jobKey || node.querySelector('summary')?.textContent));
  const viewCounts = records.recordView?.jobCounts && Object.keys(records.recordView.jobCounts).length ? records.recordView.jobCounts : null;
  const counts = viewCounts || jobCounts(records);
  element.innerHTML = records.jobs.map(job => {
    const rounds = (records.rounds || []).filter(report => report.jobId === job.id);
    const c = counts[job.id];
    const success = c ? c.succeeded : (job.metrics?.success || 0);
    const failed = c ? c.failed : (job.metrics?.failed || 0);
    const uncertain = c ? c.uncertain : (job.metrics?.uncertain || 0);
    const skipped = c ? c.skipped : (job.metrics?.skipped || 0);
    const durationMs = Math.max(0, Date.parse(job.updated_at || job.created_at) - Date.parse(job.created_at));
    const stop = job.cursor?.stopReason ? '<p class="report-stop-reason">' + escapeHtml(job.cursor.stopReason) + '</p>' : '';
    const body = stop + (rounds.length ? rounds.map(roundHtml).join('') : '<p class="empty">无逐轮计时记录。</p>');
    return '<details class="job-item" data-job-key="' + escapeHtml(job.id) + '"><summary><b>' + statusName(job.status) + '</b><time>' + localTime(job.created_at) + '</time><span class="job-metrics">成功 ' + success + ' · 失败 ' + failed + ' · 待核对 ' + uncertain + ' · 跳过 ' + skipped + '</span><span class="job-duration">耗时 ' + duration(durationMs) + '</span><em class="job-hint">点击查看详细记录</em></summary><div>' + body + '</div></details>';
  }).join('');
  for (const node of element.querySelectorAll('details')) if (opened.has(node.dataset.reportKey || node.dataset.jobKey || node.querySelector('summary')?.textContent)) node.open = true;
}

export function createReportUI({ request, getState, toast, viewReport, loadDailySuccess }) {
  const daily = document.querySelector('#daily-success') || (() => { const node = document.createElement('section'); node.id = 'daily-success'; node.className = 'status-strip'; node.setAttribute('aria-label', '今日成功统计'); document.querySelector('#page-overview').prepend(node); return node; })();
  const dialog = document.createElement('dialog');
  dialog.id = 'round-complete-dialog'; dialog.className = 'round-complete-dialog';
  dialog.setAttribute('aria-labelledby', 'round-complete-title');
  document.body.append(dialog);
  const dateButton = daily.querySelector('#daily-date-button');
  const datePopover = daily.querySelector('#daily-date-popover');
  const dateInput = daily.querySelector('#daily-date');
  let current = null, confirming = false, selectedDailyDate = null, selectedDailyStats = null, loadingDaily = false;
  const reportKey = report => `${report.jobId}:${report.round}`;
  async function confirm(view = false) {
    if (!current || confirming) return;
    confirming = true;
    try {
      const report = current;
      await request(`/api/jobs/${report.jobId}/rounds/${report.round}/ack`, { method: 'POST' });
      const state = getState();
      state.pendingRoundReports = (state.pendingRoundReports || []).filter(item => reportKey(item) !== reportKey(report));
      current = null; dialog.close();
      if (view) await viewReport(report);
    } catch (error) { toast(error.message); }
    finally { confirming = false; render(); }
  }
  dialog.addEventListener('cancel', event => { event.preventDefault(); void confirm(); });
  dialog.addEventListener('click', event => {
    if (event.target.closest('[data-confirm-round]')) void confirm();
    if (event.target.closest('[data-view-round]')) void confirm(true);
  });
  dateButton?.addEventListener('click', () => datePopover?.classList.toggle('hidden'));
  daily.addEventListener('click', event => {
    if (!event.target.closest('#daily-today')) return;
    selectedDailyDate = null; selectedDailyStats = null; datePopover?.classList.add('hidden'); render();
  });
  dateInput?.addEventListener('change', async event => {
    const value = event.target.value;
    if (!value || loadingDaily) return;
    selectedDailyDate = value; loadingDaily = true;
    try { selectedDailyStats = await loadDailySuccess(value); }
    catch (error) { toast(error.message || '读取当天统计失败'); selectedDailyDate = null; selectedDailyStats = null; }
    finally { loadingDaily = false; datePopover?.classList.add('hidden'); render(); }
  });
  document.addEventListener('click', event => {
    if (!datePopover || datePopover.classList.contains('hidden')) return;
    if (event.target.closest('#daily-success')) return;
    datePopover.classList.add('hidden');
  });  function render() {
    const state = getState(); if (!state) return;
    const today = localDate(), stats = selectedDailyStats || state.dailySuccess || {}, date = selectedDailyDate || stats.date || today;
    const historical = date !== today;
    daily.hidden = !state.dailySuccess && !selectedDailyStats;
    if (dateButton) dateButton.textContent = historical ? date.slice(5).replace('-', '/') : '今日';
    if (dateInput) { dateInput.value = date; dateInput.max = today; }
    const statsNode = daily.querySelector('#daily-stats');
    const statsHtml = ['checkin', 'post', 'original', 'comment'].map(kind => '<span class="strip-item">' + kindName(kind) + '<b data-daily-kind="' + kind + '">' + Number(stats[kind] || 0) + '</b></span>').join('');
    if (statsNode) statsNode.innerHTML = statsHtml; else daily.innerHTML = statsHtml;
    const pending = state.pendingRoundReports || [];
    if (current && !pending.some(item => reportKey(item) === reportKey(current))) { current = null; dialog.close(); }
    if (current || confirming || !pending.length) return;
    current = pending[0];
    dialog.innerHTML = `<div class="dialog-head"><h2 id="round-complete-title">第 ${current.round + 1} 轮已完成</h2><button class="text-button" data-confirm-round type="button" aria-label="关闭完成提醒">关闭</button></div><p>耗时 ${duration(current.durationMs)} · ${current.accountCount} 个账号 / ${current.topicCount} 个超话</p>${countTable(current.counts)}${anomalies(current.abnormalAccounts)}<div class="report-dialog-actions"><button class="quiet" data-view-round type="button">查看详细记录</button><button class="primary" data-confirm-round type="button">知道了</button></div>`;
    dialog.showModal();
  }
  return { render };
}
