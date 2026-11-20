// public/js/prompt-parser.js
// Turns the natural-language prompt into an engine config. Every field that cannot be
// found in the text keeps its default and is reported, so nothing is silently guessed.

import { DEFAULT_CONFIG, cloneConfig, validateConfig } from './config.js';

const WORDS = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6 };
const num = (s) => {
  const w = WORDS[String(s).toLowerCase()];
  return w !== undefined ? w : Number(String(s).replace(/,/g, ''));
};
const amount = (v, suffix) => num(v) * ({ k: 1e3, m: 1e6 }[String(suffix || '').toLowerCase()] || 1);
const hhmm = (t) => (t.length === 4 ? `0${t}` : t);

function setPath(obj, path, val) {
  const p = path.split('.');
  let o = obj;
  while (p.length > 1) o = o[p.shift()];
  o[p[0]] = val;
}

// Each rule: regex -> [path, value] pairs.
const VALUE_RULES = [
  { re: /run from (\d{1,2}:\d{2}) to (\d{1,2}:\d{2})/i, set: (m) => [['session.startTime', hhmm(m[1])], ['session.endTime', hhmm(m[2])]] },
  { re: /starting balance of \$([\d,.]+)/i, set: (m) => [['session.startBalance', num(m[1])]] },
  { re: /last (\d+(?:\.\d+)?) hours/i, set: (m) => [['universe.maxAgeHours', num(m[1])]] },
  { re: /minimum liquidity \$([\d.]+)(k|m)?/i, set: (m) => [['universe.minLiquidityUsd', amount(m[1], m[2])]] },
  { re: /minimum 5m volume \$([\d.]+)(k|m)?/i, set: (m) => [['universe.minVolume5mUsd', amount(m[1], m[2])]] },
  { re: /at least (\d+) holders/i, set: (m) => [['universe.minHolders', num(m[1])]] },
  { re: /volume spikes \(>(\d+(?:\.\d+)?)x/i, set: (m) => [['scanner.volumeSpikeX', num(m[1])]] },
  { re: /buy\/sell ratio above (\d+(?:\.\d+)?)%/i, set: (m) => [['scanner.buyRatioMin', num(m[1]) / 100]] },
  {
    re: /\((\d+)\+ of (\d+) tracked wallets buying within (\d+) min\)/i,
    set: (m) => [['scanner.smartWallets', { min: num(m[1]), tracked: num(m[2]), windowMin: num(m[3]) }]],
  },
  { re: /flags at least (\w+) signals/i, set: (m) => [['scanner.minSignals', num(m[1])]] },
  { re: /dev wallet under (\d+(?:\.\d+)?)%/i, set: (m) => [['rug.devMaxPct', num(m[1])]] },
  { re: /top 10 holders under (\d+(?:\.\d+)?)%/i, set: (m) => [['rug.top10MaxPct', num(m[1])]] },
  { re: /LP burned or locked (\d+)d\+/i, set: (m) => [['rug.lpLockMinDays', num(m[1])]] },
  {
    re: /(\d+)-(\d+)% per trade/i,
    set: (m) => [['sizer.minPct', num(m[1]) / 100], ['sizer.maxPct', num(m[2]) / 100]],
  },
  { re: /max (\d+) open positions/i, set: (m) => [['sizer.maxOpen', num(m[1])]] },
  {
    re: /scale down (\d+)% after (\w+) losses in a row/i,
    set: (m) => [['sizer.scaleDown', 1 - num(m[1]) / 100], ['sizer.lossStreak', num(m[2])]],
  },
  { re: /max slippage (\d+(?:\.\d+)?)%/i, set: (m) => [['executor.maxSlippagePct', num(m[1])]] },
  { re: /split entries in (\d+) parts/i, set: (m) => [['executor.splitParts', num(m[1])]] },
  {
    re: /take-profit ladder:\s*(.+?),\s*let (\d+)% run with a (\d+)% trailing stop/i,
    set: (m) => {
      const rungs = [...m[1].matchAll(/(\d+(?:\.\d+)?)% at (\d+(?:\.\d+)?)x/g)].map((r) => ({ x: num(r[2]), sellPct: num(r[1]) }));
      return [['executor.ladder', rungs], ['executor.runnerPct', num(m[2])], ['executor.trailingStopPct', num(m[3])]];
    },
  },
  { re: /hard stop -(\d+(?:\.\d+)?)%/i, set: (m) => [['executor.hardStopPct', num(m[1])]] },
  { re: /time stop (\d+) min/i, set: (m) => [['executor.timeStopMin', num(m[1])]] },
  { re: /already \+(\d+)% in the last hour/i, set: (m) => [['rules.noChaseGainPct', num(m[1])]] },
  { re: /drawdown limit -(\d+(?:\.\d+)?)%/i, set: (m) => [['rules.drawdownLimitPct', num(m[1])]] },
];

// Boolean switches: present in the prompt = on, removed from the prompt = off.
const FLAG_RULES = [
  ['universe.skipFrozenMint', /frozen mint/i],
  ['universe.skipOpenMintAuthority', /open mint authority/i],
  ['universe.skipLpUnlocked', /LP unlocked/i],
  ['rug.noBundled', /no bundled launch/i],
  ['rug.requireSellSim', /honeypot on sell simulation/i],
  ['rules.compound', /compound profits/i],
];

/**
 * @returns {{config:object, parsed:string[], defaulted:string[], errors:string[]}}
 */
export function parsePrompt(text, base = DEFAULT_CONFIG) {
  const config = cloneConfig(base);
  const parsed = [];
  const defaulted = [];
  const src = String(text || '');

  for (const rule of VALUE_RULES) {
    const m = rule.re.exec(src);
    const pairs = m ? rule.set(m) : null;
    if (pairs) pairs.forEach(([path, val]) => { setPath(config, path, val); parsed.push(path); });
  }
  for (const [path, re] of FLAG_RULES) {
    setPath(config, path, re.test(src));
    parsed.push(path);
  }
  const leaves = [];
  const walk = (o, prefix) => {
    for (const [k, v] of Object.entries(o)) {
      const p = prefix ? `${prefix}.${k}` : k;
      if (v && typeof v === 'object' && !Array.isArray(v) && !(p === 'scanner.smartWallets')) walk(v, p);
      else leaves.push(p);
    }
  };
  walk(config, '');
  const done = new Set(parsed);
  for (const p of leaves) if (p !== 'version' && !done.has(p)) defaulted.push(p);
  return { config, parsed, defaulted, errors: validateConfig(config) };
}
