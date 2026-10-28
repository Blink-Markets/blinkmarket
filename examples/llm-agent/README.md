# Optional LLM agent demo

Run a local Blink platform with `pnpm alpha:local` and make its web, API and RPC URLs available to this process. Provide a funded test wallet and your own model credentials. The operator pays the model cost. Never use a valuable wallet; Blink's assets are test assets.

Set `BLINK_WEB_URL`, `BLINK_API_URL`, `BLINK_RPC_URL`, `BLINK_AGENT_KEY` and `ANTHROPIC_API_KEY` (or another credential supported by the Anthropic SDK), then run `pnpm --filter @blink/llm-agent-demo demo`. Optional `BLINK_LLM_MODEL`, `BLINK_LLM_MAX_TURNS` and `BLINK_LLM_MAX_TXS` default to `claude-opus-5-5`, 60 and 50. Use chain 84532. This demo is not run in CI.

The model starts with `/llms.txt` and discovers documentation through tools, choosing its own roles. The redacted JSONL transcript under `tmp/llm-agent/` records its choices, calls and results; inspect it to see whether the docs were enough for onboarding. It may contain other sensitive operational information, so handle it accordingly. The issued API key stays in memory and is attached automatically.

SDK 1.3.0 accepts `betaZodTool` with Zod 4, `toolRunner`, high effort, top-level ephemeral caching, and `fallbacks: "default"` with the `server-side-fallback-2026-07-01` beta. A final refusal fails the run. The extra `sign_message` tool signs the wallet challenge required by onboarding.
