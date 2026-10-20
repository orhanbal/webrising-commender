type Bucket = {
  count: number;
  resetAt: number;
};

export class FixedWindowRateLimiter {
  private buckets = new Map<string, Bucket>();

  hit(key: string, limit: number, windowMs: number) {
    const now = Date.now();
    const existing = this.buckets.get(key);

    if (!existing || existing.resetAt <= now) {
      const bucket = { count: 1, resetAt: now + windowMs };
      this.buckets.set(key, bucket);
      this.cleanup(now);
      return { allowed: true, retryAfterSeconds: 0 };
    }

    existing.count += 1;
    const retryAfterSeconds = Math.max(1, Math.ceil((existing.resetAt - now) / 1000));
    return {
      allowed: existing.count <= limit,
      retryAfterSeconds,
    };
  }

  private cleanup(now: number) {
    if (this.buckets.size < 10_000) return;
    for (const [key, bucket] of this.buckets) {
      if (bucket.resetAt <= now) this.buckets.delete(key);
    }
  }
}
