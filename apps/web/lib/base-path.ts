// Optional sub-path for a static export served below a domain's root (NEXT_PUBLIC_BASE_PATH, e.g. "/blinkmarket").
// The Pages build sets none, because the site is served from the root of blinkmarket.xyz.
// Next adds it to <Link>, metadata and fonts itself; plain hrefs/srcs, CSS url()s and copied URLs go through withBase.
export const BASE_PATH = process.env.NEXT_PUBLIC_BASE_PATH ?? "";

export function withBase(path: string): string {
  return `${BASE_PATH}${path}`;
}
