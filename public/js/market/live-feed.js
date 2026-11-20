// public/js/market/live-feed.js
// Live market data for paper trading: DexScreener (pairs, price, liquidity, volume, txns)
// and RugCheck (holders, authorities, LP, bundling). Both are public HTTP APIs; if a field
// is missing the token carries `security: null` or null signals and the agents fail closed.
//
// Smart-money and KOL wallet activity is not exposed by these APIs, so those two signals
// are reported as null (unavailable) and the Scanner works with the remaining signals.
// The field mappings below follow the public API shapes and are covered by fixture tests;
// verify them against the live responses in your own environment.

const DS = 'https://api.dexscreener.com';
const RC = 'https://api.rugcheck.xyz';
const num = (v) => (v === null || v === undefined || v === '' || Number.isNaN(Number(v)) ? null : Number(v));

export function mapPair(p, now = Date.now()) {
  const buys = num(p?.txns?.m5?.buys) ?? 0;
  const sells = num(p?.txns?.m5?.sells) ?? 0;
  return {
    id: p?.baseToken?.address,
    symbol: String(p?.baseToken?.symbol || '?').slice(0, 12),
    dex: p?.dexId || 'unknown',
    ageMin: p?.pairCreatedAt ? (now - p.pairCreatedAt) / 60000 : Infinity,
    price: num(p?.priceUsd),
    liquidityUsd: num(p?.liquidity?.usd),
    volume5mUsd: num(p?.volume?.m5),
    volume5mAvgUsd: (num(p?.volume?.h1) ?? 0) / 12,
    buyRatio: buys + sells > 0 ? buys / (buys + sells) : null,
    change1hPct: num(p?.priceChange?.h1) ?? 0,
  };
}

export function mapRugCheck(report) {
  if (!report || typeof report !== 'object') return null;
  const top = Array.isArray(report.topHolders) ? report.topHolders : [];
  const risks = Array.isArray(report.risks) ? report.risks : [];
  const creator = report.creator;
  const lpPct = num(report.markets?.[0]?.lp?.lpLockedPct);
  const locked = lpPct !== null && lpPct >= 95;
  const hasRisk = (re) => risks.some((r) => re.test(`${r?.name || ''} ${r?.description || ''}`));
  return {
    holders: num(report.totalHolders),
    frozenMint: report.freezeAuthority !== null && report.freezeAuthority !== undefined,
    mintAuthorityOpen: report.mintAuthority !== null && report.mintAuthority !== undefined,
    lpUnlocked: lpPct === null ? true : !locked,
    devPct: creator ? num(top.find((h) => h?.address === creator)?.pct) ?? 0 : null,
    top10Pct: top.length ? top.slice(0, 10).reduce((a, h) => a + (num(h?.pct) ?? 0), 0) : null,
    bundledLaunch: hasRisk(/bundl|sniper/i),
    lpLockedDays: locked ? 3650 : 0, // API exposes locked %, not duration: >=95% is treated as satisfying the lock
    honeypot: hasRisk(/honeypot|cannot sell|unable to sell/i),
  };
}

export class LiveFeed {
  constructor({ fetchImpl, now = () => Date.now(), maxTracked = 60, profileEveryTicks = 2 } = {}) {
    this.kind = 'live';
    this.fetch = fetchImpl || ((...a) => globalThis.fetch(...a));
    this.now = now;
    this.maxTracked = maxTracked;
    this.profileEvery = profileEveryTicks;
    this.ticks = 0;
    this.tokens = new Map();
    this.errors = [];
  }

  async init() {}

  async _json(url) {
    try {
      const res = await this.fetch(url, { headers: { accept: 'application/json' } });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.json();
    } catch (err) {
      this.errors.push(`${url.split('?')[0]}: ${err.message}`);
      if (this.errors.length > 20) this.errors.shift();
      return null;
    }
  }

  async tick() {
    this.ticks++;
    if (this.ticks % this.profileEvery === 1) await this._discover();
    await this._refresh();
    await this._enrich();
  }

