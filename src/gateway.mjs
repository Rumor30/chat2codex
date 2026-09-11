import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Fault, ensure, authorized } from './state.mjs';
import { Invitations } from './invitations.mjs';
import { Jobs } from './jobs.mjs';
import { Diagnostics } from './diagnostics.mjs';
import { inspectSystem } from './system.mjs';
import { startAccountOperation } from './onboarding.mjs';
import { Router } from './routing.mjs';
import { EventObserver } from './sse.mjs';
const assets = new Map([
  ['/', ['index.html', 'text/html; charset=utf-8']], ['/app.js', ['app.js', 'text/javascript; charset=utf-8']], ['/style.css', ['style.css', 'text/css; charset=utf-8']],
].map(([url, [file, type]]) => [url, { type, bytes: readFileSync(fileURLToPath(new URL(`../public/${file}`, import.meta.url))) }]));
export async function readBody(req, limit = 32 * 1024 * 1024) {
  const chunks = []; let size = 0;
  for await (const chunk of req) { size += chunk.length; ensure(size <= limit, 413, 'body_too_large', 'Request body exceeds the size limit'); chunks.push(chunk); }
  const raw = Buffer.concat(chunks); let body;
  try { body = JSON.parse(raw.toString('utf8')); } catch { throw new Fault(400, 'invalid_json', 'Body must be valid JSON'); }
  ensure(body && typeof body === 'object' && !Array.isArray(body), 400, 'invalid_body', 'Body must be a JSON object');
  return { raw, body };
}
const modelSummary = m => ({ id: m.id, slug: m.slug, display_name: m.display_name, context_window: m.context_window, default_reasoning_level: m.default_reasoning_level });
function json(res, status, body) { res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }); res.end(JSON.stringify(body)); }
function backpressure(res, chunk) {
  if (res.destroyed) return Promise.reject(new Error('Client disconnected'));
  if (res.write(chunk)) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const clean = () => { res.off('drain', drain); res.off('close', close); res.off('error', close); };
    const drain = () => { clean(); resolve(); }; const close = () => { clean(); reject(new Error('Client disconnected')); };
    res.once('drain', drain); res.once('close', close); res.once('error', close);
  });
}
export function createGateway({ state, workers, router = new Router(state.home), token = state.token(), timeoutMs = 3600000, jobs = new Jobs(state.home), diagnostics = new Diagnostics(state.home) }) {
  const invitations = new Invitations();
  const controllers = new Map(); const maintenance = new Set();
  const server = createServer(async (req, res) => {
    res.setHeader('x-content-type-options', 'nosniff'); res.setHeader('referrer-policy', 'no-referrer');
    res.setHeader('content-security-policy', "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
    let lease; let success = false; let controller;
    try {
      const address = server.address(); const port = typeof address === 'object' ? address.port : 0;
      const origin = `http://127.0.0.1:${port}`;
      ensure(req.headers.host === `127.0.0.1:${port}` || req.headers.host === `localhost:${port}`, 403, 'bad_host', 'Loopback host required');
      ensure(!req.headers.origin || req.headers.origin === origin || req.headers.origin === `http://localhost:${port}`, 403, 'bad_origin', 'Cross-origin requests are not allowed');
      const url = new URL(req.url, origin); const path = url.pathname;
      if (req.method === 'GET' && assets.has(path)) { const a = assets.get(path); res.writeHead(200, { 'content-type': a.type, 'cache-control': 'no-store' }); res.end(a.bytes); return; }
      if (path === '/health' && req.method === 'GET') { json(res, 200, { service: 'chat2codex', version: '0.2.0' }); return; }
      if (path === '/api/session' && req.method === 'POST') {
        const { body } = await readBody(req, 1024); invitations.consume(body.ticket); json(res, 200, { key: token }); return;
      }
      ensure(authorized(req.headers.authorization, token), 401, 'unauthorized', 'A local Chat2Codex API key is required');
      if (path === '/api/system' && req.method === 'GET') { json(res, 200, inspectSystem()); return; }
      if (path === '/api/diagnostics' && req.method === 'GET') { json(res, 200, diagnostics.report()); return; }
      if (path === '/api/jobs' && req.method === 'GET') { json(res, 200, { jobs: jobs.list() }); return; }
      const jobCancel = /^\/api\/jobs\/(job_[a-f0-9]{32})\/cancel$/.exec(path);
      if (jobCancel && req.method === 'POST') { json(res, 202, jobs.cancel(jobCancel[1])); return; }
      const actionMatch = /^\/api\/accounts\/(acct_[a-f0-9]{32})\/(actions|settings)$/.exec(path);
      if (actionMatch && req.method === 'POST') {
        const { body } = await readBody(req, 16384);
        ensure(!maintenance.has(actionMatch[1]) && !jobs.active(actionMatch[1]), 409, 'account_busy', 'Account maintenance is running');
        if (actionMatch[2] === 'settings') { ensure(body.archived !== true, 409, 'archive_action_required', 'Use the account archive operation after retiring its threads'); json(res, 200, state.update(actionMatch[1], { label: body.label, maxThreads: body.maxThreads, archived: body.archived })); return; }
        const job = startAccountOperation({ state, workers, router, jobs }, actionMatch[1], body);
        diagnostics.record('account_operation_started', { accountId: actionMatch[1] }); json(res, 202, job); return;
      }
      if (path === '/api/threads/retire' && req.method === 'POST') {
        const { body } = await readBody(req, 4096); const t = router.threads.get(body.thread_id);
        ensure(t && !router.busy.has(t.id) && !t.pending.length && ['ready', 'cancelled', 'failed', 'uncertain'].includes(t.state), 409, 'thread_not_idle', 'Only settled threads may be retired');
        ensure(!maintenance.has(t.accountId) && !jobs.active(t.accountId), 409, 'account_busy', 'Account maintenance is running');
        maintenance.add(t.accountId);
        try {
          const snapshot = (await workers.snapshots()).get(t.accountId);
          // A newer process cannot own the old browser execution; do not send old IDs into it.
          if (snapshot?.online !== false && snapshot?.generation === t.generation) await workers.control(t.accountId, 'release', { thread_id: t.id });
          t.state = 'ready'; router.release(t.id); json(res, 200, { retired: true });
        } finally { maintenance.delete(t.accountId); }
        return;
      }
      if (path === '/api/accounts' && req.method === 'GET') {
        const w = await workers.snapshots();
        json(res, 200, { accounts: state.list().map(a => ({ ...a, state: w.get(a.id)?.state || 'offline', ready: !!w.get(a.id)?.ready,
          models: (w.get(a.id)?.models || []).map(modelSummary), availableModels: (w.get(a.id)?.availableModels || w.get(a.id)?.models || []).map(modelSummary), operation: jobs.active(a.id), threads: router.counts(a.id) })), threads: [...router.threads.values()].filter(t => t.state !== 'retired').map(t => ({ id: t.id, accountId: t.accountId, state: t.state, pending: t.pending.length, model: t.model })) }); return;
      }
      if (path === '/api/accounts' && req.method === 'POST') { const { body } = await readBody(req, 4096); json(res, 201, state.add(body.label, body.maxThreads ?? 1)); return; }
      const match = /^\/api\/accounts\/(acct_[a-f0-9]{32})\/(enable|disable|start|launch|verify|reset)$/.exec(path);
      if (match && req.method === 'POST') {
        ensure(!maintenance.has(match[1]) && !jobs.active(match[1]), 409, 'account_busy', 'Account maintenance is running');
        if (match[2] === 'start') { state.account(match[1]); await workers.start(match[1]); json(res, 202, { starting: true }); }
        else if (match[2] === 'launch') { state.account(match[1]); await workers.launch(match[1]); json(res, 202, { launching: true }); }
        else if (match[2] === 'verify') {
          const { body } = await readBody(req, 4096); ensure(typeof body.model === 'string', 400, 'model_required', 'A model is required for the MCP probe');
          json(res, 200, await workers.control(match[1], 'verify', body));
        } else if (match[2] === 'reset') {
          const { body } = await readBody(req, 4096); ensure(body.confirm === true, 400, 'confirmation_required', 'Confirm reset of retained account conversations');
          ensure(!maintenance.has(match[1]), 409, 'account_busy', 'Account maintenance is already in progress');
          const owned = [...router.threads.values()].filter(t => t.accountId === match[1] && t.state !== 'retired');
          ensure(owned.every(t => !router.busy.has(t.id) && t.pending.length === 0), 409, 'account_busy', 'Cancel active tools and settle results before resetting this account');
          maintenance.add(match[1]);
          try {
            const result = await workers.control(match[1], 'reset', {});
            for (const t of owned) router.threads.delete(t.id); router.save(); json(res, 200, result);
          } finally { maintenance.delete(match[1]); }
        }
        else json(res, 200, state.enable(match[1], match[2] === 'enable')); return;
      }
      if (path === '/api/cancel' && req.method === 'POST') {
        const { body } = await readBody(req, 4096); const t = router.threads.get(body.thread_id);
        ensure(t, 404, 'not_running', 'Unknown thread');
        controllers.get(t.id)?.abort();
        const result = await workers.control(t.accountId, 'cancel', { thread_id: t.id });
        t.state = 'cancelled'; t.pending = []; router.save(); json(res, 200, result); return;
      }
      if ((path === '/v1/models' || path === '/models') && req.method === 'GET') {
        const enabled = new Set(state.list().filter(a => a.enabled && !a.archived && !jobs.active(a.id) && !maintenance.has(a.id)).map(a => a.id));
        const models = new Map(); for (const [id, w] of await workers.snapshots()) if (enabled.has(id) && w.ready) for (const m of w.models) {
          const prior = models.get(m.id); models.set(m.id, prior ? { ...prior, context_window: Math.min(prior.context_window ?? Infinity, m.context_window ?? Infinity), auto_compact_token_limit: Math.min(prior.auto_compact_token_limit ?? Infinity, m.auto_compact_token_limit ?? Infinity) } : m);
        }
        const data = [...models.values()]; json(res, 200, { object: 'list', data, models: data }); return;
      }
      if (path === '/v1/responses' && req.method === 'GET') { json(res, 426, { error: { code: 'http_sse_only', message: 'Use HTTP POST and SSE, not WebSocket' } }); return; }
      ensure(req.method === 'POST' && ['/v1/responses', '/v1/responses/compact'].includes(path), 404, 'not_found', 'Endpoint not supported');
      const { raw, body } = await readBody(req);
      ensure(typeof body.model === 'string' && body.model.startsWith('chatgpt-web/'), 400, 'bad_model', 'This gateway supports genuine chatgpt-web/* routes only');
      const snapshots = new Map([...await workers.snapshots()].map(([id, worker]) => [id, (maintenance.has(id) || jobs.active(id)) ? { ...worker, ready: false } : worker]));
      lease = router.acquire(body, req.headers, snapshots, state.list());
      controller = new AbortController(); controllers.set(lease.thread.id, controller);
      const abort = () => { if (!res.writableEnded) controller.abort(); }; res.on('close', abort);
      const timer = setTimeout(() => controller.abort(), timeoutMs); timer.unref();
      try {
        const headers = { 'content-type': 'application/json', authorization: `Bearer ${lease.worker.token}`, 'x-chat2codex-thread': lease.thread.id };
        for (const [k, v] of Object.entries(req.headers)) if (typeof v === 'string' && (k.startsWith('x-codex-') || ['session_id', 'originator', 'version'].includes(k))) headers[k] = v;
        const upstream = await fetch(`${lease.worker.endpoint}${path}`, { method: 'POST', body: raw, headers, signal: controller.signal, redirect: 'error' });
        const type = upstream.headers.get('content-type') || '';
        ensure(type.includes('application/json') || type.includes('text/event-stream'), 502, 'bad_upstream', 'Worker returned a non-Responses content type');
        res.setHeader('x-chat2codex-thread', lease.thread.id); res.setHeader('cache-control', 'no-store');
        if (upstream.headers.has('retry-after')) res.setHeader('retry-after', upstream.headers.get('retry-after'));
        if (type.includes('text/event-stream') && upstream.ok) {
          res.writeHead(upstream.status, { 'content-type': type, 'x-accel-buffering': 'no' });
          const observer = new EventObserver(event => router.observe(lease, event));
          for await (const chunk of upstream.body) { observer.push(chunk); await backpressure(res, chunk); }
          observer.end(); ensure(lease.terminal, 502, 'missing_terminal', 'Worker stream closed without a terminal Responses event');
          success = true; res.end();
        } else {
          const chunks = []; let size = 0;
          for await (const chunk of upstream.body) { size += chunk.length; ensure(size <= 32 * 1024 * 1024, 502, 'response_too_large', 'Worker JSON response exceeds limit'); chunks.push(chunk); }
          const bytes = Buffer.concat(chunks); let response;
          try { response = JSON.parse(bytes.toString('utf8')); } catch { throw new Fault(502, 'invalid_response', 'Worker returned invalid JSON'); }
          if (upstream.ok && path.endsWith('/compact')) {
            ensure(Array.isArray(response.output), 502, 'invalid_compaction', 'Compaction returned no replacement history');
            lease.thread.pending = []; lease.thread.state = 'ready'; lease.terminal = true;
          } else if (upstream.ok) router.observe(lease, { type: 'json', response });
          success = upstream.ok && !!lease.terminal;
          res.writeHead(upstream.status, { 'content-type': type }); res.end(bytes);
        }
      } finally { clearTimeout(timer); res.off('close', abort); controllers.delete(lease.thread.id); }
    } catch (error) {
      const fault = error instanceof Fault ? error : new Fault(502, 'bridge_unavailable', 'Bridge interrupted or unavailable; the task was not replayed');
      try { diagnostics.record('request_failed', { code: fault.code, status: fault.status, accountId: lease?.thread.accountId }); } catch { /* Preserve the original error even when the disk is full. */ }
      if (!res.headersSent) json(res, fault.status, { error: { type: 'chat2codex_error', code: fault.code, message: fault.message } });
      else if (!res.destroyed) res.end(`event: error\ndata: ${JSON.stringify({ type: 'error', error: { code: fault.code, message: fault.message } })}\n\n`);
    } finally { if (lease) {
      controller?.abort(); router.finish(lease, success);
      if (!success && workers.control) { try { await workers.control(lease.thread.accountId, 'cancel', { thread_id: lease.thread.id }); } catch { /* Remains uncertain; never replay. */ } }
    } }
  });
  server.requestTimeout = 60000; server.headersTimeout = 15000;
  server.on('upgrade', (_req, socket) => { socket.end('HTTP/1.1 426 Upgrade Required\r\nConnection: close\r\nContent-Length: 0\r\n\r\n'); });
  return { server, router, jobs, diagnostics, invitations, async close() { await jobs.close(); for (const c of controllers.values()) c.abort(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); } };
}
