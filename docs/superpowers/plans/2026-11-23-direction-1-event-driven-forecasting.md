# Direction 1: Event-Driven Forecasting Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Forecasting agents stop paying for a full analysis in every forecast window. They run a cheap "did the sources change?" check first and run the expensive analysis only when something changed (or when a staleness limit is reached), then update through the existing forecast windows. The website shows how fresh each forecast is and which evidence changed. No contract changes.

**Architecture:**
- `@blink/schemas` gains one new document type, the forecast note, and two pure functions that turn notes into a freshness summary. The signed `Forecast` EIP-712 type does not change: the note is the document that the existing `contentHash` field already points to.
- `examples/agents` gains a safe source watcher and an event-driven forecaster tick. The model is asked for a new forecast only when the watcher reports a change, a heartbeat is due, or there is no earlier forecast. The reference agent process reads sources only through a fetcher that it is given, and by default that fetcher serves the world file's fixtures (OQ12).
- `@blink/client` gains a reader that composes the existing public routes into the freshness summary. No API route is added unless the user chooses it (OQ10).
- `apps/web` shows freshness and the evidence changes on the market page and in the forecast chart. The site is a static export with sample data and makes no API calls today (section 1.5), so this stage shows the new views on sample markets; reading live data is open question OQ9.

**Tech Stack:**
- Node 22, TypeScript, pnpm workspace
- viem (hashing and signing in the agents)
- zod (the note schema)
- Next 16 static export (website)
- Anvil (chain 84532) for the chain-facing tests

**Decision record:** [the long-horizon discussion](../specs/2026-11-16-long-horizon-forecasting-discussion.md) (`docs/superpowers/specs/2026-11-16-long-horizon-forecasting-discussion.md`). Direction 1 is built as planned (Q13, section 8). The user's description of it, quoted from the user's original brief (written in English), which this plan implements:

> Event-driven forecasting, with no contract change. How it works: agents run cheap "did the source change?" checks and run expensive analysis only on news, then update through the existing windows. The site shows how fresh each forecast is and what evidence changed. Limits: it lowers cost but adds no revenue, and others can copy the last revealed consensus.

**Where work lands:** `main`, the repository's established branch (`AGENTS.md`: push to "the established project remote and branch"). There is no feature branch. Each implementer works in its own git worktree on a throwaway branch; after a task passes its checks and its review, the controller merges that task into `main` in wave order and pushes it (section 5, checkpoint procedure). A push to `main` runs CI, the nightly drill picks it up on its next run, and, once CI passes, the website deploys (section 4).

**Decision log:** the controller's written record, kept outside the tracked files, of the user's answers to the open questions, each task's state and each review result.

**Prerequisite:** the current main with green CI. The open questions in section 3 are answered by the user, and the controller records the answers in the decision log, before Task 1 starts.

## Global Constraints

- **No contract change, and no change to the signed forecast type.** The `Forecast` types in `packages/schemas/src/research.ts` (lines 19-29) and the digest of a fixed message stay byte for byte the same. Task 1 pins both with a test. Changing the type would break every agent that signs forecasts (OQ1, option b), so it needs the user's explicit answer first.
- **Consensus fallback, credit and the bounty mechanism are out of scope.** The consensus fallback and credit change with the next contract generation (`2026-11-16-long-horizon-forecasting-discussion.md`, 12.5, Q9 and Q10). Nothing in this plan edits `packages/domain/src/consensus.ts` or the credit queries.
- **Mechanism R stays off the website** until it is built (U24; discussion record 12.5, "What does not change yet"). No page or doc added here mentions the bounty, a sponsor or paid baselines.
- **The reference agents stay outside the platform, and they stay API-only by default.** They use only the public API, `@blink/client`, `viem`, `node:*` and their own files (`scripts/check-boundaries.mjs`), and `examples/agents/README.md` (line 3) and the agents docs promise that they use "the public API … and nothing else". So the agent process never fetches from the network unless the operator opts in (OQ12): `main.ts` builds the fixture fetcher, and `createContext` requires a `fetcher` and has no network default. A fetcher written for the examples may not import `packages/`; it carries its own copy of the address rules and a test that compares it with the platform's (OQ11). No file under `examples/agents/src`, comments included, contains the strings `packages/`, `apps/` or `contracts/out`.
- **The watcher never reads the platform's revealed consensus or other agents' answers as a signal.** `apps/web/content/docs/forecaster.md` says: do not look for or copy others' answers. The "others can copy the last revealed consensus" limit stays a limit, not something this plan tries to fix (section 2.9).
- **A forecast note is a claim, not a proof.** The platform does not read or check it (OQ2). Every place that shows a note says that the forecaster reported it, and shows as verified only what can be checked: the window time (platform clock), the answer's signature and the hash of an archived snapshot.
- **Nothing uploaded before a window's deadline may reveal the sealed answer** (Review Focus 8, OQ13).
- **The website introduces the product.** No status labels ("implemented", "deployed", "under construction"), no competitor names, no invitations to sign up or trade, media inline (`tests/showcase-claims.ts`, U24). Sample views stay labelled "Sample data".
- **Fixture models and fixture fetchers in every test and in the drill.** Results are reproducible and no test touches the network.
- **No manual deployment, paid service, signing of a real transaction or broadcast to a public network** (`AGENTS.md`). The only deployment is the Pages deploy that a green push to `main` already starts (section 4). Chain 84532 on local Anvil only.
- **Internal docs are English only.** Tracked files describe no particular machine, account or local tool setup; record verification limits as facts ("not run locally; CI ran it").
- **Commits are made by the controller, not by implementers** (`AGENTS.md`, "Agent roles and delegation"). They use the controller's own identity, linked to its GitHub account, and end with the attribution lines the session gives. Never rewrite pushed history.
- **Stage checkpoints (`AGENTS.md`)** follow the checkpoint procedure in section 5. Do not label the milestone complete before Task 6.

## Review Focus

1. **The signed type is unchanged.** A forecast signed by the new forecaster must verify with the old `forecastTypedData` and differ from an old one only in `contentHash`. Test: Task 1 `the Forecast typed data and a fixed digest are unchanged`; Task 3 `the signed message equals the old shape except contentHash`.
2. **A source URL chosen by a market creator points inside the agent's network.** The cheap check fetches URLs that anyone can put into a market spec (`spec.sources`, up to 10 https URLs). Tests: Task 2 `a URL with userinfo, a non-443 port, a non-https scheme or an IP-literal host is refused before any socket opens`, `a lookup answer with one public and one private address is refused`, `httpsRequestOptions pins the connection to the checked address`, `the default transport passes those options to request` and `every redirect is checked again`.
3. **A page that changes on every fetch** (a timestamp, a nonce, an ad) must not trigger an analysis every window, which would defeat the saving. Tests: Task 2 `a script nonce and a timestamp attribute keep the fingerprint`; Task 3 `a source that differs only in noise runs no analysis`.
4. **A crash between uploading the note and submitting the forecast.** The agent must resubmit the same bytes (same digest, replayed receipt), not a second note, and must not lose its record of what it last forecast. Test: Task 3 `restart after the intent was saved resubmits identical bytes`.
5. **One answer per window, and withdrawing does not free the slot.** A forecast cannot be amended inside its window (section 1.3). The agent decides once per window and never plans a two-step "carry forward now, correct later". Test: Task 3 `one decision per window, even when the source changes after the answer`.
6. **A note that lies about its subject or its times.** A note for another window, market, deployment or forecaster, or one whose evidence times fall outside its window, must not make a market look fresher or push `evidenceChangedAt` to a time that cannot be true. Tests: Task 1 `a note for another window, market, deployment or forecaster is unreadable` and `evidence items with times outside the window are ignored`; Task 4 `a missing note, a hash mismatch, an invalid note and a note for another window, market or forecaster each count as noNote and never throw`.
7. **The site claims more than it knows.** A sample view must not read like a live record, a closed market must not read as "current", and "fresh" must not read like "verified". Tests: Task 5 browser cases and the showcase-claims scan.
8. **Sealing.** `GET /v1/content/:hash` is public, so whether a hash exists is public. A note or snapshot uploaded before the deadline must not let anyone confirm a guess about the sealed answer. Tests: Task 1 `a note without a salt is refused`; Task 3 `two carry-forward notes built from identical inputs have different hashes` and `no snapshot is uploaded before the window's deadline`.
9. **The default agent process never touches the network.** Test: Task 3 `the context that main builds uses the fixture fetcher and cannot reach httpsFetcher without the opt-in`.
10. **Long markets.** A market with more than 100 windows must still be answered in its open window. Tests: Task 3 `a market with 150 windows is answered in the 150th window`; Task 4 `pages to the latest windows of a market with 150 windows`.

---

## 1. What exists today

### 1.1 The reference forecasters decide nothing about when to forecast, and fetch nothing

**`examples/agents` (the forecaster role).**
- `examples/agents/src/main.ts:25` sets `TICK_MS = 2000`; `:28-37` maps each role to one tick; `:54` runs `runAgent`. `examples/agents/src/lib/loop.ts:39-66` runs every tick of the agent each period, so the forecaster wakes every two seconds.
- Each wake, `examples/agents/src/roles/forecaster.ts:48-65`:
  1. lists up to 100 OPEN markets (`:50`);
  2. for each, lists the first 100 forecast windows (`:54`, with a `ponytail` comment that a long market needs paging). Pages are oldest first with forward-only cursors (`packages/schemas/src/http.ts:176-181`, `packages/adapters/src/forecast-store.ts:98-106`), so on a market with more than 100 windows the later windows are never seen and never answered;
  3. keeps the windows that are `OPEN` and not yet answered (`:55`);
  4. calls `ctx.model.probabilityBps` for the market (`:57`) when at least one such window exists;
  5. signs and submits one forecast per open window (`:63`), then records the window id in `state.acted["forecaster.submitted"]` (`:44-45`).
- So the rule for "when to forecast" is: **in every window, at the moment it opens, ask the model again.** With a real model that is one full analysis per market per window. There is no memory of the earlier answer, no notion of "nothing changed", and no limit on the model's cost.
- What it fetches: only platform routes (`listMarkets`, `listForecastWindows`, `submitForecast`). `grep` finds no `fetch(` and no `node:http`, `node:https` or `node:dns` import anywhere under `examples/agents/src`. The fixture model answers from the world file (`examples/agents/src/lib/model.ts:59-62`); the only place it reads a source is the class A outcome for proposers (`model.ts:44-49` and `:63-79`).
- What it signs: `contentHash` is always `NO_CONTENT_HASH` (`forecaster.ts:30` and `:36`), so the reference forecaster attaches no reasoning and no evidence.
- The `Model` interface (`model.ts:16-25`) has no way to pass a previous forecast or a list of changes to the model.

**`examples/llm-agent` (the optional LLM demo).**
- `examples/llm-agent/src/main.ts:58` fetches `llms.txt` once; `:66` starts one `toolRunner` conversation; `:71` stops at `BLINK_LLM_MAX_TURNS` (default 60). Every turn is a model call.
- Its tools (`examples/llm-agent/src/tools.ts:24-79`): `fetchDoc` (same origin as `BLINK_WEB_URL` only), `apiRequest` (`/v1/` paths of `BLINK_API_URL` only), chain read and write, typed-data signing. It has no tool for an outside source and no memory between runs except its transcript. It is not run in CI.
- Neither reference agent can tell that a source changed.

### 1.2 The signed forecast payload

- The EIP-712 type is `Forecast { forecaster address, markets address, marketId uint256, horizon uint8, scheduledAt uint64, probabilityBps uint16, contentHash bytes32 }` (`packages/schemas/src/research.ts:19-29`), domain `Blink Forecast` version `1`, chain 84532, verified by the generation's `BlinkAnchor` address (`:47-71`).
- **It already carries one evidence reference: `contentHash`.** `apps/web/content/docs/forecaster.md` (Submit bullet) says it is "the hash of a `/v1/content` document holding your reasoning, or `NO_CONTENT_HASH`". The design spec says each forecast "can carry a signed, hash-addressed reasoning document" (`2026-10-23-autonomous-market-design.md:296`), and the market page promises that a live market's reasoning summary "comes from the reasoning document that a forecast signs by hash" (`apps/web/app/markets/[id]/page.tsx:146`).
- **What is not defined is the document.** No schema, no media type and no size rule exists for it. `ForecastView` returns `contentHash` (`research.ts:115-128`) and nothing else about the document. The platform does not even look at it: `createForecastService` has no content store among its dependencies (`packages/application/src/forecasts.ts:77-92`), and `submit` (`:135-237`) never checks that the hash resolves. A forecaster can sign a hash of bytes that were never uploaded.
- The submission body is a strict object of exactly `{ horizon, scheduledAt, probabilityBps, contentHash, signature }` (`research.ts:80-86`). The service rebuilds the signed struct itself from the route and the key (`forecasts.ts:143-156`), so any extra field would be refused.
- The type is checked off chain (`SignatureVerifier`). `BlinkAnchor` only stores window roots: its one write is `anchor(bytes32 root)` (`contracts/src/protocol/BlinkAnchor.sol:18`). So even a change to the signed type would need no contract change, but it would break every signer (OQ1).

### 1.3 Forecast windows, sealing and the consensus

