import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, copyFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PROJECT, UPSTREAM, runtimePath } from '../src/runtime.mjs';
import { lock, writeJson } from '../src/state.mjs';
import { fetchCatalog } from './fetch-catalog.mjs';
import { applyProfileOverlay, ownedOverlayChanges } from './overlay.mjs';
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
  run('git', ['config', 'core.autocrlf', 'false'], root);
  const remote = 'https://github.com/miuuyy/codex-chatgpt-web.git';
  const current = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' });
  if (current.stdout.trim() !== UPSTREAM) { run('git', ['fetch', '--depth', '1', remote, UPSTREAM], root); run('git', ['checkout', '--detach', UPSTREAM], root); }
  const head = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' });
  if (head.stdout.trim() !== UPSTREAM) throw new Error('Upstream commit verification failed');
  const dirty = spawnSync('git', ['diff', '--name-only', 'HEAD'], { cwd: root, encoding: 'utf8' });
  const overlay = join(PROJECT, 'bridge', 'profile-constants.ts');
  const changed = dirty.stdout.trim().split(/\r?\n/).filter(Boolean);
  if (dirty.status !== 0 || !ownedOverlayChanges(root, overlay, changed)) throw new Error('Pinned upstream tracked files were changed outside the exact owned profile overlay; bootstrap will not overwrite them');
  applyProfileOverlay(root, overlay);
  run(bun, ['install', '--frozen-lockfile'], root);
  if (!process.argv.includes('--core-only')) {
    run(bun, ['install', '--frozen-lockfile'], join(root, 'launcher'));
    run(bun, ['run', 'build'], join(root, 'launcher'));
  }
  run(bun, ['run', 'scripts/build-browser-helper.ts', join(root, '.chat2codex-browser-helper.cjs')], root);
  mkdirSync(join(root, '.launcher-runtime'), { recursive: true });
  copyFileSync(join(root, '.chat2codex-browser-helper.cjs'), join(root, '.launcher-runtime', 'browser-helper.cjs'));
  await fetchCatalog(join(root, '.chat2codex-catalog.json'));
  copyFileSync(join(PROJECT, 'bridge', 'worker.ts'), join(root, '.chat2codex-worker.ts'));
  copyFileSync(join(PROJECT, 'bridge', 'setup.ts'), join(root, '.chat2codex-setup.ts'));
  copyFileSync(join(PROJECT, 'bridge', 'launcher-entry.cjs'), join(root, 'launcher', '.chat2codex-launcher.cjs'));
  copyFileSync(join(PROJECT, 'bridge', 'provision.cjs'), join(root, 'launcher', '.chat2codex-provision.cjs'));
  writeJson(join(root, '.chat2codex-tsconfig.json'), { extends: './tsconfig.json', include: ['.chat2codex-worker.ts', '.chat2codex-setup.ts', 'src/**/*.ts'], exclude: ['node_modules', 'launcher'] });
  if (!readFileSync(join(root, 'LICENSE'), 'utf8').includes('MIT')) throw new Error('Unexpected upstream license');
  writeJson(join(root, '.chat2codex-build.json'), { commit: UPSTREAM, bridgeVersion: 4, launcher: !process.argv.includes('--core-only') || existsSync(join(root, 'launcher', 'dist', 'index.html')) });
  console.log('Pinned browser bridge installed. No user Codex configuration was read or changed.');
} finally { release(); }