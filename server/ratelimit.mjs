import { rpc } from './store.mjs';

// subjects: [primary (g:<session> or u:<user>), ip:<hash>]; limits are matched by index.
export function plan(cfg, primary, ipHash) {
  return {
    subjects: [primary, `ip:${ipHash}`],
    limits: [cfg.limit, cfg.ipLimit],
  };
}

const args = (cfg, p) => ({
  p_subjects: p.subjects,
  p_limits: p.limits,
  p_window_seconds: cfg.windowSeconds,
  p_daily_cap: cfg.dailyCap,
});

// What the browser is told. Combines buckets: the smallest remaining wins; when nothing is left,
// the time shown is when the LAST blocking bucket frees a slot (so "available at" is truthful).
export function summarize(cfg, state, extra = {}) {
  const buckets = state?.buckets || [];
  const primary = buckets[0];
  let remaining = primary ? primary.remaining : 0;
  let nextAt = null;
  for (const b of buckets) remaining = Math.min(remaining, b.remaining);
  const blocking = buckets.filter((b) => b.remaining === 0 && b.next_at);
  if (blocking.length) nextAt = blocking.map((b) => b.next_at).sort().at(-1);
  const daily = state?.daily;
  const dailyReached = !!daily?.reached;
  if (dailyReached) { remaining = 0; nextAt = daily.reset_at; }
  return {
    limit: cfg.limit,
    window_minutes: Math.round(cfg.windowSeconds / 60),
    used: primary ? primary.used : 0,
    remaining: Math.max(Math.min(remaining, cfg.limit), 0),
    next_at: remaining === 0 ? nextAt : null,
    daily_cap_reached: dailyReached,
    ...extra,
  };
}

export const status = (cfg, p) => rpc(cfg, 'fx_status', args(cfg, p));
export const reserve = (cfg, reservation, p) => rpc(cfg, 'fx_reserve', { p_reservation: reservation, ...args(cfg, p) });
export const release = (cfg, reservation) => rpc(cfg, 'fx_release', { p_reservation: reservation });
export const commit = (cfg, reservation, tin, tout) =>
  rpc(cfg, 'fx_commit', { p_reservation: reservation, p_tokens_in: tin ?? null, p_tokens_out: tout ?? null });
export const newSession = (cfg, ipHash) =>
  rpc(cfg, 'fx_new_session', { p_subject: `ipn:${ipHash}`, p_limit: cfg.newSessionsPerIp, p_window_seconds: cfg.windowSeconds });
