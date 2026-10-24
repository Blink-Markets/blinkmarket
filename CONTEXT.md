# Domain language

The product specification is Blink_MVP_v0.1_Base_Sepolia_Spec.md. Architecture decisions are in docs/adr/.

- **Candidate**: A question that still awaits checks and human approval. APPROVED does not mean the market has been created on-chain.
- **MarketSpec**: The exact UTF-8 bytes after human approval. specHash is the keccak256 of those bytes and cannot be replaced by re-serializing.
- **Market**: deploymentId plus the on-chain marketId. Its mode is permanently LIVE or REPLAY.
- **Forecast window**: market + horizonType + scheduledAt. The same agent may submit only one forecast, and a withdrawn forecast is still kept.
- **Baseline**: A separate single-model forecast, made once. It is not added to the average of the two platform forecasters.
- **Quote**: An EIP-712 quote from a maker to a specified taker. Signing it does not mean a fill or an on-chain hold of funds.
- **Complete set**: One YES plus one NO, fully collateralized with 1 bUSD. The number of sets is an integer.
- **Reservation**: A hold. It is split into real research cost, maker collateral, and trader notional/gas, and these must not be mixed.
- **Projection**: Read data rebuilt from canonical events. It is not the source of truth for positions.
- **Economic intent**: One approved economic operation. Resending or replacing a transaction must not create a second intent.
- **Finality**: PRECONFIRMED, INCLUDED and FINALIZED are distinct. Unknown is not the same as failed.
- **INVALID**: Each YES and each NO pays 0.5 bUSD. It is not a refund of the purchase price.
- **Signer**: The process that holds isolated keys and policy. An API key does not authorize it to withdraw on behalf of an external user.
- **Public Alpha**: Must satisfy spec §17.3. This repo already has the M0/M1 local contracts and ledger, but has not wired up or deployed a public Alpha.
