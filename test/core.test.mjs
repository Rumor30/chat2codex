import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { State, Fault, lock, authorized, loopbackEndpoint } from '../src/state.mjs';
import { Router } from '../src/routing.mjs';
import { EventObserver } from '../src/sse.mjs';
import { codexInvocation } from '../src/codex.mjs';
import { profileEnvironment } from '../src/runtime.mjs';

function fixture(t) {
  const home = mkdtempSync(join(tmpdir(), 'c2c-')); t.after(() => rmSync(home, { recursive: true, force: true }));
  const state = new State(home); const a = state.add('A'); const b = state.add('B');
  const model = { id: 'chatgpt-web/high' };
  const workers = new Map([a, b].map(a => [a.id, { ready: true, generation: a.id, models: [model] }]));
  return { home, state, a, b, workers, router: new Router(home) };
}
const body = (id, extra = {}) => ({ model: 'chatgpt-web/high', prompt_cache_key: id, input: [{ role: 'user', content: 'test' }], ...extra });
const final = (id, output = []) => ({ type: 'response.completed', response: { id, status: 'completed', output } });
const call = (id, type = 'function_call') => ({ type, call_id: id, name: 'echo', arguments: '{}' });
const output = id => ({ type: 'function_call_output', call_id: id, output: 'ok' });
function done(router, lease, event = final('resp_done')) { router.observe(lease, event); router.finish(lease, true); }
function throwsCode(fn, code) { assert.throws(fn, e => e instanceof Fault && e.code === code); }

