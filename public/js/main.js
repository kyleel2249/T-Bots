// public/js/main.js - controller: compose view, run loop, exports, optional cloud/LLM.

import { DEFAULT_PROMPT } from './prompt-template.js';
import { parsePrompt } from './prompt-parser.js';
import { PromptManager } from './prompt-manager.js';
import { SimFeed } from './market/sim-feed.js';
import { LiveFeed } from './market/live-feed.js';
import { SimClock, RealClock } from './core/clock.js';
import { Orchestrator } from './core/orchestrator.js';
import { Dashboard } from './ui/dashboard.js';
import { LoggerAgent } from './agents/logger.js';
import { FirebaseSync } from './services/firebase-sync.js';
import { LlmClient } from './services/llm-client.js';
import { APP_VERSION } from './config.js';

const $ = (id) => document.getElementById(id);
const env = window.GROKBOT_ENV || {};
const pm = new PromptManager();
const dash = new Dashboard();
const fb = new FirebaseSync(env);
const llm = new LlmClient(env, pm);

const store = {
  get(k, d) {
    try {
      return localStorage.getItem(k) ?? d;
    } catch {
      return d;
    }
  },
  set(k, v) {
    try {
      localStorage.setItem(k, v);
    } catch {
      /* storage unavailable: settings simply are not remembered */
    }
  },
};

let orch = null;
let runId = '';
let timer = null;
let busy = false;
let paused = false;
let acc = 0;
let lastFrame = 0;
let mode = 'sim';
let lastCfg = null;

// ---------- compose view ----------
function refreshCompose() {
  const text = $('promptInput').value;
  const res = parsePrompt(text);
  pm.set(text);
  $('promptStats').textContent = `${text.length.toLocaleString()} chars · ${(text.match(/\S+/g) || []).length} words`;
  $('chipStart').textContent = `start $${res.config.session.startBalance}`;
  $('chipWindow').textContent = `${res.config.session.startTime} → ${res.config.session.endTime}`;
  const ul = $('parseReport');
  const rows = [];
  rows.push(['ok', `${res.parsed.length} settings read from the prompt`]);
  for (const e of res.errors) rows.push(['err', e]);
  if (res.defaulted.length) rows.push(['warn', `defaults used: ${res.defaulted.join(', ')}`]);
  ul.replaceChildren(
    ...rows.map(([c, t]) => {
      const li = document.createElement('li');
      li.className = c;
      li.textContent = (c === 'ok' ? '✓ ' : c === 'warn' ? '• ' : '✗ ') + t;
      return li;
    })
  );
  $('btnRun').disabled = res.errors.length > 0;
  const r = pm.report();
  dash.tokens($('tokenTiles'), r);
  $('tokenNote').textContent = `Token counts are heuristic estimates (about ±15%). Savings come from giving each agent only its own rules plus a shared cacheable header, not from rewording: compression is lossless and ${r.intentPreserved ? 'parsed settings are identical before and after' : 'CHANGED settings, review the prompt'}.`;
  return res;
}

let debounce;
$('promptInput').addEventListener('input', () => {
  clearTimeout(debounce);
  debounce = setTimeout(() => {
    store.set('grokbot.prompt', $('promptInput').value);
    refreshCompose();
  }, 200);
});

// ---------- run ----------
async function start() {
  const res = refreshCompose();
  if (res.errors.length) return;
  lastCfg = res.config;
  mode = $('selMode').value;
  const seed = Math.max(1, Math.floor(Number($('inSeed').value)) || Math.floor(Math.random() * 1e6));
  store.set('grokbot.mode', mode);
  store.set('grokbot.seed', String(seed));
  store.set('grokbot.speed', $('selSpeed').value);
  const cfg = res.config;
  const clock = mode === 'live' ? new RealClock(sessionLen(cfg)) : new SimClock(cfg.session.startTime, cfg.session.endTime);
  const feed = mode === 'live' ? new LiveFeed() : new SimFeed({ seed });
  orch = new Orchestrator({ config: cfg, feed, clock, seed });
  runId = `${new Date().toISOString().replace(/[:.]/g, '-')}-${seed}`;
  paused = false;
  acc = 0;
  dash.logCount = -1;
  $('btnPause').textContent = 'Pause';
  $('selSpeed2').value = $('selSpeed').value;
  $('tagVer').textContent = `v${APP_VERSION}`;
  $('subtitle').textContent = 'prompt parsed · launching terminal';
  $('chipMode').textContent = mode === 'live' ? 'paper · live market data' : `paper · simulated market · seed ${seed}`;
  $('viewCompose').hidden = true;
  $('viewTerminal').hidden = false;
  await orch.init();
  orch.bus.on('session:end', onEnd);
  render();
  schedule();
}

