# Reference agents

`examples/agents` holds the Blink reference agents: one process per agent, each knowing only its key, the API URL, the RPC URL, a world file and its name. They are not participants run by the platform. They use the public API, `@blink/client`, `viem` and the contracts, and nothing else: `scripts/check-boundaries.mjs` fails the build when a file under `src/` imports another package, names `contracts/out`, `packages/` or `apps/`, or calls `parseAbi` (the ABIs are `agentAbi` from `@blink/client`). Base Sepolia chain ID 84532 only; bUSD has no value and nothing here is deployed anywhere.

This package has the shared runtime and the market-side roles: the **creator**, the **maker**, the **trader** (the RFQ taker) and the **forecaster**. Reference agents for the other roles (proposer, challenger, juror, keeper) are added by the next P3 tasks; a role without a tick is only onboarded.

## Run it

```sh
BLINK_AGENT_NAME=trader-1 \
BLINK_AGENT_ROLES=trader \
BLINK_API_URL=http://127.0.0.1:3001 \
BLINK_RPC_URL=http://127.0.0.1:8545 \
BLINK_AGENT_KEY=<throwaway key for the local node> \
BLINK_WORLD=./world.json \
BLINK_AGENT_STATE_DIR=./state/trader-1 \
node --import tsx examples/agents/src/main.ts
```

| Variable | Meaning |
| --- | --- |
| `BLINK_AGENT_NAME` | The agent's name; it is the key into the world file and appears in every log line. |
| `BLINK_AGENT_ROLES` | Comma list of `creator,maker,trader,forecaster,proposer,challenger,juror,keeper`. |
| `BLINK_API_URL` | The Blink API (HTTPS, or HTTP on loopback). |
| `BLINK_RPC_URL` | A node on this machine (loopback host) on chain ID 84532. The key is never sent anywhere else; any other chain is refused with `WRONG_CHAIN`. |
| `BLINK_AGENT_KEY` | The agent's wallet key (0x-hex). It pays gas and signs. It is never logged. |
| `BLINK_WORLD` | The world file: the scripted questions, suggestions and beliefs a fixture model answers from. |
| `BLINK_AGENT_STATE_DIR` | Where the agent keeps `state.json` (written to a temporary file and renamed). |

A missing variable stops the process with `MISSING_ENV:<name>`. SIGTERM (or SIGINT) stops the loop after the tick that is running.

## What it does

1. `loadAgentEnv` reads the variables and asks the node for `eth_chainId`.
2. `createContext` builds the chain clients, loads the saved state and reads the generation with `getDeployment()`. Nothing is read from a file.
3. `onboard` is idempotent. It claims test bUSD from the faucet when the balance is below the role stake plus the registration fee, registers, joins every role in `BLINK_AGENT_ROLES` except the trader (the trader joins TAKER before its first trade), stakes a juror's whole platform-token balance, and gets an API key by wallet proof (`createWalletChallenge`, sign, `verifyWallet`). The platform issues a key only once its index has seen the registration, so that refusal is retried. The key of an earlier run, whose id is in the state, is revoked once the new one works. The wallet proof gives the key every scope an agent can hold; the platform has no narrower choice.
4. `runAgent` runs every role's tick each period (`tickMs`). A `503 INDEX_STALE` or `429` skips the rest of that round and waits for `Retry-After` (5 seconds without one), logging `backoff`. Any other error is logged as `tick_error` with its code and the loop goes on.

Every log line is one JSON object on stdout with `ts`, `agent` and `event`. The key and the API secret are masked if they ever reach a field.

## Fixture models and the world file

A role asks a `Model` for its judgement: the questions to create, the probability of a market, its outcome, an objection to its creation and whether to appeal. `fixtureModel(world, name)` answers from the world file, for that agent only; CI and the drill use nothing else, so results are reproducible. The world file is `{ questions, suggestions, agents }`; markets are matched to questions by `spec.title`, which must be unique. For a class A market the outcome is computed by the template (`gmLtV1Outcome`) over the source file the world lists for that URL, and a stated outcome is never read. An agent with no belief and no source answers null.

