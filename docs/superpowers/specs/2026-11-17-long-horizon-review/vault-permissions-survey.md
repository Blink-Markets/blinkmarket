# Interest-bearing USDC vaults on Base: permissions and risk survey

Date: 2026-11-23. Status: working material for the decision in section 12.13 of the [discussion record](../2026-11-16-long-horizon-forecasting-discussion.md). A subagent wrote it, and it is kept as delivered, except that three sentences about how the research was done were reworded or removed.

Snapshot date: 2026-11-23. Chain: Base mainnet (chain id 8453), asset: native USDC `0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913`.
Scope: read-only research. No transaction was sent and no wallet was used.

## 0. Method and evidence tags

Every claim carries one tag.

| Tag | Meaning |
| --- | --- |
| `[SRC]` | Read from verified contract source: the protocol's GitHub repository, or Sourcify-verified source of the deployed address (`https://sourcify.dev/server/v2/contract/8453/<address>`). |
| `[DOC]` | Read from official documentation or an official forum/post by the protocol. |
| `[EXP]` | Explorer-equivalent on-chain read: `eth_call` or `eth_getStorageAt` against a public Base RPC (`mainnet.base.org`) on 2026-11-23. This returns the same values as the "Read contract" tab of a block explorer. Explorer pages and APIs were not used; reads went directly to a public RPC. Explorer link for any address: `https://basescan.org/address/<address>`. |
| `[INF]` | Inferred by me from the above. |
| `[UNV]` | Unverified: news articles, third-party risk reports, aggregator data. Treat as leads, not facts. |

Other tooling notes:
- Sizes come from `[EXP]` reads and from the DefiLlama pool list (`https://yields.llama.fi/pools`, `[UNV]`; its `tvlUsd` for lending pools is supply minus borrows, so it understates deposits) and the Morpho API (`https://api.morpho.org/graphql`, `[UNV]` as an index of on-chain state).
- GitHub `main` branches were cloned on 2026-11-23. The deployed bytecode may be older than `main`; I matched code only where Sourcify verified the deployed address, and did not diff versions.
- Pages from coindesk and cointelegraph were not read; for those the survey relies on search-result summaries and marks them `[UNV]`.

## 1. Candidate selection

Base USDC pools by size (2026-11-23, DefiLlama + on-chain reads):

| Venue on Base (USDC) | Size | Verdict |
| --- | --- | --- |
| Morpho vaults (aggregate of the list below) | about $1.8B in the 7 largest | IN (two vault generations) |
| Aave v3 USDC market | 180.7M supplied, 166.7M borrowed `[EXP]` | IN, but only through its ERC-4626 wrapper (aUSDC itself is not ERC-4626) |
| Fluid fUSDC | 5.85M `[EXP]` | IN |
| Spark USDC Vault (sUSDC) | 3.93M `[EXP]` | IN |
| Euler v2 USDC (EVK vaults, Euler Earn) | each below about 0.3M net `[UNV]` | IN, but flagged as too small |
| Compound v3 cUSDCv3 | 7.35M supplied, 6.46M borrowed `[EXP]` | OUT as a primary candidate: not ERC-4626 on Base (the official ERC-4626 `CometWrapper` is listed "Upcoming" for Base USDC `[DOC]`); documented for completeness |
| Yearn v3 USDC (about 2M), Yo `yoUSD` (about 6.9M), Beefy / Harvest / IPOR wrappers, Moonwell Flagship USDC (3.5M), Seamless | small | OUT: wrappers add a second upgradeable layer with a team-controlled strategy, or are small; Moonwell and others are Morpho Vault V1 instances and are covered by section 4.1 `[UNV, DefiLlama]` |
| Spark Vaults V2 (`spUSDC`) | not deployed on Base | OUT: official docs list Ethereum, Avalanche, X Layer only `[DOC]` |
| Spark Savings `sUSDS` on Base, via PSM3 | about 12M `[UNV]` | OUT: sUSDS on Base is a bridged ERC-20 priced by a rate oracle, not an ERC-4626 `[INF]`; the Spark USDC Vault wraps it (4.4) |
| Aave v4 (`aave-v4` pools, Coinbase Stocks) | about 2M | OUT: no USDC supply market of relevance; immature `[UNV]` |
| Midas, Centrifuge, other RWA tokens | large but permissioned (KYC / issuer-controlled) | OUT: not permissionless DeFi vaults |

Candidates (7): (1) Morpho Vault V1, (2) Morpho Vault V2, (3) Aave v3 via stataUSDC, (4) Spark USDC Vault, (5) Fluid fUSDC, (6) Euler v2, (7) Compound v3 (excluded, documented).

## 2. Summary table

"Moves funds" means a role that can transfer depositors' assets out of the vault without a depositor action, directly or by upgrading code. All timings are as read on-chain on 2026-11-23.

