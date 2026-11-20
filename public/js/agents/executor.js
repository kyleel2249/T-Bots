// public/js/agents/executor.js
// EXECUTOR: opens and closes paper positions, tracks slippage.
// Entries are split in parts; exits follow the take-profit ladder, a breakeven stop once
// the first rung fills, a trailing stop on the runner, a hard stop, a time stop, and an
// instant exit when the dev sells or LP is pulled.

import { BaseAgent } from './base.js';

const EPS = 1e-9;

export class ExecutorAgent extends BaseAgent {
  constructor(bus, cfg, equity, rng, now) {
    super('EXECUTOR', 'Executor', bus, { badge: 'LIVE', hint: 'opens + closes, tracks slip' });
    this.cfg = cfg;
    this.equity = equity;
    this.rng = rng;
    this.now = now;
    this.positions = new Map();
    this.seq = 0;
    this.card = null;
    this.set('idle', `slippage cap ${cfg.executor.maxSlippagePct.toFixed(1)}%`);
  }

  active() {
    return [...this.positions.values()];
  }
  count() {
    return this.positions.size;
  }
  has(tokenId) {
    return [...this.positions.values()].some((p) => p.tokenId === tokenId);
  }
  pendingSpend() {
    let s = 0;
    for (const p of this.positions.values()) s += p.pending * p.partUsd;
    return s;
  }

  _slip(usd, liquidity) {
    if (!(liquidity > 0)) return 95;
    return Math.min(95, (usd / (liquidity / 2)) * 100 + this.rng.float() * 0.4);
  }

  _fillBuy(pos, t, usd) {
    const e = this.cfg.executor;
    const slip = this._slip(usd, t.liquidityUsd);
    const fillPrice = t.price * (1 + slip / 100);
    const qty = (usd * (1 - e.feePct / 100)) / fillPrice;
    this.equity.debit(usd);
    pos.notional += qty * fillPrice;
    pos.qty += qty;
    pos.remaining += qty;
    pos.cost += usd;
    pos.avgEntry = pos.notional / pos.qty;
    pos.slipPct = Math.max(pos.slipPct, slip);
    return { slip, fillPrice };
  }

  /** @returns {{ok:boolean, reason?:string, position?:object}} */
  open(t, sizeUsd, meta) {
    const e = this.cfg.executor;
    const partUsd = sizeUsd / e.splitParts;
    const estSlip = (partUsd / (t.liquidityUsd / 2)) * 100;
    if (!(estSlip <= e.maxSlippagePct)) return { ok: false, reason: `slippage ~${estSlip.toFixed(1)}% > ${e.maxSlippagePct}% cap` };
    const pos = {
      id: ++this.seq,
      tokenId: t.id,
      symbol: t.symbol,
      state: 'open',
      qty: 0,
      remaining: 0,
      cost: 0,
      notional: 0,
      avgEntry: 0,
      slipPct: 0,
      peak: t.price,
      rungs: 0,
      realized: 0,
      proceeds: 0,
      entryAt: this.now(),
      sizeUsd,
      sizePct: meta.sizePct,
      partUsd,
      pending: e.splitParts - 1,
      reason: meta.reason,
      signals: meta.signals,
      lastExit: null,
    };
    const { slip, fillPrice } = this._fillBuy(pos, t, partUsd);
    pos.peak = Math.max(pos.peak, fillPrice);
    this.positions.set(pos.id, pos);
    this.card = pos;
    this.bump('opened');
    this.set('live', `LONG $${t.symbol} slip ${slip.toFixed(1)}%`);
    this.bus.emit('trade:enter', { symbol: t.symbol, reason: meta.reason, sizePct: meta.sizePct, sizeUsd, price: fillPrice });
    return { ok: true, position: pos };
  }

