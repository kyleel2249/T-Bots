// public/js/agents/sizer.js
// SIZER: size from current equity, never a fixed ticket. Conviction (signal count) scales
// the size between min and max; a loss streak scales it down; profits compound.

import { BaseAgent } from './base.js';

const MAX_SIGNALS = 5;

export class SizerAgent extends BaseAgent {
  constructor(bus, cfg) {
    super('SIZER', 'Sizer', bus, { badge: 'IDLE', hint: 'sizes from account equity' });
    this.cfg = cfg;
    this.set('idle', 'never trades a fixed ticket');
  }

  size({ equity, available, signals, lossStreak, openCount }) {
    const c = this.cfg.sizer;
    if (openCount >= c.maxOpen) return { ok: false, reason: `max ${c.maxOpen} open positions` };
    const span = Math.max(1, MAX_SIGNALS - this.cfg.scanner.minSignals);
    const conviction = Math.min(1, Math.max(0, (signals - this.cfg.scanner.minSignals) / span));
    let pct = c.minPct + (c.maxPct - c.minPct) * conviction;
    const scaled = lossStreak >= c.lossStreak;
    if (scaled) pct *= c.scaleDown;
    const base = this.cfg.rules.compound ? equity : this.cfg.session.startBalance;
    const usd = Math.min(base * pct, available * 0.98);
    if (!(usd >= 1)) return { ok: false, reason: 'insufficient free cash' };
    this.bump('sized');
    this.set('live', `${Math.round((usd / equity) * 100)}% of $${equity.toFixed(0)}${scaled ? ' (scaled down)' : ''}`);
    return { ok: true, usd, pct: usd / equity, scaled };
  }
}
