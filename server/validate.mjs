// Validates and trims the conversation sent by the browser. The server decides how much context reaches the model.

const CTRL = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g;

export class ValidationError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}

export function cleanText(s) {
  return String(s).replace(CTRL, '').replace(/\r\n?/g, '\n').trim();
}

export function validateChat(body, cfg) {
  if (!body || typeof body !== 'object' || !Array.isArray(body.messages)) {
    throw new ValidationError('bad_request', 'Send a "messages" array.');
  }
  const raw = body.messages;
  if (raw.length === 0 || raw.length > 100) throw new ValidationError('bad_request', 'Invalid number of messages.');
  const msgs = [];
  for (const m of raw) {
    if (!m || typeof m !== 'object' || (m.role !== 'user' && m.role !== 'assistant') || typeof m.content !== 'string') {
      throw new ValidationError('bad_request', 'Each message needs a role (user or assistant) and text content.');
    }
    msgs.push({ role: m.role, content: cleanText(m.content) });
  }
  const last = msgs.at(-1);
  if (last.role !== 'user') throw new ValidationError('bad_request', 'The last message must be from the user.');
  if (!last.content) throw new ValidationError('empty', 'Type a question first.');
  if (last.content.length > cfg.maxInputChars) {
    throw new ValidationError('too_long', `Questions are limited to ${cfg.maxInputChars} characters. Yours is ${last.content.length}.`);
  }

  // Context: newest messages that fit both the message and character budgets.
  const history = msgs.slice(0, -1).filter((m) => m.content);
  const kept = [];
  let chars = 0;
  for (let i = history.length - 1; i >= 0 && kept.length < cfg.maxHistoryMessages; i--) {
    const content = history[i].content.slice(0, 2000);
    if (chars + content.length > cfg.maxHistoryChars) break;
    chars += content.length;
    kept.unshift({ role: history[i].role, content });
  }
  while (kept.length && kept[0].role !== 'user') kept.shift(); // must start with a user turn
  // Merge consecutive same-role turns (some providers reject them).
  const out = [];
  for (const m of [...kept, last]) {
    const prev = out.at(-1);
    if (prev && prev.role === m.role) prev.content += '\n\n' + m.content;
    else out.push({ ...m });
  }
  return out;
}
