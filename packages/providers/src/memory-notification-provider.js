// @ts-check

import { randomUUID } from 'node:crypto';
import { nowIso } from '../../core/src/time.js';

export class MemoryNotificationProvider {
  constructor() {
    /** @type {Array<{id: string, channel: string, recipient: string, subject: string, body: string, createdAt: string}>} */
    this.messages = [];
  }

  /** @param {{channel?: string, recipient: string, subject: string, body: string}} input */
  async send(input) {
    const message = {
      id: randomUUID(),
      channel: input.channel ?? 'in_app',
      recipient: input.recipient,
      subject: input.subject,
      body: input.body,
      createdAt: nowIso(),
    };
    this.messages.push(message);
    return message;
  }

  list() {
    return [...this.messages].reverse();
  }
}
