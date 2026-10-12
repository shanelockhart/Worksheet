// Reads and validates configuration from environment variables. Nothing here is ever sent to the browser.

function int(env, name, def, { min = 0, max = 1_000_000 } = {}) {
  const raw = env[name];
  if (raw === undefined || raw === '') return def;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < min || n > max) throw new Error(`${name} must be an integer between ${min} and ${max}`);
  return n;
}
function bool(env, name, def) {
  const raw = env[name];
  if (raw === undefined || raw === '') return def;
  return /^(1|true|yes|on)$/i.test(String(raw).trim());
}

export function loadConfig(env) {
  const provider = (env.AI_PROVIDER || 'anthropic').toLowerCase();
  if (!['anthropic', 'openai'].includes(provider)) throw new Error('AI_PROVIDER must be "anthropic" or "openai"');
  const cfg = {
    provider,
    model: env.AI_MODEL || (provider === 'anthropic' ? 'claude-haiku-5-5' : ''),
    apiKey: env.AI_API_KEY || '',
    baseUrl: (env.AI_BASE_URL || (provider === 'anthropic' ? 'https://api.anthropic.com' : 'https://api.openai.com/v1')).replace(/\/+$/, ''),
    maxOutputTokens: int(env, 'AI_MAX_OUTPUT_TOKENS', 700, { min: 50, max: 4000 }),
    timeoutMs: int(env, 'AI_TIMEOUT_MS', 25000, { min: 1000, max: 50000 }),
    effort: env.AI_EFFORT || '',
    supabaseUrl: (env.SUPABASE_URL || '').replace(/\/+$/, ''),
    supabaseKey: env.SUPABASE_SERVICE_ROLE_KEY || '',
    sessionSecret: env.SESSION_SECRET || '',
    limit: int(env, 'LIMIT_PER_WINDOW', 5, { min: 1, max: 1000 }),
    windowSeconds: int(env, 'LIMIT_WINDOW_MINUTES', 60, { min: 1, max: 1440 }) * 60,
    ipLimit: int(env, 'IP_LIMIT_PER_WINDOW', 20, { min: 1, max: 10000 }),
    newSessionsPerIp: int(env, 'NEW_SESSIONS_PER_IP', 10, { min: 1, max: 10000 }),
    dailyCap: int(env, 'DAILY_CAP', 500, { min: 0, max: 10_000_000 }),
    maxInputChars: int(env, 'MAX_INPUT_CHARS', 600, { min: 20, max: 4000 }),
    maxHistoryMessages: int(env, 'MAX_HISTORY_MESSAGES', 6, { min: 0, max: 40 }),
    maxHistoryChars: int(env, 'MAX_HISTORY_CHARS', 3000, { min: 0, max: 40000 }),
    allowedOrigins: (env.ALLOWED_ORIGINS || '').split(',').map((s) => s.trim()).filter(Boolean),
    authEnabled: bool(env, 'AUTH_ENABLED', false),
    includeArchive: bool(env, 'KNOWLEDGE_INCLUDE_ARCHIVE', true),
  };
  // Window must be a multiple of nothing in particular, but the IP limit may not be lower than the per-user limit.
  if (cfg.ipLimit < cfg.limit) cfg.ipLimit = cfg.limit;
  return cfg;
}

// Names of anything that is missing. Reported to the log and as a generic "not configured" error, never with values.
export function missingConfig(cfg) {
  const m = [];
  if (!cfg.apiKey) m.push('AI_API_KEY');
  if (!cfg.model) m.push('AI_MODEL');
  if (!cfg.supabaseUrl) m.push('SUPABASE_URL');
  if (!cfg.supabaseKey) m.push('SUPABASE_SERVICE_ROLE_KEY');
  if (cfg.sessionSecret.length < 32) m.push('SESSION_SECRET (32+ chars)');
  return m;
}
