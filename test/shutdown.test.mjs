import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { terminateOwnedChild } from '../src/process.mjs';
async function child(source) {
  const p = spawn(process.execPath, ['-e', source], { stdio: ['ignore', 'pipe', 'pipe'], shell: false });
  await new Promise((resolve, reject) => { p.stdout.once('data', resolve); p.once('error', reject); }); return p;
}
test('owned subprocess shutdown confirms exit and supports repeat cleanup', async () => {
  const p = await child('console.log("ready");setInterval(()=>{},1000)');
  await terminateOwnedChild(p, { graceMs: 100 }); assert(p.exitCode !== null || p.signalCode !== null);
  await terminateOwnedChild(p);
});
test('owned subprocess ignoring normal termination is stopped within a bounded grace period', async () => {
  const p = await child('process.on("SIGTERM",()=>{});console.log("ready");setInterval(()=>{},1000)');
  await terminateOwnedChild(p, { graceMs: 50, hardMs: 1000 }); assert(p.exitCode !== null || p.signalCode !== null);
});
test('missing or already exited child does not trigger a PID-based kill', async () => {
  let killed = false;
  await terminateOwnedChild({ pid: undefined, exitCode: null, signalCode: null, kill: () => { killed = true; } });
  await terminateOwnedChild({ pid: 1, exitCode: 0, signalCode: null, kill: () => { killed = true; } }); assert(!killed);
});
