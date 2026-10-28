import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import type { Abi, AbiParameter } from "viem";
import { agentAbi, createBlinkClient } from "../packages/client/src/index.ts";
import { ProtocolParams, generateOpenApi } from "../packages/schemas/src/index.ts";
import { llmsTxt } from "../apps/web/lib/docs/llms.ts";
import { loadDocs, type DocPage } from "../apps/web/lib/docs/registry.ts";

// The agent documentation must match the code as built: the reference agents, agentAbi, the client
// and the generated OpenAPI document. A page that drifts from them fails here.
const root = join(import.meta.dirname, "..");
const pages = loadDocs(join(root, "apps/web/content/docs"));
const page = (slug: string): DocPage => {
  const found = pages.find((p) => p.slug === slug);
  assert.ok(found, `missing page "${slug}"`);
  return found;
};

const ROLE_PAGES = ["creator", "maker", "trader", "forecaster", "proposer", "challenger", "juror", "keeper"] as const;
const SECTIONS = ["Duties", "Stake or bond", "Income", "Credit", "Risks", "Steps"];

/** Lines inside code fences are not headings. */
const withoutFences = (text: string) => text.replace(/```[\s\S]*?```/g, "");
const h2s = (p: DocPage) => [...withoutFences(p.body).matchAll(/^## (.+)$/gm)].map((m) => m[1]);
/** The text under `## <heading>`, up to the next H2. */
function section(p: DocPage, heading: string): string {
  const found = p.body.split(/^## /m).slice(1).find((s) => s.startsWith(heading + "\n"));
  assert.ok(found, `${p.file}: no section "${heading}"`);
  return found.slice(heading.length + 1);
}

test("every role page has the six sections in order", () => {
  for (const slug of ROLE_PAGES) {
    const p = page(slug);
    assert.deepEqual(h2s(p), SECTIONS, `${p.file}: sections`);
    const steps = section(p, "Steps");
    assert.ok(/^\d+\. /m.test(steps), `${p.file}: Steps is not a numbered list`);
    assert.match(steps, /`GET \/v1\/deployment`/, `${p.file}: Steps does not read the deployment`);
  }
});

// --- what the code calls ---

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? sourceFiles(path) : path.endsWith(".ts") ? [path] : [];
  });
}
const agentsSrc = join(root, "examples/agents/src");

const abiNames = new Set<string>();
const functionsByContract = new Map<string, Set<string>>();
for (const [key, abi] of Object.entries(agentAbi) as [string, Abi][]) {
  const functions = new Set<string>();
  for (const item of abi) {
    if (item.type === "function") functions.add(item.name);
    if (item.type === "function" || item.type === "event") abiNames.add(item.name);
  }
  functionsByContract.set(key, functions);
}
const clientMethods = new Set(Object.keys(createBlinkClient("http://127.0.0.1:1")));

/** Comment lines are not call sites. */
const withoutComments = (source: string) => source.replace(/^\s*(?:\/\/|\/\*|\*).*$/gm, "");

