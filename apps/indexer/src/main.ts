import { createService, startService } from "@blink/runtime";
// 事件同步、共同祖先回退、projection 重建、reconcile 均尚未啟用。
await startService(createService("indexer"), 3003);
