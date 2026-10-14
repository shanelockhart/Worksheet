// Provider adapters. One function: complete({cfg, system, messages}) -> {text, tokensIn, tokensOut}.
// Errors are ProviderError with a short code; provider response text is never surfaced to users.

export class ProviderError extends Error {
  constructor(code, detail) { super(detail || code); this.code = code; }
}

const mapStatus = (s) => (s === 429 || s === 529 || s === 503 ? 'busy' : s === 401 || s === 403 ? 'auth' : s === 400 || s === 404 || s === 422 ? 'bad_request' : s >= 500 ? 'server' : 'server');

// One deadline covers the whole exchange: connecting, headers AND reading the body.
// (A provider that sends headers and then stalls must not hold the request, and its reservation, open.)
async function post(url, headers, body, timeoutMs) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    let res;
    try {
      res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body), signal: ctrl.signal });
    } catch (e) {
      throw new ProviderError(e.name === 'AbortError' ? 'timeout' : 'network', e.name);
    }
    if (!res.ok) {
      res.body?.cancel().catch(() => {});
      throw new ProviderError(mapStatus(res.status), `HTTP ${res.status}`);
    }
    let text;
    try {
      text = await res.text();
    } catch (e) {
      throw new ProviderError(ctrl.signal.aborted ? 'timeout' : 'network', 'body read');
    }
    try { return JSON.parse(text); } catch { throw new ProviderError('empty', 'invalid JSON'); }
  } finally {
    clearTimeout(timer);
  }
}

async function anthropic({ cfg, system, messages }) {
  const body = { model: cfg.model, max_tokens: cfg.maxOutputTokens, system, messages };
  if (cfg.effort) body.output_config = { effort: cfg.effort };
  const data = await post(`${cfg.baseUrl}/v1/messages`, { 'x-api-key': cfg.apiKey, 'anthropic-version': '2023-06-01' }, body, cfg.timeoutMs);
  const text = (data?.content || []).filter((b) => b?.type === 'text').map((b) => b.text).join('').trim();
  if (!text) throw new ProviderError('empty', 'no text');
  return { text, tokensIn: data?.usage?.input_tokens ?? null, tokensOut: data?.usage?.output_tokens ?? null, truncated: data?.stop_reason === 'max_tokens' };
}

async function openai({ cfg, system, messages }) {
  const body = { model: cfg.model, max_completion_tokens: cfg.maxOutputTokens, messages: [{ role: 'system', content: system }, ...messages] };
  const data = await post(`${cfg.baseUrl}/chat/completions`, { authorization: `Bearer ${cfg.apiKey}` }, body, cfg.timeoutMs);
  const choice = data?.choices?.[0];
  const text = String(choice?.message?.content || '').trim();
  if (!text) throw new ProviderError('empty', 'no text');
  return { text, tokensIn: data?.usage?.prompt_tokens ?? null, tokensOut: data?.usage?.completion_tokens ?? null, truncated: choice?.finish_reason === 'length' };
}

export const complete = (args) => (args.cfg.provider === 'openai' ? openai(args) : anthropic(args));
