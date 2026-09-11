import { createHash } from 'node:crypto';
import { closeSync, existsSync, fsyncSync, lstatSync, openSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ensure } from './state.mjs';

/** Append-only replay fence. Finished conversations do not consume active routing slots. */
export class RetiredThreads {
  constructor(home) {
    this.file = join(home, 'retired-threads.log'); this.ids = new Set();
    if (!existsSync(this.file)) return;
    const stat = lstatSync(this.file);
    ensure(stat.isFile() && !stat.isSymbolicLink() && stat.size <= 128 * 1024 * 1024, 500, 'invalid_retirement_log', 'Retirement log is unsafe or too large');
    const text = readFileSync(this.file, 'utf8');
    ensure(!text || text.endsWith('\n'), 500, 'invalid_retirement_log', 'Retirement log was interrupted; restore a valid backup before reusing this pool');
    for (const line of text.split('\n').filter(Boolean)) {
      ensure(/^[a-f0-9]{64}$/.test(line), 500, 'invalid_retirement_log', 'Invalid retirement log entry'); this.ids.add(line);
    }
  }
  hash(id) { return createHash('sha256').update(id).digest('hex'); }
  has(id) { return this.ids.has(this.hash(id)); }
  add(id) {
    const digest = this.hash(id); if (this.ids.has(digest)) return;
    // Fence it in memory even when persistence fails; never replay an ambiguous retirement.
    this.ids.add(digest);
    ensure(!existsSync(this.file) || !lstatSync(this.file).isSymbolicLink(), 500, 'unsafe_path', 'Retirement log must not be a symlink');
    const fd = openSync(this.file, 'a', 0o600);
    try { writeFileSync(fd, `${digest}\n`); fsyncSync(fd); } finally { closeSync(fd); }
  }
}
