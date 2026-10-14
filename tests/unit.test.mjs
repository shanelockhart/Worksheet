import { test } from 'node:test';
import assert from 'node:assert/strict';
import { networkKey, hashNetwork, issueSession, verifySession } from '../server/session.mjs';
import { validateChat } from '../server/validate.mjs';
import { loadConfig } from '../server/config.mjs';

test('networkKey', () => {
  assert.equal(networkKey('203.0.113.9'), '203.0.113.9');
  assert.equal(networkKey('::ffff:203.0.113.9'), '203.0.113.9');
  assert.equal(networkKey('2001:db8:1:2::1'), networkKey('2001:db8:1:2:aaaa:bbbb:cccc:dddd'));
  assert.notEqual(networkKey('2001:db8:1:2::1'), networkKey('2001:db8:1:3::1'));
  assert.equal(networkKey(''), 'unknown');
});
test('hashNetwork depends on secret and hides the IP', () => {
  const a = hashNetwork('s'.repeat(40), '1.2.3.4'), b = hashNetwork('t'.repeat(40), '1.2.3.4');
  assert.notEqual(a, b); assert.ok(!a.includes('1.2.3.4'));
});
test('session sign/verify/expiry', () => {
  const s = 'k'.repeat(40), { id, token } = issueSession(s, 1_000_000_000_000);
  assert.equal(verifySession(s, token, 1_000_000_000_000 + 1000).id, id);
  assert.equal(verifySession('z'.repeat(40), token, 1_000_000_000_000), null);
  assert.equal(verifySession(s, token, 1_000_000_000_000 + 31 * 86400e3), null);
  assert.equal(verifySession(s, token.replace(id, id.slice(0, -1) + (id.endsWith('A') ? 'B' : 'A')), 1_000_000_000_000), null);
});
test('config validation', () => {
  assert.throws(() => loadConfig({ AI_PROVIDER: 'nope' })); assert.throws(() => loadConfig({ LIMIT_PER_WINDOW: 'abc' }));
  const c = loadConfig({}); assert.equal(c.limit, 5); assert.equal(c.windowSeconds, 3600); assert.equal(c.model, 'claude-haiku-5-5');
});
test('validate strips control characters and merges same-role turns', () => {
  const cfg = loadConfig({});
  const out = validateChat({ messages: [{ role: 'user', content: 'a' }, { role: 'user', content: 'b' }, { role: 'user', content: 'hi\u0000there' }] }, cfg);
  assert.equal(out.length, 1); assert.ok(out[0].content.includes('hithere'));
});
