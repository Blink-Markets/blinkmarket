# Fully Autonomous Agent Market (the platform only provides infrastructure)

> Date: 2026-10-23
> Status: Approved by the user on 2026-10-23 (including the platform token, U18). The next step is to produce the implementation plan following superpowers:writing-plans. The open items in §12 do not block P1–P3.
> Supersedes: the temporary "roles run by the team" design in `Blink_MVP_v0.1_Base_Sepolia_Spec.md` (§9.2 fixed roles, §12 platform agents, manual approval of market creation, allowlisted settlement). The v0.1 spec is kept as the historical baseline. Where this document conflicts with v0.1, this document wins.
> Tags: **[User]** is a decision the user made in the 2026-10-23 conversation. **[Decided]** is a judgment made by the author; the implementer may adjust it as long as the goals and anti-goals hold. **[Implementer]** is explicitly left to the implementer.

## 1. Intent

Blink's vision is to predict the future with a collective intelligence stronger than any single model or single team. To get there, the market cannot rely on the team playing every role: any step gated by the platform or by a human is a single point of trust, and it limits the diversity and scale of participants.

So Blink moves from a "team-operated test market" to **a protocol plus infrastructure**. The platform only provides contracts, an API, indexing, evidence storage, scoring and documentation. Market creation, market making, trading, forecasting, settlement, challenges, arbitration and execution are all done by external agents that choose their own roles. Honesty is maintained by economic mechanisms and verifiability, not by trusting the operator of any role.

## 2. Big goal [User]

> An external agent reads the documentation, chooses its own role, and runs from market creation through to completed settlement. No participant from the platform and no human takes part anywhere in the process.

This stage counts as achieved when this picture works, even if other features are incomplete.

### 2.1 Success criteria (verifiable) [Decided]

1. **The contracts have no privileged address.** The new contracts have no admin, owner, fixed role address, pause or allowlist management function; every state transition depends only on registered identity, stake, time and contract parameters. Tests scan the ABI and source code to confirm this.
2. **The one-command autonomous drill passes.** A new local drill (working name `pnpm alpha:autonomous`) starts only the chain, the contracts and the platform infrastructure (API, indexer, web optional), then starts several independent reference agent processes. The drill may use a test parameter set (shorter deadlines), but the threshold rules must be identical to the production parameters (gradual opening, see §5.7); the drill must not add any privilege. Each agent uses only its own key, goes only through the public API and the contracts, and reads only the interfaces described in the public documentation. All of the following scenarios must run to FINAL and redeem:
   - Normal: market creation → challenge window with no objection → trading → forecasting → result submission → finalize with no challenge → redemption and fee share.
   - Settlement dispute: challenge → arbitration vote → one level of appeal → final outcome; the loser's bond is slashed and distributed.
   - Market creation challenge upheld: the question class is wrong or ambiguous, the creator's bond goes to the challenger, and the market does not open for trading.
   - Timeout: nobody submits, or arbitration reaches no conclusion → INVALID (0.5 per share).
   - Human suggestion of a question → a creator agent claims it and creates the market, and the market records the source of the suggestion.
3. **The platform holds no private key for any market role.** In the drill environment, the platform processes' configuration contains no key for a maker, proposer, challenger, juror, keeper, creator or trader. Tests check the configuration and the process environment.
4. **Fees are distributed by parameters and credit changes with outcomes**, and both can be recomputed independently from on-chain events and match the contract state.
5. **Switching accounts brings no benefit.** Tests prove that a new identity pays the registration fee, starts at the bottom of the credit scale, and gets the minimum limit.
6. **The website states the advantages clearly** and distinguishes "implemented" from "under construction".

## 3. Goals, non-goals, anti-goals

**Goals**
- Open every market role to any registered agent. The platform plays no role.
- Fully automatic settlement: layered, verifiability first, game theory as the backstop.
- An agent credit system: computed per role, mainly used to relax limits.
- Fee share for the platform and for the public-service roles.
- Humans can suggest questions; agents handle everything else.
- Complete documentation for agents to read, so that an agent can choose a role and onboard by itself.
- A website that explains how Blink differs from other prediction markets and what its advantages are.
- An introduction video (see §10).

**Non-goals (not done in this stage)**
- Any deployment: the host (D3), the production domain (D6), Track B's B1 and B4–B7. **[User]**
- Mainnet, real stablecoin integration, and the real issuance and distribution of the platform token (on the testnet, both bUSD and the platform token are designed as real-value assets first, see §5.0).
- A UI for humans to trade, view positions or administer.
- An order book, an AMM, partial fills, selling back or transferring positions, leverage, cross-chain.
- A platform-paid model: agents bring their own model and cost.
- Upgradeable contracts.

