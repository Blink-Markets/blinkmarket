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

1. A local PostgreSQL with a dedicated administrator (see `docs/M5_LOCAL_ALPHA.md`), then `pnpm install --frozen-lockfile`.
2. Dry run: `TEST_POSTGRES_ADMIN_URL=<local admin URL> pnpm alpha:local`. It must pass before recording. It prints each stage (`ALPHA stage: ...`) and a JSON report; the run takes about 15 s end to end.
3. Optional, for the website shots: `pnpm --filter @blink/web dev` (the read-only explainer, whose markets are fictional REPLAY samples). Confirm its REPLAY labels are visible before recording.
4. Terminal font large, window about 100 columns, dark theme. Capture the terminal and the browser as separate clips.
5. Do not edit the harness for the video. If a closer look at a stage is needed, read the existing stage names from the log instead.

## Storyboard (3:00)

### Scene 1, 0:00-0:30. The problem and who it is for

| On screen | Narration |
| --- | --- |
| Title card: "Blink Market - agent-run forecasting markets (local Alpha)". Then the README's one-sentence description and the 4-step flow (evidence, forecast, RFQ trade, resolve and redeem). | "Forecasts about company numbers are usually opinions in a chat. Blink turns one question into a market with fixed rules, a traceable forecast and a settlement you can check. The users are AI agents and the people who run them." |
| The market spec (`fixtures/replay/market-spec.json`): comparator, threshold 7000 bps, dates, `missingValueOutcome: INVALID`. Overlay the REPLAY tag. | "Each question is a frozen spec: one metric, one threshold, named sources, deadlines, and what happens if the number never appears. This one is a fictional company's gross margin, from a REPLAY fixture. It is not a real market." |
| Overlay text: "Local test stack. Nothing deployed. Test assets have no value." | "Everything you will see runs on one laptop. Nothing is deployed, and the token has no value." |

### Scene 2, 0:30-1:30. From new data to a forecast

Run `pnpm alpha:local` (or play the recorded run) and cut between its stages.

| Time | On screen | Narration |
| --- | --- | --- |
| 0:30-0:45 | Log lines for the scenario's early stages. Show the reviewed offline evidence being imported (`evidence-admin`). | "Evidence is imported and reviewed first, offline in this demo. The agent may only use sources on the market's allowlist." |
| 0:45-1:00 | The discovery agent's structured candidate submitted through the API, then the admin approval and the creation transaction on the local chain. | "A discovery agent proposes a structured candidate, never free text. A human approves it, and only then is the market created on chain." |
| 1:00-1:20 | The forecast window opening; two platform forecasters and a baseline forecast through their own API keys, using the deterministic fixture gateway. Then the window closing and the ensemble snapshot. | "While the window is open, platform agents submit forecasts through the same public API an outside agent uses. Here the model is a deterministic fixture, so there is no paid provider and the output is repeatable. When the window closes, the forecasts are locked into an ensemble snapshot." |
| 1:20-1:30 | A forecast record with its model, prompt hash and time. | "Each forecast keeps who made it, with which model and prompt, and when. That is what makes it traceable. This is REPLAY data, so it says nothing about live skill." |

### Scene 3, 1:30-2:30. RFQ trade and rights

Run the example agent against the stack the harness starts (`examples/agent/README.md`); the harness runs it for every scenario, so the clip comes from the same run.

| Time | On screen | Narration |
| --- | --- | --- |
| 1:30-1:45 | The agent binding its wallet (challenge, signature, verify) and claiming the faucet. | "An outside agent binds its own wallet, then claims test bUSD from the faucet. Its private key never leaves its process." |
| 1:45-2:05 | The agent requesting a quote for 10 YES shares, then `verifySignedQuote` passing. Highlight: it checks the config, its wallet, the request and the chain's block time. | "It asks the platform's maker for a quote. The quote is signed, and the agent verifies the signature, the terms and the expiry against the chain's clock before it trusts anything." |
| 2:05-2:20 | The exact approval of the quote's cost, then the fill transaction, then the position appearing through the API. | "It approves exactly the quote's cost, not an unlimited amount, and sends the trade straight to the contract. The platform never holds the agent's funds. The indexer then shows the position." |
| 2:20-2:30 | The payout table from `docs/M5_LOCAL_ALPHA.md` or the README example, with the 10-share numbers. Overlay "No early exit in v0.1". | "Rights are fixed at the start. The 10 shares pay 10 bUSD if the answer is YES, nothing if NO, and half of each side's stake if the question is INVALID. There is no early exit: you hold until the market resolves. Resolution roles are trusted in this version." |

### Scene 4, 2:30-3:00. The REPLAY result and next steps

| Time | On screen | Narration |
| --- | --- | --- |
| 2:30-2:45 | The harness report for the three scenarios: normal (YES), dispute (NO after arbiter decision) and timeout (INVALID, 5,000,000 micros each side). Show the agent redeeming and its payout asserted against the contract. | "The harness settles three REPLAY paths. Normal: YES after the challenge period, the keeper finalizes, the agent redeems 10 bUSD. Dispute: challenged, then decided NO. Timeout: no proposal, so INVALID, and each side gets half. All three are fixtures." |
| 2:45-2:55 | The final log lines: restore drills passed, no leftover Anvil or database. Overlay: "Local verification only". | "It also rebuilds the chain index from stored events and checks it matches. This proves the flow works locally. It does not prove public-network finality, or that anyone would use it." |
| 2:55-3:00 | End card: "Next: a restricted Base Sepolia preview, invited agents, feedback". Feedback prompts per spec §19: your role, the question you want to forecast, your current alternative, whether you would use it again, what blocked your agent. | "Next is a small invited preview on Base Sepolia testnet, and we want to know what blocked your agent. Nothing is deployed yet." |

Closing tag text must match what is true on the day. If a deployment exists by recording time, this script is out of date: re-read it against the README and site before recording.

## Facts to check against the repo before recording

| Claim in the script | Where it comes from |
| --- | --- |
| Three scenarios, outcomes YES, NO, INVALID and the payouts | `docs/M5_LOCAL_ALPHA.md`, "Exercised flow" table |
| Agent steps (bind, faucet, quote, verify, exact approval, fill, track, redeem) | `examples/agent/README.md`, "What it does" |
| 10 YES shares, loopback RPC, chain ID 84532 only | `examples/agent/README.md` |
| INVALID pays half to each side; no early exit; trusted resolution roles | README (example and limits), `docs/M5_LOCAL_ALPHA.md` |
| Fictional entity, `INVALID` for a missing value, 7000 bps | `fixtures/replay/market-spec.json` |
| Nothing deployed, no public API, no paid provider | README status paragraph |
| What to ask for in feedback | spec §19 |

## Known limits of this script

- It is a storyboard, not a recording. Timings are targets; the harness log is the source for exact stage names, which may be edited for the video only by cutting, never by altering output.
- The harness does not start a web UI. The website is read-only and shows fictional REPLAY samples, so trades and positions appear only in the terminal and API output.
- Real LIVE sources, a deployed API, external operators and recorded feedback are not covered here (plan items B1-B7 and D10).

## Verification

| Command | Result |
| --- | --- |
| `pnpm check` | PASS: 619 tests, no skips; typechecks, contract compilation and boundaries (docs-only change; build, service-build, anvil and postgres suites not rerun) |
