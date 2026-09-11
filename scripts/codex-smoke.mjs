/** Uses the real pinned Codex CLI with an explicit LOCAL fixture model, not a ChatGPT login. */
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { State } from '../src/state.mjs';
import { createGateway } from '../src/gateway.mjs';
import { startCodex } from '../src/codex.mjs';
const entry = resolve('.runtime/codex-smoke/node_modules/@openai/codex/bin/codex.js');
assert(existsSync(entry), 'Install the pinned @openai/codex package into .runtime/codex-smoke first');
process.env.CHAT2CODEX_CODEX = entry;
const home = mkdtempSync(join(tmpdir(), 'c2c-native-')); const codexHome = join(home, 'codex'); mkdirSync(codexHome);
const config = '# Sentinel: Chat2Codex must not replace this configuration.\n';
const auth = '{"OPENAI_API_KEY":"fixture-only-not-an-openai-key"}\n';
writeFileSync(join(codexHome, 'config.toml'), config); writeFileSync(join(codexHome, 'auth.json'), auth);
const marker = `C2C_NATIVE_${randomUUID().replaceAll('-', '')}`; const callId = 'call_c2c_native_probe';
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
      assert(JSON.stringify(result.output).includes(marker), 'Native tool output must include the generated marker'); witnessedTool = true;
      emit(res, { type: 'message', id: 'msg_done', role: 'assistant', status: 'completed', phase: 'final_answer', content: [{ type: 'output_text', text: marker, annotations: [] }] }); return;
    }
    assert(requests <= 3, 'Codex did not return the native tool result');
    const tools = (body.tools || []).flatMap(t => t.type === 'namespace' ? (t.tools || []).map(n => ({ ...n, namespace: t.name })) : [t]);
    const direct = tools.find(t => !t.namespace && ['exec_command', 'shell_command', 'shell'].includes(t.name));
    let item;
    if (direct) {
      const command = process.platform === 'win32' ? `Write-Output ${marker}` : `printf '%s\\n' ${marker}`;
      const args = direct.name === 'exec_command' ? { cmd: command, max_output_tokens: 1000 } : direct.name === 'shell_command' ? { command } : { command: process.platform === 'win32' ? ['powershell', '-NoProfile', '-Command', command] : ['/bin/sh', '-c', command] };
      item = { type: 'function_call', id: 'fc_probe', call_id: callId, name: direct.name, arguments: JSON.stringify(args), status: 'completed' };
    } else {
      const exec = tools.find(t => t.name === 'exec' && ['custom', 'custom_tool'].includes(t.type));
      assert(exec, `No supported native tool advertised: ${tools.map(t => `${t.type}:${t.name}`).join(', ')}`);
      item = { type: 'custom_tool_call', id: 'fc_probe', call_id: callId, name: 'exec', input: `text(${JSON.stringify(marker)})`, status: 'completed' };
    }
    emit(res, item);
  } catch (e) { failure = e; res.writeHead(500, { 'content-type': 'application/json' }); res.end('{"error":{"message":"local smoke fixture failed"}}'); }
});
await new Promise(r => fixture.listen(0, '127.0.0.1', r));
const state = new State(join(home, 'pool')); const account = state.add('Explicit local fixture');
const worker = { ready: true, generation: 'fixture', endpoint: `http://127.0.0.1:${fixture.address().port}`, token: 'fixture-worker-key', models: [{ id: 'chatgpt-web/high' }] };
const gateway = createGateway({ state, workers: { snapshots: async () => new Map([[account.id, worker]]), control: async () => ({ cancelled: 0 }) } });
await new Promise(r => gateway.server.listen(0, '127.0.0.1', r));
try {
  child = startCodex({ endpoint: `http://127.0.0.1:${gateway.server.address().port}`, token: state.token(), model: 'chatgpt-web/high', reasoning: 'high', env: { ...process.env, CODEX_HOME: codexHome }, args: ['exec', '--skip-git-repo-check', '--ephemeral', '--sandbox', 'read-only', 'Use one harmless native tool, then report its exact output.'] });
  const timer = setTimeout(() => child.kill('SIGTERM'), 90000); timer.unref();
  const code = await new Promise((r, reject) => { child.once('error', reject); child.once('exit', r); }); clearTimeout(timer);
  if (failure) throw failure;
  assert.equal(code, 0, 'Native Codex invocation failed'); assert(witnessedTool, 'Native Codex did not execute the advertised tool');
  assert(nativeMetadata, 'Codex version did not provide the metadata required by the real web adapter');
  assert.equal(readFileSync(join(codexHome, 'config.toml'), 'utf8'), config);
  assert.equal(readFileSync(join(codexHome, 'auth.json'), 'utf8'), auth);
  console.log('PASS: real Codex -> local fixture Responses -> native tool -> result -> final answer; config.toml and auth.json unchanged. This does NOT validate ChatGPT login/MCP/Tunnel.');
} finally {
  child?.kill('SIGTERM'); await gateway.close(); fixture.closeAllConnections(); await new Promise(r => fixture.close(r)); rmSync(home, { recursive: true, force: true });
}
