// In-process token bucket (one API instance in v0.1). `now` is milliseconds from any monotonic source.
export function createTokenBucket(options: {
  capacity: number;
  refillPerSecond: number;
  now?: () => number;
  maxKeys?: number;
}) {
  const { capacity, refillPerSecond, maxKeys = 10_000 } = options;
  if (
    !(capacity >= 1) ||
    !(refillPerSecond > 0) ||
    !Number.isInteger(maxKeys) ||
    maxKeys < 1
  )
    throw new Error("INVALID_RATE_LIMIT");
  const now = options.now ?? (() => performance.now());
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

// In-process sliding-window log: at most `limit` accepted events in any trailing `windowSeconds`, per
// key. A refused request is not counted, so it never extends its own wait. Use this for every
// "N per hour/day" ceiling; the token bucket above is for a rate with a burst. One log holds at most
// `limit` timestamps, and `maxKeys` bounds the number of logs (least recently used evicted).
// ponytail: one API instance; a shared store if the API ever scales out.
export function createWindowLimiter(options: {
  limit: number;
  windowSeconds: number;
  now?: () => number;
  maxKeys?: number;
}) {
  const { limit, windowSeconds, maxKeys = 10_000 } = options;
  if (
    !Number.isInteger(limit) ||
    limit < 1 ||
    !(windowSeconds > 0) ||
    !Number.isFinite(windowSeconds) ||
    !Number.isInteger(maxKeys) ||
    maxKeys < 1
  )
    throw new Error("INVALID_RATE_LIMIT");
  const now = options.now ?? (() => performance.now());
  const windowMs = windowSeconds * 1000;
  const logs = new Map<string, number[]>();
  return {
    take(
      key: string,
    ): { allowed: true } | { allowed: false; retryAfterSeconds: number } {
      const at = now();
      const known = logs.get(key);
      logs.delete(key);
      while (logs.size >= maxKeys) logs.delete(logs.keys().next().value!);
      // An event leaves the window exactly one window after it was counted.
      const log = (known ?? []).filter((t) => at - t < windowMs);
      if (log.length >= limit) {
        logs.set(key, log);
        return {
          allowed: false,
          retryAfterSeconds: Math.max(
            1,
            Math.ceil((log[0]! + windowMs - at) / 1000),
          ),
        };
      }
      log.push(at);
      logs.set(key, log);
      return { allowed: true };
    },
  };
}
