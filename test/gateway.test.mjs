import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { State } from '../src/state.mjs';
import { createGateway } from '../src/gateway.mjs';

const sse = event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`;
async function listen(server) { await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); return `http://127.0.0.1:${server.address().port}`; }
async function harness(t, behavior) {
  const home = mkdtempSync(join(tmpdir(), 'c2c-http-')); const state = new State(home); const accounts = [state.add('A'), state.add('B')];
  const requests = []; const fixtures = []; const snapshots = new Map();
  for (const account of accounts) {
    const server = createServer(async (req, res) => {
      const chunks = []; for await (const c of req) chunks.push(c);
      const raw = Buffer.concat(chunks).toString(); const body = JSON.parse(raw);
      requests.push({ accountId: account.id, raw, body, headers: req.headers, path: req.url });
      behavior(req, res, body, account);
    });
    const endpoint = await listen(server); fixtures.push(server);
    snapshots.set(account.id, { endpoint, token: 'worker-only-token', generation: account.id, ready: true, models: [{ id: 'chatgpt-web/high', context_window: 90000, auto_compact_token_limit: 80000 }] });
  }
  const workers = { snapshots: async () => snapshots, start() {}, launch() {}, control: async (_id, action) => action === 'verify' ? { verified: true } : { cancelled: 1 } };
  const gateway = createGateway({ state, workers }); const endpoint = await listen(gateway.server); const key = state.token();
  t.after(async () => { await gateway.close(); for (const s of fixtures) { s.closeAllConnections(); await new Promise(r => s.close(r)); } rmSync(home, { recursive: true, force: true }); });
  const post = (body, headers = {}, path = '/v1/responses') => fetch(`${endpoint}${path}`, { method: 'POST', headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });
  return { endpoint, key, state, accounts, requests, post, gateway, snapshots, workers };
}
const request = (thread, input = [{ role: 'user', content: 'inspect' }]) => ({ model: 'chatgpt-web/high', stream: true, prompt_cache_key: thread, input });
function response(res, id, output) { res.writeHead(200, { 'content-type': 'text/event-stream' }); res.end(sse({ type: 'response.created', response: { id, status: 'in_progress', output: [] } }) + sse({ type: 'response.completed', response: { id, status: 'completed', output } })); }

