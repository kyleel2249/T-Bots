// public/js/core/ledger.js
// Task ledger: every flagged coin becomes a task that is assigned to agents in turn,
// so the orchestrator can show who is working on what and how each task ended.

export class TaskLedger {
  constructor(cap = 400) {
    this.cap = cap;
    this.tasks = [];
    this.byToken = new Map();
    this.seq = 0;
  }
  open(tokenId, symbol, now) {
    const existing = this.byToken.get(tokenId);
    if (existing && existing.status === 'running') return existing;
    const task = { id: ++this.seq, tokenId, symbol, status: 'running', stage: 'SCANNER', note: 'flagged', steps: [], openedAt: now };
    this.tasks.push(task);
    this.byToken.set(tokenId, task);
    if (this.tasks.length > this.cap) this.tasks.shift();
    return task;
  }
  step(task, agent, result, note = '') {
    task.stage = agent;
    task.note = note || result;
    task.steps.push({ agent, result, note });
  }
  done(task, status, note = '') {
    task.status = status;
    task.note = note || task.note;
  }
  recent(n = 8) {
    return this.tasks.slice(-n).reverse();
  }
  counts() {
    const c = { running: 0, entered: 0, filtered: 0, skipped: 0 };
    for (const t of this.tasks) c[t.status] = (c[t.status] || 0) + 1;
    return c;
  }
}
