# ADR 0001 — TypeScript 模組化後端與隔離 signer

狀態：採用於架構基線；日期：2026-09-22。

## 背景與選擇

v0.1 單 maker、少量市場、外部 agent 接入、链下 LLM/資料 IO、鏈上資金帳本，優先要求可追溯、穩定與低維運成本。

| 方案 | 效能與可靠性 | 開發／營運代價 | 決定 |
| --- | --- | --- | --- |
| TypeScript / Node.js | 適合併發 IO；CPU 重工作需分程序 | 前後端 schema 共用、EVM tooling 一致 | 採用 |
| Go | 資源效率與併發可控 | 增加跨語言 schema 與 agent tooling 成本 | 有量測瓶頸後再評估局部替換 |
| Python | 模型／研究生態方便 | Web/EVM 再一套型別與部署，当前無 Python-only 需求 | 後續特定研究可獨立 job |
| Rust | 嚴格型別與高效資源控制 | 目前負載不抵銷實作與審查時間 | 暫不採用 |

以上是本案取捨，不是 benchmark 結論。Node.js 22.23.1 是目前已存在且能驗證的固定基線；API 採 Fastify 5。框架相容性參考 [Fastify LTS](https://fastify.dev/docs/latest/Reference/LTS/) 與 [Next.js 安裝要求](https://nextjs.org/docs/app/getting-started/installation)。套件精確版本及 transitive lock 以 package.json / pnpm-lock.yaml 為準，不能從規格猜測已驗證版本。

## 資料層

PostgreSQL 17 作單一關聯式來源；一個 DB、分 schema/table ownership。明確 SQL migrations 與交易優先；M2 adapter 採 pg + SQL，當時鎖版，暫不引入 ORM。NUMERIC(78,0) + uint256 check，不使用 JS number 轉金額。

Postgres outbox/job queue 足以開始；`FOR UPDATE SKIP LOCKED` 支援多 consumer 競爭領取 queue rows，但不能拿跳過鎖的讀法檢查資金一致性，預算與 reservation 要明確 lock。同 DB 交易避免業務 commit 後工作消失。[PostgreSQL SELECT](https://www.postgresql.org/docs/17/sql-select.html)

不引入 Redis/Kafka/獨立搜尋引擎；若有實際 queue 延遲或資料庫壓力，先量測、調索引/併發，再經 ports 替換。

## 合約與簽章

Solidity 0.8.30 + Foundry，帳本非升級；標準 token／ECDSA／權限預定採固定版 OpenZeppelin，M1 引入。這次只固定 Quote struct 與介面，未導入未使用 library。

EIP-712 型別順序有跨語言測試；domain chainId=84532、verifier=部署地址。協定本身不解決 replay，consumed/cancelled/epoch/expiry 在 M1 實作。[EIP-712](https://eips.ethereum.org/EIPS/eip-712)

Signer 與普通 worker 分開 secrets、credential、network identity；內部不同角色分 key。ADMIN/裁決角色採人工錢包，API 不取得這些 key。憑證與金鑰隔離需在 M3/部署驗收，不以 TypeScript type 當權限控制。

## 代價與重審條件

共用 PostgreSQL 是初期故障集中點；需 managed backup、還原演練與連線池。Node CPU 長任務會阻塞 event loop；解析重任務放 worker 子程序，RFQ 路徑不跑 LLM。沒有 K8s、跨區 active-active 或多 maker；需求出現時再立 ADR。

升級 Node／Next／React／Fastify 與 image patch 時，重跑 lockfile install、typecheck、契約測試及 build。正式部署另固定映像 digest 與產出 SBOM，不將本地 Compose 當 production manifest。
