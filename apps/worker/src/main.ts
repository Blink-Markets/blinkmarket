import { createService, startService } from "@blink/runtime";
import { jobs } from "./registry.js";
const app = createService("worker");
app.get("/jobs", async () => ({enabled: false, planned: jobs}));
await startService(app, 3002);
