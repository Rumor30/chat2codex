import { ensure, opaque, readJson, writeJson } from './state.mjs';
import { join } from 'node:path';

/** Durable public receipts only: callbacks and secrets never enter the journal. */
export class Jobs {
  constructor(home, { now = Date.now, limit = 100 } = {}) {
    this.file = join(home, 'operations.json'); this.now = now; this.limit = limit;
    const data = readJson(this.file, { version: 1, jobs: [] });
    ensure(data.version === 1 && Array.isArray(data.jobs), 500, 'invalid_jobs', 'Invalid operations journal');
    this.jobs = new Map(); this.running = new Map(); this.controllers = new Map();
    for (const item of data.jobs) {
      ensure(item && /^job_[a-f0-9]{32}$/.test(item.id) && typeof item.accountId === 'string'
        && typeof item.kind === 'string' && ['running', 'succeeded', 'failed', 'cancelled', 'interrupted', 'waiting_user'].includes(item.state),
      500, 'invalid_jobs', 'Invalid operation record');
      this.jobs.set(item.id, item.state === 'running' ? { ...item, state: 'interrupted', code: 'process_restarted', finishedAt: now() } : item);
    }
  }
  list() { return [...this.jobs.values()].map(j => structuredClone(j)).reverse(); }
  active(accountId) { return this.running.has(accountId); }
  save() { writeJson(this.file, { version: 1, jobs: [...this.jobs.values()] }); }
  start(accountId, kind, action) {
    ensure(!this.active(accountId), 409, 'account_busy', 'An account operation is already in progress');
    // Bound the journal without evicting active operations.
    for (const [id, job] of this.jobs) {
      if (this.jobs.size < this.limit) break;
      if (job.state !== 'running') this.jobs.delete(id);
    }
    ensure(this.jobs.size < this.limit, 503, 'operation_capacity', 'Too many active account operations');
    const job = { id: opaque('job'), accountId, kind, state: 'running', step: 'starting', startedAt: this.now() };
    const controller = new AbortController();
    this.jobs.set(job.id, job); this.running.set(accountId, job.id); this.controllers.set(job.id, controller);
    try { this.save(); } catch (error) { this.jobs.delete(job.id); this.running.delete(accountId); this.controllers.delete(job.id); throw error; }
    const task = Promise.resolve().then(() => action({ signal: controller.signal, progress: step => {
      // Do not accept arbitrary payloads or upstream output as progress messages.
      ensure(/^[a-z][a-z0-9_]{0,63}$/.test(step), 500, 'invalid_step', 'Invalid operation step');
      job.step = step; this.save();
    } })).then(result => {
      job.state = controller.signal.aborted ? 'cancelled' : 'succeeded';
      job.code = typeof result?.code === 'string' && /^[a-z0-9_]{1,80}$/.test(result.code) ? result.code : 'completed';
      if (job.state === 'succeeded' && /_(required|review|reconciliation|pending)$/.test(job.code)) job.state = 'waiting_user';
      job.step = job.code;
    }, error => {
      job.state = controller.signal.aborted ? 'cancelled' : 'failed';
      // Error messages may contain secrets echoed by upstream programs. Persist only a code.
      job.code = /^[a-z0-9_]{1,80}$/.test(error?.code || '') ? error.code : 'operation_failed';
      job.step = job.code;
    }).finally(() => {
      job.finishedAt = this.now(); this.running.delete(accountId); this.controllers.delete(job.id);
      try { this.save(); } catch { job.state = 'interrupted'; job.code = 'journal_write_failed'; job.step = job.code; }
      // The durable record remains running and will fail closed on restart if saving failed.
    });
    // Keep settlement separate from the serializable receipt.
    this.controllers.get(job.id).settled = task;
    return structuredClone(job);
  }
  cancel(id) {
    const controller = this.controllers.get(id); ensure(controller, 409, 'operation_not_running', 'Operation is not running');
    controller.abort(); return { cancelling: true };
  }
  async close() {
    const controllers = [...this.controllers.values()]; for (const c of controllers) c.abort();
    await Promise.all(controllers.map(c => c.settled));
  }
}
