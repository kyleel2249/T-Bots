// public/js/config.js
// Single source of truth for every tunable rule. The prompt parser fills this object
// from the prompt text; every agent reads only from it.

export const APP_VERSION = '1.0-night';

export const DEFAULT_CONFIG = {
  version: APP_VERSION,
  session: { startBalance: 70, startTime: '23:00', endTime: '07:00' },
  universe: {
    maxAgeHours: 6,
    minLiquidityUsd: 40000,
    minVolume5mUsd: 25000,
    minHolders: 300,
    skipFrozenMint: true,
    skipOpenMintAuthority: true,
    skipLpUnlocked: true,
  },
  scanner: {
    volumeSpikeX: 5,
    buyRatioMin: 0.7,
    holderGrowthMinPct: 10,
    smartWallets: { min: 3, tracked: 40, windowMin: 10 },
    minSignals: 2,
  },
  rug: { devMaxPct: 5, top10MaxPct: 35, noBundled: true, lpLockMinDays: 30, requireSellSim: true },
  sizer: { minPct: 0.2, maxPct: 0.4, maxOpen: 2, lossStreak: 2, scaleDown: 0.5 },
  executor: {
    maxSlippagePct: 2.5,
    splitParts: 2,
    ladder: [
      { x: 2, sellPct: 40 },
      { x: 4, sellPct: 30 },
    ],
    runnerPct: 30,
    trailingStopPct: 25,
    hardStopPct: 12,
    timeStopMin: 25,
    feePct: 1,
  },
  rules: {
    noChaseGainPct: 300,
    noChasePullbackPct: 10,
    drawdownLimitPct: 30,
    pauseMin: 60,
    reentryCooldownMin: 30,
    compound: true,
  },
};

export const SIGNAL_NAMES = ['volume spike', 'buy pressure', 'holder growth', 'smart money', 'KOL buy'];

export function cloneConfig(cfg = DEFAULT_CONFIG) {
  return JSON.parse(JSON.stringify(cfg));
}

const TIME_RE = /^([01]?\d|2[0-3]):[0-5]\d$/;

/** Returns a list of human-readable problems; empty list means the config is runnable. */
export function validateConfig(c) {
  const e = [];
  const pos = (v, name) => {
    if (!(typeof v === 'number' && Number.isFinite(v) && v > 0)) e.push(`${name} must be a positive number`);
  };
  pos(c.session.startBalance, 'starting balance');
  if (!TIME_RE.test(c.session.startTime) || !TIME_RE.test(c.session.endTime)) e.push('run window must be HH:MM to HH:MM');
  pos(c.universe.maxAgeHours, 'pair age window');
  pos(c.universe.minLiquidityUsd, 'minimum liquidity');
  pos(c.universe.minVolume5mUsd, 'minimum 5m volume');
  pos(c.universe.minHolders, 'minimum holders');
  pos(c.scanner.volumeSpikeX, 'volume spike multiple');
  if (!(c.scanner.buyRatioMin > 0 && c.scanner.buyRatioMin < 1)) e.push('buy/sell ratio must be between 0 and 100%');
  if (!(c.scanner.minSignals >= 1 && c.scanner.minSignals <= 5)) e.push('minimum signals must be 1-5');
  if (!(c.sizer.minPct > 0 && c.sizer.minPct <= c.sizer.maxPct && c.sizer.maxPct <= 1)) e.push('position size range invalid');
  if (!(c.sizer.maxOpen >= 1)) e.push('max open positions must be >= 1');
  pos(c.executor.maxSlippagePct, 'max slippage');
  if (!(c.executor.splitParts >= 1 && c.executor.splitParts <= 5)) e.push('entry split must be 1-5 parts');
  const sold = c.executor.ladder.reduce((a, r) => a + r.sellPct, 0) + c.executor.runnerPct;
  if (Math.abs(sold - 100) > 0.001) e.push(`take-profit ladder + runner must total 100% (got ${sold}%)`);
  const xs = c.executor.ladder.map((r) => r.x);
  if (xs.some((x, i) => x <= 1 || (i > 0 && x <= xs[i - 1]))) e.push('ladder multiples must increase and exceed 1x');
  pos(c.executor.trailingStopPct, 'trailing stop');
  pos(c.executor.hardStopPct, 'hard stop');
  pos(c.executor.timeStopMin, 'time stop');
  pos(c.rules.drawdownLimitPct, 'drawdown limit');
  return e;
}
