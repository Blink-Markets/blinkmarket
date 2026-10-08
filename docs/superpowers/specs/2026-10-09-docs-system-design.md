# Docs 系統設計（人類版／Agent 版技術文件）

> 日期：2026-10-09
> 範圍：取代 `apps/web` 目前的 `/docs`、`/docs/api`，建立類似 Claude Code docs 的技術文件系統。
> 狀態：設計已於對話中核准（兩條路線、Markdown＋marked、不加 Open in Claude／ChatGPT）；視覺細節實作時以截圖迭代，不另做模擬頁。

## 1. 目標

技術文件要清楚、可分主題瀏覽，並且能直接交給 agent 使用。

- **人類版**（`/docs`）：多頁、依主題分組、分層說明；每頁都可複製 Markdown、檢視 Markdown、複製給 agent 的提示詞；指令與給 agent 的指引可一鍵複製。
- **Agent 版**（`/docs/agents`）：一份步驟式指引——直接告訴 agent 怎麼安裝、怎麼做，含必要原理、規則與技術細節；另提供純 Markdown（`/docs/agents.md`）與 `/llms.txt` 索引。

成功判定：

1. 每個人類版頁面都有對應的 `/docs/<slug>.md`，內容與來源檔逐字一致；`/docs/agents.md`、`/docs/api.md`、`/llms.txt` 存在且靜態產生。
2. 「Copy page」複製整頁 Markdown；「View as Markdown」開啟 `.md`；「Copy prompt for agent」複製含當下網址的提示詞；程式碼區塊與 Agent prompt 區塊可複製。
3. 所有 Markdown 內 `/docs/...` 站內連結都指向存在的頁面（測試保證）。
4. 文件內容只寫 repo 內可查證的事實；未實作的 endpoint 一律標示 Planned；不虛構網域、套件或部署。
5. 375px 無水平溢出；左導覽在手機收合；`pnpm check`、`pnpm build` 通過。

## 2. 資訊架構

### 2.1 人類版頁面

| 分組 | slug（URL） | 內容依據 |
| --- | --- | --- |
| Get started | `/docs`（index） | README、CONTEXT.md |
| Get started | `/docs/quickstart` | docs/DEVELOPMENT.md（本機啟動、入口表、scaffold 行為） |
| Get started | `/docs/concepts` | CONTEXT.md 詞彙 |
| Build an agent | `/docs/authentication` | wallet challenge／verification 契約、M2 身份交付 |
| Build an agent | `/docs/markets` | markets、spec、evidence 契約；MarketSpec 與 specHash |
| Build an agent | `/docs/forecasts` | forecast windows／forecasts 契約；一窗一筆、撤回保留、baseline |
| Build an agent | `/docs/errors` | ApiError、Idempotency-Key、501／503 行為 |
| How Blink works | `/docs/lifecycle` | 規格 §6 狀態機、結算、INVALID、challenge、finality |
| How Blink works | `/docs/architecture` | README 架構、信任邊界 |
| Reference | `/docs/api` | 由 `generateOpenApi()` 產生（沿用 `openapi-index.ts`） |
| Reference | `/docs/status` | ROADMAP、交付記錄的現況與限制 |

### 2.2 Agent 版

`/docs/agents`（HTML）與 `/docs/agents.md`（同內容純 Markdown），結構固定：

1. Purpose and hard constraints：測試網、資產無價值、未部署、哪些功能未上線、禁止事項（不建立錢包、不簽署或廣播交易、API key 不代表可代人提款）。
2. Install and run locally：照抄的指令（Node 22.23.1、pnpm 11.20.0、clone、install、check、dev）。
3. Verify：`curl http://127.0.0.1:3001/v1/config` 等與預期輸出。
4. Core model：Market、MarketSpec、forecast window、quote、complete set、INVALID、finality 的精簡定義。
5. Workflows：authenticate → read markets/specs → submit forecasts（含 Idempotency-Key），每步列出 endpoint、必要欄位、狀態（enabled 於哪個 API 模式／Planned）。
6. Rules and invariants：必須遵守的規則。
7. Endpoint status table。
8. Troubleshooting：400／501／503 的意義。

