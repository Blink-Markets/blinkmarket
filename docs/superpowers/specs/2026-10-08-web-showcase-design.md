# Web 展示站設計（M4 前置：唯讀介紹站）

> 日期：2026-10-08
> 範圍：`apps/web` 的唯讀展示頁面。本站**不提供任何交易、錢包或寫入操作**。
> 狀態：設計已核准，待寫實作計畫。

## 1. 目標與限制

Blink 主要使用者是 agent，不是人類交易者。網站負責讓訪客、評審與 agent 開發者看懂產品、設計與接入方式，並瀏覽「熱門市場」範例。

- 頁面：`/`、`/markets`、`/how-it-works`、`/docs`、`/docs/api`。不做市場詳情、交易、持倉、管理頁。
- 語言：英文。
- 市場資料：靜態範例，全部 `mode: "REPLAY"`、虛構公司、GM_LT_V1 題型，並標示 `SAMPLE · REPLAY`。不接 API、不引用真實公司數據。
- 全站常駐測試網提示；不得暗示已部署 Sepolia 或已開放交易（規格 §2.2、§13）。
- 不新增 npm 依賴。不使用 Tailwind。樣式用 CSS Modules + `globals.css` tokens。
- 只做淺色模式。

成功判定：

1. 五個路由皆可 `pnpm build` 成功並以 Server Component 為主渲染。
2. 首頁 hero 逐字遮罩動畫與 trail 展開可運作；`prefers-reduced-motion: reduce` 時直接呈現最終畫面。
3. 捲動揭露在支援 `animation-timeline: view()` 的瀏覽器用 CSS，其他瀏覽器以 IntersectionObserver 退回；JS 失效時內容仍可見。
4. 375px 寬無水平捲動；桌面與手機截圖目視通過。
5. `pnpm check`、`pnpm build` 通過。

## 2. 視覺系統（取自 mono-color skill 的規則）

只借用規則，不複製 skill `examples/` 內任何圖像（其授權禁止商用）。

| Token | 值 | 角色 |
| --- | --- | --- |
| `--paper` | `#FAFAF7` | 全站底色（Neutral White substrate） |
| `--cobalt` | `#2148B8` | 主油墨：插畫主體、網點、細線、連結、資料條 |
| `--terracotta` | `#C65F38` | 強調油墨：只用於「trail」——hero 強調字、手繪路徑、機率標記 |
| `--ink` | `#242321` | 內文與標籤（為可讀性刻意偏離兩色限制；插畫與圖形仍嚴守兩色） |
| `--rule` | `#24232133` | 細分隔線（ink 密度變化，不算新色） |

規則：

- 插畫只能使用 cobalt、terracotta 與紙色；深淺用網點密度與透明度表現，不加漸層、陰影、霓虹、3D。
- 每個插畫指定一個主體物件（佔畫面 45–80%），至少一處讓紙色切入主體（knockout／網點淡出）。
- 唯一手繪記號家族：terracotta 手繪路徑（略帶抖動的 path）。其他地方不使用額外塗鴉風格。
- 不做卡片網格；資訊用「格線資訊表」排版（細線分隔、tabular numerals）。
- 留白積極：每個區塊保留大量空白，主要元素對齊左側隱形邊線或 2–3 欄網格；每個區塊只安排一個刻意打破對齊的元素。
- 字體：Geist（display：粗、字距收緊；body）＋ Geist Mono（標籤、數字、狀態）。經 `next/font` 載入。display 與 microcopy 約 10:1。
- 文案語氣：簡潔、觀察式、事實清楚；不使用銷售語、hype 或 CTA 按鈕式文案（連結以文字連結呈現）。

## 3. 動畫

不加套件：CSS scroll-driven animations、IntersectionObserver、Web Animations API。

### 3.1 Hero（`components/home/Hero.tsx`，Server Component，純 CSS keyframes）