test('account store persists labels and isolates all paths', t => {
  const { state, a, b, home } = fixture(t);
  assert.notEqual(state.paths(a.id).profile, state.paths(b.id).profile);
  assert.equal(new State(home).list().length, 2);
  state.enable(a.id, false); assert.equal(new State(home).account(a.id).enabled, false);
  assert(!readFileSync(state.file, 'utf8').includes('accessToken'));
  throwsCode(() => state.paths('../escape'), 'account_not_found');
});
test('local keys are stable and bearer checks reject wrong lengths', t => {
  const { state } = fixture(t); const key = state.token();
  assert.equal(key, state.token()); assert(authorized(`Bearer ${key}`, key));
  assert(!authorized(undefined, key)); assert(!authorized(`Bearer ${key}x`, key));
});
test('corrupt account state is never silently replaced', t => {
  const { state } = fixture(t); writeFileSync(state.file, '{bad');
  throwsCode(() => state.list(), 'invalid_state'); assert.equal(readFileSync(state.file, 'utf8'), '{bad');
});
test('process locks are exclusive and explicit', t => {
  const { home } = fixture(t); const path = join(home, 'owner.lock'); const release = lock(path);
  throwsCode(() => lock(path), 'state_locked'); release(); lock(path)();
});
test('credential symlink is rejected', { skip: process.platform === 'win32' }, t => {
  const { state, home } = fixture(t); const target = join(home, 'other'); writeFileSync(target, 'x');
  const path = join(home, 'sym.key'); symlinkSync(target, path); throwsCode(() => state.token(path), 'unsafe_path');
});
test('only literal IPv4 loopback worker origins are accepted', () => {
  assert.equal(loopbackEndpoint('http://127.0.0.1:1234'), 'http://127.0.0.1:1234');
  for (const url of ['http://example.com', 'http://127.0.0.1.evil.test', 'http://localhost', 'http://u:p@127.0.0.1', 'http://127.0.0.1/x', 'https://127.0.0.1']) throwsCode(() => loopbackEndpoint(url), 'bad_endpoint');
});
test('threads choose least-loaded accounts and preserve tool affinity', t => {
  const { router, state, workers } = fixture(t); const x = router.acquire(body('x'), {}, workers, state.list());
  done(router, x, final('rx', [call('cx')]));
  const y = router.acquire(body('y'), {}, workers, state.list()); assert.notEqual(x.thread.accountId, y.thread.accountId); done(router, y, final('ry'));
  const next = router.acquire(body('x', { input: [output('cx')] }), {}, workers, state.list()); assert.equal(next.thread.accountId, x.thread.accountId); done(router, next, final('rx2'));
  assert.equal(router.threads.get('x').pending.length, 0);
});
test('continuation by previous_response_id resolves the original account', t => {
  const { router, state, workers } = fixture(t); const first = router.acquire(body('x'), {}, workers, state.list()); done(router, first, final('rx'));
  const next = router.acquire(body(undefined, { previous_response_id: 'rx' }), {}, workers, state.list()); assert.equal(next.thread.id, 'x'); done(router, next, final('rx2'));
});
test('recovered route state preserves original response ownership', t => {
  const { router, state, workers, home } = fixture(t); const first = router.acquire(body('x'), {}, workers, state.list()); done(router, first, final('rx'));
  const restarted = new Router(home); const lease = restarted.acquire(body(undefined, { previous_response_id: 'rx' }), {}, workers, state.list());
  assert.equal(lease.thread.accountId, first.thread.accountId); done(restarted, lease, final('rx2'));
});
test('pending parallel tool results must all be returned exactly once', t => {
  const { router, state, workers } = fixture(t); const first = router.acquire(body('x'), {}, workers, state.list()); done(router, first, final('rx', [call('c1'), call('c2')]));
  for (const input of [[output('c1')], [output('c1'), output('c1')], [output('c1'), output('wrong')]]) throwsCode(() => router.acquire(body('x', { input }), {}, workers, state.list()), 'tool_result_mismatch');
  const next = router.acquire(body('x', { input: [output('c2'), output('c1'), { type: 'compaction_trigger' }] }), {}, workers, state.list()); done(router, next, final('rx2'));
});
test('function and freeform calls share correct call_id routing', t => {
  const { router, state, workers } = fixture(t); const x = router.acquire(body('x'), {}, workers, state.list()); done(router, x, final('rx', [call('patch', 'custom_tool_call')]));
  const next = router.acquire(body(undefined, { input: [{ type: 'custom_tool_call_output', call_id: 'patch', output: 'applied' }] }), {}, workers, state.list());
  assert.equal(next.thread.id, 'x'); done(router, next, final('rx2'));
});
test('concurrent same-thread requests are rejected without cross-routing', t => {
  const { router, state, workers } = fixture(t); const x = router.acquire(body('x'), {}, workers, state.list());
  throwsCode(() => router.acquire(body('x'), {}, workers, state.list()), 'thread_busy'); done(router, x);
});
test('disabled accounts drain existing threads but cannot receive new ones', t => {
  const { router, state, workers, a, b } = fixture(t); const x = router.acquire(body('x'), { 'x-chat2codex-account': a.id }, workers, state.list()); done(router, x, final('rx'));
  state.enable(a.id, false); const next = router.acquire(body('x'), {}, workers, state.list()); assert.equal(next.thread.accountId, a.id); done(router, next, final('rx2'));
  const y = router.acquire(body('y'), {}, workers, state.list()); assert.equal(y.thread.accountId, b.id); done(router, y, final('ry'));
});
test('a bound worker failure never silently changes accounts', t => {
  const { router, state, workers } = fixture(t); const x = router.acquire(body('x'), {}, workers, state.list()); done(router, x, final('rx'));
  workers.get(x.thread.accountId).ready = false;
  throwsCode(() => router.acquire(body('x'), {}, workers, state.list()), 'bound_account_unavailable');
});
test('worker restart is a hard continuation fence', t => {
  const { router, state, workers } = fixture(t); const x = router.acquire(body('x'), {}, workers, state.list()); done(router, x, final('rx'));
  workers.get(x.thread.accountId).generation = 'new-process';
  throwsCode(() => router.acquire(body('x'), {}, workers, state.list()), 'worker_restarted');
});
test('unfinished streams and gateway crashes cannot be silently replayed', t => {
  const { router, state, workers, home } = fixture(t); const x = router.acquire(body('x'), {}, workers, state.list());
  const restarted = new Router(home); throwsCode(() => restarted.acquire(body('x'), {}, workers, state.list()), 'thread_uncertain');
  router.finish(x, false); throwsCode(() => router.acquire(body('x'), {}, workers, state.list()), 'thread_uncertain');
});
test('reject mismatched account, response, and native thread identities', t => {
  const { router, state, workers, a, b } = fixture(t); const x = router.acquire(body('x'), { 'x-chat2codex-account': a.id }, workers, state.list()); done(router, x, final('rx'));
  throwsCode(() => router.acquire(body('x'), { 'x-chat2codex-account': b.id }, workers, state.list()), 'account_conflict');
  throwsCode(() => router.acquire(body('other', { previous_response_id: 'rx' }), {}, workers, state.list()), 'identity_conflict');
  throwsCode(() => router.acquire(body('x', { client_metadata: { 'x-codex-turn-metadata': '{"thread_id":"native"}' } }), { 'x-chat2codex-thread': 'foreign' }, workers, state.list()), 'identity_conflict');
});
test('tool requests need explicit affinity and orphaned results fail', t => {
  const { router, state, workers } = fixture(t);
  throwsCode(() => router.acquire(body(undefined, { tools: [{ type: 'function', name: 'x' }] }), {}, workers, state.list()), 'thread_required');
  throwsCode(() => router.acquire(body('new', { input: [output('unknown')] }), {}, workers, state.list()), 'orphan_tool_result');
  throwsCode(() => router.acquire(body('x', { previous_response_id: 'unknown' }), {}, workers, state.list()), 'unknown_response');
});
test('SSE framing survives split Unicode and CRLF without changing bytes', () => {
  const events = []; const observer = new EventObserver(e => events.push(e));
  const bytes = Buffer.from(': heartbeat\r\n\r\ndata: {"type":"response.output_text.delta","delta":"海晶灯"}\r\n\r\ndata: [DONE]\r\n\r\n');
  for (const byte of bytes) observer.push(Buffer.from([byte])); observer.end();
  assert.deepEqual(events, [{ type: 'response.output_text.delta', delta: '海晶灯' }]);
});
test('SSE rejects truncated frames, oversized data and malformed JSON', () => {
  const o = new EventObserver(() => {}); o.push(Buffer.from('data: {}')); throwsCode(() => o.end(), 'truncated_sse');
  const large = new EventObserver(() => {}, 16); throwsCode(() => large.push(Buffer.from('x'.repeat(17))), 'sse_too_large');
  assert.throws(() => new EventObserver(() => {}).push(Buffer.from('data: broken\n\n')));
});
test('Codex shim uses process settings and keeps API key out of argv', t => {
  const { home, state } = fixture(t); const config = join(home, 'config.toml'); const auth = join(home, 'auth.json');
  writeFileSync(config, '# untouched'); writeFileSync(auth, '{"untouched":true}');
  const key = state.token(); const invocation = codexInvocation({ endpoint: 'http://127.0.0.1:7841', token: key, model: 'chatgpt-web/high', account: 'name"quoted', args: ['exec', 'test'], env: { CODEX_HOME: home }, reasoning: 'high', contextWindow: 90000, autoCompact: 80000 });
  assert(!invocation.args.join(' ').includes(key)); assert.equal(invocation.env.CHAT2CODEX_API_KEY, key); assert.equal(invocation.env.CODEX_HOME, home);
  assert(invocation.args.includes('model_providers.chat2codex.requires_openai_auth=false')); assert(invocation.args.includes('model_context_window=90000'));
  assert.deepEqual(invocation.args.slice(-2), ['exec', 'test']); assert.equal(readFileSync(config, 'utf8'), '# untouched'); assert.equal(readFileSync(auth, 'utf8'), '{"untouched":true}');
});
test('per-account launcher env cannot inherit user Codex paths', t => {
  const { state, a, b } = fixture(t);
  const original = { CODEX_HOME: '/original', CODEX_CHATGPT_WEB_HOME: '/normal', CODEX_WEB_GPT_LAUNCHER_DATA_DIR: '/normal-launcher', ELECTRON_RUN_AS_NODE: '1', PATH: '/safe' };
  const env = profileEnvironment(state, a.id, original);
  assert.equal(env.CODEX_HOME, undefined); assert.equal(env.CODEX_CHATGPT_WEB_HOME, undefined); assert.equal(env.ELECTRON_RUN_AS_NODE, undefined);
  assert.equal(original.CODEX_HOME, '/original'); assert.equal(env.PATH, '/safe');
  assert.equal(env.CODEX_WEB_GPT_BUN, 'bun'); assert.equal(env.CODEX_CHATGPT_WEB_BUN, 'bun');
  assert.notEqual(env.CODEX_WEB_GPT_DEV_HOME, profileEnvironment(state, b.id, original).CODEX_WEB_GPT_DEV_HOME);
});
test('malformed persistent route records fail closed', t => {
  const { home } = fixture(t); const path = join(home, 'routes.json'); const invalid = JSON.stringify({ version: 1, threads: [{ id: 'x' }] });
  writeFileSync(path, invalid); throwsCode(() => new Router(home), 'invalid_routes'); assert.equal(readFileSync(path, 'utf8'), invalid);
});
test('model absence and account capacity are explicit admission failures', t => {
  const { router, state, workers } = fixture(t);
  throwsCode(() => router.acquire({ ...body('missing'), model: 'chatgpt-web/pro' }, {}, workers, state.list()), 'no_ready_account');
  state.mutate(accounts => { for (const a of accounts) a.maxThreads = 1; });
  for (const id of ['x', 'y']) { const lease = router.acquire(body(id), {}, workers, state.list()); done(router, lease, final(`r_${id}`)); }
  throwsCode(() => router.acquire(body('z'), {}, workers, state.list()), 'no_ready_account');
});

test('pending tool round cannot switch model within the same account', t => {
  const { router, state, workers } = fixture(t);
  for (const w of workers.values()) w.models.push({ id: 'chatgpt-web/pro' });
  const lease = router.acquire(body('same-model'), {}, workers, state.list()); done(router, lease, final('rmodel', [call('pending')]));
  throwsCode(() => router.acquire(body('same-model', { model: 'chatgpt-web/pro', input: [output('pending')] }), {}, workers, state.list()), 'model_conflict');
});
