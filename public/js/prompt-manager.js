// public/js/prompt-manager.js
// Versioned global + agent-scoped prompt templates, lossless compression, token
// estimation, provider prompt-cache request building and usage tracking.
//
// Savings come from context selection: each agent receives the shared global header
// (cacheable prefix) plus only the lines relevant to its role, instead of the full
// prompt on every call. Compression is lossless (whitespace / exact duplicate lines).

import { parsePrompt } from './prompt-parser.js';

export const TEMPLATE_VERSION = '1.0.0';

export const ROLES = ['SCANNER', 'RUG', 'SIZER', 'EXECUTOR', 'LOGGER', 'EQUITY'];

const ROLE_MAP = {
  SCANNER: { agent: 'SCANNER', sections: ['UNIVERSE'], rules: [/SCANNER flags/i] },
  RUG: { agent: 'RUG CHECK', sections: [], rules: [/RUG CHECK passes/i] },
  SIZER: { agent: 'SIZER', sections: [], rules: [/compound/i, /drawdown/i] },
  EXECUTOR: { agent: 'EXECUTOR', sections: [], rules: [/no chasing/i] },
  LOGGER: { agent: 'LOGGER', sections: ['OUTPUT'], rules: [] },
  EQUITY: { agent: 'EQUITY', sections: ['OUTPUT'], rules: [/drawdown/i] },
  BRIEFING: { agent: null, sections: ['OUTPUT'], rules: [] },
};

/** Cheap, stable token estimate (blend of char and word heuristics, about +/-15%). */
export function estimateTokens(text) {
  if (!text) return 0;
  const words = (text.match(/\S+/g) || []).length;
  return Math.max(1, Math.ceil((text.length / 4 + words * 1.3) / 2));
}

export function hashText(text) {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}

/** Lossless: normalises whitespace and drops exact duplicate lines. Never rewrites words. */
export function compressPrompt(text) {
  const t = String(text)
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t]+$/gm, '')
    .replace(/(\S)[ \t]{2,}/g, '$1 ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  const seen = new Set();
  return t
    .split('\n')
    .filter((l) => {
      const k = l.trim();
      if (!k) return true;
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    })
    .join('\n');
}

export function splitPrompt(text) {
  const out = { header: [], UNIVERSE: [], AGENTS: [], RULES: [], OUTPUT: [] };
  let cur = 'header';
  for (const l of String(text).replace(/\r\n?/g, '\n').split('\n')) {
    const t = l.trim();
    if (/^(UNIVERSE|AGENTS|RULES|OUTPUT)$/.test(t)) {
      cur = t;
      continue;
    }
    out[cur].push(l);
  }
  const clean = (a) => a.filter((l) => l.trim()).join('\n');
  return {
    header: clean(out.header),
    UNIVERSE: clean(out.UNIVERSE),
    AGENTS: out.AGENTS.filter((l) => l.trim()),
    RULES: out.RULES.filter((l) => l.trim()),
    OUTPUT: clean(out.OUTPUT.filter((l) => !/^start now\.?$/i.test(l.trim()))),
  };
}

export class UsageTracker {
  constructor() {
    this.rows = [];
  }
  record(row) {
    this.rows.push({ at: Date.now(), ...row });
  }
  summary() {
    const s = { calls: this.rows.length, estIn: 0, estOut: 0, actualIn: 0, actualOut: 0, cacheRead: 0, cacheWrite: 0 };
    for (const r of this.rows) {
      s.estIn += r.estIn || 0;
      s.estOut += r.estOut || 0;
      s.actualIn += r.actualIn || 0;
      s.actualOut += r.actualOut || 0;
      s.cacheRead += r.cacheRead || 0;
      s.cacheWrite += r.cacheWrite || 0;
    }
    return s;
  }
}

export class PromptManager {
  constructor() {
    this.usage = new UsageTracker();
    this.cache = new Map();
    this.set('');
  }

  set(text) {
    this.original = String(text);
    this.text = compressPrompt(this.original);
    this.parts = splitPrompt(this.text);
    this.hash = hashText(this.text);
    this.cache.clear();
    return this;
  }

  global() {
    return this.parts.header;
  }

  role(role) {
    const key = `${this.hash}:${role}`;
    if (this.cache.has(key)) return this.cache.get(key);
    const m = ROLE_MAP[role];
    if (!m) throw new Error(`Unknown role ${role}`);
    const lines = [];
    for (const s of m.sections) if (this.parts[s]) lines.push(this.parts[s]);
    if (m.agent) lines.push(...this.parts.AGENTS.filter((l) => new RegExp(`^\\d+\\.\\s*${m.agent}\\b`, 'i').test(l.trim())));
    lines.push(...this.parts.RULES.filter((l) => m.rules.some((re) => re.test(l))));
    const text = `ROLE ${role}\n${lines.join('\n')}`;
    this.cache.set(key, text);
    return text;
  }

  /** Anthropic Messages payload with the shared header as a cacheable prefix. */
  buildRequest(role, task, { model, maxTokens = 600 } = {}) {
    const req = {
      max_tokens: maxTokens,
      system: [
        { type: 'text', text: this.global(), cache_control: { type: 'ephemeral' } },
        { type: 'text', text: this.role(role) },
      ],
      messages: [{ role: 'user', content: task }],
    };
    if (model) req.model = model;
    return req;
  }

  /** Every non-heading line of the compressed prompt must reach at least one role. */
  coverage() {
    const joined = Object.keys(ROLE_MAP).map((r) => this.role(r)).join('\n') + '\n' + this.global();
    const lines = this.text
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l && !/^(UNIVERSE|AGENTS|RULES|OUTPUT)$/.test(l) && !/^start now\.?$/i.test(l));
    const missing = lines.filter((l) => !joined.includes(l));
    return { total: lines.length, missing, ok: missing.length === 0 };
  }

  parsedConfigPreserved() {
    const a = JSON.stringify(parsePrompt(this.original).config);
    const b = JSON.stringify(parsePrompt(this.text).config);
    return a === b;
  }

  report(agentCount = ROLES.length) {
    const fullTokens = estimateTokens(this.original);
    const baseline = fullTokens * agentCount;
    const globalTok = estimateTokens(this.global());
    let scoped = 0;
    const perRole = {};
    for (const r of ROLES) {
      const t = globalTok + estimateTokens(this.role(r));
      perRole[r] = t;
      scoped += t;
    }
    const cacheable = globalTok * agentCount;
    const cov = this.coverage();
    return {
      version: TEMPLATE_VERSION,
      hash: this.hash,
      fullTokens,
      compressedFullTokens: estimateTokens(this.text),
      baselinePerCycle: baseline,
      scopedPerCycle: scoped,
      savedTokens: baseline - scoped,
      savedPct: baseline ? Math.round(((baseline - scoped) / baseline) * 1000) / 10 : 0,
      cacheablePrefixTokens: cacheable,
      perRole,
      coverageOk: cov.ok,
      coverageMissing: cov.missing,
      intentPreserved: this.parsedConfigPreserved(),
      usage: this.usage.summary(),
    };
  }
}