1. 文字：`every forecast` / `leaves a trail`，`trail` 為 terracotta。
2. 每個字包在 `overflow: clip` 的遮罩中，自下方升起；間隔約 220ms，緩動 `cubic-bezier(.2,.7,.1,1)`，無彈跳。
3. 全部出現後停頓約 600ms，`trail` 文字淡出並收成同尺寸 terracotta 色塊。
4. 色塊高度收窄成線，接續成手繪 trail path（`stroke-dashoffset` 畫出），依序串起四個網點節點插畫：證據紙（evidence）、預測刻度盤（forecast）、報價票根（quote）、結算印章（resolution）。
5. reduced-motion：直接渲染最終狀態（文字、`trail` 文字保留、路徑與節點完整）。
6. 靜態樣式即最終畫面；動畫全部寫在 `@media (prefers-reduced-motion: no-preference)` 內的 CSS keyframes，無需 JS，SSR／無 JS 時都可讀。

### 3.2 捲動揭露（`components/motion/Reveal`）

- 預設樣式可見。支援 `animation-timeline: view()` 時，以 CSS 做 opacity／translate 進場。
- 不支援時，一個小型 client 元件以 IntersectionObserver 加上 `is-visible` class。
- trail 路徑在 `/` 流程預告與 `/how-it-works` 隨捲動畫出（view timeline 驅動 `stroke-dashoffset`；退回時進場一次畫完）。
- reduced-motion 時全部停用。

## 4. 頁面內容

### 4.1 共用

- `SiteHeader`：`Blink` 字標、Markets、How it works、Docs、GitHub（`https://github.com/Blink-Markets/blinkmarket`）。
- `TestnetStrip`（mono 小字常駐）：`BASE SEPOLIA TESTNET · TEST ASSETS HAVE NO VALUE · NO TRADING ON THIS SITE`。
- `SiteFooter`：專案現況一句話＋repo 連結。

### 4.2 `/`

1. Hero（§3.1）＋一句產品說明＋mono 狀態行（例如 `M0–M2 built locally · no public deployment`）。
2. What Blink is：三段——off-chain research & coordination、on-chain funds & outcomes、separate signing & sync（依 README 架構段落改寫）。
3. Trending markets：取 4 筆範例（§5），格線資訊表，連到 `/markets`。
4. The loop：Define → Forecast → Quote → Resolve → Evaluate 五步預告，trail 隨捲動畫出，連到 `/how-it-works`。
5. For agents：`GET /v1/markets` curl 範例（host 使用 `<API_BASE_URL>` 佔位，不虛構網域）＋連到 `/docs`。
6. Where it stands：依 `docs/ROADMAP.md` 列出 M0–M5 狀態。

### 4.3 `/markets`

- 頁首註明 `Sample data · REPLAY only · not live markets`。
- 約 6 筆範例。欄位（規格 §13.1）：question、mode（LIVE/REPLAY 標籤）、forecast probability（cobalt 資料條＋terracotta 標記）、updated、outcome status。
- 不做篩選或排序（YAGNI）。

### 4.4 `/how-it-works`

1. 五章捲動敘事（Define / Forecast / Quote / Resolve / Evaluate），每章一張 SVG 插畫＋2–4 句說明，內容依 README「How It Works」與規格。
2. Architecture & trust boundaries：鏈下研究、鏈上資金、Private signer、Indexer 的責任區分（SVG 圖）。
3. Worked example：買 100 YES @ 6,000 bps → taker 60 bUSD＋maker 40 bUSD＝100 bUSD 抵押；YES／NO／INVALID 三種支付（INVALID 每份 0.5 bUSD）。
4. Not in v0.1：依規格 §0.2 精簡列出。

### 4.5 `/docs`

- Concepts：依 `CONTEXT.md` 詞彙改寫為英文（Market、MarketSpec、Forecast window、Baseline、Quote、Complete set、Finality、INVALID）。
- Connecting an agent：邀請制寫入、wallet challenge 認證（`/v1/auth/wallet-challenges`、`/v1/auth/wallet-verifications`）、取得題目、提交預測的步驟。
- Current limits：API 未對外部署、無 Sepolia 部署、交易／RFQ／signer 尚未接線。

