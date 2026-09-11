import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { codexCommand } from '../src/command.mjs';
function fixture(t) { const root = mkdtempSync(join(tmpdir(), 'c2c-command-')); t.after(() => rmSync(root, { recursive: true, force: true })); return root; }
test('explicit JavaScript Codex entry bypasses shell wrappers', t => {
  const file = join(fixture(t), 'codex.js'); writeFileSync(file, '');
  assert.deepEqual(codexCommand(file), { executable: process.execPath, prefix: [file] });
});
test('Windows global npm layout resolves to its JS entry without cmd.exe', t => {
  const root = fixture(t); const dir = join(root, 'node_modules/@openai/codex/bin'); mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'codex.js'), '');
  assert.deepEqual(codexCommand('codex', { platform: 'win32', env: { Path: root } }), { executable: process.execPath, prefix: [join(dir, 'codex.js')] });
});
test('Windows real binary is preferred and missing batch runtime fails explicitly', t => {
  const root = fixture(t); const binary = join(root, 'codex.exe'); writeFileSync(binary, '');
  assert.deepEqual(codexCommand('codex', { platform: 'win32', env: { PATH: root } }), { executable: binary, prefix: [] });
  assert.throws(() => codexCommand(join(root, 'unknown.cmd'), { platform: 'win32', env: {} }), e => e.code === 'codex_missing');
});
test('Unix native executable is not parsed or interpolated by a shell', () => {
  assert.deepEqual(codexCommand('/a path/codex', { platform: 'linux', env: {} }), { executable: '/a path/codex', prefix: [] });
});