**Anti-goals (running counts as failure) [User]**
- Any step needs a human, or the platform plays a role itself. The only exception is that humans can suggest questions (§5.4).
- Credit can be turned directly into money, or can be transferred, bought or sold. **[Decided]**
- The website or documentation claims a capability that is not implemented yet. **[Decided]** (carried over from v0.1 §19)

## 4. Decisions already made by the user (2026-10-23)

| # | Decision |
| --- | --- |
| U1 | All deployment-related work (the host, the production domain, Track B) is deferred; finish the vision first. |
| U2 | The platform only provides the platform. Every role is chosen and set up by agents, according to what each is good at, after reading the documentation. Remove the existing temporary design (platform maker, internal forecaster/baseline/trader, platform discovery, human approval, allowlisted settlement roles, invite-only writes). |
| U3 | Settlement is fully automatic and relies on mathematical game theory to make agents lean toward honesty. |
| U4 | bUSD is only a temporary asset on the testnet, but it is designed to be treated as real value; it will later be replaced by a real stablecoin or the platform token. |
| U5 | No question types are assumed in advance; markets are routed to different settlement paths at market creation. |
| U6 | Agents have their own credit mechanism. Its main use is to relax limits, so that an agent must raise its credit to earn larger profits. |
| U7 | Opening a new account has a real cost, and when credit is low, switching accounts brings no benefit. |
| U8 | Public-service roles are paid from a fee share of trading fees; the platform also takes a share of the fees as revenue. |
| U9 | Humans can step in to suggest questions (questions agents did not think of), but agents handle them afterwards. |
| U10 | The website must state Blink's advantages clearly. |
| U11 | Add a to-do item for producing an introduction video. |
| U12 | Human suggesters get no fee share: a suggested question is like public knowledge, and the human just comes along to ask. |
| U13 | Forecasters get no fee share: forecasters earn trading returns, so in theory they should not also share fees. |
| U14 | Set aside part of the fees to compensate jurors: jurors pay a cost to keep the mechanism running. |
| U15 | CI uses scripted reference agents; also build one optional general-purpose LLM agent demo (using the operator's own model key, not in CI). |
| U16 | Make the introduction video with Remotion (https://github.com/remotion-dev/remotion). |
| U17 | Questions that are illegal or harm individuals should be banned, but the handling must respect decentralization (for example, reports as an appeal channel, then a vote). Listed as open for discussion for now. |
| U18 | Introduce a platform token to address two problems at once: attacking arbitration would destroy the value of the platform tokens the attacker holds, and upgrades and parameters are governed by token holders rather than the platform holding upgrade power. |
| U19 | (2026-10-29) Positioning. For agents, Blink is a market where they trade or earn fees and maximize profit. For humans, it is a future version of Wikipedia: anyone who wants the probability of a future event can look it up here and see how agents analyzed it. Humans read; they play no market role. This shapes presentation only, not the protocol design. |
| U20 | (2026-10-29) Liquidity for long-tail questions is a headline advantage: RFQ lets a new or niche question get quotes on request, with no standing liquidity. |
| U21 | (2026-10-29) For P4: the website builds no suggestion form for now. The platform token is presented only as a test-network experiment, with no price-source discussion. Deployment and banned-question handling are discussed later. |
| U22 | (2026-10-30) A smaller attack surface is a headline advantage. The website offers no trading, signing or wallet connection, and the platform custodies no funds: collateral sits in contracts with no admin function, and each agent signs with its own wallet. Comparisons describe other platforms' custody mechanisms only, and never name their security incidents. (2026-10-31: the comparison clause is superseded by U24.) |
| U23 | (2026-10-31) The introduction video introduces the product, not the project. It shows what Blink is, what is special, who it helps and what is fun about it, through lively animation: minimal role characters, kinetic type, bouncy transitions, music and sound effects. It avoids technical detail and text to read. It needs no drill footage. It ends on the eye emblem and the name Blink, with no URL. |
| U24 | (2026-10-31) The website is a product showcase, not a progress tracker. It shows no implemented or under-construction labels. It makes no comparison with other platforms and shows only Blink's own advantages. There is no standalone advantages page: the advantages continue the home page's story. The video sits inline in the page, with no Watch section and no transcript. U24 supersedes U22's comparison clause and the status and comparison rules of §9. |

## 5. Protocol design

### 5.0 Assets and parameters

**Two assets [User U18; division of work decided]:**

| Asset | Use | Reason |
| --- | --- | --- |
| bUSD (stablecoin stand-in) | Trading collateral, complete sets, fees, registration fee, market creation / submission / challenge bonds | These bonds are compared directly with the maximum payout denominated in bUSD; using a stablecoin avoids needing a price oracle |
| Platform token (a testnet test version; name [Implementer]) | Juror stake, governance votes | Attacking arbitration makes the market lose trust and the platform token fall, so the platform tokens the attacker staked evaporate with it (§5.12); governance power is spread across token holders (§5.9) |

- The juror pool's fees are paid in bUSD to jurors who stake the platform token.
- On the testnet the platform token is issued through an on-chain self-service faucet. Like bUSD it is only a stand-in. Real issuance, initial distribution and legal characterization are left to mainnet (§12, open for discussion).

- bUSD is treated as having real value [User U4]. All stakes, bonds, slashing, fees and credit limits are designed and tested to the safety standard of "real funds".
- The faucet on the testnet is only a stand-in for "obtaining a stablecoin"; it is not a market role. **[Decided]** It becomes an on-chain self-service faucet: each registered identity can claim a fixed amount every 24 hours. This is a testnet limitation: the faucet lowers the real cost of the registration fee and of stakes, the documentation must say so explicitly, and the mainnet version removes the faucet.
- All economic parameters (stake and bond multiples, challenge window, fee bps and fee-share ratios, credit formula constants, caps) are hard-coded in the contracts at deployment and cannot change afterwards; changing a parameter means a new deployment. **[Decided]**

### 5.1 Identity and registration [Decided]

- Any address can call the registration function to become an agent identity and pay a **non-refundable registration fee** (it goes to the platform treasury) [User U7].
- An identity can declare one or more roles. Each role locks that role's **minimum stake**, which is slashed on misconduct and can be reclaimed after a cooldown on a normal exit.
- Credit is bound to the identity and cannot be transferred; the identity itself cannot be transferred either.
- The protocol cannot tell whether an agent or a human is behind an identity. "Only agents take part" means: no role or permission is reserved for humans or for the platform, and all participation goes through the same registered identities, public API and contracts.
- API access becomes self-service: an identity proves control of its wallet with a signature and automatically receives an API key, replacing the invite-only scheme.
- **Wallet neutrality [User 2026-10-24]:** every agent brings its own wallet that it can operate fully autonomously. An identity can be an EOA, or a contract wallet that supports ERC-1271 (for example ERC-4337 accounts such as Coinbase smart accounts). On-chain quote fills and off-chain signature verification (exchanging for an API key, quote relay, forecasts) accept both; off-chain verification also accepts ERC-6492 (accounts not yet deployed). The platform does not create, fund or custody wallets for agents.
- Whether to be compatible with ERC-8004 (the identity and reputation registries of Trustless Agents) is **[Implementer]**: first evaluate its current state; if adopted, it must not add privileged roles.
- **Generation:** the identity registry and the market factory are deployed as a pair and form one generation. Only markets created by that factory can report outcomes and change credit, which stops anyone from deploying fake markets to farm credit. The contracts are not upgradeable; to fix something or change parameters, deploy a new generation. **A new generation imports the previous generation's identities and credit read-only** (possibly discounted), so a low-credit identity cannot launder itself by waiting for a new version, and a high-credit identity does not reset to zero on an upgrade. Whether the registration fee is paid again in the new generation, and how large the credit discount is, are [Implementer].

### 5.2 Roles

| Role | What it does | Stake / bond | Income source | Credit source |
| --- | --- | --- | --- | --- |
| Creator | Writes the MarketSpec, declares the class, creates the market with a creation bond; can claim a human suggestion | Creation bond (scaled up with the market's maximum payout) | Fee share, paid only if the question settles successfully | The question was not successfully challenged and not ruled INVALID (trading volume is not counted, to stop wash-trading for points) |
| Maker | Answers RFQs, signs EIP-712 quotes, posts collateral | Role stake; fills still need full collateral | Spread | Share of quotes honored and not withdrawn before a fill |
| Taker/Trader | Requests quotes, fills, redeems at expiry | Role stake | Position returns | Not counted (limited only by identity and limits) |
| Forecaster | Submits a probability with a timestamp and evidence in a sealed window | Role stake | Informational advantage in trading (no fee share [User U13]) | Brier score and calibration on settled questions, compared within the same set of events |
| Proposer (result submitter) | Submits the result and evidence after close | Submission bond (scaled up with the market's maximum payout) | The settlement pool of the fees | The submitted result survives the challenge window or wins in arbitration |
| Challenger | Challenges a result or a market creation | Challenge bond (scaled up with the market's maximum payout) | The other side's slashed bond, plus the guaranteed challenge reward reserved from fees | Share of challenges upheld; points deducted for a failed challenge |
| Juror | Votes by commit-reveal in a dispute | Juror stake (slashable, and it is the voting weight) | A fixed share of the fees (by stake and lock time) [User U14], plus the loser's bond and part of the slashing of inconsistent voters | Votes consistent with the final outcome |
| Keeper | Calls the permissionless finalize, vote-reveal cutoff and fee distribution | None | A small execution fee from the settlement pool | Not counted |

One identity can hold several roles, but **within the same market** the contracts enforce these forbidden combinations **[Decided]**: a Proposer cannot be a Juror in the same market; a Juror cannot vote on a market in which it holds a position (or its position counts toward its stake requirement); a Creator cannot challenge its own market. The contracts cannot tell whether several identities belong to the same operator, so these rules only block the most direct self-dealing. Conflicts of interest across identities are handled by "bond and stake requirements are computed on the maximum payout" and by the safety cap in §5.12.

### 5.3 Question classes and market creation [User U5; details decided]

At market creation the Creator declares a class, and the class decides the settlement path and parameters:

| Class | Definition | Settlement path | Parameter direction |
| --- | --- | --- | --- |
| A computable | The answer is the result of running a fixed program on a specified public data source (the data source, field, comparison, and parser version hash are written in the MarketSpec) | Anyone can recompute; in a dispute, jurors only need to rerun it | Smallest bond, shortest challenge window |
| B verifiable | Reading public documents is needed to judge whether a fact occurred | Optimistic submission → challenge → arbitration → appeal | Medium bond and deadlines |
| C judgment | Involves subjective judgment | Same as B, with the most jurors and the highest bond | Lowest open-interest cap; the Creator needs a minimum credit threshold |

- The existing GM_LT_V1 (GAAP gross margin threshold) becomes the first template of class A. The parser reuses `packages/domain/src/gm-parser.ts`, and its version hash is made public.
- For class A, "recomputable" is based on the **archived raw bytes**, not on a live fetch (the source may be redesigned, disappear, or return different content to different people). The MarketSpec states the data source and the extraction rules. When submitting a result, the Proposer must publish the source response bytes and their hash together, and the challenge window starts from when the bytes become available. A dispute recomputes from the archived bytes. What to do when no one can archive the source before proposalDeadline is [Implementer], but it must not let the Proposer choose a favorable version.
- Agents can register new templates; the first use of a new template goes through a longer market creation challenge window. **[Decided]**
- **Market creation challenge window:** after a market is created it first enters PENDING, and anyone can challenge it with a bond on the grounds "wrong class", "the spec is ambiguous or cannot be settled", or "the result can be influenced by participants". The challenge goes through the same arbitration (§5.6). If upheld, the creator's bond goes to the challenger and the market does not open; if the window expires with no challenge, or the challenge fails, the market becomes OPEN. This replaces v0.1's human approval.
- The rules for spec bytes and specHash follow v0.1 (exact UTF-8 bytes, keccak256, no re-serialization).

### 5.4 Human suggestion of questions [User U9; details decided]

- Humans submit suggestions through a website form or the API (natural language is enough). No registered identity is needed; rate limits and basic validation guard against spam.
- Suggestions are publicly listed in a suggestion queue. Any Creator agent can claim one, write it as a formal MarketSpec and create the market with a bond. The spec records the suggestion ID.
- A suggestion by itself creates no on-chain right; the suggester cannot influence the spec content or the settlement.
- The suggester gets no fee share [User U12]: a suggestion is like public knowledge, and the human just comes along to ask. The spec records the suggestion ID only to mark the source; whether to record it is up to the Creator, and the protocol does not force it.

### 5.5 Trading: multi-maker RFQ [Decided]

- Keep the RFQ, taker binding, EIP-712 quotes, fully collateralized complete sets, whole-order fills and redemption at expiry.
- Any registered Maker can quote. The API only does **RFQ relay**: after receiving a request for quote it forwards it to the subscribed makers and collects the signed quotes back to the taker. The contracts verify that the quote signature belongs to a registered maker with enough collateral and an unexceeded limit.
- The platform may refuse to relay (censorship), but cannot forge or modify a quote; makers and takers can also skip the API and submit a quote directly to the contracts.
- Remove the taker allowlist, the single maker, and the pricing logic of the platform quote service (each maker decides its own pricing).
- On every fill the taker pays the fee (§5.8).

### 5.6 Settlement: layered [User U3; details decided]

Principle: **the cheaper verification is, the easier lying is to catch; game theory is the last line of defense, not the main mechanism.**

1. **Computable layer (class A):** the answer can be recomputed by a public program. The Proposer submits the result; anyone who recomputes a mismatch can challenge, and jurors only need to rerun.
2. **Optimistic layer:** the Proposer submits a result with a bond; if nobody challenges within the challenge window, it is finalized (permissionless).
3. **Arbitration layer:** after a challenge, the market enters an arbitration round. When the dispute opens, the eligible Jurors and their slashable stake are **snapshotted**; later registrations, added stake or unstaking do not affect this round. Jurors vote by **commit-reveal**, and the **weight = the slashable stake at snapshot time** (credit does not amplify weight; it only decides eligibility for higher rounds), so splitting stake across several sybil identities does not increase weight. Commit and reveal have explicit deadlines and buffer blocks, and the quorum is counted on committed stake. Whether to switch to random juror selection is **[Implementer]**: Base's `prevrandao` is supplied by the sequencer and can be manipulated, so if selection is adopted the security of the randomness source must be explained; without selection, every Juror in the snapshot can vote.
4. **Appeal:** the losing side can appeal to the next round by posting a doubled bond (longer deadlines, higher quorum, higher credit threshold); the maximum number of rounds is hard-coded.
5. **Backstop:** Only a market still unresolved after hardDeadline becomes INVALID (YES/NO 0.5 each, as in v0.1). A round that misses its quorum is **not directly INVALID**; it is extended or escalated, so that an attacker cannot push a market to INVALID by delaying.

**Safety invariants (must be written as formulas and have adversarial tests):**
- **Cost of corruption > benefit of corruption, checked on-chain per market.** A market's **maximum payout** is fixed at market creation (`maxPairs × 1 bUSD`) and never decreases afterwards. At market creation the contract checks that the slashable stake needed to win a majority in the final arbitration round, plus the cost of appeals, is greater than the market's maximum payout plus the rewards the same attacker could collect in the related roles; if not, market creation is refused. All bond and stake requirements are computed on the maximum payout, not on open interest, which changes and can be split. The exact formula is [Implementer], but it must be written into the documentation and tested item by item.
- **INVALID must not be cheaper than winning a dispute.** An attacker might first buy the cheap side, then push the result to INVALID through a cheap challenge, not revealing votes or delaying, and collect 0.5. So the challenge bond is computed on the maximum payout; if the challenge in the end does not overturn the original result (including ending in INVALID), the challenge bond is not refunded; the slashing for not revealing must be large enough to compensate for the delay it causes.
- **Lying cannot profit even when there is no challenger.** A guaranteed challenge reward is reserved from fees, so catching an error is always profitable; the Proposer's bond is at least the maximum benefit it can get from a wrong result. `examples/` provides a reference challenger agent, but safety must not depend on it being online.
- Juror incentives look only at consistency with the final outcome, combined with commit-reveal to discourage herding.
- Settlement documents are always treated as untrusted data; class A uses a deterministic parser on the archived bytes to reduce the impact of prompt injection on settlement.
- Advancing any state after a deadline expires is permissionless (the Keeper is merely paid to do it; anyone can).

### 5.7 Credit [User U6, U7; details decided]

- **Computed separately per role** (see the table in §5.2). Slow to accumulate, fast to lose; subject to time decay; not transferable.
- **On-chain credit:** the outcomes of Creator, Proposer, Challenger, Juror and Maker are all on-chain; the contracts compute credit from events, and it can affect on-chain limits.
- **Off-chain credit:** the Forecaster's Brier score is computed off-chain (forecasts are off-chain). It only affects off-chain uses (consensus probability weighting, public rankings) and does not affect any rule about funds.
- **Use: credit does not pay money directly; it only lowers costs and relaxes caps.**
  - Cap = staked capital × credit multiplier (a new identity has the lowest multiplier, but staking more capital still raises the limit, to avoid a cold-start deadlock).
  - Bond and stake multiples fall with credit, with a **floor**; large markets always require full bonds (to stop "farm credit, then harvest").
  - Class C market creation and high-level arbitration need a minimum credit threshold; credit **does not amplify** arbitration voting weight (weight depends only on slashable stake, see §5.6).
  - The challenge window can shorten with the Proposer's credit, but not below a floor.
  - The consensus probability the platform displays is weighted by Forecaster credit.
- **Anti-laundering:** a new identity pays the registration fee, starts with zero credit and the smallest limit [User U7].
- **Cold start:** when a new generation has just been deployed, every identity has zero credit, and if the thresholds were fixed, nobody could enter class C market creation or high-level arbitration. The thresholds instead **open gradually according to the generation's public metrics** (for example the number of finalized markets, total juror stake), and no privileged address can open them manually. If credit is imported from a previous generation, it is used directly.
- **Anti-farming:** credit comes only from finalized outcomes (whether a settlement was overturned, whether a question was ruled invalid, whether a forecast was accurate), not from trading volume or open interest; the increments are weighted by the market's maximum payout, so farming on small markets pays little. Wash trades pay fees, and the platform's share of those is a net loss, so inflating trading volume has a cost of its own.
- **Residual risk:** an identity with very low credit can switch to a new account, return to the newcomer limit and shed its bad record. This fits "switching accounts brings no benefit" but is not a punishment; the registration fee and the role stake are the cost of switching accounts.

### 5.8 Fees and fee share [User U8; ratios decided]

- Every fill charges a fixed bps fee on the amount the taker pays, held inside that market's contract.
- It is distributed when the market is FINAL (triggered permissionlessly):
  - Platform treasury: a fixed ratio.
  - Creator: a fixed ratio; when the question is INVALID or a market creation challenge is upheld, this share goes to the settlement pool or the treasury (one of the two, [Implementer]).
  - Settlement pool: for the Proposer who survived the challenge window or won in arbitration, and the Keeper execution fee.
  - Juror pool: compensates jurors for the stake they lock to keep the mechanism running, distributed by stake and lock time, and slashed on misconduct [User U14]. This share keeps total juror stake sustained even when there are no disputes, so that the market cap in §5.6 has a useful size.
  - Guaranteed challenge reward: reserved for every market and paid out only if a challenge is upheld (§5.6).
- The win or loss of a dispute itself is paid for separately by the loser's slashed bond.
- Forecasters and human suggesters get no fee share [User U12, U13].
- The registration fee goes to the platform treasury.
- The default ratios are [Implementer] and are written as deployment parameters; no reward calculated from trading volume may appear (to prevent wash trades).
- The platform treasury address is a receiving address and has **no protocol permission**.

### 5.9 After there is no admin [Decided]

- The contracts are not upgradeable and have no pause; a new version is a new deployment (a new generation, §5.1), and old markets run to completion under their old rules.
- **Governance only decides "the next generation" and does not touch existing markets [User U18; scope decided]:** platform token holders vote on whether to adopt a new generation and its parameters, and after it passes there is a lock period before it takes effect. Governance **cannot** modify the rules, outcome or escrowed funds of an existing market. The reason is that a position can only be redeemed at expiry and users cannot exit during the lock period, so any governance power over existing markets would amount to power over users' money.
- Governance's quorum, lock period and proposal threshold are [Implementer]; governance votes are likewise weighted by snapshot, to prevent borrowed-token voting.
- Trading stops automatically at closeAt; all deadline advances are permissionless.
- In a security incident all the platform can do is: stop API relay, announce on the website and in the documentation, and publish a new deployment. This limit must be written into the documentation.
- When the indexer lags, RFQ forwarding stops (the v0.1 rule), but this does not affect any action on the contracts.

### 5.10 Boundary of the platform processes [Decided]

The platform keeps and runs only infrastructure:

| Process | New responsibility | What it no longer does |
| --- | --- | --- |
| API | Self-service identity, RFQ relay, public reads, forecast submission and windows, human suggestions, evidence upload | Approval, admin actions, quote pricing |
| Indexer | Events of the new contracts, reorg handling, projections, read models for credit and fee share | — |
| Worker | Infrastructure jobs: outbox, retention, alerts, scoring, opening and closing forecast windows | Business handlers for discovery, forecaster, baseline, trader, keeper and faucet |
| Signer | **Removed** (once the faucet is on-chain and self-service, the platform has no business that needs a signature) | Maker, keeper, faucet and trader signing |
| Web | Documentation site, docs, advantages page, human suggestion form, read-only market data | — |

- Forecasts must be signed by the agent; the platform cannot forge or retroactively modify a forecast, and timestamps must be independently verifiable (for example, periodically put the Merkle root of the forecasts in a window on-chain, triggered by anyone). The method is [Implementer].
- Evidence and spec bytes are addressed by content hash, and anyone can mirror them; the platform's storage is only a convenience, not a source of trust.
- Operating the platform's infrastructure (hosts, alerts, backups) does not count as playing a market role.

### 5.12 Trust assumptions (must be stated publicly) [Decided]

After all privileged roles are removed, the final safety of settlement still rests on one assumption: **the slashable juror stake inside the snapshot is an honest majority**. This is the same assumption as permissionless oracles such as UMA and Kleros; without trusted identities, stake alone cannot give a stronger guarantee (for example, it cannot fully prevent off-chain bribery). The design handles this as follows:

- Write the assumption into the documentation and the website. State the claim as: "**Under the publicly listed assumptions**, honesty is the provably best strategy", and do not claim an unconditional guarantee.
- Juror stake uses the platform token [User U18]: taking over arbitration → the market loses trust → the platform token falls → the platform tokens the attacker staked evaporate, so the attack destroys the attacker itself. This is the same kind of security source that Bitcoin and UMA rely on; its strength depends on the platform token's market value. While the market value is small early on, the protection is small too, so the market cap must be small with it.
- The per-market cap check has to convert juror stake into bUSD, which needs a manipulation-resistant platform token price. The price source is [Implementer], but it must resist short-term manipulation (for example a long-window TWAP, taking the conservative value). The testnet has no real liquidity, so the drill uses a fixed test price, and the documentation must say so explicitly.
- Use the per-market cap in §5.6 so that the maximum payout of any single market is smaller than the cost of taking over arbitration.
- Keep results in the computable layer wherever possible, to shrink the range that needs arbitration.
- At cold start, total juror stake is small and the market cap is small with it; this is expected behavior.

### 5.11 LIVE and REPLAY [Decided]

REPLAY becomes a **deployment-level** flag: only test and drill deployments allow REPLAY markets, and production deployments have only LIVE. REPLAY statistics stay permanently separate from LIVE.

## 6. Temporary design to remove (against the current code)

The implementation plan must list files one by one; the scope is as follows:

- **Contracts:** in `BlinkMarket.sol`, the immutable `maker`, `admin`, `resultProposer`, `challenger`, `arbiter` and the `only(...)` permissions; `setGlobalTradingPaused`, `setMarketTradingPaused`, `setTakerAllowed`; `arbitrate`. In `BlinkTestUSD.sol`, the fixed minter (replaced by a self-service faucet).
- **Market approval flow:** the manual approval paths of approval/preparation/creation tracking (`approval*`, `preparation*`, market creation from the ADMIN wallet).
- **Platform agents:** discovery, `platform-forecaster`, baseline, the internal trader (`trader*`, `trader-rule`), the platform keeper and the faucet worker.
- **Signer and dispatcher:** `apps/signer`, `signer*`, `signing-*`, `tx-dispatcher`, the platform's nonce management, and the runtime role that exists only for platform signing.
- **Invite-only identity:** invite key issuance, operator management.
- **Single-maker pricing:** the quote service pricing by ensemble, and the platform-side logic of maker collateral reservation.
- **Documentation:** the descriptions in v0.1 of fixed roles, manual approval and team-operation disclosures are turned into history or deleted.

When removing, follow these rules: applied migrations must not be modified, only added; the `alpha-2` deployment record and manifest are kept as history and are no longer the target deployment.

## 7. What to keep and rework

- Complete sets, full collateral, integer share counts, INVALID 0.5, redemption at expiry, the rules for spec bytes and hashes.
- The EIP-712 quote format (adding the maker identity), and consumed/cancel/epoch replay protection.
- The chain indexer (reorg, canonical cursor) and tx tracking (for agent queries).
- Forecast windows, sealed submission, `OUTCOME_ALREADY_PUBLIC`, Brier, LIVE/REPLAY separation.
- The allowlist fetcher's SSRF protection (used by reference agents and evidence upload).
- The `@blink/client` SDK and quote verification; `examples/agent` is extended into reference agents for each role.
- Job queue, outbox, retention, alerts, health, and the backup and restore drill.

## 8. Reference agents and documentation [Decided]

- `examples/` provides a reference agent for every role (creator, maker, trader, forecaster, proposer, challenger, juror, keeper), open source, runnable by anyone. They are **not participants operated by the platform**: they use only the public documentation, the public API and their own keys, and must not use any internal package or privileged configuration (enforced by an import-boundary test).
- Reference agents use a fixture model by default and do not depend on a paid model; CI and the §2.1 drill use only them, and the results are reproducible [User U15].
- Also build one **optional general-purpose LLM agent demo**: it receives only `/llms.txt` and the documentation, uses the operator's own model key, and decides for itself which roles to take. It is not in CI, and the operator pays the model cost. It can serve as material for the introduction video, and it is also used to check that the documentation is enough for an agent to onboard by itself [User U15].
- `/docs/agents` and `/llms.txt` are rewritten as "read it and you can choose a role and onboard": each role's duties, stake or bond, income, credit, risks, and the API and contract call steps. The drill in the success criteria §2.1 must use only the interfaces this documentation describes.

## 9. Website: advantages and vision [User U10, U24; presentation decided]

The home page continues into an advantages section (no standalone page) whose content covers at least:
- A verifiable closed loop from raw data to scoring.
- Protection against AI forecast contamination: sealed windows, `OUTCOME_ALREADY_PUBLIC`, permanent LIVE/REPLAY separation.
- Research probabilities shown separately from market prices.
- Safety boundaries for autonomous agents.
- RFQ solves the cold start of long-tail questions.
- All-agent roles, layered automatic settlement, agent credit.
- Readable reasoning: each forecast can carry a signed, hash-addressed reasoning document, so a human can see how an agent reached its probability [User U19].
- No custody: the platform holds no funds and no key that can move them, and the website signs nothing [User U22].

Lead with liquidity for long-tail questions [User U20], and present the site to humans as a place to read forecasts and agents' reasoning, not to take part [User U19].

The section shows only implemented capabilities, carries no status label, and names no other platform [User U24]. Every claim must match what the code does (§3).

## 10. Introduction video [User U11]

- Add a to-do: produce the Blink introduction video, introducing the product [User U23].
- It replaces the "3-minute demo" positioning of v0.1 §19 and `docs/M5_DEMO_SCRIPT.md`. The video is animation: placeholder questions and probabilities must stay plausible and truthful to the protocol, and the music track's licence is recorded in `video/README.md`.
- Make it with Remotion (generating video from React code) [User U16], in a separate workspace inside the repo (location [Implementer]), so that the website and services do not depend on it. Before starting, confirm whether Remotion's license terms apply (its license is free for individuals and small teams, and larger companies must buy a company license), and write the result into the documentation.

## 11. Phases (suggested) [Decided]

| Phase | Content | Parallelizable |
| --- | --- | --- |
| P0 | Approve this design; tidy the existing plan documents and the ROADMAP to match the new goal | — |
| P1 | New contracts: registration and role stakes, question classes and market creation challenge, multi-maker fills and fees, layered settlement and arbitration, credit, self-service faucet; Foundry unit, invariant and adversarial tests | Parallel by module inside the contracts |
| P2 | Off-chain rework: remove the §6 items; self-service identity; RFQ relay; indexer and read models for the new events; signed forecasts; human suggestions | Parallel once the P1 interface is fixed |
| P3 | Reference agents, agent documentation, the `pnpm alpha:autonomous` drill (all §2.1 scenarios) | Agents for each role in parallel |
| P4 | Website advantages section, README/ROADMAP, introduction video | In parallel with the later part of P3 |

Deployment (D3, D6, Track B) is reassessed after P4.

## 12. The user's answers and open items for discussion

Answered on 2026-10-23: Q1 juror compensation → U14; Q2 level of proof → U15; Q3 Forecaster fee share → U13; Q4 human suggester fee share → U12; Q6 video → U16.

**Open for discussion (does not block starting P1–P3, but must be decided before the website opens to public suggestions and market creation):**

- **How to handle banned questions [User U17].** Questions that are illegal or harm individuals should be banned, but platform review would not be decentralized. Direction: reports as an appeal channel, then handled by a vote (for example, list "illegal or harms individuals" as a market creation challenge ground that goes through the same Juror arbitration). Still undecided:
  - how to write the criteria as a rule jurors can apply consistently;
  - what happens to positions when a report is upheld after the market has opened for trading (for example, settle as INVALID), and whether this could be used to arbitrage the 0.5;
  - whether the platform may first hide reported content on its own website and API (affecting only the platform's interface, not touching the chain), and whether that counts as playing a role.
- When designing the contracts, reserve an extension slot for "market creation challenge grounds", so that this decision can later go into a new generation without rewriting the market creation flow.
- **Real issuance of the platform token (decided before mainnet) [Derived from User U18]:** initial distribution (if the platform holds too much it controls governance, which amounts to playing a role), how to obtain it, the legal characterization of whether Juror stake earning fees counts as a security, and the real price source. This does not block the testnet stage.
- **Further extension of governance upgrades:** once an early-exit mechanism exists, evaluate whether governance can modify existing markets in a limited way.

## 13. Decisions made by the author (please check)

- Economic parameters are hard-coded at deployment; changing a parameter means a new deployment.
- The on-chain self-service faucet replaces the platform minter, and the signer process is removed as a result.
- The registration fee is non-refundable; role stakes can be returned after a cooldown.
- The mutual-exclusion rules for roles within one market (§5.2).
- Three question classes, the market creation challenge window, and a longer challenge window for the first use of a new template.
- Arbitration uses commit-reveal voting weighted by snapshot stake (credit is only a threshold and does not amplify weight), and the appeal bond doubles; a round without a conclusion is not directly INVALID, and only a market past hardDeadline becomes INVALID.
- All bonds and stakes are computed on the maximum payout fixed at market creation; the check "cost of corruption > benefit of corruption" runs per market at market creation.
- Class A settlement is based on archived bytes; a guaranteed challenge reward is reserved from fees.
- Credit is split into on-chain (roles tied to funds) and off-chain (Forecaster); it comes only from finalized outcomes; all five uses are included, but it does not amplify voting weight.
- The "honest-majority stake" trust assumption is stated publicly (§5.12).
- The identity registry and the market factory form a "generation" as a pair; a new generation imports the previous generation's identities and credit read-only.
- Two assets: bUSD for trading, fees and per-market bonds; the platform token for juror stake and governance.
- Governance can only decide the next generation and its parameters (with a lock period) and cannot touch existing markets.
- Credit thresholds open gradually according to the generation's public metrics; the drill may use test parameters with shorter deadlines, but the threshold rules are the same as production.
- The taker pays the fees; dispute rewards come only from slashed bonds.
- There is no pause and no upgrade.
- REPLAY becomes a deployment-level flag.
- Reference agents live in `examples/`, and an import boundary guarantees they use no internal capability.
