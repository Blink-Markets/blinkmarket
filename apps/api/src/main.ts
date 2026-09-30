import { buildApi } from "./server.js";
import { startService } from "@blink/runtime";
await startService(buildApi(), 3001);
