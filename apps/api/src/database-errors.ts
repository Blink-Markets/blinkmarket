// Failures that say the database could not be reached or went away, as opposed to one that a
// statement caused. The request did not take effect or, for a write, its Idempotency-Key tells
// the outcome, so the same request is worth repeating.
const SQLSTATE = /^(08...|57P01|57P03)$/; // connection exceptions, admin shutdown, starting up
const SOCKET_ERRORS = new Set(["ECONNREFUSED", "ECONNRESET", "ETIMEDOUT"]);
// pg and pg-pool raise these without a code: no connection within connectionTimeoutMillis (an
// exhausted pool ends the same way), a connection closed under a query, a dead client.
const MESSAGES = [
  /^timeout exceeded when trying to connect$/i,
  /^connection terminated/i,
  /^client has encountered a connection error and is not queryable$/i,
];

export function isDatabaseUnavailable(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  const { code, message } = error as { code?: unknown; message?: unknown };
  if (
    typeof code === "string" &&
    (SQLSTATE.test(code) || SOCKET_ERRORS.has(code))
  )
    return true;
  return typeof message === "string" && MESSAGES.some((m) => m.test(message));
}
