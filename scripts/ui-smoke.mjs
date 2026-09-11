/** Explicit synthetic UI fixtures. This does not sign into or change any ChatGPT account. */
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtempSync, rmSync, mkdirSync, readFileSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { State } from '../src/state.mjs';
import { createGateway } from '../src/gateway.mjs';
import { checkedRuntime } from '../src/runtime.mjs';
const require = createRequire(import.meta.url); const { settingsStep } = require('../bridge/provision.cjs');
const { chromium } = createRequire(join(checkedRuntime(), 'package.json'))('playwright-core');
const executablePath = process.env.CHAT2CODEX_BROWSER || ['/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser'].find(existsSync);
assert(executablePath, 'Set CHAT2CODEX_BROWSER to the installed Chrome/Chromium executable');
const home = mkdtempSync(join(tmpdir(), 'c2c-ui-')); const state = new State(home); const account = state.add('界面测试账号');
const calls = []; const model = { id: 'chatgpt-web/high', display_name: 'High · 测试数据' };
const fixtureWorkers = {
  snapshots: async () => new Map([[account.id, { ready: false, online: true, generation: 'ui-fixture', state: 'needs_mcp_probe', models: [], availableModels: [model] }]]),
  configure: async (id, body) => { calls.push({ id, consent: body.consent, keyReceived: body.runtimeKey === 'test-only-key-123456789' }); return { code: 'completed' }; },
  launch: async id => calls.push({ id, kind: 'launch' }), start: async () => {},
  assist: async () => ({ code: 'security_confirmation_required' }),
  launcherControl: async () => ({ code: 'settings_opened' }), control: async () => ({ verified: true }),
};
const gateway = createGateway({ state, workers: fixtureWorkers });
await new Promise(r => gateway.server.listen(0, '127.0.0.1', r));
const origin = `http://127.0.0.1:${gateway.server.address().port}`; let browser;
try {
  browser = await chromium.launch({ executablePath, headless: true });
  const page = await browser.newPage({ viewport: { width: 1366, height: 1000 } }); const errors = []; page.on('pageerror', e => errors.push(e.message));
  await page.goto(`${origin}/#invite=${gateway.invitations.issue()}`); await page.locator('#workspace').waitFor({ state: 'visible' });
  assert.equal(new URL(page.url()).hash, ''); assert.equal(await page.evaluate(() => localStorage.length + sessionStorage.length), 0);
  await page.getByRole('button', { name: '② 配置 Tunnel', exact: true }).click();
  await page.locator('#tunnel-id').fill(`tunnel_${'a'.repeat(32)}`); await page.locator('#runtime-key').fill('test-only-key-123456789');
  await page.locator('#consent').check(); await page.getByRole('button', { name: '保存并连接 Tunnel', exact: true }).click();
  await page.waitForFunction(() => document.querySelector('#jobs').textContent.includes('配置完成'));
  assert.equal(await page.locator('#runtime-key').inputValue(), ''); assert.equal(calls[0].keyReceived, true);
  assert(!JSON.stringify(gateway.jobs.list()).includes('test-only-key')); assert(!JSON.stringify(gateway.diagnostics.report()).includes('test-only-key'));
  await page.locator('#label').fill('<img src=x onerror=alert(1)>'); await page.getByRole('button', { name: '＋ 添加账号', exact: true }).click();
  await page.getByRole('heading', { name: '<img src=x onerror=alert(1)>', exact: true }).waitFor(); assert.equal(await page.locator('#accounts img').count(), 0);
  await page.locator('#logout').click(); await page.locator('#login').waitFor({ state: 'visible' });
  assert.deepEqual(errors, []); console.log('PASS: dashboard invitation, Tunnel form, secret clearing, safe labels, lock action');
  // No remote navigation. The only mocked object here is location; the real DOM/events are Chromium's.
  const form = await browser.newPage();
  const tunnelId = `tunnel_${'a'.repeat(32)}`;
  await form.setContent(`<form><label>Name<input id="name"></label><label>Tunnel<select id="tunnel"><option value="">Choose</option><option value="${tunnelId}">Fixture tunnel</option></select></label><label>Authentication<select id="auth"><option value="oauth">OAuth</option><option value="none">None</option></select></label><div>codex_tool_inventory codex_tool_call</div><button type="button" onclick="window.created=(window.created||0)+1">Create</button></form>`);
  const invoke = action => form.evaluate(({ source, target, action }) => {
    return new Function('location', 'target', 'action', `return (${source})(target, action)`)(
      { origin: 'https://chatgpt.com', pathname: '/', hash: '#settings/Plugins' }, target, action);
  }, { source: settingsStep.toString(), target: { name: 'Codex Native2 DEV', tunnelId }, action });
  assert.equal((await form.evaluate(({ source, tunnelId }) => new Function('target', `return (${source})(target)` )({ name: 'Codex Native2 DEV', tunnelId }), { source: settingsStep.toString(), tunnelId })).code, 'settings_page_required');
  assert.equal((await invoke('advance')).code, 'connector_name_filled');
  assert.equal((await invoke('advance')).code, 'tunnel_selected'); assert.equal((await invoke('advance')).code, 'authentication_selected');
  assert.equal((await invoke('inspect')).code, 'ready_to_create'); assert.equal(await form.evaluate(() => window.created || 0), 0);
  assert.equal((await invoke('create')).code, 'creation_submitted'); assert.equal(await form.evaluate(() => window.created), 1);
  await form.evaluate(() => document.querySelector('button').disabled = true);
  assert.equal((await invoke('create')).code, 'security_confirmation_required');
  await form.evaluate(() => { const copy = document.querySelector('#name').cloneNode(); document.querySelector('form').prepend(copy); copy.setAttribute('aria-label', 'Name'); });
  assert.notEqual((await invoke('create')).code, 'creation_submitted');
  console.log('PASS: synthetic Connector DOM, exact tunnel identity, no premature Create, disabled security control and ambiguous inputs');
  // Keep the exported preview readable after the XSS fixture assertion above.
  const labelFixture = state.list().find(a => a.label.startsWith('<img'));
  if (labelFixture) state.update(labelFixture.id, { label: '第二账号 · 界面测试' });
  mkdirSync(resolve('.runtime/ui-artifacts'), { recursive: true });
  await page.locator('#key').fill(state.token()); await page.getByRole('button', { name: '连接控制台', exact: true }).click(); await page.locator('#workspace').waitFor({ state: 'visible' });
  await page.waitForFunction(() => document.querySelector('#message').textContent === '');
  await page.screenshot({ path: resolve('.runtime/ui-artifacts/dashboard-fixture.png'), fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), 'Dashboard must not overflow on mobile');
  await page.screenshot({ path: resolve('.runtime/ui-artifacts/dashboard-mobile-fixture.png'), fullPage: true });
} finally { await browser?.close(); await gateway.close(); rmSync(home, { recursive: true, force: true }); }
