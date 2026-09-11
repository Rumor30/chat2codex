import { join } from 'node:path';
import { readJson, writeJson } from './state.mjs';

/** A small allowlisted audit ring, not a request/prompt logger. */
export class Diagnostics {
  constructor(home) { this.file = join(home, 'diagnostics.json'); this.events = readJson(this.file, { version: 1, events: [] }).events || []; }
  record(kind, { accountId, code, status } = {}) {
    if (!/^[a-z0-9_]{1,64}$/.test(kind)) return;
    const entry = { at: new Date().toISOString(), kind };
    if (/^acct_[a-f0-9]{32}$/.test(accountId || '')) entry.accountId = accountId;
    if (/^[a-z0-9_]{1,80}$/.test(code || '')) entry.code = code;
    if (Number.isInteger(status)) entry.status = status;
    this.events.push(entry); this.events = this.events.slice(-100); writeJson(this.file, { version: 1, events: this.events });
  }
  report() { return { version: 1, generatedAt: new Date().toISOString(), events: structuredClone(this.events) }; }
}
