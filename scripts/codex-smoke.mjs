/** Uses the real pinned Codex CLI with an explicit LOCAL fixture model, not a ChatGPT login. */
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { rm } from 'node:fs/promises';
import { successfulShellReceipt } from './smoke-receipt.mjs';
import { State } from '../src/state.mjs';
import { createGateway } from '../src/gateway.mjs';
import { startCodex } from '../src/codex.mjs';
import { catalogFile } from '../src/catalog.mjs';
import { fetchCatalog } from './fetch-catalog.mjs';
const entry = resolve('.runtime/codex-smoke/node_modules/@openai/codex/bin/codex.js');
assert(existsSync(entry), 'Install the pinned @openai/codex package into .runtime/codex-smoke first');
process.env.CHAT2CODEX_CODEX = entry;
// Keep the managed Codex home outside OS temp: native helper installation rejects /tmp.
const smokeRoot = resolve('.runtime'); mkdirSync(smokeRoot, { recursive: true });
const home = mkdtempSync(join(smokeRoot, 'c2c-native-')); const codexHome = join(home, 'codex'); mkdirSync(codexHome);
const config = '# Sentinel: Chat2Codex must not replace this configuration.\n';
const auth = '{"OPENAI_API_KEY":"fixture-only-not-an-openai-key"}\n';
writeFileSync(join(codexHome, 'config.toml'), config); writeFileSync(join(codexHome, 'auth.json'), auth);
const marker = `C2C_NATIVE_${randomUUID().replaceAll('-', '')}`; const callId = 'call_c2c_native_probe';
const shellMode = process.argv.includes('--shell');
let requests = 0; let witnessedTool = false; let nativeMetadata = false; let failure; let child;
function emit(res, item) {
  const id = `resp_${randomUUID()}`;
  const events = [
    { type: 'response.created', response: { id, object: 'response', status: 'in_progress', output: [] } },
    { type: 'response.output_item.added', output_index: 0, item },
    { type: 'response.output_item.done', output_index: 0, item },
    { type: 'response.completed', response: { id, object: 'response', status: 'completed', output: [item], usage: { input_tokens: 10, output_tokens: 10, total_tokens: 20 } } },
  ];
  res.writeHead(200, { 'content-type': 'text/event-stream' });
  res.end(events.map(e => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join(''));
}
const fixture = createServer(async (req, res) => {
  try {
    const chunks = []; for await (const chunk of req) chunks.push(chunk); const body = JSON.parse(Buffer.concat(chunks)); requests++;
    assert.equal(req.headers.authorization, 'Bearer fixture-worker-key');
    let meta = body.client_metadata?.['x-codex-turn-metadata']; if (typeof meta === 'string') meta = JSON.parse(meta);
    nativeMetadata ||= typeof meta?.thread_id === 'string' && typeof meta?.turn_id === 'string';
    const result = body.input?.find(i => ['function_call_output', 'custom_tool_call_output'].includes(i.type) && i.call_id === callId);
    if (result) {
      assert(shellMode ? successfulShellReceipt(result.output, marker) : result.output === 'Plan updated',
        `Native tool did not return the expected successful receipt: ${JSON.stringify(result.output).slice(0, 4000)}`); witnessedTool = true;
      emit(res, { type: 'message', id: 'msg_done', role: 'assistant', status: 'completed', phase: 'final_answer', content: [{ type: 'output_text', text: marker, annotations: [] }] }); return;
    }
    assert(requests <= 3, 'Codex did not return the native tool result');
    const tools = (body.tools || []).flatMap(t => t.type === 'namespace' ? (t.tools || []).map(n => ({ ...n, namespace: t.name })) : [t]);
    const direct = tools.find(t => !t.namespace && ['exec_command', 'shell_command', 'shell'].includes(t.name));
    let item;
    if (!shellMode) {
      const plan = tools.find(t => t.name === 'update_plan' && t.type === 'function');
      assert(plan, `Codex did not advertise update_plan; actual tool names/types: ${JSON.stringify(tools.map(t => ({ type: t.type, name: t.name, namespace: t.namespace })))}`);
      item = { type: 'function_call', id: 'fc_probe', call_id: callId, name: plan.name,
        ...(plan.namespace ? { namespace: plan.namespace } : {}),
        arguments: JSON.stringify({ plan: [{ step: `Verify transport ${marker}`, status: 'completed' }] }), status: 'completed' };
    } else if (direct) {
      const command = process.platform === 'win32' ? `Write-Output ${marker}` : `printf '%s\\n' ${marker}`;
      const args = direct.name === 'exec_command' ? { cmd: command, max_output_tokens: 1000 } : direct.name === 'shell_command' ? { command } : { command: process.platform === 'win32' ? ['powershell', '-NoProfile', '-Command', command] : ['/bin/sh', '-c', command] };
      item = { type: 'function_call', id: 'fc_probe', call_id: callId, name: direct.name, arguments: JSON.stringify(args), status: 'completed' };
    } else { throw new Error('Shell smoke needs an explicitly advertised native command tool'); }
    emit(res, item);
  } catch (e) { failure = e; res.writeHead(500, { 'content-type': 'application/json' }); res.end('{"error":{"message":"local smoke fixture failed"}}'); }
});
await new Promise(r => fixture.listen(0, '127.0.0.1', r));
const template = (await fetchCatalog(resolve('.runtime/codex-catalog.json'))).models[0];
const catalogPath = catalogFile(home, [{ ...template, slug: 'chatgpt-web/high', id: 'chatgpt-web/high', display_name: 'Local transport fixture', default_reasoning_level: 'high', supported_reasoning_levels: [{ effort: 'high', description: 'High' }], context_window: 90000, max_context_window: 90000, visibility: 'list', supported_in_api: true, multi_agent_version: 'v1', auto_compact_token_limit: 80000 }]);
const state = new State(join(home, 'pool')); const account = state.add('Explicit local fixture');
const worker = { ready: true, generation: 'fixture', endpoint: `http://127.0.0.1:${fixture.address().port}`, token: 'fixture-worker-key', models: [{ id: 'chatgpt-web/high' }] };
const gateway = createGateway({ state, workers: { snapshots: async () => new Map([[account.id, worker]]), control: async () => ({ cancelled: 0 }) } });
await new Promise(r => gateway.server.listen(0, '127.0.0.1', r));
try {
  child = startCodex({ endpoint: `http://127.0.0.1:${gateway.server.address().port}`, token: state.token(), model: 'chatgpt-web/high', catalogPath, reasoning: 'high', env: { ...process.env, CODEX_HOME: codexHome }, args: [...(!shellMode ? ['-c', 'tools.update_plan.enabled=true'] : []), 'exec', '--skip-git-repo-check', '--ephemeral', '--sandbox', 'read-only', shellMode ? 'Use one harmless native command, then report its exact output.' : 'Update the plan with one completed transport-check step, then report completion.'] });
  const timer = setTimeout(() => child.kill('SIGTERM'), 90000); timer.unref();
  const code = await new Promise((r, reject) => { child.once('error', reject); child.once('exit', r); }); clearTimeout(timer);
  if (failure) throw failure;
  assert.equal(code, 0, 'Native Codex invocation failed'); assert(witnessedTool, 'Native Codex did not execute the advertised tool');
  assert(nativeMetadata, 'Codex version did not provide the metadata required by the real web adapter');
  assert.equal(readFileSync(join(codexHome, 'config.toml'), 'utf8'), config);
  assert.equal(readFileSync(join(codexHome, 'auth.json'), 'utf8'), auth);
  console.log(`PASS: real Codex -> local fixture Responses -> native ${shellMode ? 'shell' : 'update_plan'} tool -> successful receipt -> final answer; config.toml and auth.json unchanged. This does NOT validate ChatGPT login/MCP/Tunnel${shellMode ? '' : ' or shell execution'}.`);
} finally {
  child?.kill('SIGTERM'); await gateway.close(); fixture.closeAllConnections(); await new Promise(r => fixture.close(r));
  try { await rm(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); }
  catch (e) { if (!['EBUSY', 'EPERM'].includes(e.code)) throw e; console.warn('Isolated smoke state retained because a native helper still owns a file handle. No user profile was touched.'); }
}
