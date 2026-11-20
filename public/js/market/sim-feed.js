// public/js/market/sim-feed.js
// Seeded synthetic Solana meme-coin market. One tick = one simulated minute.
// Coins follow hidden archetypes (rug, runner, pump-and-fade, dud, chop). Signals are
// noisy functions of recent momentum, so the agents can never see the archetype.
// Every token is exposed through the same "view" contract the live feed uses.

import { Rng } from '../core/rng.js';

const ARCH = [['rug', 0.3], ['runner', 0.04], ['pumpFade', 0.22], ['dud', 0.3], ['chop', 0.14]];
const DEXES = ['pump.fun', 'pump.fun', 'raydium', 'meteora'];
const SYL = ['MOON', 'FAT', 'CLAUD', 'TIN', 'FOIL', 'MCRIB', 'SOCKS', 'BAWS', 'ROCK', 'STAR', 'JENS', 'PEPE', 'FROG', 'CAT', 'HAT', 'BONK', 'WIF', 'GOAT', 'ZEN', 'APE', 'NUT', 'BEAN', 'LLAMA', 'TOAD', 'PUMP', 'GIGA', 'BASED', 'CHAD', 'NORM', 'IA'];
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const mean = (a) => a.reduce((x, y) => x + y, 0) / (a.length || 1);

export class SimFeed {
  constructor({ seed = 1 } = {}) {
    this.kind = 'sim';
    this.rng = new Rng(seed);
    this.tokens = new Map();
    this.seq = 0;
    this.names = new Set();
  }

  async init() {
    for (let i = 0; i < 26; i++) this._spawn(this.rng.range(0, 300));
    for (const s of this.tokens.values()) for (let k = 0; k < 8; k++) this._step(s, true);
    for (const s of this.tokens.values()) s.view = this._view(s);
  }

  async tick() {
    const n = this.rng.poisson(0.55);
    for (let i = 0; i < n; i++) this._spawn(this.rng.range(0, 25));
    for (const s of this.tokens.values()) {
      this._step(s, false);
      s.retired = s.age0 + s.life > 360 + 120;
      s.view = this._view(s);
    }
  }

  snapshot() {
    return [...this.tokens.values()].filter((s) => !s.retired).map((s) => s.view);
  }

  get(id) {
    return this.tokens.get(id)?.view;
  }

  /** Sell attempts on a hidden honeypot fail, as they would on-chain. */
  canSell(id) {
    return !this.tokens.get(id)?.trapped;
  }

  _symbol() {
    for (let i = 0; i < 20; i++) {
      const a = this.rng.pick(SYL);
      const b = this.rng.chance(0.35) ? this.rng.pick(SYL) : '';
      const name = (a + b).slice(0, 8);
      if (!this.names.has(name)) {
        this.names.add(name);
        return name;
      }
    }
    const fallback = `COIN${this.seq}`;
    this.names.add(fallback);
    return fallback;
  }

  _arch() {
    let x = this.rng.float();
    for (const [name, p] of ARCH) {
      if ((x -= p) <= 0) return name;
    }
    return 'chop';
  }

  _spawn(age) {
    const r = this.rng;
    const arch = this._arch();
    const price0 = r.logn(0.00004, 0.9);
    const s = {
      id: `T${++this.seq}`,
      symbol: this._symbol(),
      dex: r.pick(DEXES),
      arch,
      age0: age,
      life: 0,
      price: price0,
      price0,
      liq0: r.logn(52000, 0.45),
      holders: Math.max(40, Math.round(r.logn(430, 0.45))),
      volBase: r.logn(34000, 0.45),
      vol5m: 0,
      smart: 0,
      buyRatio: 0.5,
      hist: [price0],
      volHist: [],
      holdHist: [],
      kolUntil: -1,
      rugged: false,
      pendingCrash: false,
      crashLeft: 0,
      liqFactor: 1,
      events: { devSold: false, lpPulled: false },
      retired: false,
      trapped: false,
      pumpStart: r.int(0, 40),
    };
    if (arch === 'runner') {
      s.runLen = r.int(25, 110);
      s.runMu = r.range(0.008, 0.022);
    } else if (arch === 'pumpFade') {
      s.runLen = r.int(8, 25);
      s.runMu = r.range(0.03, 0.07);
      s.fadeMu = -r.range(0.02, 0.04);
    } else if (arch === 'rug') {
      s.rugAt = r.int(15, 170);
    }
    const clean = arch === 'rug' ? r.chance(0.35) : r.chance(0.82);
    const sec = {
      frozenMint: r.chance(0.03),
      mintAuthorityOpen: r.chance(0.06),
      devPct: r.range(0.5, 4.5),
      top10Pct: r.range(14, 33),
      bundledLaunch: false,
      lpBurned: r.chance(0.5),
      lpLockedDays: r.pick([30, 60, 90, 180, 365]),
      honeypot: false,
    };
    if (sec.lpBurned) sec.lpLockedDays = 3650;
    if (!clean) {
      const flaws = r.int(1, 2);
      for (let i = 0; i < flaws; i++) {
        const k = r.int(0, 4);
        if (k === 0) sec.devPct = r.range(5.5, 18);
        else if (k === 1) sec.top10Pct = r.range(36, 60);
        else if (k === 2) sec.bundledLaunch = true;
        else if (k === 3) {
          sec.lpBurned = false;
          sec.lpLockedDays = r.pick([0, 0, 7, 14]);
        } else sec.honeypot = r.chance(0.5);
      }
    } else if (r.chance(0.015)) {
      s.trapped = true;
    }
    s.sec = sec;
    this.tokens.set(s.id, s);
    s.view = this._view(s);
    return s;
  }

