import Anthropic from '@anthropic-ai/sdk';
import { betaZodTool } from '@anthropic-ai/sdk/helpers/beta/zod';
import { ToolError } from '@anthropic-ai/sdk/resources/beta/messages';
import { z } from 'zod';
import { appendFile, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import type { Hex } from 'viem';
import { createTools, redact } from './tools.ts';

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing ${name}`);
  return value;
}
function limit(name: string, fallback: number): number {
  const value = Number(process.env[name] ?? fallback);
  if (!Number.isSafeInteger(value) || value < 1) throw new Error(`Invalid ${name}`);
  return value;
}
async function main() {
  const key = required('BLINK_AGENT_KEY') as Hex;
  const tools = createTools({ webUrl: required('BLINK_WEB_URL'), apiUrl: required('BLINK_API_URL'), rpcUrl: required('BLINK_RPC_URL'), privateKey: key, maxTxs: limit('BLINK_LLM_MAX_TXS', 50) });
  const llms = await tools.fetchDoc({ path: 'llms.txt' });
  const dir = fileURLToPath(new URL('../../../tmp/llm-agent/', import.meta.url));
  await mkdir(dir, { recursive: true });
  const file = join(dir, `${new Date().toISOString().replaceAll(':', '-')}.jsonl`);
  const secrets = () => [...tools.secrets, process.env.ANTHROPIC_API_KEY ?? ''];
  const log = async (entry: unknown) => appendFile(file, redact(JSON.stringify(entry, (_, value: unknown) => typeof value === 'bigint' ? value.toString() : value), secrets()) + '\n', { mode: 0o600 });
  function wrap<T>(name: string, fn: (input: T) => Promise<unknown>) {
    return async (input: T) => {
      await log({ type: 'tool_call', name, input });
      try {
        const result = await fn(input);
        const json = JSON.stringify(result, (_, value: unknown) => typeof value === 'bigint' ? value.toString() : value) ?? 'null';
        await log({ type: 'tool_result', name, result });
        return redact(json, secrets());
      } catch (error) {
        const code = error instanceof Error ? error.message : 'TOOL_ERROR';
        const json = redact(JSON.stringify({ code }), secrets());
        await log({ type: 'tool_result', name, is_error: true, result: JSON.parse(json) });
        throw new ToolError(json);
      }
    };
  }
  const chainInput = z.object({ address: z.string(), signature: z.string(), args: z.array(z.unknown()) });
  const definitions = [
    betaZodTool({ name: 'fetch_doc', description: 'Read a documentation path on the supplied web origin.', inputSchema: z.object({ path: z.string() }), run: wrap('fetch_doc', tools.fetchDoc) }),
    betaZodTool({ name: 'api_request', description: 'Call the Blink API. The session key is attached automatically. Operations that need an Idempotency-Key header (such as forecasts) take idempotencyKey: 1-128 printable ASCII characters, POST only.', inputSchema: z.object({ method: z.enum(['GET', 'POST']), path: z.string(), body: z.unknown().optional(), idempotencyKey: z.string().optional() }), run: wrap('api_request', tools.apiRequest) }),
    betaZodTool({ name: 'chain_read', description: 'Read a deployed contract using one human-readable function signature.', inputSchema: chainInput, run: wrap('chain_read', tools.chainRead) }),
    betaZodTool({ name: 'chain_write', description: 'Send a transaction to a deployed contract using one human-readable function signature.', inputSchema: chainInput, run: wrap('chain_write', tools.chainWrite) }),
    betaZodTool({ name: 'sign_typed_data', description: 'Sign EIP-712 typed data on chain 84532.', inputSchema: z.object({ domain: z.record(z.string(), z.unknown()), types: z.record(z.string(), z.array(z.object({ name: z.string(), type: z.string() }))), primaryType: z.string(), message: z.record(z.string(), z.unknown()) }), run: wrap('sign_typed_data', tools.signTypedData) }),
    betaZodTool({ name: 'sign_message', description: 'Sign the exact wallet challenge message using personal sign.', inputSchema: z.object({ message: z.string() }), run: wrap('sign_message', tools.signMessage) }),
    betaZodTool({ name: 'wait', description: 'Wait up to 120 seconds.', inputSchema: z.object({ seconds: z.number() }), run: wrap('wait', async ({ seconds }) => { if (seconds < 0 || seconds > 120) throw new Error('WAIT_LIMIT'); await new Promise((resolve) => setTimeout(resolve, seconds * 1000)); return { waited: seconds }; }) }),
  ];
  const client = new Anthropic();
  const runner = client.beta.messages.toolRunner({ model: process.env.BLINK_LLM_MODEL ?? 'claude-opus-5-5', max_tokens: 16000, output_config: { effort: 'high' }, cache_control: { type: 'ephemeral' }, betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default', system: llms, tools: definitions, messages: [{ role: 'user', content: `Explore Blink, choose your own roles and participate. Your wallet address is ${tools.address}.` }] });
  let turns = 0;
  for await (const message of runner) {
    await log({ type: 'assistant', content: message.content, stop_reason: message.stop_reason });
    if (message.stop_reason === 'refusal') throw new Error('MODEL_REFUSAL');
    if (++turns >= limit('BLINK_LLM_MAX_TURNS', 60)) break;
  }
  console.log(`Transcript: ${file}`);
}
main().catch(() => { console.error('LLM agent failed; inspect the redacted transcript.'); process.exitCode = 1; });
