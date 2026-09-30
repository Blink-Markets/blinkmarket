# SQL migrations

M0已有0001_foundation.sql與runner；只建立uint256/address/hash domains、runtime group roles與operations基礎表。其餘業務表按docs/design/03-data-transactions.md於M2建立。

```sh
DATABASE_URL=postgresql://blink:local-only@127.0.0.1:5432/blink pnpm db:migrate
```

沒有默认連線。使用可建schema/role的migration帳號；runtime users需另外設定登入憑證並授相應NOLOGIN group role，不共享migration帳號。Runner單一連線持session advisory lock，依序每檔BEGIN/COMMIT，記SHA-256；既有checksum改變即拒絕。失敗回滾該批，不自動DROP任何資料。

採forward migration；已套用的SQL檔不可修改，新增版本修正。NUMERIC domain明確檢查整數，避免欄位precision scale的自動rounding。Audit runtime僅INSERT/SELECT，trigger亦拒UPDATE/DELETE/TRUNCATE。

pnpm test以PGlite engine驗DDL、grants、checksum與精度。正式PostgreSQL多connection lock contention、backup/restore與outbox重試整合留M2；不能把單session測試當成已驗證分散式併發。
