import test from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_CONFIG, cloneConfig, validateConfig } from '../public/js/config.js';
import { DEFAULT_PROMPT, renderPrompt } from '../public/js/prompt-template.js';
import { parsePrompt } from '../public/js/prompt-parser.js';
import { PromptManager, compressPrompt, estimateTokens } from '../public/js/prompt-manager.js';
import { EventBus } from '../public/js/core/bus.js';
import { Rng } from '../public/js/core/rng.js';
import { SimClock, sessionMinutes } from '../public/js/core/clock.js';
import { ScannerAgent } from '../public/js/agents/scanner.js';
import { RugCheckAgent } from '../public/js/agents/rug-check.js';
import { SizerAgent } from '../public/js/agents/sizer.js';
import { EquityAgent } from '../public/js/agents/equity.js';
import { ExecutorAgent } from '../public/js/agents/executor.js';
import { LoggerAgent } from '../public/js/agents/logger.js';
import { mapPair, mapRugCheck, LiveFeed } from '../public/js/market/live-feed.js';
import { runNight } from '../scripts/sweep.mjs';

const cfg = () => cloneConfig(DEFAULT_CONFIG);
const goodSec = () => ({ frozenMint: false, mintAuthorityOpen: false, lpUnlocked: false, devPct: 2, top10Pct: 20, bundledLaunch: false, lpLockedDays: 365, honeypot: false });
const tok = (o = {}) => ({
  id: 'T1', symbol: 'TEST', dex: 'raydium', ageMin: 30, price: 1, change1hPct: 20, pullbackPct: 5, liquidityUsd: 60000, volume5mUsd: 90000, volume5mAvgUsd: 10000,
  buyRatio: 0.8, holders: 500, holderGrowth10mPct: 12, smartWallets10m: 4, kolBought: false, security: goodSec(), events: { devSold: false, lpPulled: false }, dead: false, ...o,
});

test('prompt: round-trips exactly through parser; unparsed fields are reported', () => {
  const r = parsePrompt(DEFAULT_PROMPT);
  assert.deepEqual(r.config, DEFAULT_CONFIG);
  assert.deepEqual(r.errors, []);
  assert.deepEqual(r.defaulted.sort(), ['executor.feePct', 'rules.noChasePullbackPct', 'rules.pauseMin', 'rules.reentryCooldownMin', 'scanner.holderGrowthMinPct']);
  assert.equal(DEFAULT_PROMPT.split(/\s+/).filter(Boolean).length, 345);
});

test('prompt: editing text changes config; removing a rule line switches it off', () => {
  const edited = DEFAULT_PROMPT.replace('$70', '$150').replace('Hard stop -12%', 'Hard stop -8%').replace('- Compound profits into the next position size.\n', '');
  const r = parsePrompt(edited);
  assert.equal(r.config.session.startBalance, 150);
  assert.equal(r.config.executor.hardStopPct, 8);
  assert.equal(r.config.rules.compound, false);
  const bad = parsePrompt(DEFAULT_PROMPT.replace('let 30% run', 'let 50% run'));
  assert.ok(bad.errors.some((e) => /total 100%/.test(e)));
  const c = cfg();
  c.executor.ladder = [{ x: 3, sellPct: 20 }, { x: 6, sellPct: 20 }, { x: 10, sellPct: 30 }];
  assert.deepEqual(parsePrompt(renderPrompt(c)).config.executor.ladder, c.executor.ladder);
});

test('prompt manager: lossless compression, scoped prompts, full coverage, real savings', () => {
  const messy = DEFAULT_PROMPT.replace('Solana.', 'Solana.   ').replace('\n\n', '\n\n\n\n') + '\n\n';
  assert.deepEqual(parsePrompt(compressPrompt(messy)).config, DEFAULT_CONFIG);
  const pm = new PromptManager().set(DEFAULT_PROMPT);
  const r = pm.report();
  assert.ok(r.coverageOk, `missing: ${r.coverageMissing}`);
  assert.ok(r.intentPreserved);
  assert.ok(r.scopedPerCycle < r.baselinePerCycle);
  assert.ok(r.savedPct > 40, `saved ${r.savedPct}%`);
  assert.match(pm.role('EXECUTOR'), /EXECUTOR - max slippage/);
  assert.doesNotMatch(pm.role('EXECUTOR'), /SCANNER - watches/);
  const req = pm.buildRequest('SIZER', 'size it');
  assert.equal(req.system[0].cache_control.type, 'ephemeral');
  assert.equal(req.system[0].text, pm.global());
  assert.ok(estimateTokens('abcd efgh') > 0);
});

