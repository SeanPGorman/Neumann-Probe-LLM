export type RateLimitSnapshot = {
  limit: number;
  remaining: number;
  resetAtMs: number;
};

/**
 * Account-wide VNG throttler. Reservations are synchronous so concurrent
 * callers cannot all consume the same server-reported remaining slot.
 */
export class RateLimitThrottler {
  private snapshot: RateLimitSnapshot | null = null;
  private readonly localAttempts: number[] = [];
  private unknownProbeInFlight = false;
  private nextHeaderlessAttemptAt = 0;

  constructor(
    private readonly safetyReserve = 5,
    private readonly fallbackLimit = 110,
    private readonly fallbackWindowMs = 60_000,
  ) {}

  /**
   * Reserve one outbound request or return the milliseconds to wait.
   * Call again after waiting; another concurrent request may have used a slot.
   */
  reserve(now = Date.now()): number {
    this.pruneLocalAttempts(now);

    if (this.snapshot && now >= this.snapshot.resetAtMs) {
      this.snapshot = null;
    }

    if (!this.snapshot) {
      if (this.unknownProbeInFlight) return 25;
      if (now < this.nextHeaderlessAttemptAt) {
        return this.nextHeaderlessAttemptAt - now;
      }
    }

    if (this.localAttempts.length >= this.fallbackLimit) {
      return Math.max(
        25,
        this.localAttempts[0] + this.fallbackWindowMs - now + 25,
      );
    }

    if (this.snapshot) {
      if (this.snapshot.remaining <= this.safetyReserve) {
        return Math.max(25, this.snapshot.resetAtMs - now + 250);
      }
      this.snapshot.remaining -= 1;
    } else {
      // Until one response establishes the account's current server window,
      // permit only one request in flight.
      this.unknownProbeInFlight = true;
    }

    this.localAttempts.push(now);
    return 0;
  }

  observe(snapshot: RateLimitSnapshot, now = Date.now()): boolean {
    this.unknownProbeInFlight = false;
    if (
      !Number.isFinite(snapshot.limit) ||
      !Number.isFinite(snapshot.remaining) ||
      !Number.isFinite(snapshot.resetAtMs) ||
      !Number.isInteger(snapshot.limit) ||
      !Number.isInteger(snapshot.remaining) ||
      snapshot.limit <= 0 ||
      snapshot.remaining < 0 ||
      snapshot.remaining > snapshot.limit ||
      snapshot.resetAtMs <= now ||
      snapshot.resetAtMs > now + 5 * 60_000
    ) {
      this.nextHeaderlessAttemptAt = Math.max(
        this.nextHeaderlessAttemptAt,
        now + 600,
      );
      return false;
    }

    if (!this.snapshot || snapshot.resetAtMs > this.snapshot.resetAtMs) {
      this.snapshot = { ...snapshot };
      return true;
    }

    if (snapshot.resetAtMs === this.snapshot.resetAtMs) {
      // Concurrent responses can arrive out of order. Never let an older
      // response increase the locally reserved remaining allowance.
      this.snapshot.limit = snapshot.limit;
      this.snapshot.remaining = Math.min(
        this.snapshot.remaining,
        snapshot.remaining,
      );
    }
    return true;
  }

  releaseWithoutHeaders(now = Date.now()): void {
    this.unknownProbeInFlight = false;
    // 600 ms caps headerless traffic below 100/minute.
    this.nextHeaderlessAttemptAt = Math.max(
      this.nextHeaderlessAttemptAt,
      now + 600,
    );
  }

  penalize(retryAfterMs: number, now = Date.now()): void {
    this.unknownProbeInFlight = false;
    const boundedRetryMs = Math.min(
      5 * 60_000,
      Math.max(1_000, retryAfterMs),
    );
    this.snapshot = {
      limit: 120,
      remaining: 0,
      resetAtMs: now + boundedRetryMs,
    };
  }

  getSnapshot(): RateLimitSnapshot | null {
    return this.snapshot ? { ...this.snapshot } : null;
  }

  private pruneLocalAttempts(now: number): void {
    const cutoff = now - this.fallbackWindowMs;
    while (
      this.localAttempts.length > 0 &&
      this.localAttempts[0] <= cutoff
    ) {
      this.localAttempts.shift();
    }
  }
}