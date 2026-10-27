/** One JSON line per event on stdout: `ts`, `agent`, `event` and the given fields. */
export type Log = {
  (event: string, fields?: Record<string, unknown>): void;
  /** Registers a secret that must never reach the output; any later occurrence is masked. */
  redact(secret: string): void;
};

const MASK = "[redacted]";

/**
 * A logger that masks every registered secret in the finished line. The agent's key and its API
 * secret are secrets; nothing in this package logs them on purpose, and this is the backstop for an
 * error message or a field that happens to carry one.
 */
export function createLogger(
  agent: string,
  secrets: readonly string[] = [],
  write: (line: string) => void = (line) => void process.stdout.write(line + "\n"),
): Log {
  const hidden = new Set(secrets.filter((s) => s.length > 0));
  const log = ((event: string, fields: Record<string, unknown> = {}) => {
    let line = JSON.stringify(
      { ts: new Date().toISOString(), agent, event, ...fields },
      (_key, value: unknown) => (typeof value === "bigint" ? value.toString() : value),
    );
    // Masked on the serialized line, so a nested field or a message is covered alike.
    for (const secret of hidden) line = line.split(secret).join(MASK);
    write(line);
  }) as Log;
  log.redact = (secret) => {
    if (secret.length > 0) hidden.add(secret);
  };
  return log;
}
