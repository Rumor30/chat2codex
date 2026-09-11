import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { checkedRuntime, UPSTREAM } from './runtime.mjs';
import { codexCommand } from './command.mjs';

export function inspectSystem() {
  const checks = [{ name: 'node', ok: Number(process.versions.node.split('.')[0]) >= 22, version: process.versions.node }];
  for (const [name, command, args] of [['git', 'git', ['--version']], ['bun', process.env.CHAT2CODEX_BUN || 'bun', ['--version']]]) {
    const r = spawnSync(command, args, { shell: false, encoding: 'utf8', timeout: 3000, windowsHide: true });
    const version = /\d+\.\d+\.\d+/.exec(r.stdout || '')?.[0];
    checks.push({ name, ok: r.status === 0 && (name !== 'bun' || version === '1.4.0'), ...(version ? { version } : {}) });
  }
  try {
    const command = codexCommand(process.env.CHAT2CODEX_CODEX || 'codex');
    const r = spawnSync(command.executable, [...command.prefix, '--version'], { encoding: 'utf8', shell: false, timeout: 5000, windowsHide: true });
    const version = /\d+\.\d+\.\d+/.exec(r.stdout || '')?.[0];
    checks.push({ name: 'codex', ok: r.status === 0, tested: version === '0.154.0', ...(version ? { version } : {}) });
  } catch { checks.push({ name: 'codex', ok: false }); }
  let runtimeReady = false;
  try { runtimeReady = existsSync(join(checkedRuntime(), 'launcher', 'dist', 'index.html')); } catch { /* Checklist reports missing runtime. */ }
  checks.push({ name: 'browser_runtime', ok: runtimeReady });
  return { version: '0.2.0', upstream: UPSTREAM, platform: process.platform, checks, ready: checks.every(c => c.ok) };
}
