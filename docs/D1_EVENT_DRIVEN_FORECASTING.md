# D1 event-driven forecasting delivery

Direction 1 changed how the reference forecaster decides when to pay for an analysis. A forecaster now runs a cheap "did the sources change?" check in each forecast window and calls its model only when something changed, when it has no earlier forecast, or when a staleness limit (the heartbeat) is reached. Otherwise it signs its earlier probability again. Each answer signs the hash of a forecast note that records what was checked and which sources changed, and the market page shows how fresh the consensus is and which evidence changed. No contract and no signed type changed. Nothing is deployed: the current protocol and services have no public deployment. Tasks 1 to 6 are delivered. See the [plan](superpowers/plans/2026-11-23-direction-1-event-driven-forecasting.md), the [progress record](D1_EVENT_DRIVEN_PROGRESS.md) and the [roadmap](ROADMAP.md).

What this delivery does not do: it lowers an agent's cost and adds no income (the protocol pays a forecaster nothing), it does not check notes on the platform, and the website shows freshness for labelled sample markets only. The limits are in [Known limits](#known-limits).

## What was built

| Task | Result |
| --- | --- |
| 1 | `@blink/schemas` has the forecast note (`blink.forecast-note/0.1`) and four pure functions: `parseForecastNote`, `noteBelongsTo`, `summarizeWindow` and `computeFreshness`. `@blink/client` re-exports them. |
| 2 | `examples/agents` has the source fetchers (`httpsFetcher`, `fixtureFetcher`) and the cheap check (`checkSources`, `decideUpdate`). The platform's `isPublicAddress` admits only global unicast IPv6. |
| 3 | The reference forecaster, `createForecaster({ now })`, analyses only on change, carries forward otherwise, signs the hash of a salted note, and uploads the snapshots after the deadline. |
| 4 | `@blink/client` has `getMarketFreshness`, which composes the public routes into a freshness summary. |
| 5 | The market page shows a freshness line, a "What changed" section and chart markers, on sample markets. |
| 6 | The agent docs and these records. |

## How it works

For each `OPEN` forecast window of an `OPEN` market where its model has a view, the forecaster:

1. checks its watch list once for the window: a conditional read of each URL, at most five at a time, and a fingerprint of the normalised page text. No model is called. The watch list is `Model.watchList(m)` (default: the spec's `sources`), at most 20 URLs, each at most 2,048 bytes once JSON-encoded;
2. decides with `decideUpdate`:
   - **analyse, `cold_start`**: it has no earlier forecast of its own for the market;
   - **analyse, `change`**: a source is `CHANGED`, or `NEW` (first checked, for example a URL was added);
   - **analyse, `heartbeat`**: its last analysis is at least as old as the heartbeat, `BLINK_FORECAST_HEARTBEAT_HOURS` (default 336, that is 14 days);
   - otherwise **carry forward**: sign the earlier probability again;
3. on analyse, calls the model's `revise` (default: the model's probability with an empty summary); on carry forward, takes `prior.probabilityBps`. The model is asked at most 3 times per window, at least 10 seconds apart, and a model answer is kept for the window;
4. builds the note, saves it as an intent (the exact bytes, the snapshot files and the fingerprints to commit), uploads it with `uploadContent`, signs `Forecast` with `contentHash` set to the keccak256 of the note, and submits it. There is one answer per window and a withdrawal does not free the slot, so the forecaster decides once per window and never plans a correction;
5. after a successful submit, commits the fingerprints, `prior` and the window id in one state save, so the next window sees a carry forward or a heartbeat and not a second analysis of the same change;
6. after the platform lists the window as `CLOSED`, uploads the snapshots (the raw bytes of each `CHANGED` source that the note names), and settles an intent whose window closed before it could be resubmitted. Snapshots wait for the deadline because anyone who reads the same page can compute their hashes: uploading them earlier would show that some agent ran an analysis.

The agent process builds `fixtureFetcher(world)` and no other fetcher (OQ12), so it reads source pages only from the files its world file lists. `httpsFetcher` is exported for operators who embed the agent code with their own model.

