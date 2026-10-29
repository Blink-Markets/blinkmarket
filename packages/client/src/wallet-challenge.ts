export function checkWalletChallenge(
  response: unknown,
  expected: { origin: string; address: string; action: "issue" | "revoke"; keyId?: string; now: Date },
): { challengeId: string; message: string } {
  const fail = (): never => { throw Object.assign(new Error("WALLET_CHALLENGE_MISMATCH"), { code: "WALLET_CHALLENGE_MISMATCH" }); };
  if (!response || typeof response !== "object" || Array.isArray(response) || Object.keys(response).sort().join(",") !== "challengeId,expiresAt,message") return fail();
  const { challengeId, message, expiresAt } = response as Record<string, unknown>;
  if (typeof challengeId !== "string" || !challengeId || typeof message !== "string" || typeof expiresAt !== "string") return fail();
  if (expected.action === "revoke" ? !expected.keyId : expected.keyId !== undefined) return fail();
  const lines = message.split("\n");
  const prefix = [
    "Blink Market wallet identity binding v1",
    "This signature only binds your identity. It does not authorize trading, token approvals, or withdrawals.",
    `Origin: ${expected.origin}`,
    "Chain ID: 84532",
    `Address: ${expected.address.toLowerCase()}`,
    `Action: ${expected.action}`,
    ...(expected.action === "revoke" ? [`Key ID: ${expected.keyId!.toLowerCase()}`] : []),
    `Challenge ID: ${challengeId}`,
  ];
  if (lines.length !== prefix.length + 3 || prefix.some((line, i) => lines[i] !== line) || !lines[prefix.length]?.startsWith("Nonce: ") || !lines[prefix.length]!.slice(7)) return fail();
  const issued = lines[prefix.length + 1]?.slice("Issued At: ".length);
  const expiry = lines[prefix.length + 2]?.slice("Expires At: ".length);
  const iso = (value: string | undefined) => {
    if (!value) return false;
    const date = new Date(value);
    return Number.isFinite(date.getTime()) && date.toISOString() === value;
  };
  if (!lines[prefix.length + 1]?.startsWith("Issued At: ") || !lines[prefix.length + 2]?.startsWith("Expires At: ") || !iso(issued) || !iso(expiry) || expiry !== expiresAt || new Date(expiry!).getTime() <= expected.now.getTime() || new Date(issued!).getTime() >= new Date(expiry!).getTime() || new Date(issued!).getTime() > expected.now.getTime() + 60_000 || !Number.isFinite(expected.now.getTime())) return fail();
  return { challengeId, message };
}