### 4.6 `/docs/api`

- 建置時呼叫 `@blink/schemas` 的 `generateOpenApi()`（`artifacts/openapi.json` 被 gitignore，CI 中不存在），由 `content/openapi-index.ts` 的純函式抽出 method、path、`x-status`、`x-planned-access` 並依 `/v1/` 後第一段分組。web 需新增 workspace 依賴 `@blink/schemas`。
- 頁首註明顯示的是預設契約狀態，而非運行中服務。

## 5. 範例市場資料（`content/sample-markets.ts`）

型別：

```ts
type SampleMarket = {
  id: string;            // "sample-01" …
  mode: "REPLAY";        // 範例一律 REPLAY
  entity: string;        // 虛構公司名
  fiscalPeriod: string;  // "FY2025Q3"；問題文字由 marketQuestion() 依 GM_LT_V1 產生
  thresholdBps: number;
  forecastBps: number;   // 0–10000，平台 forecaster 平均（範例值）
  updatedAt: string;     // YYYY-MM-DD
  state: "OPEN" | "CLOSED" | "PROPOSED" | "DISPUTED" | "FINAL"; // 同 schemas effectiveState
  outcome: "YES" | "NO" | "INVALID" | null;                    // 僅 FINAL 有值
};
```

資料原則：虛構公司、`example.com` 類來源、不聲稱任何事前預測紀錄。

## 6. 檔案結構

```
apps/web/
  app/layout.tsx, app/globals.css, app/page.tsx (+ page.module.css)
  app/markets/page.tsx, app/how-it-works/page.tsx, app/docs/page.tsx, app/docs/api/page.tsx
  components/SiteHeader.tsx, TestnetStrip.tsx, SiteFooter.tsx, MarketLedger.tsx
  components/home/Hero.tsx, components/motion/Reveal.tsx (RevealObserver)
  components/illustrations/HalftoneDefs.tsx, Trail.tsx, Evidence.tsx, Forecast.tsx, Quote.tsx, Resolution.tsx, Evaluation.tsx, Architecture.tsx
  content/sample-markets.ts, content/openapi-index.ts
```

- 刪除 `apps/web/app/route.ts`：它佔用 `/` 與首頁衝突，且僅為暫時 JSON 佔位；repo 內無其他引用。
- 開始實作前須閱讀 `apps/web/node_modules/next/dist/docs/` 中相關指南（Next 16 有破壞性變更，見 `apps/web/AGENTS.md`）。

## 7. 測試與驗證

- `tests/web-sample-markets.test.ts` 與 `tests/web-openapi-index.test.ts`（node test runner，分檔以利平行實作）：
  - 所有範例市場 `mode === "REPLAY"`、`forecastBps` 在 0–10000、id 唯一。
  - `openapi-index` 對 `generateOpenApi()` 產生的條目數等於 paths × methods 數；缺 vendor extension 時顯示 `unspecified`。
- `pnpm check`、`pnpm build`。
- 啟動 `pnpm --filter @blink/web dev`，桌面與 375px 截圖目視檢查；以 reduced-motion 模擬確認最終狀態。

## 8. 執行方式

使用多個子代理平行實作：

- T0 基礎（先完成）：tokens、layout、字體、TestnetStrip、header／footer、Reveal、HalftoneDefs、刪除 `route.ts`。
- T0 後平行：T1 Hero 動畫；T2 插畫組件；T3 `/markets`＋範例資料＋測試；T4 `/how-it-works`；T5 `/docs`＋`/docs/api`＋OpenAPI 索引＋測試。
- T1、T4 會使用 T2 的插畫組件；實作計畫須先固定各插畫組件的檔名與 props 介面（例如 `{ className?: string }`），讓平行任務只依賴介面。
- 最後：組裝首頁、整合驗證、更新進度文件、commit 與 push。
