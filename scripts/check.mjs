import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
function walk(root) { return readdirSync(root, { withFileTypes: true }).flatMap(d => d.isDirectory() ? walk(join(root, d.name)) : [join(root, d.name)]); }
for (const f of ['src', 'scripts', 'test', 'public'].flatMap(walk).filter(f => f.endsWith('.mjs') || f.endsWith('.js'))) {
  const r = spawnSync(process.execPath, ['--check', f], { stdio: 'inherit' }); if (r.status !== 0) process.exit(1);
}
console.log('JavaScript syntax checks passed');