test('real HTTP gateway keeps tools and tool results on one worker', async t => {
  const h = await harness(t, (_req, res, body) => {
    const result = body.input.find(i => i.type === 'function_call_output');
    response(res, result ? 'resp_second' : 'resp_first', result ? [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: '海晶测试通过' }] }] : [{ type: 'function_call', call_id: 'call_test', name: 'exec_command', arguments: '{"cmd":"pwd"}' }]);
  });
  const first = { ...request('thread'), tools: [{ type: 'namespace', name: 'mcp__demo', tools: [{ type: 'function', name: 'echo', parameters: { type: 'object' } }] }] };
  const r = await h.post(first); assert.equal(r.status, 200); const text = await r.text(); assert(text.includes('call_test'));
  const second = await h.post({ ...request('thread', [{ type: 'function_call_output', call_id: 'call_test', output: '/workspace' }]), previous_response_id: 'resp_first' });
  assert.equal(second.status, 200); assert((await second.text()).includes('海晶测试通过'));
  assert.equal(h.requests[0].accountId, h.requests[1].accountId); assert.equal(h.requests[0].raw, JSON.stringify(first));
  assert.equal(h.requests[0].headers.authorization, 'Bearer worker-only-token'); assert(!h.requests[0].raw.includes(h.key));
});
test('separate HTTP threads use separate accounts, not a shared session', async t => {
  const h = await harness(t, (_req, res, body) => response(res, `r_${body.prompt_cache_key}`, []));
  await (await h.post(request('one'))).text(); await (await h.post(request('two'))).text();
  assert.notEqual(h.requests[0].accountId, h.requests[1].accountId);
});
test('SSE is forwarded byte-for-byte including partial Unicode chunks', async t => {
  const wire = ': heartbeat\n\n' + sse({ type: 'response.output_text.delta', delta: '你好，Chat2Codex' }) + sse({ type: 'response.completed', response: { id: 'rbytes', status: 'completed', output: [] } });
  const h = await harness(t, (_req, res) => { res.writeHead(200, { 'content-type': 'text/event-stream' }); for (const b of Buffer.from(wire)) res.write(Buffer.from([b])); res.end(); });
  const r = await h.post(request('bytes')); assert.equal(await r.text(), wire);
});
test('nonstream JSON Responses and custom tools retain original shape', async t => {
  const payload = { id: 'json_id', status: 'completed', output: [{ type: 'custom_tool_call', call_id: 'patch_id', name: 'apply_patch', input: '*** Begin Patch\n*** End Patch' }] };
  const h = await harness(t, (_req, res) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(payload)); });
  const r = await h.post({ ...request('json'), stream: false }); assert.deepEqual(await r.json(), payload);
  assert.deepEqual(h.gateway.router.threads.get('json').pending, ['patch_id']);
});
test('compaction endpoint forwards native replacement-history shape', async t => {
  const payload = { output: [{ type: 'compaction', encrypted_content: 'opaque-preserved' }] };
  const h = await harness(t, (_req, res) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(payload)); });
  const r = await h.post({ ...request('compact'), stream: false }, {}, '/v1/responses/compact');
  assert.deepEqual(await r.json(), payload); assert.equal(h.requests[0].path, '/v1/responses/compact');
  assert.equal(h.gateway.router.threads.get('compact').state, 'ready');
});
test('truncated streams become uncertain and are not replayed', async t => {
  const h = await harness(t, (_req, res) => { res.writeHead(200, { 'content-type': 'text/event-stream' }); res.end(sse({ type: 'response.created', response: { id: 'truncated' } })); });
  const r = await h.post(request('broken')); const text = await r.text(); assert(text.includes('missing_terminal')); assert(!text.includes('response.completed'));
  const retry = await h.post(request('broken')); assert.equal(retry.status, 409); assert.equal(h.requests.length, 1);
});
test('HTTP 429 is returned with Retry-After and never retried on another account', async t => {
  const h = await harness(t, (_req, res) => { res.writeHead(429, { 'content-type': 'application/json', 'retry-after': '60' }); res.end('{"error":{"code":"rate_limit"}}'); });
  const r = await h.post(request('limited')); assert.equal(r.status, 429); assert.equal(r.headers.get('retry-after'), '60'); assert.equal((await r.json()).error.code, 'rate_limit'); assert.equal(h.requests.length, 1);
});
test('authenticated administration never exposes worker or gateway tokens', async t => {
  const h = await harness(t, (_req, res) => response(res, 'x', []));
  const unauthorized = await fetch(`${h.endpoint}/api/accounts`); assert.equal(unauthorized.status, 401);
  const r = await fetch(`${h.endpoint}/api/accounts`, { headers: { authorization: `Bearer ${h.key}` } }); const text = await r.text();
  assert(!text.includes(h.key)); assert(!text.includes('worker-only-token')); assert(!text.includes('endpoint'));
});
test('cross-origin requests and WebSocket upgrade are rejected', async t => {
  const h = await harness(t, (_req, res) => response(res, 'x', []));
  const cross = await h.post(request('cross'), { origin: 'https://evil.invalid' }); assert.equal(cross.status, 403); assert.equal(h.requests.length, 0);
  const ws = await fetch(`${h.endpoint}/v1/responses`, { headers: { authorization: `Bearer ${h.key}` } }); assert.equal(ws.status, 426);
});
test('model list contains only enabled Ready account capabilities', async t => {
  const h = await harness(t, (_req, res) => response(res, 'x', []));
  h.state.enable(h.accounts[0].id, false); h.snapshots.get(h.accounts[1].id).ready = false;
  const r = await fetch(`${h.endpoint}/v1/models`, { headers: { authorization: `Bearer ${h.key}` } }); assert.deepEqual((await r.json()).data, []);
});
test('dashboard has a CSP and no embedded management credential', async t => {
  const h = await harness(t, (_req, res) => response(res, 'x', []));
  const r = await fetch(h.endpoint); const html = await r.text(); assert.equal(r.status, 200);
  assert(r.headers.get('content-security-policy').includes("frame-ancestors 'none'")); assert(html.includes('Chat2Codex')); assert(!html.includes(h.key));
});
test('cancel also retires a pending tool boundary between HTTP requests', async t => {
  const h = await harness(t, (_req, res) => response(res, 'cancel_pending', [{ type: 'function_call', call_id: 'pending', name: 'echo', arguments: '{}' }]));
  await (await h.post(request('cancel-me'))).text();
  const r = await h.post({ thread_id: 'cancel-me' }, {}, '/api/cancel'); assert.equal(r.status, 200); await r.text();
  assert.equal(h.gateway.router.threads.get('cancel-me').state, 'cancelled'); assert.equal(h.gateway.router.threads.get('cancel-me').pending.length, 0);
  const retry = await h.post(request('cancel-me')); assert.equal(retry.status, 409); assert.equal(h.requests.length, 1);
});

test('two simultaneous HTTP tasks retain separate workers', async t => {
  const h = await harness(t, (_req, res, body) => setTimeout(() => response(res, `parallel_${body.prompt_cache_key}`, []), 25));
  const results = await Promise.all(['one', 'two'].map(async id => { const r = await h.post(request(id)); assert.equal(r.status, 200); return r.text(); }));
  assert(results.every(text => text.includes('response.completed'))); assert.notEqual(h.requests[0].accountId, h.requests[1].accountId);
});
test('account login-window action is authenticated and account-scoped', async t => {
  const h = await harness(t, (_req, res) => response(res, 'x', []));
  const r = await h.post({}, {}, `/api/accounts/${h.accounts[0].id}/launch`); assert.equal(r.status, 202); assert.deepEqual(await r.json(), { launching: true });
});

