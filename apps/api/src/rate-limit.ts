// In-process token bucket (one API instance in v0.1). `now` is milliseconds from any monotonic source.
export function createTokenBucket(options: {
  capacity: number;
  refillPerSecond: number;
  now?: () => number;
  maxKeys?: number;
}) {
  const { capacity, refillPerSecond } = options;
  if (!(capacity >= 1) || !(refillPerSecond > 0))
    throw new Error("INVALID_RATE_LIMIT");
  const now = options.now ?? (() => performance.now());
  const maxKeys = options.maxKeys ?? 10_000;
  // Map order is least to most recently used, so the oldest entries are the idle ones.
  const buckets = new Map<string, { tokens: number; at: number }>();
  return {
    take(
      key: string,
    ): { allowed: true } | { allowed: false; retryAfterSeconds: number } {
      const at = now();
      const known = buckets.get(key);
      buckets.delete(key);
      while (buckets.size >= maxKeys)
        buckets.delete(buckets.keys().next().value!);
      const tokens = known
        ? Math.min(
            capacity,
            known.tokens +
              (Math.max(0, at - known.at) / 1000) * refillPerSecond,
          )
        : capacity;
      const allowed = tokens >= 1;
      buckets.set(key, { tokens: allowed ? tokens - 1 : tokens, at });
      return allowed
        ? { allowed }
        : {
            allowed,
            retryAfterSeconds: Math.max(
              1,
              Math.ceil((1 - tokens) / refillPerSecond),
            ),
          };
    },
  };
}
