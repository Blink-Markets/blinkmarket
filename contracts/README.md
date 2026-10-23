# Blink 合約 — M1

已實作非升級 BlinkTestUSD 與 BlinkMarket：固定角色、maker free collateral、完整抵押成交、EIP-712、取消/epoch、內部持倉、提案/挑戰/仲裁/逾時/贖回。鏈 ID 固定 84532；本機測試也使用此 ID。

固定工具：Solidity 0.8.30、OpenZeppelin 5.6.1、Foundry 1.7.1、EVM Cancun、optimizer 200、viaIR。Foundry 經 npm 鎖版，無需全域安裝；第一次 native 編譯需下載固定 solc。

在 repo root 執行：

```sh
pnpm check:contracts
pnpm test:contracts
pnpm test:contracts:seeds
pnpm replay
```

- check:contracts 編譯完整合約，產生 contracts/artifacts/{BlinkMarket,BlinkTestUSD}.json，含 ABI、ABI hash、creation bytecode/hash。Artifacts 可重新產生，不入版控。
- test:contracts 執行行為、fuzz、惡意 token 與 ghost ledger invariants。
- test:contracts:seeds 使用固定 0x01/0x02，每個 128 runs × 64 operations；每個 run 結束強制結算贖回檢查無殘餘 escrow。
- replay 啟動自己的 loopback Anvil，使用公開測試助記詞，驗證三個 REPLAY；結束自動停止，不接受外部 RPC URL。輸出本機 report 與 spec 精確 bytes。

請透過 package scripts 或 scripts/foundry.mjs 執行，避免 npm 原 wrapper 未傳遞 child failure exit code。CI 已使用修正的 runner。

constructor 檢查 collateral code/decimals，正式部署還必須以 manifest、ABI/runtime bytecode hash 與鏈上 getters 核對是正確 BlinkTestUSD，不能只用6位小數辨識資產。Getter 的 proposedOutcome / finalOutcome 必須搭配 state 判斷是否存在，不把 enum 預設值當已公布答案。

沒有 Sepolia 部署、真實資產或外部安全審計。測試矩陣與限制見 [M0/M1 交付記錄](../docs/M0_M1_DELIVERY.md)。

## P1 Task 4: market creation slice

`protocol/BlinkMarkets.sol` adds permissionless templates, class-dependent creation windows,
creator bonds and exposure limits, the global juror security bound, creator role locks,
and resolution-only creation/result state hooks. `IBlinkMarkets.Market` keeps its URI in
the separate `specURI(id)` getter; `MarketCreated` includes the URI.

Spec uniqueness is per creator, keyed by `keccak256(abi.encode(creator, specHash))`
in `usedSpecHashes`. Every market on an unreviewed template gets the extra review
window until one market reaches OPEN through `open` or a rejected creation challenge.
Cancellation does not review the template. Creation requires `openAt < closeAt`.

Creation tests use the real registry and jurors, predicted resolution caller, and a
test-only finalized-count stub. Run them with
`node scripts/foundry.mjs forge test --root contracts --match-path test/protocol/MarketsCreation.t.sol`.
They cover bond accounting, phase-in and credit, windows, security limits, cancellation,
role locks, reward streaming, access control, and failure rollback.

This is a partial P1 delivery: Task 5 adds trading, Tasks 6–7 provide real resolution,
and Task 8 adds FINAL bond return, exposure release, creator unlock, credit and the
finalized counter. Until Task 8, `finalizedCount()` returns zero and FINAL hooks only
record state/outcome. An early rejected creation challenge sets OPEN with the original
future `openAt`; trading must enforce that timestamp. No deployment was performed.

Fix round 1: 30 focused tests (including 256 cancellation fuzz cases), all 121
Solidity tests, and `pnpm check:contracts` passed; BlinkMarkets runtime is 9,693
bytes. The alerts TypeScript suite is skipped per the controller's fix instructions;
the controller verifies `pnpm check` on main. This worktree does not claim that
repository-wide check passed.

## P1 Task 7: dispute arbitration slice

`protocol/BlinkResolution.sol` adds snapshot-weighted commit/reveal arbitration,
permissionless per-vote settlement, same-level restarts and bounded appeals for both
creation and result disputes. No function enumerates jurors. Bond loops have at most
five entries: two initial parties and three appeals (`maxRounds <= 4`).

`getDispute(disputeId)` returns the dispute and its current round aggregates. Use
`currentRound` in commitments and `settleVote(disputeId, round, juror)`; this attempt
number increases on restarts and appeals. `appealRound` selects the quorum and credit
parameters and increases only on appeal. Snapshots use round start minus one second.
Vote weight is the smaller of snapshot stake and current active plus pending stake.
RESULT reveals accept only YES/NO; choice 2 reverts `InvalidChoice`. A tied or
inquorate round restarts; only the hard deadline permits final INVALID.
`RoundRestarted`, `RoundSettled` and `Appealed` carry both the attempt index and
appeal level. A restart event identifies the newly opened attempt.

Creation-side appellants use CREATOR; result proposal-side appellants use PROPOSER.
Both challenger sides use CHALLENGER. Existing losing-side bond posters appeal
under their recorded role even if it is exiting; new entrants need an active role.

After `settleRound`, anyone can settle losers. Settle all losers at an appeal level,
including non-revealers from restarted attempts, before claiming coherent jurors'
token rewards. Coherent claims wait until that round is appealed or the dispute is
finalized. Each vote unlocks exactly once. Only the final round earns JUROR credit:
a loser settled early needs another `settleVote` after `finalizeDispute` for credit.
After timeout, remaining votes only unlock. bUSD cuts transfer to jurors before
`notifyReward` and follow its existing seven-day stream.

The focused command is
`node scripts/foundry.mjs forge test --root contracts --match-path 'test/protocol/{ResolutionDispute,ResolutionBasic,Jurors}.t.sol'`.
Fix round 1: all 92 focused tests, all 202 Solidity tests (`pnpm test:contracts`)
and `pnpm check:contracts` pass after rebasing onto Task 5. BlinkResolution runtime
is 20,113 bytes. With 1 versus 60 committers, `settleRound` uses identical gas and
`settleVote` differs by 20 gas on both decisive and restart paths. This remains a
partial P1 delivery. Real Task 5 signed fills seed positions; only Task 8's finalized-count fixture
remains in the test-local markets subclass. Real registry, jurors, trading, creation
and resolution hooks are exercised. Task 8 still supplies
RESULT bounty payout, redemption and FINAL creator accounting. Full TypeScript
verification remains the controller's gate on main. No deployment was performed.
