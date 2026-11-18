# Domain

`blinkmarket.xyz` is the project's domain. The owner bought it on 2026-11-18 [User U25].

## What uses it

| Service | Address | State |
| --- | --- | --- |
| Website and docs | `https://blinkmarket.xyz/`, at the root of the domain | Live since 2026-11-18. It replaced `https://blink-markets.github.io/blinkmarket/`. |
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

### Done on 2026-11-18

- **DNS.** The domain's DNS is hosted on Cloudflare. All nine records above are set to "DNS only", with no proxying, because GitHub must see its own addresses to check the domain and issue the certificate. The registrar's parking records were removed, including a wildcard (`*`) record.
- **Kept records.** The Porkbun MX records for email forwarding, one SPF record and an unrelated `77667683` CNAME were kept.
- **Cutover.** The custom domain was set through the Pages API, and `main` was fast-forwarded to `17f1e7c`, which deployed the build with no base path. CI passed on that commit before the merge, browser tests included.
- **HTTPS.** GitHub approved the certificate for `blinkmarket.xyz` and `www.blinkmarket.xyz`, and Enforce HTTPS is on. About two minutes after it was turned on, `http://blinkmarket.xyz/` returned 301 to `https://blinkmarket.xyz/`. The redirects from `www` and the old address point to the `http://` form, so they reach HTTPS in a second hop.
- **Checks after the deploy.** The home page, docs, Markdown pages, `llms.txt`, the share card, a market page and the `/_next` assets return 200 at `https://blinkmarket.xyz/`, and an unknown path returns 404. `og:image` is `https://blinkmarket.xyz/share-card.png`. `www` and old URLs under `blink-markets.github.io/blinkmarket/` return 301 to the same path on the new domain.
- **Not done.** The domain has not been verified for the organization.
