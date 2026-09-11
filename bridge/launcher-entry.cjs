// Runs the pinned launcher unchanged, extending only its authenticated control channel.
const { createHash, randomBytes, timingSafeEqual } = require('node:crypto');
const { readFileSync, writeFileSync, renameSync, existsSync } = require('node:fs');
const path = require('node:path');
const { app, BrowserWindow, session } = require('electron');
const { BrowserControlServer } = require('./electron/control-server.cjs');
const { settingsStep, Provisioner } = require('./.chat2codex-provision.cjs');
const accountId = process.env.CHAT2CODEX_ACCOUNT_ID;
const home = process.env.CHAT2CODEX_ACCOUNT_HOME;
if (!/^acct_[a-f0-9]{32}$/.test(accountId || '') || !home) throw new Error('Account-scoped launcher required');
const salt = randomBytes(32); const handles = new WeakMap();
const original = BrowserControlServer.prototype.handle;
function result(response, status, body) { response.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' }); response.end(JSON.stringify(body)); }
BrowserControlServer.prototype.handle = async function (req, res) {
  if (!req.url.startsWith('/v1/chat2codex/')) return original.call(this, req, res);
  const supplied = Buffer.from(req.headers.authorization || ''); const wanted = Buffer.from(`Bearer ${this.token}`);
  if (supplied.length !== wanted.length || !timingSafeEqual(supplied, wanted)) return result(res, 401, { code: 'unauthorized' });
  if (req.method !== 'POST' || req.headers.origin) return result(res, 403, { code: 'local_control_only' });
  const host = this.getBrowserHost();
  if (!host || host.profile !== 'development') return result(res, 409, { code: 'isolated_launcher_required' });
  const ses = session.fromPartition(host.partition);
  const controller = new AbortController();
  const cancel = () => { if (!res.writableEnded) controller.abort(); };
  res.once('close', cancel); req.once('aborted', cancel);
  try {
    if (req.url === '/v1/chat2codex/quit') { result(res, 200, { code: 'launcher_stopping' }); setImmediate(() => app.quit()); return; }
    if (req.url === '/v1/chat2codex/identity') {
      // Existing upstream read-only session endpoint; no credential fields leave Electron.
      const response = await ses.fetch('https://chatgpt.com/api/auth/session', { signal: AbortSignal.timeout(5000), redirect: 'error', credentials: 'include' });
      if (!response.ok || !response.headers.get('content-type')?.includes('application/json')) return result(res, 200, { authenticated: false });
      const data = await response.json();
      if (typeof data.user?.id !== 'string' || !data.user.id) return result(res, 200, { authenticated: false });
      const identity = createHash('sha256').update(salt).update(JSON.stringify([data.user.id, data.account?.id || null])).digest('hex');
      return result(res, 200, { accountId, authenticated: true, identity });
    }
    if (!['/v1/chat2codex/open-settings', '/v1/chat2codex/assist'].includes(req.url)) return result(res, 404, { code: 'not_found' });
    let raw = ''; for await (const chunk of req) { raw += chunk; if (raw.length > 16384) return result(res, 413, { code: 'body_too_large' }); }
    const body = JSON.parse(raw || '{}');
    let current = handles.get(host);
    if (!current || current.window.isDestroyed()) {
      const window = new BrowserWindow({ width: 1060, height: 800, title: 'Chat2Codex · MCP setup', webPreferences: { partition: host.partition, contextIsolation: true, sandbox: true, nodeIntegration: false } });
      window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
      window.webContents.on('will-navigate', (event, url) => { try { if (new URL(url).origin !== 'https://chatgpt.com') event.preventDefault(); } catch { event.preventDefault(); } });
      const journal = path.join(home, 'connector-provision.json');
      const provisioner = new Provisioner({
        load: () => existsSync(journal) ? JSON.parse(readFileSync(journal, 'utf8')) : undefined,
        save: data => { writeFileSync(`${journal}.tmp`, JSON.stringify(data), { mode: 0o600 }); renameSync(`${journal}.tmp`, journal); },
        evaluate: (target, action) => window.webContents.executeJavaScript(`(${settingsStep.toString()})(${JSON.stringify(target)},${JSON.stringify(action)})`),
      });
      current = { window, provisioner }; handles.set(host, current);
      await window.loadURL('https://chatgpt.com/#settings/Plugins');
    }
    current.window.show(); current.window.focus();
    if (req.url.endsWith('/open-settings')) return result(res, 200, { code: 'settings_opened' });
    if (body.consent !== true) return result(res, 400, { code: 'setup_consent_required' });
    const outcome = await current.provisioner.assist({ name: 'Codex Native2 DEV', tunnelId: body.tunnelId }, controller.signal);
    return result(res, 200, outcome);
  } catch { if (!res.destroyed) return result(res, 502, { code: 'settings_bridge_failed' }); }
  finally { res.off('close', cancel); req.off('aborted', cancel); }
};
const profile = require('./electron/profile.cjs');
const originalProfile = profile.resolveLauncherProfile;
profile.resolveLauncherProfile = function (...args) { const p = originalProfile(...args); return { ...p, displayName: `Chat2Codex · ${(process.env.CHAT2CODEX_ACCOUNT_LABEL || 'Account').slice(0, 100)}` }; };
require('./electron/main.cjs');