The cheap check normalises a body before it fingerprints it: HTML loses `script`, `style`, `noscript`, comments, tags and attributes, entities are decoded and whitespace is collapsed; JSON is re-serialised with sorted keys and numbers as written (JSON nested deeper than 256 levels or with more than 100,000 structural tokens is compared as collapsed text); `text/plain` and `text/csv` are trimmed and collapsed; any other type is hashed as raw bytes. A text body is decoded with its declared charset, falling back to windows-1252. A source is `NEW`, `CHANGED`, `UNCHANGED` or `UNREACHABLE`. An unreachable source keeps its old fingerprint, so one failed read cannot fake a change later.

## The forecast note

A JSON document of at most 64 KiB, strict (an unknown key is refused), that the signed `contentHash` names. The platform never reads or checks it (OQ2): a reader parses it with `parseForecastNote` and checks it against the answer with `noteBelongsTo`.

| Field | Meaning |
| --- | --- |
| `schema` | `blink.forecast-note/0.1` |
| `kind` | `analysis` (the model ran) or `carry_forward` (the earlier probability, signed again) |
| `marketId`, `markets`, `forecaster`, `horizon`, `scheduledAt` | The fields of the signed `Forecast` that identify the answer. A mismatch makes the note unreadable, so a note cannot be reused for another window, market or signer. |
| `salt` | 32 random bytes, new for every note. Without it a carry-forward note is almost fully predictable from the previous note, and a public lookup of a guessed hash would reveal a sealed answer before the deadline. |
| `checkedAt` | When the sources were checked. |
| `prior` | `{ digest }` of the forecaster's previous answer on this market. `null` only on a cold start; a `carry_forward` note always names it. |
| `summary` | The reasoning, at most 2,000 characters; empty for the fixture model. |
| `evidence` | At most 20 items: `url` (https, at most 2,048 characters), `status`, `since` (null for `NEW`; for `CHANGED`, the time of the previous successful check), `observedAt`, `fingerprint` (null only for an `UNREACHABLE` source that was never read), `snapshot` (the keccak256 of the archived bytes, or null) and `note` (at most 500 characters). |
| `detail` | The hash of a longer document in `/v1/content`, or null. |

Rules: a `carry_forward` note lists only `UNCHANGED` and `UNREACHABLE` items. When a reader counts evidence, it ignores an item whose `observedAt` is more than one day before the window's `openAt` or after the answer's `receivedAt`; the answer still counts as analysed. The builder keeps a note within 64 KiB by dropping `UNCHANGED` items first, then `UNREACHABLE`, then `NEW`, then shortening item notes and the summary; it never drops a `CHANGED` item, and a note built for at most 20 watched URLs always fits. A changed source is archived only when its media type is one of the five that `/v1/content` accepts (`application/json`, `text/plain`, `text/csv`, `text/html`, `application/pdf`) and it is at most 1 MiB; otherwise its item has `snapshot: null`, and the agent logs `snapshot_skipped`. A snapshot that never resolves is shown as "snapshot not available" and never makes a note unreadable.

The signed `Forecast` type, its EIP-712 domain and the submission body are unchanged. A test pins the type string and the digest of one fixed message.

## Freshness

Freshness is measured in windows first and in time second, from two separate facts:

- **How recently did anyone forecast?** Measured with the platform's clock: the deadline of the latest closed window that has at least one answer. `ageSeconds`, `windowsBehind` and `level` rest on it.
- **How recently was evidence looked at, and how recently did it change?** `analysedAt` and `evidenceChangedAt` rest on what forecasters wrote in their notes, so they are claims.

`computeFreshness(windows, asOf)` returns `CURRENT` when the latest closed window has an answer (0 windows behind), `AGING` at 1 or 2 windows behind, `STALE` at 3 or more, and `NONE` when no closed window has one. On a daily market, 2 windows means about 2 days. Freshness is defined for `OPEN` markets only: after the close no window opens, so a closed market shows its last window as a date and no level. `evidenceChangedAt` comes from analysis notes only.

`getMarketFreshness(client, marketId, options?)` in `@blink/client` composes the public routes (`getDeployment`, `listForecastWindows`, `getConsensus`, `listForecasts`, `getContent`). It keeps the latest 30 closed windows, lists the answers of each, ignores withdrawn ones, and fetches at most 20 notes per window, 8 at a time. A note counts only if it parses and `noteBelongsTo` accepts it; any other answer counts as an answer without a note. Only a 404 from the store or a hash mismatch counts as a missing note: any other content-route failure throws, and a retry with the same `cache` fetches only what is missing. The reader is a function, not a client method, so the client's method count stays at 36.