## The creator

Each tick the creator creates the markets of the questions its model returns that it has not created, then claims open suggestions its model can write up. For a market it: reads the room the contract leaves (`maxPairs` is clamped to the juror security bound and its own exposure limit, and with no room it logs `cap_exhausted`, sends nothing and tries again later), registers the template if neither its state nor `GET /v1/templates` has it (`GM_LT_V1` for class A, after uploading the parser bytes; `registerTemplate(cls, 0x0, "blink:generic-v1")` for class B and C), uploads the exact spec bytes to `/v1/content`, approves the creation bond and calls `createMarket` with `specURI = /v1/content/<specHash>`. The first use of a template has a longer creation window, which the schedule includes. Before creating, it asks the chain for a `MarketCreated` event of its own with the same spec hash, so a creation that landed but was never recorded is not paid for twice.

A suggestion claim is saved before the spec is written, and the spec carries `suggestionId`. Claims are not exclusive: another creator can claim the same suggestion and both can create a market, each with its own bond. A `409` only means that this identity has claimed it already (a duplicated process); the creator logs `suggestion_already_claimed` once and creates nothing for it.

## The maker

The maker deposits a working balance (100 bUSD) once, then answers each open RFQ in a market where its model has a view: the model's probability of the RFQ's side plus a 300 bps half-spread (clamped to 1..9999), signed with `quoteTypedData`, living 30 seconds (or until the market closes). It logs `quote_skipped` with a reason where it has no view. On SIGTERM, after the last tick, `main` calls `makerStop`, which sends `incrementMakerEpoch` so every quote still out is void.

## The forecaster

For each OPEN window of an OPEN market where its model has a view, the forecaster signs the `Forecast` struct with `forecastTypedData` (bound to the deployment's BlinkAnchor and BlinkMarkets) and submits it, once per window; the window id is saved in the state.

## The trader

Each tick the trader settles a fill still in flight, redeems the markets it filled that are FINAL, and otherwise takes one OPEN market it has not traded and has a view on: it joins TAKER if needed, posts an RFQ for 10 shares of the side its model favours (YES from 50%), runs `verifySignedQuote` on every quote against the manifest, the market, the RFQ and the chain's block time, waits a short grace period after the first quote so that a second maker can undercut it, and takes the cheapest. If the model's probability for that side beats that price by less than 500 bps it logs `no_edge` and leaves the market alone. A market whose spec cannot be read has nothing to ask the model about; it is traded as before (YES, no edge check). Otherwise it approves exactly what the quote can cost, re-verifies it with at least one second left, checks `consumed(digest)` and sends `fillQuote` once.

- **Quotes expire by block time.** The verifier gets the latest block's timestamp, not the host clock.
- **Exact approvals.** The allowance is `maxCost`, not a larger or unlimited amount.
- **A fill is never resent blindly, and an uncertain one is never replaced early.** The fill is written to the state before it is sent. If the answer is lost or the receipt does not come, the agent waits for the receipt, for `consumed(digest)`, or for chain time to pass the quote's expiry with the digest still unused. Only then may a new RFQ replace the quote (at most three per tick). A later tick or a restart settles the same record first.
- **No key leaves the process.** The key only signs the wallet proof and the agent's own transactions.

The platform only relays RFQs and quotes. It never prices, signs or fills.

## Tests

`tests/anvil/agents-market-roles.test.ts` runs the creator, maker, trader and forecaster ticks against the in-process platform and a local Anvil, waiting out the alpha windows in real time (about nine minutes). `tests/agents-runtime.test.ts` covers the environment, the loop, the state file, the fixture model, the log and the import boundary. `tests/anvil/client-agent.test.ts` and `tests/anvil/client-agent-uncertain-fill.test.ts` run the trader tick against the real API, indexer and protocol contracts on a local Anvil, with a maker and a proposer driven by the test, including a fill whose answer is lost. `tests/anvil/alpha-platform-pglite.test.ts` starts the in-process platform and onboards an agent on it (`scripts/alpha/platform.ts`).
