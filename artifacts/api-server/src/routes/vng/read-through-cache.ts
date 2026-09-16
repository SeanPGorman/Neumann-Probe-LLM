type CacheEntry<T> = {
  expiresAt: number;
  promise: Promise<T>;
};

/**
 * Small promise cache used to coalesce identical reads within one poll cycle.
 * Rejections are evicted immediately so a transient failure is never cached.
 */
export class ReadThroughCache {
  private readonly entries = new Map<string, CacheEntry<unknown>>();

  constructor(private readonly ttlMs: number) {}

  get<T>(key: string, load: () => Promise<T>): Promise<T> {
    const now = Date.now();
    const existing = this.entries.get(key) as CacheEntry<T> | undefined;
    if (existing && existing.expiresAt > now) return existing.promise;

    const promise = load().catch((error) => {
      const current = this.entries.get(key);
      if (current?.promise === promise) this.entries.delete(key);
      throw error;
    });
    this.entries.set(key, { expiresAt: now + this.ttlMs, promise });
    return promise;
  }

  clear(): void {
    this.entries.clear();
  }
}