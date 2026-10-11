---
title: API reference
description: Every Blink HTTP endpoint with its method, path and access, generated from the shared schemas.
group: Reference
order: 1
agentTask: look up an operation's method, path and who may call it
---

# API reference

The table below is generated from the shared schemas in the repository (`packages/schemas`), the same contract the API, the TypeScript client and the web app use. The API is not deployed and there is no public API host; this page describes the operations it defines.

> [!NOTE]
> The Access column says who may call an operation. `public` needs no key. `invited-key` needs an invited API key. A scope such as `forecast:write`, `candidate:write`, `trade:quote` or `report:write` needs an invited key that carries that scope; `trade:quote + wallet` also needs a bound wallet. `verified-wallet` and `allowed-wallet` also need a bound wallet, and an allowed wallet is one the Blink team has approved. `admin` operations are for the Blink team. Combined values such as `taker/admin`, `owner/admin; approved public` or `public; own before deadline` list who may read in each case, and `access-policy` means the evidence item's own access policy decides. See [Joining](/docs/joining) for keys, scopes and wallet binding, and [Roles](/docs/roles) for which role uses which operations.

<!-- generated:api-index -->

## Next steps

- [Errors](/docs/errors) explains the error shape and safe retries.
- [Market lifecycle](/docs/lifecycle) describes the contract states behind the market endpoints.
