# Domain language

The approved design is `docs/superpowers/specs/2026-10-23-autonomous-market-design.md`. Contract terms are in `docs/P1_PROTOCOL_CONTRACTS.md`, and off-chain terms in `docs/P2_OFFCHAIN_PROTOCOL.md`. Architecture decisions are in `docs/adr/`.

## Current terms (P1 contracts, P2 off-chain)

**Identity and roles**

- **Identity**: A registered wallet address (an EOA or an ERC-1271 contract wallet). Registration pays a non-refundable fee. The platform never creates, funds or custodies a wallet. The protocol cannot tell whether an agent or a human is behind an identity.
- **Role**: One of CREATOR, MAKER, TAKER, FORECASTER, PROPOSER, CHALLENGER, JUROR. An identity takes a role by locking its minimum stake. The KEEPER needs no role. The platform plays no role.
- **Generation**: A registry, jurors, markets and resolution contract set deployed as one unit, with fixed parameters and no admin, pause or upgrade. A new generation imports the previous generation's identities and credit read-only. Governance can only adopt the next generation.
- **API key**: Obtained by proving control of a wallet with a signature, with no invitation. It carries scopes (`forecast:write`, `rfq:write`, `content:write`, `suggestion:claim`) and lasts 30 days. Writes that act for an identity also need the matching role in the indexed generation.
- **Credit**: Computed per role from finalized outcomes, bound to the identity, not transferable and decaying. It relaxes limits and thresholds but never pays money and never amplifies voting weight.

**Questions and markets**

- **Template**: A registered question template. An agent can register a new one; its first use gets a longer creation window.
- **Question class**: A (computable from archived source bytes), B (verifiable from public documents) or C (judgment). The class sets the bonds, windows and caps.
- **MarketSpec**: The exact UTF-8 bytes the Creator wrote. `specHash` is the keccak256 of those bytes and cannot be replaced by re-serializing. The bytes live in the content store, addressed by their hash, and anyone can mirror them.
- **Market**: A `marketId` inside one generation. States are PENDING, OPEN, PROPOSED, DISPUTED, FINAL and CANCELLED. A new market is PENDING while anyone may challenge its creation. REPLAY is a deployment-level flag, so only test and drill deployments have REPLAY markets, and its statistics stay apart from LIVE.
- **Human suggestion**: A public natural-language question idea that needs no identity. A Creator agent may claim it. It creates no on-chain right and earns no fee share.
- **Content hash**: The keccak256 of stored bytes. Evidence, specs and forecast rationales are addressed by it. The platform store is a convenience, and a proposal whose evidence bytes cannot be fetched from any mirror is unsupported.

**Trading**

- **RFQ**: A taker's request for a price on a market, side and quantity. It stays open 30 seconds, and several makers may answer. The platform relays it and prices nothing.
- **Quote**: An EIP-712 quote signed by a maker for one taker. Signing it is not a fill and holds no funds. The taker checks it with `verifySignedQuote` and fills it on chain.
- **Digest, epoch**: A quote's digest is UNUSED, CONSUMED or cancelled. A maker's epoch increase cancels all its older quotes.
- **Complete set**: One YES plus one NO, fully collateralized with 1 bUSD (`UNIT = 1_000_000`). The number of sets is an integer.
- **INVALID**: Each YES and each NO pays 0.5 bUSD. It is not a refund of the purchase price. A market becomes INVALID only by timeout at the hard deadline.
- **Fee**: Charged on the taker's payment and split among the treasury, creator, resolution, juror and bounty shares. Rounding dust goes to the treasury.

**Settlement**

- **Proposal**: A Proposer's result with an evidence hash and a bond. It stands unless challenged in its window.
- **Dispute, round, appeal**: A challenge goes to jurors by commit-reveal. A tie or missing quorum reopens the same level. An appeal doubles the bond, up to the maximum number of levels.
- **Juror**: A platform-token staker whose slashable stake is its voting weight. The final security assumption is an honest majority of the slashable stake inside the snapshot.
- **Keeper**: Anyone who calls a permissionless step (finalize, settle a vote, distribute fees). No privileged keeper exists.

**Off-chain read models**

- **Projection**: Read data rebuilt from canonical events. It is not the source of truth for funds.
- **Index health**: Stale when the indexed block's timestamp trails the chain head by more than 30 seconds. Identity-acting writes then fail with `503 INDEX_STALE`.
- **Finality**: PRECONFIRMED, INCLUDED and FINALIZED are distinct. Unknown is not the same as failed.
- **Forecast window**: A market plus a horizon (DAILY or PRE_CLOSE) plus `scheduledAt`. Each wallet submits at most one signed forecast.
- **Signed forecast, leaf, root, anchor**: A forecast is an EIP-712 `Forecast` struct signed by the forecaster. Its leaf joins a window's Merkle tree. The platform stores the root after the deadline, and any agent may anchor it on `BlinkAnchor`. The platform never signs or anchors.
- **Consensus**: A window's probability weighted by forecaster credit (`max(0, 0.25 - meanBrier)` over the latest 50 scored answers, and 0 below 5). It is a read model and affects no funds.
- **Maker stats**: Informational counts of quotes relayed, filled and cancelled early. They gate nothing.

## History (v0.1, team-operated design)

These terms belong to the provisional v0.1 design that P2 removed. They remain in the v0.1 delivery documents.

- **Candidate**: A question awaiting checks and human approval. APPROVED did not mean the market existed on chain.
- **Approval, creation intent**: The manual path from candidate to market, signed by a fixed ADMIN wallet.
- **Fixed roles**: `ADMIN`, `RESULT_PROPOSER`, `CHALLENGER`, `ARBITER` and `MAKER` addresses fixed in the constructor of `BlinkMarket`.
- **Platform forecasters, baseline**: Two platform models whose snapshot priced the maker's quotes, and a separate single-model baseline.
- **Reservation, economic intent**: Database holds on maker collateral, research cost and trader notional, and one approved economic operation.
- **Signer**: The process that held role keys and signing policy. It no longer exists.
- **Invitation**: The invite-only API key. Self-serve wallet identity replaced it.
- **Public Alpha**: Spec §17.3 of `Blink_MVP_v0.1_Base_Sepolia_Spec.md`. No public Alpha was deployed.
