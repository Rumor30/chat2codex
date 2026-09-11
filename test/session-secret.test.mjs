import test from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseSessionSecret, readSessionSecret } from '../src/session-secret.mjs';
const token = `eyJ${'a'.repeat(80)}.${'b'.repeat(80)}.${'c'.repeat(80)}`;
test('raw session token is accepted without transformation', () => assert.equal(parseSessionSecret(token), token));
test('auth session JSON imports sessionToken but never substitutes accessToken', () => {
  assert.equal(parseSessionSecret(JSON.stringify({ sessionToken: token, accessToken: `access_${'x'.repeat(80)}` })), token);
  assert.throws(() => parseSessionSecret(JSON.stringify({ accessToken: `access_${'x'.repeat(80)}` })), e => e.code === 'session_token_required');
});
test('legacy cookie header and chunked cookies are reconstructed', () => {
  assert.equal(parseSessionSecret(`Cookie: a=1; __Secure-next-auth.session-token=${token}; z=2`), token);
  const half = Math.ceil(token.length / 2);
  assert.equal(parseSessionSecret(`__Secure-next-auth.session-token.0=${token.slice(0, half)}; __Secure-next-auth.session-token.1=${token.slice(half)}`), token);
});
test('Auth.js cookie family is supported for local profile migration', () => {
  assert.equal(parseSessionSecret(`__Secure-authjs.session-token=${token}`), token);
});
test('control characters and incomplete chunk sequences fail closed', () => {
  assert.throws(() => parseSessionSecret(`${token}\nextra`), e => e.code === 'invalid_session_secret');
  assert.throws(() => parseSessionSecret(`__Secure-next-auth.session-token.1=${token}`), e => e.code === 'session_token_required');
});
test('session file must be private on Unix and is never rewritten', { skip: process.platform === 'win32' }, async t => {
  const root = mkdtempSync(join(tmpdir(), 'c2c-session-')); t.after(() => rmSync(root, { recursive: true, force: true }));
  const file = join(root, 'session.txt'); writeFileSync(file, token, { mode: 0o600 }); assert.equal(await readSessionSecret({ file }), token);
  chmodSync(file, 0o644); await assert.rejects(() => readSessionSecret({ file }), e => e.code === 'unsafe_session_file');
});
