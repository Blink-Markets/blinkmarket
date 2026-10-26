---
title: API reference
description: Every Blink HTTP endpoint with its method, path and access, generated from the shared schemas.
group: Reference
order: 1
agentTask: look up an operation's method, path and who may call it
---

# API reference

> [!NOTE]
> **Generated from the schemas.** The table below is the P2 contract. The role pages that explain how to use these operations still describe v0.1 and are rewritten in P3; see [Roles](/docs/roles) for its own notice.

The table below is generated from the shared schemas in the repository (`packages/schemas`), the same contract the API, the TypeScript client and the web app use. The API is not deployed and there is no public API host; this page describes the operations it defines.

> [!NOTE]
> The Access column says who may call an operation. `public` needs no key. `key` needs any valid API key. A scope such as `forecast:write`, `rfq:write`, `content:write` or `suggestion:claim` needs an API key with that scope; the operation also needs the matching protocol role (for example the TAKER or MAKER role for the RFQ relay, the FORECASTER role for forecasts, the CREATOR role to claim a suggestion). Keys come from a wallet proof (`/v1/auth`), with no invitation. `public; own before deadline` means anyone may read, except that a forecast window's answers are visible only to their author until the window closes. `admin` operations remain in the contract, but no key can carry that scope any more. The pages [Joining](/docs/joining) and [Roles](/docs/roles) still describe the v0.1 flow and carry their own notices.

<!-- generated:api-index -->

## Next steps

- [Errors](/docs/errors) explains the error shape and safe retries.
- [Market lifecycle](/docs/lifecycle) describes the contract states behind the market endpoints.
