import { randomBytes } from 'node:crypto';
import { ensure } from './state.mjs';

/** The browser opener sees only a single-use short-lived ticket, never the gateway key. */
export class Invitations {
  constructor({ now = Date.now, ttlMs = 60000 } = {}) { this.now = now; this.ttlMs = ttlMs; this.tickets = new Map(); }
  issue() {
    for (const [ticket, expiry] of this.tickets) if (expiry <= this.now()) this.tickets.delete(ticket);
    ensure(this.tickets.size < 8, 429, 'invitation_capacity', 'Too many pending dashboard invitations');
    const ticket = randomBytes(32).toString('base64url'); this.tickets.set(ticket, this.now() + this.ttlMs); return ticket;
  }
  consume(ticket) {
    const expiry = this.tickets.get(ticket); this.tickets.delete(ticket);
    ensure(typeof ticket === 'string' && expiry > this.now(), 401, 'invitation_expired', 'Dashboard invitation expired or already used');
  }
}
