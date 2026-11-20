// public/js/core/clock.js
// SimClock advances one virtual minute per tick; RealClock follows the wall clock.

export function hm(s) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(s);
  if (!m) throw new Error(`Bad time "${s}"`);
  return Number(m[1]) * 60 + Number(m[2]);
}

/** Minutes between start and end, wrapping past midnight (23:00 -> 07:00 = 480). */
export function sessionMinutes(start, end) {
  let d = hm(end) - hm(start);
  if (d <= 0) d += 1440;
  return d;
}

const pad = (n) => String(n).padStart(2, '0');

export class SimClock {
  constructor(start, end) {
    this.kind = 'sim';
    this.startMin = hm(start);
    this.length = sessionMinutes(start, end);
    this.elapsed = 0;
  }
  advance(min = 1) {
    this.elapsed += min;
  }
  get done() {
    return this.elapsed >= this.length;
  }
  tod() {
    return (this.startMin + this.elapsed) % 1440;
  }
  label() {
    const t = Math.floor(this.tod());
    return `${pad(Math.floor(t / 60))}:${pad(t % 60)}`;
  }
}

export class RealClock {
  constructor(lengthMin, now = () => Date.now()) {
    this.kind = 'real';
    this.now = now;
    this.t0 = now();
    this.length = lengthMin;
  }
  advance() {}
  get elapsed() {
    return (this.now() - this.t0) / 60000;
  }
  get done() {
    return this.elapsed >= this.length;
  }
  label() {
    const d = new Date(this.now());
    return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  }
}
