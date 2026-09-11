import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
export const OVERLAY_PATH = 'src/dev-chat/constants.ts';
const ORIGINAL_BLOB = '4e9c9a27f09467d922a49ac0331dc0e91ac548f4';
export function gitBlob(bytes) {
  return createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex');
}
export function applyProfileOverlay(root, source) {
  const path = join(root, OVERLAY_PATH);
  const current = readFileSync(path); const replacement = readFileSync(source);
  if (current.equals(replacement)) return;
  if (gitBlob(current) !== ORIGINAL_BLOB) throw new Error('Upstream profile constants changed; refusing to apply an unverified overlay');
  writeFileSync(path, replacement);
}
export function ownedOverlayChanges(root, source, changedPaths) {
  return changedPaths.every(path => path === OVERLAY_PATH && readFileSync(join(root, path)).equals(readFileSync(source)));
}