### 2.3 機器可讀端點

- `/docs.md`、`/docs/<slug>.md`：人類版頁面原文。
- `/docs/agents.md`：Agent 指引原文。
- `/docs/api.md`：由 openapi-index 產生的 Markdown 表格。
- `/llms.txt`：依 llms.txt 慣例的索引（標題、一句摘要、各 `.md` 連結與一句說明），連結以相對路徑或建置時無網域的路徑表示，不虛構網域。

## 3. 版面與互動

- 文件區獨立 layout：頂端沿用站台 header 與測試網提示；其下一列「For humans ｜ For agents」切換。
- 三欄（≥1100px）：左側分組導覽（sticky）、中間文章（約 72ch）、右側「On this page」（h2／h3）。768–1099px：隱藏右欄。<768px：左導覽收為「Menu」disclosure（`<details>`），無 JS 也可用。
- 頁首：分組名、標題、描述、**Copy page** 分段按鈕（主鍵複製 Markdown；選單：View as Markdown、Copy prompt for agent）。
- 程式碼區塊：語言標籤＋複製鈕；不做語法上色。
- 提示框（以 GitHub alert 語法寫在 Markdown，原文仍可讀）：`> [!NOTE]`、`> [!PLANNED]`（尚未上線）。
- Agent prompt 區塊：Markdown 中以 ```` ```prompt ```` 圍欄撰寫，渲染為帶「Copy prompt」的醒目區塊；原文中仍是普通程式碼區塊。
- Copy prompt for agent 模板：`Read {origin}/docs/agents.md first and follow its rules. Then use {origin}/docs/<slug>.md to <frontmatter.agentTask>. Blink runs on the Base Sepolia testnet with test assets only; do not create wallets, sign or broadcast transactions unless I explicitly ask.` `{origin}` 於點擊時取 `location.origin`。
- 視覺：沿用站台 tokens（paper、cobalt、ink、Geist／Geist Mono）；文件區不放大型插畫、不啟用 blink-open 揭露動畫；terracotta 僅用於 Planned 標記與目前所在頁的導覽指示。
- 複製回饋：按鈕文字短暫變為「Copied」；clipboard 失敗時退回選取文字。
- 深淺色切換（2026-10-09 依模擬頁回饋加入）：只作用於文件區（`html:has(.docs-root)`），展示頁維持淺色（插畫使用固定油墨色）。預設跟隨 `prefers-color-scheme`，切換鈕（位於 audience 列右側）將選擇存於 `localStorage`（鍵 `blink-theme`）並設定 `<html data-theme>`；根 layout 以首繪前的 inline script 套用，避免閃爍。深色 tokens：paper `#141518`、paper-2 `#1c1e22`、ink `#ecebe5`、cobalt `#8ea6f2`、terracotta `#e08a66`、rule `#ecebe529`；header 眼睛改用 `currentColor` 以在深色下維持對比。

## 4. 技術設計

- 內容：`apps/web/content/docs/*.md`（人類版）與 `apps/web/content/docs/agents.md`。frontmatter（`---` 區塊，`key: value` 單行）欄位：`title`、`description`、`group`、`order`、`agentTask`。自寫極簡 frontmatter 解析，不加套件。
- 渲染：新增第三方依賴 **marked 18.0.13**（2026-09-12 發布，>2 週）。自訂 renderer：標題 id（slug 化）、code → 包複製鈕的結構、`prompt` 圍欄 → Agent prompt 區塊、GitHub alert → 提示框。輸出 HTML 以 `dangerouslySetInnerHTML` 插入（內容為 repo 內受信任檔案）。
- 模組邊界：
  - `apps/web/lib/docs/frontmatter.ts`（純函式）
  - `apps/web/lib/docs/registry.ts`（讀檔、排序、導覽樹、slug ↔ 檔案；server-only）
  - `apps/web/lib/docs/render.ts`（marked 設定、heading 收集供目錄）
  - `apps/web/lib/docs/llms.ts`（llms.txt 產生）
  - `apps/web/components/docs/*`：`DocsShell`、`Sidebar`、`Toc`、`CopyPageMenu`（client）、`CodeCopy`（client，替渲染出的按鈕綁定行為）
