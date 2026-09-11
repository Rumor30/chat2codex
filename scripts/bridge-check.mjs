import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { PROJECT, checkedRuntime } from '../src/runtime.mjs';
const root = checkedRuntime(); const bun = process.env.CHAT2CODEX_BUN || 'bun';
copyFileSync(join(PROJECT, 'bridge', 'worker.ts'), join(root, '.chat2codex-worker.ts'));
copyFileSync(join(PROJECT, 'bridge', 'setup.ts'), join(root, '.chat2codex-setup.ts'));
for (const args of [
  ['x', '--no-install', '--bun', 'tsc', '--noEmit', '--project', '.chat2codex-tsconfig.json'],
  ['build', '.chat2codex-worker.ts', '--target', 'bun', '--outfile', '.chat2codex-worker-check.js'],
]) {
  const r = spawnSync(bun, args, { cwd: root, stdio: 'inherit', shell: false });
  if (r.error || r.status !== 0) process.exit(1);
}
// Exercise the actual upstream-imported alias constant in separate account processes.
const seen = new Set();
for (const digit of ['a', 'b']) {
  const accountId = `acct_${digit.repeat(32)}`;
  const r = spawnSync(bun, ['-e', 'import { DEV_TUNNEL_BASE_NAME as alias } from "./src/dev-chat/constants.ts"; console.log(alias)'],
    { cwd: root, env: { ...process.env, CHAT2CODEX_ACCOUNT_ID: accountId }, encoding: 'utf8', shell: false });
  if (r.error || r.status !== 0 || r.stdout.trim() !== `chat2codex-${accountId}`) throw new Error('Per-account upstream Tunnel alias check failed');
  seen.add(r.stdout.trim());
}
if (seen.size !== 2) throw new Error('Two accounts shared a Tunnel runtime alias');
console.log('Pinned bridge imports and TypeScript checked. This is not a logged-in browser E2E test.');

if (!existsSync(join(root, '.launcher-runtime/browser-helper.cjs'))) throw new Error('Launcher browser helper is missing');
