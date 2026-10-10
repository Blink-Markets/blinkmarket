// Static export for GitHub Pages serves the site under a sub-path (NEXT_PUBLIC_BASE_PATH, e.g. "/blinkmarket").
// Next adds it to <Link>, metadata and fonts itself; plain hrefs/srcs, CSS url()s and copied URLs go through withBase.
export const BASE_PATH = process.env.NEXT_PUBLIC_BASE_PATH ?? "";

export function withBase(path: string): string {
  return `${BASE_PATH}${path}`;
}
