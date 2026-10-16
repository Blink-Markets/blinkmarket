// Inspect the wire value before literal-chain schemas can turn mainnet into a parse error.
export function hasMainnetChain(value: unknown): boolean {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  return (
    record.chainId === 8453 ||
    record.chainId === "8453" ||
    [record.domain, record.deployment].some((nested) => hasMainnetChain(nested))
  );
}
