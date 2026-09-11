/** Copied beside the pinned upstream src/ by bootstrap. Never use DevChatDriver's simulated executor. */
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { readFileSync, mkdirSync, writeFileSync, renameSync, unlinkSync, openSync, closeSync } from 'node:fs';
import { join } from 'node:path';
import { loadConfig } from './src/config';
import { activateDevProfileEnvironment } from './src/dev-chat/profile';
import { createLauncherDevAdapter } from './src/dev-chat/driver';
import { TurnBroker } from './src/adapters/chatgpt-web/turn-broker';
import { chatGptTurnSessions } from './src/adapters/chatgpt-web/turn-execution';
import { closeChatGptBrowserWorkers } from './src/adapters/chatgpt-web/browser-worker';
import { availableChatGptWebModelRoutes, resolveChatGptWebContextLimits } from './src/chatgpt-web-models';
import { inspectLauncherBrowserHost } from './src/launcher-browser-host';
import { responseRequest, compactRequest } from './src/server';
import { tunnelStatus } from './src/tunnel';

const home = process.env.CHAT2CODEX_ACCOUNT_HOME;
const accountId = process.env.CHAT2CODEX_ACCOUNT_ID;
const keyPath = process.env.CHAT2CODEX_WORKER_KEY_FILE;
if (!home || !accountId || !keyPath) throw new Error('Worker must be started by chat2codex');
const key = readFileSync(keyPath, 'utf8').trim();
if (!/^[A-Za-z0-9_-]{43}$/.test(key)) throw new Error('Invalid worker key');
const paths = activateDevProfileEnvironment();
let generation = randomBytes(16).toString('hex');
let verifiedConfig = ''; let verifying = false; let used = false;
let broker: TurnBroker | undefined;
const turns = new Map<string, { threadId: string; turnId: string }>();
mkdirSync(home, { recursive: true, mode: 0o700 });
const ownerLock = join(home, 'worker.lock');
const ownerFd = openSync(ownerLock, 'wx', 0o600);
writeFileSync(ownerFd, String(process.pid));
function auth(req: Request) {
  const a = Buffer.from(req.headers.get('authorization') || ''); const b = Buffer.from(`Bearer ${key}`);
  return a.length === b.length && timingSafeEqual(a, b);
}
function fingerprint() { return createHash('sha256').update(readFileSync(paths.configPath)).digest('hex'); }
async function runtime() {
  const config = loadConfig();
  if (config.purpose !== 'dev-harness' || config.mode !== 'full' || !config.tunnel || !config.browserHostDescriptorPath)
    throw new Error('setup_required');
  if (config.browserInteractionMode !== 'automatic') throw new Error('automatic_profile_required');
  const tunnel = tunnelStatus(config);
  if (!tunnel.ok || !tunnel.ready) throw new Error('tunnel_unavailable');
  await inspectLauncherBrowserHost(config.browserHostDescriptorPath, { expectedProfile: 'development' });
  if (!broker) { broker = TurnBroker.forSocket(config.brokerSocketPath); await broker.listen(); }
  const factory = createLauncherDevAdapter(config, join(home!, 'state'), { broker, browserHelperScriptPath: join(import.meta.dir, '.chat2codex-browser-helper.cjs') }).adapterFactory;
  return { config, factory };
}
async function status() {
  try {
    const { config } = await runtime();
    const models = availableChatGptWebModelRoutes(config).map(route => {
      const limits = resolveChatGptWebContextLimits(route.backendModel, route.adapterEffort, config);
      return { id: route.slug, slug: route.slug, object: 'model', owned_by: 'chat2codex', display_name: route.displayName,
        context_window: limits.contextWindow, auto_compact_token_limit: limits.autoCompactTokenLimit,
        default_reasoning_level: route.codexEffort, supported_reasoning_levels: [{ effort: route.codexEffort, description: route.displayName }] };
    });
    const ready = verifiedConfig === fingerprint();
    return { accountId, generation, ready, state: ready ? 'ready' : 'needs_mcp_probe', models };
  } catch (e) {
    const allowed = ['setup_required', 'automatic_profile_required', 'tunnel_unavailable'];
    const state = e instanceof Error && allowed.includes(e.message) ? e.message : 'launcher_unavailable';
    return { accountId, generation, ready: false, state, models: [] };
  }
}
function nativeIdentity(body: any): { threadId: string; turnId: string } | undefined {
  let m = body.client_metadata?.['x-codex-turn-metadata'];
  if (typeof m === 'string') { try { m = JSON.parse(m); } catch { return; } }
  if (typeof m?.thread_id === 'string' && typeof m?.turn_id === 'string') return { threadId: m.thread_id, turnId: m.turn_id };
}
async function cancel(id: string) {
  const identity = turns.get(id); if (!identity) return { cancelled: 0 };
  const result = chatGptTurnSessions.cancelNativeTurn(identity.threadId, identity.turnId, new Error('Chat2Codex user cancelled the task'));
  await result.settlement; turns.delete(id); return { cancelled: result.cancelled };
}
/** A real harmless MCP -> Responses -> result -> ChatGPT probe, not a fabricated shell receipt. */
async function probe(model: string) {
  if (verifying || used) throw new Error('Probe is allowed only before this worker serves user tasks; restart it to verify again');
  verifying = true; verifiedConfig = '';
  const { config, factory } = await runtime();
  const expectedConfig = fingerprint(); let succeeded = false;
  const nonce = randomBytes(16).toString('hex'); const threadId = crypto.randomUUID(); const turnId = crypto.randomUUID();
  const itemMeta = { turn_id: turnId };
  const escaped = home!.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
  const input: any[] = [
    { type: 'message', id: `msg_env_${nonce}`, role: 'user', content: [{ type: 'input_text', text: `<environment_context><cwd>${escaped}</cwd><filesystem><workspace_roots><root>${escaped}</root></workspace_roots><permission_profile type="disabled"><file_system type="unrestricted" /></permission_profile></filesystem></environment_context>` }], internal_chat_message_metadata_passthrough: itemMeta },
    { type: 'message', id: `msg_probe_${nonce}`, role: 'user', content: [{ type: 'input_text', text: `Transport verification only. Discover chat2codex_probe with the attached connector, call it with nonce ${nonce}, then reply with exactly the nonce returned by the tool. Do not use other tools.` }], internal_chat_message_metadata_passthrough: itemMeta },
  ];
  let echoed = false;
  try {
    for (let round = 0; round < 8; round++) {
      const body = { model, stream: false, store: false, input, prompt_cache_key: threadId,
        tools: [{ type: 'function', name: 'chat2codex_probe', description: 'Echo a verification nonce. No filesystem, command, or external side effects.', parameters: { type: 'object', properties: { nonce: { type: 'string', const: nonce } }, required: ['nonce'], additionalProperties: false } }],
        client_metadata: { 'x-codex-turn-metadata': JSON.stringify({ thread_id: threadId, turn_id: turnId, request_kind: 'turn', sandbox: 'none', workspaces: { [home!]: {} } }) } };
      const response = await responseRequest(new Request('http://127.0.0.1/v1/responses', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }), config, factory, { rememberState: false });
      const r: any = await response.json();
      if (!response.ok || r.status !== 'completed' || !Array.isArray(r.output)) throw new Error('MCP probe returned an unsuccessful Responses result');
      input.push(...r.output.map((i: any) => ({ ...i, internal_chat_message_metadata_passthrough: itemMeta })));
      const calls = r.output.filter((i: any) => ['function_call', 'custom_tool_call', 'tool_search_call'].includes(i.type));
      if (!calls.length) {
        const text = r.output.filter((i: any) => i.type === 'message' && i.phase !== 'commentary').flatMap((i: any) => i.content || []).map((b: any) => b.text || '').join('').trim();
        if (!echoed || text !== nonce) throw new Error('Probe did not prove both tool dispatch and result delivery');
        if (fingerprint() !== expectedConfig) throw new Error('Configuration changed during verification');
        succeeded = true; return { verified: true, model };
      }
      for (const call of calls) {
        if (call.type !== 'function_call' || call.name !== 'chat2codex_probe' || JSON.parse(call.arguments).nonce !== nonce)
          throw new Error('Probe attempted an unapproved tool');
        echoed = true;
        input.push({ type: 'function_call_output', call_id: call.call_id, output: nonce, internal_chat_message_metadata_passthrough: itemMeta });
      }
    }
    throw new Error('Probe exceeded the round limit');
  } finally {
    verifying = false;
    const end = chatGptTurnSessions.cancelNativeTurn(threadId, turnId, new Error('Verification finished'));
    try { await end.settlement; await closeChatGptBrowserWorkers(); }
    catch (error) { succeeded = false; throw error; }
    finally { verifiedConfig = succeeded ? expectedConfig : ''; }
  }
}
const server = Bun.serve({
  hostname: '127.0.0.1', port: 0, idleTimeout: 0, maxRequestBodySize: 32 * 1024 * 1024,
  async fetch(req) {
    if (!auth(req)) return Response.json({ error: { code: 'unauthorized' } }, { status: 401 });
    const path = new URL(req.url).pathname;
    try {
      if (path === '/health' && req.method === 'GET') return Response.json(await status());
      if (path === '/control/verify' && req.method === 'POST') {
        const body = await req.json();
        try { return Response.json(await probe(body.model)); } finally { verifying = false; }
      }
      if (path === '/control/reset' && req.method === 'POST') {
        if (verifying || chatGptTurnSessions.activeCount()) return Response.json({ error: { code: 'account_busy' } }, { status: 409 });
        for (const id of [...turns.keys()]) await cancel(id);
        chatGptTurnSessions.clear(); await closeChatGptBrowserWorkers();
        verifiedConfig = ''; used = false; generation = randomBytes(16).toString('hex'); saveDescriptor();
        return Response.json({ reset: true, generation, needsProbe: true });
      }
      if (path === '/control/cancel' && req.method === 'POST') return Response.json(await cancel((await req.json()).thread_id));
      if (req.method !== 'POST' || !['/v1/responses', '/v1/responses/compact'].includes(path)) return Response.json({ error: { code: 'not_found' } }, { status: 404 });
      if (!(await status()).ready || verifying) return Response.json({ error: { code: 'mcp_not_verified', message: 'Complete the real MCP probe before sending tasks' } }, { status: 503 });
      const body = await req.clone().json(); const identity = nativeIdentity(body); const id = req.headers.get('x-chat2codex-thread');
      if (!identity || !id) return Response.json({ error: { code: 'native_metadata_required', message: 'This adapter requires native Codex thread/turn metadata; arbitrary Responses clients are not yet supported' } }, { status: 400 });
      turns.set(id, identity); used = true;
      const { config, factory } = await runtime();
      return path.endsWith('/compact') ? compactRequest(req, config, factory) : responseRequest(req, config, factory);
    } catch {
      return Response.json({ error: { code: 'web_bridge_error', message: 'Browser/MCP bridge failed. Check the isolated launcher, tunnel, and account permissions; no fallback model was used.' } }, { status: 502 });
    }
  },
});
const descriptor = join(home, 'worker.json');
function saveDescriptor() {
writeFileSync(`${descriptor}.tmp`, JSON.stringify({ accountId, generation, endpoint: `http://127.0.0.1:${server.port}`, pid: process.pid }), { mode: 0o600 });
renameSync(`${descriptor}.tmp`, descriptor);
}
saveDescriptor();
let stopping = false;
async function stop() {
  if (stopping) return; stopping = true;
  server.stop(true); chatGptTurnSessions.clear(); await broker?.close(); await closeChatGptBrowserWorkers();
  try { unlinkSync(descriptor); } catch { /* Already removed. */ }
  closeSync(ownerFd); try { unlinkSync(ownerLock); } catch { /* Already removed. */ }
  process.exit(0);
}
process.on('SIGTERM', () => void stop()); process.on('SIGINT', () => void stop());
