import { spawn } from 'node:child_process';
import { ensure } from './state.mjs';
export function openLocal(url) {
  const parsed = new URL(url);
  ensure(parsed.origin.startsWith('http://127.0.0.1:') && parsed.hostname === '127.0.0.1' && !parsed.username && !parsed.password, 400, 'bad_url', 'Only local dashboard URLs may be opened');
  const [command, args] = process.platform === 'win32' ? ['rundll32.exe', ['url.dll,FileProtocolHandler', url]]
    : process.platform === 'darwin' ? ['open', [url]] : ['xdg-open', [url]];
  const child = spawn(command, args, { shell: false, stdio: 'ignore', detached: true }); child.unref();
  return new Promise((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject); });
}
