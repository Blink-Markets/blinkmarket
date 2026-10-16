# M5 demo script — Task A8 delivery

中文摘要：依規格 §19 撰寫三分鐘展示分鏡，全程在本地 Alpha（pnpm alpha:local 與範例代理）上執行；歷史資料一律標示 REPLAY，不宣稱部署、真實市場或收益，錄影由使用者負責。

A 3-minute storyboard for the Blink Market demo video, following spec §19 (30 s problem, 60 s data to forecast, 60 s RFQ trade and rights, 30 s REPLAY result and next steps). Everything shown runs on the local Alpha stack. Recording and publishing are the user's (decision D10); this document does not record, deploy or publish anything.

## Ground rules for the video

- **Say only what exists.** The API and contracts are implemented and verified locally. Nothing is deployed to Base Sepolia, there is no public API host, no live market, no paid model provider, and no external user has used it. Do not say "live", "deployed", "launched" or "public beta".
- **Label history.** Every market, forecast, price and result on screen comes from REPLAY fixtures (a fictional entity, `fixture-company-not-real`, and a deterministic fixture model). Keep a persistent on-screen tag, "REPLAY - historical fixture data, not a live market", for the whole video, and say it aloud in scenes 2 and 4.
- **Test assets only.** bUSD is a test token with no value. The chain is a local Anvil with chain ID 84532, the Base Sepolia chain ID; it is not the public testnet.
- **No claims of profit, autonomous decentralized adjudication, or beating humans or single models** (spec §19). Do not show or quote the REPLAY Brier score as evidence of skill: it comes from three fixture markets.
- **Trusted roles.** Resolution is proposed by a human, with challenge and arbitration roles that are trusted in v0.1. Say so in scene 3.
- **Show no secrets.** Use only the harness's throwaway local keys and the public development mnemonic. Do not show a real wallet, RPC URL or API key.

## Preparation (off camera)

1. A local PostgreSQL with a dedicated administrator (see `docs/M5_LOCAL_ALPHA.md`), then `pnpm install --frozen-lockfile` and `pnpm check:contracts` (generates the contract artifacts the harness needs).
2. Dry run the exact command you will film:
   `TEST_POSTGRES_ADMIN_URL=<local admin URL> node --import tsx scripts/local-alpha.ts`.
   Use this entrypoint, not `pnpm alpha:local`: `pnpm alpha:local` runs the test file, which prints only a wall time and test results, while the entrypoint prints the stage lines and the JSON report. A measured run on this branch (2026-10-17, local PostgreSQL) took 27 s wall time from the shell (`wallTimeMs` 25552 in its report). Film it live or sped up; do not call it instant.
3. Optional, for the website shots: `pnpm --filter @blink/web dev` (the read-only explainer, whose markets are fictional REPLAY samples). Confirm its REPLAY labels are visible before recording.
4. Terminal font large, window about 100 columns, dark theme. Capture the terminal, the editor and the browser as separate clips.
5. Do not edit the harness for the video. The harness prints only what is quoted in "What the harness prints" below; everything else on screen is a file you open, and everything else in the narration is narration.

## What the harness prints (measured)

```
ALPHA stage: setup
ALPHA scenario normal
ALPHA stage: scenario normal
ALPHA stage: scenario normal: external agent
ALPHA stage: scenario normal: settlement
PASS ALPHA normal YES payouts=10000000/0
ALPHA scenario dispute
...
PASS ALPHA dispute NO payouts=0/10000000
...
PASS ALPHA timeout INVALID payouts=5000000/5000000
ALPHA stage: restore drill: rebuild
ALPHA stage: restore drill: drop and re-index
{ "scenarios": [ { "scenario": "normal", "outcome": "YES", "takerPayoutMicros": "10000000", "makerPayoutMicros": "0" }, ... ],
  "rebuildVerified": true, "reindexIdentical": true, "liveRows": 0, "wallTimeMs": 25552 }
```

(The JSON is printed pretty, one field per line; the dispute and timeout entries are elided above.) The example agent's own output is collected in memory and shown only if the agent fails, so its steps are never on screen in a successful run. Forecast records, prompt hashes and evidence import lines are not printed either.

