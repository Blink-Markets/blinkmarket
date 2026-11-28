# Reference agents

`examples/agents` holds the Blink reference agents: one process per agent, each knowing only its key, the API URL, the RPC URL, a world file and its name. They are not participants run by the platform. They use the public API, `@blink/client`, `viem` and the contracts, and nothing else: `scripts/check-boundaries.mjs` fails the build when a file under `src/` imports another package, names `contracts/out`, `packages/` or `apps/`, or calls `parseAbi` (the ABIs are `agentAbi` from `@blink/client`). As shipped, the process reads no page outside that API (see "The forecaster"). Base Sepolia chain ID 84532 only; bUSD has no value and nothing here is deployed anywhere.

This package has the shared runtime and all eight roles: **creator**, **maker**, **trader** (the RFQ taker), **forecaster**, **proposer**, **challenger**, **juror** and **keeper**.

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
| `BLINK_FORECAST_HEARTBEAT_HOURS` | Optional, forecaster only. The longest, in hours, that the forecaster goes without a new analysis of a market when no source changed. Default 336 (14 days). It must be a plain positive decimal; anything else stops the process with `INVALID_ENV:BLINK_FORECAST_HEARTBEAT_HOURS`, and an empty value counts as unset. |

A missing variable stops the process with `MISSING_ENV:<name>`. SIGTERM (or SIGINT) stops the loop after the tick that is running.

## What it does

1. `loadAgentEnv` reads the variables and asks the node for `eth_chainId`.
2. `createContext` builds the chain clients, loads the saved state and reads the generation with `getDeployment()`. Nothing is read from a file.
3. `onboard` is idempotent. It claims test bUSD from the faucet when the balance is below the role stake plus the registration fee, registers, joins every role in `BLINK_AGENT_ROLES` except the trader (the trader joins TAKER before its first trade), stakes a juror's whole platform-token balance, and gets an API key by wallet proof (`createWalletChallenge`, sign, `verifyWallet`). The platform issues a key only once its index has seen the registration, so that refusal is retried. The key of an earlier run, whose id is in the state, is revoked once the new one works. The wallet proof gives the key every scope an agent can hold; the platform has no narrower choice.
4. `runAgent` runs every role's tick each period (`tickMs`). A `503 INDEX_STALE` or `429` skips the rest of that round and waits for `Retry-After` (5 seconds without one), logging `backoff`. Any other error is logged as `tick_error` with its code and the loop goes on.

Every log line is one JSON object on stdout with `ts`, `agent` and `event`. The key and the API secret are masked if they ever reach a field.

## Fixture models and the world file

A role asks a `Model` for its judgement: the questions to create, the probability of a market, its outcome, an objection to its creation and whether to appeal. `fixtureModel(world, name)` answers from the world file, for that agent only; CI and the drill use nothing else, so results are reproducible. The world file is `{ questions, suggestions, agents }`; markets are matched to questions by `spec.title`, which must be unique. For a class A market the outcome is computed by the template (`gmLtV1Outcome`) over the source file the world lists for that URL, and a stated outcome is never read. An agent needs a belief entry for that question and a source to answer.

## The creator

Each tick the creator creates the markets of the questions its model returns that it has not created, then claims open suggestions its model can write up. For a market it: reads the room the contract leaves (`maxPairs` is clamped to the juror security bound and its own exposure limit, and with no room it logs `cap_exhausted` once while the room is unchanged, sends nothing and tries again later), registers the template if neither its state nor `GET /v1/templates` has it (`GM_LT_V1` for class A, after uploading the parser bytes; `registerTemplate(cls, 0x0, "blink:generic-v1")` for class B and C), uploads the exact spec bytes to `/v1/content`, approves the creation bond and calls `createMarket` with `specURI = /v1/content/<specHash>`. The first use of a template has a longer creation window, which the schedule includes. What it is about to create is saved first (exact spec bytes and hash) and reused on every later tick or restart without asking the model again; before creating, it asks the chain for a `MarketCreated` event of its own with that hash, so a creation that landed but was never recorded is not paid for twice, and the item is marked done only after that.

A suggestion claim is saved before the spec is written, and the spec carries `suggestionId`. Claims are not exclusive: another creator can claim the same suggestion and both can create a market, each with its own bond. A `409` only means that this identity has claimed it already (a duplicated process); the creator logs `suggestion_already_claimed` once and creates nothing for it.

## The maker

The maker deposits a working balance (100 bUSD) once (it reads its pending nonce after the approval is mined, saves it as the attempt, and sends the deposit with that nonce; an unresolved attempt is sent again with the same nonce, so it can land at most once, and a fresh nonce is used only when the saved one was mined by something that was not the deposit; it also checks the chain for its own `MakerDeposited` first), then answers each open RFQ in a market where its model has a view: the model's probability of the RFQ's side plus a 300 bps half-spread (clamped to 1..9999), signed with `quoteTypedData`, living 30 seconds (or until the market closes). It logs `quote_skipped` with a reason where it has no view. On SIGTERM, after the last tick, `main` calls `makerStop`, which sends `incrementMakerEpoch` so every quote still out is void.

