import { lstatSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { ensure } from './state.mjs';

export const SESSION_COOKIE_BASES = Object.freeze([
  '__Secure-next-auth.session-token',
  '__Secure-authjs.session-token',
]);

function cookieValue(text) {
  const source = text.replace(/^Cookie:\s*/i, '');
  const pairs = new Map();
  for (const part of source.split(';')) {
    const index = part.indexOf('=');
    if (index < 1) continue;
    pairs.set(part.slice(0, index).trim(), part.slice(index + 1).trim());
  }
  for (const base of SESSION_COOKIE_BASES) {
    if (pairs.has(base)) return pairs.get(base);
    const chunks = [...pairs.entries()]
      .map(([name, value]) => {
        const match = new RegExp(`^${base.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\.(\\d+)$`).exec(name);
        return match ? [Number(match[1]), value] : null;
      })
      .filter(Boolean)
      .sort((a, b) => a[0] - b[0]);
    if (chunks.length && chunks.every(([index], position) => index === position)) return chunks.map(([, value]) => value).join('');
  }
}

export function parseSessionSecret(value) {
  ensure(typeof value === 'string', 400, 'invalid_session_secret', 'Session input must be text');
  let text = value.trim();
  ensure(text.length > 0 && text.length <= 65536, 400, 'invalid_session_secret', 'Session input is empty or too large');
  if (text.startsWith('{')) {
    let decoded;
    try { decoded = JSON.parse(text); } catch { decoded = null; }
    if (decoded && typeof decoded === 'object' && !Array.isArray(decoded)) {
      ensure(typeof decoded.sessionToken === 'string' && decoded.sessionToken.trim(), 400, 'session_token_required', 'JSON imports must contain sessionToken; accessToken alone is not accepted');
      text = decoded.sessionToken.trim();
    }
  } else if (/^(?:Cookie:\s*)?[^\r\n]*session-token(?:\.\d+)?=/i.test(text)) {
    const extracted = cookieValue(text);
    ensure(extracted, 400, 'session_token_required', 'Cookie input does not contain a complete supported ChatGPT session token');
    text = extracted;
  }
  ensure(text.length >= 32 && text.length <= 32768 && !/[\u0000-\u0020\u007f]/.test(text), 400, 'invalid_session_secret', 'Session token has an invalid shape');
  return text;
}

async function readAll(stream, limit = 65536) {
  const chunks = []; let size = 0;
  for await (const chunk of stream) { size += chunk.length; ensure(size <= limit, 413, 'session_input_too_large', 'Session input exceeded the size limit'); chunks.push(chunk); }
  return Buffer.concat(chunks).toString('utf8');
}

async function hiddenInput(input, output) {
  if (!input.isTTY || typeof input.setRawMode !== 'function') return readAll(input);
  output.write('Paste ChatGPT session key (hidden) and press Enter: ');
  return new Promise((resolveValue, reject) => {
    let value = ''; const priorRaw = input.isRaw;
    const finish = (error) => {
      input.off('data', onData); try { input.setRawMode(Boolean(priorRaw)); } catch {} output.write('\n');
      if (error) reject(error); else resolveValue(value);
    };
    const onData = chunk => {
      for (const byte of Buffer.from(chunk)) {
        if (byte === 3) return finish(Object.assign(new Error('Session import cancelled'), { code: 'operation_cancelled' }));
        if (byte === 13 || byte === 10) return finish();
        if (byte === 8 || byte === 127) { value = value.slice(0, -1); continue; }
        ensure(value.length < 65536, 413, 'session_input_too_large', 'Session input exceeded the size limit');
        value += Buffer.from([byte]).toString('utf8');
      }
    };
    input.setRawMode(true); input.resume(); input.on('data', onData);
  });
}

export async function readSessionSecret({ file, input = process.stdin, output = process.stderr } = {}) {
  let raw;
  if (file) {
    const path = resolve(file); const stat = lstatSync(path);
    ensure(stat.isFile() && !stat.isSymbolicLink(), 400, 'unsafe_session_file', 'Session file must be a regular file, not a symlink');
    if (process.platform !== 'win32') ensure((stat.mode & 0o077) === 0, 400, 'unsafe_session_file', 'Session file must not be readable by group or others (chmod 600)');
    ensure(stat.size <= 65536, 413, 'session_input_too_large', 'Session file exceeded the size limit');
    raw = readFileSync(path, 'utf8');
  } else raw = await hiddenInput(input, output);
  return parseSessionSecret(raw);
}
