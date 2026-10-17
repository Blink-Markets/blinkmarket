const HTTP_LOOPBACK_HOSTS = ["127.0.0.1", "localhost", "[::1]"] as const;

/** HTTP origins accepted by @blink/client, kept shared with deploy preflight. */
export function isClientHttpLoopbackHost(hostname: string): boolean {
  return (HTTP_LOOPBACK_HOSTS as readonly string[]).includes(hostname);
}
