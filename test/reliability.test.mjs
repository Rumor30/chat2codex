import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Jobs } from '../src/jobs.mjs';
import { State, recoverLock, lock } from '../src/state.mjs';
import { Router } from '../src/routing.mjs';
import { Invitations } from '../src/invitations.mjs';
import { Diagnostics } from '../src/diagnostics.mjs';
import { processFailure, runPrivate } from '../src/process.mjs';
import { startAccountOperation } from '../src/onboarding.mjs';
import { createRequire } from 'node:module';
const { Provisioner, settingsStep } = createRequire(import.meta.url)('../bridge/provision.cjs');
const code = value => e => e.code === value;
function dir(t) { const home = mkdtempSync(join(tmpdir(), 'c2c-reliable-')); t.after(() => rmSync(home, { recursive: true, force: true })); return home; }
async function settle(jobs) { await Promise.all([...jobs.controllers.values()].map(c => c.settled)); }
function route(t) {
  const home = dir(t); const state = new State(home); const a = state.add('fixture A'); const b = state.add('fixture B'); const router = new Router(home);
  const workers = new Map([a, b].map(a => [a.id, { ready: true, generation: a.id, models: [{ id: 'chatgpt-web/high' }] }]));
  const request = (thread, input = [{ role: 'user', content: 'fixture' }]) => ({ model: 'chatgpt-web/high', prompt_cache_key: thread, input });
  const complete = (lease, id, output = []) => { router.observe(lease, { type: 'response.completed', response: { id, status: 'completed', output } }); router.finish(lease, true); };
  return { home, state, a, b, router, workers, request, complete };
}

