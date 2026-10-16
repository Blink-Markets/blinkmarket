const LOOPBACK_HOST = /^(localhost|127(\.[0-9]{1,3}){3}|\[::1\])$/;

/** https only, except loopback; no credentials or fragment; never a placeholder. */
export function isAllowedAlertWebhookUrl(url: string): boolean {
  if (url.includes("<TO BE PROVIDED:")) return false;
  try {
    const parsed = new URL(url);
    return (
      !parsed.username &&
      !parsed.password &&
      !parsed.hash &&
      (parsed.protocol === "https:" ||
        (parsed.protocol === "http:" && LOOPBACK_HOST.test(parsed.hostname)))
    );
  } catch {
    return false;
  }
}