test('config validation catches bad input', () => {
  const c = cfg();
  c.sizer.minPct = 0.9;
  assert.ok(validateConfig(c).length > 0);
  assert.equal(sessionMinutes('23:00', '07:00'), 480);
});

test('scanner: universe gates and signal counting; null signals are unavailable not failing', () => {
  const s = new ScannerAgent(new EventBus(), cfg());
  assert.equal(s.scan(tok()).flag, true);
  assert.equal(s.scan(tok({ liquidityUsd: 30000 })).universe.pass, false);
  assert.equal(s.scan(tok({ holders: 100 })).universe.pass, false);
  assert.equal(s.scan(tok({ ageMin: 400 })).universe.pass, false);
  assert.equal(s.scan(tok({ security: { ...goodSec(), frozenMint: true } })).universe.pass, false);
  assert.equal(s.scan(tok({ security: { ...goodSec(), mintAuthorityOpen: true } })).universe.pass, false);
  assert.equal(s.scan(tok({ security: { ...goodSec(), lpUnlocked: true } })).universe.pass, false);
  assert.equal(s.scan(tok({ security: null })).universe.pending, true);
  assert.equal(s.scan(tok({ buyRatio: 0.5, holderGrowth10mPct: 1, smartWallets10m: 0 })).flag, false);
  const live = s.scan(tok({ smartWallets10m: null, kolBought: null, holderGrowth10mPct: null }));
  assert.equal(live.signals.length, 2);
  assert.equal(live.flag, true);
});

test('rug check: every threshold, fail closed on missing data', () => {
  const r = new RugCheckAgent(new EventBus(), cfg());
  assert.equal(r.check(tok()).pass, true);
  const fails = [{ devPct: 5 }, { top10Pct: 35 }, { bundledLaunch: true }, { lpLockedDays: 0 }, { lpLockedDays: 29 }, { honeypot: true }, { devPct: null }, { top10Pct: undefined }];
  for (const f of fails) assert.equal(r.check(tok({ security: { ...goodSec(), ...f } })).pass, false, JSON.stringify(f));
  assert.equal(r.check(tok({ security: null })).pass, false);
  assert.equal(r.check(tok({ security: { ...goodSec(), lpLockedDays: 30 } })).pass, true);
});

test('sizer: scales with conviction, scales down after loss streak, caps, compounds', () => {
  const z = new SizerAgent(new EventBus(), cfg());
  const base = { equity: 100, available: 100, lossStreak: 0, openCount: 0 };
  assert.equal(z.size({ ...base, signals: 2 }).pct, 0.2);
  assert.ok(Math.abs(z.size({ ...base, signals: 5 }).pct - 0.4) < 1e-9);
  assert.ok(Math.abs(z.size({ ...base, signals: 5, lossStreak: 2 }).pct - 0.2) < 1e-9);
  assert.equal(z.size({ ...base, signals: 3, openCount: 2 }).ok, false);
  assert.equal(z.size({ ...base, signals: 5, available: 10 }).usd, 9.8);
  assert.equal(z.size({ ...base, available: 0.5, signals: 3 }).ok, false);
  assert.equal(z.size({ ...base, equity: 200, available: 200, signals: 2 }).usd, 40);
  const c = cfg();
  c.rules.compound = false;
  assert.equal(new SizerAgent(new EventBus(), c).size({ ...base, equity: 200, available: 200, signals: 2 }).usd, 14);
});

// ---- executor harness ----
function harness(mod = (c) => c) {
  const c = mod(cfg());
  const bus = new EventBus();
  const equity = new EquityAgent(bus, c);
  const clock = { elapsed: 0, label: () => '00:00' };
  const logger = new LoggerAgent(bus, c, clock);
  const ex = new ExecutorAgent(bus, c, equity, new Rng(5), () => clock.elapsed);
  const t = tok({ price: 1, liquidityUsd: 1e9 });
  const open = (usd = 20) => ex.open(t, usd, { sizePct: usd / 70, reason: 'test', signals: 3 }).position;
  const tick = (pos, price, extra = {}) => {
    clock.elapsed += 1;
    Object.assign(t, { price }, extra);
    ex.manage(pos, t, {});
  };
  return { c, bus, equity, ex, t, open, tick, clock, logger };
}

test('executor: split entry fills two parts and accounts fees', () => {
  const h = harness();
  const p = h.open(20);
  assert.equal(p.pending, 1);
  assert.ok(Math.abs(h.equity.cash - 60) < 1e-9);
  h.tick(p, 1);
  assert.equal(p.pending, 0);
  assert.ok(Math.abs(h.equity.cash - 50) < 1e-9);
  assert.ok(Math.abs(p.qty - 20 * 0.99) < 0.12, 'qty within fee + <=0.4% slippage noise');
});

