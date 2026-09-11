import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { RetiredThreads } from '../src/retired.mjs';
import { Router } from '../src/routing.mjs';
function home(t) { const p = mkdtempSync(join(tmpdir(), 'c2c-retire-')); t.after(() => rmSync(p, { recursive: true, force: true })); return p; }
test('retirement journal persists a hash without the original thread identity', t => {
  const root = home(t); const retired = new RetiredThreads(root); retired.add('private-thread-label'); retired.add('private-thread-label');
  assert.equal(readFileSync(retired.file, 'utf8').length, 65); assert(!readFileSync(retired.file, 'utf8').includes('private-thread-label'));
  assert(new RetiredThreads(root).has('private-thread-label'));
});
test('a torn retirement write fails closed instead of forgetting a replay fence', t => {
  const root = home(t); writeFileSync(join(root, 'retired-threads.log'), 'a'.repeat(40));
  assert.throws(() => new RetiredThreads(root), e => e.code === 'invalid_retirement_log');
});
test('legacy retired routes migrate out of active storage and keep replay protection', t => {
  const root = home(t); writeFileSync(join(root, 'routes.json'), JSON.stringify({ version: 1, threads: [{ id: 'legacy', accountId: 'a', generation: 'g', model: 'chatgpt-web/high', state: 'retired', pending: [], responses: [] }] }));
  const router = new Router(root); assert.equal(router.threads.size, 0); assert(router.retired.has('legacy'));
  assert.throws(() => router.acquire({ model: 'chatgpt-web/high', prompt_cache_key: 'legacy' }, {}, new Map(), []), e => e.code === 'thread_retired');
});
test('more than 1000 completed retirements do not exhaust active route capacity', t => {
  const root = home(t); const router = new Router(root);
  for (let i = 0; i < 1001; i++) router.retired.add(`finished-${i}`);
  const worker = { ready: true, generation: 'g', models: [{ id: 'chatgpt-web/high' }] };
  const lease = router.acquire({ model: 'chatgpt-web/high', prompt_cache_key: 'new-work' }, {}, new Map([['a', worker]]), [{ id: 'a', enabled: true, maxThreads: 1 }]);
  assert.equal(lease.thread.accountId, 'a'); router.finish(lease, false);
});