- **Windows are platform scheduling, not protocol parameters.** `plannedWindows` (`packages/domain/src/forecast-windows.ts:37-72`) makes one `DAILY` window per UTC midnight until the market's `closeAt` (`:59-64`), each open for the 30 minutes before its deadline (`DAILY_OPEN_SECONDS = 1800`, `:21`; fixed, not configurable), plus one `PRE_CLOSE` window ending `preCloseLeadSeconds` before the close (default 3600 s lead, 1800 s open; `:17-20`, `:65-66`). Only the pre-close lead and open times are configurable, through `FORECAST_PRE_CLOSE_LEAD_SECONDS` and `FORECAST_WINDOW_OPEN_SECONDS` (`apps/worker/src/config.ts:103-134`); the local drill uses 80 s and 80 s (`scripts/alpha/platform.ts:170`). `createWindowScheduler.scheduleOnce` plans windows for every OPEN market and never backfills (`forecasts.ts:481-521`).
- **So an answer can enter only about once a day per market.** A 90-day market has about 91 windows. [`docs/M3_FORECASTS.md`](../../M3_FORECASTS.md) describes an older model and carries a historical notice (lines 3-5); the current rules are in `docs/P2_OFFCHAIN_PROTOCOL.md:100-109` and `apps/web/content/docs/forecaster.md`.
- **One answer per forecaster per window, and a withdrawal does not free the slot.** A unique index on `(window_id, forecaster_address)` (`packages/adapters/migrations/0033_signed_forecasts.sql:28`) and the `taken` check in `submit` (`packages/adapters/src/forecast-store.ts:135-139`) refuse a second, different answer with `409 FORECAST_ALREADY_SUBMITTED` (`forecasts.ts:177-182`). `withdraw` (`forecast-store.ts:171-197`) is allowed before the deadline and removes the answer from the root and the consensus, but the row still occupies the slot. The same signed answer sent again is a replay and returns the same receipt (`forecasts.ts:180`).
- **Sealed until the deadline.** Before a window's deadline, an anonymous caller sees nothing and a forecaster sees only its own answer (`forecasts.ts:240-275`). After it, every answer is public with its `contentHash` and `receivedAt` (`ForecastView`).
- **The consensus is per window, from that window's answers only.** `getConsensus` (`forecasts.ts:354-397`) lists closed windows; for each, it takes the answers of that window (`store.answers`, `forecast-store.ts:218-227`), weights each forecaster by credit frozen at the deadline (`forecasts.ts:366-374`) and calls `consensus` (`packages/domain/src/consensus.ts:65-81`). The weight is `max(0, 1/4 - meanBrier)` over the latest 50 scored answers, zero below 5 (`consensus.ts:5-7`, `:36-45`; `forecast-store.ts:38`); when every weight is zero, the plain mean is used (`consensus.ts:73`). An agent that skips a window is simply not in that window's mean.
- **Credit counts answers, not markets.** The 50 answers behind a forecaster's credit are rows in `forecasts.submissions`, one per window, so an agent that answers every daily window of one long market fills its credit with that one market. This is the existing rule and Q9 changes it in the next generation; this plan does not touch it (section 2.9).
- **Contamination.** A window is marked contaminated when a proposal exists at or before its deadline (`consensus.ts:83-87`). An OPEN market has no proposal, so freshness only concerns OPEN markets.

### 1.4 Evidence storage and the API routes

- **Content store.** `POST /v1/content` stores up to 1 MiB (`CONTENT_MAX_BYTES`, `packages/schemas/src/http.ts:67`) of `application/json`, `text/plain`, `text/csv`, `text/html` or `application/pdf` (`:59-65`), at its keccak256, for a registered address with the `content:write` scope (`packages/application/src/content.ts:65-99`). Any other media type is refused with `415`. `GET /v1/content/:hash` is public, immutable, `nosniff` and sandboxed (`content.ts:19-43`, `:101-111`), and answers `404` for an unknown hash. The adapter writes the bytes first, then a `content.objects` row of hash, size, media type and uploader (`packages/adapters/src/content-store.ts:34-60`, migration `0030_content_and_suggestions.sql`). Nothing links a stored object to a market or a forecast; the only link is the hash inside a signed forecast or a spec.
- **Client.** `uploadContent(bytes, mediaType)` and `getContent(hash)` check the hash on both sides (`packages/client/src/index.ts:218-234`).
- **Archived-bytes precedent.** For class A markets, a proposal whose `evidenceHash` bytes cannot be fetched counts as unsupported (`docs/P2_OFFCHAIN_PROTOCOL.md:92`). Forecast evidence has no such rule.
- **Sources of a market.** `spec.sources` is an array of up to 10 https URLs (`packages/schemas/src/market-spec.ts:17`). They are the market's resolution sources. The platform does not fetch them; the v0.1 platform fetcher is historical (`docs/M3_EVIDENCE_FETCHER.md`, banner at the top) and its `evidence.*` tables were dropped (migration `0033`, lines 118-120). That fetcher's network rules are `isPublicAddress` and `checkFetchUrl` in `packages/domain/src/network-policy.ts:95` and `:148-172` (it refuses IP-literal hosts before DNS), and `packages/adapters/src/allowlist-fetcher.ts:66-76` checks every resolved address and connects to the one it checked.
- **Forecast routes** (`forecastPaths`, `forecasts.ts:37-46`; contracts in `packages/schemas/src/http.ts`; client in `packages/client/src/index.ts:245-292`): `GET /v1/markets/:id/forecast-windows`, `POST` and `GET /v1/markets/:id/forecasts`, `POST /v1/forecasts/:id/withdrawal`, `GET /v1/forecast-windows/:id` and `/proof`, `GET /v1/markets/:id/consensus`, `GET /v1/forecasters` and `/:address`. The list routes page by `cursor` and `limit` (at most 100), oldest first. `ConsensusItem` has `probabilityBps`, `submissions` and `contaminated` per window (`research.ts:135-146`) and no field about freshness or evidence.
- **No CORS handling** was found in `apps/api/src`, and `docs/DOMAIN.md:11` records the API as not deployed.

### 1.5 How the website shows forecasts

- **Static, sample data, no API calls.** `apps/web/next.config.ts` exports a static site for GitHub Pages; `docs/M4_WEB_SHOWCASE_DELIVERY.md` states the site has "no live API calls"; the web package depends on `@blink/schemas` only (`apps/web/package.json`) and no web source imports `@blink/client`.
- **The market page** `apps/web/app/markets/[id]/page.tsx` reads `findMarket(id)` from `apps/web/content/sample-markets.ts` (`:37-40`). It carries the notice "Sample data · REPLAY only · Fictional company · Not a forecast record" (`:53`). The "Agent consensus · YES" card shows `m.forecastBps` and "Track-record-weighted consensus of signed agent forecasts. Not a price." (`:58-66`); the state card shows "As of {m.updatedAt} (sample snapshot)" (`:86`); the chart section renders `ForecastChart` (`:103-105`); "Evidence" lists archived sources (`:127-142`); "How agents reasoned" lists per-agent summaries and says a live summary would come from the signed reasoning document (`:144-150`). Of the six sample markets, 01 and 02 are OPEN; 03 is PROPOSED, 04 DISPUTED, and 05 and 06 FINAL.
- **The chart** `apps/web/components/markets/ForecastChart.tsx` is a client component (`"use client"`). It draws one point per window (`:76-80`): a consensus line and a "last fill" line, a hover tooltip (`:96-102`) and a table with the columns Window, Consensus, Last fill and Signed forecasts (`:104-125`). The `ForecastWindow` type is `{ date, consensus, lastFill, forecasters }` (`sample-markets.ts:7`). Nothing records how fresh a point is, whether an answer was new analysis, or what evidence changed.
- **Tests that guard the page:** `tests/web-sample-markets.test.ts`, `tests/browser/market-detail.spec.ts` (heading names, the chart's aria label, the tooltip, the table), `tests/browser/routes.spec.ts` (overflow at 375 px, and it renders `/markets/sample-06`), `tests/showcase-claims.ts` (banned status phrases, platform names and invitations, scanned over `apps/web/app`, `apps/web/components` and three content files), `tests/web-no-wallet.test.ts`.

### 1.6 What follows for the design

1. **The cheap check needs to run only when a window is open.** A forecast can be submitted only inside a window, so a faster check changes nothing about cost or about when the forecast can change. Polling between windows would only date a change more precisely (section 2.2).
2. **A skipped window leaves a hole in that window's consensus.** The consensus uses that window's answers only. If every agent skipped quiet windows, the consensus would be computed from whoever happened to update, and would jump. An agent that wants to count in a window must sign something in it, and signing a carried-forward probability costs a signature, not an analysis.
3. **An agent cannot correct an answer inside its window.** Combined with the daily cadence, the agent decides once per window, as late in the open period as it likes (OQ4).
4. **The signed type already has a slot for a document, and no format for it.** The format can be defined without touching the signed type (OQ1).
5. **`spec.sources` are resolution sources, not news sources.** For a class A market they change when the number is published, which is usually when the outcome becomes public. A useful watch list therefore is the spec's sources plus sources the agent chooses (section 2.2).
6. **The website has no live data path.** Freshness can be built and shown on sample markets now; showing it on real markets needs an API deployment, CORS and a browser-side reader that do not exist (OQ9).
7. **A public hash lookup can leak a sealed answer** if the document behind it is guessable (section 2.6, OQ13).

---

## 2. Design

### 2.1 The loop

```
every tick (2 s), for each OPEN market with an OPEN window this agent has not answered:

  window opens
       |
       v
  cheap check of the watch list (conditional GET, fingerprint), once per window
       |
       v
  decide: cold start? source changed? heartbeat due?
       |                                  |
      yes                                 no
       |                                  |
       v                                  v
  ANALYSE                            CARRY FORWARD
  (the expensive model call:         (re-sign the earlier probability,
   a new probability)                 no model call)
       |                                  |
       +----------------+-----------------+
                        |
                        v
  write the salted note, upload it to /v1/content (hash = keccak256 of the note bytes)
                        |
                        v
  sign Forecast(..., probabilityBps, contentHash = that hash)
                        |
                        v
  POST /v1/markets/:id/forecasts
                        |
                        v
  after the window's deadline: upload the archived snapshots the note names
```

Terms used below:
- **Window.** One of the platform's forecast slots for a market (section 1.3).
- **Watch list.** The URLs an agent checks for a market: the spec's `sources` plus any the agent adds.
- **Conditional GET.** An ordinary web request that says "send the page only if it changed since this version" (it carries the `ETag` or `Last-Modified` value of the last answer). An unchanged page is answered with `304 Not Modified` and no body, so the check costs almost nothing.
- **Fingerprint.** keccak256 of a source's text after noise is removed (section 2.2). Two fetches with the same fingerprint mean "nothing changed".
- **Analysis.** The expensive step: the model forecasts again, given the market, the agent's earlier forecast and the list of changes.
- **Carry forward.** Signing the earlier probability again in a new window, with no model call (what exactly it signs is OQ14).
- **Heartbeat.** A staleness limit: an analysis runs when the last one is older than the limit, even if no source changed.
- **Note.** The JSON document a forecast's `contentHash` points to (section 2.6).
- **Snapshot.** The raw bytes of a changed source, archived in `/v1/content`.

### 2.2 The cheap change check

For each URL on the watch list, once per open window (not per tick; the result is kept in memory for the window, so a retry on the next tick does not fetch again):

1. **Conditional GET** with the stored `ETag` or `Last-Modified` validators. A validator goes only on the request for the final URL it was saved for (where the redirects ended), never on another hop, and only in the shape a server issues it. A `304` means unchanged and downloads nothing; it is believed only when a conditional header was actually sent.
2. On a `200`, **normalise** the body and **fingerprint** it:
   - a text body is first decoded with its declared `charset` (UTF-8 when none is given); an unknown label, or bytes that do not decode, fall back to windows-1252, which gives every byte its own character;
   - `text/html`: drop `script`, `style`, `noscript` and comments, then tags and attributes, decode entities, collapse whitespace;
   - `application/json`: parse and re-serialise with sorted keys and numbers as written. JSON nested deeper than 256 levels, with more than 100,000 structural tokens, or that does not parse, is compared as whitespace-collapsed text;
   - `text/plain` and `text/csv`: trim and collapse whitespace;
   - `application/pdf` and any other type that is not text: hash the raw bytes (`raw:` plus the keccak256 of the bytes).
3. **Compare** with the stored fingerprint of the previous check, and classify the source: `NEW` (first sighting by this agent), `CHANGED`, `UNCHANGED` or `UNREACHABLE` (timeout, refusal, size limit or an empty body; the old fingerprint is kept, so one failed fetch cannot fake a change later. A URL whose first check failed has no fingerprint and no entry, so its first success is `NEW`).
4. For `CHANGED`, record `since`, the time of the previous successful check, so a change is dated as "between since and observedAt", not as a point. A `NEW` source has no `since`: it means only "first checked", which happens on every cold start, after lost state and whenever a URL is added.

**Safety of the fetch** (Review Focus 2). A market creator chooses the URLs, so the fetcher is hostile-input code. The platform's own fetcher is the model (section 1.4). The agent's fetcher:
- before any socket opens, refuses a scheme other than https, any userinfo (`user:pass@`), any port other than 443, and any host that is an IP literal (`https://10.0.0.1/`, `https://[::1]/`, and forms such as `https://0x7f.1/` that the URL parser folds to a dotted address);
- resolves the name with the c-ares resolver (`dns.Resolver`: A and AAAA, bounded in time and in tries), not `dns.lookup`, because c-ares can be cancelled when the fetch gives up, cannot exhaust the process's thread pool, and reads no `/etc/hosts` and applies no search domains. A and AAAA are asked together; a failure of one does not fail the name, and the lookup stops waiting 300 ms after the first non-empty answer (RFC 8305's resolution delay), so a name whose other record type is never answered does not cost the resolver's timeout on every hop. It then refuses if any returned address is not public: only global unicast space is admitted (for IPv6, `2000::/3`, with the registry's reachable exceptions inside `2001::/23`), the IPv4-mapped, NAT64 and IPv4-compatible forms are judged by the IPv4 address they embed, and an address inside a subnet of one of the machine's own network interfaces or of `extraBlockedRanges` (CIDR strings) is refused too. One private answer poisons the name;
- connects to the address it checked (not to the name again) and sets `servername` to the host, so TLS still verifies the certificate for the host and a second DNS answer cannot change the target. The connection options come from one pure, exported function, `httpsRequestOptions({ ip, family, url })`, so a test can pin them (Task 2). It is the same design as the platform's (`packages/adapters/src/allowlist-fetcher.ts:261-291`, copied, not imported): `hostname` is the URL host, a pinned `lookup` answers both the single and the `{ all: true }` call with the checked address, `servername` is the host, the `Host` header comes from the URL, `agent: false`, and `rejectUnauthorized: true` set explicitly so an environment variable cannot turn verification off;
- re-checks every redirect from the start (at most 3), so a redirect to an IP literal, to http, to another port or to a name that resolves privately is refused;
- one 10 s deadline covers the whole read, redirects and lookups included; no cookies, and no `User-Agent` or other header that names the operator or the software; no HTTP proxy is used, and the fetcher refuses to be built (`PROXY_CONFIGURED`) while `HTTPS_PROXY`, `https_proxy`, `HTTP_PROXY`, `http_proxy` or `NODE_USE_ENV_PROXY` is set, unless `direct: true` says the direct connection is intended, because a proxy resolves the name itself and would defeat the address check;
- caps the size of the body at 4 MiB, both on the wire and decoded, and asks for `Accept-Encoding: identity`; if a server compresses anyway, gzip and deflate are decoded under the same cap, so a compression bomb is `TOO_LARGE`, and any other encoding, `br` included, is `UNSUPPORTED_ENCODING`.