- 路由：`app/docs/[[...slug]]/page.tsx`（`generateStaticParams`）；Markdown 原文由 route handler（`app/docs-md/[...slug]/route.ts`，`dynamic = "force-static"`）提供，`next.config.ts` rewrites 將 `/docs.md`、`/docs/:path.md` 對應過去；實作須先查 `node_modules/next/dist/docs` 的 rewrites 文件並以 `next start` 實測。`app/llms.txt/route.ts` 靜態產生。`/docs/api` 保留 React 頁並沿用 `openapi-index.ts`。
- 取代：刪除現有 `app/docs/page.tsx`、`app/docs/layout.tsx`、`app/docs/docs.module.css`；`app/docs/api/page.tsx` 改用新 layout。

## 5. 測試

- 單元（`tests/web-docs-*.test.ts`）：frontmatter 解析（含缺欄位報錯）、導覽排序與分組、heading id 唯一、`prompt` 圍欄與 alert 的渲染、llms.txt 列出每個 `.md`、每頁 frontmatter 完整。
- 內容完整性：所有 Markdown 內 `/docs/...` 連結（含 `.md`）都存在；不含 `TODO`／`TBD`；`agents.md` 含 §2.2 的八個章節標題。
- 建置後實測：`next start` 下以 curl 驗證 `.md` 端點與 `/llms.txt` 的 status、`content-type`（`text/markdown; charset=utf-8`、`text/plain; charset=utf-8`）與逐字內容。
- 截圖：桌機與 375px；以 CDP 腳本實際點擊 Copy page／Copy prompt 並讀回剪貼簿內容（或攔截 `navigator.clipboard.writeText`）。

## 6. Open items（未完成項目，延續追蹤）

### 6.1 本次刻意不做

- 文件站內搜尋。
- 程式碼語法上色。
- Open in Claude／ChatGPT（使用者決定不加；網站公開部署後可再評估）。
- 人類版與 Agent 版的多語系（目前英文）。
- 依實際 API 執行模式動態顯示 endpoint 狀態（目前顯示預設契約狀態）。
- 深色模式延伸到展示頁（需改寫插畫為 token 色）。

### 6.2 自 2026-10-08 展示站延續（尚未處理）

- 真實 Safari／Firefox／實機驗證未做；Firefox 走 IntersectionObserver 備援，未實測；`/how-it-works` spine（`stretch`＋`non-scaling-stroke`＋`pathLength`）在備援下的畫線效果未確認。
- 溢出檢查方法：`body { overflow-x: clip }` 會掩蓋溢出，`scrollWidth` 檢查恆為真；應改以元素 rect 比對 viewport（本次截圖驗證採用新方法）。
- 重複樣式待整併：`.code`（首頁與 docs）、`.ops th`／`.payouts th`、三處 `.title` clamp（docs 部分隨本次重做處理）。
- `.visually-hidden` 目前未使用；市場表格可加「Forecast YES」視覺隱藏標籤。
- Architecture 插圖 `aria-label` 過長，宜改短標籤＋`<desc>`；插圖下方留白約 70px 可平衡；Evaluation 插圖的直方圖是否保留待定。
- SiteHeader 眼睛圖示使用硬寫色碼而非 `INK`；尚無 skip link。
- README／ROADMAP 表格欄寬未對齊（純外觀）。
- 待使用者確認的裁定：免責提示由 terracotta 文字改為 ink＋terracotta 標線；子代理 commit trailer 是否需標示實際模型。
- 產品面（M4 其餘）：市場詳情、交易、持倉、結算、管理頁面，以及接上真實 API 資料——尚未開始。