| Candidate | ERC-4626 | Who can upgrade, and delay | Who can pause or block withdrawals | Who can move funds | Share price can fall | Harmful change observable before it takes effect |
| --- | --- | --- | --- | --- | --- | --- |
| 1. Morpho Vault V1 (MetaMorpho). Instances: Gauntlet USDC Prime `0xeE8F4eC5672F09119b96Ab6fB59C27E1b7e44b61`; Steakhouse USDC `0xbeeF010f9cb27031ad51e3333f9aF9C6B1228183`; Steakhouse Prime USDC `0xBEEFE94c8aD530842bfE7d8B397938fFc1cb83b2` | Yes. `max*` follow caps and market liquidity | Nobody: the vault is not a proxy `[SRC]` `[EXP]`. Behaviour changes only through configuration (timelock 7 days on the three instances) | No pause, blacklist or gate in the code `[SRC]`. Withdrawals are limited only by liquidity in the underlying Morpho Blue markets | No role can transfer principal out. Allocators move funds between already-capped markets instantly. A curator can add a market or raise a cap after the timelock, so funds can be routed into a bad market up to its cap. `skim()` sends non-accounted tokens to a recipient set by the owner | Yes: bad debt in an underlying Morpho Blue market lowers share price. Hits in 2025-26 (section 4.1) | Partly. Cap increases, timelock decrease and guardian change are queued in public storage for the full timelock (`pendingCap(id)`, `pendingTimelock()`, `pendingGuardian()`). Not observable: instant owner actions (`setCurator`, `setIsAllocator`, `setFee` up to 50%, `setSkimRecipient`, timelock increase), and allocator reallocation within caps |
| 2. Morpho Vault V2. Instances: Steakhouse Prime USDC `0xbeef0e0834849aCC03f0089F01f4F1Eeb06873C9`; Gauntlet USDC Prime `0x050cE30b927Da55177A4914EC73480238BAD56f0`; Grove x Steakhouse `0xbeef0786756810478b88982DE00F3CD7fdB8e7c7`; Steakhouse High Yield Edition `0xbeeff2490FEffa212faC2f6553682C219E6a8845` | Yes, but `maxDeposit/maxMint/maxWithdraw/maxRedeem` always return 0 `[SRC]` | Nobody: vault is not a proxy; per-function timelocks of 0 to 7 days; any function can be abdicated (made uncallable forever) `[SRC]` `[EXP]` | No pause. Optional "gates" could block specific addresses or all exits `[SRC]`, but on all four instances the share and withdrawal gates are unset and abdicated `[EXP]`. Allocators can set the liquidity adapter, which can block in-vault exits but not `forceDeallocate` (in-kind exit, penalty at most 2%) | No role can transfer principal out. Allocators move funds between capped markets; curator additions and cap increases are timelocked (3 to 7 days on the instances) | Yes: losses are booked immediately; gains are rate-limited by `maxRate`. Same underlying risk as V1 | Partly better than V1. Every timelocked action is stored as `executableAt[calldata]` and `timelock(selector)`, `abdicated(selector)` are public. A watcher must know the exact calldata. Instant actions (some fee changes, `setIsAllocator` on some instances, allocator moves, penalty up to 2%) are not observable in advance |
| 3. Aave v3 USDC via `stataUSDC` `0xC768c589647798a6EE01A91FdE98EF2ed046DBD6` (aUSDC `0x4e65fE4DbA92790696d040ac24Aa414708F5c0AB`, not 4626) | Wrapper yes (StataTokenV2); `max*` reflect pause, caps and liquidity. Wrapper holds only about 0.4M | Pool, aToken and stata are proxies upgraded by Aave governance. On Base the Level 1 executor delay is 1 day (grace 7 days) `[EXP]` | Emergency admin can pause the pool or one reserve (blocks withdrawals) and can pause the wrapper `[DOC]` `[SRC]`. A guardian can also freeze a reserve (no new supply or borrow) | No role transfers user funds directly. A governance upgrade could, after 1 day | Not by the aToken accounting itself; bad debt becomes a recorded deficit (reserve deficit 30.9 USDC on Base now `[EXP]`) whose coverage (Umbrella, treasury, or depositors) is decided by governance. April 2026 forum report models depositor shortfalls `[DOC]` | Governance payloads: yes, queued 24 h on the Base `PayloadsController` (public). Guardian pause or freeze: no warning |
| 4. Spark USDC Vault (`sUSDC`) `0x3128a0F7f0ea68E7B7c9B00AFa7E41045828e858` | Yes, plus extra overloads and an `exit()` escape hatch to sUSDS | UUPS proxy; upgrade authority is `wards`, which include the Spark Executor. The Base executor `delay()` reads 0 `[EXP]`; the effective delay is the Ethereum-side Sky governance delay (18 h in April 2025, may differ now) `[UNV]` | No pause in the vault. Exits are limited by USDC in the PSM3 pocket (about 1.0M USDC against 3.93M vault assets) `[EXP]`; `exit()` redeems sUSDS instead | Upgrade authority only (Spark governance). PSM3 owner (same executor) can move PSM3's USDC (`setPocket`) | Not by design: share price follows a rate set by Sky governance. Loss would need an upgrade, an oracle fault or a PSM/USDS failure `[INF]` | Weak on Base: executor delay is 0; the Ethereum-side spell is visible on Ethereum, not readable from Base without a bridge `[INF]` |
| 5. Fluid fUSDC `0xf42f5795D9ac7e9D757dB633D693cD548Cfd9169` | Yes (plus EIP-2612 deposits) | fToken is immutable `[DOC]` `[SRC]`. The Liquidity layer (holds all funds, `0x52Aa899454998Be5b000Ad077a46Bbe360F4e497`) is an upgradeable proxy whose admin on Base is a TimelockController, `minDelay` 1 day, proposer and canceller = team Avocado multisig `[EXP]`. Team multisig can also roll back an upgrade within 7 days `[DOC]` | Guardians and auths can pause tokens, pause individual users' withdrawals, or pause all of Liquidity (`changeStatus`) `[SRC]`. Auths can set per-user withdrawal limits | Guardian cannot move funds `[UNV]`. Upgrade by the timelocked multisig could | Possible through bad debt in Fluid's borrow vaults sharing the Liquidity layer; March 2026 bad debt of about $19-21M was covered by a discretionary off-chain backstop, not a pre-funded reserve `[UNV]` | Timelocked upgrades: yes (TimelockController). Pauses by guardians and auths: no |
| 6. Euler v2 (EVK `eUSDC-*` vaults; Euler Earn) factory `0x7F321498A801A191a93C840750ed637149dDf8D0` | Yes | EVK vault implementation is upgradeable through the factory `upgradeAdmin` (governor access control behind a 4-day TimelockController, DAO Safe 4/8) `[EXP]`; individual vaults may be non-upgradeable (minimal proxy) `[SRC]` | Each vault's governor can instantly disable `withdraw`/`redeem` by `setHookConfig(address(0), ops)`; no timelock at vault level `[SRC]` | No role transfers funds directly; the governor can change LTV, IRM, caps and oracle-bearing settings instantly `[SRC]` | Yes: bad debt is socialised to suppliers | Factory upgrades: yes (4 days). Vault-level governor changes: no |
| 7. Compound v3 cUSDCv3 `0xb125E6687d4313864e53df431d5425969c15Eb2F` (excluded) | No on Base (wrapper "Upcoming") | Comet proxy admin owned by the Base Timelock (delay 1 day, grace 14 days), controlled from Ethereum governance through the bridge receiver `[EXP]` | `pauseGuardian` Safe (5 of 9) or governor can pause supply, transfer, withdraw, absorb, buy `[SRC]` `[EXP]` | Governor can withdraw protocol reserves and upgrade code `[SRC]` | Not by accounting; deficits are borne by reserves first | Timelocked governance: yes. Pause: no |

## 3. Background only: USDC contract on Base (issuer powers; not weighed)

Contract `0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913` is a Circle `FiatTokenProxy` (`[EXP]`, source `https://github.com/circlefin/stablecoin-evm` `[SRC]`):
- Upgrade: the proxy admin `0x4fc7850364958d97b4d3f5a08f79db2493f8ca44` can `upgradeTo` / `upgradeToAndCall` and `changeAdmin` with no delay (implementation now `0x2Ce6311ddAE708829bc0784C967B7d77D19FD779`, `version()` = "2") `[EXP]` `[SRC]`.
- Pause: `pauser` `0xD3571B3bc51CECFf49194AD67aFFFC648d5e07b4` can pause all transfers; `paused()` = false now `[EXP]` `[SRC]`.
- Blacklist: `blacklister` `0x1f2e3A640175d20ac31ed523B6733B977173E277` can blacklist any address, including a vault or the protocol's contracts, blocking all transfers to and from it `[EXP]` `[SRC]`.
- Owner `0x3ABd6f64A422225E61E435baE41db12096106df7` can replace pauser, blacklister and rescuer; `masterMinter` `0x2230393EDAD0299b7E7B59F20AA856cD1bEd52e1`; `rescuer` is unset `[EXP]`.
- Total supply on Base about 4.27B USDC `[EXP]`.

## 4. Candidate sections

### 4.1 Morpho Vault V1 (MetaMorpho / MetaMorpho V1.1)

**Addresses (Base).** Morpho Blue singleton `0xBBBBBbbBBb9cC5e90e3b3Af64bdAF62C37EEFFCb` (non-proxy; Sourcify "Morpho", EIP-1967 slots empty) `[SRC]` `[EXP]`. Largest V1 USDC vaults by assets (Morpho API `[UNV]`, `totalAssets` confirmed `[EXP]`):

