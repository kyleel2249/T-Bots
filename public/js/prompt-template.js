// public/js/prompt-template.js
// Renders the canonical overnight prompt from a config object, so the prompt text
// and the engine configuration can never drift apart.

import { DEFAULT_CONFIG } from './config.js';

const NUM_WORDS = { 1: 'one', 2: 'two', 3: 'three', 4: 'four', 5: 'five', 6: 'six' };
const word = (n) => NUM_WORDS[n] || String(n);
const money = (n) => (n >= 1e6 && n % 1e6 === 0 ? `${n / 1e6}m` : n >= 1000 && n % 1000 === 0 ? `${n / 1000}k` : String(n));

function joinOr(items) {
  if (items.length <= 1) return items.join('');
  if (items.length === 2) return `${items[0]} or ${items[1]}`;
  return `${items.slice(0, -1).join(', ')}, or ${items[items.length - 1]}`;
}

export function renderPrompt(c) {
  const { session: s, universe: u, scanner: sc, rug, sizer: z, executor: e, rules: r } = c;
  const L = [];
  L.push(
    `You are Grok Bot, an overnight meme-coin trading terminal on Solana. Run from ${s.startTime} to ${s.endTime} with a starting balance of $${s.startBalance}. I will not be watching. Log every decision so I can read it in the morning.`,
    '',
    'UNIVERSE',
    `- Only fresh DEX pairs: launched or migrated in the last ${u.maxAgeHours} hours (pump.fun, Raydium, Meteora).`,
    `- Minimum liquidity $${money(u.minLiquidityUsd)}, minimum 5m volume $${money(u.minVolume5mUsd)}, at least ${u.minHolders} holders.`
  );
  const skips = [];
  if (u.skipFrozenMint) skips.push('a frozen mint');
  if (u.skipOpenMintAuthority) skips.push('open mint authority');
  if (u.skipLpUnlocked) skips.push('LP unlocked');
  if (skips.length) L.push(`- Skip anything with ${joinOr(skips).replace('a frozen mint', 'a frozen mint')}.`);
  L.push('', 'AGENTS');
  L.push(
    `1. SCANNER - watches new pairs, volume spikes (>${sc.volumeSpikeX}x 1h average), buy/sell ratio above ${Math.round(sc.buyRatioMin * 100)}%, holder growth, smart-money wallets (${sc.smartWallets.min}+ of ${sc.smartWallets.tracked} tracked wallets buying within ${sc.smartWallets.windowMin} min) and KOL wallets that actually bought. It flags only, it never trades.`
  );
  const rugBits = [`dev wallet under ${rug.devMaxPct}%`, `top 10 holders under ${rug.top10MaxPct}%`];
  if (rug.noBundled) rugBits.push('no bundled launch');
  rugBits.push(`LP burned or locked ${rug.lpLockMinDays}d+`);
  if (rug.requireSellSim) rugBits.push('no honeypot on sell simulation');
  L.push(`2. RUG CHECK - ${rugBits.join(', ')}. Nothing executes without a PASS.`);
  L.push(
    `3. SIZER - size from current equity, never a fixed ticket, ${Math.round(z.minPct * 100)}-${Math.round(z.maxPct * 100)}% per trade, max ${z.maxOpen} open positions, scale down ${Math.round((1 - z.scaleDown) * 100)}% after ${word(z.lossStreak)} losses in a row.`
  );
  const [first, ...rest] = e.ladder;
  const ladder = [`sell ${first.sellPct}% at ${first.x}x`, ...rest.map((x) => `${x.sellPct}% at ${x.x}x`)].join(', ');
  L.push(
    `4. EXECUTOR - max slippage ${e.maxSlippagePct}%, split entries in ${e.splitParts} parts. Take-profit ladder: ${ladder}, let ${e.runnerPct}% run with a ${e.trailingStopPct}% trailing stop. Hard stop -${e.hardStopPct}%, time stop ${e.timeStopMin} min, exit instantly if dev sells or LP is pulled.`
  );
  L.push('5. LOGGER - write every ENTER / EXIT / FILTERED line with the reason, size, fill price and PnL.');
  L.push('6. EQUITY - update balance and the equity curve on every close.', '', 'RULES');
  L.push(`- Enter only when SCANNER flags at least ${word(sc.minSignals)} signals and RUG CHECK passes.`);
  L.push(`- No chasing: skip if the coin is already +${r.noChaseGainPct}% in the last hour without a pullback.`);
  L.push(`- Daily drawdown limit -${r.drawdownLimitPct}% from peak: pause and log why.`);
  if (r.compound) L.push('- Compound profits into the next position size.');
  L.push(
    '',
    'OUTPUT',
    'Live dashboard: balance, trades, wins/losses, current position, agent status and the full night log. At 07:00 print a recap: start vs end balance, best trade, worst trade, total trades, and the three coins that made the most.',
    '',
    'Start now.'
  );
  return L.join('\n');
}

export const DEFAULT_PROMPT = renderPrompt(DEFAULT_CONFIG);
