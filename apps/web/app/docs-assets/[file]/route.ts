import { renderSketch, SKETCHES, type SketchName } from "../../../lib/docs/sketches";

export const dynamic = "force-static";
export const dynamicParams = false;

export function generateStaticParams(): { file: string }[] {
  return SKETCHES.map((n) => ({ file: `${n}.svg` }));
}

export async function GET(_req: Request, ctx: { params: Promise<{ file: string }> }): Promise<Response> {
  const { file } = await ctx.params;
  const name = file.replace(/\.svg$/, "");
  if (!(SKETCHES as readonly string[]).includes(name)) return new Response("Not found", { status: 404 });
  return new Response(renderSketch(name as SketchName), {
    headers: { "content-type": "image/svg+xml; charset=utf-8", "cache-control": "public, max-age=86400" },
  });
}
