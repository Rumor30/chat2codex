import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { applyProfileOverlay, ownedOverlayChanges, gitBlob, OVERLAY_PATH } from '../scripts/overlay.mjs';
const original = 'export const DEV_CONFIG_PURPOSE = "dev-harness" as const;\nexport const DEV_LAUNCHER_PROFILE = "development" as const;\nexport const DEV_TUNNEL_BASE_NAME = "codex-chatgpt-web-dev" as const;\n';
function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'c2c-overlay-')); t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, 'src/dev-chat'), { recursive: true });
  const target = join(root, OVERLAY_PATH); const source = join(root, 'replacement.ts');
  writeFileSync(target, original); writeFileSync(source, '// owned replacement\n'); return { root, target, source };
}
test('overlay matches the exact pinned upstream Git blob', () => assert.equal(gitBlob(Buffer.from(original)), '4e9c9a27f09467d922a49ac0331dc0e91ac548f4'));
test('overlay applies once and repeat bootstrap is idempotent', t => {
  const { root, target, source } = fixture(t); applyProfileOverlay(root, source); applyProfileOverlay(root, source);
  assert.equal(readFileSync(target, 'utf8'), '// owned replacement\n'); assert(ownedOverlayChanges(root, source, [OVERLAY_PATH]));
});
test('overlay refuses unexpected source edits', t => {
  const { root, target, source } = fixture(t); writeFileSync(target, original + '// user edit\n');
  assert.throws(() => applyProfileOverlay(root, source), /unverified overlay/); assert(readFileSync(target, 'utf8').endsWith('// user edit\n'));
});
test('only exact owned changes pass tracked-file validation', t => {
  const { root, target, source } = fixture(t); applyProfileOverlay(root, source);
  assert(!ownedOverlayChanges(root, source, ['src/server.ts'])); writeFileSync(target, '// different\n');
  assert(!ownedOverlayChanges(root, source, [OVERLAY_PATH])); assert(ownedOverlayChanges(root, source, []));
});