test('account reset blocks admission to its existing threads until cleanup settles', async t => {
  const h = await harness(t, (_req, res, body) => response(res, `r_${body.prompt_cache_key}`, []));
  await (await h.post(request('bound'))).text(); const account = h.gateway.router.threads.get('bound').accountId;
  let started; let resume;
  const begun = new Promise(r => { started = r; }); const unblock = new Promise(r => { resume = r; });
  h.workers.control = async () => { started(); await unblock; return { reset: true }; };
  const reset = h.post({ confirm: true }, {}, `/api/accounts/${account}/reset`); await begun;
  try { const blocked = await h.post(request('bound')); assert.equal(blocked.status, 503); await blocked.text(); assert.equal(h.requests.length, 1); }
  finally { resume(); }
  assert.equal((await reset).status, 200); assert(!h.gateway.router.threads.has('bound'));
});

test('dashboard invitation is single-use and rejects cross-origin exchange', async t => {
  const h = await harness(t, (_req, res) => response(res, 'unused', [])); const ticket = h.gateway.invitations.issue();
  const exchange = (headers = {}) => fetch(`${h.endpoint}/api/session`, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify({ ticket }) });
  assert.equal((await exchange({ origin: 'https://evil.invalid' })).status, 403);
  const first = await exchange(); assert.equal(first.status, 200); assert.equal((await first.json()).key, h.key);
  assert.equal((await exchange()).status, 401);
});
test('async configure is account-exclusive and never publishes secret fields', async t => {
  const h = await harness(t, (_req, res) => response(res, 'unused', [])); const id = h.accounts[0].id;
  let resume; const block = new Promise(r => { resume = r; }); let seen;
  h.workers.configure = async (_id, body) => { seen = body.runtimeKey; await block; return { code: 'completed', token: body.runtimeKey }; };
  const r = await h.post({ action: 'configure', consent: true, tunnelId: `tunnel_${'a'.repeat(32)}`, runtimeKey: 'secret-fixture-123456789' }, {}, `/api/accounts/${id}/actions`);
  assert.equal(r.status, 202); const receipt = await r.json(); assert.equal(receipt.state, 'running'); assert(!JSON.stringify(receipt).includes('secret-fixture'));
  try {
    assert.equal((await h.post(request('blocked'), { 'x-chat2codex-account': id })).status, 503);
    assert.equal((await h.post({ action: 'verify', model: 'chatgpt-web/high' }, {}, `/api/accounts/${id}/actions`)).status, 409);
  } finally { resume(); }
  await Promise.all([...h.gateway.jobs.controllers.values()].map(c => c.settled));
  assert.equal(seen, 'secret-fixture-123456789'); assert(!JSON.stringify(h.gateway.jobs.list()).includes(seen));
  assert(!JSON.stringify(h.gateway.diagnostics.report()).includes(seen));
});
test('settings endpoint cannot bypass the archive lifecycle gate', async t => {
  const h = await harness(t, (_req, res) => response(res, 'unused', []));
  const r = await h.post({ archived: true }, {}, `/api/accounts/${h.accounts[0].id}/settings`);
  assert.equal(r.status, 409); assert.equal((await r.json()).error.code, 'archive_action_required');
});
test('individual retirement frees capacity but does not permit stale thread replay', async t => {
  const h = await harness(t, (_req, res, body) => response(res, `r_${body.prompt_cache_key}`, []));
  await (await h.post(request('finished'))).text(); const owner = h.gateway.router.threads.get('finished').accountId;
  const retired = await h.post({ thread_id: 'finished' }, {}, '/api/threads/retire'); assert.equal(retired.status, 200); await retired.text();
  assert.equal(h.gateway.router.counts(owner), 0); assert.equal((await h.post(request('finished'))).status, 409);
  assert.equal((await h.post(request('new'), { 'x-chat2codex-account': owner })).status, 200);
});
test('admin snapshots omit large model instructions while API catalog preserves them', async t => {
  const h = await harness(t, (_req, res) => response(res, 'unused', []));
  for (const w of h.snapshots.values()) w.models[0].base_instructions = 'PUBLIC_NATIVE_TEMPLATE';
  const headers = { authorization: `Bearer ${h.key}` };
  assert(!(await (await fetch(`${h.endpoint}/api/accounts`, { headers })).text()).includes('PUBLIC_NATIVE_TEMPLATE'));
  assert((await (await fetch(`${h.endpoint}/v1/models`, { headers })).text()).includes('PUBLIC_NATIVE_TEMPLATE'));
});