  _rug(s) {
    const r = this.rng;
    s.rugged = true;
    const kind = r.chance(0.5) ? 'lpPulled' : 'devSold';
    s.events[kind] = true;
    s.rugKind = kind;
    if (r.chance(0.4)) {
      s.price *= 0.07;
      s.liqFactor = kind === 'lpPulled' ? 0.03 : 0.4;
    } else {
      s.pendingCrash = true;
    }
  }

  _step(s, warmup) {
    const r = this.rng;
    s.life++;
    let mu = 0;
    let sigma = 0.04;
    const live = s.life >= s.pumpStart && s.life < s.pumpStart + (s.runLen || 0);
    switch (s.arch) {
      case 'runner':
        mu = s.life < s.pumpStart ? 0.001 : live ? s.runMu : -0.004;
        sigma = 0.045;
        break;
      case 'pumpFade':
        mu = s.life < s.pumpStart ? 0 : live ? s.runMu : s.fadeMu;
        sigma = 0.05;
        break;
      case 'rug':
        mu = 0.004;
        sigma = 0.035;
        break;
      case 'dud':
        mu = -0.004;
        break;
      default:
        sigma = 0.05;
    }
    if (s.pendingCrash) {
      s.pendingCrash = false;
      s.crashLeft = 3;
      s.liqFactor = s.rugKind === 'lpPulled' ? 0.03 : 0.4;
    }
    if (s.arch === 'rug' && !s.rugged && s.life >= s.rugAt) this._rug(s);
    if (s.crashLeft > 0) {
      s.price *= 0.3;
      s.crashLeft--;
    } else if (s.rugged) {
      s.price *= Math.exp(-0.01 + 0.03 * r.gauss());
    } else {
      s.price *= Math.exp(mu + sigma * r.gauss());
    }
    s.price = Math.max(1e-10, s.price);
    s.hist.push(s.price);
    if (s.hist.length > 61) s.hist.shift();
    const h = s.hist;
    const m5 = Math.log(s.price / h[Math.max(0, h.length - 6)]);

    const act = Math.tanh(Math.abs(m5) / 0.08) ** 2;
    s.vol5m = s.volBase * (1 + 14 * act) * Math.exp(0.25 * r.gauss()) * Math.max(0.3, 1 - s.life / 1200);
    s.volHist.push(s.vol5m);
    if (s.volHist.length > 60) s.volHist.shift();

    const bias = s.arch === 'runner' ? 0.04 : s.arch === 'rug' ? 0.05 : 0;
    s.buyRatio = clamp(0.5 + 0.3 * Math.tanh(m5 / 0.1) + bias + 0.07 * r.gauss(), 0.15, 0.97);

    let sm = 0.2;
    if (s.arch === 'runner' && s.life >= s.pumpStart - 5 && s.life < s.pumpStart + s.runLen) sm = 2.4;
    else if (s.arch === 'pumpFade' && s.life < s.pumpStart + s.runLen) sm = 1.8;
    else if (s.arch === 'rug' && !s.rugged) sm = 1.2;
    s.smart = Math.min(40, r.poisson(sm));

    const pk = s.arch === 'runner' && live ? 0.03 : s.arch === 'rug' && !s.rugged ? 0.012 : s.arch === 'pumpFade' && live ? 0.03 : 0.002;
    if (s.life > s.kolUntil && r.chance(pk)) s.kolUntil = s.life + 15;

    const g = 0.002 + 0.012 * Math.tanh(m5 / 0.1) + 0.003 * r.gauss();
    s.holders *= Math.exp(Math.max(-0.003, g));
    s.holdHist.push(s.holders);
    if (s.holdHist.length > 12) s.holdHist.shift();
    void warmup;
  }

  _view(s) {
    const h = s.hist;
    const ago = h[Math.max(0, h.length - 61)];
    const high = Math.max(...h);
    const hold10 = s.holdHist[Math.max(0, s.holdHist.length - 11)] || s.holders;
    const sec = s.sec;
    const liquidity = s.liq0 * Math.pow(s.price / s.price0, 0.6) * s.liqFactor;
    return {
      id: s.id,
      symbol: s.symbol,
      dex: s.dex,
      ageMin: s.age0 + s.life,
      price: s.price,
      change1hPct: (s.price / ago - 1) * 100,
      pullbackPct: (1 - s.price / high) * 100,
      liquidityUsd: liquidity,
      volume5mUsd: s.vol5m,
      volume5mAvgUsd: mean(s.volHist),
      buyRatio: s.buyRatio,
      holders: Math.round(s.holders),
      holderGrowth10mPct: (s.holders / hold10 - 1) * 100,
      smartWallets10m: s.smart,
      kolBought: s.life <= s.kolUntil,
      security: {
        frozenMint: sec.frozenMint,
        mintAuthorityOpen: sec.mintAuthorityOpen,
        lpUnlocked: !sec.lpBurned && sec.lpLockedDays === 0,
        devPct: sec.devPct,
        top10Pct: sec.top10Pct,
        bundledLaunch: sec.bundledLaunch,
        lpLockedDays: sec.lpLockedDays,
        honeypot: sec.honeypot,
      },
      events: { ...s.events },
      dead: s.rugged && s.price < 0.1 * high,
    };
  }
}
