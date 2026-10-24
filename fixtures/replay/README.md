# REPLAY fixtures

market-spec.json is retained v0.1 reader test data. It uses a non-existent company and example.com. It has expired and must not be used to create a LIVE market.

M1's pnpm replay uses it as a template to generate v0.1.1, new relative times and a specHash for each scenario, and runs the normal, dispute and timeout flows on an Anvil it starts itself. The exact spec bytes and the report it generates are in contracts/artifacts, all marked REPLAY / LOCAL_REPLAY_ONLY.

This is an integration of the contract layer with the M0 schema. It has not gone through the API, the Indexer or an LLM. It does not claim any pre-event forecast or external Alpha deployment.