test('executor: take-profit ladder, breakeven stop, trailing runner', () => {
  const h = harness();
  const p = h.open(20);
  h.tick(p, 1);
  h.tick(p, 2.1);
  assert.equal(p.rungs, 1);
  assert.ok(Math.abs(p.remaining - p.qty * 0.6) < 1e-6);
  h.tick(p, 4.2);
  assert.equal(p.rungs, 2);
  assert.ok(Math.abs(p.remaining - p.qty * 0.3) < 1e-6);
  h.tick(p, 8);
  h.tick(p, 6.5);
  assert.equal(p.state, 'open', 'above the 25% trail from 8x');
  h.tick(p, 5.9);
  assert.equal(p.state, 'closed');
  assert.match(p.closeReason, /runner sold/);
  assert.ok(p.realized > 20);
});

test('executor: hard stop, breakeven stop after TP1, time stop', () => {
  let h = harness();
  let p = h.open(20);
  h.tick(p, 1);
  h.tick(p, 0.85);
  assert.equal(p.state, 'closed');
  assert.match(p.closeReason, /hard stop -12%/);
  h = harness();
  p = h.open(20);
  h.tick(p, 1);
  h.tick(p, 2.2);
  h.tick(p, 0.99);
  assert.match(p.closeReason, /stop at entry/);
  h = harness();
  p = h.open(20);
  for (let i = 0; i < 25; i++) h.tick(p, 1.02);
  assert.match(p.closeReason, /time stop 25m/);
});

test('executor: instant exit when dev sells or LP is pulled; honeypot trap writes off', () => {
  let h = harness();
  let p = h.open(20);
  h.tick(p, 1, { events: { devSold: true, lpPulled: false } });
  assert.match(p.closeReason, /dev sold/);
  h = harness();
  p = h.open(20);
  h.tick(p, 1, { events: { devSold: false, lpPulled: true } });
  assert.match(p.closeReason, /LP pulled/);
  h = harness();
  p = h.open(20);
  h.t.events = { devSold: false, lpPulled: false };
  h.clock.elapsed += 1;
  h.t.price = 1;
  h.ex.manage(p, h.t, {});
  h.clock.elapsed += 1;
  h.t.events = { devSold: true, lpPulled: false };
  h.ex.manage(p, h.t, { canSell: () => false });
  assert.ok(p.state === 'closed' || p.remaining === 0);
});

test('executor: slippage cap rejects thin pools; pnl conservation', () => {
  const h = harness();
  const thin = tok({ liquidityUsd: 500 });
  assert.equal(h.ex.open(thin, 20, { sizePct: 0.2, reason: 'x', signals: 2 }).ok, false);
  const p = h.open(20);
  h.tick(p, 1);
  h.tick(p, 2.5);
  h.tick(p, 5);
  h.tick(p, 3);
  assert.equal(p.state, 'closed');
  assert.ok(Math.abs(h.equity.cash - (70 + p.realized)) < 1e-6, `${h.equity.cash} vs ${70 + p.realized}`);
  assert.equal(h.equity.trades, 1);
});

test('equity: loss streak resets on win, recap names best/worst/top coins', () => {
  const bus = new EventBus();
  const e = new EquityAgent(bus, cfg());
  for (const [s, p] of [['A', -5], ['B', -3], ['C', 10], ['A', 4]]) bus.emit('trade:closed', { symbol: s, pnl: p, t: 1 });
  assert.equal(e.lossStreak, 0);
  assert.equal(e.trades, 4);
  const r = e.recap();
  assert.equal(r.best.symbol, 'C');
  assert.equal(r.worst.symbol, 'A');
  assert.equal(r.topCoins[0].symbol, 'C');
});

