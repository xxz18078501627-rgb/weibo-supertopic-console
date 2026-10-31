const esc = (value = '') => String(value).replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
const kind = value => ({ checkin: '签到', post: '发帖', comment: '评论' })[value] || value;
const labels = { pending: '需要验证', requested: '等待打开', validating: '正在验证', ready: '已验证，待补做', retrying: '正在补做', resolved: '已处理' };

export function createVerificationUI({ getState, request, refresh, toast }) {
  const panel = document.createElement('article'); panel.id = 'verification-panel'; panel.className = 'panel verification-panel';
  document.querySelector('#run-card').after(panel);
  let sending = false;
  panel.addEventListener('click', async event => {
    const button = event.target.closest('button'); if (!button || sending) return;
    const state = getState(), verification = state.verification; if (!verification) return;
    let action, body = {};
    if (button.dataset.verifyToggle != null) { const id = button.dataset.verifyToggle; if (openRows.has(id)) openRows.delete(id); else openRows.add(id); render(); return; }
    if (button.dataset.verifyIdentity) { action = 'open'; body.identity = button.dataset.verifyIdentity; }
    if (button.dataset.verificationEnd != null) action = 'end';
    if (button.dataset.verificationContinue != null) action = 'continue';
    if (button.dataset.verificationRecheck != null) action = 'recheck';
    if (button.dataset.confirmUnpublished) {
      if (!confirm('请确认你已经在微博核对：该操作确实没有发布成功。确认后将允许按原文案补发。')) return;
      action = 'confirm-unpublished'; body = { stepKey: button.dataset.confirmUnpublished, confirmed: true };
    }
    if (!action) return;
    sending = true; button.disabled = true;
    try { await request(`/api/jobs/${verification.jobId}/verification/${action}`, { method: 'POST', body }); await refresh(); }
    catch (error) { toast(error.message); }
    finally { sending = false; render(); }
  });

  let openRows = new Set();
  function render() {
    const state = getState(), verification = state?.verification;
    if (!verification) {
      panel.innerHTML = '<header class="verify-head"><h2>待验证账号</h2><span class="verify-count">0/0</span></header><div class="verify-rows"><div class="verify-empty"><i class="light ok"></i>无待验证账号，任务可正常推进</div></div>';
      return;
    }
    const closed = ['stopped', 'completed'].includes(verification.jobStatus);
    const blocked = state.dailyStop?.blocked || closed;
    const busy = Boolean(verification.session);
    const scroller = panel.querySelector('.verify-rows');
    const previousScroll = scroller ? scroller.scrollTop : 0;
    // 分子分母必须用同一个集合：已完成的卡 visible=false 会被隐藏，若分母
    // 只算可见卡，比例永远是 0/剩余数，看起来像「0 个完成」。
    const allCards = verification.cards;
    const cards = allCards.filter(card => card.visible !== false);
    const isDone = card => card.status === 'resolved' || (card.checkinResult === 'succeeded' && card.remainingStepCount === 0);
    const tierOf = card => {
      if (isDone(card)) return 2;
      const pendingCheckin = card.steps.some(step => step.kind === 'checkin' && ['deferred', 'review', 'running', 'pending'].includes(step.state));
      if (pendingCheckin || ['pending', 'validating', 'requested'].includes(card.status)) return 0;
      return 1;
    };
    cards.sort((a, b) => tierOf(a) - tierOf(b) || String(a.name || '').localeCompare(String(b.name || ''), 'zh-CN'));
    // 「已完成」按验证是否通过算（ready = 验证码已过、签到待补做），
    // 与任务卡的 60/144 不是一回事。
    const verified = card => card.verificationResult === 'passed' || card.checkinResult === 'succeeded' || card.status === 'resolved';
    const completed = allCards.filter(verified).length;
    const totalCards = allCards.length;
    const pendingCheckins = cards.reduce((n, card) => n + card.steps.filter(step => step.kind === 'checkin' && ['deferred', 'review', 'running', 'pending'].includes(step.state)).length, 0);
    const session = verification.session;
    const sessionText = session ? (session.phase === 'requested' ? '等待打开验证窗口…' : session.phase === 'signing_checkin' || session.phase === 'submitting_checkin' ? '正在当前窗口补做签到…' : session.phase === 'challenge' ? '正在当前窗口手动验证…' : session.phase === 'awaiting_post_receipt' ? '正在确认发帖回执…' : '正在打开账号…') : '';
    let html = '<header class="verify-head"><h2>待验证账号</h2><span class="verify-count" title="已验证 ' + completed + ' / 本轮共 ' + totalCards + ' 个待验证账号">' + completed + '/' + totalCards + '</span>' + (pendingCheckins ? '<span class="verify-hint" title="待补做 ' + pendingCheckins + ' 项">待补做 ' + pendingCheckins + '</span>' : '');
    if (sessionText) html += '<span class="verify-session" role="status">' + sessionText + '</span>';
    html += '<div class="verify-actions">';
    if (session) html += '<button class="quiet" data-verification-end type="button">结束验证</button>';
    if (session && session.phase === 'challenge') html += '<button class="quiet" data-verification-recheck type="button">重新检测</button>';
    html += '<button class="primary" data-verification-continue type="button"' + (!verification.canContinue || blocked || sending ? ' disabled' : '') + '>继续运行</button></div></header>';
    html += '<div class="verify-rows">';
    if (!cards.length) html += '<div class="verify-empty"><i class="light ok"></i>' + (closed ? '本轮已完成，无待验证账号' : '无待验证账号') + '</div>';
    for (const card of cards) {
      const reviews = card.steps.filter(step => step.needsReview);
      const pending = card.steps.filter(step => step.kind === 'checkin' && ['deferred', 'review', 'running', 'pending'].includes(step.state)).length;
      const open = openRows.has(card.identity);
      const tone = card.status === 'resolved' ? 'ok' : pending ? 'warn' : card.status === 'validating' ? 'blue' : 'warn';
      const hint = pending ? '签到待补做（剩 ' + pending + ' 项）' : (card.reason || labels[card.status] || '');
      html += '<article class="verify-row' + (open ? ' open' : '') + '" data-identity="' + esc(card.identity) + '">';
      html += '<i class="light ' + tone + '"></i><b>' + esc(card.name) + '</b><span class="uid">UID ' + esc(card.uid || '—') + '</span>';
      html += '<span class="why" title="' + esc(card.reason || '') + '">' + esc(hint) + '</span>';
      html += '<button class="text-button" data-verify-toggle="' + esc(card.identity) + '" type="button">' + (open ? '收起' : '详情') + '</button>';
      html += '<button class="quiet" data-verify-identity="' + esc(card.identity) + '" type="button"' + (blocked || busy || card.status === 'resolved' || sending ? ' disabled' : '') + '>' + (card.status === 'ready' ? '再验证' : card.status === 'resolved' ? '已处理' : '验证') + '</button>';
      if (open) {
        html += '<div class="verify-detail"><p>待补做 ' + card.remainingStepCount + ' 项 · 待核对 ' + reviews.length + ' 项</p>';
        if (card.reason) html += '<p class="muted">' + esc(card.reason) + '</p>';
        for (const step of reviews) html += '<div class="verification-review"><span>' + esc(step.topicName) + ' · ' + kind(step.kind) + '</span><button class="text-button" data-confirm-unpublished="' + esc(step.key) + '"' + (blocked || busy ? ' disabled' : '') + ' type="button">确认未发布</button></div>';
        html += '</div>';
      }
      html += '</article>';
    }
    html += '</div>';
    panel.innerHTML = html;
    const nextScroller = panel.querySelector('.verify-rows');
    if (nextScroller && previousScroll) nextScroller.scrollTop = previousScroll;
  }
  return { render };
}
