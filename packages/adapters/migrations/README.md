# SQL migrations

0001_foundation 建立 domains、runtime roles 與 operations 基礎表；0002_identity 建立邀請與 wallet binding；0003_preparation 建立證據與候選；0004_approval 建立部署驗證、specs、approvals、creation_intents 與 active_slots，以及獨立部署登錄角色。Pending slot 釋放與鏈上確認留待後續 migration，不手動刪除。

```sh
DATABASE_URL=postgresql://blink:local-only@127.0.0.1:5432/blink pnpm db:migrate
```

沒有默认連線。使用可建schema/role的migration帳號；runtime users需另外設定登入憑證並授相應NOLOGIN group role，不共享migration帳號。Runner單一連線持session advisory lock，依序每檔BEGIN/COMMIT，記SHA-256；既有checksum改變即拒絕。失敗回滾該批，不自動DROP任何資料。

採forward migration；已套用的SQL檔不可修改，新增版本修正。NUMERIC domain明確檢查整數，避免欄位precision scale的自動rounding。Audit runtime僅INSERT/SELECT，trigger亦拒UPDATE/DELETE/TRUNCATE。

pnpm test 以 PGlite engine 驗 DDL、grants、checksum、精度及身份交易。pnpm test:postgres 另需专用 PostgreSQL，測真實多 connection 的身份鎖競爭；不能把單 session 測試當成分散式併發驗收。backup/restore 與 outbox 重試整合仍待後續切片。