test('job metadata never persists credentials, raw errors, or callback return objects', async t => {
  const home = dir(t); const jobs = new Jobs(home); const secret = 'sk-do-not-log-secret-fixture';
  jobs.start('account', 'configure', async () => ({ code: 'completed', token: secret })); await settle(jobs);
  jobs.start('account', 'verify', async () => { throw new Error(`auth failure ${secret}`); }); await settle(jobs);
  assert(!readFileSync(jobs.file, 'utf8').includes(secret)); assert.equal(jobs.list()[0].code, 'operation_failed');
});
test('job lease excludes a second concurrent operation on the same account', async t => {
  const jobs = new Jobs(dir(t)); let finish; const block = new Promise(r => { finish = r; });
  jobs.start('same', 'verify', () => block); assert(jobs.active('same'));
  assert.throws(() => jobs.start('same', 'configure', () => {}), code('account_busy')); finish(); await settle(jobs); assert(!jobs.active('same'));
});
test('job lease is independent across accounts', async t => {
  const jobs = new Jobs(dir(t)); let finish; const block = new Promise(r => { finish = r; });
  jobs.start('a', 'verify', () => block); jobs.start('b', 'verify', () => block); assert.equal(jobs.controllers.size, 2); finish(); await settle(jobs);
});
test('interrupted jobs are restored as interrupted, never replayed', async t => {
  const home = dir(t); const jobs = new Jobs(home); let finish; const block = new Promise(r => { finish = r; }); jobs.start('a', 'configure', () => block);
  const restored = new Jobs(home); assert.equal(restored.list()[0].state, 'interrupted'); assert(!restored.active('a')); finish(); await settle(jobs);
});
test('cancellation propagates to the operation without a false success receipt', async t => {
  const jobs = new Jobs(dir(t));
  const job = jobs.start('a', 'configure', async ({ signal }) => { await new Promise(r => signal.addEventListener('abort', r, { once: true })); });
  await new Promise(r => setImmediate(r)); jobs.cancel(job.id); await settle(jobs); assert.equal(jobs.list()[0].state, 'cancelled');
});
test('setup outcomes requiring a person are not reported as succeeded', async t => {
  const jobs = new Jobs(dir(t)); jobs.start('a', 'assist', async () => ({ code: 'tunnel_selection_required' })); await settle(jobs); assert.equal(jobs.list()[0].state, 'waiting_user');
});
test('operation history is bounded while active entries stay visible', async t => {
  const jobs = new Jobs(dir(t), { limit: 2 });
  for (let i = 0; i < 5; i++) { jobs.start('a', 'test', async () => {}); await settle(jobs); }
  assert.equal(jobs.list().length, 2);
});
test('diagnostic export permits only safe codes and identifiers', t => {
  const diagnostics = new Diagnostics(dir(t)); diagnostics.record('request_failed', { code: 'no_ready_account', status: 503, password: 'secret', prompt: 'private' });
  const encoded = JSON.stringify(diagnostics.report()); assert(encoded.includes('no_ready_account')); assert(!encoded.includes('private')); assert(!encoded.includes('secret'));
});
test('invitation expires and is consumed once', () => {
  let now = 10; const invitations = new Invitations({ now: () => now, ttlMs: 10 }); const ticket = invitations.issue(); invitations.consume(ticket);
  assert.throws(() => invitations.consume(ticket), code('invitation_expired')); const next = invitations.issue(); now = 21; assert.throws(() => invitations.consume(next), code('invitation_expired'));
});
test('malformed invitation cannot authenticate the local dashboard', () => {
  const invitations = new Invitations(); for (const ticket of [null, '', {}, 'guessed']) assert.throws(() => invitations.consume(ticket), code('invitation_expired'));
});
test('invitation capacity is bounded', () => {
  const invitations = new Invitations(); for (let i = 0; i < 8; i++) invitations.issue(); assert.throws(() => invitations.issue(), code('invitation_capacity'));
});
test('dead process locks can be reclaimed, live locks cannot', t => {
  const home = dir(t); const path = join(home, 'lock'); writeFileSync(path, '987654321'); assert(recoverLock(path, () => false)); assert(!existsSync(path));
  const release = lock(path); assert(!recoverLock(path, () => true)); release();
});
test('malformed lock owner fails closed', t => {
  const path = join(dir(t), 'lock'); writeFileSync(path, 'not-a-pid'); assert.throws(() => recoverLock(path), code('invalid_lock')); assert(existsSync(path));
});
test('account rename, capacity and archive preserve isolated profile identity', t => {
  const state = new State(dir(t)); const a = state.add('before'); const path = state.paths(a.id).profile;
  state.update(a.id, { label: 'after', maxThreads: 2, archived: true }); assert.equal(state.account(a.id).label, 'after'); assert(!state.account(a.id).enabled); assert.equal(state.paths(a.id).profile, path);
  assert.throws(() => state.update(a.id, { maxThreads: 100 }), code('bad_capacity'));
});
test('private process input is not returned in error diagnostics', async () => {
  const secret = 'sk-fixture-private-input'; await assert.rejects(runPrivate(process.execPath, ['-e', 'process.stdin.on("data", x => { console.error(x.toString()); process.exitCode=1 })'], { input: secret }), e => !e.message.includes(secret) && e.code === 'runtime_command_failed');
});
test('private process reports missing dependencies without raw process output', async () => {
  await assert.rejects(runPrivate('/not/a/real/c2c/executable', [], {}), code('dependency_missing'));
});
test('private process respects an already-aborted signal', async () => {
  const c = new AbortController(); c.abort(); await assert.rejects(runPrivate(process.execPath, ['-e', 'process.exit(99)'], { signal: c.signal }), code('operation_cancelled'));
});
test('private process cancellation settles its child', async () => {
  const c = new AbortController(); const promise = runPrivate(process.execPath, ['-e', 'setInterval(()=>{}, 1000)'], { signal: c.signal }); setTimeout(() => c.abort(), 30); await assert.rejects(promise, code('operation_cancelled'));
});
test('process failure classifier produces actionable fixed codes', () => {
  assert.equal(processFailure('EAI_AGAIN with private hostname'), 'network_unavailable'); assert.equal(processFailure('runtime key unauthorized'), 'tunnel_auth_required');
});
test('malformed Responses tool/input shapes fail at admission', t => {
  const f = route(t);
  assert.throws(() => f.router.acquire({ ...f.request('x'), tools: {} }, {}, f.workers, f.state.list()), code('invalid_tools'));
  assert.throws(() => f.router.acquire({ ...f.request('x'), input: {} }, {}, f.workers, f.state.list()), code('invalid_input'));
  assert.equal(f.router.threads.size, 0);
});
test('an unknown new tool result cannot piggyback on a valid pending result', t => {
  const f = route(t); const lease = f.router.acquire(f.request('x'), {}, f.workers, f.state.list()); f.complete(lease, 'r1', [{ type: 'function_call', name: 'echo', call_id: 'known' }]);
  const input = [{ type: 'function_call_output', call_id: 'known', output: 'ok' }, { type: 'function_call_output', call_id: 'foreign', output: 'fake' }];
  assert.throws(() => f.router.acquire(f.request('x', input), {}, f.workers, f.state.list()), code('tool_result_mismatch'));
});
test('failed admission cannot leak an account slot', t => {
  const f = route(t); const input = [{ type: 'function_call_output', call_id: 'foreign', output: 'fake' }, { role: 'user', content: 'next' }];
  assert.throws(() => f.router.acquire(f.request('x', input), {}, f.workers, f.state.list()), code('orphan_tool_result')); assert.equal(f.router.threads.size, 0);
});
test('failed persistence rolls back an in-memory admission lock', t => {
  const f = route(t); f.router.save = () => { throw new Error('disk full'); };
  assert.throws(() => f.router.acquire(f.request('x'), {}, f.workers, f.state.list()), /disk full/); assert.equal(f.router.threads.size, 0); assert.equal(f.router.busy.size, 0);
});
test('completed event needs a coherent status and output array', t => {
  const f = route(t); const lease = f.router.acquire(f.request('x'), {}, f.workers, f.state.list());
  assert.throws(() => f.router.observe(lease, { type: 'response.completed', response: { id: 'r', status: 'failed', output: [] } }), code('invalid_terminal'));
  assert.throws(() => f.router.observe(lease, { type: 'response.completed', response: { id: 'r', status: 'completed' } }), code('invalid_terminal')); f.router.finish(lease, false);
});
test('second terminal event cannot rewrite a completed result', t => {
  const f = route(t); const lease = f.router.acquire(f.request('x'), {}, f.workers, f.state.list()); f.complete(lease, 'r');
  assert.throws(() => f.router.observe(lease, { type: 'response.completed', response: { id: 'r2', status: 'completed', output: [] } }), code('duplicate_terminal'));
});
test('retiring a thread frees capacity but rejects its later replay', t => {
  const f = route(t); const lease = f.router.acquire(f.request('x'), {}, f.workers, f.state.list()); f.complete(lease, 'r'); f.router.release('x');
  assert.equal(f.router.counts(lease.thread.accountId), 0); assert.throws(() => f.router.acquire(f.request('x'), {}, f.workers, f.state.list()), code('thread_retired'));
  const restored = new Router(f.home); assert.equal(restored.threads.get('x').state, 'retired');
});
test('settings page driver contains no private Connector endpoint or token extraction', () => {
  const source = settingsStep.toString(); assert(!source.includes('/backend-api/')); assert(!source.includes('document.cookie')); assert(!source.includes('localStorage'));
});
const target = { name: 'Codex Native2 DEV', tunnelId: `tunnel_${'a'.repeat(32)}` };
function provision(responses, journal) {
  const calls = []; let saved = journal;
  const p = new Provisioner({ evaluate: async (t, action) => { calls.push(action); const next = responses.shift(); if (next instanceof Error) throw next; return next; }, load: () => saved, save: j => { saved = j; }, pause: async () => {} });
  return { p, calls, saved: () => saved };
}
test('Connector creation records intent before its one create action', async () => {
  const f = provision([{ code: 'ready_to_create' }, { code: 'creation_submitted' }]); const r = await f.p.assist(target);
  assert.equal(r.code, 'creation_submitted_verify_required'); assert(f.saved().attempted); assert.deepEqual(f.calls, ['inspect', 'create']);
});
test('an ambiguous create is not repeated after a restart', async () => {
  const f = provision([{ code: 'ready_to_create' }, new Error('network lost')]); await assert.rejects(f.p.assist(target));
  const retry = provision([{ code: 'ready_to_create' }], f.saved()); assert.equal((await retry.p.assist(target)).code, 'creation_needs_reconciliation'); assert.deepEqual(retry.calls, ['inspect']);
});
test('same-name existing Connector requires identity review, not duplicate creation', async () => {
  const f = provision([{ code: 'connector_exists_review' }]); assert.equal((await f.p.assist(target)).code, 'connector_exists_review'); assert.deepEqual(f.calls, ['inspect']);
});
test('changed Tunnel cannot reuse an uncertain create transaction', async () => {
  const f = provision([], { ...target, attempted: true }); assert.equal((await f.p.assist({ ...target, tunnelId: `tunnel_${'b'.repeat(32)}` })).code, 'creation_needs_reconciliation'); assert.equal(f.calls.length, 0);
});
test('setup assistant stops on security or unsupported-control requirements', async () => {
  const f = provision([{ code: 'security_confirmation_required' }, { code: 'security_confirmation_required' }]); assert.equal((await f.p.assist(target)).code, 'security_confirmation_required'); assert(!f.calls.includes('create'));
});
test('setup helper never accepts a caller-provided arbitrary Connector name', async () => {
  const f = provision([]); assert.equal((await f.p.assist({ ...target, name: 'other service' })).code, 'invalid_connector_target'); assert.equal(f.calls.length, 0);
});
test('setup helper serializes actions against one browser page', async () => {
  let finish; const block = new Promise(r => { finish = r; });
  const p = new Provisioner({ evaluate: () => block, load: () => undefined, save: () => {}, pause: async () => {} });
  const active = p.assist(target); assert.equal((await p.assist(target)).code, 'setup_busy'); finish({ code: 'connector_exists_review' }); await active;
});
test('setup helper checks cancellation before mutating the page', async () => {
  const f = provision([]); const c = new AbortController(); c.abort(); assert.equal((await f.p.assist(target, c.signal)).code, 'operation_cancelled'); assert.equal(f.calls.length, 0);
});
test('configuration action refuses missing explicit consent before creating a job', t => {
  const f = route(t); const jobs = new Jobs(f.home);
  assert.throws(() => startAccountOperation({ ...f, jobs, workers: {} }, f.a.id, { action: 'configure', tunnelId: target.tunnelId, runtimeKey: 'x'.repeat(30) }), code('invalid_tunnel_credentials')); assert.equal(jobs.list().length, 0);
});
test('configuration action does not run while a thread is active', t => {
  const f = route(t); const lease = f.router.acquire(f.request('x'), {}, f.workers, f.state.list());
  assert.throws(() => startAccountOperation({ ...f, jobs: new Jobs(f.home), workers: {} }, lease.thread.accountId, { action: 'assist', consent: true }), code('account_busy')); f.router.finish(lease, false);
});