| Vault | Address | Assets | Timelock | Fee | Owner | Curator | Guardian |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Gauntlet USDC Prime (V1.0) | `0xeE8F4eC5672F09119b96Ab6fB59C27E1b7e44b61` | 396.7M | 7 d | 0% | Safe 4/7 `0x5a4E19842e09000a582c20A4f524C26Fb48Dd4D0` | Safe 3/7 `0x9E33faAE38ff641094fa68c65c2cE600b3410585` | Safe 3/7 `0x7084bF4dB6c21e1834dD6482f6056a39A33584cD` |
| Steakhouse USDC (V1.0) | `0xbeeF010f9cb27031ad51e3333f9aF9C6B1228183` | 101.7M | 7 d | 25% | Safe 5/10 `0x0A0e559bc3b0950a7e448F0d4894db195b9cf8DD` | Safe 3/9 `0x827e86072B06674a077f592A531dcE4590aDeCdB` | `0x9e0FdDDa790651E6a05CD2dE69e624B94C04eAf5` (no contract code: an EOA) |
| Steakhouse Prime USDC (V1.1) | `0xBEEFE94c8aD530842bfE7d8B397938fFc1cb83b2` | 11.5M | 7 d | 5% | same Safe 5/10 | same Safe 3/9 | `0x894d59017Ed0F8dcd8f2B6e89a3C26eF76876D33` |
| Spark USDC vault | `0x7BfA7C4f149E7415b73bdeDfe609237e29CBF34A` | 3.6M | 10 d | 10% | Spark Executor `0xF93B7122450A50AF3e5A76E1d546e95Ac1d0F579` | Safe `0x0f963A8A8c01042B69054e787E5763ABbB0646A3` | Safe `0xf5748bBeFa17505b2F7222B23ae11584932C908B` |
| Pangolins, Moonwell Flagship, Yearn OG, Gauntlet Core | see Morpho API | 1.5-7M | 3-4 d | 10-15% | varies | varies | varies |

Roles and thresholds read from `[EXP]` (Safe `getThreshold`/`getOwners`). Gauntlet's owner, curator and guardian Safes share the same 7 signer addresses `[EXP]` (so the guardian is not an independent check on the curator). Morpho Blue's owner is a Safe 5/9 `0xcBa28b38103307Ec8dA98377ffF9816C164f9AFa` `[EXP]`.

**ERC-4626.** Implements ERC-4626 (OpenZeppelin-based). `maxDeposit` is the remaining supply-cap room; `maxWithdraw`/`maxRedeem` are limited by market liquidity (`_simulateWithdrawMorpho`); fee shares are minted on interest. `DECIMALS_OFFSET` = 12 on all three instances `[EXP]`, so the virtual-share offset is 10^12 for a 6-decimal asset `[SRC]` `https://github.com/morpho-org/metamorpho-v1.1/blob/main/src/MetaMorphoV1_1.sol`; V1.0 source `https://github.com/morpho-org/metamorpho`.

**Upgradeability.** Not a proxy (Sourcify `isProxy: false` for the Gauntlet instance) `[SRC]` `[EXP]`. The code has no upgrade function; deployments come from the factory.

**Pausing and freezing.** None in the code: no `pause`, no blacklist, no per-address block `[SRC]`. Withdrawals can fail or be partial only when the underlying Morpho Blue markets lack idle liquidity. Docs state the curator "cannot pause asset withdrawals" `[DOC]` `https://docs.morpho.org/curate/concepts/roles`.

**Parameter powers** `[SRC]` (V1.1; V1.0 same in substance):
- Owner, instantly: `setCurator`, `setIsAllocator`, `setSkimRecipient`, `setFee` (max 50%, accrues first), `setFeeRecipient`, `setName/Symbol`, increase timelock. Owner, delayed by the current timelock: lower timelock, change guardian (`pendingTimelock`, `pendingGuardian`).
- Timelock bounds: 1 day to 2 weeks.
- Curator: `submitCap` increase (timelocked), decrease (instant); `submitMarketRemoval` (timelocked).
- Allocator: `reallocate`, `setSupplyQueue`, `updateWithdrawQueue`, instant, within the curator's caps.
- Guardian: revoke pending timelock decrease, guardian change, cap increases, market removal.
- Anyone: accept a queued change after its delay; call `skim(token)`, which sends the vault's balance of any token (including USDC not accounted in `totalAssets`) to the owner-set skim recipient.

**Can any role move or seize depositor funds?** Not directly: assets sit in Morpho Blue markets as the vault's supply position; no function sends them to an arbitrary address `[SRC]`. Indirectly: a curator can enable a market (after the timelock) whose collateral or oracle is bad and an allocator can fund it up to the cap; this is a loss path with a visible delay `[INF]`. A compromised owner can instantly change curator and allocators and the fee (up to 50% of interest). Docs describe owner compromise as complete loss of vault control `[DOC]`.

**Liquidity delays.** Withdrawal needs idle supply in the markets in the withdraw queue. Morpho's markets target high utilization, so exits can be partial in stress. Past events: after the Stream xUSD collapse (4 Nov 2025) vault liquidity for xUSD-backed markets stayed near zero for weeks (December 2025 reporting) `[UNV]`; the March 2026 Resolv event affected about 15 vaults; an `AlphaUSDC Delta V2` vault had about $18M stuck after the msY token fell up to 85% (20 June 2026; chain not stated) `[UNV]`. I found no Base-USDC-flagship vault with a documented multi-day full lock.

**Share price.** Can fall: losses realized in Blue markets reduce the vault's supply position. V1.1 accounts for it with `lostAssets` so later gains first recover the loss before fees; V1.0 instances (Gauntlet Prime, Steakhouse USDC) have no `lostAssets` (call reverts `[EXP]`). Protection against donation/inflation: virtual shares (offset 10^12) and accounting from the Blue positions rather than the raw token balance `[SRC]`. Documented residual: for 18-decimals assets protection is lower and deployers should seed `[SRC]`. Morpho Blue markets use virtual shares/assets (1e6 / 1) `[INF]`.

**Oracles.** None in the vault. Each underlying Morpho Blue market has an immutable oracle chosen when the market is created. Gauntlet USDC Prime's allocation (Morpho API `[UNV]`): cbBTC (about $370M), WETH (about $21M), cbETH, wstETH markets, all with `ChainlinkOracleV2` oracles and LLTV 77-86%.

**Observable before effect.** The timelocked items are public state: `pendingCap(Id)` returns (value, validAt), `pendingTimelock()`, `pendingGuardian()`, `config(Id).removableAt`; all emit events `[SRC]`. A contract can require `pendingTimelock().validAt == 0`, a minimum `timelock()` and the expected `owner/curator/guardian`, but cannot enumerate unknown market ids; a new cap is only visible if its id is known `[INF]`. Instant changes are visible only after the fact.

**Incidents and audits.**
- 4 Nov 2025 Stream xUSD / Elixir deUSD: MEV Capital USDC vaults booked haircuts of about 3.5% (Ethereum) and 12% (Arbitrum); Morpho said about 1 of 320 vaults had limited exposure `[UNV]` (`https://finance.yahoo.com/news/stream-finance-stablecoin-plunges-77-160515530.html`, `https://cryptorank.io/news/feed/dd09a-morpho-co-founder-illiquidity-in-defi-vault`).
- 22 Mar 2026 Resolv USR mint exploit: about 15 Morpho vaults with significant exposure, about $6.2M bad debt in 11 vaults, 96% in Gauntlet-curated vaults per a risk-rating post; Gauntlet disputes the scale `[UNV]` (`https://www.halborn.com/blog/post/explained-the-resolv-hack-march-2026`, `https://www.dlnews.com/articles/defi/kpk-declares-zero-loss-to-depositors-after-resolv-stablecoin-collapse/`).
- 20 Jun 2026 AlphaUSDC Delta V2: about $18M stuck, msY collapse `[UNV]` (`https://cryptobriefing.com/morpho-blue-vault-msy-collapse-loss/`).
- 2025 Morpho web-app front-end flaw (about $2.6M, intercepted by a white hat); not a contract flaw `[UNV]`.
- I found no exploit of Morpho Blue or MetaMorpho contracts themselves (negative search result, `[UNV]`).
- Audits `[DOC]` `https://docs.morpho.org/get-started/resources/audits`: Morpho Blue (OpenZeppelin 2023-10, Spearbit 2023-10, Cantina contest 2023-11/12); MetaMorpho V1 (Spearbit and OpenZeppelin 2023-11, Cantina contest); V1.1 (OpenZeppelin 2024-11-16, Spearbit 2024-11-23).

