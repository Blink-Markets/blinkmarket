# Optional LLM agent demo

## Run it

1. Start a platform that stays up: `pnpm alpha:serve` (from the repository root). It starts the local pglite alpha platform, prints `BLINK_API_URL`, `BLINK_RPC_URL` and the address of one funded test account, and runs until Ctrl-C (SIGINT or SIGTERM), which stops it and exits 0. (`pnpm alpha:local` is a test that shuts its platform down when it ends; do not use it for the demo.)
2. The funded account is Anvil's public test account at index 7 of the well-known mnemonic `test test test test test test test test test test test junk`. Its private key is public and is not printed; derive it from that mnemonic and index and use it as `BLINK_AGENT_KEY`. Never use a valuable wallet; Blink's assets are test assets.
3. Point `BLINK_WEB_URL` at the docs, either:
   - the deployed GitHub Pages site, `https://blink-markets.github.io/blinkmarket` (the base path is part of the URL; `llms.txt` is fetched as `<BLINK_WEB_URL>/llms.txt`). `build:pages` in `apps/web` produces this site with that base path and `llms.txt` links such as `/blinkmarket/docs/agents.md`, which resolve against the origin. This URL was not fetched from here (no network), so confirm the site is live; or
   - a local web dev server: `pnpm --filter @blink/web exec next dev --webpack --hostname 127.0.0.1 --port 3000`, then `BLINK_WEB_URL=http://127.0.0.1:3000`. Verified: with `--webpack`, `GET /llms.txt` and `GET /docs/agents.md` answer 200 and the links are `/docs/<page>.md`. The default Turbopack dev server (`pnpm --filter @blink/web dev`) could not be tried on the build host (its glibc is too old for Next's native bindings).
4. Set `BLINK_API_URL`, `BLINK_RPC_URL`, `BLINK_WEB_URL`, `BLINK_AGENT_KEY` and `ANTHROPIC_API_KEY` (or another credential supported by the Anthropic SDK), then run `pnpm --filter @blink/llm-agent-demo demo`. The operator pays the model cost. Optional `BLINK_LLM_MODEL`, `BLINK_LLM_MAX_TURNS` and `BLINK_LLM_MAX_TXS` default to `claude-opus-5-5`, 60 and 50. Use chain 84532. This demo is not run in CI.

`api_request` takes an optional `idempotencyKey` (1-128 printable ASCII characters, POST only), sent as the `Idempotency-Key` header that operations such as forecasts require.

The model starts with `/llms.txt` and discovers documentation through tools, choosing its own roles. The redacted JSONL transcript under `tmp/llm-agent/` records its choices, calls and results; inspect it to see whether the docs were enough for onboarding. It may contain other sensitive operational information, so handle it accordingly. The issued API key stays in memory and is attached automatically.

SDK 1.3.0 uses `betaTool` with Zod-derived schemas and validation inside the transcript wrapper, and accepts `toolRunner`, high effort, top-level ephemeral caching, and `fallbacks: "default"` with the `server-side-fallback-2026-07-01` beta. A final refusal fails the run. The extra `sign_message` tool signs the wallet challenge required by onboarding.
