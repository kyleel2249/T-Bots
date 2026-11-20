# Grok Bot

Overnight meme-coin trading terminal run by six cooperating agents (Scanner, Rug Check, Sizer, Executor, Logger, Equity) under an orchestrator. Plain HTML/CSS/JS ES modules, no build step.

**It is a paper-trading system.** It never signs a transaction or touches a wallet. Simulated results do not predict real results.

## Run

**Windows:** install Node.js 18+, download or clone this repo, double-click `start.bat` (it opens http://localhost:8080). Do not open `index.html` directly from disk: browsers block ES modules on `file://`.

```bash
npm start            # same as start.bat, any OS
npm run serve        # http://localhost:8080, no auto-open
npm test             # run the test suite
npm run sweep        # simulated nights, outcome distribution
```

Edit the prompt on the first screen, press **Run**. The prompt is parsed into the engine config (every number and switch), and anything not found in the text keeps a default that is listed under "Prompt parsed".

## Agents

| Agent | File | Job |
|---|---|---|
| Orchestrator | `public/js/core/orchestrator.js` | task assignment, task ledger, no-chase rule, drawdown pause, cooldown |
| Scanner | `agents/scanner.js` | universe filter, 5 signals; flags only |
| Rug Check | `agents/rug-check.js` | dev %, top-10 %, bundled, LP lock, honeypot; fails closed |
| Sizer | `agents/sizer.js` | % of live equity by conviction, loss-streak scale-down, compounding |
| Executor | `agents/executor.js` | split entries, TP ladder, breakeven + trailing stops, hard/time stop, instant rug exit |
| Logger | `agents/logger.js` | every ENTER / EXIT / FILTERED / SYS line with reason, size, fill, PnL |
| Equity | `agents/equity.js` | ledger, win/loss, equity curve, 07:00 recap |

## Market data

- **Simulated** (default): seeded, replayable synthetic market with rugs, runners, pump-and-fades and duds. The harsher mix and 1% fees are deliberate; run `npm run sweep` to see the spread of outcomes.
- **Live data** (paper only): DexScreener for price, liquidity, volume, txns; RugCheck for holders, authorities, LP. Smart-money and KOL wallet signals are not available from these APIs, so in live mode the Scanner uses the other three signals. Field mappings follow the public API shapes and are fixture-tested; confirm them against live responses in your environment. Missing security data fails closed (no trade).

## Prompt efficiency

`prompt-manager.js` keeps versioned global + per-agent templates. Each agent receives the shared header (a cacheable prefix, built with `cache_control`) plus only its own rules. Compression is lossless, and the dashboard shows estimated tokens, savings against sending the full prompt to every agent, and actual provider usage when the optional briefing agent runs.

## Not included

Real order execution. It would need a funded wallet, key custody and a swap router (for example Jupiter), and the risks are substantial: most new meme coins lose money.
