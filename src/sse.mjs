import { ensure } from './state.mjs';
/** Observe framing only. The gateway forwards original bytes, not reconstructed SSE. */
export class EventObserver {
  constructor(onEvent, maxFrame = 8 * 1024 * 1024) { this.onEvent = onEvent; this.maxFrame = maxFrame; this.buffer = ''; this.decoder = new TextDecoder(); }
  push(bytes) { this.buffer += this.decoder.decode(bytes, { stream: true }); this.drain(); }
  drain() {
    let boundary;
    while ((boundary = /\r?\n\r?\n/.exec(this.buffer))) {
      const frame = this.buffer.slice(0, boundary.index); this.buffer = this.buffer.slice(boundary.index + boundary[0].length);
      ensure(frame.length <= this.maxFrame, 502, 'sse_too_large', 'Upstream SSE frame exceeded the limit');
      const lines = frame.split(/\r?\n/); const data = lines.filter(l => l.startsWith('data:')).map(l => l.slice(5).replace(/^ /, '')).join('\n');
      if (!data || data === '[DONE]') continue;
      let event; try { event = JSON.parse(data); } catch { throw Object.assign(new Error('Malformed upstream SSE JSON'), { status: 502, code: 'invalid_sse' }); }
      this.onEvent(event);
    }
    ensure(this.buffer.length <= this.maxFrame, 502, 'sse_too_large', 'Unterminated upstream SSE frame exceeded the limit');
  }
  end() { this.buffer += this.decoder.decode(); this.drain(); ensure(!this.buffer.trim(), 502, 'truncated_sse', 'Upstream closed with an incomplete SSE frame'); }
}
