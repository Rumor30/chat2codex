import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { runPrivate, processFailure, terminateOwnedChild } from './process.mjs';
import { readFileSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ensure, readJson, loopbackEndpoint, recoverLock } from './state.mjs';

export const PROJECT = resolve(fileURLToPath(new URL('..', import.meta.url)));
export const UPSTREAM = 'e85e3693fdb4e3e033348c08df0298c20fcdb612';
export const runtimePath = () => join(PROJECT, '.runtime', UPSTREAM);
export function profileEnvironment(state, id, env = process.env) {
  const paths = state.paths(id); const clean = { ...env };
  for (const k of ['CODEX_CHATGPT_WEB_HOME', 'CODEX_HOME', 'CODEX_WEB_GPT_LAUNCHER_DATA_DIR', 'CODEX_WEB_GPT_DEV_HOME', 'ELECTRON_RUN_AS_NODE', 'CHAT2CODEX_API_KEY']) delete clean[k];
  clean.CODEX_WEB_GPT_BUN = env.CHAT2CODEX_BUN || 'bun';
  clean.CODEX_CHATGPT_WEB_BUN = clean.CODEX_WEB_GPT_BUN;
  clean.CODEX_WEB_GPT_DEV_HOME = paths.profile;
  clean.CHAT2CODEX_ACCOUNT_HOME = paths.home;
  clean.CHAT2CODEX_ACCOUNT_ID = id;
  clean.CHAT2CODEX_ACCOUNT_LABEL = state.account(id).label;
  clean.CHAT2CODEX_WORKER_KEY_FILE = paths.token;
  return clean;
}
export function checkedRuntime() {
  const root = runtimePath();
  const manifest = readJson(join(root, '.chat2codex-build.json'), {});
  ensure(manifest.commit === UPSTREAM && manifest.bridgeVersion === 3, 503, 'runtime_missing', 'Run npm run bootstrap to install the pinned browser bridge');
  return root;
}
export class Workers {
  constructor(state) { this.state = state; this.children = new Map(); this.launchers = new Map(); this.cache = new Map(); this.probes = new Map(); this.starting = new Map(); this.failures = new Map(); }
  async probe(id, force = false) {
    if (this.probes.has(id)) return this.probes.get(id);
    const cached = this.cache.get(id);
    if (!force && cached && Date.now() - cached.checkedAt < 1500) return cached;
    const work = this.inspect(id).finally(() => this.probes.delete(id)); this.probes.set(id, work); return work;
  }
  async inspect(id) {
    const p = this.state.paths(id); let snapshot;
    try {
      const d = readJson(p.descriptor, {});
      ensure(d.accountId === id && d.generation && d.endpoint, 503, 'worker_offline', 'Worker is offline');
      const endpoint = loopbackEndpoint(d.endpoint);
      ensure(existsSync(p.token), 503, 'worker_offline', 'Worker key is missing');
      const token = readFileSync(p.token, 'utf8').trim();
      const r = await fetch(`${endpoint}/health`, { headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(12000), redirect: 'error' });
      const h = await r.json();
      ensure(r.ok && h.accountId === id && h.generation === d.generation && Array.isArray(h.models), 503, 'worker_identity', 'Worker identity did not match');
      snapshot = { ...h, ...(!h.ready && h.state === 'launcher_unavailable' && this.failures.has(id) ? { state: this.failures.get(id) } : {}), online: true, endpoint, token, checkedAt: Date.now() };
    } catch {
      snapshot = { accountId: id, ready: false, models: [], state: this.failures.get(id) || 'worker_offline', checkedAt: Date.now() };
    }
    this.cache.set(id, snapshot); return snapshot;
  }
  async snapshots() { const pairs = await Promise.all(this.state.list().map(async a => [a.id, await this.probe(a.id)])); return new Map(pairs); }
  async start(id) {
    if (this.children.has(id)) return;
    if (this.starting.has(id)) return this.starting.get(id);
    const starting = (async () => {
      if ((await this.probe(id, true)).online) return;
      const root = checkedRuntime(); const p = this.state.paths(id); this.state.token(p.token); recoverLock(join(p.home, 'worker.lock'));
      const child = spawn(process.env.CHAT2CODEX_BUN || 'bun', ['run', join(root, '.chat2codex-worker.ts')], {
        cwd: root, env: profileEnvironment(this.state, id), stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, shell: false,
      });
      this.children.set(id, child); this.failures.delete(id);
      let tail = '';
      for (const stream of [child.stdout, child.stderr]) stream.on('data', chunk => { tail = (tail + chunk).slice(-8192); });
      child.once('close', code => { if (code) this.failures.set(id, processFailure(tail)); tail = ''; });
      const forget = () => { if (this.children.get(id) === child) this.children.delete(id); this.cache.delete(id); };
      child.on('error', () => { this.failures.set(id, 'dependency_missing'); forget(); }); child.on('exit', forget);
      await new Promise((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject); });
    })().finally(() => this.starting.delete(id));
    this.starting.set(id, starting); return starting;
  }
  launch(id) {
    this.state.account(id);
    if (this.launchers.has(id)) return;
    const child = launchAccount(this.state, id, { stdio: ['ignore', 'pipe', 'pipe'] }); this.launchers.set(id, child); this.failures.delete(id);
    let tail = '';
    for (const stream of [child.stdout, child.stderr]) stream.on('data', bytes => { tail = (tail + bytes.toString()).slice(-8192); });
    child.once('close', code => { if (code !== 0) this.failures.set(id, processFailure(tail)); tail = ''; this.cache.delete(id); });
    const forget = () => { if (this.launchers.get(id) === child) this.launchers.delete(id); };
    child.once('error', () => { this.failures.set(id, 'launcher_start_failed'); forget(); }); child.once('exit', forget);
    return new Promise((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject); });
  }
  startEnabled() { for (const a of this.state.list()) if (a.enabled) this.start(a.id).catch(() => {}); }
  async control(id, action, body, signal) {
    ensure(['verify', 'cancel', 'reset', 'release'].includes(action), 400, 'bad_action', 'Unsupported worker action');
    const w = await this.probe(id, true); ensure(w.online, 503, 'worker_offline', 'Start the account worker first');
    const r = await fetch(`${w.endpoint}/control/${action}`, { method: 'POST', redirect: 'error',
      headers: { authorization: `Bearer ${w.token}`, 'content-type': 'application/json' }, body: JSON.stringify(body),
      signal: AbortSignal.any([...(signal ? [signal] : []), AbortSignal.timeout(action === 'verify' ? 3600000 : 15000)]) });
    const result = await r.json(); this.cache.delete(id);
    ensure(r.ok, r.status, result.error?.code || 'worker_error', result.error?.message || 'Worker control failed');
    return result;
  }
  async stop(id) {
    const child = this.children.get(id);
    ensure(child, 409, 'worker_not_owned', 'Restart only workers started by this gateway');
    await terminateOwnedChild(child); this.children.delete(id); this.cache.delete(id);
  }
  async configure(id, { tunnelId, runtimeKey, consent }, signal) {
    ensure(consent === true, 400, 'setup_consent_required', 'Confirm use of this account and Tunnel');
    ensure(/^tunnel_[a-f0-9]{32}$/.test(tunnelId || '') && typeof runtimeKey === 'string' && runtimeKey.trim().length >= 20 && runtimeKey.length < 8192,
      400, 'invalid_tunnel_credentials', 'A Tunnel ID and runtime key are required');
    const root = checkedRuntime();
    const current = await this.probe(id, true);
    if (current.online) { ensure(this.children.has(id), 409, 'stop_external_worker_required', 'Stop the manually started worker before reconfiguring this account'); await this.stop(id); }
    await runPrivate(process.env.CHAT2CODEX_BUN || 'bun', ['run', join(root, '.chat2codex-setup.ts')], {
      cwd: root, env: profileEnvironment(this.state, id), signal, timeoutMs: 180000,
      input: JSON.stringify({ tunnelId, runtimeKey: runtimeKey.trim(), consent: true }),
    });
    if (signal?.aborted) throw Object.assign(new Error('Operation cancelled'), { code: 'operation_cancelled' });
    await this.start(id);
    return { code: 'tunnel_configured_connector_required' };
  }
  async launcherControl(id, action, body = {}, signal) {
    ensure(['identity', 'import-session', 'open-settings', 'assist', 'quit'].includes(action), 400, 'bad_action', 'Unsupported launcher action');
    const paths = this.state.paths(id);
    const d = readJson(join(paths.profile, 'runtime', 'launcher-browser.json'), {});
    ensure(d.kind === 'codex-web-gpt-launcher' && d.profile === 'development' && typeof d.control?.token === 'string', 503, 'launcher_login_required', 'Open the account login window first');
    const endpoint = loopbackEndpoint(d.control.endpoint);
    const response = await fetch(`${endpoint}/v1/chat2codex/${action}`, { method: 'POST', redirect: 'error', signal: AbortSignal.any([...(signal ? [signal] : []), AbortSignal.timeout(action === 'import-session' ? 45000 : 30000)]),
      headers: { authorization: `Bearer ${d.control.token}`, 'content-type': 'application/json' }, body: JSON.stringify(body) });
    const result = await response.json();
    ensure(response.ok, response.status, /^[a-z0-9_]{1,80}$/.test(result.code || '') ? result.code : 'launcher_action_failed', 'Launcher operation did not complete');
    return result;
  }
  async assist(id, consent, signal) {
    ensure(consent === true, 400, 'setup_consent_required', 'Confirm automatic Connector setup');
    const config = readJson(join(this.state.paths(id).profile, 'config.json'), {});
    ensure(config.tunnel?.tunnelId, 409, 'tunnel_setup_required', 'Configure the account Tunnel before preparing its Connector');
    return this.launcherControl(id, 'assist', { tunnelId: config.tunnel.tunnelId, consent: true }, signal);
  }
  async close() {
    const launchers = [...this.launchers.entries()];
    await Promise.all(launchers.map(([id]) => this.launcherControl(id, 'quit', {}, AbortSignal.timeout(5000)).catch(() => {})));
    const owned = [...new Set([...launchers.map(([, child]) => child), ...this.children.values()])];
    const outcomes = await Promise.allSettled(owned.map(child => terminateOwnedChild(child)));
    this.children.clear(); this.launchers.clear();
    const failed = outcomes.find(outcome => outcome.status === 'rejected');
    if (failed) throw failed.reason;
  }
}
/** The pinned Electron launcher owns login and tunnel lifecycle in an isolated DEV profile. */
export function launchAccount(state, id, { stdio = 'ignore' } = {}) {
  const root = checkedRuntime();
  ensure(readJson(join(root, '.chat2codex-build.json'), {}).launcher === true, 503, 'launcher_missing', 'Run npm run bootstrap without --core-only to install the desktop launcher');
  const require = createRequire(join(root, 'launcher', 'package.json'));
  const electron = require('electron');
  return spawn(electron, [join(root, 'launcher', '.chat2codex-launcher.cjs'), '--dev-profile'], {
    cwd: root, env: profileEnvironment(state, id), stdio, shell: false,
  });
}
export function setupAccount(state, id, tunnelId, keyFile) {
  ensure(/^tunnel_[A-Za-z0-9_-]+$/.test(tunnelId || ''), 400, 'bad_tunnel', 'A real Tunnel ID is required');
  ensure(typeof keyFile === 'string' && existsSync(resolve(keyFile)), 400, 'key_file_missing', 'A runtime key file is required; do not pass a secret on the command line');
  const root = checkedRuntime();
  return spawn(process.env.CHAT2CODEX_BUN || 'bun', ['run', 'src/cli.ts', 'dev', 'setup', '--full', '--tunnel-id', tunnelId,
    '--runtime-key-file', resolve(keyFile), '--automatic-browser-interaction'], {
    cwd: root, env: profileEnvironment(state, id), stdio: 'inherit', shell: false,
  });
}