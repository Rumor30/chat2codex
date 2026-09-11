/** Boot actual Electron source under Xvfb with a new empty account; never import user credentials. */
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { State, readJson } from '../src/state.mjs';
import { Workers } from '../src/runtime.mjs';
const home = mkdtempSync(join(tmpdir(), 'c2c-electron-')); const state = new State(home); const account = state.add('Empty Electron startup fixture');
const workers = new Workers(state); let result;
try {
  await workers.launch(account.id);
  for (let i = 0; i < 80; i++) {
    const d = readJson(join(state.paths(account.id).profile, 'runtime/launcher-browser.json'), {});
    if (d.control?.endpoint) {
      const response = await fetch(`${d.control.endpoint}/v1/chat2codex/unknown-fixture-action`, { method: 'POST', headers: { authorization: `Bearer ${d.control.token}` }, signal: AbortSignal.timeout(2000) }).catch(() => undefined);
      if (response) { result = { descriptor: d, status: response.status, body: await response.json() }; break; }
    }
    await new Promise(r => setTimeout(r, 500));
  }
  assert(result, 'Electron did not publish an accessible descriptor');
  assert.equal(result.descriptor.profile, 'development'); assert.equal(result.descriptor.partition, 'persist:codex-web-gpt-dev-chatgpt');
  assert.equal(result.status, 404); assert.equal(result.body.code, 'not_found', 'New authenticated setup extension was not active');
  const denied = await fetch(`${result.descriptor.control.endpoint}/v1/chat2codex/identity`, { method: 'POST' }); assert.equal(denied.status, 401);
  console.log('PASS: actual Electron launcher boot, isolated descriptor, authenticated setup extension, unauthenticated access rejected. No ChatGPT account is signed in.');
} finally { await workers.close(); try { rmSync(home, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 }); } catch { console.warn('Empty test profile retained until Electron exits.'); } }
