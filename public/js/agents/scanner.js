// public/js/agents/scanner.js
// SCANNER: watches new pairs, applies the universe filter and counts signals.
// It flags only. It never trades.

import { BaseAgent } from './base.js';

export class ScannerAgent extends BaseAgent {
  constructor(bus, cfg) {
    super('SCANNER', 'Scanner', bus, { badge: 'SCAN', hint: 'smart money + KOL wallets' });
    this.cfg = cfg;
  }

  /** Universe gate: age, liquidity, volume, holders, mint / LP flags. */
  universe(t) {
    const u = this.cfg.universe;
    if (t.security === null || t.security === undefined) return { pass: false, pending: true, reasons: ['security data pending'] };
    const sec = t.security;
    const why = [];
    if (!(t.ageMin <= u.maxAgeHours * 60)) why.push(`older than ${u.maxAgeHours}h`);
    if (!(t.liquidityUsd >= u.minLiquidityUsd)) why.push('liquidity below minimum');
    if (!(t.volume5mUsd >= u.minVolume5mUsd)) why.push('5m volume below minimum');
    if (!(t.holders >= u.minHolders)) why.push('holders below minimum');
    if (u.skipFrozenMint && sec.frozenMint) why.push('frozen mint');
    if (u.skipOpenMintAuthority && sec.mintAuthorityOpen) why.push('open mint authority');
    if (u.skipLpUnlocked && sec.lpUnlocked) why.push('LP unlocked');
    return { pass: why.length === 0, pending: false, reasons: why };
  }

  /** Returns the signals that fired. A null input means the data source cannot supply it. */
  signals(t) {
    const c = this.cfg.scanner;
    const out = [];
    const spike = t.volume5mAvgUsd > 0 ? t.volume5mUsd / t.volume5mAvgUsd : 0;
    if (spike > c.volumeSpikeX) out.push({ key: 'volume', label: `volume ${spike.toFixed(1)}×` });
    if (t.buyRatio !== null && t.buyRatio > c.buyRatioMin) out.push({ key: 'buys', label: `buys ${Math.round(t.buyRatio * 100)}% of flow` });
    if (t.holderGrowth10mPct !== null && t.holderGrowth10mPct >= c.holderGrowthMinPct) out.push({ key: 'holders', label: `holders +${t.holderGrowth10mPct.toFixed(0)}% / 10m` });
    if (t.smartWallets10m !== null && t.smartWallets10m >= c.smartWallets.min) out.push({ key: 'smart', label: `${t.smartWallets10m} smart wallets in` });
    if (t.kolBought === true) out.push({ key: 'kol', label: 'KOL bought' });
    return out;
  }

  scan(t) {
    const universe = this.universe(t);
    if (!universe.pass) return { flag: false, universe, signals: [] };
    const signals = this.signals(t);
    const flag = signals.length >= this.cfg.scanner.minSignals;
    if (flag) {
      this.bump('flags');
      this.set('live', `flagged $${t.symbol} · ${signals.length} signals`);
    }
    return { flag, universe, signals };
  }
}
