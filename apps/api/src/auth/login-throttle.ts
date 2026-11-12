/**
 * Slows down password guessing on sign-in. Counts failed sign-ins per email and per network address over a window;
 * once either passes its limit, sign-in answers 429 until the window ends. A good sign-in clears that email's count.
 *
 * Kept in memory, so each API process counts on its own and a restart forgets. That is enough to stop a script trying
 * thousands of passwords; a shared store (Redis) is the next step when more than one API process runs.
 */
export class LoginThrottle {
  private readonly hits = new Map<string, { n: number; start: number }>();
  constructor(
    private readonly perEmail = 5,
    private readonly perIp = 30,
    private readonly windowMs = 15 * 60_000,
    private readonly now: () => number = Date.now,
  ) {}

  /** Seconds to wait when this email or address is blocked, otherwise 0. */
  blockedFor(email: string, ip: string): number {
    const t = this.now();
    let wait = 0;
    for (const [key, max] of [[`e:${email}`, this.perEmail], [`i:${ip}`, this.perIp]] as const) {
      const h = this.live(key, t);
      if (h && h.n >= max) wait = Math.max(wait, Math.ceil((h.start + this.windowMs - t) / 1000));
    }
    return wait;
  }

  fail(email: string, ip: string): void {
    const t = this.now();
    for (const key of [`e:${email}`, `i:${ip}`]) {
      const h = this.live(key, t);
      if (h) h.n++; else this.hits.set(key, { n: 1, start: t });
    }
    if (this.hits.size > 50_000) this.sweep(t);
  }

  succeed(email: string): void {
    this.hits.delete(`e:${email}`);
  }

  private live(key: string, t: number) {
    const h = this.hits.get(key);
    if (h && h.start + this.windowMs <= t) { this.hits.delete(key); return undefined; }
    return h;
  }

  private sweep(t: number) {
    for (const [k, h] of this.hits) if (h.start + this.windowMs <= t) this.hits.delete(k);
  }
}