### 4.2 Morpho Vault V2

**Addresses.** Same Morpho Blue underneath through `MorphoMarketV1AdapterV2` adapters. Largest V2 USDC vaults on Base (Morpho API `[UNV]`, `totalAssets` `[EXP]`): Steakhouse High Yield Edition `0xbeeff2490FEffa212faC2f6553682C219E6a8845` (442.6M), Grove x Steakhouse `0xbeef0786756810478b88982DE00F3CD7fdB8e7c7` (429.6M), Gauntlet USDC Prime `0x050cE30b927Da55177A4914EC73480238BAD56f0` (287.8M), Steakhouse Prime USDC `0xbeef0e0834849aCC03f0089F01f4F1Eeb06873C9` (200.8M). Adapter for Steakhouse Prime: `0xfDd31Cdf6712c47A4e67037D9F2E35587f5404C0` (4 markets); for the High Yield Edition: `0x4a70DC70CeF79f51Cc7f79C08f863B2841311165` (10 markets); the adapter registry is `0x5C2531Cbd2cf112Cf687da3Cd536708aDd7DB10a` `[EXP]`. Vault code `https://github.com/morpho-org/vault-v2/blob/main/src/VaultV2.sol` (cloned at commit `ccab7caa`, 2026-11-23) `[SRC]`; the instances are Sourcify-matched as `VaultV2` and are not proxies `[SRC]` `[EXP]`.

**ERC-4626 and deviations.** The four `max*` functions return the constant 0 ("gross underestimation") `[SRC]`; spec-compliant but useless for integrators that size an exit with `maxWithdraw`. `virtualShares` = 10^12 on Steakhouse Prime `[EXP]`. Deposit and withdraw can revert if a gate, if present, rejects the caller `[SRC]`.

**Upgradeability.** None. Behaviour changes only through timelocked setters. Each function has a timelock (`timelock(selector)`) and can be abdicated, after which it can never be called `[SRC]`. Note: timelocks start at 0 on a fresh vault, so every instance must be read individually.

**Pausing and freezing** `[SRC]`: no pause. Four optional gates: `receiveSharesGate`, `sendSharesGate`, `receiveAssetsGate` (can lock users out of exiting), `sendAssetsGate` (deposit side only, "not critical"). A gate can block specific addresses. On all four instances above, the three exit-relevant gates are set to the zero address and **abdicated** (irreversible); `sendAssetsGate` is not abdicated (timelock 7 d) `[EXP]`. The allocator can set the liquidity adapter and data, which can hinder deposits and withdrawals, but `forceDeallocate` (anyone, penalty up to 2%) lets users pull in-kind from the adapter `[SRC]`. `receiveAssetsGate` abdication means USDC-level blacklisting is the only per-address block.

**Parameter powers and timelocks (read on-chain, seconds shown as days):**

| Function | Steakhouse Prime | Steakhouse High Yield Ed. | Grove x Steakhouse | Gauntlet Prime V2 |
| --- | --- | --- | --- | --- |
| `setOwner`, `setCurator` | 0 | 0 | 0 | 0 |
| `setIsAllocator` | 0 | 0 | 0 | 7 d |
| `addAdapter` | 7 d | 3 d | 7 d | 7 d |
| `increaseAbsoluteCap` / `increaseRelativeCap` | 7 d | 3 d | 7 d | 7 d |
| `setPerformanceFee`, `setManagementFee` | 0 | 0 | 3 d | 3 d |
| Fee recipients | 0 | 0 | 3 d | 0 |
| `setForceDeallocatePenalty` | 0 | 0 | 0 | 1 d |
| `increaseTimelock`, `abdicate` | 7 d | 7 d | 7 d | 7 d |
| `setAdapterRegistry` | abdicated | abdicated | abdicated | abdicated |
| Share/asset-receive and share-send gates | abdicated | abdicated | abdicated | abdicated |

Source: `[EXP]`, script reading `timelock(bytes4)` and `abdicated(bytes4)`. Current fee: Steakhouse Prime 0%, High Yield Edition 25%, Grove 0%, Gauntlet 0%. Max performance fee 50%, management fee 5%/yr, penalty 2% `[SRC]`. Roles `[DOC]` `https://docs.morpho.org/curate/concepts/roles`: owner (sets curator and sentinels), curator (timelocked risk changes, instant cap decreases), allocator (moves funds within caps, sets liquidity adapter and `maxRate`), sentinel (deallocate, instant cap decrease, revoke pending actions).

Owner of the Steakhouse vaults is `VaultV2Supervisor` `0x639bfA26472906Ccd40513408284a8aD292bC5D6`, a Steakhouse contract (verified on Sourcify `[SRC]`) that adds a timelock and guardian vetoes to owner actions; its own timelock and ownership I did not trace. Grove's and Gauntlet's owners `0x491EDFB0B8b608044e227225C715981a30F3A44E`, `0x5a4E19842e09000a582c20A4f524C26Fb48Dd4D0` (Gauntlet: Safe 4/7) `[EXP]`.

**Can any role move or seize depositor funds?** No role can transfer principal to an arbitrary address `[SRC]`. A curator can, after the timelock, add an adapter or raise caps. Allocators move funds between markets inside caps with no delay. The vault's own docs state that "the owner cannot do actions that can directly hurt depositors" and "the curator cannot do actions that can directly hurt depositors without going through a timelock" `[SRC]`. Gap: where `setIsAllocator` or fee setters have timelock 0 (see table), a curator can instantly add an allocator or raise a fee (to 50% of interest); losses are bounded by caps and by the fee applying only to interest `[INF]`.

**Liquidity delays.** Same as V1 plus idle assets and the liquidity adapter. `forceDeallocate` still depends on underlying market liquidity.

**Share price.** Can fall. `accrueInterestView` books `min(realAssets, maxTotalAssets)`: losses are recognized at once; gains are rate-limited by the allocator-set `maxRate`, which blunts donation-based manipulation. Management fee can lower the share price. Vault doc notes it "might need to be seeded" and rounding losses in adapters `[SRC]`.

**Oracles.** None in the vault; oracle risk sits in the underlying Morpho Blue markets (immutable per market) and any other adapter the curator adds.

**Observable before effect.** `executableAt(bytes data)` is public, `submit` emits an event, `timelock(selector)`, `abdicated(selector)` and the gate addresses are public `[SRC]`. A contract can pin "gates are zero and abdicated; adapter registry abdicated; `timelock(addAdapter) >= X`". It cannot discover an unknown pending calldata, so detection of a specific queued action requires knowing its exact bytes `[INF]`. Instant actions are not observable in advance.

**Incidents and audits.** V2 is newer (adapters launched 2025); no incident specific to V2 vault code found `[UNV]`. Audits `[DOC]`: Spearbit (2025-05-19, 2025-11-08), Cantina contest (2025-07-15), Zellic (2025-07-15), ChainSecurity (2025-09-15), Blackthorn (2025-09-15); adapters: Spearbit, Blackthorn, Certora; registry: Certora, Spearbit `https://docs.morpho.org/get-started/resources/audits`. Same underlying market incidents as 4.1.

### 4.3 Aave v3 (aUSDC and the ERC-4626 wrapper stataUSDC)

