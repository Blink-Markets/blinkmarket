# External taker agent example

`run.ts` is a complete taker agent for the local Blink stack. It claims test bUSD, registers, joins the TAKER role, gets an API key by proving its wallet, posts an RFQ, verifies the quotes makers send back, approves exactly what the best one can cost, fills it on chain, waits for the market to be FINAL and redeems. It imports only `@blink/client` and `viem` (inside this repository the root `tsconfig.json` maps `@blink/client` to `packages/client`). Base Sepolia chain ID 84532 only, bUSD has no value, and nothing here is deployed anywhere.

The platform only relays RFQs and quotes. It never prices, signs or fills: the agent checks every quote itself and sends the fill itself.

## Run it

```sh
BLINK_API_URL=http://127.0.0.1:3001 \
AGENT_PRIVATE_KEY=<throwaway key for the local node> \
RPC_URL=http://127.0.0.1:8545 \
node --import tsx examples/agent/run.ts
```

| Variable | Meaning |
| --- | --- |
| `BLINK_API_URL` | The Blink API (HTTPS, or HTTP on loopback). |
| `AGENT_PRIVATE_KEY` | The agent's wallet. It pays gas and signs the wallet proof. The example refuses to run unless `RPC_URL` is on this machine. |
| `RPC_URL` | A local node (loopback host) on chain ID 84532. Any other chain is refused. |

No API key is configured: the agent obtains one by wallet proof once its registration is indexed. The stack it expects is the P2 one: the protocol generation deployed on the local node, the indexer, the API with the read routes and the RFQ relay, and at least one OPEN market with a maker that answers RFQs.

## What it does

1. Reads the current generation with `getDeployment()`. Everything after trusts this manifest and nothing a quote says about itself.
2. Claims the faucet if its balance does not cover the registration fee, the role stake and one full fill, then registers and joins TAKER with the minimum role stake (each step is skipped if it is already done).
3. Proves its wallet (`createWalletChallenge`, sign, `verifyWallet`). The API issues a key only after its index has seen the registration, so a refusal for that reason is retried with a fresh challenge.
4. Picks an OPEN market that has not closed (`listMarkets`, `getMarket`) and posts an RFQ for 10 YES shares (`createRfq`).
5. Lists the quotes (`listQuotes`, cheapest first) and runs `verifySignedQuote` on each one against the manifest, the market, the RFQ and the chain's block time. A quote that fails is ignored.
6. Approves `maxCost` (the taker cost plus the fee, as `approvalFor` computes it), re-verifies the quote with at least one second left, checks `consumed(digest)` and sends `fillQuote` once.
7. Waits until `getMarket` reports FINAL, calls `redeem` and reports the payout from the `PositionRedeemed` event.

## Safety rules it follows

- **Quotes expire by block time.** `verifySignedQuote` gets the latest block's timestamp, not the host clock, and wants 6 seconds left for the approval and the fill.
- **The signature is checked the way BlinkMarkets checks it.** A maker without code must give a canonical 65-byte ECDSA signature; a contract-wallet maker is asked through ERC-1271 on the node; an ERC-6492 wrapper is refused.
- **Exact approvals.** The allowance is `maxCost`, not a larger or unlimited amount.
- **A fill is never resent blindly, and an uncertain one is never replaced early.** If the answer to a fill is lost or its receipt does not come, the agent waits for the receipt, for `consumed(digest)`, or for chain time to pass the quote's expiry with the digest still unused. Only then may a new RFQ replace the quote (at most three times).
- **No key leaves the process.** The private key only signs the wallet proof and the agent's own transactions, and only a loopback node is ever contacted with it.

## Tests

`tests/anvil/client-agent.test.ts` runs this file unchanged against the real API, indexer and protocol contracts on a local Anvil, with a maker and a proposer driven by the test. `tests/client.test.ts` covers its refusals (a non-local node, the wrong chain, a missing variable).

## Scope

This is the only reference agent delivered by P2: a taker. The platform plays no role, and reference agents for the other roles (creator, maker, forecaster, proposer, challenger, juror, keeper) belong to P3. See [P2 off-chain protocol](../../docs/P2_OFFCHAIN_PROTOCOL.md).
