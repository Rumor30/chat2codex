import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, copyFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PROJECT, UPSTREAM, runtimePath } from '../src/runtime.mjs';
import { lock, writeJson } from '../src/state.mjs';
const bun = process.env.CHAT2CODEX_BUN || 'bun'; const root = runtimePath();
function run(command, args, cwd = PROJECT) {
  const r = spawnSync(command, args, { cwd, stdio: 'inherit', shell: false });
  if (r.error || r.status !== 0) throw new Error(`${command} failed. Install Git and Bun 1.4.0, and check network access. Existing runtime files were retained.`);
}
mkdirSync(join(PROJECT, '.runtime'), { recursive: true }); const release = lock(join(PROJECT, '.runtime', 'bootstrap.lock'));
try {
  const version = spawnSync(bun, ['--version'], { encoding: 'utf8', shell: false });
  if (version.status !== 0 || version.stdout.trim() !== '1.4.0') throw new Error('The pinned upstream requires Bun 1.4.0');
  mkdirSync(root, { recursive: true });
  if (!existsSync(join(root, '.git'))) run('git', ['init', root]);
  const remote = 'https://github.com/miuuyy/codex-chatgpt-web.git';
  const current = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' });
  if (current.stdout.trim() !== UPSTREAM) { run('git', ['fetch', '--depth', '1', remote, UPSTREAM], root); run('git', ['checkout', '--detach', UPSTREAM], root); }
  const head = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' });
  if (head.stdout.trim() !== UPSTREAM) throw new Error('Upstream commit verification failed');
  const dirty = spawnSync('git', ['diff', '--name-only', 'HEAD'], { cwd: root, encoding: 'utf8' });
  if (dirty.status !== 0 || dirty.stdout.trim()) throw new Error('Pinned upstream tracked files were changed; bootstrap will not overwrite them');
  run(bun, ['install', '--frozen-lockfile'], root);
  if (!process.argv.includes('--core-only')) {
    run(bun, ['install', '--frozen-lockfile'], join(root, 'launcher'));
    run(bun, ['run', 'build'], join(root, 'launcher'));
  }
  run(bun, ['run', 'scripts/build-browser-helper.ts', join(root, '.chat2codex-browser-helper.cjs')], root);
  copyFileSync(join(PROJECT, 'bridge', 'worker.ts'), join(root, '.chat2codex-worker.ts'));
  writeJson(join(root, '.chat2codex-tsconfig.json'), { extends: './tsconfig.json', include: ['.chat2codex-worker.ts', 'src/**/*.ts'], exclude: ['node_modules', 'launcher'] });
  // Existing licenses stay with the upstream checkout. We do not relabel its authorship.
  if (!readFileSync(join(root, 'LICENSE'), 'utf8').includes('MIT')) throw new Error('Unexpected upstream license');
  writeJson(join(root, '.chat2codex-build.json'), { commit: UPSTREAM, bridgeVersion: 1, launcher: !process.argv.includes('--core-only') });
  console.log('Pinned browser bridge installed. No user Codex configuration was read or changed.');
} finally { release(); }
