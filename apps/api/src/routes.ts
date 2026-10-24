import type {ModuleId} from "@blink/domain";
export const routes = [
  { method: "GET", path: "/v1/admin/pause", module: "trading", access: "admin", summary: "Indexed pause state and health diagnostics" },
  { method: "GET", path: "/v1/admin/jobs", module: "operations", access: "admin", summary: "Safe job status metadata" },
  { method: "GET", path: "/v1/admin/metrics", module: "analytics", access: "admin", summary: "Execution latency, status counts and gas ledger" },

  { method: "GET", path: "/v1/specs/:specHash", module: "markets", access: "public", summary: "讀取已核准規格原始 bytes" },
  {
    "method": "POST",
    "path": "/v1/auth/wallet-challenges",
    "module": "identity",
    "access": "invited-key",
    "summary": "建立 wallet 綁定挑戰"
  },
  {
    "method": "POST",
    "path": "/v1/auth/wallet-verifications",
    "module": "identity",
    "access": "invited-key",
    "summary": "驗證 wallet"
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
    "method": "GET",
    "path": "/v1/evidence/:id",
    "module": "evidence",
    "access": "access-policy",
    "summary": "證據與可公開材料"
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
    "path": "/v1/transactions",
    "module": "chain",
    "access": "verified-wallet",
    "summary": "登記交易追蹤提示"
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
