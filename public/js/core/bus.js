// public/js/core/bus.js
// Minimal synchronous pub/sub used for all agent-to-agent communication.

export class EventBus {
  constructor() {
    this.handlers = new Map();
  }
  on(topic, fn) {
    if (!this.handlers.has(topic)) this.handlers.set(topic, new Set());
    this.handlers.get(topic).add(fn);
    return () => this.handlers.get(topic)?.delete(fn);
  }
  emit(topic, payload) {
    for (const fn of this.handlers.get(topic) || []) fn(payload, topic);
    for (const fn of this.handlers.get('*') || []) fn(payload, topic);
  }
}
