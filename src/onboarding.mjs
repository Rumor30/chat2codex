import { ensure } from './state.mjs';

/** Hold the account maintenance lease through a full operation, not merely one HTTP request. */
export function startAccountOperation({ state, workers, router, jobs }, id, body) {
  state.account(id);
  const action = body.action;
  ensure(['configure', 'assist', 'verify', 'open-settings', 'restart', 'archive'].includes(action), 400, 'bad_action', 'Unknown account operation');
  const owned = [...router.threads.values()].filter(t => t.accountId === id && t.state !== 'retired');
  ensure(owned.every(t => !router.busy.has(t.id) && t.pending.length === 0), 409, 'account_busy', 'Finish or cancel active tool rounds before account maintenance');
  if (['configure', 'restart', 'archive'].includes(action)) ensure(owned.length === 0, 409, 'retire_threads_first', 'Retire this account’s completed threads before changing its runtime');
  if (action === 'configure') ensure(body.consent === true && /^tunnel_[a-f0-9]{32}$/.test(body.tunnelId || '')
    && typeof body.runtimeKey === 'string' && body.runtimeKey.trim().length >= 20 && body.runtimeKey.length < 8192, 400, 'invalid_tunnel_credentials', 'Enter the Tunnel ID and runtime key and confirm setup');
  if (action === 'assist') ensure(body.consent === true, 400, 'setup_consent_required', 'Confirm assisted Connector creation');
  if (action === 'verify') ensure(typeof body.model === 'string' && body.model.startsWith('chatgpt-web/'), 400, 'model_required', 'Select the exact model to verify');
  return jobs.start(id, action, async ({ signal, progress }) => {
    progress(`${action}_started`);
    if (action === 'configure') {
      try { return await workers.configure(id, body, signal); } finally { body.runtimeKey = ''; }
    }
    if (action === 'assist') return workers.assist(id, body.consent, signal);
    if (action === 'open-settings') return workers.launcherControl(id, 'open-settings', {}, signal);
    if (action === 'verify') { await workers.control(id, 'verify', { model: body.model }, signal); return { code: 'model_verified' }; }
    if (action === 'restart') { await workers.stop(id); await workers.start(id); return { code: 'worker_restarted_probe_required' }; }
    if (workers.children?.has(id)) await workers.stop(id);
    if (workers.launchers?.has(id)) await workers.launcherControl(id, 'quit', {}, signal);
    state.update(id, { archived: true }); return { code: 'account_archived_profiles_retained' };
  });
}