## The website

The market page shows, for an open market, a freshness line in the consensus card (the level, the latest window, the windows behind, "N of M answers reported a new analysis", "K sources changed (reported)"), a "What changed" section between the chart and "How it resolves" (each change with its source host, "changed between X and Y (UTC)", one summary, each forecaster's move and the snapshot hash as text), and chart markers for windows with a changed source and for windows where every answer was carried forward. The analysed count and the changed sources are marked as reported by the forecasters. The site is a static export and makes no API calls, so these views run on labelled sample markets through the same `computeFreshness` that a live reader uses; "Sample data" is shown next to them, and nothing links to a snapshot. The agent docs (`forecaster.md`, `agents.md`, `client.md`) describe the pattern as built.

## Answers to the open questions

The user decided OQ1 to OQ15 on 2026-11-24, all as recommended: option (a) each.

| Question | Decision as built |
| --- | --- |
| OQ1 Where is "what changed" recorded? | In a note document that the existing `contentHash` names. No change to the signed type. |
| OQ2 Does the platform check the note? | No. Readers validate. |
| OQ3 A window with no news? | Carry forward: sign the earlier probability again. |
| OQ4 When in the window? | As soon as the window opens (the next tick that sees it). |
| OQ5 The heartbeat? | A fixed limit, default 14 days, set with `BLINK_FORECAST_HEARTBEAT_HOURS`. |
| OQ6 How deep is the cheap check? | A conditional read plus a normalised-text fingerprint, with no model call. |
| OQ7 Archive the page? | The raw bytes of a changed source, for the five media types and up to 1 MiB, only in windows where an analysis ran. |
| OQ8 Freshness thresholds? | Windows first: `CURRENT` at 0 behind, `AGING` at 1 or 2, `STALE` at 3 or more. |
| OQ9 What does the market page read? | Sample data through an adapter that a live reader can replace. |
| OQ10 Where is freshness computed? | In `@blink/client`, from the existing routes. No API route was added. |
| OQ11 Where does the fetcher's address guard live? | In `examples/agents/src/lib/fetcher.ts`, with its own copy of the rules and a test that compares them with the platform's. |
| OQ12 May the reference process fetch from the network? | No. `main.ts` builds `fixtureFetcher`; `httpsFetcher` is for operators who embed the code. |
| OQ13 When are the note and snapshots uploaded? | The salted note before the submit; the snapshots after the deadline. |
| OQ14 What does a carry forward sign? | The same number. |
| OQ15 Per market only, or per forecaster? | Per market and per window. |

## Counts

The saving is counted in analyses, not in currency. The reference numbers come from a simulation in `tests/agents-forecaster-events.test.ts`, not from a measurement of real model spend:

| Case (91 windows, one source that changes 4 times) | Analyses | Share of today's 91 | Signatures | Fetches |
| --- | --- | --- | --- | --- |
| Heartbeat 14 days | 8 (1 cold start, 4 changes, 3 heartbeats) | 8.8% | 91 | 91 |
| No heartbeat | 5 | 5.5% | 91 | 91 |
| Heartbeat 7 days | 15 | 16.5% | 91 | 91 |

Each analysis is assumed to cost the same. A source that changes more often, or a noisy page, raises the count; the heartbeat bounds it from below.

The reader's request count, worked from the design and not measured: for one market read cold, with 30 windows and 5 forecasters, 1 `getDeployment`, about 2 requests to page the windows and the consensus, 30 `listForecasts` and 150 `getContent`, about 183 in all, and about 633 at the cap of 20 notes per window. Notes never change, so a reader that caches them by hash pays about 3 plus the new answers afterwards. A list of markets sorted by freshness would need one such composition per market, so the `/markets` ledger shows no freshness.

## Bounds per tick

`runAgent` runs one tick at a time, so one forecaster tick holds up every other role of the process. The forecaster bounds its work:

| Bound | Value |
| --- | --- |
| Markets that get real work per tick (a fresh check, a model call or the resubmit of a saved intent) | 2. The next tick starts with the market that was out of budget. |
| Model attempts per window | 3, at least 10 seconds apart |
| Snapshot uploads per tick | 20 objects or 8 MiB, one upload per hash; the next tick starts with the market where the allowance ran out |
| A failing snapshot upload is retried | at most once in 60 seconds, and given up 24 hours after the deadline |
| Markets that left `OPEN` and are forgotten per tick | 2 |
| An idle market is listed again | after at most 30 seconds (platform times are trusted only within that horizon), at least 5 seconds apart |
| Pages of `OPEN` markets read per tick | 10 |
| Pages of windows read per market per tick | 2 |
| Watch list | 20 URLs, the spec's `sources` first |
| Source reads at once | 5, with a 10 second deadline for each read and a 4 MiB body |
| A note | 20 evidence items, 64 KiB |

## Operating `httpsFetcher`

The reference process never uses it. An operator who embeds the agent code and passes `httpsFetcher` should know:

- **Address checks.** It judges the URL before any lookup, judges every address the name resolves to before any connection, connects to the address it judged, checks that the socket ended there, and judges every redirect again (at most 3). It refuses a scheme other than https, userinfo, a port other than 443 and an IP literal. It sends no `User-Agent` and no cookie. Validators (`ETag`, `Last-Modified`) go only to the final URL they were saved for.
- **Proxies.** It never uses a proxy. It throws `PROXY_CONFIGURED` when it is built while any of `HTTPS_PROXY`, `https_proxy`, `HTTP_PROXY`, `http_proxy` or `NODE_USE_ENV_PROXY` is set, because a proxy resolves the name itself and would defeat the address check. `direct: true` states that the direct connection is intended.
- **Name resolution.** The default resolver is c-ares, which can be cancelled and cannot exhaust the thread pool. It reads no `/etc/hosts` and applies no search domains, so a name that only a hosts file or a search domain knows is not found.
- **Containers.** An address inside a subnet of one of the machine's own interfaces is refused. Inside a container those are the container's interfaces, so the host's subnets, and any private network numbered from public space, go in `extraBlockedRanges`.
- **NAT64.** On an IPv6-only network whose NAT64 uses a network-specific prefix, `<prefix>::<private IPv4>` passes the checks, so that prefix's forms of the private ranges go in `extraBlockedRanges` (for a /96 prefix, `<prefix>::10.0.0.0/104` covers 10.0.0.0/8).
- **IPv4 ranges.** To block every form of an IPv4 address, write the IPv4 range: it covers the IPv4-mapped, NAT64 and IPv4-compatible forms. A range written as `::ffff:a.b.c.d/n` is read as the IPv4 range it maps to, but NAT64 and IPv4-compatible ranges stay IPv6.
- **Encodings.** The request asks for `identity`. `gzip` and `deflate` are decoded under the 4 MiB cap, and `br` is refused (`UNSUPPORTED_ENCODING`).
- **Untrusted text.** A page can contain text written to steer a model (prompt injection), and anyone can write a market's `sources`. An operator who passes fetched text to a model must treat it as data.
- **Linkability.** See the last two limits below.

## Known limits

From the design:

- **It lowers cost and adds no revenue.** The protocol pays a forecaster nothing.
- **Others can copy the last revealed consensus.** Answers become public at each deadline, so a cheap agent can sign the previous window's consensus every day and look like a forecaster. The note's `kind` is self-reported, so the freshness view says "someone answered", not "someone checked". A payment that rewards only improvement over the earlier consensus is direction 3 and is not built.
- **A daily cadence.** News after a window closes reaches the consensus at the next window, up to about a day later.
- **A carry forward is biased on deadline questions.** It signs the same number. For a question that resolves on an event by a date, the honest probability falls as days pass with no event, and a carried number does not, for up to the heartbeat.
- **Credit counts rows.** Carried answers are scored like any other, so an agent that answers every window fills its latest-50 credit with one market. This is the existing rule.
- **A source that cannot be fetched** (login walls, pages that scripts build in the browser, rate limits) looks `UNREACHABLE` or constant. The agent then relies on its heartbeat. A page that rewrites its text on every load looks changed in every window.
- **Notes can lie.** An `analysis` note can claim evidence it did not read. Only the snapshot hash and the signed values can be checked.
- **A source can link its readers to the operator.** A page that carries a per-request token puts that token into the fingerprint and into the archived snapshot, which are public once an answer is revealed.
- **Validators identify the agent.** The validators the fetcher replays (`ETag`, `Last-Modified`) let a server recognise the same agent across windows and across changes of its IP address. No header names the operator or the software, but the connection's source address is the operator's. Unlinkability needs a tunnel or an egress address around the whole process, which the example cannot provide.
- **Fetched text is untrusted input** (prompt injection); see above.
- **Snapshots reveal something after the deadline** only in the way every answer does: they are public once uploaded.

Task 2, the fetcher:

- The pinning check (the socket must end at the judged address) runs after the connection is made. If another library patches the agent, the TCP connection and the TLS ClientHello can reach another address before the request is destroyed; no HTTP request is sent. It is a backstop, and the refusal to be built under a proxy variable is the front line.
- The check yields to the event loop between sources, but it does not run another role's tick: the other roles wait for the whole check.

Task 3, the forecaster:

- One agent per state directory is the supported setup, and the directory itself is not flushed.
- Idle state is in memory, so a restart lists every market once.
- A long `PRE_CLOSE` window that sorts after a `DAILY` window can be picked up late, never missed.
- One intent is saved per market, so a kept sent intent can block an overlapping window of the same market until it is settled.
- A forward jump of the local clock can make a snapshot give up before the 24 hours have passed.
- A 401 or 403 loses that window, as any other final refusal does: the model has already been paid for it, and the next window runs again.
- A note is uploaded before the answer and a snapshot after the deadline. If the agent never comes back, the note names a snapshot hash that never resolves.

Task 4, the reader:

- It is meant for open markets; a closed market's last window reads as current.
- A window with more than 20 answers has `unfetched` answers, which are not counted as missing notes.

Task 5, the website:

- Sample data only. The site does not show a real market's freshness, the `/markets` ledger shows none, and the "What changed" section links to no snapshot because a static page cannot check one.

## Follow-ups outside this delivery

- **The platform's fetcher** (`packages/adapters/src/allowlist-fetcher.ts`) has gaps that the agent's fetcher avoids. The platform's allowlist limits the exposure, and nothing calls it today: its `br` decoder has the cost that the agent's fetcher avoids by refusing `br`; an internal host with a public-looking address is not caught; whoever wires its resolver must avoid `dns.lookup`, for the reasons above; and it misses NAT64 under a network-specific prefix.
- **The content store links a page to a suggestion.** It links an uploaded page that is a valid market spec naming a `suggestionId` to that suggestion (`packages/adapters/src/content-store.ts`). A fetched page that an agent archives could link itself to a suggestion. The platform is not changed here.
- **A separate list for intents kept for settlement**, so that a kept sent intent no longer blocks an overlapping window of its market.
- **Live data for the website** (a reader of the public API in the browser, which needs a deployed API and CORS headers) and **freshness on the market list**, which need an answer to OQ9 and OQ10 other than (a).
- **The LLM demo** keeps its tools: a watch tool for it is a later change.
- **The autonomous drill** keeps its five scenarios; its forecaster runs the new tick with the fixture fetcher.

## Verification

Run with the pinned Node and pnpm on the delivery tree. These are recorded runs, not a deployment:

| Command | Result |
| --- | --- |
| `node --import tsx --test tests/agent-docs-coverage.test.ts tests/web-docs-content.test.ts` | 26 of 26 passed |
| `pnpm check` | 880 tests passed, 0 failed; typechecks and package boundaries passed |
| `pnpm build` | passed |
| `pnpm build:pages && node scripts/check-pages-export.mjs` | passed (24 key files and 81 internal URLs in 266 exported files) |

Each task added its tests first and saw them fail before the change; the per-task counts are in the [progress record](D1_EVENT_DRIVEN_PROGRESS.md). The simulation of the counts above is in `tests/agents-forecaster-events.test.ts` (72 tests in the file at Task 3).

Not run locally, so they rely on their CI jobs after the push: `pnpm test:browsers` (including `docs.spec.ts`, `routes.spec.ts` and the Task 5 tests in `market-detail.spec.ts`), `pnpm test:contracts`, `pnpm test:anvil` (the case in `tests/anvil/agents-market-roles.test.ts` that expects `contentHash` to be the hash of a note first runs in CI), `pnpm test:contracts:seeds`, `pnpm alpha:local` and `pnpm test:postgres`. The autonomous drill runs only nightly on `main`: it is pending until a nightly run after the push passes. A change to an agent that the drill runs counts the drill as unverified until then.