## Storyboard (3:00)

Source key: **[run]** is output of the command above. **[file]** is a file opened on camera, at the path named. **[narration]** is spoken over a title card or the previous shot, with no claim that it appears on screen.

### Scene 1, 0:00-0:30. The problem and who it is for

| On screen | Narration |
| --- | --- |
| [file] Title card, then `README.md`: the opening description and the "How it works" list (five steps: define, collect, quote and trade, resolve and redeem, index and evaluate). | "Forecasts about company numbers are usually opinions in a chat. Blink turns one question into a market with fixed rules, a traceable forecast and a settlement you can check. The users are AI agents and the people who run them." |
| [file] `fixtures/replay/market-spec.json`, the template the harness builds each scenario's market from: comparator `LT`, `thresholdBps` 7000, `missingValueOutcome: INVALID`, `fundingType`. Overlay the REPLAY tag. (Its own dates are expired; the harness derives relative dates from it, so do not read the dates aloud.) | "Each question is a frozen spec: one metric, one threshold, named sources, deadlines, and what happens if the number never appears. This template is a fictional company's gross margin, from a REPLAY fixture. It is not a real market." |
| [narration] Overlay text: "Local test stack. Nothing deployed. Test assets have no value." | "Everything you will see runs on one laptop. Nothing is deployed, and the token has no value." |

### Scene 2, 0:30-1:30. From new data to a forecast

Start `node --import tsx scripts/local-alpha.ts` here (or play its recording). Only the lines under "What the harness prints" appear; the rest is a file or narration.

| Time | On screen | Narration |
| --- | --- | --- |
| 0:30-0:45 | [run] `ALPHA stage: setup`, `ALPHA scenario normal`, `ALPHA stage: scenario normal`. | "Each scenario starts the same way. Evidence is imported and reviewed first, offline in this demo, and the agents may only use sources on the market's allowlist. [narration: these steps run inside the stage and are not printed.]" |
| 0:45-1:00 | [file] The "Exercised flow" section of `docs/M5_LOCAL_ALPHA.md`, the paragraph on candidate, approval and creation. | "A discovery agent proposes a structured candidate, never free text. A human approves it, and only then is the market created on chain." |
| 1:00-1:20 | [file] Same document, the paragraph that starts "The normal window scheduler creates windows". | "While the window is open, platform forecasters and a baseline submit forecasts through the same public API an outside agent uses. The model here is a deterministic fixture: no paid provider, repeatable output. When the window closes, the forecasts are locked into an ensemble snapshot." |
| 1:20-1:30 | [run] `ALPHA stage: scenario normal: external agent` scrolls past. | "Each forecast is stored with who made it, which model and prompt, and when. That is what makes it traceable. This is REPLAY data, so it says nothing about live skill. [narration: the stored record is not shown.]" |

### Scene 3, 1:30-2:30. RFQ trade and rights

The harness does not show the agent's steps (they are captured and hidden on success), and its stack is torn down when it exits, so there is no live agent shot from this run. Use the source file and the README instead.

| Time | On screen | Narration |
| --- | --- | --- |
| 1:30-1:45 | [file] `examples/agent/README.md`, "What it does", steps 1-2 and 5 highlighted. | "An outside agent binds its own wallet, then claims test bUSD from the faucet. Its private key never leaves its process." |
| 1:45-2:05 | [file] Same list, step 6, and the "Safety rules" bullet on block-time expiry. | "It asks the platform's maker for a quote on 10 YES shares. The quote is signed, and the agent verifies the signature, the terms and the expiry against the chain's clock before it trusts anything." |
| 2:05-2:20 | [file] Same list, step 7, then [run] `ALPHA stage: scenario normal: settlement` and `PASS ALPHA normal YES payouts=10000000/0`. | "It approves exactly the quote's cost, not an unlimited amount, and sends the trade straight to the contract. The platform never holds the agent's funds. In the harness run the agent then redeems, and the harness checks its payout against the contract." |
| 2:20-2:30 | [file] The scenario table in `docs/M5_LOCAL_ALPHA.md` (10 shares, amounts in micros). Overlay "No early exit in v0.1". | "Rights are fixed at the start. The 10 shares pay 10 bUSD to the taker if the answer is YES and to the maker if NO. If the question is INVALID, each side gets half a bUSD per share, 5 bUSD each. There is no early exit: you hold until the market resolves. Resolution roles are trusted in this version." |

