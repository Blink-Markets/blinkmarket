import { llmsTxt } from "../../lib/docs/llms.ts";
import { loadDocs } from "../../lib/docs/registry.ts";

export const dynamic = "force-static";

export function GET() {
  return new Response(llmsTxt(loadDocs()), { headers: { "content-type": "text/plain; charset=utf-8" } });
}
