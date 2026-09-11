import { parseArgs } from 'node:util';
import { mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { State, ensure, privateDir, readJson, writeJson } from '../src/state.mjs';
import { Workers, checkedRuntime } from '../src/runtime.mjs';
import { createGateway } from '../src/gateway.mjs';
import { catalogFile } from '../src/catalog.mjs';
import { startCodex } from '../src/codex.mjs';
import { readSessionSecret } from '../src/session-secret.mjs';

const { values } = parseArgs({ strict: true, options: {
  account: { type: 'string' }, model: { type: 'string' }, 'session-file': { type: 'string' },
  'replace-session': { type: 'boolean', default: false }, 'use-existing-session': { type: 'boolean', default: false },
  'keep-workspace': { type: 'boolean', default: false },
} });
ensure(values.account, 400, 'account_required', '--account ACCOUNT_ID is required');
ensure(values.model?.startsWith('chatgpt-web/'), 400, 'model_required', '--model chatgpt-web/... is required');
ensure(!(values['session-file'] && values['use-existing-session']), 400, 'session_option_conflict', 'Choose a session import or --use-existing-session');
checkedRuntime();
const state = new State(); const account = state.account(values.account);
ensure(!account.archived, 409, 'account_archived', 'Restore the account before live acceptance');
const workers = new Workers(state); const gateway = createGateway({ state, workers });
const runId = `live_${randomBytes(8).toString('hex')}`;
const acceptanceRoot = join(state.home, 'acceptance'); privateDir(acceptanceRoot);
const workspace = join(acceptanceRoot, runId); privateDir(workspace);
const reportPath = join(acceptanceRoot, `${runId}.json`);
const report = { version: 1, runId, accountId: account.id, model: values.model, startedAt: new Date().toISOString(), stages: [] };
const record = (stage, ok, detail) => { report.stages.push({ stage, ok, ...(detail ? { detail } : {}), at: new Date().toISOString() }); writeJson(reportPath, report); };
const sleep = ms => new Promise(r => setTimeout(r, ms));
let secret = ''; let gatewayEndpoint; let succeeded = false;
async function identity() { return workers.launcherControl(account.id, 'identity'); }
async function ensureLauncher() {
  try { return await identity(); } catch { await workers.launch(account.id); }
  const deadline = Date.now() + 45000; let last;
  while (Date.now() < deadline) { try { return await identity(); } catch (error) { last = error; await sleep(300); } }
  throw last || new Error('Account launcher did not become ready');
}
async function settleThreads() {
  for (const thread of [...gateway.router.threads.values()].filter(t => t.accountId === account.id && !gateway.router.busy.has(t.id) && !t.pending.length)) {
    try { await workers.control(account.id, 'release', { thread_id: thread.id }); } catch {}
    try { thread.state = 'ready'; gateway.router.release(thread.id); } catch {}
  }
}
try {
  await new Promise((resolve, reject) => { gateway.server.once('error', reject); gateway.server.listen(0, '127.0.0.1', resolve); });
  gatewayEndpoint = `http://127.0.0.1:${gateway.server.address().port}`;
  const existing = await ensureLauncher(); record('launcher', true, existing.authenticated ? 'existing authenticated profile detected' : 'isolated launcher ready');
  if (!values['use-existing-session']) {
    secret = await readSessionSecret({ file: values['session-file'] });
    const imported = await workers.launcherControl(account.id, 'import-session', { sessionToken: secret, replace: values['replace-session'] === true });
    secret = '';
    ensure(imported.authenticated === true, 401, 'session_import_failed', 'Imported session did not authenticate');
    record('session_import', true, `authenticated using ${imported.cookieFamily}`);
  } else {
    ensure(existing.authenticated === true, 401, 'launcher_login_required', 'The selected profile is not logged in'); record('session_import', true, 'existing profile session used');
  }
  const identityAfter = await identity(); ensure(identityAfter.authenticated === true, 401, 'launcher_login_required', 'ChatGPT session is not authenticated'); record('session_identity', true, 'session endpoint confirmed login');
  const config = readJson(join(state.paths(account.id).profile, 'config.json'), {});
  ensure(config.tunnel?.tunnelId, 409, 'tunnel_setup_required', 'Configure this account Tunnel before running live acceptance');
  const assisted = await workers.assist(account.id, true); record('connector_assistant', true, assisted.code);
  await workers.start(account.id);
  const deadline = Date.now() + 45000; let snapshot;
  while (Date.now() < deadline) { snapshot = await workers.probe(account.id, true); if (snapshot.online && snapshot.availableModels?.some(m => m.id === values.model)) break; await sleep(500); }
  ensure(snapshot?.online, 503, 'worker_offline', 'Browser bridge did not become ready');
  ensure(snapshot.availableModels?.some(m => m.id === values.model), 409, 'model_unavailable', 'The logged-in account does not expose the requested model');
  record('model_discovery', true, values.model);
  const verified = await workers.control(account.id, 'verify', { model: values.model }, AbortSignal.timeout(3600000));
  ensure(verified.verified === true, 502, 'mcp_probe_failed', 'MCP nonce round-trip did not verify'); record('mcp_probe', true, values.model);
  snapshot = await workers.probe(account.id, true);
  const model = snapshot.models.find(m => m.id === values.model); ensure(model, 409, 'model_not_ready', 'Verified model did not enter the Ready model set');
  const before = `BEFORE_${randomBytes(16).toString('hex')}`; const after = `AFTER_${randomBytes(16).toString('hex')}`;
  const target = join(workspace, 'acceptance.txt'); writeFileSync(target, `CHAT2CODEX_LIVE_ACCEPTANCE\nRESULT=${before}\n`, { mode: 0o600 });
  const catalogPath = catalogFile(state.home, snapshot.models);
  const prompt = `This is a live transport acceptance check. Use your normal Codex tools to read acceptance.txt, replace the exact line RESULT=${before} with RESULT=${after}, then read the file again. Do not create or modify any other file. Your final answer must be exactly ${after}.`;
  const child = startCodex({ endpoint: gatewayEndpoint, token: state.token(), model: values.model, account: account.id, catalogPath,
    reasoning: model.default_reasoning_level, contextWindow: model.context_window, autoCompact: model.auto_compact_token_limit,
    cwd: workspace, args: ['exec', '--skip-git-repo-check', '--ephemeral', '--sandbox', 'workspace-write', prompt] });
  const exit = await new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', code => resolve(code ?? 1)); });
  ensure(exit === 0, 502, 'codex_acceptance_failed', `Codex exited with code ${exit}`);
  const finalText = readFileSync(target, 'utf8');
  ensure(finalText === `CHAT2CODEX_LIVE_ACCEPTANCE\nRESULT=${after}\n`, 502, 'disk_verification_failed', 'Codex did not produce the exact expected disk mutation');
  ensure(readdirSync(workspace).join('\n') === 'acceptance.txt', 502, 'workspace_polluted', 'Acceptance task created unexpected files');
  record('codex_tool_loop', true, 'real disk mutation verified');
  await settleThreads(); record('thread_retirement', true, 'acceptance threads settled');
  succeeded = true; report.completedAt = new Date().toISOString(); report.result = 'pass'; writeJson(reportPath, report);
  console.log(`PASS: authenticated ChatGPT Web -> MCP -> Responses -> Codex tool loop -> disk verification.\nSanitized report: ${reportPath}`);
} catch (error) {
  secret = '';
  report.completedAt = new Date().toISOString(); report.result = 'fail'; report.error = { code: error?.code || 'acceptance_failed', message: error instanceof Error ? error.message : String(error) };
  try { writeJson(reportPath, report); } catch {}
  console.error(`${report.error.code}: ${report.error.message}\nSanitized report: ${reportPath}`); process.exitCode = 1;
} finally {
  secret = '';
  try { await settleThreads(); } catch {}
  try { await gateway.close(); } catch {}
  try { await workers.close(); } catch {}
  if (succeeded && !values['keep-workspace']) rmSync(workspace, { recursive: true, force: true });
}
