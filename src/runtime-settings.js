import { getSetting, setSetting } from './db.js';

// Long-lived task browsers are convenient (the same account/topic can keep
// posting without re-launching Chrome) but they also accumulate renderer
// memory.  On an 8 GB machine a full Chrome tree can crowd out the Node
// process and make page navigation look like a Weibo outage.  Recycle the
// reusable runner sessions after a bounded number of operations or minutes.
export const DEFAULT_BROWSER_RECYCLE = Object.freeze({ enabled: true, maxActions: 20, maxMinutes: 10 });

function clampInteger(value, fallback, min, max) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.min(max, Math.max(min, Math.round(number))) : fallback;
}

export function normalizeBrowserRecycle(value = {}) {
  const input = value && typeof value === 'object' ? value : {};
  return {
    enabled: input.enabled !== false,
    maxActions: clampInteger(input.maxActions, DEFAULT_BROWSER_RECYCLE.maxActions, 5, 100),
    maxMinutes: clampInteger(input.maxMinutes, DEFAULT_BROWSER_RECYCLE.maxMinutes, 3, 120)
  };
}

export function getBrowserRecycle() {
  return normalizeBrowserRecycle(getSetting('browser_recycle_v1', DEFAULT_BROWSER_RECYCLE));
}

export function setBrowserRecycle(value) {
  const normalized = normalizeBrowserRecycle(value);
  setSetting('browser_recycle_v1', normalized);
  return normalized;
}
