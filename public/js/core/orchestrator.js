// public/js/core/orchestrator.js
// Assigns work to the six agents, enforces the session-level rules (no chasing, max
// positions, drawdown pause, re-entry cooldown) and tracks every flagged coin as a task.
//
// Per tick: feed -> Executor manages open positions -> drawdown policy -> Scanner reviews
// every coin -> flagged coins go RUG CHECK -> rules -> SIZER -> EXECUTOR -> LOGGER/EQUITY.

import { EventBus } from './bus.js';
import { Rng } from './rng.js';
import { TaskLedger } from './ledger.js';
import { ScannerAgent } from '../agents/scanner.js';
import { RugCheckAgent } from '../agents/rug-check.js';
import { SizerAgent } from '../agents/sizer.js';
import { ExecutorAgent } from '../agents/executor.js';
import { LoggerAgent } from '../agents/logger.js';
import { EquityAgent } from '../agents/equity.js';
import { fmtSigned } from '../agents/base.js';

export class Orchestrator {
  constructor({ config, feed, clock, seed = 1, bus = new EventBus() }) {
    this.cfg = config;
    this.feed = feed;
    this.clock = clock;
    this.bus = bus;
    this.rng = new Rng(seed + 1013);
    const now = () => clock.elapsed;
    this.equity = new EquityAgent(bus, config);
    this.logger = new LoggerAgent(bus, config, clock);
    this.scanner = new ScannerAgent(bus, config);
    this.rug = new RugCheckAgent(bus, config);
    this.sizer = new SizerAgent(bus, config);
    this.executor = new ExecutorAgent(bus, config, this.equity, this.rng, now);
    this.agents = [this.scanner, this.rug, this.sizer, this.executor, this.logger, this.equity];
    this.ledger = new TaskLedger();
    this.checked = new Set();
    this.skipped = new Set();
    this.blacklist = new Set();
    this.cooldown = new Map();
    this.logged = new Set();
    this.filteredCount = 0;
    this.paused = false;
    this.pauseUntil = 0;
    this.pauseReason = '';
    this.peak = config.session.startBalance;
    this.finished = false;
    this.recap = null;
    this.banner = 'ready';
    this.lastSample = 0;
    this.ctx = { canSell: (id) => (this.feed.canSell ? this.feed.canSell(id) : true) };
    bus.on('trade:enter', (e) => (this.banner = `ENTERED · LOGGED $${e.symbol}`));
    bus.on('trade:closed', (e) => {
      this.banner = `TRADE CLOSED · LOGGED $${e.symbol}`;
      this.cooldown.set(e.tokenId, e.t + this.cfg.rules.reentryCooldownMin);
    });
    bus.on('trade:filtered', (e) => (this.banner = `FILTERED $${e.symbol}`));
  }

  async init() {
    await this.feed.init();
    const s = this.cfg.session;
    this.bus.emit('sys', {
      reason: `session start ${s.startTime} → ${s.endTime} · balance $${s.startBalance} · ${this.feed.kind === 'sim' ? 'simulated market' : 'live market data'} · paper execution`,
    });
    this.executor.set('idle', `slippage cap ${this.cfg.executor.maxSlippagePct.toFixed(1)}%`);
  }

  _filtered(token, reason, key) {
    const k = `${token.id}:${key}`;
    if (this.logged.has(k)) return;
    this.logged.add(k);
    this.filteredCount++;
    this.bus.emit('trade:filtered', { symbol: token.symbol, reason });
  }

  async step() {
    if (this.finished) return;
    this.clock.advance(1);
    await this.feed.tick(1);
    const now = this.clock.elapsed;
    const getToken = (id) => this.feed.get(id);

    for (const pos of this.executor.active()) this.executor.manage(pos, getToken(pos.tokenId), this.ctx);
    for (const [id, until] of this.cooldown) if (until <= now) this.cooldown.delete(id);
    this._mark(getToken);
    this._drawdownPolicy(now);

    for (const token of this.feed.snapshot()) this._review(token, now);

    this._mark(getToken);
    if (now - this.lastSample >= 5) {
      this.equity.sample(now);
      this.lastSample = now;
    }
    if (this.clock.done) this._finalize(getToken);
  }

  _mark(getToken) {
    let v = 0;
    for (const p of this.executor.active()) {
      const t = getToken(p.tokenId);
      if (t) v += p.remaining * t.price;
    }
    this.equity.mark(v);
  }

  _drawdownPolicy(now) {
    const eq = this.equity.balance;
    const limit = this.cfg.rules.drawdownLimitPct;
    if (this.paused) {
      if (now >= this.pauseUntil) {
        this.paused = false;
        this.peak = eq;
        this.bus.emit('sys', { reason: `RESUME after ${this.cfg.rules.pauseMin}m pause · peak reset to $${eq.toFixed(2)}` });
      }
      return;
    }
    if (eq > this.peak) this.peak = eq;
    const dd = ((this.peak - eq) / this.peak) * 100;
    if (dd >= limit) {
      this.paused = true;
      this.pauseUntil = now + this.cfg.rules.pauseMin;
      this.pauseReason = `drawdown -${dd.toFixed(1)}% from peak $${this.peak.toFixed(2)}`;
      this.bus.emit('sys', { reason: `PAUSE new entries: ${this.pauseReason} (limit -${limit}%). Open positions keep their exits.` });
    }
  }

