#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawn } from 'node:child_process';
import { State, ensure, lock, readJson } from './state.mjs';
import { Workers, launchAccount, setupAccount, checkedRuntime, profileEnvironment } from './runtime.mjs';
import { createGateway } from './gateway.mjs';
import { catalogFile } from './catalog.mjs';
import { openLocal } from './open-local.mjs';
import { inspectSystem } from './system.mjs';
import { PROJECT } from './runtime.mjs';
import { startCodex } from './codex.mjs';

const HELP = `chat2codex 0.2.0 — browser integration beta

npm run bootstrap                             Install pinned upstream browser bridge
node src/cli.mjs start                        Check/install runtime and open the dashboard
node src/cli.mjs serve [--port 7841]            Local API and account dashboard
node src/cli.mjs token                         Print the LOCAL management key
node src/cli.mjs account add --label "Pro A"    Create an isolated profile
node src/cli.mjs account list                  List profiles, never cookies
node src/cli.mjs account launch ACCOUNT_ID     Open that account's Electron launcher
node src/cli.mjs account setup ACCOUNT_ID --tunnel-id ID --key-file PATH
node src/cli.mjs account worker ACCOUNT_ID     Start a bridge in the foreground
node src/cli.mjs account verify ACCOUNT_ID --model chatgpt-web/high
node src/cli.mjs account enable ACCOUNT_ID
node src/cli.mjs account reset ACCOUNT_ID      Retire idle conversations; requires re-probe
node src/cli.mjs account disable ACCOUNT_ID
node src/cli.mjs doctor [--port 7841]
node src/cli.mjs codex --model chatgpt-web/high [--account ID] [-- CODEX_ARGS...]

Use CHAT2CODEX_HOME for separate storage. No ChatGPT cookies are imported/exported.
The browser launcher must complete Full MCP setup. A real MCP probe gates Ready.
The settings assistant reuses your logged-in browser; unknown controls and security prompts need user review.
`;
function options(args) {
  return parseArgs({ args, allowPositionals: true, strict: true, options: {
    port: { type: 'string', default: '7841' }, label: { type: 'string' }, model: { type: 'string' },
    account: { type: 'string' }, 'tunnel-id': { type: 'string' }, 'key-file': { type: 'string' }, 'max-threads': { type: 'string', default: '1' },
  } });
}
function wait(child) { return new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', (code, signal) => resolve(signal ? 130 : code ?? 1)); }); }
export async function main(argv = process.argv.slice(2)) {
  if (!argv.length || ['help', '--help', '-h'].includes(argv[0])) { console.log(HELP); return 0; }
  const separator = argv.indexOf('--'); const passthrough = separator < 0 ? [] : argv.slice(separator + 1);
  const { values, positionals } = options(separator < 0 ? argv : argv.slice(0, separator));
  const [command, action, id] = positionals;
  const state = new State(); const port = Number(values.port);
  ensure(Number.isInteger(port) && port >= 1 && port <= 65535, 400, 'bad_port', 'Port must be between 1 and 65535');
  const endpoint = `http://127.0.0.1:${port}`;
  const api = async (path, method = 'GET', body) => {
    const r = await fetch(`${endpoint}${path}`, { method, headers: { authorization: `Bearer ${state.token()}`, ...(body ? { 'content-type': 'application/json' } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(path.endsWith('/verify') ? 3600000 : 5000), redirect: 'error' });
    const data = await r.json(); ensure(r.ok, r.status, data.error?.code || 'api_error', data.error?.message || 'API request failed'); return data;
  };
  if (command === 'token') { console.log(state.token()); return 0; }
  if (command === 'doctor') {
    const system = inspectSystem(); let accounts;
    try { accounts = await api('/api/accounts'); } catch { accounts = { gateway: 'offline' }; }
    console.log(JSON.stringify({ system, ...accounts }, null, 2)); return 0;
  }
  if (command === 'account') {
    if (action === 'add') { console.log(JSON.stringify(state.add(values.label, Number(values['max-threads'])), null, 2)); return 0; }
    if (action === 'list') { console.log(JSON.stringify(state.list(), null, 2)); return 0; }
    state.account(id);
    if (action === 'enable' || action === 'disable') { state.enable(id, action === 'enable'); console.log(`${id}: ${action}`); return 0; }
    if (action === 'launch') return await wait(launchAccount(state, id));
    if (action === 'setup') return await wait(setupAccount(state, id, values['tunnel-id'], values['key-file']));
    if (action === 'worker') {
      const root = checkedRuntime(); const p = state.paths(id); state.token(p.token);
      return await wait(spawn(process.env.CHAT2CODEX_BUN || 'bun', ['run', join(root, '.chat2codex-worker.ts')], { cwd: root, env: profileEnvironment(state, id), stdio: 'inherit', shell: false }));
    }
    if (action === 'reset') { console.log(JSON.stringify(await api(`/api/accounts/${id}/reset`, 'POST', { confirm: true }), null, 2)); return 0; }
    if (action === 'verify') { ensure(values.model, 400, 'model_required', '--model is required'); console.log(JSON.stringify(await api(`/api/accounts/${id}/verify`, 'POST', { model: values.model }), null, 2)); return 0; }
    throw new Error('Unknown account action; run --help');
  }
  if (command === 'codex') {
    ensure(values.model, 400, 'model_required', '--model is required; the gateway never silently picks another model');
    const catalog = await api('/v1/models'); const model = catalog.data.find(m => m.id === values.model);
    ensure(model, 409, 'model_not_ready', 'The requested model has no verified Ready account');
    return await wait(startCodex({ endpoint, token: state.token(), model: values.model, account: values.account, args: passthrough,
      catalogPath: catalogFile(state.home, catalog.data), reasoning: model.default_reasoning_level, contextWindow: model.context_window, autoCompact: model.auto_compact_token_limit }));
  }
  if (command === 'serve' || command === 'start') {
    if (command === 'start') {
      try { const root = checkedRuntime(); ensure(readJson(join(root, '.chat2codex-build.json'), {}).launcher === true, 503, 'launcher_missing', 'Desktop runtime is not installed'); }
      catch {
        const system = inspectSystem();
        ensure(system.checks.filter(c => ['node', 'git', 'bun'].includes(c.name)).every(c => c.ok), 503, 'dependencies_required', 'Install Node.js 22+, Git, and Bun 1.4.0 first; run node src/cli.mjs doctor for details');
        const exit = await wait(spawn(process.execPath, [join(PROJECT, 'scripts/bootstrap.mjs')], { cwd: PROJECT, stdio: 'inherit', shell: false }));
        if (exit !== 0) return exit;
      }
    }
    const release = lock(join(state.home, 'gateway.lock'), { reclaim: true }); const workers = new Workers(state);
    const gateway = createGateway({ state, workers });
    let closed = false;
    const close = async () => { if (closed) return; closed = true; await gateway.close(); await workers.close(); release(); };
    try {
      await new Promise((resolve, reject) => { gateway.server.once('error', reject); gateway.server.listen(port, '127.0.0.1', resolve); });
      console.log(`Chat2Codex dashboard: ${endpoint}\nResponses API: ${endpoint}/v1\nUse the token command to unlock the local dashboard.`);
      workers.startEnabled();
      if (command === 'start') await openLocal(`${endpoint}/#invite=${gateway.invitations.issue()}`).catch(() => console.log('Open the displayed dashboard address and use the token command to sign in.')); 
      process.once('SIGINT', () => void close()); process.once('SIGTERM', () => void close());
    } catch (e) { await close(); throw e; }
    return 0;
  }
  throw new Error('Unknown command; run --help');
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().then(code => { if (code) process.exitCode = code; }).catch(e => { console.error(e.message); process.exitCode = 1; });
}
