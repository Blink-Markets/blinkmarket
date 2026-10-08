import { expandSource, loadDocs } from "../../../lib/docs/registry.ts";

export const dynamic = "force-static";
export const dynamicParams = false;

export function generateStaticParams() {
  return loadDocs().map((p) => ({ slug: p.slug || "index" }));
}

export async function GET(_req: Request, ctx: { params: Promise<{ slug: string }> }) {
  const { slug } = await ctx.params;
  const page = loadDocs().find((p) => (p.slug || "index") === slug);
  if (!page) return new Response("Not found", { status: 404 });
  return new Response(expandSource(page), { headers: { "content-type": "text/markdown; charset=utf-8" } });
}
