// public/js/agents/equity.js
// EQUITY: owns the account ledger. Balance = cash + marked open positions. Updates the
// win/loss record and the equity curve on every close.

import { BaseAgent } from './base.js';

export class EquityAgent extends BaseAgent {
  constructor(bus, cfg) {
    super('EQUITY', 'Equity', bus, { badge: 'UPDATE', hint: 'balance + curve' });
    this.start = cfg.session.startBalance;
    this.cash = this.start;
    this.positionsValue = 0;
    this.peak = this.start;
    this.trades = 0;
    this.wins = 0;
    this.losses = 0;
    this.lossStreak = 0;
    this.realized = 0;
    this.closed = [];
    this.curve = [{ t: 0, balance: this.start }];
    this.now = () => 0;
    bus.on('trade:closed', (rec) => this.onClosed(rec));
    this.set('idle', 'updates on every close');
  }

  get balance() {
    return this.cash + this.positionsValue;
  }
  debit(a) {
    if (a > this.cash + 1e-9) throw new Error('insufficient cash');
    this.cash -= a;
  }
  credit(a) {
    this.cash += a;
  }
  mark(value) {
    this.positionsValue = value;
    if (this.balance > this.peak) this.peak = this.balance;
  }
  sample(t) {
    this.curve.push({ t, balance: this.balance });
    if (this.curve.length > 4000) this.curve.splice(1, 1);
  }

  onClosed(rec) {
    this.trades++;
    this.realized += rec.pnl;
    if (rec.pnl > 0) {
      this.wins++;
      this.lossStreak = 0;
    } else {
      this.losses++;
      this.lossStreak++;
    }
    this.closed.push(rec);
    this.sample(rec.t);
    this.set('write', `$${this.balance.toFixed(2)} · ${this.trades} closes`);
  }

  recap() {
    const sorted = [...this.closed].sort((a, b) => b.pnl - a.pnl);
    const byCoin = new Map();
    for (const r of this.closed) byCoin.set(r.symbol, (byCoin.get(r.symbol) || 0) + r.pnl);
    const top = [...byCoin.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3).map(([symbol, pnl]) => ({ symbol, pnl }));
    return {
      start: this.start,
      end: this.balance,
      returnPct: ((this.balance / this.start - 1) * 100),
      trades: this.trades,
      wins: this.wins,
      losses: this.losses,
      best: sorted[0] ? { symbol: sorted[0].symbol, pnl: sorted[0].pnl } : null,
      worst: sorted.length ? { symbol: sorted[sorted.length - 1].symbol, pnl: sorted[sorted.length - 1].pnl } : null,
      topCoins: top,
      maxDrawdownPct: this.maxDrawdown(),
    };
  }

  maxDrawdown() {
    let peak = -Infinity;
    let dd = 0;
    for (const p of this.curve) {
      peak = Math.max(peak, p.balance);
      dd = Math.max(dd, (peak - p.balance) / peak);
    }
    return dd * 100;
  }
}
