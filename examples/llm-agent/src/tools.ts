import { createPublicClient, createWalletClient, http, parseAbiItem, type Address, type Hex, type TypedData } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { baseSepolia } from 'viem/chains';

const CHAIN = 84532;
const MAX_DOC = 200_000;
const IDEMPOTENCY_KEY = /^[\x21-\x7e]{1,128}$/;
type ChainInput = { address: string; signature: string; args: unknown[] };
type TypedInput = { domain: Record<string, unknown>; types: Record<string, { name: string; type: string }[]>; primaryType: string; message: Record<string, unknown> };
type Options = { webUrl: string; apiUrl: string; rpcUrl: string; privateKey: Hex; maxTxs: number; fetch?: typeof fetch; chainId?: () => Promise<number>; write?: () => Promise<string> };
export function redact(text: string, secrets: readonly string[]): string {
  return secrets.filter(Boolean).reduce((s, secret) => s.replaceAll(secret, '[REDACTED]'), text);
}
export function createTools(options: Options) {
  const fetcher = options.fetch ?? fetch;
  const account = privateKeyToAccount(options.privateKey);
  const publicClient = createPublicClient({ transport: http(options.rpcUrl) });
  const wallet = createWalletClient({ account, chain: baseSepolia, transport: http(options.rpcUrl) });
  let apiKey = '';
  let txs = 0;
  const challenges = new Set<string>();
  const secrets: string[] = [options.privateKey];
  async function fetchDoc({ path }: { path: string }) {
    const base = new URL(options.webUrl);
    // A relative path resolves under the site's base path (GitHub Pages); a root-absolute llms.txt link keeps its own.
    const url = new URL(path, base.pathname.endsWith('/') ? base : new URL(`${base.pathname}/`, base));
    if (url.origin !== base.origin || url.username || url.password) throw new Error('ORIGIN');
    const response = await fetcher(url, { redirect: 'error' });
    if (!response.ok) throw new Error(`HTTP_${response.status}`);
    if (!response.body) return '';
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let length = 0;
    try {
      while (length < MAX_DOC) {
        const next = await reader.read();
        if (next.done) break;
        const chunk = next.value.subarray(0, MAX_DOC - length);
        chunks.push(chunk); length += chunk.length;
      }
    } finally { await reader.cancel(); }
    const bytes = new Uint8Array(length); let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
    return new TextDecoder().decode(bytes);
  }
  async function apiRequest({ method, path, body, idempotencyKey }: { method: 'GET' | 'POST'; path: string; body?: unknown; idempotencyKey?: string | undefined }) {
    const base = new URL(options.apiUrl);
    const url = new URL(path, base);
    if (url.origin !== base.origin || !url.pathname.startsWith('/v1/') || url.pathname.includes('%') || url.username || url.password) throw new Error('API_PATH');
    // The API's IdempotencyHeaders rule (packages/schemas/src/http.ts): 1-128 printable ASCII characters.
    if (idempotencyKey !== undefined && (method !== 'POST' || !IDEMPOTENCY_KEY.test(idempotencyKey))) throw new Error('IDEMPOTENCY_KEY');
    const headers: Record<string, string> = {};
    if (idempotencyKey !== undefined) headers['Idempotency-Key'] = idempotencyKey;
    if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    const response = await fetcher(url, { method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }), redirect: 'error' });
    const text = await response.text();
    let data: unknown;
    try { data = JSON.parse(text); } catch { data = text; }
    if (response.ok && method === 'POST' && typeof data === 'object' && data !== null) {
      if (url.pathname === '/v1/auth/wallet-verifications' && 'apiKey' in data && typeof data.apiKey === 'string') apiKey = data.apiKey;
      if (url.pathname === '/v1/auth/wallet-challenges' && 'message' in data && typeof data.message === 'string') challenges.add(data.message);
    }
    function mask(value: unknown): void {
      if (typeof value !== 'object' || value === null) return;
      for (const [key, child] of Object.entries(value)) {
        if (key === 'apiKey' && typeof child === 'string') {
          secrets.push(child);
          (value as Record<string, unknown>)[key] = '[REDACTED]';
        } else mask(child);
      }
    }
    mask(data);
    return { status: response.status, data, retryAfter: response.headers.get('retry-after') };
  }
  async function guard(address: string) {
    if ((await (options.chainId ?? (() => publicClient.getChainId()))()) !== CHAIN) throw new Error('WRONG_CHAIN');
    const result = await apiRequest({ method: 'GET', path: '/v1/deployment' });
    if (result.status !== 200 || typeof result.data !== 'object' || result.data === null || !('deployment' in result.data)) throw new Error('DEPLOYMENT');
    const deployment = result.data.deployment;
    if (typeof deployment !== 'object' || deployment === null || !('chainId' in deployment) || deployment.chainId !== CHAIN) throw new Error('WRONG_CHAIN');
    const record = deployment as Record<string, unknown>;
    const sections = ['shared', 'generation'] as const;
    const addresses = sections.flatMap((section) => section in record && typeof record[section] === 'object' && record[section] !== null ? Object.values(record[section]) : []);
    if (!addresses.some((a) => typeof a === 'string' && a.toLowerCase() === address.toLowerCase())) throw new Error('ADDRESS');
  }
  function abi(input: ChainInput) {
    const item = parseAbiItem(input.signature);
    if (item.type !== 'function') throw new Error('ABI');
    return item;
  }
  async function chainRead(input: ChainInput) {
    await guard(input.address);
    const item = abi(input);
    return publicClient.readContract({ address: input.address as Address, abi: [item], functionName: item.name, args: input.args });
  }
  async function chainWrite(input: ChainInput) {
    await guard(input.address);
    const item = abi(input);
    if (txs >= options.maxTxs) throw new Error('TX_LIMIT');
    txs++;
    if (options.write) return options.write();
    return wallet.writeContract({ address: input.address as Address, abi: [item], functionName: item.name, args: input.args });
  }
  async function signTypedData(input: TypedInput) {
    if (Number(input.domain.chainId) !== CHAIN) throw new Error('WRONG_CHAIN');
    if ('EIP712Domain' in input.types) throw new Error('DOMAIN_TYPE');
    return account.signTypedData({ domain: input.domain, types: input.types as unknown as TypedData, primaryType: input.primaryType, message: input.message });
  }
  return { fetchDoc, apiRequest, chainRead, chainWrite, signTypedData, signMessage: async ({ message }: { message: string }) => { if (!challenges.delete(message)) throw new Error('CHALLENGE'); return account.signMessage({ message }); }, secrets, address: account.address };
}
