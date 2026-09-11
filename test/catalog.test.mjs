import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { catalogFile } from '../src/catalog.mjs';
import { codexInvocation } from '../src/codex.mjs';
import { fetchCatalog } from '../scripts/fetch-catalog.mjs';
const entry = { slug: 'chatgpt-web/high', id: 'chatgpt-web/high', base_instructions: 'Fixture instructions', context_window: 90000 };
function home(t) { const p = mkdtempSync(join(tmpdir(), 'c2c-cat-')); t.after(() => rmSync(p, { recursive: true, force: true })); return p; }
test('catalog is content-addressed under pool state, not Codex configuration', t => {
  const root = home(t); const a = catalogFile(root, [entry]); const b = catalogFile(root, [entry]);
  assert.equal(a, b); assert(a.startsWith(join(root, 'catalogs')));
  const parsed = JSON.parse(readFileSync(a)); assert.equal(parsed.models[0].base_instructions, entry.base_instructions);
  assert.equal(parsed.models[0].tool_mode, null); assert.equal(parsed.models[0].use_responses_lite, false);
});
test('catalog refuses missing metadata, duplicate slugs and zero models', t => {
  const root = home(t);
  for (const list of [[], [entry, entry], [{ id: entry.id }], [{ ...entry, context_window: -1 }]]) assert.throws(() => catalogFile(root, list), e => e.code === 'invalid_catalog');
});
test('catalog changes produce separate paths and do not mutate source objects', t => {
  const root = home(t); const e = { ...entry, tool_mode: 'code_mode_only' };
  assert.notEqual(catalogFile(root, [e]), catalogFile(root, [{ ...e, context_window: 80000 }]));
  assert.equal(e.tool_mode, 'code_mode_only');
});
test('wrapper passes optional catalog path only through process override', t => {
  const path = catalogFile(home(t), [entry]);
  const invocation = codexInvocation({ endpoint: 'http://127.0.0.1:7841', token: 'test-key', model: entry.id, catalogPath: path });
  assert(invocation.args.includes(`model_catalog_json=${JSON.stringify(path)}`)); assert(!invocation.args.join(' ').includes('test-key'));
});
test('cached public templates with wrong Git hash are rejected without replacement', async t => {
  const dest = join(home(t), 'public.json'); writeFileSync(dest, '{"models":[]}');
  await assert.rejects(fetchCatalog(dest), /pinned Git blob/); assert.equal(readFileSync(dest, 'utf8'), '{"models":[]}');
});
