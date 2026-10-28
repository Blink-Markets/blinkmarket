import { test } from 'node:test';
import assert from 'node:assert/strict';
import Anthropic from '../examples/llm-agent/node_modules/@anthropic-ai/sdk/index.mjs';
import { createTools, redact } from '../examples/llm-agent/src/tools.ts';
import { createToolDefinitions } from '../examples/llm-agent/src/main.ts';

const key = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80';
async function invoke(input: unknown) {
  let calls = 0;
  const transcript: string[] = [];
  const tools = createTools({ webUrl: 'http://localhost:3000', apiUrl: 'http://localhost:3001', rpcUrl: 'http://localhost:8545', privateKey: key, maxTxs: 1,
    fetch: async () => { calls++; return Response.json({ nested: [{ apiKey: 'other-secret' }] }); } });
  const definitions = createToolDefinitions(tools, async (entry) => { transcript.push(redact(JSON.stringify(entry), tools.secrets)); }, () => tools.secrets);
  let requests = 0;
  let toolResult: { content: string; is_error?: boolean } | undefined;
  const client = new Anthropic({ apiKey: 'fixture-key', webhookKey: null, baseURL: 'https://fixture.invalid', maxRetries: 0, fetch: async (url, init) => {
    if (String(url) !== 'https://fixture.invalid/v1/messages') throw new Error('unexpected fixture URL: ' + String(url));
    const body = JSON.parse(String(init?.body));
    requests++;
    if (requests === 2) toolResult = body.messages.at(-1).content[0];
    assert.ok(requests <= 2);
    return Response.json({ id: 'msg_fixture', type: 'message', role: 'assistant', model: 'fixture', content: requests === 1 ? [{ type: 'tool_use', id: 'tool_fixture', name: 'api_request', input }] : [{ type: 'text', text: 'done' }], stop_reason: requests === 1 ? 'tool_use' : 'end_turn', stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 } });
  } });
  for await (const _message of client.beta.messages.toolRunner({ model: 'fixture', max_tokens: 100, tools: definitions, messages: [{ role: 'user', content: 'test' }] })) { /* consume fixture */ }
  assert.equal(requests, 2);
  assert.ok(toolResult);
  return { toolResult, transcript: transcript.join('\n'), calls };
}
test('SDK tool runner validates inside the transcript wrapper', async () => {
  const result = await invoke({ method: 'DELETE', path: '/v1/x', body: { privateKey: key } });
  assert.equal(result.toolResult.is_error, true);
  assert.deepEqual(JSON.parse(result.toolResult.content), { code: 'INVALID_INPUT' });
  assert.equal(result.calls, 0);
  assert.match(result.transcript, /tool_call/); assert.match(result.transcript, /tool_result/);
  assert.doesNotMatch(result.transcript, new RegExp(key));
});
test('SDK tool wrapper refuses encoded paths and masks keys on unrelated routes', async () => {
  const encoded = await invoke({ method: 'POST', path: '/v1/auth/wallet-verification%73' });
  assert.equal(encoded.toolResult.is_error, true);
  assert.deepEqual(JSON.parse(encoded.toolResult.content), { code: 'API_PATH' });
  assert.equal(encoded.calls, 0);
  const result = await invoke({ method: 'GET', path: '/v1/markets' });
  assert.equal(result.calls, 1);
  assert.doesNotMatch(result.toolResult.content + result.transcript, /other-secret/);
  assert.match(result.toolResult.content, /\[REDACTED\]/);
});
test('model-facing typed signing refuses a string chain ID before signing', async () => {
  const tools = createTools({ webUrl: 'http://localhost:3000', apiUrl: 'http://localhost:3001', rpcUrl: 'http://localhost:8545', privateKey: key, maxTxs: 1 });
  const definitions = createToolDefinitions(tools, async () => {}, () => tools.secrets);
  const tool = definitions.find((definition) => definition.name === 'sign_typed_data');
  assert.ok(tool);
  await assert.rejects(async () => tool.run({ domain: { chainId: '84532' }, types: { X: [{ name: 'x', type: 'uint256' }] }, primaryType: 'X', message: { x: 1 } }), /WRONG_CHAIN/);
});
