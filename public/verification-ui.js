const esc = (value = '') => String(value).replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
const kind = value => ({ checkin: '签到', post: '发帖', original: '原创', comment: '评论', repost: '转发', like: '外赞', comment_like: '内赞' })[value] || value;
const labels = { pending: '需要验证', requested: '等待打开', validating: '正在验证', ready: '已验证，待补做', retrying: '正在补做', resolved: '已处理' };

export function createVerificationUI({ getState, request, refresh, toast, panelId = 'verification-panel', anchor = '#run-card', verificationKey = 'verification' }) {
  const panel = document.getElementById(panelId) || document.createElement('article'); panel.id = panelId; panel.className = 'panel verification-panel';
  if (!panel.isConnected) document.querySelector(anchor).after(panel);
  let sending = false;
  let opening = null;
  panel.addEventListener('click', async event => {
    const button = event.target.closest('button'); if (!button || sending) return;
    const state = getState(), verification = state[verificationKey]; if (!verification) return;
    let action, body = {};
    if (button.dataset.verifyToggle != null) { const id = button.dataset.verifyToggle; if (openRows.has(id)) openRows.delete(id); else openRows.add(id); render(); return; }
    if (button.dataset.verifyIdentity) { action = 'open'; opening = button.dataset.verifyIdentity; body.identity = button.dataset.verifyIdentity; if (button.dataset.verifyStep) body.stepKey = button.dataset.verifyStep; }
    if (button.dataset.verificationEnd != null) action = 'end';
    if (button.dataset.verificationContinue != null) action = 'continue';
    if (button.dataset.verificationRecheck != null) action = 'recheck';
    if (button.dataset.confirmUnpublished) {
      if (!confirm('请确认已经在微博核对：该操作确实未成功。确认后才允许补做；点赞会先读取状态，不会重复点击已赞。')) return;
      action = 'confirm-unpublished'; body = { stepKey: button.dataset.confirmUnpublished, confirmed: true };
    }
    if (!action) return;
    sending = true; button.disabled = true; if (opening) render();
    try { await request(`/api/jobs/${verification.jobId}/verification/${action}`, { method: 'POST', body }); await refresh(); }
    catch (error) { toast(error.message || '验证窗口没有成功打开，请重试'); await refresh().catch(() => {}); }
    finally { sending = false; opening = null; render(); }
  });

  let openRows = new Set();
  function render() {
    const state = getState(), verification = state?.[verificationKey];
    if (!verification) {
      panel.innerHTML = '<header class="verify-head"><h2>待验证账号</h2><span class="verify-count">0/0</span>' + (verificationKey === 'engageVerification' ? '<div class="verify-actions"><button class="primary" data-verification-continue type="button" disabled title="暂无可继续的任务">继续运行</button></div>' : '') + '</header><div class="verify-rows"><div class="verify-empty"><i class="light ok"></i>无待验证账号，任务可正常推进</div></div>';
      return;
    }
    const closed = ['stopped', 'completed'].includes(verification.jobStatus);
    const offline = verificationKey === 'engageVerification' && state.engageNetwork?.state === 'offline';
    const blocked = state.dailyStop?.blocked || closed || offline;
    const pendingCards = verification.cards.some(card => card.visible !== false && (card.status === 'pending' || card.verificationResult !== 'passed'));
    const continueReason = closed ? '任务已结束' : state.dailyStop?.blocked ? '已到每日截止时间' : offline ? '网络断开，等待恢复' : verification.session ? '请先结束当前验证会话' : !verification.canContinue ? '请等待当前浏览器操作结束' : pendingCards ? '先执行已验证账号和未受阻操作，其余账号继续等待验证' : '';
    const busy = Boolean(verification.session || opening);
    const scroller = panel.querySelector('.verify-rows');
    const previousScroll = scroller ? scroller.scrollTop : 0;
    // 分子分母必须用同一个集合：已完成的卡 visible=false 会被隐藏，若分母
    // 只算可见卡，比例永远是 0/剩余数，看起来像「0 个完成」。
    const allCards = verification.cards;
    const cards = allCards.filter(card => card.visible !== false);
    const engageMode = verificationKey === 'engageVerification';
    const isDone = card => card.status === 'resolved' || (card.checkinResult === 'succeeded' && card.remainingStepCount === 0);
    const tierOf = card => {
      if (engageMode) return card.verificationResult === 'passed' || isDone(card) ? 2 : 0;
      if (isDone(card)) return 2;
      const pendingCheckin = card.steps.some(step => step.kind === 'checkin' && ['deferred', 'review', 'running', 'pending'].includes(step.state));
      if (pendingCheckin || ['pending', 'validating', 'requested'].includes(card.status)) return 0;
      return 1;
    };
    cards.sort((a, b) => {
      const tier = tierOf(a) - tierOf(b); if (tier) return tier;
      if (engageMode) {
        const at = Date.parse(a.verificationResult === 'passed' ? a.verifiedAt || a.triggeredAt : a.triggeredAt) || 0;
        const bt = Date.parse(b.verificationResult === 'passed' ? b.verifiedAt || b.triggeredAt : b.triggeredAt) || 0;
        if (at !== bt) return at - bt;
      }
      return String(a.name || '').localeCompare(String(b.name || ''), 'zh-CN');
    });
    // 「已完成」按验证是否通过算（ready = 验证码已过、签到待补做），
    // 与任务卡的 60/144 不是一回事。
    const verified = card => card.status === 'resolved' || (verificationKey === 'engageVerification'
      ? card.verificationResult === 'passed' || card.checkinResult === 'succeeded'
      : card.verificationResult === 'passed' && !['pending', 'requested', 'validating'].includes(card.status));
    const completed = allCards.filter(verified).length;
    const totalCards = allCards.length;
    const pendingCheckins = cards.reduce((n, card) => n + card.steps.filter(step => step.kind === 'checkin' && ['deferred', 'review', 'running', 'pending'].includes(step.state)).length, 0);
    const session = verification.session;
    const sessionAttemptLimit = session?.kind === 'checkin' ? 2 : 1;
    const sessionText = opening ? '正在打开验证窗口…' : session ? (session.phase === 'opening' || session.phase === 'requested' ? '正在打开验证窗口…' : session.phase === 'checking_previous_result' ? '正在核对上次操作结果…' : session.phase === 'retryable' ? '当前动作未触发，准备第 ' + Math.min(Number(session.attempt || 0) + 1, sessionAttemptLimit) + '/' + sessionAttemptLimit + ' 次重试…' : String(session.phase || '').startsWith('triggering_') ? '正在触发当前操作，第 ' + Math.min(Number(session.attempt || 1), sessionAttemptLimit) + '/' + sessionAttemptLimit + ' 次…' : session.phase === 'waiting_challenge' || session.phase === 'challenge' ? '正在当前窗口手动验证…' : session.phase === 'action_triggered' ? '当前动作已触发，正在确认结果…' : session.phase === 'signing_checkin' || session.phase === 'submitting_checkin' ? '正在当前窗口补做签到…' : session.phase === 'awaiting_post_receipt' ? '正在等待本次发帖成功提示…' : session.phase === 'awaiting_comment_receipt' ? '正在等待本次评论成功提示…' : session.phase === 'submitting_post' ? '正在当前窗口发帖…' : session.phase === 'submitting_comment' ? '正在当前窗口评论…' : session.phase === 'submitting_repost' ? '正在当前窗口转发…' : session.phase === 'submitting_like' || session.phase === 'submitting_comment_like' ? '正在当前窗口点赞…' : session.phase === 'awaiting_repost_receipt' ? '正在只读核对转发回执…' : session.phase === 'awaiting_like_receipt' || session.phase === 'awaiting_comment_like_receipt' ? '正在只读核对已赞状态…' : session.phase === 'opened' || String(session.phase || '').startsWith('processing_') ? '验证窗口已打开，正在处理当前操作…' : '正在打开账号…') : '';
    let html = '<header class="verify-head"><h2>待验证账号</h2><span class="verify-count" title="已验证 ' + completed + ' / 本轮共 ' + totalCards + ' 个待验证账号">' + completed + '/' + totalCards + '</span>' + (pendingCheckins ? '<span class="verify-hint" title="待补做 ' + pendingCheckins + ' 项">待补做 ' + pendingCheckins + '</span>' : '');
    if (sessionText) html += '<span class="verify-session" role="status">' + sessionText + '</span>';
    html += '<div class="verify-actions">';
    if (session) html += '<button class="quiet" data-verification-end type="button">结束验证</button>';
    if (session && session.phase === 'challenge') html += '<button class="quiet" data-verification-recheck type="button">重新检测</button>';
    html += '<button class="primary" data-verification-continue type="button" title="' + esc(continueReason) + '"' + (!verification.canContinue || blocked || busy || sending ? ' disabled' : '') + '>继续运行</button>' + '</div></header>';
    html += '<div class="verify-rows">';
    if (!cards.length) html += '<div class="verify-empty"><i class="light ok"></i>' + (closed ? '本轮已完成，无待验证账号' : '无待验证账号') + '</div>';
    for (const card of cards) {
      const reviews = card.steps.filter(step => step.needsReview);
      const pending = card.steps.filter(step => step.kind === 'checkin' && ['deferred', 'review', 'running', 'pending'].includes(step.state)).length;
      const open = openRows.has(card.identity);
      const tone = card.status === 'resolved' ? 'ok' : pending ? 'warn' : card.status === 'validating' ? 'blue' : 'warn';
      const mainlineWait = engageMode && card.verificationResult !== 'passed' && card.canOpen === false;
      const hint = mainlineWait ? '当前操作结束后可打开验证' : card.currentKind ? '当前：' + kind(card.currentKind) + ' · ' + (card.reason || labels[card.status] || '') : (card.reason || labels[card.status] || '');
      html += '<article class="verify-row' + (open ? ' open' : '') + '" data-identity="' + esc(card.identity) + '">';
      html += '<i class="light ' + tone + '"></i><b>' + esc(card.name) + '</b><span class="uid">UID ' + esc(card.uid || '—') + '</span>';
      html += '<span class="why" title="' + esc(card.reason || '') + '">' + esc(hint) + '</span>';
      html += '<button class="text-button" data-verify-toggle="' + esc(card.identity) + '" type="button">' + (open ? '收起' : '详情') + '</button>';
      const handled = card.status === 'resolved' || (card.status === 'ready' && card.verificationResult === 'passed' && !card.currentActionable);
      const cardOpening = opening === card.identity;
      const retryLabel = card.source === 'manual_unconfirmed' ? '再次验证' : '验证';
      const canOpen = !engageMode || card.canOpen !== false;
      const openTitle = !canOpen ? 'title="当前操作结束后可打开验证"' : engageMode ? 'title="打开验证时会先安全暂停主线任务"' : '';
      html += '<button class="quiet" data-verify-identity="' + esc(card.identity) + '" data-verify-step="' + esc(card.currentStepKey || '') + '" type="button" ' + openTitle + (blocked || busy || handled || sending || !canOpen ? ' disabled' : '') + '>' + (cardOpening ? '正在打开…' : handled ? '已验证' : (card.verificationResult === 'passed' || (verificationKey !== 'engageVerification' && card.checkinResult === 'succeeded')) && card.currentKind ? '处理当前' + kind(card.currentKind) : retryLabel) + '</button>';
      if (open) {
        const needsValidation = step => card.verificationResult !== 'passed' && (step.verificationPending ?? card.source !== 'checkin_unconfirmed');
        const validating = reviews.filter(needsValidation).length;
        const reviewing = reviews.length - validating;
        html += '<div class="verify-detail"><p>待补做 ' + card.remainingStepCount + ' 项 · ' + (validating ? '待验证 ' + validating + ' 项' : '待核对 ' + reviewing + ' 项') + (validating && reviewing ? ' · 待核对 ' + reviewing + ' 项' : '') + '</p>';
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