/** The agentAbi function and event names a source mentions as string literals, and the client methods it calls. */
function scan(source: string): { abi: Set<string>; client: Set<string> } {
  const code = withoutComments(source);
  const literals = [...code.matchAll(/["']([A-Za-z_]\w*)["']/g)].map((m) => m[1]!);
  const calls = [...code.matchAll(/\.\s*(\w+)\s*\(/g)].map((m) => m[1]!);
  return {
    abi: new Set(literals.filter((n) => abiNames.has(n))),
    client: new Set(calls.filter((n) => clientMethods.has(n))),
  };
}
const usedBy = (file: string) => scan(readFileSync(file, "utf8"));

test("the source scanner sees real call sites and ignores comments", () => {
  const found = scan(`
    // "register" is only mentioned here, and ctx.client.getSuggestion(id) is not called
    /* functionName: "joinRole" */
    const a = { functionName: "claimRewards", abi: agentAbi.jurors };
    const b = { functionName: 'stake' };
    await resolutionCall(ctx, "commitVote", [1n]);
    const c = await ctx.client
      .listMarkets({ state: "OPEN" });
    const d = await client.getMarket ({ marketId });
    list.push("hello");
  `);
  assert.deepEqual([...found.abi].sort(), ["claimRewards", "commitVote", "stake"]);
  assert.deepEqual([...found.client].sort(), ["getMarket", "listMarkets"]);
});

const mentions = (text: string, name: string) => new RegExp(`\\b${name}\\b`).test(text);

test("every agentAbi function and every client method the examples call appears in the docs", () => {
  // Role steps and onboarding hold the calls; contracts.md lists every signature, so it proves nothing here.
  const corpus = [...ROLE_PAGES.map((s) => section(page(s), "Steps")), page("onboarding").body, page("client").body].join("\n");
  const abi = new Set<string>();
  const methods = new Set<string>();
  for (const file of sourceFiles(agentsSrc)) {
    const used = usedBy(file);
    used.abi.forEach((n) => abi.add(n));
    used.client.forEach((n) => methods.add(n));
  }
  assert.ok(abi.size > 20 && methods.size > 10, "the scan found too little: has the source layout changed?");
  for (const name of abi) assert.ok(mentions(corpus, name), `agentAbi "${name}" is called by the examples but not documented`);
  for (const name of methods) assert.ok(mentions(corpus, name), `client method "${name}" is called by the examples but not documented`);
});

test("each role's Steps name every call its reference agent makes", () => {
  for (const role of ROLE_PAGES) {
    const steps = section(page(role), "Steps");
    const used = usedBy(join(agentsSrc, "roles", `${role}.ts`));
    assert.ok(used.abi.size + used.client.size > 0, `${role}: the scan found no calls in its source`);
    for (const name of [...used.abi, ...used.client]) assert.ok(mentions(steps, name), `${role}: Steps never names "${name}"`);
  }
});

test("pages cite only real routes and real contract functions", () => {
  const doc = generateOpenApi() as { paths: Record<string, Record<string, unknown>> };
  const operations = new Set<string>();
  for (const [path, item] of Object.entries(doc.paths))
    for (const method of Object.keys(item)) operations.add(`${method.toUpperCase()} ${path}`);
  const contracts: Record<string, string> = {
    BlinkRegistry: "registry",
    BlinkJurors: "jurors",
    BlinkMarkets: "markets",
    BlinkResolution: "resolution",
    BlinkFaucet: "faucet",
    BlinkTestUSD: "usd",
    BlinkToken: "platformToken",
    BlinkAnchor: "anchor",
  };
  let routes = 0;
  let calls = 0;
  for (const p of [...ROLE_PAGES.map(page), page("onboarding")]) {
    for (const m of p.body.matchAll(/`((?:GET|POST) \/v1\/[^`]*)`/g)) {
      routes++;
      assert.ok(operations.has(m[1]!), `${p.file}: no such operation ${m[1]}`);
    }
    for (const m of p.body.matchAll(/`(Blink\w+)\.(\w+)\(/g)) {
      calls++;
      const key = contracts[m[1]!];
      assert.ok(key, `${p.file}: unknown contract ${m[1]}`);
      assert.ok(functionsByContract.get(key)?.has(m[2]!), `${p.file}: ${m[1]}.${m[2]} is not in agentAbi`);
    }
  }
  assert.ok(routes >= 20 && calls >= 20, `too few citations (${routes} routes, ${calls} calls)`);
});

// --- contracts.md ---

/** One ABI parameter as Solidity writes it: tuples expanded, `indexed` and the name kept. */
function formatParam(p: AbiParameter): string {
  const type = p.type.startsWith("tuple")
    ? `(${(p as { components: readonly AbiParameter[] }).components.map(formatParam).join(", ")})${p.type.slice("tuple".length)}`
    : p.type;
  return [type, (p as { indexed?: boolean }).indexed ? "indexed" : "", p.name ?? ""].filter(Boolean).join(" ");
}
function signatures(abi: Abi): string[] {
  return abi.flatMap((item) => {
    if (item.type !== "function" && item.type !== "event" && item.type !== "error") return [];
    const head = `${item.type} ${item.name}(${item.inputs.map(formatParam).join(", ")})`;
    if (item.type !== "function") return [head];
    const view = item.stateMutability === "view" || item.stateMutability === "pure" ? ` ${item.stateMutability}` : "";
    const out = item.outputs.length ? ` returns (${item.outputs.map(formatParam).join(", ")})` : "";
    return [head + view + out];
  });
}

const CONTRACT_HEADINGS: Record<keyof typeof agentAbi, string> = {
  registry: "BlinkRegistry",
  jurors: "BlinkJurors",
  markets: "BlinkMarkets",
  resolution: "BlinkResolution",
  faucet: "BlinkFaucet",
  usd: "BlinkTestUSD",
  platformToken: "BlinkToken",
  anchor: "BlinkAnchor",
};

test("contracts.md lists exactly the agentAbi signatures", () => {
  const p = page("contracts");
  assert.deepEqual(h2s(p).slice(0, 8), Object.values(CONTRACT_HEADINGS), "contract order");
  for (const [key, name] of Object.entries(CONTRACT_HEADINGS) as [keyof typeof agentAbi, string][]) {
    const block = /```solidity\n([\s\S]*?)\n```/.exec(section(p, name));
    assert.ok(block, `contracts.md: no signature block under ${name}`);
    assert.deepEqual(block[1]!.split("\n"), signatures(agentAbi[key] as Abi), `contracts.md: ${name} differs from agentAbi.${key}`);
  }
});

// --- llms.txt ---

test("llms.txt links every docs page and only existing pages", () => {
  const text = llmsTxt(pages);
  assert.match(text, /^# Blink\n\n> .+\n/);
  const sections = new Map<string, string[]>();
  let current = "";
  for (const line of text.split("\n")) {
    const heading = /^## (.+)$/.exec(line);
    if (heading) sections.set((current = heading[1]!), []);
    const link = /^- \[[^\]]+\]\((\/[^)\s]*\.md)\): \S/.exec(line);
    if (link && current) sections.get(current)!.push(link[1]!);
    else if (line.startsWith("- ")) assert.fail(`not a link to a .md page: ${line}`);
  }
  const href = (slugs: readonly string[]) => slugs.map((s) => `/docs/${s}.md`);
  assert.deepEqual(sections.get("Start here"), href(["agents", "onboarding", "trust"]));
  assert.deepEqual(sections.get("Roles"), href(ROLE_PAGES));
  assert.deepEqual(sections.get("Reference"), href(["contracts", "api", "errors", "client"]));
  const known = new Set(pages.map((p) => p.mdHref));
  const linked = [...sections.values()].flat();
  for (const link of linked) assert.ok(known.has(link), `llms.txt links a page that does not exist: ${link}`);
  for (const p of pages) assert.ok(linked.includes(p.mdHref), `llms.txt does not link ${p.mdHref}`);
  assert.equal(new Set(linked).size, linked.length, "a page is linked twice");
});

// --- claims ---

test("no page claims unimplemented capability", () => {
  // v0.1 phrases: the design they describe was removed. A page may state a limit ("the relay polls;
  // there is no push delivery") but may not describe the old flow as current.
  const banned = ["invitation", "Candidates", "no public API", "operator approval", "approved by Blink"];
  for (const p of pages) {
    for (const phrase of banned) assert.ok(!p.source.toLowerCase().includes(phrase.toLowerCase()), `${p.file}: "${phrase}"`);
    assert.ok(!/\bP3 rewrites\b|mid-transition/.test(p.source), `${p.file}: still carries a transition notice`);
    assert.ok(!/\((?:\/docs\/)?(?:joining|question-proposer|resolution-reporter)(?:\.md)?[)#]/.test(p.body), `${p.file}: links a removed page`);
  }
});

// --- trust.md ---

test("trust.md carries the assumption sentence and the fixed test price notice", () => {
  const plain = page("trust").body.replace(/[*`]/g, "");
  assert.ok(
    plain.includes(
      "After all privileged roles are removed, the final safety of settlement still rests on one assumption: the slashable juror stake inside the snapshot is an honest majority.",
    ),
    "the §5.12 assumption sentence is missing or reworded",
  );
  assert.ok(plain.includes("Under the publicly listed assumptions, honesty is the provably best strategy"), "the claim wording");
  assert.match(plain, /fixed test price/i);
  assert.match(plain, /tokenPriceMicros/);
  assert.match(plain, /cold start/i);
  assert.match(plain, /maxPairs/);
  assert.match(plain, /CREATION_GROUND/);
  assert.match(plain, /P3 decision/);
  assert.match(plain, /not enforced on chain/i);
  for (const ground of ["WRONG_CLASS", "AMBIGUOUS", "MANIPULABLE"]) assert.ok(plain.includes(ground), ground);
});

// --- the behaviour of the reference agents as built (rulings of Tasks 3 and 4) ---

test("role pages state the behaviour of the reference agents as built", () => {
  const body = (slug: string) => page(slug).body;
  for (const needle of ["ALREADY_CLAIMED", "blink:generic-v1", "thresholdBps", "OPEN", "firstUseExtraWindow", "cap_exhausted"])
    assert.ok(body("creator").includes(needle), `creator: ${needle}`);
  assert.match(body("creator"), /not exclusive/i);
  assert.match(body("creator"), /its own bond/i);
  assert.match(body("trader"), /500 bps/);
  assert.match(body("trader"), /no view/i);
  assert.match(body("maker"), /300 bps/);
  assert.match(body("maker"), /30 s\b|30 seconds/);
  assert.match(body("maker"), /1\.\.9999/);
  assert.match(body("maker"), /incrementMakerEpoch/);
  for (const slug of ["proposer", "challenger", "juror"]) assert.ok(body(slug).includes("CONTENT_UNAVAILABLE"), `${slug}: CONTENT_UNAVAILABLE`);
  assert.match(body("challenger"), /unsupported/i);
  assert.match(body("juror"), /against/i);
  for (const slug of ["creator", "proposer", "challenger"]) assert.match(body(slug), /re-stake/i, `${slug}: slashing below the minimum`);
  assert.match(body("agents"), /only `@blink\/client`, `viem`, Node built-ins/);
  assert.match(body("keeper"), /raced/);
});

test("role pages name the Params field and send the reader to GET /v1/deployment", () => {
  const fields: Record<(typeof ROLE_PAGES)[number], string[]> = {
    creator: ["minRoleStake", "creationBondBps", "creationWindow", "firstUseExtraWindow", "creatorExposureMultiple", "securityMultipleBps", "maxMarketPairs", "classCCreditThreshold", "creatorShareBps"],
    maker: ["minRoleStake", "feeBps", "maxFillShares"],
    trader: ["minRoleStake", "feeBps", "maxFillShares", "maxTakerShares"],
    forecaster: ["minRoleStake"],
    proposer: ["minRoleStake", "proposerBondBps", "resultChallengeWindow", "minResultChallengeWindow", "challengeWindowStepSeconds", "resolutionShareBps", "maxRounds"],
    challenger: ["minRoleStake", "challengeBondBps", "bountyShareBps", "jurorBondCutBps", "creditDiscountStepBps"],
    juror: ["commitSeconds", "revealSeconds", "appealSeconds", "quorumBps", "nonRevealSlashBps", "incoherentSlashBps", "jurorUnstakeCooldown", "jurorShareBps", "roundCreditThreshold", "phaseInFinalizedMarkets"],
    keeper: ["keeperTipBps"],
  };
  const real = new Set(Object.keys(ProtocolParams.shape));
  for (const role of ROLE_PAGES) {
    const body = page(role).body;
    assert.match(body, /`params`/, `${role}: does not name \`params\``);
    for (const field of fields[role]) {
      assert.ok(real.has(field), `${role}: "${field}" is not a Params field`);
      assert.ok(body.includes(`\`${field}\``), `${role}: does not name \`${field}\``);
    }
  }
});

test("client.md names every method of the client and the count it states", () => {
  const body = page("client").body;
  for (const method of clientMethods) assert.ok(body.includes(`\`${method}(`), `client.md: no row for ${method}`);
  assert.ok(body.includes(`The client has ${clientMethods.size} methods`), "client.md: wrong method count");
});

test("pages state the protocol rules as the contracts enforce them", () => {
  const body = (slug: string) => page(slug).body;
  // INVALID is never proposed (BlinkResolution.propose reverts InvalidOutcome).
  assert.match(body("lifecycle"), /`INVALID` cannot be proposed/);
  assert.match(body("concepts"), /`INVALID` cannot be proposed/);
  assert.ok(!/`YES`, `NO` or `INVALID`\) plus|proposer's `YES`, `NO` or `INVALID`/.test(body("lifecycle") + body("concepts")));
  // A creation challenge leaves the market PENDING; rejected opens it, upheld cancels it.
  assert.match(body("lifecycle"), /stays `PENDING` with `creationChallenged` set/);
  assert.match(body("lifecycle"), /`CANCELLED` if the challenge is upheld, `OPEN` if it is rejected/);
  // The security bound has its basis-point denominator.
  for (const slug of ["trust", "creator", "concepts"]) assert.match(body(slug), /securityMultipleBps <= attackCostMicros x 10000/, `${slug}: security bound`);
  // verifySignedQuote is async, takes the signature, and does not read the epoch.
  assert.match(body("client"), /`verifySignedQuote\(quote, signature, context\)` is asynchronous/);
  assert.match(body("trader"), /await verifySignedQuote\(quote, signature, context\)/);
  assert.match(body("trader"), /never reads the maker's epoch/);
  // Only forecasts take an Idempotency-Key, so a retried RFQ is not deduplicated.
  assert.ok(!/never acts twice/.test(body("client")));
  assert.match(body("client"), /retried `createRfq` can open a second RFQ/);
  // listRfqs needs the MAKER role, so a taker is not told to read it after a lost createRfq answer.
  assert.ok(!/read `listRfqs`/.test(body("client")));
  assert.match(body("client"), /`listRfqs` needs the MAKER role/);
  // A reverted reward claim is blocked, not retried.
  assert.match(body("juror"), /claim_blocked/);
});
