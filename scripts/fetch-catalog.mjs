import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
export const CATALOG_BLOB = 'c9b4d6ce6e85acc87c236e83421e3b4520e1a5a0';
export async function fetchCatalog(destination) {
  let bytes;
  if (existsSync(destination)) bytes = readFileSync(destination);
  else {
    const response = await fetch('https://raw.githubusercontent.com/openai/codex/rust-v0.154.0/codex-rs/models-manager/models.json', { signal: AbortSignal.timeout(30000), redirect: 'error' });
    if (!response.ok) throw new Error('Could not download the public Codex catalog template');
    bytes = Buffer.from(await response.arrayBuffer());
  }
  const hash = createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex');
  if (hash !== CATALOG_BLOB) throw new Error('Public Codex catalog does not match its pinned Git blob');
  mkdirSync(dirname(destination), { recursive: true });
  const licensePath = `${destination}.LICENSE`;
  let license;
  if (existsSync(licensePath)) license = readFileSync(licensePath);
  else {
    const response = await fetch('https://raw.githubusercontent.com/openai/codex/rust-v0.154.0/LICENSE', { signal: AbortSignal.timeout(30000), redirect: 'error' });
    if (!response.ok) throw new Error('Could not retain the public Codex catalog license');
    license = Buffer.from(await response.arrayBuffer());
  }
  const licenseHash = createHash('sha1').update(`blob ${license.length}\0`).update(license).digest('hex');
  if (licenseHash !== '4606e72e042564097e8780d66c1d4dcb611869bd') throw new Error('Public Codex license does not match its pinned Git blob');
  writeFileSync(licensePath, license);
  writeFileSync(destination, bytes);
  return JSON.parse(bytes.toString('utf8'));
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  fetchCatalog(resolve(process.argv[2] || '.runtime/codex-catalog.json')).catch(e => { console.error(e.message); process.exitCode = 1; });
}