function sessionLen(cfg) {
  const [a, b] = [cfg.session.startTime, cfg.session.endTime].map((t) => Number(t.split(':')[0]) * 60 + Number(t.split(':')[1]));
  const d = b - a;
  return d <= 0 ? d + 1440 : d;
}

function render() {
  if (!orch) return;
  dash.update(orch.snapshot(), pm.report());
}

function schedule() {
  clearTimeout(timer);
  lastFrame = performance.now();
  const tick = async () => {
    if (!orch) return;
    if (!busy && !paused && !orch.finished) {
      busy = true;
      try {
        const now = performance.now();
        if (mode === 'live') {
          await orch.step();
        } else {
          acc += (Number($('selSpeed2').value) * (now - lastFrame)) / 1000;
          lastFrame = now;
          let n = Math.min(Math.floor(acc), 480);
          acc -= n;
          while (n-- > 0 && !orch.finished) await orch.step();
        }
        render();
      } catch (err) {
        paused = true;
        orch.bus.emit('sys', { reason: `ENGINE ERROR: ${err.message}. Session paused.` });
        $('btnPause').textContent = 'Resume';
        render();
      } finally {
        busy = false;
      }
    } else {
      lastFrame = performance.now();
    }
    if (orch && !orch.finished) timer = setTimeout(tick, mode === 'live' ? 15000 : 100);
  };
  tick();
}

async function onEnd(recap) {
  render();
  dash.recapDialog(recap, mode === 'live' ? 'live' : 'simulated');
  $('btnBrief').hidden = !llm.enabled;
  $('live').textContent = 'Session complete. Recap ready.';
  if (fb.enabled) {
    try {
      await fb.saveRun({ runId, config: lastCfg, recap, lines: orch.logger.lines, usage: pm.report().usage });
      orch.bus.emit('sys', { reason: 'run saved to Firebase' });
    } catch (err) {
      orch.bus.emit('sys', { reason: `Firebase save failed: ${err.message}` });
    }
    render();
  }
}

function download(name, text, type) {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

// ---------- wiring ----------
$('btnRun').addEventListener('click', start);
$('btnPause').addEventListener('click', () => {
  paused = !paused;
  $('btnPause').textContent = paused ? 'Resume' : 'Pause';
  if (orch && !paused && !orch.finished) schedule();
});
$('selSpeed2').addEventListener('change', () => (acc = 0));
$('btnBack').addEventListener('click', () => {
  clearTimeout(timer);
  orch = null;
  $('viewTerminal').hidden = true;
  $('viewCompose').hidden = false;
  $('subtitle').textContent = 'new session · overnight trading prompt';
});
$('btnLog').addEventListener('click', () => orch && download(`grok-bot-${runId}.log`, orch.logger.toText(), 'text/plain'));
$('btnJson').addEventListener('click', () =>
  orch && download(`grok-bot-${runId}.json`, JSON.stringify({ runId, mode, config: lastCfg, recap: orch.recap, equityCurve: orch.equity.curve, log: orch.logger.lines, tasks: orch.ledger.tasks, tokens: pm.report() }, null, 2), 'application/json')
);
$('btnClose').addEventListener('click', () => $('recap').close());
$('btnBrief').addEventListener('click', async () => {
  const out = $('briefOut');
  out.hidden = false;
  out.textContent = 'writing briefing…';
  $('btnBrief').disabled = true;
  try {
    out.textContent = await llm.briefing(orch.recap, orch.logger.tail(12).map(LoggerAgent.format));
  } catch (err) {
    out.textContent = `Briefing unavailable: ${err.message}`;
  } finally {
    $('btnBrief').disabled = false;
    render();
  }
});

// ---------- init ----------
$('promptInput').value = store.get('grokbot.prompt', DEFAULT_PROMPT);
$('selMode').value = store.get('grokbot.mode', 'sim');
$('inSeed').value = store.get('grokbot.seed', '7');
$('selSpeed').value = store.get('grokbot.speed', '20');
refreshCompose();
