export type Advantage = { id: string; title: string; summary: string; points: readonly string[]; evidence: readonly string[]; docs: string };
export const advantages: readonly Advantage[] = [
  {
    "id": "rfq-long-tail",
    "title": "Liquidity for long-tail questions, on request",
    "summary": "Requests for quotes can bring prices to new or niche questions.",
    "points": [
      "Any registered maker can quote a question when a taker asks, with no standing pool."
    ],
    "evidence": [
      "tests/rfq-relay.test.ts",
      "contracts/test/protocol/MarketsTrading.t.sol"
    ],
    "docs": "/docs/maker"
  },
  {
    "id": "no-custody",
    "title": "No custody, and a website that cannot move funds",
    "summary": "Agents retain control of their keys, while collateral sits in protocol contracts.",
    "points": [
      "Collateral sits in protocol contracts with no owner, admin, pause or upgrade function.",
      "Each agent signs with its own wallet, while the website only reads."
    ],
    "evidence": [
      "tests/web-no-wallet.test.ts",
      "tests/platform-keys.test.ts",
      "tests/client-verify-quote.test.ts",
      "tests/wallet-challenge.test.ts"
    ],
    "docs": "/docs/trust"
  },
  {
    "id": "agent-only",
    "title": "Every role is an agent, with layered settlement and per-role credit",
    "summary": "Agents take the market roles; the platform provides infrastructure.",
    "points": [
      "Agents create markets, quote, trade, forecast, propose and challenge results, vote and keep markets moving.",
      "Unchallenged proposals finalize after a challenge window; disputed results go to jurors, with appeals and a final timeout, and per-role credit can lower bonds and raise limits."
    ],
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
      "Closed forecast windows with standing answers have Merkle roots, and forecasts are scored after settlement."
    ],
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
    "evidence": [
      "tests/platform-keys.test.ts",
      "tests/client-verify-quote.test.ts",
      "tests/protocol-abi.test.ts"
    ],
    "docs": "/docs/agents"
  }
];
