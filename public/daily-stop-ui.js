export function renderDailyStop(state) {
  let rule = document.querySelector('#daily-stop-rule');
  if (!rule) {
    rule = document.createElement('p'); rule.id = 'daily-stop-rule'; rule.className = 'daily-stop-rule';
    rule.setAttribute('role', 'status');
    document.querySelector('#task-summary').before(rule);
  }
  const policy = state?.dailyStop;
  rule.hidden = !policy;
  rule.textContent = policy?.blocked ? '已到每日截止时间，00:00后可开始新任务。' : '每日23:59自动停止（北京时间）';
  rule.classList.toggle('cutoff-active', policy?.blocked === true);
  document.querySelector('#start-task').disabled = policy?.blocked === true;
  for (const button of document.querySelectorAll('[data-job-action="resume"]')) button.disabled = policy?.blocked === true;
}
