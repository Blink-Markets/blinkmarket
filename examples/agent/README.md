# External agent example

`run.ts` is a complete external agent for the local Blink stack: it binds a wallet, forecasts, claims test bUSD, buys YES shares with a verified quote, waits for the market to be FINAL and redeems. It uses only the public API through `@blink/client` and its own wallet through viem. Base Sepolia chain ID 84532 only, bUSD has no value, and nothing here is deployed anywhere.

## Run it

```sh
BLINK_API_URL=http://127.0.0.1:3001 \
BLINK_API_KEY=<invited key> \
AGENT_PRIVATE_KEY=<throwaway key for the local node> \
RPC_URL=http://127.0.0.1:8545 \
node --import tsx examples/agent/run.ts
```

| Variable | Meaning |
| --- | --- |
| `BLINK_API_URL` | The Blink API (HTTPS, or HTTP on loopback). |
| `BLINK_API_KEY` | An invited key with `forecast:write`, `trade:quote` and `faucet:claim`. |
| `AGENT_PRIVATE_KEY` | The wallet that is bound to the key and pays gas. The example refuses to run unless `RPC_URL` is on this machine. |
| `RPC_URL` | A local node (loopback host) on chain ID 84532. Any other chain is refused. |

The stack it expects is the one `docs/M2_RFQ.md` (runtime) and `docs/M3_KEEPER_FAUCET.md` describe: the API in trading mode with an indexed, trading-enabled deployment and one OPEN market, the signer, the indexer (with transaction tracking), the worker (faucet and keeper jobs), a funded maker, and the wallet allow-listed on the market contract. The market must have a recent ensemble forecast, or the quote is refused with `STALE_FORECAST`. The agent's gas comes from the local node's own funded accounts.

## What it does

1. Reads `getConfig()`. Everything after trusts this deployment and nothing a quote says about itself.
2. Binds the wallet (`createWalletChallenge`, sign, `verifyWallet`); an already bound agent is fine.
3. Picks an OPEN market with `canTrade`, and checks its spec bytes against the listed `specHash` (`getMarketSpec`).
4. Submits one forecast in the open window, if there is one (a fixed probability, to show the call).
5. Claims the faucet and waits for the bUSD to arrive, unless the balance already covers the purchase.
6. Requests a quote for 10 YES shares, then runs `verifySignedQuote` against the config, the wallet, the request and the chain's own block time.
7. Approves exactly the quote's taker cost, then re-reads `consumed(digest)` and re-verifies at the current chain time before it sends the quote's calldata once.
8. Calls `trackTransaction`, polls `getTransaction` and `getPositions` until the fill is indexed, then waits for the market to be FINAL and redeems.

## Safety rules it follows

- **Quotes expire by block time.** `verifySignedQuote` gets the latest block's timestamp, not the host clock. An expired quote, however it is noticed (verification, an API refusal, a fill that would revert), is replaced by a new request under a **new** Idempotency-Key, at most three times.
- **A fill is never retried blindly.** `consumed(digest)` is read before the fill. If the send's outcome is unknown (a lost answer, no receipt), the calldata is not sent again: the agent waits until `consumed(digest)` shows it landed or the quote expires, and only then moves on.
- **Retries reuse the key.** The client repeats a retryable answer with the same Idempotency-Key and body; a 503 `SERVICE_NOT_READY` while a quote is being signed resumes the same quote.
- **Exact approvals.** The allowance is the quote's taker cost, not a larger or unlimited amount.
- **No key leaves the process.** The private key only signs the binding message and the agent's own transactions.

## Tests

`tests/anvil/client-agent.test.ts` runs this file unchanged against the real API, signer, worker and indexer on a local Anvil: once with a quote that expires before it is filled (the requote), and once with a lost answer to the fill. `tests/client.test.ts` covers its refusals (a non-local node, the wrong chain).