**Addresses (Base)** `[SRC]` `https://github.com/bgd-labs/aave-address-book/blob/main/src/AaveV3Base.sol`: Pool `0xA238Dd80C259a72e81d7e4664a9801593F98d1c5` (proxy, implementation `0xf248Dd0AdB01e78043e8a423b8504c8129F11918`), PoolAddressesProvider `0xe20fCBdBfFC4Dd138cE8b2E6FBb6CB49777ad64D` (owner = Base Level 1 executor), PoolConfigurator `0x5731a04B1E775f0fdd454Bf70f3335886e9A96be`, ACLManager `0x43955b0899Ab7232E3a454cf84AedD22Ad46FD33`, Level 1 executor `0x9390B1735def18560c509E2d0bc090E9d6BA257a`, aUSDC `0x4e65fE4DbA92790696d040ac24Aa414708F5c0AB` (proxy to `0x273E4B97C3f5280AFf4949Aa19a27fF54968458D`), stataUSDC `0xC768c589647798a6EE01A91FdE98EF2ed046DBD6` (proxy, implementation `0xbcb167bdcf14a8f791d6f4a6edd964aed2f8813b`; proxy admin `0xc85b1e333aecc99340b2320493fe2d22b8734795`) `[EXP]`. A legacy static aToken wrapper also exists `0x4EA71A20e655794051D1eE8b6e4A3269B13ccaCc`.

**Size and state `[EXP]`.** USDC reserve: 180.74M supplied, 166.73M variable debt, utilization 92.2%, available liquidity 14.0M, supply cap 230M, borrow cap 195M, liquidity rate about 4.29%, reserve factor 10%, paused = false. stataUSDC total assets only 0.40M.

**ERC-4626.** aUSDC is a rebasing aToken, not ERC-4626. stataUSDC (`StataTokenV2`) is ERC-4626 and documents "full EIP-4626 compatibility" `[DOC]` `https://github.com/aave-dao/aave-v3-origin/blob/main/src/contracts/extensions/stata-token/README.md`. Deviations `[SRC]`: `maxDeposit` is 0 if the reserve is inactive, paused or frozen, else the room under the supply cap; `maxRedeem` is 0 if the reserve is inactive or paused, else limited by the pool's virtual underlying balance (liquidity). `totalAssets()` is computed from `totalSupply` times the liquidity index, not from the token balance, so donations cannot move the share price `[SRC]`. The pool tracks a virtual underlying balance (`getVirtualUnderlyingBalance` = 14.0M `[EXP]`), also resisting donation manipulation.

**Upgradeability.** Pool, PoolConfigurator, aToken and the wrapper are upgradeable by Aave governance `[DOC]` `[SRC]`. The path: Ethereum governance vote (3 days vote, per Aave docs for Level 1 `[DOC]`), cross-chain controller, then Base `PayloadsController` `0x2DC219E716793fb4b21548C0f009Ba3Af753ab01` which enforces an executor delay of 86400 s (Level 1) and grace period 604800 s `[EXP]`. Governance Guardian `0x360c0a69Ed2912351227a0b745f890CB2eBDbcFe` is a Safe 5/9 and is the `guardian()` of the payloads controller `[EXP]` (it can cancel queued payloads `[INF]`). The "Granular Guardian" `0xa1c6aF35E0205f42256382C05243C543FEDBf4bB` is a contract of 7 KB; I could not read its role set `[EXP]` partial.

**Pausing and freezing** `[DOC]` `https://aave.com/docs/aave-v3/smart-contracts/acl-manager` and `[SRC]`: Emergency Admin can pause/unpause the pool or any reserve (blocks supply, withdraw, borrow, repay, liquidation for that reserve); Pool Admin can also pause reserves; Emergency Admin and Risk Admin can freeze (no new supply or borrow; withdrawals, repay and liquidation continue). The wrapper `setPaused` is callable by any Emergency Admin and `_update` is `whenNotPaused`, so a pause blocks wrapper transfers and redemptions `[SRC]`. I could not identify the on-chain holder of the Emergency Admin role on Base: `isEmergencyAdmin` is false for the Governance Guardian, the Granular Guardian, the executor and the Risk Council `[EXP]`. Forum text says the Protocol Guardian multisig holds emergency authority on 19 networks and was being reconfigured to 4 of 7 `[UNV]` (`https://governance.aave.com/t/aave-emergency-guardian-protocol-signer-rotation/24944`).

**Parameter powers.** Risk Admin: caps, LTV, liquidation parameters, rates (through Risk Steward contracts with limits and cooldowns); Asset Listing Admin: oracle sources; Pool Admin: token implementations, flash-loan premium; ACL Admin = executor `[DOC]` `[EXP]`. Interest-rate strategy `0x86AB1C62A8bf868E1b3E1ab87d587Aba6fbCbDC5` (shared by many reserves) `[SRC]`.

**Can any role move or seize depositor funds?** No role has a function to transfer user funds. Governance can upgrade the pool or aToken (after 1 day on Base), which could in principle do so `[INF]`. `Rescuable` on the wrapper lets the ACL admin rescue only surplus aTokens beyond backing `[SRC]`.

**Liquidity delays.** Exits are limited to unborrowed liquidity. Now 14.0M of 180.7M (utilization 92%). Past: during the rsETH event, WETH reserves on Ethereum, Arbitrum, Base, Linea and Mantle were at 100% utilization with under $20 idle on each chain (about 18-20 April 2026) `[DOC]` (`https://governance.aave.com/t/rseth-incident-report-april-20-2026/24580`); the report does not state how long withdrawals were blocked. No USDC-specific lock on Base found.

**Share price / bad debt.** The aToken and the wrapper rate follow the liquidity index and do not fall mechanically. Bad debt appears as a reserve deficit (USDC Base: 30.9 USDC `[EXP]`), and who absorbs it is decided by governance, the Umbrella staking module or the DAO treasury. The 20 April 2026 report models both a uniform socialization (about $123.7M) and an L2-isolated one (about $230.1M, with a 23.28% WETH shortfall on Base) in which "unrecovered shortfalls would fall on reserve depositors" `[DOC]`. A 24 April 2026 funding proposal sought 25,000 ETH from the Aave DAO plus donations and a Mantle credit facility; I did not find a final outcome `[UNV]` (`https://governance.aave.com/t/arfc-rseth-incident-funding-update/24740`).

**Oracles.** `AaveOracle` `0x2Cc0Fc26eD4563A5ce5e8bdcfe1A2878676Ae156` with Chainlink feeds; USDC oracle `0xf52D010c7d4ecBfda92c2509900593CE34535D86` `[SRC]`. The USDC supplier's exposure is to all collateral assets' oracles and to the bad-debt rules.

**Observable before effect.** Governance changes: yes, as a queued payload on `PayloadsController` for 24 h (public getters). Guardian freeze or pause: immediate, no notice. A contract can poll `Pool.getConfiguration(USDC)` for the pause/freeze bits, but only after the action `[INF]`.

