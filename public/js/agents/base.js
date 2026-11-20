// public/js/agents/base.js
// Shared agent unit: identity, status line for the dashboard and counters.

export class BaseAgent {
  constructor(role, label, bus, { badge = '', hint = '' } = {}) {
    this.role = role;
    this.label = label;
    this.bus = bus;
    this.badge = badge;
    this.hint = hint;
    this.state = 'idle';
    this.line = 'standing by';
    this.counters = {};
    this.lastActiveAt = 0;
  }
  set(state, line) {
    this.state = state;
    this.line = line;
    this.bus.emit('agent:status', { role: this.role, state, line });
  }
  bump(key, n = 1) {
    this.counters[key] = (this.counters[key] || 0) + n;
  }
  view() {
    return { role: this.role, label: this.label, badge: this.badge, hint: this.hint, state: this.state, line: this.line, counters: { ...this.counters } };
  }
}

export const fmtUsd = (n, digits = 2) => `${n < 0 ? '-' : ''}$${Math.abs(n).toLocaleString('en-US', { minimumFractionDigits: digits, maximumFractionDigits: digits })}`;
export const fmtSigned = (n) => `${n >= 0 ? '+' : '-'}$${Math.abs(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
export const fmtPrice = (p) => (p >= 1 ? p.toFixed(4) : p.toFixed(8));
