// Secret provisioning input is read from stdin, never argv or exported browser cookies.
import { activateDevProfileEnvironment } from './src/dev-chat/profile';
import { setupDevProfile } from './src/setup';
activateDevProfileEnvironment();
let raw = '';
for await (const chunk of Bun.stdin.stream()) {
  raw += new TextDecoder().decode(chunk);
  if (raw.length > 16384) throw new Error('Provisioning input exceeds limit');
}
const input = JSON.parse(raw); raw = '';
if (input.consent !== true || !/^tunnel_[a-f0-9]{32}$/.test(input.tunnelId || '') || typeof input.runtimeKey !== 'string' || input.runtimeKey.length < 20) throw new Error('Invalid provisioning input');
await setupDevProfile({ mode: 'full', tunnelId: input.tunnelId, runtimeKeyValue: input.runtimeKey,
  browserInteractionMode: 'automatic', acknowledgedUnofficial: true, refreshAccountCapabilities: true });
input.runtimeKey = '';
console.log('Chat2Codex isolated runtime configured. Connector verification is still required.');