  async _discover() {
    const list = await this._json(`${DS}/token-profiles/latest/v1`);
    if (!Array.isArray(list)) return;
    for (const p of list) {
      if (p.chainId !== 'solana' || !p.tokenAddress || this.tokens.has(p.tokenAddress)) continue;
      this.tokens.set(p.tokenAddress, { id: p.tokenAddress, tracked: true, hist: [], liqMax: 0, security: undefined, holdHist: [], view: null, order: this.ticks });
    }
    const ids = [...this.tokens.values()].sort((a, b) => b.order - a.order);
    for (const stale of ids.slice(this.maxTracked)) if (!stale.view?.__open) this.tokens.delete(stale.id);
  }

  async _refresh() {
    const ids = [...this.tokens.keys()];
    for (let i = 0; i < ids.length; i += 30) {
      const batch = ids.slice(i, i + 30);
      const pairs = await this._json(`${DS}/tokens/v1/solana/${batch.join(',')}`);
      if (!Array.isArray(pairs)) continue;
      const best = new Map();
      for (const p of pairs) {
        const id = p?.baseToken?.address;
        if (!id) continue;
        const liq = num(p?.liquidity?.usd) ?? 0;
        if (!best.has(id) || liq > (num(best.get(id)?.liquidity?.usd) ?? 0)) best.set(id, p);
      }
      for (const [id, p] of best) this._apply(this.tokens.get(id), mapPair(p, this.now()));
    }
  }

  _apply(t, m) {
    if (!t || m.price === null) return;
    const now = this.now();
    t.hist.push({ at: now, price: m.price });
    t.hist = t.hist.filter((h) => now - h.at <= 3600000);
    const high = Math.max(...t.hist.map((h) => h.price));
    const liq = m.liquidityUsd ?? 0;
    t.liqMax = Math.max(t.liqMax, liq);
    const lpPulled = t.liqMax > 0 && liq < t.liqMax * 0.3;
    if (t.security && t.security.holders !== null) {
      t.holdHist.push({ at: now, n: t.security.holders });
      t.holdHist = t.holdHist.filter((h) => now - h.at <= 900000);
    }
    const old = t.holdHist.find((h) => now - h.at >= 600000 - 30000);
    t.m = m;
    t.view = {
      id: t.id,
      symbol: m.symbol,
      dex: m.dex,
      ageMin: m.ageMin,
      price: m.price,
      change1hPct: m.change1hPct,
      pullbackPct: (1 - m.price / high) * 100,
      liquidityUsd: liq,
      volume5mUsd: m.volume5mUsd ?? 0,
      volume5mAvgUsd: m.volume5mAvgUsd,
      buyRatio: m.buyRatio,
      holders: t.security?.holders ?? 0,
      holderGrowth10mPct: old && t.security?.holders ? (t.security.holders / old.n - 1) * 100 : null,
      smartWallets10m: null,
      kolBought: null,
      security: t.security === undefined ? null : t.security,
      events: { devSold: false, lpPulled },
      dead: lpPulled,
    };
  }

  async _enrich() {
    let budget = 4;
    for (const t of this.tokens.values()) {
      if (budget <= 0) break;
      const m = t.m;
      if (t.security !== undefined || !m) continue;
      if ((m.liquidityUsd ?? 0) < 1 || (m.volume5mUsd ?? 0) < 1) continue;
      budget--;
      const report = await this._json(`${RC}/v1/tokens/${t.id}/report`);
      t.security = mapRugCheck(report);
      if (t.security === null) t.security = { failedLookup: true, frozenMint: true, mintAuthorityOpen: true, lpUnlocked: true, devPct: 100, top10Pct: 100, bundledLaunch: true, lpLockedDays: 0, honeypot: true, holders: 0 };
      if (t.view) {
        t.view.security = t.security;
        t.view.holders = t.security.holders ?? 0;
      }
    }
  }

  snapshot() {
    return [...this.tokens.values()].map((t) => t.view).filter((v) => v && v.price !== null);
  }
  get(id) {
    return this.tokens.get(id)?.view;
  }
  canSell() {
    return true;
  }
}