**Why not poll all day.** Submitting is possible only in a window (section 1.6, point 1), so more frequent checks cost fetches and change nothing about the forecast. They would only date a change more precisely. The plan does not include between-window polling. If a later stage wants it, it is a separate scheduler that writes the same fingerprints.

The watch list is `Model.watchList(market)`, optional, whose default is `spec.sources`. Agents that follow news, filings or polls return more URLs. The fixture model returns the world file's `sources` URLs. The list is capped at 20 URLs, `spec.sources` first; the rest are dropped with a `watch_list_truncated` log line. The cap is what lets every note fit the note's limits (section 2.6). Before the check, the list also drops any URL whose serialised form (`new URL(u).href`) takes more than 2048 bytes once JSON-encoded, with a `watch_url_too_long` log line. A `spec.sources` entry has no length limit (`market-spec.ts:17`), and a serialised https URL can keep `\` in its query or fragment, which JSON writes as two bytes. The note stores the serialised form. `watchableUrl` builds that form, and `checkSources` throws on a list that was not built with it (more than 20 URLs, a URL that is not https, not canonical or too long), so the filtering stays with the caller. At most five fetches run at once, and the check yields to the event loop between sources, which does not let another role's tick run.

- **Rulings during Task 2 (2026-11-27).** The fetcher departs from the first text of this section in these ways: the name is resolved with c-ares, not `dns.lookup`, with A and AAAA asked together and a 300 ms resolution delay; gzip and deflate are decoded and `br` is refused; validators go only to the stored final URL; an empty body is `UNREACHABLE`; very deep or very large JSON is compared as collapsed text; a text body that does not decode falls back to windows-1252; addresses inside the machine's own subnets and the mapped, NAT64 and IPv4-compatible IPv6 forms are refused; no `User-Agent` is sent, and any of five proxy variables stops the fetcher from being built; source URLs, final URLs and world-file keys are canonical and at most 2048 bytes in JSON. The [progress record](../../D1_EVENT_DRIVEN_PROGRESS.md) lists every ruling.

### 2.3 When the expensive step runs

An analysis runs, at most once per market per window, when any of these holds:

| Trigger | Condition | Why |
| --- | --- | --- |
| Cold start | The agent has no earlier forecast of this market | There is nothing to carry forward |
| Change | At least one source is `CHANGED`, or a source is `NEW` and the agent already has an earlier forecast (a URL was added to the watch list) | This is the news |
| Heartbeat | The last analysis is older than the heartbeat (OQ5) | News the watch list cannot see |

Otherwise the agent carries forward.

The pure function `decideUpdate({ prior, items, now, heartbeatSeconds })` returns `{ action: "analyse", reason: "cold_start" | "change" | "heartbeat" } | { action: "carry_forward" }`. It is the unit under test for the saving. It has no skip: the caller handles the cases below.

- **The model has no view** (`revise` returns null, or `probabilityBps` is null). With or without an earlier forecast, the agent submits nothing this window, logs `no_view`, and does not commit the new fingerprints, so the change is seen again in the next window. Without an earlier forecast this is the reference forecaster's behaviour today.
- **The analysis throws.** The agent submits nothing yet. It tries the analysis at most 3 times per window, at least 10 s apart (a tick is 2 s, so without a limit a 30-minute window could call the model about 900 times, the opposite of the saving), then logs `window_missed` when it gives up or when the window closes. It never submits a guess to fill a window.
- **A model answer is kept for the window.** Once the model has answered, the answer stays in memory for the window, so a failure after that point (building the note, an upload, the submit) never calls the model again.

### 2.4 How an update goes through the existing windows

Nothing in the windows, the API or the sealing changes.

1. The window opens (`openAt`). The agent runs the check and decides.
2. It builds the salted note (section 2.6), uploads the bytes with `uploadContent` (media type `application/json`) and receives `hash = keccak256(bytes)`.
3. It signs `Forecast{ ..., probabilityBps, contentHash: hash }` with `forecastTypedData` exactly as today, and calls `submitForecast`.
4. The window's answer is sealed until the deadline, then public. The window's Merkle leaf commits to the digest, so the note hash, and therefore the note, is committed by the window root (and by the anchor, if any agent anchors it).
5. Once the API lists the window as `CLOSED` (the platform's clock decides when sealing ends, not the agent's), the agent uploads the snapshots that the note names (OQ13), and the next window's note names this answer's digest as `prior`.

Crash safety: before uploading anything, the agent writes the snapshot files (in the state directory, named by hash), then saves the intent in one state save together with its `pendingSnapshots`, and only then uploads the note. The intent holds the exact note bytes including the salt, the `kind`, the probability and the window id, like the creator's `CreateIntent` (`examples/agents/src/lib/state.ts:8-17`). A restart resends the same bytes, which produce the same digest and a replayed receipt (`forecasts.ts:180`). After success it replaces `state.watch[marketId].prior` and marks the window done.

An intent whose window is no longer OPEN when the agent restarts cannot be resubmitted. The agent settles it on its next tick: it lists its own answer in that window (`listForecasts`, public after the deadline). If the answer's digest matches the intent, it sets `prior` from it (with `analysedAt` when `kind` is `analysis`), keeps the snapshots queued, and leaves the new fingerprints uncommitted, so the next window sees the same change again. Otherwise it drops the intent and logs `intent_dropped`; dropping an intent also drops its `pendingSnapshots` and their files. The agent reads whether a window is open or closed with `getForecastWindow({ windowId })`, which uses the platform's clock, never its own. So a crash never loses the record of what the agent last signed (Review Focus 4).

Reaching the open window of a long market: windows come oldest first, 100 to a page, and each page's `nextCursor` is issued by the server (`forecasts.ts:296-312`). The format is not part of the public contract, so the agent stores only cursors the server issued and never builds one. Per market it saves the cursor that fetched the page holding the first window that is not `CLOSED` (null for the first page), advances it to `nextCursor` whenever a whole page is `CLOSED`, and saves it whenever it moves, whether or not an answer was submitted. Each tick reads one page, and two on the tick when a whole page has just closed; the first tick of a long market pages from the start (Review Focus 10).

### 2.5 What "fresh" means and how it is computed

A forecast cannot be fresher than its window, so freshness is measured in windows first and in time second. Two different facts are kept apart, because they answer different questions:

- **How recently did anyone forecast?** (`age`, `windowsBehind`, `level`.) Measured with the platform's clock: the deadline of the latest closed window that has at least one counted answer.
- **How recently was evidence looked at, and how recently did it change?** (`analysedAt`, `evidenceChangedAt`.) Reported by forecasters in notes, so labelled as reported.

`computeFreshness(windows, asOf)` takes the market's closed windows, newest last, each reduced to `{ scheduledAt, answers, analysed, carried, noNote, unfetched, evidence[], firstChecked }`, and returns:

```
{
  asOf,
  lastAnsweredWindow: scheduledAt | null,      // latest closed window with answers >= 1
  ageSeconds | null,                           // asOf - lastAnsweredWindow
  windowsBehind,                               // closed windows after lastAnsweredWindow
  level: "CURRENT" | "AGING" | "STALE" | "NONE",
  analysedAt | null,                           // latest closed window with analysed >= 1
  evidenceChangedAt | null,                    // latest observedAt of a CHANGED item in an analysis note
  latestWindow: { answers, analysed, carried, noNote, unfetched }
}
```

Levels (OQ8): `CURRENT` when `windowsBehind = 0`; `AGING` for 1 or 2; `STALE` for 3 or more; `NONE` when no closed window has an answer. Worked example with daily windows: the latest closed window is Tuesday and has 3 answers: `CURRENT`. Nobody answered Wednesday or Thursday: on Friday, `windowsBehind = 2`, `AGING`. Add Friday with no answers: `STALE`.

Freshness is defined for OPEN markets only. After the close no more windows open, so "windows behind" would read `CURRENT` for a market that stopped forecasting weeks ago. A reader shows a closed market's last window as a date, with no level (section 2.7).

Time checks: a note's `checkedAt` is honoured only between the window's `openAt - 24 h` and the answer's `receivedAt`, and an evidence item counts only if its `observedAt` lies in the same range and its `since`, when present, is not after `observedAt`. Outside that range the note still counts as an answer and as analysed or carried, but the time or the item is ignored.

### 2.6 How "what evidence changed" is recorded: the forecast note

The note is the document that `contentHash` already names (OQ1, option a). It is JSON, UTF-8, at most 64 KiB, with the schema `blink.forecast-note/0.1`:

```json
{
  "schema": "blink.forecast-note/0.1",
  "kind": "analysis",
  "marketId": "7",
  "markets": "0x...",
  "forecaster": "0x...",
  "horizon": 0,
  "scheduledAt": 1796083200,
  "salt": "0x...",
  "checkedAt": 1796083160,
  "prior": { "digest": "0x..." },
  "summary": "The new release shows a 68% margin, below the 70% threshold.",
  "evidence": [
    {
      "url": "https://example.com/investors/q2-release",
      "status": "CHANGED",
      "since": 1795996800,
      "observedAt": 1796083150,
      "fingerprint": "0x...",
      "snapshot": "0x...",
      "note": "Gross margin line updated."
    }
  ],
  "detail": null
}
```

Rules, enforced by `parseForecastNote` (Task 1):
- **Subject.** `marketId` (canonical decimal, no leading zeros), `markets` (the generation's `BlinkMarkets`), `forecaster`, `horizon` and `scheduledAt` are the fields of the signed `Forecast` that identify the answer. A reader compares them with the answer and the window; a mismatch makes the note unreadable (Review Focus 6). A note therefore cannot be signed again for another window or market.
- **Salt.** `salt` is 32 random bytes, new for every note. Without it a carry-forward note is almost fully predictable from the previous note (same URLs, same fingerprints, `prior` already public), and anyone could hash a candidate and ask `GET /v1/content/:hash` whether it exists before the deadline, which would reveal that the sealed answer equals the previous one (Review Focus 8). The salt stays inside the saved intent so a restart resends identical bytes.
- **Kind.** `analysis` (the model ran this window) or `carry_forward` (the earlier probability was signed again). A `carry_forward` note may list only `UNCHANGED` or `UNREACHABLE` items; `NEW` or `CHANGED` in a carry-forward is a contradiction and the note is unreadable. A heartbeat analysis lists only `UNCHANGED` items, which is allowed.
- **Evidence.** At most 20 items; each `url` is https and at most 2048 characters (the watcher is stricter: it drops a URL over 2048 bytes in JSON, section 2.2); `status` is `NEW`, `CHANGED`, `UNCHANGED` or `UNREACHABLE`; `since` is null for `NEW` and a unix time not after `observedAt` for `CHANGED`; `fingerprint` is the normalised-text hash of section 2.2; `snapshot` is the keccak256 of the raw bytes archived in `/v1/content` (OQ7), else `null`; `note` is at most 500 characters. The builder keeps the note within 20 items and 64 KiB by dropping `UNCHANGED` items first, then `UNREACHABLE`, then `NEW` ones, then shortening item notes, then the summary. It never drops a `CHANGED` item. With at most 20 URLs of at most 2048 bytes in JSON (section 2.2), 20 `CHANGED` items with empty notes, and every other field at its maximum, take 46,467 bytes of compact JSON (measured), so a note always fits in 65,536 bytes.
- **Snapshot not available.** A snapshot hash that does not resolve (never uploaded, or refused by the store) is shown as "snapshot not available" and never makes the note unreadable.
- **Summary.** At most 2000 characters, possibly empty. It is the text the market page's "How agents reasoned" shows for live markets (`page.tsx:146`), so the reasoning view and the evidence view read one document. `detail` optionally names a longer document in `/v1/content`.
- **Prior.** `prior.digest` is the digest of this forecaster's previous answer on this market, or `prior` is null. The note carries no probability: the size of a move is computed by the reader from the signed answers (this answer and the answer with that digest in an earlier window). A reader that finds no such answer shows no move; it does not treat the note as unreadable.
- **Checked on read, never at submit** (OQ2). A reader that cannot fetch the note, cannot parse it or finds a mismatch shows the answer as "no readable note" and counts it as `noNote`.
- **Rulings during Task 1 (2026-11-26).** An evidence item's `fingerprint` may be null only on an `UNREACHABLE` item, for a source that has never been fetched successfully. A `carry_forward` note with `prior: null` is refused. The limits are exported for the builder: `FORECAST_NOTE_MAX_EVIDENCE`, `FORECAST_NOTE_MAX_URL_CHARS`, `FORECAST_NOTE_MAX_ITEM_NOTE_CHARS` and `FORECAST_NOTE_MAX_SUMMARY_CHARS`. The [progress record](../../D1_EVENT_DRIVEN_PROGRESS.md) lists every ruling.

What it records, concretely: for each window an agent answered, which sources it looked at, which changed, between which two moments, the fingerprint of the text it compared, the archived raw snapshot (when kept), and the earlier answer it started from.

### 2.7 How the website shows it

Using the sample markets now (OQ9); the same components take live data later. `FreshnessLine` and `EvidenceChanges` are server components that receive values computed on the server, so `zod` and `@blink/schemas` stay out of the client bundle of the chart. `ForecastChart` stays a client component and receives plain numbers only.

- **Agent consensus card, OPEN markets only.** Under the number, one freshness line: "Latest window 2026-10-06 · 0 windows behind · 2 of 2 answers reported a new analysis · 1 source changed (reported)" with the level as text ("Current", "Aging", "Stale"). The time is shown in UTC; a relative age is added after hydration only for live data, because a static page cannot know the current time. For a market that is not OPEN the line reads "Forecasting ended at close; last window 2026-09-24" and shows no level.
- **Chart.** A small marker on the baseline of the plot at each window where a source changed (`CHANGED` only); a different point style for windows where every answer was carried forward; the tooltip names "Sources changed: 1 (reported)" and "New analysis 2, carried 0". The table gains the columns "New analysis / carried" and "Sources changed". The chart's aria label mentions the count of windows with changed sources.
- **"What changed" section**, between the chart and "How it resolves": the latest changes, newest first, each with the source host, "changed between X and Y (UTC)", the forecasters' summaries, the move in probability (from the signed values), and the snapshot's hash as text. On sample data nothing links to a snapshot, because the static site cannot check one; a live view may link to `/v1/content/<hash>` and compare the bytes with the hash. A `NEW` source is shown as "first checked", never as a change. A snapshot hash that does not resolve is shown as "snapshot not available". A line states: "Reported by the forecasters; an archived snapshot can be checked against its hash."
- **Evidence and reasoning sections** are unchanged; "How agents reasoned" reads the same notes' `summary` for live data.
- No bounty, sponsor or payment wording anywhere (U24, Mechanism R).

### 2.8 What it saves: a worked example

A market opens 90 days before its close, so it has 91 windows (90 daily and one pre-close). One agent forecasts every window.

- **Today's pattern.** One analysis per window: 91 model calls.
- **Event-driven, one source that changes 4 times (days 10, 35, 60, 80), heartbeat 14 days:** 1 cold start + 4 changes + 3 heartbeats = 8 analyses, 91 conditional GETs, 91 signatures. That is 8.8% of the model calls.
- **Same, no heartbeat:** 5 analyses (5.5%). **Heartbeat 7 days:** 15 (16.5%).
- Each analysis is assumed to cost the same. The numbers come from the simulation in `tests/agents-forecaster-events.test.ts` (Task 3), not from a measurement of real model spend. A source that changes more often, or a noisy page, raises the count; the heartbeat bounds it from below.

### 2.9 Limits, stated plainly

- **It lowers cost and adds no revenue.** The protocol pays a forecaster nothing (`forecaster.md`, Income). A cheaper agent keeps the same zero income.
- **Others can copy the last revealed consensus.** Answers become public at each deadline, so a cheap agent can sign the previous window's consensus every day and look like a forecaster. A carry-forward note is indistinguishable in effect from that, and the note's `kind` is self-reported. The freshness view therefore says "someone answered", not "someone checked". Nothing here changes that; a payment that rewards only improvement over the earlier consensus is direction 3.
- **A daily cadence.** News after a window closes reaches the consensus at the next window, up to about a day later. The platform's window schedule is not part of this plan.
- **A carry-forward is biased on deadline questions.** It signs the same number again. For a question that resolves on an event by a date (for example "will X happen this year"), the honest probability falls as days pass with no event; a carried number does not, for up to the heartbeat. OQ14 asks what a carry-forward should sign.
- **Credit counts rows.** Carry-forward answers are scored like any other answer, so an agent that answers every window fills its latest-50 credit with one market. This is the existing rule (Q9 changes it).
- **A source that cannot be fetched** (login walls, scripts that build the page in the browser, rate limits) looks `UNREACHABLE` or constant. The agent then relies on its heartbeat.
- **Notes can lie.** An `analysis` note can claim evidence it did not read. Only the snapshot hash and the signed values can be checked.
- **Snapshots reveal something even after the deadline** only in the way every answer does: they are public once uploaded after the deadline (OQ13).
- **A source can link its readers to the operator.** A page that carries a per-request token puts that token into the fingerprint and into the archived snapshot, which are public once an answer is revealed. The validators the fetcher replays (`ETag`, `Last-Modified`) let a server recognise the same agent across windows and across changes of its IP address. No header names the operator or the software, but the connection's source address is the operator's. Unlinkability needs a tunnel or an egress address around the whole process, which the example cannot provide.
- **Fetched text is untrusted input.** A page can contain text written to steer a model (prompt injection). An operator who passes fetched text to a model must treat it as data. The docs say so (Task 6).

---

## 3. Open questions for the user

Each question lists its options, the cost of each and a recommendation. Nothing in these options changes a contract: `BlinkAnchor` only stores window roots (`BlinkAnchor.sol:18`) and the forecast type is checked off chain. The plan implements the recommendation unless the user answers otherwise. The tasks that change with each answer are named. Plain terms: a **conditional GET** is defined in section 2.1; **CORS** is the browser rule that a web page may read another site's data only if that site's server sends headers that allow it.

**Decided on 2026-11-24 [User].** The user accepted every recommendation, so OQ1 to OQ15 are all (a). The first round (OQ1, OQ3, OQ4, OQ5, OQ6, OQ8, OQ9, OQ11 and OQ12) was answered "都依照建議" ("all as recommended"), and the second round (OQ2, OQ7, OQ10, OQ13, OQ14 and OQ15) "全部依照建議" ("all as recommended"). The tasks in section 5 implement these options. The other options stay below as the record of what was weighed.

**OQ1. Where is "what evidence changed" recorded?** *Decided on 2026-11-24: (a).*
- **(a) In a note document, referenced by the existing `contentHash`. Recommended.** The signed type, the submission body, the verifier, every existing agent and the Merkle leaves stay as they are. Cost: the note is optional and self-declared; the platform does not check it (OQ2); each forecast needs one extra upload, so one extra API call per window per market; agents that already attach their own reasoning document must use this format for the site to read it.
- **(b) New fields in the signed `Forecast` type** (for example `evidenceHash` and `priorDigest`). **This changes the EIP-712 type hash, so every agent that signs forecasts breaks until it is updated.** The files and parties that break:
  - agents: the reference forecaster (`examples/agents/src/roles/forecaster.ts`), the LLM demo's typed-data tool (`examples/llm-agent/src/tools.ts`, which signs whatever the model passes), any outside agent built from the docs or from `forecastTypedData`, and the CDP wallet check (`tests/cdp/cdp-wallet.test.ts`);
  - the platform: `forecastTypes`, `ForecastMessage`, `forecastTypedData` and `ForecastSubmission` in `packages/schemas/src/research.ts`, the digest and verification path in `packages/application/src/forecasts.ts:143-156`, `forecastDigest` and the re-exports in `packages/client/src/index.ts`, the stored `digest` and `signature` columns of every existing row, and the Merkle leaves derived from the old digests;
  - docs: `apps/web/content/docs/forecaster.md`, `contracts.md` and `client.md`;
  - tests that build or check a forecast: `tests/client.test.ts`, `tests/forecast-signing.test.ts`, `tests/alpha/local-alpha.test.ts`, `tests/anvil/agents-market-roles.test.ts`, `tests/helpers/forecast-fixture.ts`, `tests/forecasts.test.ts` and `tests/postgres/forecasts.test.ts`.
  Old signed answers cannot be verified under the new type unless the platform accepts both, which means a second domain version and a dual-verification path. No contract changes. Benefit: the platform could index evidence fields without fetching a document. Cost: a breaking change for every signer, a migration of stored rows, and a flag day.
- **(c) A separate signed evidence log**, a new write route and table (for example `POST /v1/markets/:id/evidence-notes`) that agents call whenever they see a change, not only inside windows. Benefit: changes are dated when seen, not when a window opens. Cost: a new write surface (scopes, rate limits, abuse), a migration, a second thing to keep consistent with the forecasts, and tests on the PostgreSQL row.

**OQ2. Does the platform check the note when a forecast is submitted?** *Decided on 2026-11-24: (a).*
- **(a) No check, as today. Recommended.** Readers validate (section 2.6). Cost: a forecast can point to a missing or malformed note; the site shows "no readable note".
- **(b) Refuse a forecast whose `contentHash` is not an uploaded, valid note.** Benefit: every shown note exists. Cost: a behaviour change that refuses agents that attach other reasoning documents today; the submit path reads the content store (new dependency of `createForecastService`); an outage of the content store would block forecasting.
- **(c) Accept, but have the API report a `noteStatus` on each answer.** Benefit: one definition of "readable". Cost: the API parses agent-supplied JSON on read; a new field in `ForecastView`, the OpenAPI document and the client.

**OQ3. In a window with no news, does the agent carry forward or stay silent?** *Decided on 2026-11-24: (a).*
- **(a) Carry forward: re-sign the last probability every window. Recommended.** The consensus is computed per window from that window's answers only (section 1.3), so silence removes the agent from that window's mean and makes the series jump. Cost: one signature, one note upload and one POST per window per market; and the credit effect in section 2.9.
- **(b) Stay silent when nothing changed.** Cost: fewer rows and uploads, but the consensus of a quiet window is computed from the few agents that updated, and "fresh" would mean "someone had news".
- **(c) Change the platform so that the consensus uses each forecaster's latest answer from the last K windows.** Benefit: silence is safe. Cost: it changes the meaning of the consensus and of scoring, which belongs with the consensus and credit redesign of the next generation, so it is out of scope now.

**OQ4. When in the open window does the agent submit?** (A two-step plan, "carry forward at the open and correct later", is not an option: there is one answer per window and a withdrawal does not free the slot, section 1.3.) *Decided on 2026-11-24: (a).*
- **(a) As soon as the window opens. Recommended.** It matches today's behaviour, keeps the existing tests' timing, and the loss is small: a daily window is open for 30 minutes, so at most 30 minutes of news are missed. Cost: news inside the open period waits for the next window.
- **(b) A fixed lead before the deadline** (for example the last 20 percent of the window, at least 60 seconds). Benefit: the freshest evidence. Cost: a missed deadline if the API answers `503 INDEX_STALE`, and the alpha windows are only 80 seconds long, which leaves no room to retry.

**OQ5. How long may an agent go without an analysis when no source changed (the heartbeat)?** *Decided on 2026-11-24: (a).*
- **(a) A fixed limit, default 14 days, set by the operator with `BLINK_FORECAST_HEARTBEAT_HOURS`. Recommended.** Bounds how long the agent can miss news the watch list cannot see; 8.8 percent of the model calls in the example of section 2.8. Cost: one analysis every two weeks per market even if nothing happened.
- **(b) No heartbeat (pure event-driven).** Cheapest (5.5 percent in the example). Cost: an agent whose watch list is only `spec.sources` could stay on a stale probability for the market's whole life, because a resolution source usually changes only when the outcome is published (an expectation from how class A sources are defined, not a measurement).
- **(c) A limit that shrinks toward the close** (for example a quarter of the time left). Benefit: more care when it matters, and it softens the bias of OQ14. Cost: more parameters, harder to explain on the site and in the docs.

**OQ6. How deep is the cheap check?** *Decided on 2026-11-24: (a).*
- **(a) Conditional GET plus a normalised-text fingerprint. Recommended.** No model call; removes most noise (Review Focus 3). Cost: a page that rewrites its text on every load still looks changed.
- **(b) (a) plus a cheap-model triage** ("is this change material?") before the full analysis. Benefit: fewer false analyses. Cost: a second model with its own price and failure modes, and extra design that this plan does not build unless this option is chosen: a `Model.material(m, changes)` hook (optional, no default); a way to record a change that was judged immaterial, namely a per-item flag `judged: "immaterial"` that a `carry_forward` note may carry on a `CHANGED` item (today a carry-forward may not list `CHANGED`); and the rule that the new fingerprints are committed in that case, so the same change is not triaged again in every later window. Tasks 1 and 3 grow by that flag, that hook and their tests.
- **(c) A hash of the raw bytes.** Cheapest to write. Cost: dynamic pages trigger an analysis every window.

**OQ7. Does the agent archive the changed page, or only its hash?** *Decided on 2026-11-24: (a).*
- **(a) Archive the raw bytes of a changed source in `/v1/content`, only when its media type is one of the five the store accepts and it is at most 1 MiB, and only on windows where an analysis ran. Recommended.** The reader can check the hash and see exactly what the agent read, which follows the archived-bytes precedent for class A (section 1.4). A source that fails the media-type or size rule, or is refused by the store (for example RSS or Atom feeds get `415`), is recorded with `snapshot: null` and a log line, and never blocks the answer. Cost: storage grows by up to 1 MiB per changed source per agent; the platform serves third-party page bytes (sandboxed, never rendered inline); two agents seldom upload identical bytes; common feed formats cannot be archived.
- **(b) Hash only.** Cost: the evidence cannot be checked after the page changes again; the site can show only "a source changed".
- **(c) Archive a short excerpt.** Benefit: small. Cost: an excerpt chosen by the forecaster proves little and needs a format.

**OQ8. How is freshness labelled, and where are the thresholds?** *Decided on 2026-11-24: (a).*
- **(a) Windows first, time second; `CURRENT` at 0 windows behind, `AGING` at 1-2, `STALE` at 3 or more. Recommended.** The unit follows the platform's cadence. Cost: three arbitrary constants; "2 windows" means about 2 days on a daily market, because the daily window times are fixed; only the pre-close window's times are an operator setting.
- **(b) Clock time only** (for example "last forecast 31 hours ago"). Cost: a market whose windows come every few minutes (the pre-close window of a short market) and one with daily windows need different thresholds.
- **(c) No label, only the numbers.** Cost: a reader must judge for themselves.

**OQ9. What data does the market page read?** *Decided on 2026-11-24: (a).*
- **(a) Sample data only in this stage, through a data adapter that a live reader can replace later. Recommended.** The site stays static, offline-safe and free of status claims (U24); the new views are reviewed and tested now. Cost: the website does not yet show a real market's freshness; it shows a labelled sample.
- **(b) A browser-side reader of the public API.** Needs a deployed API (`docs/DOMAIN.md:11` records none), CORS headers (none were found in `apps/api/src`), a configured API address, and loading and error states. It breaks the static export's "no live API calls" scope (`docs/M4_WEB_SHOWCASE_DELIVERY.md`). Benefit: real data. Cost: all of that, and a client-side fan-out (OQ10).
- **(c) A snapshot read at `build:pages` time.** Cost: the page says "fresh" about a time that is already past when it is read, which defeats the purpose. Not recommended.

**OQ10. Where is freshness computed for readers?** *Decided on 2026-11-24: (a).*
- **(a) In `@blink/client`, composed from the existing routes. Recommended.** No new API surface. Cost, with a worked number: for one market read cold, with 30 windows and 5 forecasters, a reader makes about 2 requests to page to the latest windows (more on a long market: pages hold 100 windows, oldest first, so a 730-window market needs about 8 requests per list) + 30 `listForecasts` + 150 `getContent` = about 182 requests, and about 632 at the cap of 20 notes per window. Notes never change, so a reader that caches them by hash pays only for new answers afterwards (about 2 + the new answers), and the reader accepts a cache. A market list sorted by freshness would need one such composition per market, so the `/markets` ledger shows no freshness in this stage.
- **(b) A new read-only route** such as `GET /v1/markets/:id/freshness`, computed from the store. Benefit: one definition, one request, ledger rows possible. Cost: a new route in `packages/schemas/src/http.ts`, `apps/api/src/routes.ts`, the OpenAPI index and the client; an adapter query joining submissions and content (so the PostgreSQL verification row applies); the API parses agent-supplied notes. If chosen, Task 4 is replaced by Task 4B (outlined in the task list).

**OQ11. Where does the source fetcher's address guard live?** *Decided on 2026-11-24: (a).*
- **(a) In `examples/agents/src/lib/fetcher.ts`, with its own copy of the address rules and tests. Recommended.** The examples may not import `packages/` (`scripts/check-boundaries.mjs`). Cost: the same rules exist twice (`packages/domain/src/network-policy.ts` is the platform's); a drift test imports the platform's `isPublicAddress` and compares both over a list of addresses.
- **(b) Move the pure rules into `@blink/schemas`** and have both the platform (`domain` may import only `schemas`) and `@blink/client` (which may import only `schemas`) use them. Benefit: one copy. Cost: `@blink/schemas` is shipped to the web bundle and is the wrong home for network rules; the platform's fetcher is not called by anything today (`docs/M3_EVIDENCE_FETCHER.md`), so the refactor buys little now.

**OQ12. May the reference agent process fetch from the network at all?** (New: the agents docs promise API-only agents.) *Decided on 2026-11-24: (a).*
- **(a) No. `main.ts` always builds the fixture fetcher; `httpsFetcher` is exported for operators who embed the agent code with their own model and decide to fetch. Recommended for this stage.** Keeps `examples/agents/README.md` line 3 and `agents.md` true, keeps every test and the drill off the network. Cost: `node main.ts` cannot watch real sources; only a fixture world or an embedding operator can.
- **(b) An explicit opt-in switch, for example `BLINK_SOURCE_FETCHER=https` (default `fixture`).** Benefit: a runnable agent that watches real URLs. Cost: the process can now reach outside URLs, so the docs and the boundary wording change from "the public API and nothing else" to "and the sources you opt into"; the fetcher's safety (section 2.2) is then a security boundary of a shipped example. Adds one env variable and one test to Task 3.
- **(c) Network by default.** Not recommended: it breaks the "API only" promise and puts the nightly drill on the internet.

**OQ13. When are the note and its snapshots uploaded?** (New: finding on sealing. A hash lookup in `/v1/content` is public.) *Decided on 2026-11-24: (a).*
- **(a) The salted note is uploaded before the answer is submitted; the snapshots are uploaded after the window's deadline. Recommended.** The salt makes the note's hash unguessable, so its existence reveals nothing; a snapshot's hash can be computed by anyone who fetches the same page, so uploading it before the deadline would show that some agent ran an analysis, and it waits. Cost: a second pass per answered window and snapshot files kept in the state directory until the deadline passes; if the agent never comes back, the note names a snapshot hash that never resolves.
- **(b) Upload the note and the snapshots after the deadline.** Benefit: nothing is public early, and no salt is needed. Cost: if the agent dies or forgets, the signed hash points to nothing and the answer has no readable note, and every note upload needs the same return pass.
- **(c) Upload everything before the submit, as in the first draft, and state the leak.** Cost: anyone can test guesses about a sealed answer. Not recommended.

**OQ14. What does a carry-forward sign?** (New: a carried probability is stale on deadline questions.) *Decided on 2026-11-24: (a).*
- **(a) The same number. Recommended for this stage.** Cheapest and simplest; its bias on deadline questions is stated (section 2.9) and the heartbeat bounds it.
- **(b) An optional cheap hook `Model.carry(m, prior, now)`** that returns an adjusted probability without the expensive model call (for example a time decay the operator chooses). The note's kind stays `carry_forward`. Cost: a rule per question type that is a forecasting decision, not a platform one; one more optional method and its tests.
- **(c) Rely on a heartbeat that shrinks toward the close** (OQ5 c). Cost: more analyses near the close, which is when most questions are decided.

**OQ15. Is freshness shown per market only, or also per forecaster?** (New: the brief says "how fresh each forecast is".) *Decided on 2026-11-24: (a).*
- **(a) Per market and per window, as designed. Recommended for this stage.** The consensus card and the chart show how recent the window and its answers are, which covers each window's forecast.
- **(b) Also a per-forecaster age** in "How agents reasoned" (for example "last analysis 9 days ago, reported"), following each answer's `prior` chain back to its last analysis. Cost: the reader fetches one more window's answers and notes per forecaster, which raises the request count of OQ10 (a); more to show and to label as reported.

---

## 4. Pre-flight rulings (the controller records these in the decision log before Task 1)

- **Answers to OQ1-OQ15.** The tasks below assume the recommended option of every question. If an answer differs, the affected tasks change as follows. Any option that touches more than one task gets a written change to the brief, reviewed before the first affected task starts.
  - OQ1 (b) or (c): replaces Task 1's note schema and Task 3's note building with a signed-type or route change; needs its own reviewed brief before any code.
  - OQ2 (b) or (c): a new platform task with its own reviewed brief.
  - OQ3 (b): Task 3 stays silent in a quiet window (the carry-forward path is dropped). OQ3 (c) is out of scope.
  - OQ4, OQ5, OQ8: constants and one function each.
  - OQ6 (b): Tasks 1 and 3.
  - OQ7 (b): Tasks 1, 3 and 5.
  - OQ9 (b) or (c): a new live-data task for the website with its own reviewed brief.
  - OQ10 (b): Task 4 is replaced by Task 4B.
  - OQ11 (b): Task 2, plus moving the rules into `@blink/schemas`, `domain` and `@blink/client`, which adds the web and service verification rows.
  - OQ12 (b): Tasks 3 and 6. Task 3 parses `BLINK_SOURCE_FETCHER` as `fixture` or `https`, stops with `INVALID_ENV:BLINK_SOURCE_FETCHER` on any other value, and adds three tests (default fixture, `https` selects `httpsFetcher`, any other value stops). Task 6 changes README line 3 and `agents.md` to "the public API and the sources the operator opts into", and updates its docs test to match.
  - OQ13 (b): Tasks 1 (salt optional) and 3 (a note upload pass after the deadline).
  - OQ14 (b): Task 3 (an optional `Model.carry` hook and its tests).
  - OQ15 (b): Task 1 (a per-forecaster reducer over the `prior` chain), Task 4 (the restated request count) and Task 5 (one line per forecaster in "How agents reasoned", labelled reported, with a browser test).
- **Before Wave A, the controller:**
  - creates `docs/D1_EVENT_DRIVEN_PROGRESS.md` as a skeleton with one empty section per task, and commits and pushes it to `main` (it is a documentation-only change, which CI's `paths-ignore` skips). Implementers do not edit it. The controller, or a documentation agent it dispatches, fills each task's section at that task's checkpoint, in checkpoint order, so parallel tasks never conflict on it.
- **Window timing in tests.** No new real-time test is added. The multi-window behaviour is tested in process with a stub client and a fake clock; the one chain-facing test extends the existing `forecaster submits one signed forecast per window and the API verifies it` case (`tests/anvil/agents-market-roles.test.ts:505`), which already waits for a real open window. The nine-minute real-time cost of that file does not grow.
- **The autonomous drill.** Tasks 2 and 3 change the agents' runtime and the reference forecaster that the drill runs. The drill's forecaster has a belief only for the `normal` question, whose source file the world lists and the fixture fetcher serves, so it takes the cold-start path (and carries forward if a second window opens). The drill (`autonomous.yml`) runs nightly on `main`, and on demand, not on every push. Each task therefore reports the drill row as pending until a nightly run after its push passes. If that run fails, the fix is a new commit on `main`; pushed history is never rewritten.
- **Pushes to `main` deploy the website.** After a push to `main`, once CI passes for that commit, `pages.yml` deploys the static site (a push that CI skips deploys nothing). So every task whose push CI runs redeploys the site from that commit. Tasks 3, 4 and 6 change the docs pages and Task 5 changes the market pages. Each follows the website rules in `AGENTS.md` (no project-status labels, no competitor comparisons, media shown inline) and describes only what is already on `main`. Sample views stay labelled "Sample data".
- **Review.** Each diff gets a reviewer who is not its implementer.

---

## 5. Tasks

### Checkpoint procedure (the last step of every task)

1. **Verification.** The implementer runs the commands the task lists and reports their real output. A command that cannot run on the implementer's host is reported as not run, with the reason, and relies on its CI job.
2. **Reviewer approval.** A reviewer who is not the implementer reads the diff against the brief. Critical and High findings go back to an implementer and are reviewed again.
3. **The controller reads the final diff itself**, confirms it matches the brief, and finds no secrets, debug output or unrelated edits.
4. **The controller commits and pushes** the task to `main` (no force push; if a push is rejected, report it and keep the local work), after filling the task's section of `docs/D1_EVENT_DRIVEN_PROGRESS.md` with the scope, the real test output and any verification limit.
5. **CI is green for that commit.** If it fails, the fix is a new commit; the pushed commit is not rewritten. A task that changes the website is live once this passes (section 4). The drill row stays pending until a nightly run after the push passes.
6. **The controller reports the commit hash and whether the push succeeded.**
7. **Cleanup.** Merged task worktrees and branches, per-task logs and any background waits started for the task are removed, after looking at each; nothing a running agent still uses is removed.

### Task 1: The forecast note schema and the freshness functions

**Files:**
- Create:
  - `packages/schemas/src/forecast-note.ts`
  - `tests/forecast-note.test.ts`
- Modify:
  - `packages/schemas/src/index.ts`: export the new module
  - `packages/client/src/index.ts`: re-export `parseForecastNote`, the note types and `computeFreshness` (the agents and the web read them through `@blink/client` and `@blink/schemas`)
  - `tests/forecast-signing.test.ts`: the type pin

**Interfaces:**
- `ForecastNote`: the zod schema of section 2.6, strict, with the constants `FORECAST_NOTE_SCHEMA = "blink.forecast-note/0.1"` and `FORECAST_NOTE_MAX_BYTES = 65_536`.
- `parseForecastNote(bytes: Uint8Array): { ok: true; note: ForecastNote } | { ok: false; reason: string }`: refuses a BOM, invalid UTF-8, JSON that is not an object, more than 64 KiB, an unknown key, a missing or malformed `salt`, a `marketId` that is not canonical decimal, a `url` over 2048 characters, more than 20 evidence items, a `NEW` item with a `since`, a `CHANGED` item without one or with one after `observedAt`, and a `carry_forward` note that lists a `NEW` or `CHANGED` item. Like `parseMarketSpec`, it never serialises the note again.
- `noteBelongsTo(note, { marketId, markets, forecaster, horizon, scheduledAt }): boolean`: compares all five fields (addresses lowercased).
- `summarizeWindow(answers: { note: ForecastNote | null; noteState: "read" | "none" | "unfetched"; receivedAt: number }[], window: { scheduledAt: number; openAt: number }): WindowSummary`: `{ scheduledAt, answers, analysed, carried, noNote, unfetched, evidence, firstChecked }`. `evidence` merges `CHANGED` items across notes by `url` (the latest `observedAt`, the earliest `since`, and the count of answers that saw it); items whose `observedAt` is outside `[openAt - 86400, receivedAt]` or whose `since` is after `observedAt` are ignored. `firstChecked` counts `NEW` items and is never counted as a change. `noteState` is `read` (a readable note for this answer), `none` (`NO_CONTENT_HASH`, a 404, a hash mismatch, an invalid note or a note for another subject; counts in `noNote`) or `unfetched` (only beyond the reader's `notesPerWindow` limit; counts in `unfetched`, not in `noNote`).
- `computeFreshness(windows: WindowSummary[], asOf: number): FreshnessView` per section 2.5, with `FRESHNESS_AGING_WINDOWS = 1` and `FRESHNESS_STALE_WINDOWS = 3`. `FreshnessView` is also a zod schema, so a client or a web fixture can be validated against it.

- [ ] **Step 1: Write the failing tests.**
  - `tests/forecast-note.test.ts`:
    - `parseForecastNote accepts an analysis note and a carry-forward note`
    - `parseForecastNote refuses a BOM, invalid UTF-8, an unknown key, 21 evidence items, a non-https url, a url over 2048 characters and bytes over 64 KiB`
    - `a note of exactly 65,536 bytes parses`
    - `a note without a salt, or with a malformed one, is refused`
    - `a marketId with a leading zero or a sign is refused`
    - `a NEW item with a since is refused; a CHANGED item without a since, or with one after observedAt, is refused`
    - `a carry-forward note listing a CHANGED or NEW item is refused; a heartbeat analysis note listing only UNCHANGED items is accepted`
    - `a note for another window, market, deployment or forecaster is unreadable` (`noteBelongsTo`, one case per field)
    - `summarizeWindow counts analysed, carried, noNote and unfetched answers separately`
    - `summarizeWindow merges the same url seen by two agents into one change with two witnesses`
    - `evidence items with times outside the window are ignored`, and `a NEW item is counted as firstChecked and not as a change`
    - `computeFreshness is CURRENT when the latest closed window has an answer, AGING at 1 and 2 windows behind, STALE at 3 and NONE with no answer` (the Tuesday to Friday example of section 2.5)
    - `computeFreshness reports evidenceChangedAt as the latest observedAt of a CHANGED item in an analysis note, and null when there is none or only NEW items`
  - `tests/forecast-signing.test.ts`: `the Forecast typed data and a fixed digest are unchanged`. It holds the literal EIP-712 type string and the digest of one fixed message, so any edit to `forecastTypes`, the domain or the field order fails. It passes before and after this task; it exists to fail later if someone edits the signed type (Review Focus 1).
- [ ] **Step 2: Run** `node --import tsx --test tests/forecast-note.test.ts tests/forecast-signing.test.ts`. Expected: the note tests FAIL (module missing); the pin passes.
- [ ] **Step 3: Implement** the module. `packages/schemas` and `packages/client` are source-exported: relative imports must name the real `.ts` file (`pnpm check:boundaries` enforces it).
- [ ] **Step 4: Run** the Step 2 command, then `pnpm check`. Because `@blink/schemas` is consumed by the web and bundled by the services, also run `pnpm build`, `pnpm test:browsers`, `pnpm build:pages && node scripts/check-pages-export.mjs`, `pnpm build:services` and `pnpm test:service-build`. `@blink/client` is chain-facing code: also run `pnpm test:contracts`, `pnpm test:anvil` and `pnpm test:contracts:seeds`. Expected: PASS.
- [ ] **Step 5: Run the checkpoint procedure** with the commit message `feat: forecast note schema and freshness functions, with the signed type pinned`.

### Task 2: The source watcher in the reference agents

**Files:**
- Create:
  - `examples/agents/src/lib/fetcher.ts`: the safe https fetcher (`httpsFetcher`), its pure `httpsRequestOptions` and default transport, and the fixture fetcher
  - `examples/agents/src/lib/watch.ts`: normalisation, fingerprints, `checkSources`, `decideUpdate`
  - `tests/agents-watch.test.ts`
- Modify:
  - `examples/agents/src/lib/state.ts`: `watch?: Record<marketId, WatchRecord>` and its validation in `loadState` (an older state file without it still loads; a malformed record is `STATE_CORRUPT`)
  - `examples/agents/src/lib/env.ts`: `AgentContext` gains `fetcher: SourceFetcher`; `createContext` takes it as a required option, with no network default
  - `examples/agents/src/main.ts:45`: passes `fixtureFetcher(world)` (Task 3 finishes this wiring and its test)
  - the `createContext` callers and typed `AgentContext` literals that a required field breaks, so that `pnpm typecheck` passes (the root `tsc` run includes `tests/**`): `tests/cdp/cdp-wallet.test.ts:93`, `tests/anvil/agents-market-roles.test.ts:116`, `tests/anvil/agents-resolution-roles.test.ts:181`, `tests/anvil/trader-edge-gate.test.ts:89`, `tests/anvil/alpha-platform-pglite.test.ts:49` and `tests/helpers/trader-agent.ts:87`. Each passes the fixture fetcher or a stub

**Interfaces:**
- `type SourceFetcher = (url: string, validators: { etag?: string; lastModified?: string; finalUrl?: string }) => Promise<{ status: 200; bytes: Uint8Array; mediaType: string; charset?: string; etag?: string; lastModified?: string; finalUrl?: string } | { status: 304 } | { status: "error"; code: string }>`. `mediaType` is the response's `Content-Type` without parameters and `charset` is its `charset` parameter, lower-cased. `finalUrl` is where the redirects ended, and the validators are sent only on the request for that URL.
- `httpsFetcher(options?: { resolve?, transport?, timeoutMs?, maxBytes?, maxRedirects?, extraBlockedRanges?, direct? }): SourceFetcher`: section 2.2's rules. It is exported for operators who embed the code (OQ12); nothing in `main.ts` builds it. The two seams have fixed shapes, copied from the platform's (`packages/ports/src/source-fetcher.ts:15-27`) and not imported:
  - `resolve(host, signal?): Promise<{ address: string; family: 4 | 6 }[]>`. The default is the c-ares resolver (A and AAAA together, cancelled by the signal, 300 ms resolution delay), not `dns.lookup` (section 2.2);
  - `transport.request({ ip, family, url, signal, timeoutMs, validators? }): Promise<{ status: number; headers: Record<string, string>; body: AsyncIterable<Uint8Array> }>`. The default transport takes an injectable `request` (default `https.request`) and calls it with `httpsRequestOptions({ ip, family, url, validators })`.
- `httpsRequestOptions({ ip, family, url, validators? }): https.RequestOptions`: pure and exported, as in section 2.2.
- `fixtureFetcher(world: World): SourceFetcher`: serves `world.questions[*].sources` files and answers `{ status: "error", code: "NOT_IN_WORLD" }` for any other URL, so CI never touches the network. The media type comes from the file extension: `.txt` `text/plain`, `.html` `text/html`, `.json` `application/json`, `.csv` `text/csv`, `.pdf` `application/pdf`, anything else `application/octet-stream`.
- `isPublicAddress(ip: string): boolean`: the address rules, in the example's own words.
- `normalizeForFingerprint(bytes, mediaType): string` and `fingerprint(text): Hex` (keccak256 of the UTF-8 text).
- `type WatchRecord = { sources: Record<url, { fingerprint: Hex; etag?: string; lastModified?: string; finalUrl?: string; checkedAt: number }>; windowsCursor?: string; prior?: { digest: Hex; windowId: string; analysedAt: number; answeredAt: number; probabilityBps: number }; intent?: { windowId: string; kind: "analysis" | "carry_forward"; noteBytes: string; probabilityBps: number }; pendingSnapshots?: { hash: Hex; mediaType: string; windowId: string }[] }` (the last three are used in Task 3; `windowsCursor` is a cursor the server issued and is never built by the agent, section 2.4; `probabilityBps` here is the agent's own record, which the carry-forward signs, not a field of the note).
- `checkSources(fetcher, record, urls, now): Promise<{ items: SourceCheck[]; next: WatchRecord["sources"] }>` where `SourceCheck` is `{ url, status: "NEW" | "CHANGED" | "UNCHANGED" | "UNREACHABLE", since: number | null, observedAt, fingerprint: Hex | null, raw?, mediaType?, code? }` (`fingerprint` is null only for an `UNREACHABLE` source that has never been read; `code` is the failure code of an `UNREACHABLE` source) and `now` is a whole number of unix seconds. It does not mutate `record`; the caller commits `next` only after a successful submission. It throws a `RangeError` on a list that `watchableUrl` would have filtered (section 2.2).
- `decideUpdate({ prior, items, now, heartbeatSeconds }): { action: "analyse"; reason: "cold_start" | "change" | "heartbeat" } | { action: "carry_forward" }`.

- [ ] **Step 1: Write the failing tests** in `tests/agents-watch.test.ts`:
  - `a URL with userinfo, a non-443 port, a non-https scheme or an IP-literal host is refused before any socket opens` (cases: `http://a.example/`, `https://user:pw@a.example/`, `https://a.example:8443/`, `https://10.0.0.1/`, `https://[::1]/`, `https://0x7f.1/`; the transport and the resolver are never called)
  - `a lookup answer with one public and one private address is refused`
  - `httpsRequestOptions pins the connection to the checked address` (IPv4 and IPv6; the pinned `lookup` answers both the single and the `{ all: true }` form with the checked address; hostname, port 443, `servername`, the `Host` header, `agent: false` and `rejectUnauthorized: true`), modelled on the platform's test of its own options (`tests/allowlist-fetcher.test.ts:421-470`)
  - `the default transport passes those options to request` (a `request` spy; no socket opens)
  - `every redirect is checked again: a redirect to an IP literal, to http, to another port or to a name that resolves privately is refused, and a fourth redirect is refused`
  - `a compressed body that expands past the cap is UNREACHABLE with code TOO_LARGE`, and `a body over the cap is TOO_LARGE`
  - `isPublicAddress agrees with the platform's isPublicAddress over a list of addresses` (the test imports the platform's function from `packages/domain/src/network-policy.ts`; the example does not). The same drift test compares the example's and the platform's `httpsRequestOptions` outputs for hostname, port, servername, Host, agent, `rejectUnauthorized` and the pinned lookup answers
  - `a 304 answer is UNCHANGED and downloads nothing`
  - `a script nonce and a timestamp attribute keep the fingerprint; a changed paragraph changes it` (HTML); `key order does not change a JSON fingerprint`
  - `a first sighting is NEW with since null, a changed fingerprint is CHANGED, the same is UNCHANGED, a failed fetch is UNREACHABLE and keeps the old fingerprint`
  - `since is the time of the previous successful check`
  - `decideUpdate: cold start analyses; a change analyses; a NEW source after the cold start analyses; a heartbeat analyses with nothing changed; otherwise carries forward; an UNREACHABLE source alone never analyses`
  - `state with watch records survives a rename-write and a reload; an older state file without them still loads; a malformed watch record is STATE_CORRUPT`
  - `the fixture fetcher serves the world's source files with their media types and nothing else`
  - `createContext without a fetcher is a type error` (a `// @ts-expect-error` case that `pnpm typecheck` verifies)
- [ ] **Step 2: Run** `node --import tsx --test tests/agents-watch.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.** `pnpm check:boundaries` must still pass: the files import only `@blink/client`, `viem`, `node:*` and each other, and no comment names `packages/`, `apps/` or `contracts/out`.
- [ ] **Step 4: Run** the Step 2 command and `pnpm check`. Example agents are chain-facing code, so also run `pnpm test:contracts`, `pnpm test:anvil` and `pnpm test:contracts:seeds`. The agents' runtime is what the drill runs: the reference-agent row, `node --import tsx --test tests/alpha/autonomous.test.ts` (about 18 minutes; needs `TEST_POSTGRES_ADMIN_URL`), runs nightly and is reported as pending until a nightly run after the push passes. Expected: the others PASS. Because this fetcher is exported for operators and handles hostile input, the reviewer of Task 2's diff includes an adversarial review by a second model (`AGENTS.md` encourages this for security-relevant changes).
- [ ] **Step 5: Run the checkpoint procedure** with the commit message `feat: safe source watcher for reference agents with fingerprints and a change decision`.

### Task 3: The event-driven forecaster

**Files:**
- Modify:
  - `examples/agents/src/roles/forecaster.ts`
  - `examples/agents/src/lib/model.ts`: `Model` gains two optional methods, `watchList(m)` (default: `m.spec.sources`) and `revise(m, { prior, changes })` (default: `probabilityBps(m)` with an empty summary); `fixtureModel` implements `watchList` from the world's `sources`. The `Model` literals in `tests/anvil/alpha-platform-pglite.test.ts:14`, `tests/anvil/trader-edge-gate.test.ts:79` and `tests/helpers/trader-agent.ts:25` stay valid because the methods are optional
  - `examples/agents/src/lib/env.ts`: optional `BLINK_FORECAST_HEARTBEAT_HOURS` (default 336, that is 14 days; an invalid value stops the process with `INVALID_ENV:<name>`)
  - `examples/agents/src/main.ts`: extracts and exports `agentParts(env, world)`, returning `{ model, fetcher, heartbeatSeconds }`, because `main()` builds the context inline (`main.ts:42-57`) and could not otherwise be tested. It always builds `fixtureFetcher(world)` next to `fixtureModel(world)` and passes the heartbeat option. (If OQ12 (b) is chosen: `BLINK_SOURCE_FETCHER=https` selects `httpsFetcher()`, default `fixture`, with its own test.)
  - `tests/anvil/agents-market-roles.test.ts`: the case at line 505 now expects `contentHash` to be the keccak256 of a note that parses
  - `tests/agents-runtime.test.ts`: the fixture model's new methods answer from the agent's own beliefs only
  - `apps/web/content/docs/forecaster.md`: only what the docs-coverage test forces. Its Steps must name every client call that `roles/forecaster.ts` makes (`tests/agent-docs-coverage.test.ts`, "each role's Steps name every call its reference agent makes"), so the new `uploadContent` call is added, with one sentence that `contentHash` is now the hash of a note, and Step 2 names the `content:write` scope next to `forecast:write`. The "Reasoning is optional" bullet says that the reference forecaster publishes no reasoning document, which is false after this task, so it is corrected in the same commit. The full rewrite is Task 6. Because the forecaster now also settles a closed-window intent with `listForecasts` and reads a window's status with `getForecastWindow` (section 2.4), the Steps name both calls too
  - `tests/web-docs-content.test.ts`: the new test below
- Create:
  - `examples/agents/src/lib/note.ts`: builds the note bytes (salt, size and item limits)
  - `tests/agents-forecaster-events.test.ts`

**Interfaces:**
- The tick of section 2.4, in this order for each OPEN market:
  1. read the windows from `state.watch[marketId].windowsCursor` (a cursor the server issued, never one the agent builds), following `nextCursor` until the open windows are reached; keep the unanswered `OPEN` ones; save the cursor whenever it moves (it advances to `nextCursor` when a whole page is `CLOSED`), whether or not anything is answered;
  2. resume a saved `intent` for the window, if any (resubmit its exact bytes). An intent whose window is no longer OPEN (read with `getForecastWindow({ windowId })`, the platform's clock) is settled instead (section 2.4): list the agent's own answer in that window, set `prior` if the digest matches, else drop the intent with its `pendingSnapshots` and their files and log `intent_dropped`;
  3. `checkSources` over `model.watchList(m)`, once per window (kept in memory for the retries of later ticks);
  4. `decideUpdate`; on `analyse`, call `model.revise` (at most 3 attempts per window, at least 10 s apart, and the answer is kept in memory once received); on `carry_forward`, take `prior.probabilityBps`. A null from the model is `no_view`: nothing is submitted and the new fingerprints are not committed. The watch list is capped at 20 URLs, `spec.sources` first, with a `watch_list_truncated` line, and a URL over 2048 bytes in JSON is also dropped, with `watch_url_too_long`;
  5. build the note (`kind`, a fresh random `salt`, the window's identifying fields, `prior.digest`, the evidence items, `summary`). For each `CHANGED` item whose media type is one of the five the store accepts and whose size is at most 1 MiB, compute the snapshot hash and write the bytes to a file named by hash, queued in `pendingSnapshots` with the window id; any other item gets `snapshot: null` and a `snapshot_skipped` log line (OQ7);
  6. write the snapshot files, then save the intent together with its `pendingSnapshots` in one state save, then upload the note, sign `Forecast` with `contentHash = keccak256(noteBytes)` and submit;
  7. commit the new fingerprints, `prior` and the window cursor to the state in one save, and mark the window answered;
  8. each tick, for pending snapshots whose window `getForecastWindow({ windowId })` reports as `CLOSED` (the platform's clock): upload them. A transient failure (429, 5xx, network) is retried at most once a minute and given up 24 hours after the deadline (`snapshot_upload_failed`, code `GAVE_UP`). Any other failure is permanent: a 4xx other than 429 (for example `415`), a missing or unreadable snapshot file, bytes that no longer hash to the file's name, `HASH_MISMATCH`, or a malformed response. It is logged as `snapshot_upload_failed` with its code and dropped with its file. An upload never changes or blocks an answer, which was submitted before.
- Log lines: `forecast_decision { marketId, windowId, action, reason, checked, changed, unreachable }`, `forecast_submitted` (as today, plus `kind` and `contentHash`), `no_view`, `analysis_failed`, `window_missed`, `snapshot_skipped`, `snapshot_upload_failed`, `watch_list_truncated`, `watch_url_too_long` and `intent_dropped`.
- `Model.revise(m, { prior, changes }): Promise<{ probabilityBps: number; summary: string } | null>`. The fixture model returns the world belief and an empty summary; `probabilityBps(m)` stays for the maker and the trader.

- [ ] **Step 1: Write the failing tests** in `tests/agents-forecaster-events.test.ts` (in process: a stub `BlinkClient`, a scripted fetcher, a counting model, a fake clock):
  - `first window: a cold start runs one analysis, uploads a salted analysis note and signs its hash`
  - `second window with every source unchanged: zero model calls, a carry-forward note naming the prior digest, the same probability`
  - `two carry-forward notes built from identical inputs have different hashes`
  - `a changed source: one analysis; the note lists the CHANGED item with since and observedAt; the snapshot hash is in the note`
  - `no snapshot is uploaded before the API lists the window as CLOSED, and it is uploaded after`
  - `a source in an unaccepted media type or over 1 MiB gets snapshot null in the note and a snapshot_skipped line`
  - `after the deadline, a snapshot refused with a 4xx other than 429 is logged as snapshot_upload_failed and dropped with its file; a 429, a 5xx or a network error keeps it and retries at most once a minute; the submitted answer is unchanged`
  - `a missing snapshot file and a HASH_MISMATCH are logged and dropped, not retried; a 503 is retried at most once a minute and given up 24 hours after the deadline with code GAVE_UP`
  - `dropping an intent also drops its pendingSnapshots and their files`
  - `a source that differs only in noise runs no analysis`
  - `a heartbeat runs an analysis after the limit with nothing changed, and the note's items are all UNCHANGED`
  - `an unreachable source never triggers an analysis, is listed UNREACHABLE, and the carry-forward is still signed`
  - `a model with no view submits nothing, logs no_view and keeps the old fingerprints, with or without an earlier forecast`
  - `an analysis that throws is called at most 3 times in one window, at least 10 s apart, submits nothing, does not fetch the sources again, and logs window_missed`
  - `a failure after the model answered (note upload, submit) never calls the model again in that window`
  - `a cold start with 25 watched URLs builds a note that parses, with the watch list truncated to 20 and watch_list_truncated logged`
  - `the builder keeps every CHANGED item and stays within 65,536 bytes: 20 CHANGED items with 2048-byte URLs, 500-character notes and a 2000-character summary of U+0001 (six bytes each in JSON) build a note that parses`
  - `a watched URL over the limit (a 3000-character spec source, or a 2048-character one whose backslashes double in JSON) is dropped with watch_url_too_long and never blocks the note`
  - `restart after the intent was saved resubmits identical bytes` (the stub API returns the replayed receipt; the salt is the same) `and still uploads the snapshots after the deadline`
  - `an intent whose window closed before the restart is settled: when the agent's answer in that window has the intent's digest, prior is set (with analysedAt for an analysis) and the fingerprints stay uncommitted; when it has not, the intent is dropped and intent_dropped is logged`
  - `one decision per window, even when the source changes after the answer`
  - `a market with 150 windows is answered in the 150th window, reading at most two pages per tick after the first, from the saved cursor`; `the cursor is saved whenever it moves, even when the model has no view, and is never built by the agent`
  - `a model without watchList or revise uses spec.sources and probabilityBps`
  - `the signed message equals the old shape except contentHash`: it rebuilds the message with `forecastTypedData` and `NO_CONTENT_HASH` and compares every other field.
  - `agentParts returns the fixture fetcher: a URL outside the world answers NOT_IN_WORLD, and main.ts never references httpsFetcher` (a read of the file as text, like the boundary check, plus the call on `agentParts`)
  - `91 windows, 4 source changes, a 14-day heartbeat: 8 analyses and 91 signatures (every window gets one, as an analysis or a carry-forward); no heartbeat: 5 analyses; a 7-day heartbeat: 15`. This is the saving of section 2.8 as an assertion.
  - `tests/web-docs-content.test.ts`: `the forecaster page does not say that the reference forecaster publishes no reasoning document`
  - Anvil, in the existing case (`tests/anvil/agents-market-roles.test.ts:505`): the API returns the answer with `contentHash` equal to the keccak256 of a note the client can fetch, `parseForecastNote` accepts it, `noteBelongsTo` is true and `kind` is `analysis` (a cold start). The digest check (`:542`) now uses that `contentHash`.
- [ ] **Step 2: Run** `node --import tsx --test tests/agents-forecaster-events.test.ts tests/agents-runtime.test.ts tests/web-docs-content.test.ts tests/agent-docs-coverage.test.ts`. Expected: the new tests FAIL. `tests/agent-docs-coverage.test.ts` passes before the change; it guards Step 3, because it fails if `uploadContent` or `listForecasts` is added to the role file without the docs.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** the Step 2 command, then `pnpm check`, `pnpm test:contracts`, `pnpm test:anvil` and `pnpm test:contracts:seeds` (the chain-facing row), `pnpm build`, `pnpm test:browsers` and `pnpm build:pages && node scripts/check-pages-export.mjs` (the docs page is built into the site), and `pnpm alpha:local` (the forecast flow across the API, worker and indexer). The reference-agent row is `node --import tsx --test tests/alpha/autonomous.test.ts` (about 18 minutes; needs `TEST_POSTGRES_ADMIN_URL`). It runs nightly on `main`, not per push: report it as pending until a nightly run after the push passes. Expected: the others PASS.
- [ ] **Step 5: Run the checkpoint procedure** with the commit message `feat: event-driven reference forecaster that analyses only on change, and signs a note by hash`.

### Task 4: Reading freshness from the public routes

(If OQ10 is answered (b), replace this task with Task 4B below.)

**Files:**
- Create:
  - `packages/client/src/freshness.ts`
  - `tests/client-freshness.test.ts`
- Modify:
  - `packages/client/src/index.ts`
  - `apps/web/content/docs/client.md`: a subsection for `getMarketFreshness`. It is a function that takes a client, not a method of the client, so the method count that `tests/agent-docs-coverage.test.ts` checks in `client.md` does not change
  - `apps/web/content/docs/forecaster.md`: a bullet or an H3 inside an existing section (a role page keeps exactly its six H2 sections, `tests/agent-docs-coverage.test.ts:34-42`), "Read how fresh a market is"

**Interfaces:**
- `getMarketFreshness(client: BlinkClient, marketId: string, options?: { asOf?: number; windows?: number; notesPerWindow?: number; cache?: Map<string, Uint8Array> }): Promise<FreshnessView & { windows: WindowSummary[] }>`: pages `listForecastWindows` and `getConsensus` to the end of the market's closed windows and keeps the latest 30 (default); calls `listForecasts` for each window that has answers (paging each); then `getContent` for each answer's `contentHash` (at most 20 per window; `NO_CONTENT_HASH` is not fetched; the rest are `unfetched`; every other answer without a readable note is `none`, see `summarizeWindow`). Notes are immutable, so a `cache` keyed by hash is read before and written after each fetch. It reduces each window with `summarizeWindow` and returns `computeFreshness`.
- It never throws for a bad note: a 404, a hash mismatch (`HASH_MISMATCH`), unparsable bytes, a note for another window, market, deployment or signer all count as `noNote`.

- [ ] **Step 1: Write the failing tests** in `tests/client-freshness.test.ts`, with a stub client:
  - `reads the latest closed windows and fetches only the notes of their answers`
  - `pages to the latest windows of a market with 150 windows`
  - `NO_CONTENT_HASH is never fetched and counts as an answer without a note`
  - `a missing note, a hash mismatch, an invalid note and a note for another window, market or forecaster each count as noNote and never throw`
  - `at most notesPerWindow notes are fetched per window; the rest count as unfetched, not noNote`
  - `a cached note is not fetched again`
  - `windows without answers count toward windowsBehind`
  - `the result equals computeFreshness over the same data` (the reducer is shared)
  - `a withdrawn answer is ignored` (`withdrawnAt` is set)
- [ ] **Step 2: Run** `node --import tsx --test tests/client-freshness.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** the Step 2 command and `pnpm check`. The client and the docs content are web- and chain-facing: also run `pnpm build`, `pnpm test:browsers`, `pnpm build:pages && node scripts/check-pages-export.mjs` and `pnpm test:contracts`, `pnpm test:anvil`, `pnpm test:contracts:seeds`. Expected: PASS.
- [ ] **Step 5: Run the checkpoint procedure** with the commit message `feat: client reader that turns forecast notes into a market freshness summary`.

**Task 4B (only if OQ10 is answered (b)).** A read-only route `GET /v1/markets/:id/freshness`.
- Files: `packages/schemas/src/http.ts` (the operation and the `FreshnessView` response), `apps/api/src/routes.ts`, `packages/application/src/forecasts.ts` (a handler beside `getConsensus`), `packages/ports/src/forecasts.ts` and `packages/adapters/src/forecast-store.ts` (a read of closed windows' answers with their `contentHash`), `packages/application/src/content.ts` or a content-store read for the notes, `packages/client/src/index.ts`, `apps/web/content/openapi-index.ts` and the tests that compare the route list, plus `tests/forecasts.test.ts`, `tests/postgres/forecasts.test.ts` and `tests/api-route-services.test.ts`.
- Failing tests first: the route returns the same `FreshnessView` as `computeFreshness` on a seeded market; a sealed window is excluded; a missing note counts as `noNote`; the answer is public and needs no key.
- Verification rows added: `pnpm build:services` then `pnpm test:service-build`; `pnpm test:postgres` and `pnpm drill:restore:test` (code that runs against PostgreSQL); `pnpm alpha:local`.

### Task 5: The website shows freshness and what changed

**Files:**
- Create:
  - `apps/web/content/sample-freshness.ts`: `sampleFreshness(m)`, which calls `computeFreshness` with the market's `updatedAt` as `asOf`, for OPEN markets only. It is imported only by `page.tsx` and the tests, so `@blink/schemas` and `zod` stay out of the chart's client bundle (`ForecastChart.tsx` imports values from `sample-markets.ts`, and `@blink/schemas` is not marked side-effect free)
  - `apps/web/components/markets/FreshnessLine.tsx` and its CSS module (a server component)
  - `apps/web/components/markets/EvidenceChanges.tsx` and its CSS module (a server component)
- Modify:
  - `apps/web/content/sample-markets.ts`: `ForecastWindow` gains `analysed`, `carried` and `changes` (each `{ source, since, observedAt, summary, moves, snapshot }`, all `CHANGED`) and `firstChecked`; the sample windows are given values that exercise a change, a quiet stretch and a heartbeat; this file imports neither `@blink/schemas` nor `zod`
  - `apps/web/components/markets/ForecastChart.tsx`: the change markers, the carried-forward point style, the tooltip lines, the two table columns and the aria label; it receives plain numbers and imports neither `zod` nor `@blink/schemas`
  - `apps/web/app/markets/[id]/page.tsx`: the freshness line in the consensus card and the "What changed" section
  - `apps/web/app/markets/[id]/page.module.css`
  - `tests/web-sample-markets.test.ts`, `tests/browser/market-detail.spec.ts`

**Interfaces:**
- `FreshnessLine({ freshness, open })`: for an OPEN market, renders the level word, the latest window's date in UTC, the windows behind, "N of M answers reported a new analysis" and "K sources changed (reported)". For a market that is not OPEN it renders "Forecasting ended at close; last window <date>" and no level. It carries the sample notice when it is given sample data.
- `EvidenceChanges({ windows })` renders the newest changes first, with the line "Reported by the forecasters; an archived snapshot can be checked against its hash." and, per change, the source host, "changed between X and Y (UTC)", the summaries, the signed moves (for example "62.0% to 65.0%") and the snapshot hash as text. A first check is "first checked", never a change.
- Copy follows U24: no status words, no other platforms, no invitation. "Sample data" stays wherever sample values appear. The chart's existing aria-label prefix, "Line chart of the probability of YES", stays, because `market-detail.spec.ts` matches it.

- [ ] **Step 1: Write the failing tests.**
  - `tests/web-sample-markets.test.ts`:
    - `every sample window has analysed + carried equal to its forecasters`
    - `a window with changes has at least one analysed answer`
    - `sample-markets.ts and ForecastChart.tsx import neither @blink/schemas nor zod` (a read of both files as text)
    - `sampleFreshness equals computeFreshness over the sample windows` and is `CURRENT` for the open sample markets at their snapshot date
    - `a market that is not OPEN has no freshness level` (sample-03 to sample-06)
    - `evidence change dates are ordered: since is before observedAt, and observedAt is not after the window`
  - `tests/browser/market-detail.spec.ts`:
    - `the consensus card of an open sample market shows the freshness line with the level and the latest window`
    - `a FINAL sample market (sample-05) and sample-06 show "Forecasting ended at close" and no level word`
    - `the What changed section lists the sample changes newest first and carries the reported-by-forecasters line`
    - `the chart table has the New analysis / carried and Sources changed columns and one row per window`
    - `a chart marker exists for each window with changes, and the tooltip names the changed sources`
    - `the market page does not overflow at 375 px` (extends the existing overflow check to the new section)
  - The showcase-claims scan (`tests/showcase-claims.ts`) runs over the new components without a change to its rules; add a case in `tests/web-claims.test.ts` that the new copy contains none of the banned phrases and no payment wording.
- [ ] **Step 2: Run** `node --import tsx --test tests/web-sample-markets.test.ts tests/web-claims.test.ts`. Expected: FAIL. The browser tests fail in CI's browsers job.
- [ ] **Step 3: Implement.** Before writing Next code, read the guides named in `apps/web/AGENTS.md`. Every root-relative `href` or `src` goes through `withBase` (`apps/web/lib/base-path.ts`).
- [ ] **Step 4: Run** the Step 2 command, `pnpm check`, then `pnpm build`, `pnpm test:browsers` and `pnpm build:pages && node scripts/check-pages-export.mjs`. A web task counts as verified only when CI is green for its pushed commit, and after that push `pages.yml` deploys the site (section 4), so the copy must already follow the website rules in `AGENTS.md`; a command that cannot run on the host (for example without the Playwright browsers) is reported as not run, with the reason.
- [ ] **Step 5: Run the checkpoint procedure** with the commit message `feat: the market page shows how fresh the consensus is and which evidence changed, on sample markets`.

### Task 6: Agent docs and delivery records

**Files:**
- Modify:
  - `apps/web/content/docs/forecaster.md`: replace the rest of "Reasoning is optional" with the event-driven pattern (the watch list, the three triggers, carry forward, the salted note and its schema, snapshots after the deadline, the one-answer-per-window rule). The docs' example uses a host that `tests/web-docs-content.test.ts:37-43` allows (only `blinkmarket.xyz` and `github.com`), not `example.com`. It tells operators that fetched page text reaches their model as untrusted input (prompt injection) and must be treated as data. Role pages keep exactly six H2 sections
  - `apps/web/content/docs/agents.md` and `examples/agents/README.md`: say that `httpsFetcher` exists for operators who embed the agent code, that the reference process reads sources only from its fixture world unless the operator opts in (OQ12), and keep line 3's "public API and nothing else" true for the process as shipped; the README's "The forecaster" section and the new env variable `BLINK_FORECAST_HEARTBEAT_HOURS`
  - `docs/ROADMAP.md`: one line under the direction-change list, naming direction 1 and the slice delivered (do not tick the whole direction when only a slice is done)
  - `docs/superpowers/specs/2026-11-16-long-horizon-forecasting-discussion.md`: the status paragraph at the top, to say that direction 1 is implemented as far as the delivery record states, and that the rest is unchanged
  - `tests/agent-docs-coverage.test.ts` and `tests/web-docs-content.test.ts` only if their lists need the new calls
- Create: `docs/D1_EVENT_DRIVEN_FORECASTING.md`, structured like `docs/P3_REFERENCE_AGENTS.md`: the design as built, the note schema, the freshness definition, the open questions' answers, the measured counts, the known limits of section 2.9, and the test commands with their real counts.

- [ ] **Step 1: Write the failing tests.** Add to `tests/web-docs-content.test.ts`:
  - `the forecaster page documents the note schema, the salt, the three triggers and the one-answer-per-window rule`
  - `the forecaster page names getMarketFreshness and client.md has its subsection`
  - `the forecaster page warns that fetched page text is untrusted input`
  - `agents.md and the examples README still say that the reference agents use only the public API as shipped`

  `tests/agent-docs-coverage.test.ts` keeps guarding the Steps of the forecaster page (Task 3 already satisfied it for `uploadContent`).
- [ ] **Step 2: Run** `node --import tsx --test tests/agent-docs-coverage.test.ts tests/web-docs-content.test.ts`. Expected: FAIL.
- [ ] **Step 3: Write the docs.** English only. State the limits of section 2.9 in the delivery record, with no machine details. The site pages promise nothing that is not built (U24).
- [ ] **Step 4: Run** the Step 2 command and `pnpm check`, then `pnpm build`, `pnpm test:browsers` (`docs.spec.ts` and `routes.spec.ts` cover the docs pages) and `pnpm build:pages && node scripts/check-pages-export.mjs` (the docs are built into the site).
- [ ] **Step 5: Run the checkpoint procedure** with the commit message `docs: record direction 1, event-driven forecasting, delivery`. At this checkpoint the controller also fills the final state of `docs/D1_EVENT_DRIVEN_PROGRESS.md` and records the nightly drill (on `main`) as pending until a run after the push passes.

---

## Execution waves

| Wave | Tasks | Why |
| --- | --- | --- |
| A | 1 ∥ 2 | Different files. The controller has already created the progress doc skeleton, so neither edits it. |
| B | 3 | Needs the note schema (1) and the watcher (2). |
| C | 4 ∥ 5 | Both need only Task 1. Task 4 touches the client and docs; Task 5 touches the web. |
| D | 6 | Documents everything above. |

## Out of scope

- **Any contract change.** The plan changes no Solidity, no deployment and no on-chain parameter.
- **The consensus fallback and credit.** Both change with the next contract generation (record 12.5, Q9 and Q10). The plain-mean fallback, relative scoring and horizon buckets are untouched. The interaction in section 2.9 (credit counts answer rows) is recorded, not fixed.
- **Mechanism R and everything about bounties and sponsors.** It stays off the website until it is built (U24).
- **A change to the signed forecast type, a new signed evidence log or submit-time validation of notes**, unless the user answers OQ1 or OQ2 that way.
- **Between-window polling, a scheduler for checks, push notifications, or new window cadences.**
- **Freshness on the `/markets` ledger and a live data path for the website** (OQ9, OQ10).
- **The LLM demo.** `examples/llm-agent` keeps its tools; the docs describe the pattern, and a watch tool for it is a later change.
- **Direction 2 (short-dated evidence markets) and direction 3 (bounties), and the first experiment of section 8.** The forecaster's `forecast_decision` log lines give the experiment its inference counts per arm, but running it is separate.
- **Adding the event-driven behaviour to the autonomous drill's scenarios.** The drill keeps its five scenarios; its forecaster runs the new tick with the fixture fetcher.

## Self-review notes

- **Brief coverage:**
  - cheap change check and when the expensive step runs: sections 2.2 and 2.3, Tasks 2 and 3;
  - updates through the existing windows: section 2.4, Task 3;
  - what "fresh" means and how it is computed: section 2.5, Task 1 and Task 4;
  - how "what evidence changed" is recorded and shown: sections 2.6 and 2.7, Tasks 1, 3 and 5;
  - the signed-type warning: OQ1 (b), Global Constraints, Review Focus 1;
  - the limits (cost only, copying): section 2.9.
- **Facts checked against the code at the time of writing:** one answer per window and no slot freed by a withdrawal (`forecast-store.ts:135-139`, migration `0033` line 28); the content store is not read on submit (`forecasts.ts:77-92`); the reference forecaster signs `NO_CONTENT_HASH`, reads only the first 100 windows and fetches nothing outside the API; the website imports no client and has no API path; `/v1/content` accepts five media types up to 1 MiB and its reads are public.
- **Not determined from the sources:** how many forecasters will be on a market (the sample data uses two); a real model's cost per analysis (the saving in section 2.8 counts analyses, not currency); whether any public source for a class A market changes before its resolution (hence OQ5); the API's future address and CORS policy (OQ9).
