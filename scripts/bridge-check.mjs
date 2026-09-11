import { spawnSync } from 'node:child_process';
import { copyFileSync } from 'node:fs';
import { join } from 'node:path';
import { PROJECT, checkedRuntime } from '../src/runtime.mjs';
const root = checkedRuntime(); const bun = process.env.CHAT2CODEX_BUN || 'bun';
copyFileSync(join(PROJECT, 'bridge', 'worker.ts'), join(root, '.chat2codex-worker.ts'));
for (const args of [
  ['x', '--no-install', '--bun', 'tsc', '--noEmit', '--project', '.chat2codex-tsconfig.json'],
  ['build', '.chat2codex-worker.ts', '--target', 'bun', '--outfile', '.chat2codex-worker-check.js'],
]) {
  const r = spawnSync(bun, args, { cwd: root, stdio: 'inherit', shell: false });
  if (r.error || r.status !== 0) process.exit(1);
}
console.log('Pinned bridge imports and TypeScript checked. This is not a logged-in browser E2E test.');
