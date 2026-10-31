import { shanghaiDate } from './util.js';

export const DAILY_STOP_REASON = '每日 23:59 自动停止';
export class DailyStopError extends Error {
  constructor(message = DAILY_STOP_REASON) { super(message); this.code = 'daily_stop'; this.statusCode = 409; }
}

export function deadlineFor(value) {
  return Date.parse(`${shanghaiDate(new Date(value))}T23:59:00+08:00`);
}

export function dailyStopStatus(value = Date.now()) {
  const today = shanghaiDate(new Date(value));
  const deadline = deadlineFor(value);
  const midnight = Date.parse(`${today}T00:00:00+08:00`) + 86400000;
  return { enabled: true, timezone: 'Asia/Shanghai', time: '23:59', serverNow: new Date(value).toISOString(),
    deadlineAt: new Date(deadline).toISOString(), blocked: value >= deadline,
    blockedUntil: value >= deadline ? new Date(midnight).toISOString() : null };
}
