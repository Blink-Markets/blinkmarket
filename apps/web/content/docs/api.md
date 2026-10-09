---
title: API reference
description: Every Blink HTTP endpoint with its method and planned access, generated from the shared schemas; see Status for which API mode enables it.
group: Reference
order: 1
agentTask: look up an operation's method and planned access, then check /docs/status for which API mode enables it
---

# API reference

The table below is generated from the shared schemas in the repository, so it matches the OpenAPI document the API serves at `http://127.0.0.1:3001/openapi.json`.

> [!NOTE]
> The Status column shows the default scaffold status. `not-implemented` means the operation answers 501 until an API mode enables it; `always available` marks `GET /v1/config`, which every mode serves. Which mode (`BLINK_API_MODE`: `identity`, `preparation` or `approval`) enables which endpoints is listed on [Status](/docs/status). There is no public API host.

<!-- generated:api-index -->

## Next steps

- [Status](/docs/status) explains each mode and what is planned.
- [Quickstart](/docs/quickstart) starts the local API.
- [Market lifecycle](/docs/lifecycle) describes the contract states behind the market endpoints.