test('journal admission failure rolls back its in-memory account lease', t => {
  const { home, a } = route(t); const jobs = new Jobs(home); jobs.save = () => { throw new Error('disk unavailable'); };
  assert.throws(() => jobs.start(a.id, 'verify', () => { throw new Error('must not run'); }));
  assert(!jobs.active(a.id)); assert.equal(jobs.list().length, 0);
});
test('journal settlement failure is handled, not an unhandled rejection', async t => {
  const { home, a } = route(t); const jobs = new Jobs(home);
  jobs.start(a.id, 'verify', async () => { jobs.save = () => { throw new Error('disk unavailable'); }; return {}; });
  await new Promise(resolve => setTimeout(resolve, 5));
  assert.equal(jobs.list()[0].code, 'journal_write_failed'); assert(!jobs.active(a.id));
});
test('abort after read-only settings inspection prevents Create', async () => {
  const c = new AbortController(); let writes = 0;
  const p = new Provisioner({ load: () => undefined, save: () => writes++, evaluate: async () => { c.abort(); return { code: 'ready_to_create' }; } });
  const result = await p.assist({ name: 'Codex Native2 DEV', tunnelId: `tunnel_${'a'.repeat(32)}` }, c.signal);
  assert.equal(result.code, 'operation_cancelled'); assert.equal(writes, 0);
});
