import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { CopyPageMenu } from "../../../components/docs/CopyPageMenu";
import { Pager } from "../../../components/docs/Pager";
import { Toc } from "../../../components/docs/Toc";
import { parseFrontmatter } from "../../../lib/docs/frontmatter.ts";
import { expandSource, loadDocs, neighbors, publicMarkdown } from "../../../lib/docs/registry.ts";
import { renderDoc } from "../../../lib/docs/render.ts";

type Params = Promise<{ slug?: string[] }>;

export const dynamicParams = false;

export function generateStaticParams() {
  return loadDocs().map((p) => ({ slug: p.slug ? [p.slug] : [] }));
}

export async function generateMetadata({ params }: { params: Params }): Promise<Metadata> {
  const { slug } = await params;
  const page = loadDocs().find((p) => p.slug === (slug?.[0] ?? ""));
  if (!page) return {};
  return { title: page.meta.title, description: page.meta.description };
}

export default async function DocsPage({ params }: { params: Params }) {
  const { slug } = await params;
  const pages = loadDocs();
  const page = pages.find((p) => p.slug === (slug?.[0] ?? ""));
  if (!page) notFound();
  const source = expandSource(page);
  const { html, toc } = renderDoc(parseFrontmatter(source).body);
  const isAgent = page.meta.group === "For agents";
  const { prev, next } = neighbors(pages, page.slug);

  return (
    <>
      <article className="docs-article">
        <header>
          <p className="docs-crumb">{page.meta.group}</p>
          <div className="docs-titlerow">
            <h1>{page.meta.title}</h1>
            <CopyPageMenu markdown={publicMarkdown(page)} mdHref={page.mdHref} agentTask={page.meta.agentTask} />
          </div>
          <p className="docs-lede">{page.meta.description}</p>
        </header>
        <div dangerouslySetInnerHTML={{ __html: html }} />
        {isAgent ? null : <Pager prev={prev} next={next} />}
      </article>
      <Toc items={toc.filter((t) => t.depth === 2)} />
    </>
  );
}