**Incidents and audits.**
- Nov 2023: guardian precautionary pause of the Aave v2 Ethereum market and freezes on some v3 assets (Polygon, Arbitrum, Optimism); Base unaffected; no losses reported `[UNV]` (`https://ca.investing.com/news/cryptocurrency-news/aave-freezes-assets-on-numerous-chains-are-funds-safe-3166064`).
- 18-20 Apr 2026 Kelp DAO rsETH bridge exploit (116,500 rsETH): Protocol Guardian froze all rsETH and wrsETH reserves (including Base) and froze WETH on Base and other chains; bad debt estimated $123.7M to $230.1M `[DOC]` (Aave forum report above).
- 29 Oct 2026: after a reported Binance hot-wallet breach, guardians froze new deposits and borrows across 175 v3 reserves and 117 v4 reserves, reopened 30 Oct; withdrawals stayed available; no supplier losses reported `[UNV]` (single source: `https://crypto.news/aave-wasnt-hacked-why-did-its-users-face-restrictions/`).
- Audits `[SRC]` (repository folder `https://github.com/aave-dao/aave-v3-origin/tree/main/audits`): OpenZeppelin, Trail of Bits, PeckShield, Certora, ABDK, Sigma Prime (2021-22); Certora/MixBytes/Cantina/Enigma/Sherlock/Oxorio/Pashov/StErMi/Blackthorn through v3.6 (2025-11); StataTokenV2 audited by Certora (2024-09-11) and MixBytes (2024-12-05).

### 4.4 Spark USDC Vault (`sUSDC`) on Base

**Addresses.** Vault proxy `0x3128a0F7f0ea68E7B7c9B00AFa7E41045828e858` (ERC-1967 UUPS; implementation `0x6ACC02ddd82206a44ff4EC13977E63d1a29C7723`, `UsdcVaultL2`) `[SRC]` `https://github.com/sparkdotfi/spark-address-registry/blob/master/src/Base.sol`; PSM3 `0x1601843c5E9bC251A3272907010AFa41Fa18347E`; SSR auth oracle `0x65d946e533748A998B1f0E430803e39A6388f7a1`; Spark Executor `0xF93B7122450A50AF3e5A76E1d546e95Ac1d0F579`; ALM proxy `0x2917956eFF0B5eaF030abDB4EF4296DF775009cA`. Spark's own docs list `spUSDC` only on Ethereum, Avalanche and X Layer and do not mention this Base vault `[DOC]` (`https://docs.spark.finance/dev/savings/spark-vaults-v2`); it is the "V1 USDC vault" of the address registry. State `[EXP]`: total assets 3.93M USDC; PSM3 holds 1.0M USDC in its pocket (itself) and `totalAssets` of PSM3 is about 5.44M in USD terms; the ALM proxy holds 23 USDC.

**ERC-4626.** Implements the interface with extra overloads (slippage-protected `deposit/mint/withdraw/redeem`, referral codes) and an `exit(shares, receiver, owner)` that redeems sUSDS directly `[SRC]` (`https://github.com/sparkdotfi/spark-vaults`, commit `78d37c8`, 2025-07-25). `max*` reflect PSM3 USDC liquidity: README states "The available liquidity for the different operations (except `exit`) is limited by the PSM funds" `[SRC]`.

**Upgradeability.** UUPS; `_authorizeUpgrade` requires `auth` (the `wards` set); `wards(Spark Executor)` = 1 `[EXP]` `[SRC]`. Base executor `delay()` = 0, grace 7 days `[EXP]`. A November 2024 Sky poll proposed lowering the Base executor delay from 100 s to 0 s `[UNV]`. The effective timelock sits on Ethereum: Sky's governance pause delay (18 h in April 2025; a rise to 48 h was proposed, status unverified) and "standby spells" can bypass it `[UNV]` (`https://pablos-buch.gitbook.io/maker-operational-manual/parameters/core-protocol-parameters/param-gsm-pause-delay`).

**Pausing.** The vault has no pause or freeze (only the Spark Vaults V2 docs say so explicitly, `[DOC]`; for this V1 L2 vault, none exists in source `[SRC]`). User exits fail only if PSM3's USDC runs low; the `exit()` hatch returns sUSDS. The PSM3 owner (Spark Executor) can call `setPocket`, moving all PSM3 USDC to a new custodian `[SRC]`. For Spark Vaults V2 (not on Base) docs mention a "recovery mode" that can halt withdrawals `[DOC]`.

**Parameter powers.** Wards only. No fee in the vault.

**Move or seize funds.** Only through an upgrade by Spark governance `[INF]`.

**Liquidity delay.** As above: about a quarter of vault assets could be withdrawn in USDC today (1.0M of 3.93M); the rest only through `exit()` into sUSDS. Spark docs say the Ethereum vault keeps up to $10M for atomic redemptions and uses "Savings Liquidity Intents" for larger ones (Ethereum and X Layer only) `[DOC]`.

**Share price.** The vault wraps sUSDS via PSM3 and the Sky Savings Rate oracle; the rate is set by Sky governance and relayed to Base; it rises monotonically by construction `[INF]`. Loss paths: upgrade, oracle fault, PSM3 liquidity or USDS failure. Docs for the Ethereum vault say losses are absorbed first by Prime junior capital and the Surplus Buffer, and "as a last resort" socialized across USDS holders `[DOC]` (`https://docs.spark.finance/user-guides/earning-savings/spusdc`).

**Oracles.** `SSRAuthOracle` (rate relayed from Ethereum through an Optimism-style receiver) `[SRC]`; USDC/USDS 1:1 in PSM3.

**Observable before effect.** On Base: no (executor delay 0). On Ethereum: spells are visible in Sky's pause proxy `[INF]`.

**Incidents and audits.** No exploit of the Base vault found `[UNV]`. Audits: ChainSecurity SparkVaults (2025-01-24) and Cantina (2025-02-26) in the repo; ChainSecurity and Cantina PSM3 reports `[SRC]` `[UNV]` (`https://reports.chainsecurity.com/Spark/ChainSecurity_Spark_SparkPSM_Audit.pdf`).

### 4.5 Fluid fUSDC

**Addresses.** fUSDC `0xf42f5795D9ac7e9D757dB633D693cD548Cfd9169` (non-proxy `fToken`, 5.85M USDC) `[EXP]` `[SRC]`; Liquidity layer (same address on every chain) `0x52Aa899454998Be5b000Ad077a46Bbe360F4e497`; its admin (InfiniteProxy `getAdmin`) `0x4d6CE4F4498d59Eed397bCbC687805a07f9b2346`, an OpenZeppelin `TimelockController` with `getMinDelay` 86400 s; team multisig (Avocado) `0x4F6F977aCDD1177DCD81aB83074855EcB9C2D49e` holds the PROPOSER and CANCELLER roles on that timelock and not EXECUTOR `[EXP]`. Source `https://github.com/Instadapp/fluid-contracts-public`.

**ERC-4626.** Yes, with EIP-2612 deposits `[EXP]` `[UNV]`. Withdrawals draw from the shared Liquidity layer and are subject to per-user withdrawal limits that expand over time `[SRC]` (`updateUserWithdrawalLimit`, `updateUserSupplyConfigs`).

**Upgradeability.** fToken, vaults, DEX pools: not upgradeable in place `[DOC]`. Liquidity layer: upgrade by governance only; the team multisig can roll back within 7 days; on Base governance = the timelock above (the repo doc says L2 admin is the team multisig `[DOC]`; the chain shows a 1-day TimelockController with that multisig as proposer `[EXP]`). Mainnet is governed by GovernorBravo with a 1-day timelock `[UNV]` (`https://curation.yearn.fi/report/fluid/`).

**Pausing and freezing** `[SRC]` (`contracts/liquidity/adminModule/main.sol`): guardians (added by governance) can `pauseTokens`, `pauseUserSupply` (with withdraw mode), `pauseUserBorrow`; auths can `changeStatus` (pause the whole Liquidity layer), set token configs, rates, per-user limits and run `operateOnBehalfOf`. A pause of a user's withdrawals and a pause of the whole layer are both possible. Third-party report: the Guardian "can pause Class 0 protocols only" and "cannot move Liquidity Layer funds" `[UNV]`. Mainnet team multisig rate changes are capped (kinks plus or minus 10 points, 1-day cooldown) `[DOC]`.

