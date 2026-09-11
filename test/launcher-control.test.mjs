import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';
import vm from 'node:vm';
const require = createRequire(import.meta.url);
const source = readFileSync(new URL('../bridge/launcher-entry.cjs', import.meta.url), 'utf8');
function harness() {
  const accountId = `acct_${'a'.repeat(32)}`; const calls = []; let data = { user: { id: 'user-fixture' }, account: { id: 'workspace-A' }, accessToken: 'secret-not-for-tool-output' };
  const host = { profile: 'development', partition: 'persist:fixture' };
  class Control { constructor() { this.token = 'local-secret'; this.getBrowserHost = () => host; } async handle(_req, res) { res.original = true; } }
  const electron = { app: {}, BrowserWindow: class {}, session: { fromPartition(partition) { calls.push({ partition }); return { async fetch(url, init) { calls.push({ url, init }); return { ok: true, headers: new Headers({ 'content-type': 'application/json' }), json: async () => data }; } }; } } };
  const context = { require(name) {
    if (name === 'electron') return electron;
    if (name === './electron/control-server.cjs') return { BrowserControlServer: Control };
    if (name === './.chat2codex-provision.cjs') return require('../bridge/provision.cjs');
    if (name === './electron/profile.cjs') return { resolveLauncherProfile: () => ({ kind: 'development' }) };
    if (name === './electron/main.cjs') return {};
    return require(name);
  }, Buffer, AbortController, AbortSignal, URL, setImmediate, process: { env: { CHAT2CODEX_ACCOUNT_ID: accountId, CHAT2CODEX_ACCOUNT_HOME: '/fixture-only-not-used' } } };
  vm.runInNewContext(source, context, { filename: 'launcher-entry.cjs' });
  const control = new Control();
  const request = async ({ path = '/v1/chat2codex/identity', method = 'POST', headers = { authorization: 'Bearer local-secret' } } = {}) => {
    const req = new EventEmitter(); Object.assign(req, { url: path, method, headers });
    const res = new EventEmitter(); Object.assign(res, { writableEnded: false, writeHead(status) { this.status = status; }, end(text) { this.body = JSON.parse(text); this.writableEnded = true; } });
    await control.handle(req, res); return res;
  };
  return { accountId, calls, request, setData: value => { data = value; }, host };
}
test('identity bridge emits only an opaque account hash, never raw auth fields', async () => {
  const f = harness(); const r = await f.request(); assert.equal(r.status, 200); assert.equal(r.body.accountId, f.accountId); assert(r.body.authenticated);
  const encoded = JSON.stringify(r.body); assert(!encoded.includes('secret')); assert(!encoded.includes('user-fixture')); assert(!encoded.includes('workspace-A'));
  assert.equal(f.calls[0].partition, 'persist:fixture'); assert.equal(f.calls[1].url, 'https://chatgpt.com/api/auth/session');
});
test('identity hash is stable for one login but changes on workspace or user change', async () => {
  const f = harness(); const a = (await f.request()).body.identity; assert.equal((await f.request()).body.identity, a);
  f.setData({ user: { id: 'user-fixture' }, account: { id: 'workspace-B' } }); assert.notEqual((await f.request()).body.identity, a);
  f.setData({ user: { id: 'other' }, account: { id: 'workspace-A' } }); assert.notEqual((await f.request()).body.identity, a);
});
test('unauthorized or cross-origin launcher control never reads the session', async () => {
  const f = harness(); assert.equal((await f.request({ headers: {} })).status, 401);
  assert.equal((await f.request({ headers: { authorization: 'Bearer local-secret', origin: 'https://evil.invalid' } })).status, 403);
  assert.equal(f.calls.length, 0);
});
test('logged-out identity cannot be interpreted as an authenticated account', async () => {
  const f = harness(); f.setData({ expires: 'future' }); assert.equal((await f.request()).body.authenticated, false);
});
test('non-development host is rejected before session inspection', async () => {
  const f = harness(); f.host.profile = 'production'; assert.equal((await f.request()).status, 409); assert.equal(f.calls.length, 0);
});
test('unrelated upstream launcher routes remain owned by the upstream handler', async () => {
  const f = harness(); assert.equal((await f.request({ path: '/v1/status' })).original, true); assert.equal(f.calls.length, 0);
});