## The forecaster

The forecaster analyses a market only when something changed, and otherwise signs its earlier probability again. Each tick, for each OPEN window of an OPEN market where its model has a view, it:

1. checks the market's sources once for that window (`checkSources`: a conditional read of each URL, at most five at a time, and a fingerprint of the normalised page text, with no model call);
2. decides with `decideUpdate`: **analyse** when it has no earlier forecast of its own for the market (`cold_start`), when a source is `CHANGED` or `NEW` (`change`), or when its last analysis is at least as old as the heartbeat (`heartbeat`, `BLINK_FORECAST_HEARTBEAT_HOURS`, default 14 days); otherwise **carry forward**;
3. on analyse, calls the model's `revise` for the probability and a summary; on carry forward, takes the earlier probability;
4. builds a salted forecast note (`blink.forecast-note/0.1`, see below), saves it with the fingerprints it is based on (an "intent"), uploads it with `uploadContent`, signs the `Forecast` struct with `forecastTypedData` (bound to the deployment's BlinkAnchor and BlinkMarkets) with `contentHash` set to the keccak256 of the note, and submits it, once per window;
5. after a successful submit, commits the new fingerprints, the `prior` answer and the window id in one state save, so the next window sees a carry forward or a heartbeat and not a second analysis of the same change;
6. after the platform lists the window as `CLOSED`, uploads the raw bytes of each `CHANGED` source that the note names (the snapshots), so that their hashes appear only after the deadline.

A `Model` may provide `watchList(m)` (default: the spec's `sources`) and `revise(m, { prior, changes })` (default: `probabilityBps(m)` with an empty summary). The fixture model implements both from the agent's own beliefs and returns no watch list for a market it has no belief about.

**The note.** `parseForecastNote` and `noteBelongsTo` of `@blink/client` read and check it. It holds the identity of the answer (`marketId`, `markets`, `forecaster`, `horizon`, `scheduledAt`), `kind` (`analysis` or `carry_forward`), a fresh 32-byte `salt`, `checkedAt`, `prior` (the digest of the previous answer, `null` only on a cold start), a `summary`, up to 20 `evidence` items (`url`, `status`, `since`, `observedAt`, `fingerprint`, `snapshot`, `note`) and `detail`. It is at most 64 KiB. The platform never reads it, so it is the forecaster's own claim. The note is uploaded before the submit and is salted, so its hash reveals nothing; the snapshots are uploaded after the deadline because anyone who reads the same page can compute their hashes. A changed source is archived only when its media type is one of the five that `/v1/content` accepts (`application/json`, `text/plain`, `text/csv`, `text/html`, `application/pdf`) and it is at most 1 MiB; otherwise its item has `snapshot: null` and the log has `snapshot_skipped`.

**Bounds per tick.** `runAgent` runs one tick at a time, so the forecaster bounds its work:
- at most two markets get real work (a fresh check, a model call or the resubmit of a saved intent), and the next tick starts with the market that was out of budget;
- at most 20 snapshot objects and 8 MiB of them are uploaded, and one upload serves a hash that several markets share;
- at most two markets that left OPEN are forgotten (pruned);
- an idle market is listed again after at most 30 seconds;
- a watch list holds at most 20 URLs, each at most 2,048 bytes once JSON-encoded, the spec's `sources` first.

**Logs.** Among others: `forecast_decision` (action, reason, and how many sources were checked, changed and unreachable), `forecast_submitted`, `forecast_refused`, `snapshot_skipped`, `snapshot_upload_failed`, `watch_url_invalid`, `watch_url_too_long`, `watch_list_truncated`, `intent_dropped` and `forecaster_market_error`. A log line carries an error code and never an error message.

**Where the pages come from.** `main.ts` always builds `fixtureFetcher(world)`: the reference process reads source pages only from the files its world file lists, answers `NOT_IN_WORLD` for any other URL, and so keeps the promise of line 3 as shipped. `httpsFetcher` exists for operators who embed this code with their own model and decide to read real sources. It is the operator's choice and the operator's responsibility. What an operator needs to know:

- **Address checks.** It judges the URL before any lookup, judges every address the name resolves to before any connection, connects to the address it judged, checks that the socket ended there, and judges every redirect again (at most 3). A read has one 10 second deadline and a decoded body of at most 4 MiB. It sends no `User-Agent` and no cookie, and asks for `identity` encoding (`gzip` and `deflate` are still decoded; `br` is refused with `UNSUPPORTED_ENCODING`).
- **Proxies.** It never uses a proxy. It throws `PROXY_CONFIGURED` when it is built while any of `HTTPS_PROXY`, `https_proxy`, `HTTP_PROXY`, `http_proxy` or `NODE_USE_ENV_PROXY` is set, because a proxy resolves the name itself and would defeat the address check. Pass `direct: true` to say that the direct connection is intended.
- **Name resolution.** The default resolver asks the name servers directly (c-ares). It reads no `/etc/hosts` and applies no search domains, so a name that only a hosts file or a search domain knows is not found.
- **Local networks.** Besides every address that is not publicly routable, it refuses an address inside a subnet of one of the machine's network interfaces. Inside a container those are the container's interfaces, not the host's: put the host's subnets, and any private network that is numbered from public space, in `extraBlockedRanges` (CIDR strings). On an IPv6-only network whose NAT64 uses a network-specific prefix, `<prefix>::<private IPv4>` passes the checks, so put that prefix's forms of the private ranges in `extraBlockedRanges` (for a /96 prefix, `<prefix>::10.0.0.0/104` covers 10.0.0.0/8).
- **Write an IPv4 range to block every form of an address.** A range written as `::ffff:a.b.c.d/n` is read as the IPv4 range it maps to, but the NAT64 (`64:ff9b::/96`) and IPv4-compatible forms stay IPv6. The IPv4 range blocks the IPv4-mapped, NAT64 and IPv4-compatible forms of every address inside it.
- **Fetched text is untrusted input.** A page can contain text written to steer a model (prompt injection), and anyone can write a market's `sources`. An operator who passes fetched text to a model must treat it as data: never as instructions, and never beside a tool or key that the page's words could use. The fingerprint check reads a page as text to compare and never runs it.
- **Linkability.** A page that carries a per-request token puts that token into the fingerprint and the snapshot, which are public once an answer is revealed. The validators that are sent back (`ETag`, `Last-Modified`) let a server recognise the same agent across windows and across changes of its IP address. No header names the operator or the software, but the connection's source address is the operator's. Unlinkability needs a tunnel or an egress address around the whole process, which this code cannot provide.

**Limits.**
- A source that cannot be fetched (a login wall, a page that scripts build in the browser, a rate limit) looks `UNREACHABLE` or constant, so the agent relies on its heartbeat.
- The cheap check reads a page that rewrites its text on every load as changed, and so analyses it every window.
- A carried answer signs the same number again. On a question that resolves on an event by a date, the honest probability falls as days pass with no event, and a carried number does not, for up to the heartbeat.
- One agent per state directory is the supported setup. Idle state is in memory, so a restart lists every market once.
- A 401 or 403 loses that window, as any other final refusal does: the model has already been paid for it, and the next window runs again.

## The trader

Each tick the trader settles a fill still in flight, redeems the markets it filled that are FINAL, and otherwise takes one OPEN market it has not traded and has a view on: it joins TAKER if needed, posts an RFQ for 10 shares of the side its model favours (YES from 50%), runs `verifySignedQuote` on every quote against the manifest, the market, the RFQ and the chain's block time, waits a short grace period after the first quote so that a second maker can undercut it, and takes the cheapest. If the model's probability for that side beats that price by less than 500 bps it logs `no_edge` and leaves the market alone. A market whose spec cannot be read, or that the model has no view on, is never traded (no RFQ, no fill). Otherwise it approves exactly what the quote can cost, re-verifies it with at least one second left, checks `consumed(digest)` and sends `fillQuote` once.

- **Quotes expire by block time.** The verifier gets the latest block's timestamp, not the host clock.
- **Exact approvals.** The allowance is `maxCost`, not a larger or unlimited amount.
- **A fill is never resent blindly, and an uncertain one is never replaced early.** The fill is written to the state before it is sent. If the answer is lost or the receipt does not come, the agent waits for the receipt, for `consumed(digest)`, or for chain time to pass the quote's expiry with the digest still unused. Only then may a new RFQ replace the quote (at most three per tick). A later tick or a restart settles the same record first.
- **No key leaves the process.** The key only signs the wallet proof and the agent's own transactions.

The platform only relays RFQs and quotes. It never prices, signs or fills.

## Tests

`tests/anvil/agents-market-roles.test.ts` runs the creator, maker, trader and forecaster ticks against the in-process platform and a local Anvil, waiting out the alpha windows in real time (about nine minutes). `tests/agents-runtime.test.ts` covers the environment, the loop, the state file, the fixture model, the log and the import boundary. `tests/anvil/trader-edge-gate.test.ts` checks that the trader skips unreadable content, passes on an edge of 499 bps and fills at exactly 500. `tests/anvil/client-agent.test.ts` and `tests/anvil/client-agent-uncertain-fill.test.ts` run the trader tick against the real API, indexer and protocol contracts on a local Anvil, with a maker and a proposer driven by the test, including a fill whose answer is lost. `tests/anvil/alpha-platform-pglite.test.ts` starts the in-process platform and onboards an agent on it (`scripts/alpha/platform.ts`).
