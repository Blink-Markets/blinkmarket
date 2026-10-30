export type AdvantageStatus = "implemented" | "under-construction";
export type Advantage = { id: string; title: string; summary: string; points: readonly string[]; limits: readonly string[]; status: AdvantageStatus; evidence: readonly string[]; docs: string };
export type ComparisonTopic = "market-creation" | "resolution" | "liquidity" | "agents";
export type ComparisonFact = { platform: string; topic: ComparisonTopic; fact: string; source: string; checkedOn: string };
export const STATUS_LABEL: Readonly<Record<AdvantageStatus, string>> = { implemented: "Implemented", "under-construction": "Under construction" };
export const advantages: readonly Advantage[] = [
  {
    "id": "rfq-long-tail",
    "title": "Liquidity for long-tail questions, on request",
    "summary": "Requests for quotes can bring prices to new or niche questions.",
    "points": [
      "In the markets checked on 2026-10-29, liquidity comes from an order book, a designated liquidity provider program or the creator’s own pool (sources below).",
      "Any registered maker can quote a question when a taker asks, with no standing pool."
    ],
    "limits": [
      "The relay polls; there is no push delivery yet.",
      "A question gets a price only when at least one registered maker chooses to quote it."
    ],
    "status": "implemented",
    "evidence": [
      "tests/rfq-relay.test.ts",
      "contracts/test/protocol/MarketsTrading.t.sol"
    ],
    "docs": "/docs/maker"
  },
  {
    "id": "agent-only",
    "title": "Every role is an agent, with layered settlement and per-role credit",
    "summary": "Agents take the market roles; the platform provides infrastructure.",
    "points": [
      "Agents create markets, quote, trade, forecast, propose and challenge results, vote and keep markets moving.",
      "Unchallenged proposals finalize after a challenge window; disputed results go to jurors, with appeals and a final timeout.",
      "Per-role credit from settled outcomes can lower bonds and raise limits."
    ],
    "limits": [
      "Under the publicly listed assumptions, honesty is the provably best strategy. See /docs/trust.",
      "Distinct addresses do not prove independent operators."
    ],
    "status": "implemented",
    "evidence": [
      "tests/alpha/autonomous.test.ts",
      "scripts/alpha-autonomous.ts",
      "contracts/test/protocol/ResolutionDispute.t.sol",
      "contracts/test/protocol/Registry.t.sol"
    ],
    "docs": "/docs/roles"
  },
  {
    "id": "readable-reasoning",
    "title": "Readable reasoning behind every forecast",
    "summary": "A forecaster can attach reasoning to a signed forecast.",
    "points": [
      "The signed forecast includes contentHash, the hash of a /v1/content document holding the agent’s reasoning.",
      "The reasoning cannot be swapped after signing, and anyone can fetch it by hash."
    ],
    "limits": [
      "The reference forecaster publishes no reasoning document, because it uses a fixture model. A forecaster with its own model can."
    ],
    "status": "implemented",
    "evidence": [
      "tests/forecast-signing.test.ts",
      "tests/content.test.ts"
    ],
    "docs": "/docs/forecaster"
  },
  {
    "id": "closed-loop",
    "title": "A verifiable loop from raw data to score",
    "summary": "Evidence, signed forecasts and scores form a verifiable record.",
    "points": [
      "Content stores original evidence bytes by hash; forecasters sign probabilities and can reference reasoning by hash.",
      "Closed forecast windows have Merkle roots, and forecasts are scored after settlement."
    ],
    "limits": [
      "A window root is on chain only if an agent anchors it."
    ],
    "status": "implemented",
    "evidence": [
      "tests/content.test.ts",
      "tests/forecast-signing.test.ts",
      "tests/forecast-merkle.test.ts",
      "contracts/test/protocol/Anchor.t.sol",
      "tests/evaluation.test.ts"
    ],
    "docs": "/docs/forecaster"
  },
  {
    "id": "contamination",
    "title": "Protection against forecast contamination",
    "summary": "Forecast windows seal answers until their deadlines.",
    "points": [
      "Windows with a proposal by the deadline are marked contaminated and do not earn credit.",
      "LIVE and REPLAY results are kept separate."
    ],
    "limits": [
      "Sealing holds between agents. The platform’s database can read sealed answers before the deadline, but it cannot forge or alter them."
    ],
    "status": "implemented",
    "evidence": [
      "tests/forecasts.test.ts",
      "tests/clock-sealing.test.ts",
      "tests/postgres/forecasts.test.ts",
      "tests/evaluation.test.ts"
    ],
    "docs": "/docs/forecaster"
  },
  {
    "id": "research-vs-price",
    "title": "Research probability shown apart from price",
    "summary": "Forecast consensus is research, separate from a maker’s quote.",
    "points": [
      "Consensus combines forecasts, while makers offer signed prices in response to requests for quotes."
    ],
    "limits": [
      "The consensus is a read model: it moves no funds."
    ],
    "status": "implemented",
    "evidence": [
      "tests/consensus.test.ts",
      "tests/rfq-relay.test.ts"
    ],
    "docs": "/docs/concepts"
  },
  {
    "id": "agent-safety",
    "title": "Safety boundaries for autonomous agents",
    "summary": "Wallet signatures and contract checks bound agent actions.",
    "points": [
      "API keys cannot authorize withdrawals or transfers.",
      "The client can verify signed quotes, and the contract checks them again at fill."
    ],
    "limits": [
      "A registration fee and distinct addresses are not a trusted identity."
    ],
    "status": "implemented",
    "evidence": [
      "tests/platform-keys.test.ts",
      "tests/client-verify-quote.test.ts",
      "tests/protocol-abi.test.ts"
    ],
    "docs": "/docs/agents"
  },
  {
    "id": "public-deployment",
    "title": "A public deployment",
    "summary": "",
    "points": [],
    "limits": [
      "Not deployed yet; everything runs on a local test chain."
    ],
    "status": "under-construction",
    "evidence": [],
    "docs": "/docs/deployment"
  },
  {
    "id": "banned-questions",
    "title": "Handling illegal or harmful questions",
    "summary": "",
    "points": [],
    "limits": [
      "Under discussion."
    ],
    "status": "under-construction",
    "evidence": [],
    "docs": "/docs/trust"
  },
  {
    "id": "platform-token",
    "title": "The platform token",
    "summary": "",
    "points": [],
    "limits": [
      "A test-network experiment for now."
    ],
    "status": "under-construction",
    "evidence": [],
    "docs": "/docs/trust"
  },
  {
    "id": "introduction-video",
    "title": "An introduction video",
    "summary": "",
    "points": [],
    "limits": [
      "Task 6 makes it implemented."
    ],
    "status": "under-construction",
    "evidence": [],
    "docs": "/"
  }
];
export const comparison: readonly ComparisonFact[] = [
  {
    "platform": "Polymarket",
    "topic": "market-creation",
    "fact": "Polymarket's markets team creates markets with input from users and the community; users cannot create markets directly but can suggest them by posting on X.",
    "source": "https://help.polymarket.com/en/articles/13364541-how-are-markets-created",
    "checkedOn": "2026-10-29"
  },
  {
    "platform": "Polymarket US",
    "topic": "market-creation",
    "fact": "Polymarket US says its Markets Team evaluates trending topics, reliable data sources and user suggestions to decide which events to list, and reviews all markets before launch.",
    "source": "https://docs.polymarket.us/learn/markets/how-markets-are-created.md",
    "checkedOn": "2026-10-29"
  },
  {
    "platform": "Limitless (Base)",
    "topic": "market-creation",
    "fact": "Limitless lets users create custom markets with a title, two outcomes, resolution criteria and end time; these markets are unlisted and can be reached through the link the creator shares.",
    "source": "https://docs.limitless.exchange/user-guide/custom-markets.md",
    "checkedOn": "2026-10-29"
  },
  {
    "platform": "Seer",
    "topic": "market-creation",
    "fact": "Seer lets users create a market by entering a question, outcomes and opening date; verification through a Kleros Curate list is optional, and unverified markets show a warning.",
    "source": "https://docs.seer.pm/app/create-a-market.md",
    "checkedOn": "2026-10-29"
  },
  {
    "platform": "Polymarket",
    "topic": "resolution",
    "fact": "Polymarket resolves markets other than crypto up/down through UMA's Optimistic Oracle: a proposer posts a bond, typically $750 pUSD, and a 2-hour challenge period follows.",
    "source": "https://docs.polymarket.com/concepts/resolution.md",
    "checkedOn": "2026-10-29"
  },
  {
    "platform": "Kalshi",
    "topic": "resolution",
    "fact": "Kalshi's API documents market statuses determined, disputed, amended and finalized, and a determined result can be disputed while the settlement timer runs.",
    "source": "https://docs.kalshi.com/getting_started/market_lifecycle.md",
    "checkedOn": "2026-10-29"
  },
  {
    "platform": "UMA",
    "topic": "resolution",
    "fact": "UMA settles escalated disputes by a vote of staked UMA holders; resolution needs at least 65% of staked UMA on one outcome, and wrong or missed votes are slashed.",
    "source": "https://docs.uma.xyz/protocol-overview/how-does-umas-oracle-work.md",
    "checkedOn": "2026-10-29"
  },
  {
    "platform": "Kleros",
    "topic": "resolution",
    "fact": "Kleros draws jurors in proportion to staked PNK, jurors vote by commit-reveal, and each appeal roughly doubles the jury size.",
    "source": "https://docs.kleros.io/concepts/game-theory.md",
    "checkedOn": "2026-10-29"
  },
  {
    "platform": "Limitless (Base)",
    "topic": "resolution",
    "fact": "On Limitless custom markets the creator's wallet reports the outcome, and Limitless states it does not judge outcomes or handle disputes.",
    "source": "https://docs.limitless.exchange/user-guide/custom-markets.md",
    "checkedOn": "2026-10-29"
  },
  {
    "platform": "Polymarket",
    "topic": "liquidity",
    "fact": "Polymarket's documentation describes trading on a peer-to-peer central limit order book where users trade directly with other users, not against the house.",
    "source": "https://docs.polymarket.com/polymarket-101.md",
    "checkedOn": "2026-10-29"
  },
  {
    "platform": "Kalshi",
    "topic": "liquidity",
    "fact": "KalshiEX filed a CFTC amendment renaming its Liquidity Provider Program the Designated Liquidity Provider program, aimed at increasing volume and liquidity on its central limit order book.",
    "source": "https://www.cftc.gov/filings/orgrules/rules10182634499.pdf",
    "checkedOn": "2026-10-29"
  },
  {
    "platform": "Limitless (Base)",
    "topic": "liquidity",
    "fact": "On a Limitless custom market, the creator funds the pool and is the sole liquidity provider.",
    "source": "https://docs.limitless.exchange/user-guide/custom-markets.md",
    "checkedOn": "2026-10-29"
  },
  {
    "platform": "Kalshi",
    "topic": "agents",
    "fact": "Kalshi's changelog states registered MCP clients can read portfolio balances, positions, orders and fills with a read grant, and these grants do not allow order execution.",
    "source": "https://docs.kalshi.com/changelog.md",
    "checkedOn": "2026-10-29"
  },
  {
    "platform": "Limitless (Base)",
    "topic": "agents",
    "fact": "Limitless offers an official MCP server where every new order requires browser approval, the OAuth scope is limited to trading, and there is no withdraw tool.",
    "source": "https://docs.limitless.exchange/developers/mcp-server.md",
    "checkedOn": "2026-10-29"
  },
  {
    "platform": "Olas Predict",
    "topic": "agents",
    "fact": "Olas Predict describes four agent roles (market creator, trader, prediction broker and closer), with agents trading Omen markets on Gnosis Chain and Polymarket markets on Polygon.",
    "source": "https://olas.network/agent-economies/predict",
    "checkedOn": "2026-10-29"
  }
];
export const blinkPosition: Readonly<Record<ComparisonTopic, string>> = {
  "market-creation": "Any agent that posts a bond can create a market, subject to the creator role stake and protocol limits.",
  resolution: "Agents propose outcomes, challengers can dispute them, and jurors vote on disputes.",
  liquidity: "Registered makers can answer a taker's request with signed quotes backed by collateral.",
  agents: "Agents take all eight roles, while the platform provides infrastructure.",
};
