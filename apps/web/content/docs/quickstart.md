---
title: Quickstart
description: Run Blink on your machine and make your first API call.
group: Get started
order: 2
agentTask: set up Blink locally and confirm the API answers
---

# Quickstart

Nothing in this guide spends gas, model credits or real money. Expect about ten minutes, most of it `pnpm install`.

## Before you begin

- Node.js 22.23.1
- pnpm 11.20.0
- Git

> [!NOTE]
> The local scaffold needs no database, RPC endpoint, model API key, wallet or `.env` file.

## 1. Clone and install

```sh
git clone https://github.com/Blink-Markets/blinkmarket.git
cd blinkmarket
pnpm install --frozen-lockfile
```

## 2. Run the checks

```sh
pnpm check
```

This runs type checks, unit tests, package boundary checks and contract checks.

## 3. Start the services

```sh
pnpm dev
```

| Service | Address | What it does today |
| --- | --- | --- |
| Web | `http://127.0.0.1:3000` | This site |
| API | `http://127.0.0.1:3001/v1/config` | Testnet configuration; no deployment, trading disabled |
| OpenAPI | `http://127.0.0.1:3001/openapi.json` | Request and response contracts from the shared schemas |
| Worker | `http://127.0.0.1:3002/health/live` | Liveness check |
| Indexer | `http://127.0.0.1:3003/health/live` | Liveness check; no block sync yet |
| Signer | `http://127.0.0.1:3004/health/live` | Liveness check; no signing API |

## 4. Make your first call

```sh
curl http://127.0.0.1:3001/v1/config
```

The response describes Base Sepolia (chain ID 84532) with no deployment and trading disabled.

> [!PLANNED]
> In the default scaffold mode, valid business requests return `501` and `/v1/health` returns `503`. Identity, preparation and approval modes enable more endpoints; see [Authentication](/docs/authentication).

## Hand it to your agent

```prompt
Set up Blink locally for me.
1. Use Node.js 22.23.1 and pnpm 11.20.0.
2. git clone https://github.com/Blink-Markets/blinkmarket.git && cd blinkmarket
3. pnpm install --frozen-lockfile, then pnpm check. Stop and report if any check fails.
4. Start everything with pnpm dev.
5. Call http://127.0.0.1:3001/v1/config and report the chain ID, the deployment value and whether trading is enabled.
Do not create wallets, add keys, or sign or send any transaction.
```

## Next steps

- [Concepts](/docs/concepts): the terms the API uses.
- [Authentication](/docs/authentication): prove wallet control and get an identity.
- [Agent guide](/docs/agents): the same setup, written for an agent to follow.
