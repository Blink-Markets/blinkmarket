# Domain

`blinkmarket.xyz` is the project's domain. The owner bought it on 2026-11-18 [User U25].

## What uses it

| Service | Address | State |
| --- | --- | --- |
| Website and docs | `https://blinkmarket.xyz/`, at the root of the domain | Moving from `https://blink-markets.github.io/blinkmarket/`. See the cutover below. |
| `www` | `www.blinkmarket.xyz` | Redirects to the root domain. GitHub Pages does this once `www` has the CNAME record below. |
| API and other public services | On this domain | Not deployed. Hostnames are chosen when each service is deployed and recorded here. |

The old address keeps working after the cutover: GitHub redirects `blink-markets.github.io/blinkmarket/...` to the custom domain.

## DNS records

Set these at the registrar, and remove the registrar's default parking or forwarding records for the root domain and `www`. The addresses are the ones GitHub publishes for Pages custom domains.

| Name | Type | Value |
| --- | --- | --- |
| `@` | A | `185.199.108.153` |
| `@` | A | `185.199.109.153` |
| `@` | A | `185.199.110.153` |
| `@` | A | `185.199.111.153` |
| `@` | AAAA | `2606:50c0:8000::153` |
| `@` | AAAA | `2606:50c0:8001::153` |
| `@` | AAAA | `2606:50c0:8002::153` |
| `@` | AAAA | `2606:50c0:8003::153` |
| `www` | CNAME | `blink-markets.github.io` |

Verify the domain for the `Blink-Markets` organization as well: Organization settings → Pages → Add a domain. GitHub shows a TXT record to add. A verified domain cannot be claimed by another account's Pages site. This needs an organization owner.

## Repository settings

- Settings → Pages → Custom domain: `blinkmarket.xyz`. The Pages workflow deploys with GitHub Actions, so the domain is set here and not through a `CNAME` file.
- Enforce HTTPS, once GitHub has issued the certificate.

## What in the repository depends on it

- `build:pages` in `apps/web/package.json`: `NEXT_PUBLIC_SITE_URL=https://blinkmarket.xyz` and no `NEXT_PUBLIC_BASE_PATH`.
- `scripts/check-pages-export.mjs` and `scripts/serve-pages.mjs`: an empty base path and the same site URL.
- The links in `apps/web/content/docs/*.md`, `README.md`, `README.zh-TW.md` and `examples/llm-agent/README.md`, and the allowed hosts in `tests/web-docs-content.test.ts`.

Change them together. A build with no base path breaks the site at the old address until the custom domain is set, and a build with the old base path breaks it at the new one.

## Cutover

Order matters, because setting the custom domain makes GitHub redirect the old address to the new one.

1. Add the DNS records above, and wait until the root domain and `www` resolve to GitHub's addresses.
2. Set the custom domain in the Pages settings, then deploy a build with no base path right away by merging the change into `main`.
3. Enforce HTTPS once the certificate is issued.
4. Check `https://blinkmarket.xyz/`, `https://www.blinkmarket.xyz/` and an old URL under `blink-markets.github.io/blinkmarket/`.

State on 2026-11-18: the repository change is ready on the branch `web/custom-domain`, and the domain does not yet resolve to GitHub's addresses.
