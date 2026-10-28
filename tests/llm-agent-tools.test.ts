import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createTools, redact } from '../examples/llm-agent/src/tools.ts';

const key = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80';
const address = '0x0000000000000000000000000000000000000001';
function setup(chain = 84532, maxTxs = 50) {
  return createTools({ webUrl: 'http://localhost:3000', apiUrl: 'http://localhost:3001', rpcUrl: 'http://localhost:8545', privateKey: key, maxTxs,
    fetch: async (input) => String(input).includes('/v1/deployment') ? Response.json({ deployment: { chainId: 84532, shared: { busd: address }, generation: {} } }) : new Response('x'.repeat(210_000)),
    chainId: async () => chain, write: async () => '0xabc' });
}
test('fetch_doc refuses another origin and truncates at 200 KB', async () => {
  const tools = setup();
  await assert.rejects(tools.fetchDoc({ path: 'http://evil.test/' }), /ORIGIN/);
  assert.equal((await tools.fetchDoc({ path: '/docs.md' })).length, 200_000);
});
test('chain_write refuses an address outside the deployment, a non-84532 chain and the 51st transaction', async () => {
  const input = { address, signature: 'function claim()', args: [] };
  await assert.rejects(setup().chainWrite({ ...input, address: '0x0000000000000000000000000000000000000002' }), /ADDRESS/);
  await assert.rejects(setup(1).chainWrite(input), /CHAIN/);
  const tools = setup();
  for (let i = 0; i < 50; i++) await tools.chainWrite(input);
  await assert.rejects(tools.chainWrite(input), /TX_LIMIT/);
});
test('sign_typed_data refuses a foreign chainId', async () => {
  await assert.rejects(setup().signTypedData({ domain: { chainId: 1 }, types: {}, primaryType: 'X', message: {} }), /CHAIN/);
});
test('transcript redacts the key and the API secret', () => {
  assert.equal(redact(`key ${key} api secret`, [key, 'secret']), 'key [REDACTED] api [REDACTED]');
});
test('wallet verification captures the API key and uses it only for API calls', async () => {
  const requests: RequestInit[] = [];
  const tools = createTools({ webUrl: 'http://localhost:3000', apiUrl: 'http://localhost:3001', rpcUrl: 'http://localhost:8545', privateKey: key, maxTxs: 1,
    fetch: async (_url, init) => { requests.push(init ?? {}); return requests.length === 1 ? Response.json({ apiKey: 'session-secret', keyId: 'id' }) : Response.json({ ok: true }); } });
  const issued = await tools.apiRequest({ method: 'POST', path: '/v1/auth/wallet-verifications', body: {} });
  assert.deepEqual(issued.data, { apiKey: '[REDACTED]', keyId: 'id' });
  await tools.apiRequest({ method: 'GET', path: '/v1/markets' });
  assert.equal((requests[1]?.headers as Record<string, string>).Authorization, 'Bearer session-secret');
  await assert.rejects(tools.apiRequest({ method: 'GET', path: 'http://evil.test/v1/markets' }), /API_PATH/);
});
test('api_request sends a valid Idempotency-Key on POST only and refuses an invalid key or a GET with one', async () => {
  const requests: RequestInit[] = [];
  const tools = createTools({ webUrl: 'http://localhost:3000', apiUrl: 'http://localhost:3001', rpcUrl: 'http://localhost:8545', privateKey: key, maxTxs: 1,
    fetch: async (_url, init) => { requests.push(init ?? {}); return Response.json({ ok: true }); } });
  await tools.apiRequest({ method: 'POST', path: '/v1/markets/m1/forecasts', body: {}, idempotencyKey: 'forecast-1' });
  assert.equal((requests[0]?.headers as Record<string, string>)['Idempotency-Key'], 'forecast-1');
  await tools.apiRequest({ method: 'POST', path: '/v1/markets/m1/forecasts', body: {} });
  assert.equal('Idempotency-Key' in (requests[1]?.headers as Record<string, string>), false);
  for (const bad of ['', 'has space', 'x'.repeat(129), 'caf\u00e9'])
    await assert.rejects(tools.apiRequest({ method: 'POST', path: '/v1/x', body: {}, idempotencyKey: bad }), /IDEMPOTENCY_KEY/);
  await assert.rejects(tools.apiRequest({ method: 'GET', path: '/v1/markets', idempotencyKey: 'k' }), /IDEMPOTENCY_KEY/);
  assert.equal(requests.length, 2);
});
test('fetch_doc resolves root-absolute llms.txt links against the origin and relative paths under the base path', async () => {
  const urls: string[] = [];
  const tools = createTools({ webUrl: 'https://pages.test/blinkmarket', apiUrl: 'http://localhost:3001', rpcUrl: 'http://localhost:8545', privateKey: key, maxTxs: 1,
    fetch: async (url) => { urls.push(String(url)); return new Response('ok'); } });
  await tools.fetchDoc({ path: 'llms.txt' });
  await tools.fetchDoc({ path: '/blinkmarket/docs/agents.md' });
  assert.deepEqual(urls, ['https://pages.test/blinkmarket/llms.txt', 'https://pages.test/blinkmarket/docs/agents.md']);
});

test('typed data rejects a caller-supplied domain type', async () => {
  await assert.rejects(setup().signTypedData({ domain: { chainId: 84532 }, types: { EIP712Domain: [], X: [{ name: 'x', type: 'uint256' }] }, primaryType: 'X', message: { x: 1 } }), /DOMAIN_TYPE/);
});
test('personal signing only consumes an outstanding wallet challenge once', async () => {
  const account = '0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266';
  const other = '0x0000000000000000000000000000000000000002';
  const message = ['Blink Market wallet identity binding v1', 'This signature only binds your identity. It does not authorize trading, token approvals, or withdrawals.', 'Origin: http://binding.test', 'Chain ID: 84532', `Address: ${account}`, 'Action: issue', 'Challenge ID: id', 'Nonce: nonce', 'Issued At: 2026-10-28T00:00:00.000Z', 'Expires At: 2026-10-28T00:05:00.000Z'].join('\n');
  let returned = message;
  const tools = createTools({ webUrl: 'http://localhost:3000', apiUrl: 'http://localhost:3001', rpcUrl: 'http://localhost:8545', privateKey: key, maxTxs: 1,
    fetch: async () => Response.json({ challengeId: 'id', message: returned, expiresAt: 'later' }) });
  await assert.rejects(tools.signMessage({ message: 'arbitrary' }), /CHALLENGE/);
  await tools.apiRequest({ method: 'POST', path: '/v1/auth/wallet-challenges', body: { address: other } });
  await assert.rejects(tools.signMessage({ message }), /CHALLENGE/);
  for (const invalid of [message.replace(account, other), message.replace('Chain ID: 84532', 'Chain ID: 1')]) {
    returned = invalid;
    await tools.apiRequest({ method: 'POST', path: '/v1/auth/wallet-challenges', body: { address: account } });
    await assert.rejects(tools.signMessage({ message: invalid }), /CHALLENGE/);
  }
  returned = message;
  await tools.apiRequest({ method: 'POST', path: '/v1/auth/wallet-challenges', body: { address: account.toUpperCase() } });
  assert.match(await tools.signMessage({ message }), /^0x/);
  await assert.rejects(tools.signMessage({ message }), /CHALLENGE/);
});
