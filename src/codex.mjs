import { spawn } from 'node:child_process';
import { ensure } from './state.mjs';
import { codexCommand } from './command.mjs';
const literal = value => JSON.stringify(value);
export function codexInvocation({ endpoint, token, model, account, reasoning, contextWindow, autoCompact, catalogPath, args = [], env = process.env }) {
  const u = new URL(endpoint);
  ensure(u.protocol === 'http:' && u.hostname === '127.0.0.1' && !u.username && !u.password && !u.search && !u.hash && (u.pathname === '/' || u.pathname === '/v1'), 400, 'bad_endpoint', 'Codex connects only to the local pool');
  ensure(typeof model === 'string' && model.startsWith('chatgpt-web/'), 400, 'bad_model', 'Select a verified chatgpt-web/* model');
  // Provider credentials stay in this child environment, never config.toml, auth.json, or argv.
  const settings = [
    'model_provider="chat2codex"', `model=${literal(model)}`,
    'model_providers.chat2codex.name="Chat2Codex"',
    `model_providers.chat2codex.base_url=${literal(`${u.origin}/v1`)}`,
    'model_providers.chat2codex.wire_api="responses"',
    'model_providers.chat2codex.env_key="CHAT2CODEX_API_KEY"',
    'model_providers.chat2codex.requires_openai_auth=false',
    'model_providers.chat2codex.supports_websockets=false',
    'features.multi_agent_v2=false', 'features.multi_agent=true', 'agents.max_depth=2',
  ];
  if (catalogPath) settings.push(`model_catalog_json=${literal(catalogPath)}`);
  if (reasoning) settings.push(`model_reasoning_effort=${literal(reasoning)}`);
  if (Number.isSafeInteger(contextWindow) && contextWindow > 0) settings.push(`model_context_window=${contextWindow}`);
  if (Number.isSafeInteger(autoCompact) && autoCompact > 0) settings.push(`model_auto_compact_token_limit=${autoCompact}`);
  if (account) settings.push(`model_providers.chat2codex.http_headers={"X-Chat2Codex-Account"=${literal(account)}}`);
  return { args: [...settings.flatMap(v => ['-c', v]), ...args], env: { ...env, CHAT2CODEX_API_KEY: token } };
}
export function startCodex(options) {
  const invocation = codexInvocation(options);
  const command = codexCommand(process.env.CHAT2CODEX_CODEX || 'codex');
  return spawn(command.executable, [...command.prefix, ...invocation.args], { env: invocation.env, stdio: 'inherit', shell: false });
}