  manage(pos, t, ctx = {}) {
    if (pos.state === 'closed' || !t) return;
    const e = this.cfg.executor;
    if (t.events.devSold || t.events.lpPulled) {
      this._exitAll(pos, t, ctx, t.events.lpPulled ? 'LP pulled · instant exit' : 'dev sold · instant exit');
      return;
    }
    if (pos.pending > 0) {
      const partSlip = (pos.partUsd / (t.liquidityUsd / 2)) * 100;
      const ok = t.price > pos.avgEntry * (1 - e.hardStopPct / 100) && partSlip <= e.maxSlippagePct && this.equity.cash >= pos.partUsd;
      if (ok) {
        this._fillBuy(pos, t, pos.partUsd);
        pos.pending--;
      } else {
        pos.pending = 0;
        pos.sizeUsd = pos.cost;
      }
    }
    pos.peak = Math.max(pos.peak, t.price);
    const mult = t.price / pos.avgEntry;
    const ladder = e.ladder;
    if (pos.rungs === 0 && mult <= 1 - e.hardStopPct / 100) return this._exitAll(pos, t, ctx, `hard stop -${e.hardStopPct}%`);
    if (pos.rungs >= 1 && t.price <= pos.avgEntry) return this._exitAll(pos, t, ctx, 'stop at entry after first take-profit');
    while (pos.state === 'open' && pos.rungs < ladder.length && mult >= ladder[pos.rungs].x) {
      const rung = ladder[pos.rungs];
      const qty = Math.min(pos.remaining, (pos.qty * rung.sellPct) / 100);
      pos.rungs++;
      this._sell(pos, t, qty, `TP ${rung.x}× · sold ${rung.sellPct}%`, ctx);
    }
    if (pos.state !== 'open') return;
    if (pos.rungs >= ladder.length && t.price <= pos.peak * (1 - e.trailingStopPct / 100)) {
      return this._exitAll(pos, t, ctx, `runner sold at ${(t.price / pos.avgEntry).toFixed(1)}× · ${e.trailingStopPct}% trail from ${(pos.peak / pos.avgEntry).toFixed(1)}×`);
    }
    if (pos.rungs === 0 && this.now() - pos.entryAt >= e.timeStopMin) return this._exitAll(pos, t, ctx, `time stop ${e.timeStopMin}m`);
  }

  _exitAll(pos, t, ctx, reason) {
    if (pos.state === 'open' && pos.remaining > EPS) this._sell(pos, t, pos.remaining, reason, ctx);
  }

  _sell(pos, t, qty, reason, ctx) {
    const e = this.cfg.executor;
    const unit = pos.cost / pos.qty;
    if (ctx.canSell && !ctx.canSell(t.id)) {
      const pnl = -pos.remaining * unit;
      pos.realized += pnl;
      pos.remaining = 0;
      this.bus.emit('trade:exit', { symbol: pos.symbol, reason: 'honeypot trap · sell failed, position written off', pnl, price: t.price, multiple: t.price / pos.avgEntry, partial: false, sizeUsd: 0 });
      this._close(pos, t, 'honeypot trap · sell failed');
      return;
    }
    const slip = this._slip(qty * t.price, t.liquidityUsd);
    const fillPrice = t.price * (1 - slip / 100);
    const proceeds = qty * fillPrice * (1 - e.feePct / 100);
    const pnl = proceeds - qty * unit;
    this.equity.credit(proceeds);
    pos.remaining -= qty;
    pos.realized += pnl;
    pos.proceeds += proceeds;
    pos.slipPct = Math.max(pos.slipPct, slip);
    pos.lastExit = fillPrice;
    const closed = pos.remaining <= pos.qty * 1e-9;
    if (closed) pos.remaining = 0;
    this.bus.emit('trade:exit', { symbol: pos.symbol, reason, pnl, price: fillPrice, multiple: fillPrice / pos.avgEntry, partial: !closed, sizeUsd: qty * t.price });
    if (closed) this._close(pos, t, reason);
  }

  _close(pos, t, reason) {
    pos.state = 'closed';
    pos.closeReason = reason;
    this.positions.delete(pos.id);
    this.card = pos;
    this.bump('closed');
    this.set('live', this.positions.size ? `${this.positions.size} open` : 'flat · waiting');
    this.bus.emit('trade:closed', {
      id: pos.id,
      tokenId: pos.tokenId,
      symbol: pos.symbol,
      pnl: pos.realized,
      cost: pos.cost,
      proceeds: pos.proceeds,
      multiple: (pos.lastExit || t.price) / pos.avgEntry,
      reason,
      t: this.now(),
    });
  }

  flattenAll(getToken, ctx, reason) {
    for (const pos of this.active()) this._exitAll(pos, getToken(pos.tokenId), ctx, reason);
  }

  cardView(getToken) {
    const p = this.card;
    if (!p) return null;
    const t = getToken(p.tokenId);
    const px = p.state === 'open' && t ? t.price : p.lastExit || t?.price || 0;
    return {
      symbol: p.symbol,
      status: p.state,
      entry: p.avgEntry,
      exit: p.state === 'closed' ? p.lastExit : null,
      price: px,
      slipPct: p.slipPct,
      sizePct: p.sizePct,
      mult: p.avgEntry ? px / p.avgEntry : 0,
      pnl: p.realized,
      reason: p.state === 'closed' ? p.closeReason : p.reason,
    };
  }
}
