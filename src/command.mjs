import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { Fault } from './state.mjs';
/** Execute npm's JS entry directly on Windows instead of interpolating model args into cmd.exe. */
export function codexCommand(executable = 'codex', { platform = process.platform, env = process.env } = {}) {
  if (/\.(?:mjs|cjs|js)$/i.test(executable)) {
    if (!existsSync(executable)) throw new Fault(400, 'codex_missing', 'Configured Codex JavaScript entry does not exist');
    return { executable: process.execPath, prefix: [resolve(executable)] };
  }
  if (platform !== 'win32') return { executable, prefix: [] };
  const isBatch = /\.(?:cmd|bat)$/i.test(executable);
  if (executable !== 'codex' && !isBatch) return { executable, prefix: [] };
  const pathKey = Object.keys(env).find(k => k.toLowerCase() === 'path');
  const directories = isBatch ? [dirname(resolve(executable))] : (env[pathKey] || '').split(';').map(p => p.replace(/^"|"$/g, '')).filter(Boolean);
  for (const directory of directories) {
    const binary = join(directory, 'codex.exe');
    if (!isBatch && existsSync(binary)) return { executable: binary, prefix: [] };
    for (const entry of [join(directory, 'node_modules/@openai/codex/bin/codex.js'), join(directory, '../@openai/codex/bin/codex.js')]) {
      if (existsSync(entry)) return { executable: process.execPath, prefix: [resolve(entry)] };
    }
  }
  throw new Fault(400, 'codex_missing', 'Install Codex CLI, or set CHAT2CODEX_CODEX to its codex.exe or @openai/codex/bin/codex.js path. Batch wrappers are not executed through a shell.');
}
