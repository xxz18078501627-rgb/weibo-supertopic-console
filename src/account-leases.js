// Shared in-process resource fence. No browser profile is copied or opened twice.
export class AccountBusyError extends Error {
  constructor(message = '该账号正在另一任务中操作，等待账号空闲') { super(message); this.code = 'account_busy'; this.statusCode = 409; }
}
export class AccountLeases {
  constructor() { this.owners = new Map(); }
  acquire(account, owner) {
    const key = String(account?.uid || account?.profile_dir || account?.id || '');
    const current = this.owners.get(key);
    if (current && current.owner !== owner) throw new AccountBusyError();
    const token = current || { owner, count: 0 }; token.count++;
    this.owners.set(key, token);
    let released = false;
    return () => { if (released) return; released = true; if (--token.count === 0 && this.owners.get(key) === token) this.owners.delete(key); };
  }
}