  _review(token, now) {
    const id = token.id;
    if (this.blacklist.has(id) || this.executor.has(id)) return;
    if ((this.cooldown.get(id) || 0) > now) return;
    const scan = this.scanner.scan(token);
    if (scan.universe.pending) return;
    this.checked.add(id);
    if (!scan.universe.pass) {
      this.skipped.add(id);
      return;
    }
    this.skipped.delete(id);
    if (!scan.flag) return;

    const task = this.ledger.open(id, token.symbol, now);
    this.ledger.step(task, 'SCANNER', 'flagged', scan.signals.map((s) => s.label).join(' · '));
    const rc = this.rug.check(token);
    if (!rc.pass) {
      this.ledger.step(task, 'RUG CHECK', 'filtered', rc.reasons.join(', '));
      this.ledger.done(task, 'filtered', rc.reasons[0]);
      this.blacklist.add(id);
      this._filtered(token, `rug check: ${rc.reasons.join(', ')}`, 'rug');
      return;
    }
    this.ledger.step(task, 'RUG CHECK', 'pass');
    if (this.paused) return this.ledger.step(task, 'ORCHESTRATOR', 'waiting', 'entries paused');

    const r = this.cfg.rules;
    if (token.change1hPct >= r.noChaseGainPct && token.pullbackPct < r.noChasePullbackPct) {
      this.ledger.done(task, 'skipped', `no chase +${token.change1hPct.toFixed(0)}%`);
      this._filtered(token, `no chasing: already +${token.change1hPct.toFixed(0)}% in the last hour without a pullback`, 'chase');
      return;
    }
    const available = this.equity.cash - this.executor.pendingSpend();
    const size = this.sizer.size({ equity: this.equity.balance, available, signals: scan.signals.length, lossStreak: this.equity.lossStreak, openCount: this.executor.count() });
    if (!size.ok) return this.ledger.step(task, 'SIZER', 'blocked', size.reason);
    this.ledger.step(task, 'SIZER', 'sized', `${Math.round(size.pct * 100)}%`);

    const reason = `new pair ${Math.round(token.ageMin)}m · ${scan.signals.map((s) => s.label).join(' · ')}`;
    const res = this.executor.open(token, size.usd, { sizePct: size.pct, reason, signals: scan.signals.length });
    if (!res.ok) {
      this.ledger.done(task, 'filtered', res.reason);
      this._filtered(token, res.reason, 'slip');
      return;
    }
    this.ledger.step(task, 'EXECUTOR', 'entered');
    this.ledger.done(task, 'entered');
  }

  _finalize(getToken) {
    this.executor.flattenAll(getToken, this.ctx, `session end ${this.cfg.session.endTime} · flatten`);
    this._mark(getToken);
    this.equity.sample(this.clock.elapsed);
    this.finished = true;
    this.recap = this.equity.recap();
    const r = this.recap;
    const fmt = (x) => (x ? `$${x.symbol} ${fmtSigned(x.pnl)}` : 'n/a');
    this.bus.emit('sys', {
      reason: `RECAP ${this.cfg.session.endTime} · start $${r.start.toFixed(2)} → end $${r.end.toFixed(2)} (${r.returnPct >= 0 ? '+' : ''}${r.returnPct.toFixed(1)}%) · ${r.trades} trades ${r.wins}W/${r.losses}L · best ${fmt(r.best)} · worst ${fmt(r.worst)} · top coins ${r.topCoins.map(fmt).join(', ') || 'n/a'}`,
    });
    this.bus.emit('session:end', r);
  }

  snapshot() {
    const eq = this.equity;
    const getToken = (id) => this.feed.get(id);
    const open = this.executor.active().map((p) => {
      const t = getToken(p.tokenId);
      return { symbol: p.symbol, mult: t ? t.price / p.avgEntry : 0, sizePct: p.sizePct, rungs: p.rungs };
    });
    return {
      clock: { label: this.clock.label(), elapsed: this.clock.elapsed, length: this.clock.length, done: this.clock.done },
      finished: this.finished,
      paused: this.paused,
      pauseReason: this.pauseReason,
      banner: this.banner,
      balance: eq.balance,
      cash: eq.cash,
      start: eq.start,
      trades: eq.trades,
      wins: eq.wins,
      losses: eq.losses,
      peak: this.peak,
      stats: { checked: this.checked.size, filtered: this.filteredCount, skipped: this.skipped.size },
      agents: this.agents.map((a) => a.view()),
      flow: this.ledger.recent(8),
      open,
      card: this.executor.cardView(getToken),
      lines: this.logger.lines,
      curve: eq.curve,
      recap: this.recap,
      feedErrors: this.feed.errors || [],
    };
  }
}
