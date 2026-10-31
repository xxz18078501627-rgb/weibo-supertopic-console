const esc = (value = '') => String(value).replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));

export function createGroupUI({ getState, getConfig, getSelected, request, refresh, updateSummary, toast }) {
  const dialog = document.createElement('dialog');
  dialog.id = 'group-manager-dialog';
  dialog.className = 'group-manager-dialog';
  dialog.innerHTML = '<div class="dialog-head"><h2>分组管理</h2><button type="button" class="text-button" data-close-group-manager>关闭</button></div><div id="group-management-list" class="group-management-list"></div><form id="create-group-form" class="group-create"><input id="new-group-name" maxlength="40" required placeholder="新分组名称"><button class="quiet" type="submit">创建</button></form><div class="group-move"><select id="move-group-target" aria-label="移动所选账号到分组"></select><button class="quiet" id="move-selected-group" type="button">移动所选</button></div>';
  document.body.append(dialog);

  const accountGroups = () => getState()?.accountGroups || [];
  const managementGroups = () => [{ id: '', name: '未分组' }, ...accountGroups().filter(group => group.id)];
  const members = (groupId, task) => (getState()?.accounts || []).filter(account => (account.group_id || '') === groupId && (!task || account.enabled));
  const selected = task => task ? new Set(getConfig().accountIds || []) : getSelected();

  function setPartialInputs(root) {
    for (const input of root.querySelectorAll('[data-select-group]')) {
      const task = input.dataset.selectGroup === 'task', list = members(input.dataset.groupId, task), chosen = selected(task);
      const count = list.filter(account => chosen.has(account.id)).length;
      input.checked = list.length > 0 && count === list.length;
      input.indeterminate = count > 0 && count < list.length;
      input.disabled = !list.length;
    }
  }

  function renderTask() {
    if (!getState()) return;
    const list = document.querySelector('#task-account-list');
    if (!list) return;
    const opened = new Set([...list.querySelectorAll('details[open]')].map(node => node.dataset.groupId));
    const focusedAccount = document.activeElement?.dataset?.taskAccount || '';
    const chosen = selected(true);
    list.innerHTML = accountGroups().map(group => {
      const accounts = members(group.id, true); if (!accounts.length) return '';
      const count = accounts.filter(account => chosen.has(account.id)).length;
      return `<details class="account-group-card" data-group-id="${esc(group.id)}" ${opened.has(group.id) ? 'open' : ''}><summary><label class="check-inline"><input type="checkbox" data-select-group="task" data-group-id="${esc(group.id)}" aria-label="选择整组 ${esc(group.name)}"><b>${esc(group.name)}</b></label><small>已选 ${count} / ${accounts.length}</small></summary><div class="choice-list">${accounts.map(account => `<label class="choice"><input type="checkbox" data-task-account="${account.id}" ${chosen.has(account.id) ? 'checked' : ''}><span>${esc(account.nickname || account.name)}</span><small>${account.auth_status === 'valid' ? '已登录' : '需重新登录'}</small></label>`).join('')}</div></details>`;
    }).join('') || '<div class="empty">先到“账号”添加并启用账号。</div>';
    const note = document.querySelector('#selection-note');
    if (note) note.textContent = `已选 ${chosen.size} 个账号`;
    if (list.querySelector('details') && !list.querySelector('details[open]')) list.querySelector('details').open = true;
    setPartialInputs(list);
    if (focusedAccount) list.querySelector('[data-task-account="' + focusedAccount + '"]')?.focus({ preventScroll: true });
  }

  function renderAccounts() {
    if (!getState()) return;
    const groupList = managementGroups();
    const moveTarget = dialog.querySelector('#move-group-target');
    const currentTarget = moveTarget.value;
    moveTarget.innerHTML = groupList.map(group => `<option value="${esc(group.id)}">${esc(group.name)}</option>`).join('');
    if (groupList.some(group => group.id === currentTarget)) moveTarget.value = currentTarget;
    const chosen = selected(false);
    dialog.querySelector('#group-management-list').innerHTML = groupList.map(group => {
      const accounts = members(group.id, false);
      const count = accounts.filter(account => chosen.has(account.id)).length;
      return `<div class="group-management-row"><b>${esc(group.name)}</b><span>${count ? count + '/' + accounts.length : accounts.length} 个账号</span>${group.id ? `<button class="text-button" data-rename-group="${esc(group.id)}" type="button">改名</button><button class="text-button" data-delete-group="${esc(group.id)}" type="button">删除</button>` : ''}</div>`;
    }).join('');
    setPartialInputs(dialog);
  }

  function open() {
    renderAccounts();
    if (!dialog.open) dialog.showModal();
  }

  dialog.addEventListener('click', event => {
    if (event.target.closest('[data-close-group-manager]')) dialog.close();
  });
  dialog.querySelector('form').addEventListener('submit', async event => {
    event.preventDefault();
    try {
      await request('/api/account-groups', { method: 'POST', body: { name: dialog.querySelector('#new-group-name').value } });
      event.target.reset(); await refresh(); toast('分组已创建');
    } catch (error) { toast(error.message); }
  });

  document.addEventListener('change', event => {
    const input = event.target;
    if (input.dataset.selectGroup) {
      const task = input.dataset.selectGroup === 'task', chosen = selected(task);
      for (const account of members(input.dataset.groupId, task)) input.checked ? chosen.add(account.id) : chosen.delete(account.id);
      if (task) getConfig().accountIds = getState().accounts.filter(account => chosen.has(account.id) && account.enabled).map(account => account.id);
      renderTask();
      for (const checkbox of document.querySelectorAll('[data-select-account]')) checkbox.checked = getSelected().has(checkbox.dataset.selectAccount);
      document.querySelector('#selected-account-count').textContent = `已选 ${getSelected().size} 个`;
      setPartialInputs(document.querySelector('#account-list'));
      setPartialInputs(dialog);
      updateSummary();
    } else if (input.dataset.taskAccount) renderTask();
  });

  dialog.addEventListener('click', async event => {
    const button = event.target.closest('button'); if (!button) return;
    try {
      if (button.dataset.renameGroup) {
        const group = accountGroups().find(item => item.id === button.dataset.renameGroup);
        const name = prompt('新的分组名称', group.name); if (!name?.trim()) return;
        await request(`/api/account-groups/${group.id}`, { method: 'PATCH', body: { name } }); await refresh();
      }
      if (button.dataset.deleteGroup) {
        const group = accountGroups().find(item => item.id === button.dataset.deleteGroup);
        if (!confirm(`删除分组“${group.name}”？组内账号将移到“未分组”。`)) return;
        await request(`/api/account-groups/${group.id}`, { method: 'DELETE' }); await refresh();
      }
      if (button.id === 'move-selected-group') {
        if (!getSelected().size) throw new Error('请先选择要移动的账号');
        const result = await request('/api/accounts/group', { method: 'POST', body: { ids: [...getSelected()], groupId: dialog.querySelector('#move-group-target').value } });
        const failed = result.results.filter(item => !item.ok);
        await refresh(); toast(failed.length ? `${failed.length} 个账号移动失败` : '账号已移动');
      }
    } catch (error) { toast(error.message); }
  });

  return { renderTask, renderAccounts, open };
}
