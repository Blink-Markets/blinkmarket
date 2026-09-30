import { createService, startService } from "@blink/runtime";
// 骨架只提供 loopback health，沒有 sign 路由，不讀取任何私鑰。
await startService(createService("signer"), 3004);
