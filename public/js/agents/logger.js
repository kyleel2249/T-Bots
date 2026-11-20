// public/js/agents/logger.js
// LOGGER: no trade without a reason. Subscribes to trade events and writes every
// ENTER / EXIT / FILTERED / SYS line with reason, size, fill price and PnL.

import { BaseAgent, fmtPrice, fmtSigned } from './base.js';

export class LoggerAgent extends BaseAgent {
  constructor(bus, cfg, clock) {
    super('LOGGER', 'Logger', bus, { badge: 'WRITE', hint: 'writes every decision' });
    this.clock = clock;
    this.lines = [];
    this.seq = 0;
    bus.on('trade:enter', (e) => this.push('ENTER', e));
    bus.on('trade:exit', (e) => this.push('EXIT', e));
    bus.on('trade:filtered', (e) => this.push('FILTERED', e));
    bus.on('sys', (e) => this.push('SYS', e));
    this.set('idle', 'no trade without a reason');
  }

  push(type, o) {
    const line = {
      seq: ++this.seq,
      t: this.clock.elapsed,
      clock: this.clock.label(),
      type,
      symbol: o.symbol || '',
      reason: o.reason || '',
      sizePct: o.sizePct ?? null,
      sizeUsd: o.sizeUsd ?? null,
      price: o.price ?? null,
      pnl: o.pnl ?? null,
      multiple: o.multiple ?? null,
      partial: !!o.partial,
    };
    this.lines.push(line);
    if (this.lines.length > 6000) this.lines.shift();
    if (type !== 'SYS') this.set('write', `line #${line.seq} · ${type.toLowerCase()} ${line.symbol ? '$' + line.symbol : ''}`);
    this.bus.emit('log:line', line);
    return line;
  }

  tail(n = 8) {
    return this.lines.slice(-n);
  }

  static format(l) {
    const parts = [l.clock, l.type.padEnd(8)];
    if (l.symbol) parts.push(`$${l.symbol}`);
    if (l.sizePct !== null) parts.push(`size ${Math.round(l.sizePct * 100)}%`);
    if (l.price !== null) parts.push(`fill ${fmtPrice(l.price)}`);
    if (l.pnl !== null) parts.push(`pnl ${fmtSigned(l.pnl)}`);
    if (l.reason) parts.push(`| ${l.reason}`);
    return parts.join(' ');
  }

  toText() {
    return this.lines.map(LoggerAgent.format).join('\n');
  }
}