**Parameter powers.** Governance only: add or remove auths and guardians, revenue collector, raw rate curve. Team multisig through scoped auth contracts: rate curve within caps, borrow-limit changes, DEX parameters, pause flows, vault fee knobs `[DOC]`. The team multisig cannot change vault oracles or core risk parameters on mainnet `[DOC]`; on L2 the doc says the multisig is the final admin `[DOC]`.

**Move or seize funds.** No role listed has a function to move supplier funds; the guardian "cannot move liquidity layer funds" `[UNV]`; a timelocked upgrade of the Liquidity implementation could `[INF]`.

**Liquidity delays.** Withdrawals limited by Liquidity-layer liquidity and per-user limits. Fluid's own lending funds are commingled with borrowing vaults and DEX positions `[UNV]`. In the March 2026 stress, Fluid paused new borrows and froze deposits in about 30 minutes, with a net outflow above $300M in one day; no supplier lock is reported `[UNV]`.

**Share price.** The fToken exchange price comes from the Liquidity layer and rises; I found no mechanism that lowers it other than bad debt that reaches suppliers `[INF]`. Mar 2026: bad debt of about $19.3M to $21M from the Resolv USR depeg was "100% covered" by a short-term loan from named individuals and the Fluid team, described as "discretionary and off-balance-sheet" with no contractual duty to cover future losses `[UNV]`. No on-chain donation vector: `[INF]`.

**Oracles.** For vault liquidations: Chainlink primary with Uniswap V3 TWAP and Redstone fallbacks and custom center-price oracles; some vaults price pegged assets at exactly 1 (e.g. sUSDai vaults, about $214M debt) `[UNV]`. Oracle source configuration is immutable once deployed; the vault's oracle pointer is changeable by vault admin or governance `[DOC]`.

**Observable before effect.** Upgrades and timelocked governance calls: yes (`CallScheduled` events, `isOperationPending`). Guardian pauses and auth actions: no.

**Incidents and audits** `[UNV]` (`https://curation.yearn.fi/report/fluid/`, `https://ambcrypto.com/fluid-incident-explained-how-oracle-failures-triggered-nearly-20-mln-in-bad-debt/`):
- 22 Mar 2026 Resolv USR: new borrows paused and deposits frozen on affected vaults within about 30 minutes; $19-21M bad debt; Fluid contracts were not exploited; Fluid treasury contributed $8.2M, Resolv about $9.7M.
- 18 Apr 2026 Kelp rsETH: Fluid froze rsETH markets within hours, alongside Aave and Spark.
- Mid-2026: pauses of a USDai/USDC vault (14 Jun) and sUSDS-borrowing vaults (11 Jul) per the same report.
- A $215K theft tied to the Merkle rewards system (separate) `[UNV]`.
- Audits: PeckShield, StateMind (2023), MixBytes (vault 2024; Liquidity layer Sep-Dec 2025), Cantina and MixBytes (DEX 2024), StateMind (Liquidity 2025); no formal verification; Immunefi bounty up to $500K `[UNV]`.

### 4.6 Euler v2 (EVK vaults and Euler Earn)

**Addresses.** EVC `0x5301c7dD20bD945D2013b48ed0DEE3A284ca8989`, eVaultFactory `0x7F321498A801A191a93C840750ed637149dDf8D0`, EVault implementation `0x30a9A9654804F1e5b3291a86E83EdeD7cF281618`, EulerEarn factory `0x75F49a2621b6DeC6a5baB22ce961bF3e676EFAE6` `[SRC]` (`https://github.com/euler-xyz/euler-interfaces/tree/master/addresses/8453`). Base USDC EVK vaults are small: the largest by DefiLlama net TVL (`eUSDC-91`, `eUSDC-1`) are under $0.3M `[UNV]`.

**ERC-4626.** Yes (EVK vaults and Euler Earn implement ERC-4626).

**Upgradeability.** EVK vaults are created by a factory as either upgradeable `BeaconProxy` or non-upgradeable minimal proxies `[SRC]`. The factory's `upgradeAdmin` on Base is `0x605Aaf2CAD625dd5F855Bb055625cc1926f10A56` (governor access control) behind a `TimelockController` `0x8452eF09799601b4993E1c0CADF65297587186B4` with minDelay 345600 s (4 days); the DAO Safe `0x1e13B0847808045854Ddd908F2d770Dc902Dcfb8` is 4 of 8 `[EXP]`.

**Pausing and freezing.** The vault governor (`governorAdmin`, per vault) can instantly: change LTVs, caps, interest-rate model, liquidation parameters, interest fee, fee receiver; and `setHookConfig(address(0), hookedOps)`, which sets hooked operations to revert with `E_OperationDisabled`, so a governor can disable `withdraw` and `redeem` with no timelock `[SRC]` (`https://github.com/euler-xyz/euler-vault-kit`, `Governance.sol`, `Base.sol`). A vault with the governor set to the zero address has none of these powers; I did not check which Base USDC vaults are governance-free.

**Euler Earn** is a MetaMorpho-style vault: timelock 1 day to 2 weeks, curator, allocator, guardian `[SRC]` (`https://github.com/euler-xyz/euler-earn`).

**Move funds.** No transfer function for the governor. **Share price.** Can fall: bad debt in a lending vault is socialized to suppliers. **Liquidity delays.** As for any pooled lender. **Oracles.** Per-vault price oracles via the EVC oracle router.

**Observable.** Factory upgrades: yes (4-day timelock). Vault-governor changes: no warning.

**Incidents and audits.** Euler v1 exploit (March 2023, about $197M, later recovered) is the well-known event, not re-verified here `[UNV]`. Euler v2: after the Stream xUSD collapse (Nov 2025), Euler oracle updates were reported as late, with bad-debt risk `[UNV]`; on 22 Mar 2026 Euler disabled the RLP collateral in an Arbitrum Yield vault and stopped Euler Earn USDC on Arbitrum from allocating to it `[UNV]` (`https://www.kucoin.com/news/flash/euler-labs-disables-rlp-collateral-function-amid-unauthorized-minting-of-usr`). Audits in repo: EVK (OpenZeppelin, Spearbit, Certora, ChainSecurity, Omniscia, yAudit, Enigma Dark, Cantina contest and others); Euler Earn (Certora, Sigma Prime, Pashov) `[SRC]`.

### 4.7 Compound v3 cUSDCv3 (excluded: not ERC-4626 on Base)

`cUSDCv3` `0xb125E6687d4313864e53df431d5425969c15Eb2F`, configurator `0x45939657d1CA34A8FA39A924B71D28Fe8431e581`, bridge receiver `0x18281dfC4d00905DA1aaA6731414EABa843c468A`, Bulker `0x78D0677032A35c63D142a48A2037048871212a8C` `[SRC]` (`https://github.com/compound-finance/comet/blob/main/deployments/base/usdc/roots.json`). State `[EXP]`: supplied 7.35M, borrowed 6.46M, utilization 87.9%, `isSupplyPaused` and `isWithdrawPaused` both false. Not ERC-4626: the official ERC-4626 `CometWrapper` has Base USDC "Upcoming" `[DOC]` (`https://github.com/compound-finance/comet-wrapper`), and I did not find a deployed Base wrapper.

