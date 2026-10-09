import { buildLandscape, serializeStaticLandscape } from "../../lib/landscape";

export const dynamic = "force-static";

export function GET(): Response {
  return new Response(serializeStaticLandscape(buildLandscape()), {
    headers: { "content-type": "image/svg+xml; charset=utf-8", "cache-control": "public, max-age=86400" },
  });
}
