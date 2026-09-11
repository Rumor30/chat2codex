import { join } from 'node:path';
import { ensure, opaque, readJson, writeJson } from './state.mjs';

function metadata(value) {
  if (typeof value === 'string') { try { return JSON.parse(value); } catch { return {}; } }
  return value && typeof value === 'object' ? value : {};
}
const terminalToolResult = item => item && ['function_call_output', 'custom_tool_call_output', 'tool_search_output'].includes(item.type);
export class Router {
  constructor(home) {
    this.file = join(home, 'routes.json');
    const saved = readJson(this.file, { version: 1, threads: [] });
    ensure(saved.version === 1 && Array.isArray(saved.threads), 500, 'invalid_routes', 'Unsupported route store');
    ensure(saved.threads.length <= 1000 && saved.threads.every(t => t && typeof t.id === 'string' && typeof t.accountId === 'string'
      && typeof t.generation === 'string' && typeof t.model === 'string' && Array.isArray(t.responses) && t.responses.every(id => typeof id === 'string')
      && Array.isArray(t.pending) && t.pending.every(id => typeof id === 'string')
      && ['ready', 'in_flight', 'waiting_tools', 'uncertain', 'failed', 'cancelled', 'retired'].includes(t.state))
      && new Set(saved.threads.map(t => t.id)).size === saved.threads.length, 500, 'invalid_routes', 'Malformed route records; state was not overwritten');
    this.threads = new Map(saved.threads.map(t => [t.id, t])); this.busy = new Set();
    for (const t of this.threads.values()) if (t.state === 'in_flight') t.state = 'uncertain';
  }
  save() { writeJson(this.file, { version: 1, threads: [...this.threads.values()] }); }
  counts(accountId) { return [...this.threads.values()].filter(t => t.accountId === accountId && t.state !== 'retired').length; }
  acquire(body, headers, workers, accounts) {
    ensure(body.input === undefined || typeof body.input === 'string' || Array.isArray(body.input), 400, 'invalid_input', 'Responses input must be text or an item array');
    ensure(body.tools === undefined || Array.isArray(body.tools), 400, 'invalid_tools', 'Tools must be an array');
    ensure(body.previous_response_id === undefined || body.previous_response_id === null || typeof body.previous_response_id === 'string', 400, 'invalid_response_id', 'previous_response_id must be a string');
    const meta = metadata(body.client_metadata?.['x-codex-turn-metadata'] || headers['x-codex-turn-metadata']);
    ensure(!headers['x-chat2codex-thread'] || !meta.thread_id || headers['x-chat2codex-thread'] === meta.thread_id, 409, 'identity_conflict', 'Gateway and native thread identities do not match');
    let id = headers['x-chat2codex-thread'] || meta.thread_id || body.prompt_cache_key;
    ensure(id === undefined || (typeof id === 'string' && id.length > 0 && id.length <= 512), 400, 'bad_thread', 'Invalid thread identity');
    const previous = body.previous_response_id;
    if (previous) {
      const owner = [...this.threads.values()].find(t => t.responses.includes(previous));
      ensure(owner, 409, 'unknown_response', 'Unknown previous_response_id; do not replay this continuation to a different account');
      ensure(!id || id === owner.id, 409, 'identity_conflict', 'Response and thread identities do not match'); id = owner.id;
    }
    const input = Array.isArray(body.input) ? body.input : [];
    const tail = []; for (let i = input.length - 1; i >= 0 && terminalToolResult(input[i]); i--) tail.unshift(input[i]);
    if (!id && tail.length) {
      const owner = [...this.threads.values()].find(t => t.pending.includes(tail[0].call_id));
      ensure(owner, 409, 'orphan_tool_result', 'No pending tool call matches this result'); id = owner.id;
    }
    ensure(id || !body.tools?.length, 400, 'thread_required', 'Tool-enabled requests need Codex thread metadata, prompt_cache_key, or X-Chat2Codex-Thread');
    id ||= opaque('thread');
    ensure(!this.busy.has(id), 409, 'thread_busy', 'A request for this thread is already active');
    let t = this.threads.get(id); const existed = !!t;
    const pin = headers['x-chat2codex-account'];
    if (!t) {
      ensure(!tail.length, 409, 'orphan_tool_result', 'A new thread cannot start with tool results');
      ensure(this.threads.size < 1000, 503, 'route_capacity', 'Release idle thread bindings before starting more threads');
      const candidates = accounts.filter(a => a.enabled && !a.archived && (!pin || pin === a.id))
        .map(a => ({ a, w: workers.get(a.id) })).filter(({ a, w }) => w?.ready && w.models.some(m => m.id === body.model) && this.counts(a.id) < a.maxThreads)
        .sort((a, b) => this.counts(a.a.id) - this.counts(b.a.id) || a.a.id.localeCompare(b.a.id));
      ensure(candidates.length, 503, 'no_ready_account', 'No enabled, verified account has this model and a free thread slot');
      const { a, w } = candidates[0];
      t = { id, accountId: a.id, generation: w.generation, model: body.model, state: 'ready', pending: [], responses: [], touchedAt: Date.now() };
      // Commit admission only after every preflight validation succeeds.
    }
    ensure(!pin || pin === t.accountId, 409, 'account_conflict', 'This thread is already pinned to another account');
    ensure(t.state !== 'retired', 409, 'thread_retired', 'Start a new Codex thread after retiring a conversation');
    ensure(!['uncertain', 'failed', 'cancelled'].includes(t.state), 409, 'thread_uncertain', 'This thread needs explicit retirement; automatic replay could duplicate tool effects');
    const worker = workers.get(t.accountId);
    ensure(worker?.ready, 503, 'bound_account_unavailable', 'The bound account is unavailable; no account switching was attempted');
    ensure(worker.generation === t.generation, 409, 'worker_restarted', 'The bound worker restarted; start a new task instead of replaying old tool state');
    ensure(worker.models.some(m => m.id === body.model), 400, 'model_unavailable', 'The bound account does not expose the requested model');
    // Historical receipts need a preceding declaration. New receipts must match this active round.
    const declared = new Set(); const seen = new Set();
    for (const item of input) {
      if (['function_call', 'custom_tool_call', 'tool_search_call'].includes(item?.type)) declared.add(item.call_id);
      if (!terminalToolResult(item)) continue;
      ensure(typeof item.call_id === 'string', 400, 'invalid_tool_result', 'Tool result lacks call_id');
      ensure(!seen.has(item.call_id), 409, 'tool_result_mismatch', 'A tool result was supplied more than once');
      seen.add(item.call_id);
      ensure(t.pending.includes(item.call_id) || declared.has(item.call_id), 409, t.pending.length ? 'tool_result_mismatch' : 'orphan_tool_result', 'Unknown tool result was not dispatched by this thread');
    }
    if (t.pending.length) {
      ensure(body.model === t.model, 409, 'model_conflict', 'Settle pending tools before changing the model');
      const ids = input.filter(i => terminalToolResult(i) && t.pending.includes(i.call_id)).map(i => i.call_id);
      ensure(new Set(ids).size === ids.length && ids.length === t.pending.length && ids.every(id => t.pending.includes(id)),
        409, 'tool_result_mismatch', 'Return exactly the pending tool results, with their original call_id values');
    } else ensure(!tail.length, 409, 'orphan_tool_result', 'No tool calls are pending on this thread');
    const before = structuredClone(t);
    t.model = body.model; t.state = 'in_flight'; t.touchedAt = Date.now(); this.busy.add(id); this.threads.set(id, t);
    try { this.save(); } catch (error) {
      this.busy.delete(id); if (existed) this.threads.set(id, before); else this.threads.delete(id); throw error;
    }
    return { thread: t, worker, submitted: [...t.pending] };
  }
  observe(lease, event) {
    const t = lease.thread;
    ensure(!lease.terminal, 502, 'duplicate_terminal', 'Upstream emitted events after its terminal response');
    const r = event.response;
    if (['response.completed', 'response.failed', 'response.incomplete', 'json'].includes(event.type)) {
      ensure(r && typeof r.id === 'string' && Array.isArray(r.output), 502, 'invalid_terminal', 'Terminal response must carry an id and output array');
      if (event.type === 'response.completed') ensure(r.status === 'completed', 502, 'invalid_terminal', 'Completion event and response status disagree');
    }
    if (r?.id && !t.responses.includes(r.id)) {
      ensure(![...this.threads.values()].some(other => other.id !== t.id && other.responses.includes(r.id)), 502, 'response_collision', 'Upstream response ID collision');
      t.responses.push(r.id); if (t.responses.length > 256) t.responses.shift(); this.save();
    }
    if (event.type === 'response.completed' || (r?.status === 'completed' && event.type === 'json')) {
      const calls = (r.output || []).filter(i => ['function_call', 'custom_tool_call', 'tool_search_call'].includes(i.type));
      ensure(calls.every(c => typeof c.call_id === 'string' && c.call_id.length > 0), 502, 'bad_tool_call', 'Upstream tool call lacks call_id');
      t.pending = calls.map(c => c.call_id);
      ensure(new Set(t.pending).size === t.pending.length, 502, 'duplicate_call', 'Upstream repeated a call_id');
      t.state = t.pending.length ? 'waiting_tools' : 'ready'; lease.terminal = true; this.save();
    } else if (['response.failed', 'response.incomplete', 'error'].includes(event.type) || (event.type === 'json' && r?.status && r.status !== 'completed')) {
      t.state = 'failed'; lease.terminal = true; this.save();
    }
  }
  finish(lease, success = false) {
    if ((!success || !lease.terminal) && lease.thread.state !== 'cancelled') lease.thread.state = 'uncertain';
    lease.thread.touchedAt = Date.now(); this.busy.delete(lease.thread.id); this.save();
  }
  release(id) {
    const t = this.threads.get(id); ensure(t, 404, 'thread_not_found', 'Unknown thread');
    ensure(!this.busy.has(id) && t.state === 'ready' && t.pending.length === 0, 409, 'thread_not_idle', 'Only a fully completed idle thread may be released');
    t.state = 'retired'; t.touchedAt = Date.now(); this.save();
  }
}