Permissions: the Comet is a proxy whose admin `0xbdE8F31D2DdDA895264e27DD990faB3DC87b372d` is owned by the Base Timelock `0xCC3E7c85Bb0EE4f09380e041fee95a0caeDD4a02` (delay 86400 s, grace 1,209,600 s; admin = bridge receiver) `[EXP]`. `pauseGuardian` is a Safe 5 of 9 `0x3cb4653F3B45F448D9100b118B75a1503281d2ee`; `pause()` can be called by it or by the governor and freezes supply, transfer, withdraw, absorb or buy `[SRC]` `[EXP]`. Governor can `withdrawReserves` and set the configurator parameters; markets can also have a "market admin" role in newer code (`governorOrMarketAdmin`) `[SRC]`, whose status on Base I did not check. Price feed: Chainlink USDC/USD at `0x3e6D1ccA8Eee6d02f1f578B613374EB53E6823B4` `[EXP]`. Incidents: no Compound III depositor loss found; April-May 2026 reports say the Kelp attacker also opened a Compound v3 position and governance adjusted a collateral oracle (secondary sources only) `[UNV]` (`https://blockonomi.com/how-compound-governance-triggered-a-30m-recovery-from-the-kelpdao-exploit/`). Audits: not re-read.

## 5. Acceptability rubric (for the owner to decide)

The rubric is about what a stranger or a compromised party can do to a generation that cannot react. Three levels, strict to lenient. Each level is cumulative on the one above in the sense of what it excludes, not on the list of candidates.

### Level 1: Strict ("the vault code is fixed; every risk increase is visible and slow")

All must hold:
1. Native ERC-4626 on Base with a deployed instance of at least $50M assets.
2. The vault is not upgradeable (no proxy, no upgrade function).
3. No role can pause, gate or blacklist withdrawals, or any such power is abdicated irreversibly.
4. No role can transfer depositors' assets to an arbitrary address; funds only move between markets that are inside caps.
5. Every action that raises risk (new market or adapter, higher cap, new allocator or guardian) is behind an on-chain timelock of at least 3 days and can be revoked by a separate role. Instant powers are limited to risk reduction, plus a fee on interest only.
6. The share-price manipulation guard is in code (virtual shares) and the pending changes are readable on-chain.

Pass:
- Morpho Vault V1 (MetaMorpho): Gauntlet USDC Prime (7 d timelock, no fee), Steakhouse USDC and Steakhouse Prime (7 d). Caveat: owner can instantly set curator and allocators and a fee up to 50% of interest; Gauntlet's owner, curator and guardian share the same 7 signers; Steakhouse USDC's guardian is an EOA.
- Morpho Vault V2: Gauntlet USDC Prime V2 (all risk-increasing functions at 3-7 d; allocator and gate changes 7 d), Grove x Steakhouse (7 d on adapters and caps; fee setters 3 d), and, with weaker instant powers, Steakhouse Prime (`setIsAllocator`, fees, penalty at 0 s) and Steakhouse High Yield Edition (adapter and cap delay 3 d; fees at 0 s).
- Not passing: Aave stata, Spark, Fluid, Euler, Compound (all upgradeable or able to pause withdrawals).

Note on what this level does not cover: it does not stop loss through a bad oracle or bad collateral in a Morpho Blue market that the curator legitimately enabled; the 2025-26 incidents (4.1) were of this type.

### Level 2: Standard ("governed, but slow, and withdrawals are only paused by a multisig")

All must hold:
1. ERC-4626 on Base (a wrapper counts).
2. Upgrades and parameter changes of core contracts only through an on-chain timelock of at least 24 h on Base itself, with a cancel path.
3. Withdrawal pause is allowed but only by a multisig of at least 5 signers or by governance; no single key.
4. No role can transfer user funds except through the timelocked upgrade path.
5. At least two public audits and at least 2 years of production.

Pass: everything that passes Level 1, plus:
- Aave v3 through `stataUSDC` (1-day Base executor delay; 5 of 9 guardian can cancel payloads; emergency admin can pause the wrapper and the reserve; wrapper holds only 0.4M, so size is a concern, not a rule failure).
- Fluid fUSDC (1-day TimelockController with team multisig as proposer; guardians and auths can pause withdrawals; multisig threshold not verified, so conditional on item 3).
- Compound v3 satisfies items 2-5 (1-day Base timelock; 5 of 9 pause guardian) but fails item 1 on Base; it would pass only if a wrapper is deployed.
- Euler Earn passes if its guardian and timelock meet item 2; plain EVK vaults fail (instant governor power to disable withdrawals).

Does not pass: Spark USDC Vault (Base executor delay 0; the delay is off-chain from Base's point of view).

### Level 3: Lenient ("accept a named operator and track record")

All must hold:
1. ERC-4626 on Base.
2. At least one independent audit and 1 year in production.
3. A named operator or DAO controls upgrades; the delay is allowed to sit on another chain.
4. Operators may pause or limit withdrawals.

Pass: all of the above, plus Spark USDC Vault (Spark governance; delay 0 on Base, Sky governance delay on Ethereum), Euler EVK vaults (vault-governor controlled), and smaller Morpho Vault V1 instances (Pangolins, Moonwell Flagship, Yearn OG; delays 3-4 d, instance-specific). Compound v3 still fails item 1.

### How the two decision outcomes map

- If the owner insists on Level 1: Morpho V1 and V2 are the only candidates; the fallback "no interest" is not forced, but the vault choice, instance, and its curator/guardian become the single trust point.
- If the owner accepts Level 2: add Aave and Fluid; both still carry a governance upgrade and guardian pause.
- Interest is available at all three levels from Morpho; nothing in this survey requires going below Level 1 to get an interest-bearing vault, with the caveat about curator/oracle risk in the next section.

## 6. Open uncertainties (least sure first)

1. Emergency admin on Aave Base: I could not find the on-chain holder of the Emergency Admin role (`isEmergencyAdmin` false for the guardians I tried) nor the Granular Guardian's role set. The "Protocol Guardian 4 of 7" claim comes from a forum post `[UNV]`. Level 2 conclusions for Aave depend on this.
2. Fluid team multisig (Avocado) threshold: one third-party report says 6 of 12 (reduced on 9 Sep 2026) `[UNV]`; I could not read it on-chain (non-Safe contract). Fluid's own doc says L2 admin is the team multisig, while the chain shows a 1-day TimelockController; whether that timelock was in place at all times is unknown. Whether the multisig can execute the timelock (EXECUTOR role not held by it; open executor assumed `[INF]`).
3. Spark effective delay: the Sky governance pause delay value (18 h or 48 h) and the standby-spell bypass are from search results `[UNV]`; Spark's docs do not list this Base vault; the Spark vault's economics on Base (share price drivers) are partly inferred.
4. Morpho V2 instance timelocks are instance-specific and can be changed by the owner/curator; the table is a snapshot. `VaultV2Supervisor`'s own timelock and owner were not traced. The `main` branch source may differ from the deployed bytecode.
5. All 2025-26 incident details (Stream xUSD, Resolv, Kelp, Binance-related freeze, Aave outcome of the rsETH funding, AlphaUSDC) come from news or forum posts; the Oct 2026 Aave freeze rests on one article. Amounts conflict across sources. The Morpho Blue "no exploit" statement is a negative search result only.
6. Euler Base USDC sizes and which vaults are governance-free were not verified; DefiLlama's `tvlUsd` is net of borrows.
7. Historical maximum utilization and the longest withdrawal blockage for the Base USDC markets were not found (Aave's report gives no duration). I only have the current utilization (Aave 92.2%, Compound 87.9%).
8. Compound's "market admin" role status on Base, and the Compound audit list, were not checked.
9. Share-price manipulation protections for Fluid and Euler are inferred from design, not from a source review of their conversion code.
10. Several vault and Safe addresses come from the Morpho API and Safe reads; signer identities, key custody and operational security of the Safes are out of scope and unknown.
