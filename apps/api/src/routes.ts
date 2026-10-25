import type {ModuleId} from "@blink/domain";
export const routes = [
  { method: "GET", path: "/v1/admin/pause", module: "trading", access: "admin", summary: "Indexed pause state and health diagnostics" },
  { method: "GET", path: "/v1/admin/jobs", module: "operations", access: "admin", summary: "Safe job status metadata" },
  { method: "GET", path: "/v1/admin/metrics", module: "analytics", access: "admin", summary: "Execution latency, status counts and gas ledger" },

  {
    "method": "POST",
    "path": "/v1/auth/wallet-challenges",
    "module": "identity",
    "access": "public",
    "summary": "建立 wallet 證明挑戰"
  },
  {
    "method": "POST",
    "path": "/v1/auth/wallet-verifications",
    "module": "identity",
    "access": "public",
    "summary": "驗證 wallet 並簽發或撤銷 API key"
  },
  {
    "method": "GET",
    "path": "/v1/markets",
    "module": "markets",
    "access": "public",
    "summary": "市場列表"
  },
  {
    "method": "GET",
    "path": "/v1/markets/:id",
    "module": "markets",
    "access": "public",
    "summary": "市場詳情"
  },
  {
    "method": "GET",
    "path": "/v1/markets/:id/spec",
    "module": "markets",
    "access": "public",
    "summary": "精確規格 bytes"
  },
  {
    "method": "POST",
    "path": "/v1/content",
    "module": "evidence",
    "access": "content:write",
    "summary": "Upload hash-addressed bytes"
  },
  {
    "method": "GET",
    "path": "/v1/content/:hash",
    "module": "evidence",
    "access": "public",
    "summary": "Exact stored bytes by keccak256"
  },
  {
    "method": "POST",
    "path": "/v1/suggestions",
    "module": "markets",
    "access": "public",
    "summary": "Submit a human market suggestion"
  },
  {
    "method": "GET",
    "path": "/v1/suggestions",
    "module": "markets",
    "access": "public",
    "summary": "Suggestion queue"
  },
  {
    "method": "GET",
    "path": "/v1/suggestions/:id",
    "module": "markets",
    "access": "public",
    "summary": "One suggestion"
  },
  {
    "method": "POST",
    "path": "/v1/suggestions/:id/claims",
    "module": "markets",
    "access": "suggestion:claim",
    "summary": "Creator claims a suggestion"
  },
  {
    "method": "GET",
    "path": "/v1/markets/:id/forecast-windows",
    "module": "forecasts",
    "access": "public",
    "summary": "預測窗口"
  },
  {
    "method": "POST",
    "path": "/v1/markets/:id/forecasts",
    "module": "forecasts",
    "access": "forecast:write",
    "summary": "提交預測"
  },
  {
    "method": "GET",
    "path": "/v1/markets/:id/forecasts",
    "module": "forecasts",
    "access": "public; own before deadline",
    "summary": "讀取預測"
  },
  {
    "method": "POST",
    "path": "/v1/rfqs",
    "module": "trading",
    "access": "rfq:write",
    "summary": "Taker posts an RFQ for the relay to forward to makers"
  },
  {
    "method": "GET",
    "path": "/v1/rfqs",
    "module": "trading",
    "access": "rfq:write",
    "summary": "Makers read the open RFQs"
  },
  {
    "method": "POST",
    "path": "/v1/rfqs/:id/quotes",
    "module": "trading",
    "access": "rfq:write",
    "summary": "Maker posts a signed quote for an RFQ"
  },
  {
    "method": "GET",
    "path": "/v1/rfqs/:id/quotes",
    "module": "trading",
    "access": "rfq:write",
    "summary": "The RFQ's taker reads its quotes, unchanged"
  },
  {
    "method": "GET",
    "path": "/v1/makers/:address/stats",
    "module": "trading",
    "access": "public",
    "summary": "Informational maker relay statistics"
  },
  {
    "method": "POST",
    "path": "/v1/transactions",
    "module": "chain",
    "access": "key",
    "summary": "Register a transaction hash for tracking"
  },
  {
    "method": "GET",
    "path": "/v1/transactions/:txHash",
    "module": "chain",
    "access": "public",
    "summary": "Canonical receipt 狀態"
  },
  {
    "method": "GET",
    "path": "/v1/accounts/:address/positions",
    "module": "chain",
    "access": "public",
    "summary": "持倉 projection"
  },
  {
    "method": "GET",
    "path": "/v1/markets/:id/resolution",
    "module": "resolution",
    "access": "public",
    "summary": "結果與裁決證據"
  },
  {
    "method": "GET",
    "path": "/v1/metrics",
    "module": "analytics",
    "access": "public",
    "summary": "分模式品質與使用統計"
  }
] as const satisfies readonly {method: "GET" | "POST"; path: string; module: ModuleId; access: string; summary: string}[];
