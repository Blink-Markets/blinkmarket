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