Optional extra, not part of the harness run: a separate local stack started by hand as described in `docs/M2_RFQ.md` and `docs/M3_KEEPER_FAUCET.md`, with the example agent run against it (`examples/agent/README.md`, "Run it"), would show the agent's own log. Only film it if you have run it and seen the output.

### Scene 4, 2:30-3:00. The REPLAY result and next steps

| Time | On screen | Narration |
| --- | --- | --- |
| 2:30-2:45 | [run] The three lines `PASS ALPHA normal YES payouts=10000000/0`, `PASS ALPHA dispute NO payouts=0/10000000`, `PASS ALPHA timeout INVALID payouts=5000000/5000000`, then the JSON `scenarios` list. | "The harness settles three REPLAY paths. Normal: YES after the challenge period, the keeper finalizes, the agent redeems 10 bUSD. Dispute: challenged, then decided NO. Timeout: no proposal, so INVALID, and each side gets 5 bUSD. All three are fixtures." |
| 2:45-2:55 | [run] `ALPHA stage: restore drill: rebuild`, `ALPHA stage: restore drill: drop and re-index`, and the JSON `rebuildVerified: true`, `reindexIdentical: true`, `liveRows: 0`. Overlay: "Local verification only". | "It also rebuilds the chain index from stored events, drops it and indexes again, and both match. LIVE rows stay at zero. This proves the flow works locally. It does not prove public-network finality, or that anyone would use it." |
| 2:55-3:00 | [narration] End card: "Next: a restricted Base Sepolia preview, invited agents, feedback". Feedback prompts per spec §19: your role, the question you want to forecast, your current alternative, whether you would use it again, what blocked your agent. | "Next is a small invited preview on Base Sepolia testnet, and we want to know what blocked your agent. Nothing is deployed yet." |

Closing tag text must match what is true on the day. If a deployment exists by recording time, this script is out of date: re-read it against the README and site before recording.

## Facts to check against the repo before recording

| Claim in the script | Where it comes from |
| --- | --- |
| Three scenarios, outcomes YES, NO, INVALID and the payouts | `docs/M5_LOCAL_ALPHA.md`, "Exercised flow" table |
| Agent steps (bind, faucet, quote, verify, exact approval, fill, track, redeem); shown as a file, not run output | `examples/agent/README.md`, "What it does" |
| 10 YES shares, loopback RPC, chain ID 84532 only | `examples/agent/README.md` |
| INVALID pays 0.5 bUSD per share to each side; no early exit; trusted resolution roles | README (example and limits), `docs/M5_LOCAL_ALPHA.md` |
| Fictional entity, `INVALID` for a missing value, 7000 bps | `fixtures/replay/market-spec.json` |
| Nothing deployed, no public API, no paid provider | README status paragraph |
| What to ask for in feedback | spec §19 |

## Known limits of this script

- It is a storyboard, not a recording. Timings are targets; the harness log is the source for exact stage names, which may be edited for the video only by cutting, never by altering output.
- The narration has not been timed aloud (about 400 words): time it before recording.
- The harness does not start a web UI. The website is read-only and shows fictional REPLAY samples, so trades and positions appear only in the terminal and API output.
- Real LIVE sources, a deployed API, external operators and recorded feedback are not covered here (plan items B1-B7 and D10).

## Verification

| Command | Result |
| --- | --- |
| `pnpm check` | PASS: 619 tests, no skips; typechecks, contract compilation and boundaries (docs-only change; build, service-build, anvil and postgres suites not rerun) |
| `node --import tsx scripts/local-alpha.ts` | PASS, exit 0, 27 s from the shell, `wallTimeMs` 25552; output quoted above |
