import { mkdir, writeFile } from "node:fs/promises";
import { generateOpenApi } from "../packages/schemas/src/index.js";
await mkdir("artifacts", { recursive: true });
await writeFile(
  "artifacts/openapi.json",
  JSON.stringify(generateOpenApi(), null, 2) + "\n",
);
console.log(
  "Generated artifacts/openapi.json from shared schemas (business operations remain planned).",
);
