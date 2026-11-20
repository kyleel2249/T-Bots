// scripts/sweep.mjs - run many simulated nights and print the outcome distribution.
// Usage: node scripts/sweep.mjs [nights=40] [firstSeed=1]
import { DEFAULT_CONFIG, cloneConfig } from '../public/js/config.js';
import { SimFeed } from '../public/js/market/sim-feed.js';
import { SimClock } from '../public/js/core/clock.js';
import { Orchestrator } from '../public/js/core/orchestrator.js';
import { pathToFileURL } from 'node:url';

export async function runNight(seed, cfg = cloneConfig(DEFAULT_CONFIG)) {
  const clock = new SimClock(cfg.session.startTime, cfg.session.endTime);
  const o = new Orchestrator({ config: cfg, feed: new SimFeed({ seed }), clock, seed });
  await o.init();
  while (!o.finished) await o.step();
  return o;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const n = Number(process.argv[2] || 40);
  const first = Number(process.argv[3] || 1);
  const rows = [];
  for (let s = first; s < first + n; s++) {
    const o = await runNight(s);
    const r = o.recap;
    rows.push({ seed: s, end: r.end, trades: r.trades, wins: r.wins, dd: r.maxDrawdownPct });
  }
  const ends = rows.map((r) => r.end).sort((a, b) => a - b);
  const q = (p) => ends[Math.min(ends.length - 1, Math.floor(p * ends.length))];
  const avg = (k) => rows.reduce((a, r) => a + r[k], 0) / rows.length;
  console.log(`nights ${n} · start $${DEFAULT_CONFIG.session.startBalance}`);
  console.log(`end balance  min ${ends[0].toFixed(2)} · p25 ${q(0.25).toFixed(2)} · median ${q(0.5).toFixed(2)} · p75 ${q(0.75).toFixed(2)} · max ${ends[ends.length - 1].toFixed(2)}`);
  console.log(`profitable nights ${rows.filter((r) => r.end > DEFAULT_CONFIG.session.startBalance).length}/${n} · lost >50% ${rows.filter((r) => r.end < DEFAULT_CONFIG.session.startBalance * 0.5).length}/${n}`);
  console.log(`avg trades ${avg('trades').toFixed(1)} · avg win rate ${((rows.reduce((a, r) => a + r.wins, 0) / Math.max(1, rows.reduce((a, r) => a + r.trades, 0))) * 100).toFixed(1)}% · avg max drawdown ${avg('dd').toFixed(1)}%`);
}
