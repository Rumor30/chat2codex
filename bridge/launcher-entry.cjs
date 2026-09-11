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
const SESSION_COOKIE_BASES = ['__Secure-next-auth.session-token', '__Secure-authjs.session-token'];
const SESSION_CHUNK_SIZE = 3800;
const original = BrowserControlServer.prototype.handle;
function result(response, status, body) { response.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' }); response.end(JSON.stringify(body)); }
async function readBody(req, limit = 16384) {
  const chunks = []; let size = 0;
  for await (const chunk of req) { size += chunk.length; if (size > limit) throw Object.assign(new Error('body_too_large'), { code: 'body_too_large' }); chunks.push(chunk); }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'); }
  catch { throw Object.assign(new Error('invalid_json'), { code: 'invalid_json' }); }
}
async function sessionIdentity(ses, signal) {
  const response = await ses.fetch('https://chatgpt.com/api/auth/session', { signal: AbortSignal.any([signal, AbortSignal.timeout(8000)]), redirect: 'error', credentials: 'include', cache: 'no-store' });
  if (!response.ok || !response.headers.get('content-type')?.includes('application/json')) return { authenticated: false };
  const data = await response.json();
  if (typeof data.user?.id !== 'string' || !data.user.id) return { authenticated: false };
  const identity = createHash('sha256').update(salt).update(JSON.stringify([data.user.id, data.account?.id || null])).digest('hex');
  return { accountId, authenticated: true, identity };
}
const isSessionCookie = name => SESSION_COOKIE_BASES.some(base => name === base || name.startsWith(`${base}.`));
const cookieUrl = cookie => `https://${String(cookie.domain || 'chatgpt.com').replace(/^\./, '')}${cookie.path || '/'}`;
async function clearSessionCookies(ses) {
  for (const cookie of await ses.cookies.get({ url: 'https://chatgpt.com/' })) if (isSessionCookie(cookie.name)) await ses.cookies.remove(cookieUrl(cookie), cookie.name);
  await ses.cookies.flushStore?.();
}
async function restoreCookies(ses, cookies) {
  await clearSessionCookies(ses);
  for (const cookie of cookies) {
    const restored = { url: cookieUrl(cookie), name: cookie.name, value: cookie.value, path: cookie.path || '/', secure: cookie.secure !== false, httpOnly: cookie.httpOnly === true };
    if (cookie.domain) restored.domain = cookie.domain;
    if (cookie.sameSite && cookie.sameSite !== 'unspecified') restored.sameSite = cookie.sameSite;
    if (Number.isFinite(cookie.expirationDate) && cookie.expirationDate > Date.now() / 1000) restored.expirationDate = cookie.expirationDate;
    await ses.cookies.set(restored);
  }
  await ses.cookies.flushStore?.();
}
async function installSessionFamily(ses, base, token) {
  await clearSessionCookies(ses);
  const parts = token.length <= SESSION_CHUNK_SIZE ? [token] : Array.from({ length: Math.ceil(token.length / SESSION_CHUNK_SIZE) }, (_, index) => token.slice(index * SESSION_CHUNK_SIZE, (index + 1) * SESSION_CHUNK_SIZE));
  for (let index = 0; index < parts.length; index++) await ses.cookies.set({
    url: 'https://chatgpt.com/', name: parts.length === 1 ? base : `${base}.${index}`, value: parts[index], path: '/', secure: true, httpOnly: true, sameSite: 'lax',
  });
  await ses.cookies.flushStore?.();
}
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
    if (req.url === '/v1/chat2codex/identity') return result(res, 200, await sessionIdentity(ses, controller.signal));
    if (req.url === '/v1/chat2codex/import-session') {
      if (host.turnTabs?.size) return result(res, 409, { code: 'account_busy' });
      const body = await readBody(req, 65536);
      if (typeof body.sessionToken !== 'string' || body.sessionToken.length < 32 || body.sessionToken.length > 32768 || /[\u0000-\u0020\u007f]/.test(body.sessionToken)) return result(res, 400, { code: 'invalid_session_secret' });
      if (body.replace !== undefined && typeof body.replace !== 'boolean') return result(res, 400, { code: 'invalid_replace_flag' });
      const currentIdentity = await sessionIdentity(ses, controller.signal).catch(() => ({ authenticated: false }));
      if (currentIdentity.authenticated && body.replace !== true) return result(res, 409, { code: 'session_already_authenticated' });
      const previous = (await ses.cookies.get({ url: 'https://chatgpt.com/' })).filter(cookie => isSessionCookie(cookie.name));
      for (const base of SESSION_COOKIE_BASES) {
        await installSessionFamily(ses, base, body.sessionToken);
        const imported = await sessionIdentity(ses, controller.signal).catch(() => ({ authenticated: false }));
        if (imported.authenticated) return result(res, 200, { ...imported, cookieFamily: base });
      }
      await restoreCookies(ses, previous);
      return result(res, 401, { code: 'session_import_rejected' });
    }
    if (!['/v1/chat2codex/open-settings', '/v1/chat2codex/assist'].includes(req.url)) return result(res, 404, { code: 'not_found' });
    const body = await readBody(req);
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
  } catch (error) {
    if (!res.destroyed) return result(res, error?.code === 'body_too_large' ? 413 : error?.code === 'invalid_json' ? 400 : 502, { code: error?.code || 'settings_bridge_failed' });
  } finally { res.off('close', cancel); req.off('aborted', cancel); }
};
const profile = require('./electron/profile.cjs');
const originalProfile = profile.resolveLauncherProfile;
profile.resolveLauncherProfile = function (...args) { const p = originalProfile(...args); return { ...p, displayName: `Chat2Codex · ${(process.env.CHAT2CODEX_ACCOUNT_LABEL || 'Account').slice(0, 100)}` }; };
require('./electron/main.cjs');