test('simulation: deterministic per seed, invariants hold across seeds', async () => {
  const a = await runNight(11);
  const b = await runNight(11);
  assert.equal(a.recap.end, b.recap.end);
  assert.equal(a.logger.lines.length, b.logger.lines.length);
  assert.notEqual((await runNight(12)).recap.end, a.recap.end);
  for (const seed of [1, 2, 3, 4, 5, 6]) {
    const o = await runNight(seed);
    const r = o.recap;
    assert.equal(o.executor.count(), 0, 'flat at end');
    assert.equal(r.trades, r.wins + r.losses);
    const realized = o.equity.closed.reduce((s, x) => s + x.pnl, 0);
    assert.ok(Math.abs(o.equity.cash - (70 + realized)) < 1e-6, 'cash conservation');
    assert.ok(o.equity.cash >= -1e-9);
    const L = o.logger.lines;
    assert.ok(L.every((l) => l.reason && l.reason.length > 3), 'every line has a reason');
    assert.ok(L.filter((l) => l.type === 'ENTER').every((l) => l.sizePct >= 0.0999 && l.sizePct <= 0.41));
    let open = 0;
    let max = 0;
    for (const l of L) {
      if (l.type === 'ENTER') open++;
      if (l.type === 'EXIT' && !l.partial) open--;
      max = Math.max(max, open);
    }
    assert.ok(max <= 2, `max open ${max}`);
    assert.match(L[L.length - 1].reason, /^RECAP/);
  }
});

test('orchestrator: drawdown pause triggers and logs why; rug-failing coins never trade', async () => {
  const c = cfg();
  c.rules.drawdownLimitPct = 5;
  const o = await runNight(3, c);
  assert.ok(o.logger.lines.some((l) => l.type === 'SYS' && /^PAUSE new entries: drawdown/.test(l.reason)));
  const o2 = await runNight(4);
  const entered = new Set(o2.logger.lines.filter((l) => l.type === 'ENTER').map((l) => l.symbol));
  const rugFiltered = o2.logger.lines.filter((l) => l.type === 'FILTERED' && /^rug check/.test(l.reason)).map((l) => l.symbol);
  assert.ok(rugFiltered.length > 0);
  for (const s of rugFiltered) assert.ok(!entered.has(s), `${s} was filtered yet traded`);
  const t = o2.ledger.counts();
  assert.ok(t.entered > 0 && t.filtered > 0);
});

test('clock: wraps midnight', () => {
  const c = new SimClock('23:00', '07:00');
  assert.equal(c.label(), '23:00');
  c.advance(90);
  assert.equal(c.label(), '00:30');
  c.advance(390);
  assert.equal(c.label(), '07:00');
  assert.equal(c.done, true);
});

test('live feed: DexScreener and RugCheck mapping, fail-closed enrichment', async () => {
  const now = 1_700_000_000_000;
  const pair = { baseToken: { address: 'MintA', symbol: 'AAA' }, dexId: 'raydium', priceUsd: '0.0012', pairCreatedAt: now - 30 * 60000, liquidity: { usd: 55000 }, volume: { m5: 30000, h1: 60000 }, txns: { m5: { buys: 80, sells: 20 } }, priceChange: { h1: 45 } };
  const m = mapPair(pair, now);
  assert.equal(m.id, 'MintA');
  assert.equal(m.ageMin, 30);
  assert.equal(m.buyRatio, 0.8);
  assert.equal(m.volume5mAvgUsd, 5000);
  const report = { totalHolders: 640, creator: 'Dev', mintAuthority: null, freezeAuthority: null, topHolders: [{ address: 'Dev', pct: 2.5 }, { address: 'x', pct: 6 }], markets: [{ lp: { lpLockedPct: 100 } }], risks: [] };
  const sec = mapRugCheck(report);
  assert.equal(sec.mintAuthorityOpen, false);
  assert.equal(sec.lpUnlocked, false);
  assert.equal(sec.devPct, 2.5);
  assert.equal(mapRugCheck({ ...report, mintAuthority: 'Auth' }).mintAuthorityOpen, true);
  assert.equal(mapRugCheck({ ...report, risks: [{ name: 'Bundled launch' }] }).bundledLaunch, true);
  assert.equal(mapRugCheck(null), null);

  const calls = [];
  const fetchImpl = async (url) => {
    calls.push(url);
    const body = url.includes('token-profiles') ? [{ chainId: 'solana', tokenAddress: 'MintA' }, { chainId: 'eth', tokenAddress: '0x1' }] : url.includes('/tokens/v1/solana/') ? [pair] : url.includes('rugcheck') ? report : [];
    return { ok: true, json: async () => body };
  };
  const feed = new LiveFeed({ fetchImpl, now: () => now });
  await feed.tick();
  const snap = feed.snapshot();
  assert.equal(snap.length, 1);
  assert.equal(snap[0].smartWallets10m, null);
  assert.equal(snap[0].security.holders, 640);
  assert.ok(calls.some((u) => u.includes('rugcheck')));
  const failing = new LiveFeed({ fetchImpl: async () => ({ ok: false, status: 429, json: async () => ({}) }), now: () => now });
  await failing.tick();
  assert.equal(failing.snapshot().length, 0);
  assert.ok(failing.errors.length > 0);
});
