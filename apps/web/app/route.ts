import { modules } from "@blink/domain";
// 本次只建立 Web host 與功能分類；正式頁面設計留待架構確認後。
export function GET() {
  return Response.json({
    product: "Blink", stage: "architecture", chain: "Base Sepolia",
    tradingEnabled: false, notice: "測試資產，無價值；尚未部署或實作交易。",
    modules,
    plannedPages: ["/markets", "/markets/[id]", "/markets/[id]/trade", "/positions", "/markets/[id]/resolution", "/developers", "/admin"],
  });
}
