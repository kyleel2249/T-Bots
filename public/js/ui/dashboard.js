// public/js/ui/dashboard.js
// Renders orchestrator snapshots. All dynamic text goes through textContent (no innerHTML),
// so token symbols coming from live market data can never inject markup.

import { LoggerAgent } from '../agents/logger.js';
import { fmtSigned, fmtPrice } from '../agents/base.js';

const $ = (id) => document.getElementById(id);
const usd = (n) => `$${n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const ICON = { SCANNER: '◎', RUG: '!', SIZER: '%', EXECUTOR: '▶', LOGGER: '✎', EQUITY: '$' };

function el(tag, cls, text) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text !== undefined) n.textContent = text;
  return n;
}

export function renderTiles(root, items) {
  root.replaceChildren(
    ...items.map(([label, value]) => {
      const t = el('div', 'tile');
      t.append(el('b', '', value), el('span', '', label));
      return t;
    })
  );
}

export class Dashboard {
  constructor() {
    this.agentEls = new Map();
    this.activity = new Map();
    this.lastSig = new Map();
    this.logCount = -1;
    this.built = false;
  }

  _build(agents) {
    const ul = $('agentList');
    ul.replaceChildren();
    for (const a of agents) {
      const li = el('li', `agent a-${a.role}`);
      const ic = el('div', 'ic', ICON[a.role] || '•');
      const body = el('div');
      const nm = el('div', 'nm');
      nm.append(el('span', '', a.label), el('i', '', a.badge));
      const hint = el('div', 'hint', a.hint);
      const ln = el('div', 'ln', a.line);
      body.append(nm, hint, ln);
      li.append(ic, body);
      ul.append(li);
      this.agentEls.set(a.role, { li, ln, badge: nm.lastChild });
    }
    this.built = true;
  }

  update(s, tokenReport) {
    if (!this.built) this._build(s.agents);
    const now = performance.now();

    $('stBalance').textContent = usd(s.balance);
    $('stTrades').textContent = String(s.trades);
    $('stWins').textContent = String(s.wins);
    $('stLosses').textContent = String(s.losses);
    $('banner').textContent = s.banner;
    const dot = $('dot');
    const st = s.finished ? 'session complete' : s.paused ? `paused · ${s.pauseReason}` : `running · ${s.clock.label}`;
    $('statusText').textContent = `${st} · ${Math.floor(s.clock.elapsed / 60)}h${String(Math.floor(s.clock.elapsed % 60)).padStart(2, '0')}m of ${Math.round(s.clock.length / 60)}h`;
    dot.className = `dot ${s.finished ? 'done' : s.paused ? 'pause' : 'run'}`;

    for (const a of s.agents) {
      const e = this.agentEls.get(a.role);
      if (!e) continue;
      e.ln.textContent = a.line;
      const sig = JSON.stringify(a.counters);
      if (this.lastSig.get(a.role) !== sig) {
        this.lastSig.set(a.role, sig);
        this.activity.set(a.role, now + 1400);
      }
      e.li.classList.toggle('active', (this.activity.get(a.role) || 0) > now);
    }
    $('agentsOnline').textContent = `${s.agents.length} online`;

    $('checked').textContent = `checked ${s.stats.checked}`;
    const flow = $('flowList');
    flow.replaceChildren(
      ...(s.flow.length
        ? s.flow.map((t) => {
            const li = el('li', t.status);
            li.append(el('b', '', `$${t.symbol}`), el('small', '', `${t.stage} · ${t.note}`));
            return li;
          })
        : [el('li', '', 'scanning…')])
    );
    const last = s.flow[0];
    $('svgRug').textContent = last ? `RUG CHECK ${last.status === 'filtered' ? 'FILTER' : 'PASS'} $${last.symbol}` : 'RUG CHECK';
    $('svgExec').textContent = s.open.length ? `LIVE ${s.open.map((o) => '$' + o.symbol).join(' ')}` : 'EXECUTOR FLAT';

    $('miFiltered').textContent = String(s.stats.filtered);
    $('miSkipped').textContent = `+ ${s.stats.skipped} skipped`;
    const sizer = s.agents.find((a) => a.role === 'SIZER');
    $('miSizer').textContent = sizer.state === 'idle' ? 'idle' : sizer.line.split(' ')[0];
    $('miSizerSub').textContent = sizer.line;
    const nLines = s.lines.length;
    $('miLogger').textContent = `line #${nLines}`;
    const lastClose = [...s.lines].reverse().find((l) => l.type === 'EXIT' && l.pnl !== null);
    const mi = $('miEquity');
    mi.textContent = lastClose ? fmtSigned(lastClose.pnl) : '+$0.00';

    this._card(s.card);

    if (nLines !== this.logCount) {
      this.logCount = nLines;
      const tail = s.lines.slice(-8).map(LoggerAgent.format).join('\n');
      $('tail').textContent = tail;
      $('tail').scrollTop = 1e9;
      $('tailCount').textContent = `${nLines} lines`;
      const ul = $('logList');
      ul.replaceChildren(...s.lines.slice(-40).reverse().map((l) => this._row(l)));
    }

    $('rsStart').textContent = usd(s.start);
    $('rsNow').textContent = usd(s.balance);
    const ratio = s.balance / s.start;
    const bar = $('barFill');
    bar.style.width = `${Math.max(2, Math.min(100, (ratio / 2) * 100))}%`;
    bar.parentElement.classList.toggle('neg', ratio < 1);
    $('rsWL').textContent = `${s.wins} W / ${s.losses} L`;
    let peak = -Infinity;
    let dd = 0;
    for (const p of s.curve) {
      peak = Math.max(peak, p.balance);
      dd = Math.max(dd, (peak - p.balance) / peak);
    }
    $('rsDd').textContent = `max drawdown ${(dd * 100).toFixed(1)}%`;
    this._curve(s.curve, s.start, s.clock.length);

    if (tokenReport) this._tokens($('tokenTiles2'), tokenReport);
  }

  _row(l) {
    const li = el('li');
    li.append(el('span', 'muted mono', l.clock), el('span', `ty ${l.type}`, l.type));
    const mid = el('span');
    if (l.symbol) mid.append(el('b', '', `$${l.symbol}`));
    if (l.sizePct !== null) mid.append(document.createTextNode(`  size ${Math.round(l.sizePct * 100)}%`));
    if (l.price !== null) mid.append(document.createTextNode(`  @ ${fmtPrice(l.price)}`));
    if (!l.symbol && l.type === 'SYS') mid.textContent = 'system';
    const right = el('b', l.pnl === null ? '' : l.pnl >= 0 ? 'good' : 'bad', l.pnl === null ? '' : fmtSigned(l.pnl));
    li.append(mid, right, el('span', 'rs', l.reason));
    return li;
  }

  _card(c) {
    const kv = $('tcKv');
    if (!c) {
      $('tcSymbol').textContent = 'no trade yet';
      $('tcStatus').textContent = '–';
      $('tcMult').textContent = '';
      kv.replaceChildren();
      $('tcReason').textContent = '';
      return;
    }
    $('tcSymbol').textContent = `$${c.symbol}`;
    $('tcStatus').textContent = c.status;
    const m = $('tcMult');
    m.textContent = `${c.mult.toFixed(2)}× ${c.status === 'open' ? 'live' : 'exit'}`;
    m.className = c.mult >= 1 ? 'good' : 'bad';
    const rows = [
      ['side', 'LONG'],
      ['entry', fmtPrice(c.entry)],
      ['exit', c.exit ? fmtPrice(c.exit) : '–'],
      ['slip', `${c.slipPct.toFixed(1)}%`],
      ['size', `${Math.round(c.sizePct * 100)}% of equity`],
      ['pnl', fmtSigned(c.pnl)],
    ];
    kv.replaceChildren(...rows.flatMap(([k, v]) => [el('dt', '', k), el('dd', '', v)]));
    $('tcReason').textContent = `reason: ${c.reason}`;
  }

  _curve(curve, start, length) {
    const cv = $('curve');
    const ctx = cv.getContext('2d');
    const css = getComputedStyle(document.documentElement);
    const W = cv.width;
    const H = cv.height;
    ctx.clearRect(0, 0, W, H);
    const vals = curve.map((p) => p.balance).concat(start);
    const lo = Math.min(...vals) * 0.97;
    const hi = Math.max(...vals) * 1.03;
    const x = (t) => (t / length) * (W - 8) + 4;
    const y = (v) => H - 6 - ((v - lo) / (hi - lo || 1)) * (H - 12);
    ctx.strokeStyle = css.getPropertyValue('--line').trim() || '#ccc';
    ctx.setLineDash([4, 4]);
    ctx.beginPath();
    ctx.moveTo(0, y(start));
    ctx.lineTo(W, y(start));
    ctx.stroke();
    ctx.setLineDash([]);
    const up = curve[curve.length - 1].balance >= start;
    ctx.strokeStyle = (up ? css.getPropertyValue('--green') : css.getPropertyValue('--red')).trim() || '#16a34a';
    ctx.lineWidth = 2;
    ctx.beginPath();
    curve.forEach((p, i) => (i ? ctx.lineTo(x(p.t), y(p.balance)) : ctx.moveTo(x(p.t), y(p.balance))));
    ctx.stroke();
  }

  _tokens(root, r) {
    const u = r.usage;
    renderTiles(root, [
      ['full prompt (tokens, est.)', String(r.fullTokens)],
      ['6 agents · full prompt each cycle', String(r.baselinePerCycle)],
      ['6 agents · scoped prompts', String(r.scopedPerCycle)],
      ['saved per cycle', `${r.savedPct}%`],
      ['cacheable prefix', String(r.cacheablePrefixTokens)],
      ['intent preserved', r.intentPreserved && r.coverageOk ? '100%' : 'CHECK'],
      ['LLM calls', String(u.calls)],
      ['actual in / out', `${u.actualIn} / ${u.actualOut}`],
    ]);
  }

  tokens(root, r) {
    this._tokens(root, r);
  }

  recapDialog(r, source) {
    const body = $('recapBody');
    const line = (k, v) => {
      const d = el('div');
      d.append(el('span', 'muted', `${k}: `), document.createTextNode(v));
      return d;
    };
    const f = (x) => (x ? `$${x.symbol} ${fmtSigned(x.pnl)}` : 'n/a');
    body.replaceChildren(
      line('start → end', `${usd(r.start)} → ${usd(r.end)} (${r.returnPct >= 0 ? '+' : ''}${r.returnPct.toFixed(1)}%)`),
      line('trades', `${r.trades} (${r.wins}W / ${r.losses}L)`),
      line('best trade', f(r.best)),
      line('worst trade', f(r.worst)),
      line('top 3 coins', r.topCoins.map(f).join(' · ') || 'n/a'),
      line('max drawdown', `${r.maxDrawdownPct.toFixed(1)}%`)
    );
    $('recapSource').textContent = source;
    const d = $('recap');
    if (!d.open && d.showModal) d.showModal();
  }
}
