// Shared by the browser and server so defaults cannot drift between them.
export const DEFAULT_EMOJIS = [
  '😀', '😃', '😄', '😁', '😊', '🙂', '😉', '😎',
  '🤗', '🤩', '🥳', '😌', '😍', '🥰', '🤔', '🤝',
  '👍', '👏', '🙌', '💪', '✨', '🌟', '🎉', '❤️'
];
export const LEGACY_EMOJIS = ['🙂', '👏', '✨', '🌟'];
export const DEFAULT_ACTION_INTERVALS = { checkin: 5, post: 10, comment: 3 };

export function normalizeActionPlan(plan, settings = {}) {
  return plan.map(item => {
    const fallback = DEFAULT_ACTION_INTERVALS[item.type] ?? 0;
    const raw = item.intervalSeconds ?? settings[`${item.type}IntervalSeconds`] ?? fallback;
    const seconds = Number(raw);
    return { ...item, intervalSeconds: Number.isFinite(seconds) ? Math.max(0, Math.min(3600, Math.trunc(seconds))) : fallback };
  });
}

export function normalizeDecoration(value = {}) {
  const emojis = Array.isArray(value.emojis) ? value.emojis : DEFAULT_EMOJIS;
  const isLegacyDefault = JSON.stringify(emojis) === JSON.stringify(LEGACY_EMOJIS);
  return {
    mode: ['none', 'emoji', 'number', 'emoji-and-number'].includes(value.mode) ? value.mode : 'none',
    emojis: [...new Set((isLegacyDefault ? DEFAULT_EMOJIS : emojis).map(String).map(s => s.trim()).filter(Boolean))],
    emojiPosition: value.emojiPosition === 'prefix' ? 'prefix' : 'suffix',
    numberPosition: value.numberPosition === 'prefix' ? 'prefix' : 'suffix'
  };
}

export function normalizeTaskSettings(value = {}) {
  const { actionIntervalSeconds, checkinIntervalSeconds, postIntervalSeconds, commentIntervalSeconds, ...settings } = value;
  const refresh = Number(value.candidateRefreshSeconds);
  return {
    ...settings,
    ...(Array.isArray(value.actionPlan) ? { actionPlan: normalizeActionPlan(value.actionPlan, value) } : {}),
    syncToHome: value.syncToHome === true,
    commentSection: String(value.commentSection ?? '').trim() || '超like',
    scanLimit: Math.max(1, Math.min(500, Number(value.scanLimit) || 30)),
    candidateRefreshSeconds: !Number.isFinite(refresh) ? 3 : refresh === 0 ? 0 : Math.max(3, Math.min(3600, Math.trunc(refresh))),
    commentMaxCountEnabled: value.commentMaxCountEnabled === true,
    commentMaxCount: 20,
    postDecoration: normalizeDecoration(value.postDecoration),
    commentDecoration: normalizeDecoration(value.commentDecoration || value.decoration)
  };
}
