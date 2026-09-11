import { randomBytes, timingSafeEqual } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync, unlinkSync, openSync, closeSync, lstatSync, chmodSync, fsyncSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

export class Fault extends Error {
  constructor(status, code, message) { super(message); this.status = status; this.code = code; }
}
export function ensure(condition, status, code, message) {
  if (!condition) throw new Fault(status, code, message);
}
export const opaque = prefix => `${prefix}_${randomBytes(16).toString('hex')}`;
export const homePath = () => resolve(process.env.CHAT2CODEX_HOME || join(homedir(), '.chat2codex'));
export function privateDir(path) {
  mkdirSync(path, { recursive: true, mode: 0o700 });
  ensure(!lstatSync(path).isSymbolicLink(), 500, 'unsafe_path', 'State directory must not be a symlink');
  if (process.platform !== 'win32') chmodSync(path, 0o700);
}
export function readJson(path, fallback) {
  try { return JSON.parse(readFileSync(path, 'utf8')); }
  catch (e) { if (e.code === 'ENOENT') return structuredClone(fallback); throw new Fault(500, 'invalid_state', 'State file is unreadable or invalid; it was not overwritten'); }
}
export function writeJson(path, value) {
  ensure(!existsSync(path) || !lstatSync(path).isSymbolicLink(), 500, 'unsafe_path', 'State file must not be a symlink');
  const temporary = `${path}.${opaque('tmp')}`;
  try {
    const fd = openSync(temporary, 'wx', 0o600);
    try { writeFileSync(fd, `${JSON.stringify(value, null, 2)}\n`); fsyncSync(fd); } finally { closeSync(fd); }
    renameSync(temporary, path);
  }
  finally { try { unlinkSync(temporary); } catch (e) { if (e.code !== 'ENOENT') throw e; } }
}
export function recoverLock(path, alive = pid => {
  try { process.kill(pid, 0); return true; } catch (e) { if (e.code === 'ESRCH') return false; return true; }
}) {
  if (!existsSync(path)) return false;
  const before = lstatSync(path);
  ensure(before.isFile() && !before.isSymbolicLink(), 409, 'unsafe_lock', 'Lock is not an ordinary file');
  const text = readFileSync(path, 'utf8').trim();
  ensure(/^[1-9][0-9]{0,10}$/.test(text), 409, 'invalid_lock', 'Lock owner cannot be determined safely');
  if (alive(Number(text))) return false;
  const after = lstatSync(path);
  ensure(before.ino === after.ino && before.dev === after.dev && readFileSync(path, 'utf8').trim() === text, 409, 'lock_changed', 'Lock owner changed during recovery');
  unlinkSync(path); return true;
}
export function lock(path, { reclaim = false } = {}) {
  if (reclaim) recoverLock(path);
  let fd;
  try { fd = openSync(path, 'wx', 0o600); writeFileSync(fd, String(process.pid)); }
  catch (e) { if (e.code === 'EEXIST') throw new Fault(409, 'state_locked', 'Another process owns this state. For a stale lock, verify its PID before removing it.'); throw e; }
  return () => { if (fd === undefined) return; closeSync(fd); fd = undefined; unlinkSync(path); };
}
export class State {
  constructor(home = homePath()) { this.home = resolve(home); privateDir(this.home); this.file = join(this.home, 'accounts.json'); }
  list() {
    const data = readJson(this.file, { version: 1, accounts: [] });
    ensure(data.version === 1 && Array.isArray(data.accounts), 500, 'invalid_state', 'Unsupported account store');
    const ids = new Set();
    for (const a of data.accounts) {
      ensure(/^acct_[a-f0-9]{32}$/.test(a.id) && !ids.has(a.id) && typeof a.label === 'string' && typeof a.enabled === 'boolean'
        && Number.isInteger(a.maxThreads) && a.maxThreads >= 1 && a.maxThreads <= 5, 500, 'invalid_state', 'Invalid account record');
      ids.add(a.id);
    }
    return data.accounts;
  }
  account(id) { const a = this.list().find(a => a.id === id); ensure(a, 404, 'account_not_found', 'Unknown account'); return a; }
  paths(id) {
    this.account(id);
    const home = join(this.home, 'a', id);
    privateDir(home);
    return { home, profile: join(home, 'p'), descriptor: join(home, 'worker.json'), token: join(home, 'worker.key') };
  }
  mutate(fn) {
    const release = lock(`${this.file}.lock`);
    try { const accounts = this.list(); const result = fn(accounts); writeJson(this.file, { version: 1, accounts }); return result; }
    finally { release(); }
  }
  add(label, maxThreads = 1) {
    ensure(typeof label === 'string' && label.trim().length > 0 && label.length <= 100, 400, 'bad_label', 'Use a label between 1 and 100 characters');
    ensure(Number.isInteger(maxThreads) && maxThreads >= 1 && maxThreads <= 5, 400, 'bad_capacity', 'Capacity must be between 1 and 5');
    return this.mutate(accounts => {
      ensure(accounts.length < 100, 409, 'pool_full', 'Account limit reached');
      const a = { id: opaque('acct'), label: label.trim(), enabled: true, maxThreads, createdAt: new Date().toISOString() };
      accounts.push(a); return a;
    });
  }
  enable(id, enabled) { return this.mutate(accounts => { const a = accounts.find(a => a.id === id); ensure(a, 404, 'account_not_found', 'Unknown account'); a.enabled = enabled; return a; }); }
  update(id, { label, maxThreads, archived } = {}) {
    return this.mutate(accounts => {
      const a = accounts.find(a => a.id === id); ensure(a, 404, 'account_not_found', 'Unknown account');
      if (label !== undefined) {
        ensure(typeof label === 'string' && label.trim() && label.length <= 100, 400, 'bad_label', 'Use a label between 1 and 100 characters'); a.label = label.trim();
      }
      if (maxThreads !== undefined) {
        ensure(Number.isInteger(maxThreads) && maxThreads >= 1 && maxThreads <= 5, 400, 'bad_capacity', 'Capacity must be between 1 and 5'); a.maxThreads = maxThreads;
      }
      if (archived !== undefined) { ensure(typeof archived === 'boolean', 400, 'bad_archive', 'Archive must be boolean'); a.archived = archived; if (archived) a.enabled = false; }
      return a;
    });
  }
  token(path = join(this.home, 'gateway.key')) {
    try { writeFileSync(path, randomBytes(32).toString('base64url'), { mode: 0o600, flag: 'wx' }); }
    catch (e) { if (e.code !== 'EEXIST') throw e; }
    ensure(!lstatSync(path).isSymbolicLink(), 500, 'unsafe_path', 'Credential file must not be a symlink');
    const value = readFileSync(path, 'utf8').trim();
    ensure(/^[A-Za-z0-9_-]{43}$/.test(value), 500, 'invalid_key', 'Invalid local gateway key');
    if (process.platform !== 'win32') chmodSync(path, 0o600);
    return value;
  }
}
export function authorized(header, token) {
  const a = Buffer.from(typeof header === 'string' ? header : ''); const b = Buffer.from(`Bearer ${token}`);
  return a.length === b.length && timingSafeEqual(a, b);
}
export function loopbackEndpoint(value) {
  let u; try { u = new URL(value); } catch { throw new Fault(400, 'bad_endpoint', 'Invalid worker endpoint'); }
  ensure(u.protocol === 'http:' && u.hostname === '127.0.0.1' && !u.username && !u.password && !u.search && !u.hash && u.pathname === '/',
    400, 'bad_endpoint', 'Worker endpoint must be an uncredentialed http://127.0.0.1:port origin');
  return u.origin;
}
