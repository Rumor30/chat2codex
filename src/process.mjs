import { spawn } from 'node:child_process';
import { Fault } from './state.mjs';

const diagnostics = [
  [/SUID sandbox|setuid_sandbox_host|chrome-sandbox.*4755/i, 'linux_sandbox_setup_required'],
  [/ENOTFOUND|EAI_AGAIN|Could not resolve|unable to resolve|ECONNREFUSED|ERR_NAME_NOT_RESOLVED/i, 'network_unavailable'],
  [/runtime key|runtime-api-key|unauthorized|invalid.*key|\b401\b/i, 'tunnel_auth_required'],
  [/developer mode|admin.*permission|not authorized|entitlement/i, 'account_permission_required'],
  [/lock|already running|EADDRINUSE/i, 'runtime_in_use'],
  [/descriptor|browser host|launcher.*not|login|authenticated/i, 'launcher_login_required'],
  [/cannot find|not found|ENOENT/i, 'dependency_missing'],
];
export function processFailure(text) { return diagnostics.find(([pattern]) => pattern.test(text))?.[1] || 'runtime_command_failed'; }
/** No shell interpolation. Secret input goes over stdin; raw output is never returned or logged. */
export function runPrivate(command, args, { cwd, env, input = '', signal, timeoutMs = 120000, spawnImpl = spawn } = {}) {
  if (signal?.aborted) return Promise.reject(new Fault(409, 'operation_cancelled', 'Operation cancelled'));
  return new Promise((resolve, reject) => {
    let child; let tail = ''; let settled = false; let killTimer; let timedOut = false;
    const finish = (error, result) => {
      if (settled) return; settled = true; clearTimeout(timer); clearTimeout(killTimer);
      signal?.removeEventListener('abort', cancel); tail = ''; error ? reject(error) : resolve(result);
    };
    const cancel = () => { child?.kill('SIGTERM'); killTimer ??= setTimeout(() => child?.kill('SIGKILL'), 3000); killTimer.unref?.(); };
    const timer = setTimeout(() => { timedOut = true; cancel(); }, timeoutMs); timer.unref();
    try { child = spawnImpl(command, args, { cwd, env, shell: false, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] }); }
    catch { finish(new Fault(503, 'dependency_missing', 'Required runtime could not be started')); return; }
    signal?.addEventListener('abort', cancel, { once: true });
    for (const stream of [child.stdout, child.stderr]) stream?.on('data', chunk => { tail = (tail + chunk.toString()).slice(-8192); });
    child.stdin?.on('error', () => {}); child.stdin?.end(input); input = '';
    child.once('error', () => finish(new Fault(503, 'dependency_missing', 'Required runtime could not be started')));
    child.once('close', (code, exitSignal) => {
      if (signal?.aborted) finish(new Fault(409, 'operation_cancelled', 'Operation cancelled'));
      else if (timedOut) finish(new Fault(504, 'operation_timeout', 'Runtime operation timed out'));
      else if (code !== 0) finish(new Fault(502, exitSignal ? 'runtime_interrupted' : processFailure(tail), 'Runtime command failed; see the setup checklist'));
      else finish(undefined, { code: 'completed' });
    });
  });
}

/** Stop only a ChildProcess object created by this application; never search/kill other PIDs. */
export async function terminateOwnedChild(child, { graceMs = 4000, hardMs = 2000 } = {}) {
  if (child.exitCode !== null || child.signalCode !== null || !child.pid) return;
  await new Promise((resolve, reject) => {
    let hardTimer;
    const clean = () => { clearTimeout(softTimer); clearTimeout(hardTimer); child.off('exit', done); child.off('error', failed); };
    const done = () => { clean(); resolve(); };
    const failed = () => { clean(); reject(new Fault(503, 'process_stop_failed', 'An owned child could not be stopped')); };
    const softTimer = setTimeout(() => {
      child.kill('SIGKILL');
      hardTimer = setTimeout(() => {
        clean(); child.unref();
        for (const stream of [child.stdin, child.stdout, child.stderr]) stream?.destroy();
        reject(new Fault(503, 'process_stop_timeout', 'An owned child did not confirm shutdown; check it before restarting'));
      }, hardMs);
      hardTimer.unref();
    }, graceMs);
    softTimer.unref(); child.once('exit', done); child.once('error', failed); child.kill('SIGTERM');
  });
}
