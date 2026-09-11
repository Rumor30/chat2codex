import { createHash } from 'node:crypto';
import { join, isAbsolute } from 'node:path';
import { ensure, privateDir, writeJson } from './state.mjs';
export function catalogFile(home, models) {
  ensure(isAbsolute(home) && Array.isArray(models) && models.length > 0, 400, 'invalid_catalog', 'A nonempty verified catalog is required');
  const entries = models.map(model => {
    ensure(model && typeof model.slug === 'string' && model.slug.startsWith('chatgpt-web/') && (typeof model.base_instructions === 'string' || typeof model.model_messages?.instructions_template === 'string')
      && Number.isSafeInteger(model.context_window) && model.context_window > 0, 502, 'invalid_catalog', 'A model is missing native catalog metadata');
    return { ...model, prefer_websockets: false, use_responses_lite: false, tool_mode: null, supports_experimental_context: false };
  });
  ensure(new Set(entries.map(m => m.slug)).size === entries.length, 502, 'invalid_catalog', 'Duplicate model slugs');
  const catalog = { models: entries }; const digest = createHash('sha256').update(JSON.stringify(catalog)).digest('hex');
  const directory = join(home, 'catalogs'); privateDir(directory); const path = join(directory, `${digest}.json`); writeJson(path, catalog); return path;
}
