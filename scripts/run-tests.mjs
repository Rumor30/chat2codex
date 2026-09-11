import { readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
const tests = readdirSync('test').filter(name => name.endsWith('.test.mjs')).sort().map(name => `test/${name}`);
const run = spawnSync(process.execPath, ['--test', ...tests], { stdio: 'inherit', shell: false });
if (run.error) console.error('Node test runner could not be started');
process.exitCode = run.status ?? 1;
